/* ==========================================================================
 * KG 联机客户端 —— 连接 / 握手 / DIY 数据同步 / 确定性锁步驱动
 *
 * 依赖：js/netsync.js（纯函数层）、js/engine.js、js/ui.js（通过 Net.hooks 回填）
 *
 * 分层：
 *   Net（本文件）   网络与协议：房间、握手、差量同步、卡图分片、动作包收发
 *   KGNetSync       纯逻辑：指纹、差异、依赖闭包、录制/回放、状态比对
 *   Net.hooks       ui.js 填进来的本地能力（卡池读写、美术图读写、界面提示）
 *
 * 为什么用锁步而不是"房主跑引擎、客人只收画面"：
 *   引擎的状态里带函数（rng / 卡池引用），没法整体序列化传给对方；而它本身是确定性的
 *   （随机数全走 seeded mulberry32，唯一异步输入是 chooser）。所以让两边各跑一份引擎，
 *   只同步"动作 + 每一步 chooser 的答案"，代价小、延迟低，而且天然能离线复现整局。
 * ========================================================================== */
(function (global) {
  'use strict';
  const NS = global.KGNetSync;
  const Net = global.KGNet = global.KGNet || {};

  const HELLO_TIMEOUT = 15000;

  const S = Net.state = {
    ws: null,
    role: null,              // 'host' | 'guest'
    code: null,
    status: 'idle',          // idle | connecting | waiting | syncing | ready | playing | over | error
    peerName: null,
    peerHello: null,
    lastError: null,
    syncProgress: null,      // { phase, done, total, note }
    needIds: [],             // 我要向对方索取的卡
    myOnlyIds: [],           // 我独有的卡（要发给对方）
    conflicts: [],
    artQueue: [],
    artDone: 0,
    artTotal: 0,
    syncArt: true,
    resyncCount: 0,
    myName: '',
    peerFp: null,
    iAmComplete: false,
    peerSyncOk: false,
    peerSyncOkDigest: null,
    lastAnnounced: null,
    syncRounds: 0,
    stuckRounds: 0,         // 连续"还在等对方给卡"的轮数（超过 12 才算真卡住）
    localDigest: null,
    peerDigest: null,
    moveCount: 0,
    match: null,
    digests: {},            // 第 n 步之后**我这边**的状态指纹
    peerDigests: {},        // 对方报来的"第 n 步"的指纹
    reportedSteps: {},      // 已报过警的步号（避免同一步刷屏）
    pendingCreate: null,
    pendingJoin: null,
    artStarted: false,
    artRecv: {},           // 正在接收的卡图：id → {n, len, mime, got, parts[], done}
    artInFlight: 0,        // 已发出 art-get、还没收完的图片数（限制并发）
    artFailed: 0,          // 对方也没有的图（收不到就少这张，不阻塞其它）
    conflictLogged: false,
    inbox: null,
    logs: [],               // 联机准备/对局全程诊断日志（最近 300 条，出问题看这里）
    _lastNotReadyNote: null,
  };

  /* ui.js 填进来的本地能力 */
  Net.hooks = {
    getPoolCards: function () { return []; },        // → 我的卡池（数组）
    applyCards: function () { },                     // (cards) 把对方的卡在本地实现
    hashPool: function () { return ''; },            // → 卡池总指纹
    getArt: async function () { return null; },      // (id) → dataURL | null
    setArt: async function () { },                   // (id, dataURL) 存到本地
    artIds: function () { return []; },              // → 本地已有美术图的卡 id
    getDecks: function () { return []; },            // → 卡组库 [{id,name,cards}]
    onStatus: function () { },                       // (status, info)
    onProgress: function () { },                     // (progress)
    onPeerMessage: function () { },                  // (payload) 交给 ui 处理 start/文本等
    onMove: function () { },                         // (packet) 让 ui 执行动作包
    onLog: function () { },
  };

  function log(msg) { Net.hooks.onLog(msg); }

  /* ---------------- 诊断日志（2026-09-25 新增） ----------------
   * 背景：联机报"卡池反复拉不齐"时，面板上只有最后一条错误，看不出绕了什么圈子。
   * 做法：同步链路每一步都 dlog 一条（带轮次/张数/digest/卡 id 样本），存进 S.logs。
   * 查看：面板仍是最后一条；控制台有全程；报"反复拉不齐"时自动 dump 全量到 console.error。
   * 手动导出：控制台敲 KGNet.dumpLog()。 */
  function dlog(msg, detail) {
    S.logs = S.logs || [];
    S.logs.push({ t: Date.now(), role: S.role || '?', msg: msg, detail: detail == null ? null : detail });
    if (S.logs.length > 300) S.logs.shift();
    log(msg);
    if (detail != null && global.console) console.log('[联机·明细]', detail);
  }
  // id 列表截断显示：前 n 个 + 总数
  function idList(list, n) {
    n = n || 8;
    const l = list || [];
    if (!l.length) return '（无）';
    return l.slice(0, n).join('、') + (l.length > n ? '…等 ' + l.length + ' 张' : '');
  }
  Net.dumpLog = function () {
    return (S.logs || []).map(function (l) {
      const t = new Date(l.t).toTimeString().slice(0, 8);
      return t + ' [' + l.role + '] ' + l.msg + (l.detail != null ? ' ｜ ' + JSON.stringify(l.detail) : '');
    }).join('\n');
  };

  function setStatus(st, info) {
    S.status = st;
    Net.hooks.onStatus(st, info || {});
  }
  function progress(p) {
    S.syncProgress = p;
    Net.hooks.onProgress(p);
  }

  /* ------------------------------------------------- 卡图二进制传输（2026-09-27） */
  /* 分片格式：[4 字节大端 = 头部 JSON 长度][头部 JSON][裸图片字节]
   *   头部 = { id, seq, n, len, mime, total }
   *   只有 seq===0 带 id/mime/total；其余片尽量小（省 4 字节头部 + JSON 重复）。
   * ⚠ 为什么不用 JSON+base64：一张 500KB 的图变 670KB 字符串，还要整帧 JSON.parse，
   *   几百张串行传，跨网客机永远加载不出来。二进制省 33% 体积且不用解析。 */
  const CHUNK = 48 * 1024;          // 单片 48KB（WS 帧头开销小，MTU 影响不大，主要图省内存拷贝）
  const ART_CONCURRENCY = 4;        // 同时拉几张
  const ART_CHUNK_HEAD = [0, 0, 0, 0];
  if (!S.artRecv) S.artRecv = {};
  if (!S.artQueue) S.artQueue = [];

  function nextArt() { return S.artQueue.length ? S.artQueue.shift() : null; }

  function artProgress(id, failed) {
    progress({ phase: 'art', done: S.artDone, total: S.artTotal,
      note: '正在接收卡图' + (S.artFailed ? '（' + S.artFailed + ' 张对方也没有）' : '') });
    if (S.artDone < S.artTotal) { requestArt(); return; }
    progress({ phase: 'art', done: S.artTotal, total: S.artTotal, note: '卡图同步完成' });
    log('卡图：收完 ' + S.artDone + ' / ' + S.artTotal + ' 张' + (S.artFailed ? '（' + S.artFailed + ' 张对方也没有）' : ''));
    relay({ t: 'art-done' });
  }

  /* 把队列里的下一张要过来（最多同时 ART_CONCURRENCY 张在飞） */
  function requestArt() {
    while (S.artInFlight < ART_CONCURRENCY) {
      const id = nextArt();
      if (!id) break;
      S.artInFlight++;
      relay({ t: 'art-get', id: id });
    }
  }

  /* ★ 这个文件是**浏览器**代码（Node 里只被测试沙箱 require，没有 Buffer）——
   *   编码一律用 TextEncoder / Uint8Array，绝不能用 Node 的 Buffer。 */
  const utf8 = (typeof TextEncoder === 'function') ? new TextEncoder() : null;
  function enc(str) { return utf8 ? utf8.encode(str) : null; }

  function sendArtChunks(id, img) {
    const total = img.bytes.length;
    const n = Math.max(1, Math.ceil(total / CHUNK));
    const mime = img.mime || 'image/png';
    for (let i = 0; i < n; i++) {
      const part = img.bytes.subarray(i * CHUNK, Math.min(total, (i + 1) * CHUNK));
      // 首片带 id/总分片数/总长度/类型；其余片只带序号（省流量）
      const head = enc(i === 0
        ? JSON.stringify({ id: id, seq: 0, n: n, len: total, mime: mime })
        : JSON.stringify({ seq: i }));
      if (!head) return;
      const out = new Uint8Array(4 + head.length + part.length);
      out[0] = (head.length >>> 24) & 0xff;
      out[1] = (head.length >>> 16) & 0xff;
      out[2] = (head.length >>> 8) & 0xff;
      out[3] = head.length & 0xff;
      out.set(head, 4);
      out.set(part, 4 + head.length);
      sendRaw(out);
    }
  }

  /* 收到一片二进制 → 攒齐后落库 */
  function handleArtChunk(buf) {
    try {
      // 同样鸭子类型：有 byteLength 但不是 Buffer/ArrayBuffer 视图的一律按视图用，否则包一层
      const u8 = (typeof buf.byteLength === 'number' && typeof buf.length === 'number') ? buf : new Uint8Array(buf);
      if (u8.length < 5) return;
      const headLen = (u8[0] << 24) | (u8[1] << 16) | (u8[2] << 8) | u8[3];
      const head = JSON.parse(new TextDecoder('utf-8').decode(u8.subarray(4, 4 + headLen)));
      const body = u8.subarray(4 + headLen);
      if (head.seq === 0) {
        S.artRecv[head.id] = { n: head.n, len: head.len, mime: head.mime, got: 0, parts: new Array(head.n), done: false };
      }
      // 需要 id：非首片不带 id，靠"当前唯一在攒的那张"定位 —— 但并发时可能多张，
      // 所以在这里按"收发顺序"补：首片排在最前，后续片按顺序填第一个未满的槽位。
      let rec = head.id && S.artRecv[head.id];
      if (!rec) {
        const pend = Object.keys(S.artRecv).filter(function (k) { return !S.artRecv[k].done; });
        rec = pend.length ? S.artRecv[pend[0]] : null;
      }
      if (!rec) return;
      const id = head.id || Object.keys(S.artRecv).filter(function (k) { return S.artRecv[k] === rec; })[0];
      if (rec.parts[head.seq]) return;                 // 重复片（重传）忽略
      rec.parts[head.seq] = body;
      rec.got += body.length;
      if (rec.got < rec.len) return;                   // 还没齐
      rec.done = true;
      // 拼接 + 落库
      const all = new Uint8Array(rec.len);
      let off = 0;
      for (let i = 0; i < rec.n; i++) { const p = rec.parts[i] || new Uint8Array(0); all.set(p, off); off += p.length; }
      delete S.artRecv[id];
      S.artInFlight = Math.max(0, S.artInFlight - 1);
      S.artDone++;
      (async function () {
        try {
          await Net.hooks.setArt(id, { bytes: all, mime: rec.mime });
        } catch (e) { S.artFailed++; log('卡图保存失败：' + id); }
        artProgress(id);
      })();
    } catch (e) {
      log('卡图片解析失败：' + (e && e.message));
      S.artInFlight = Math.max(0, S.artInFlight - 1);
      requestArt();
    }
  }

  function sendRaw(u8) {
    if (!Net.isOpen()) return false;
    try { S.ws.send(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)); return true; }
    catch (e) { return false; }
  }
  Net.sendRaw = sendRaw;

  /* ------------------------------------------------------------ 连接 */
  /* ------------------------------------------------- 中继地址（跨网 / 加速器） */
  const RELAY_KEY = 'kg.relay';

  /* 把用户填的地址补成完整 ws:// URL。允许各种写法：
   *   1.2.3.4  /  1.2.3.4:8787  /  http://1.2.3.4:8787  /  ws://1.2.3.4:8787/kg-ws */
  function normalizeRelay(u) {
    let s = String(u || '').trim();
    if (!s) return '';
    if (!/^wss?:\/\//i.test(s)) {
      s = s.replace(/^https?:\/\//i, '');        // 有人会直接把浏览器地址栏的 http:// 粘过来
      s = 'ws://' + s.replace(/\/+$/, '');
    }
    if (!/\/kg-ws\/?$/.test(s)) s = s.replace(/\/+$/, '') + '/kg-ws';
    return s;
  }
  Net.normalizeRelay = normalizeRelay;

  /* 面板里手填的中继地址（localStorage 持久化）。存的是用户填的原文（去协议去路径），
   * 读的时候再补全 —— 这样输入框里回显的就是他当时填的东西，不会被补出一串 ws://。 */
  function getRelay() {
    try {
      const v = global.localStorage && global.localStorage.getItem(RELAY_KEY);
      return v ? normalizeRelay(v) : '';
    } catch (e) { return ''; }
  }
  function setRelay(v) {
    const raw = String(v || '').trim();
    try {
      if (!raw) global.localStorage.removeItem(RELAY_KEY);
      else global.localStorage.setItem(RELAY_KEY,
        raw.replace(/^wss?:\/\//i, '').replace(/\/kg-ws\/?$/i, '').replace(/\/+$/, ''));
    } catch (e) { /* 隐私模式下写不进去，本次会话用默认值即可 */ }
    return raw ? normalizeRelay(raw) : '';
  }
  function clearRelay() { return setRelay(''); }
  Net.getRelay = getRelay;
  Net.setRelay = setRelay;
  Net.clearRelay = clearRelay;

  /* 问服务器要"本机有哪些地址、推荐发哪条"（2026-09-27，UU / 虚拟局域网用）。
   * 只有页面确实来自那台服务器时才拿得到；跨源（客人填了 ?relay= 连别人的机器）
   * 会失败 —— 那时候本来也不该拿到对方机器的网卡列表，静默返回 null。 */
  Net.fetchNetInfo = function () {
    try {
      if (!global.fetch) return Promise.resolve(null);
      return global.fetch('/kg-net', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  };

  function wsUrl() {
    /* ★ 跨网（2026-09-26）：地址可以用 URL 参数直接指定，页面不必在服务器那台机器上。
     *   ?relay=ws://1.2.3.4:8787/kg-ws     完整写法
     *   ?relay=1.2.3.4:8787                简写（自动补 ws:// 与 /kg-ws）
     * ★ 2026-09-27：也可以在联机面板的「服务器地址」里填（存 localStorage，下次自动带上）
     *   —— UU 云联机这类虚拟局域网，房主的虚拟 IP 每次建房都变，UI 里改比改地址栏方便。
     *   优先级：URL 参数 > 面板手填 > 当前页面地址。
     * 房主把这个带参数的链接发给对方，对方点开就连这个中继，不需要任何设置。
     * 两者都没填时行为完全不变（还是用当前页面的 host）。 */
    try {
      const search = global.location && global.location.search;
      if (search) {
        const m = /[?&]relay=([^&]+)/.exec(String(search));
        if (m) {
          const u = normalizeRelay(decodeURIComponent(m[1]));
          if (u) return u;
        }
      }
    } catch (e) { /* 参数坏了就当没写，退回默认 */ }
    const manual = getRelay();
    if (manual) return manual;
    const proto = (global.location && global.location.protocol === 'https:') ? 'wss:' : 'ws:';
    const host = (global.location && global.location.host) || '127.0.0.1:8731';
    return proto + '//' + host + '/kg-ws';
  }
  Net.wsUrl = wsUrl;

  Net.connect = function (url) {
    return new Promise(function (resolve, reject) {
      if (S.ws && S.ws.readyState === 1) { resolve(S.ws); return; }
      let ws;
      try { ws = new (global.WebSocket)(url || wsUrl()); }
      catch (e) { reject(new Error('无法建立连接：' + e.message)); return; }
      // 卡图分片走二进制帧：要 arraybuffer，别让浏览器给 Blob（多一次异步转换）
      try { ws.binaryType = 'arraybuffer'; } catch (e) { /* 老实现不支持也不致命 */ }
      setStatus('connecting');
      const to = setTimeout(function () {
        if (ws.readyState !== 1) { try { ws.close(); } catch (e) { } reject(new Error('连接超时')); }
      }, 8000);
      ws.onopen = function () { clearTimeout(to); S.ws = ws; resolve(ws); };
      ws.onerror = function () { clearTimeout(to); setStatus('error', { error: '连接失败' }); reject(new Error('连接失败（对方服务器没开？地址不对？）')); };
      ws.onclose = function () {
        clearTimeout(to);
        if (S.status !== 'over' && S.status !== 'idle') setStatus('error', { error: '连接已断开' });
        S.ws = null;
      };
      ws.onmessage = function (ev) {
        /* ★ 二进制帧 = 卡图分片（2026-09-27）。服务端 relay 时把它原样转过来的，
         *   所以这里**不经 JSON**，直接进分片攒拼。 (blob 也要处理：部分浏览器
         *   在没设 binaryType 时给 Blob —— 统一转成 ArrayBuffer 再交给拼装器。) */
        const d0 = ev.data;
        if (d0 && typeof d0 !== 'string') {
          /* ★ 一律**鸭子类型**判定，不用 instanceof：
           *   instanceof 是认"构造函数身份"的，跨 realm 就失灵 —— 测试沙箱（vm 新上下文）、
           *   Worker、iframe 里收到的 ArrayBuffer / Blob 都不是本 realm 造的，
           *   `x instanceof ArrayBuffer` 恒 false，二进制分片会被**静默丢掉**（现场表现：
           *   卡图一张都收不到，且没有任何报错 —— 极难查）。按"有没有 byteLength /
           *   有没有 arrayBuffer()"判形状，跨 realm 永远成立。 */
          if (typeof d0.byteLength === 'number' && typeof d0.arrayBuffer !== 'function') {
            handleArtChunk(d0);                                  // ArrayBuffer / Uint8Array
          } else if (typeof d0.arrayBuffer === 'function') {
            d0.arrayBuffer().then(function (b) { handleArtChunk(b); });   // Blob（没设 binaryType 时）
          }
          return;
        }
        let m = null;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        // ★ 必须串行：onMove 是异步的（要 await 引擎回放），而紧随其后的 digest 是同步的。
        //   不排队的话 digest 会抢在回放完成前被比较 → 误报"不同步"。
        S.inbox = (S.inbox || Promise.resolve())
          .then(function () { return handle(m); })
          .catch(function (e) { log('处理联机消息出错：' + (e && e.message)); });
      };
    });
  };

  Net.isOpen = function () { return !!(S.ws && S.ws.readyState === 1); };

  function send(m) {
    if (!Net.isOpen()) return false;
    try { S.ws.send(JSON.stringify(m)); return true; } catch (e) { return false; }
  }
  Net.send = send;

  // 对局消息：走服务端转发（服务端只转发不改写）
  function relay(payload) { return send({ type: 'relay', payload: payload }); }
  Net.relay = relay;

  async function handle(m) {
    switch (m.type) {
      case 'created':
        S.role = 'host'; S.code = m.code;
        if (S.pendingCreate) { S.pendingCreate.resolve(m.code); S.pendingCreate = null; }
        setStatus('waiting', { code: m.code });
        break;
      case 'joined':
        S.role = 'guest'; S.code = m.code;
        if (S.pendingJoin) { S.pendingJoin.resolve(m.code); S.pendingJoin = null; }
        setStatus('syncing', { code: m.code });
        // ★ 房主已经在房间里了，现在打招呼才有意义（早于对方进房间的消息会被服务端丢掉）
        Net.sendHello();
        break;
      case 'peer-joined':
        log('对方已加入，开始同步卡池');
        Net.sendHello();
        break;
      case 'relay':
        await onPeerPayload(m.payload);
        break;
      case 'peer-left':
        setStatus('error', { error: m.reason || '对方已离开' });
        break;
      case 'left':
        setStatus('idle');
        break;
      case 'error':
        if (S.pendingCreate) { S.pendingCreate.reject(new Error(m.error || '建房失败')); S.pendingCreate = null; }
        if (S.pendingJoin) { S.pendingJoin.reject(new Error(m.error || '加入失败')); S.pendingJoin = null; }
        setStatus('error', { error: m.error || '服务端报错' });
        break;
      case 'snapshot-begin':
      case 'ack':
      case 'pong':
        break;
      default: break;
    }
  }

  /* ------------------------------------------------------------ 握手 / 同步 */
/* 为什么要握手：两个人的 DIY 卡池不可能天然一样（各自导入过卡、各自改过数值）。
 * 原版 KARDS 没有这个问题（卡池在服务器上人人一致），这里必须自己拉平：
 *   ① 交换"卡 id → 参与判定的字段的指纹"；
 *   ② 我缺的向对方要，我独有的主动推过去（连同效果里引用到的卡，避免引用悬空）；
 *      —— 含"主机没有、客机有的卡，主机从客机拉取"（host 的 ask = missing）。
 *   ③ 同名同 id 但内容不同 = 冲突，**一律按照主机来**（2026-09-25 Alan 定版）：
 *      两边必须同一个版本才不会跑出两种结果 —— 客机整卡换主机版（覆盖层），主机永不改自己；
 *   ④ 都补齐后互报总指纹，相等才算"数据对等"，否则不许开局。 */

  /* ------------------------------------------------------------ 房间 */
  Net.host = async function (opts) {
    opts = opts || {};
    await Net.connect(opts.url);
    // ★ 建房前强制刷新本地卡数据（2026-09-25）：房主 = 同步权威，权威是旧的
    //   会把对方也拉成旧的（"客机做房主就又错了"的根治）。
    if (Net.hooks.refreshCards) { try { await Net.hooks.refreshCards(); } catch (e) { } }
    const code = await new Promise(function (resolve, reject) {
      S.pendingCreate = { resolve: resolve, reject: reject };
      send({ type: 'create', code: opts.code || null });
      setTimeout(function () {
        if (S.pendingCreate) { S.pendingCreate = null; reject(new Error('建房超时（服务端没有回应）')); }
      }, 6000);
    });
    return code;
  };

  Net.join = async function (code, opts) {
    opts = opts || {};
    await Net.connect(opts.url);
    // ★ 加入前也刷一次：双保险（页面加载时已跑过，这里兜底"页面一直开着没刷新"的场景）
    if (Net.hooks.refreshCards) { try { await Net.hooks.refreshCards(); } catch (e) { } }
    await new Promise(function (resolve, reject) {
      S.pendingJoin = { resolve: resolve, reject: reject };
      send({ type: 'join', code: String(code || '').toUpperCase() });
      setTimeout(function () {
        if (S.pendingJoin) { S.pendingJoin = null; reject(new Error('加入超时（房间码对吗？对方建房了吗？）')); }
      }, 6000);
    });
  };

  Net.leave = function () {
    if (Net.isOpen()) send({ type: 'leave' });
    S.iAmComplete = false; S.peerSyncOk = false; S.peerHello = null; S.peerFp = null;
    S.lastAnnounced = null; S.syncRounds = 0; S.stuckRounds = 0; S.artStarted = false; S.conflictLogged = false;
    S.artRecv = {}; S.artInFlight = 0; S.artFailed = 0; S.artDone = 0; S.artTotal = 0; S.artQueue = [];
    S.peerSyncOkDigest = null; S.needIds = []; S.conflicts = [];
    setStatus('idle');
  };

  Net.setName = function (n) {
    S.myName = String(n || '').slice(0, 12) || (S.role === 'host' ? '房主' : '玩家');
  };

  Net.sendHello = function (name) {
    if (name) Net.setName(name);
    const cards = Net.hooks.getPoolCards();
    S.localFp = NS.fingerprintPool(cards);
    S.localDigest = Net.hooks.hashPool();
    dlog('发出 hello：卡池 ' + cards.length + ' 张 · digest=' + S.localDigest);
    relay({
      t: 'hello',
      name: S.myName || (S.role === 'host' ? '房主' : '玩家'),
      poolDigest: S.localDigest,
      fp: S.localFp,
      count: cards.length,
      proto: 2,   // ★ 协议版本（2026-09-25）：=2 表示本页面支持 fx-sync / 冲突整卡对齐。
                  //   旧页面发来的 hello 没有这个字段 → 提醒双方刷新（旧代码就是"反复拉不齐"老 bug 本尊）。
    });
  };

  function myPoolMap() {
    const m = {};
    Net.hooks.getPoolCards().forEach(function (c) { if (c && c.id) m[c.id] = c; });
    return m;
  }

  // 反复拉不齐：把同步全程日志 dump 出来（面板只有最后一条错误，定位靠这份日志）
  function stuckOnCards() {
    const dump = Net.dumpLog();
    const head = '[联机] 卡池反复拉不齐 —— 同步全程日志（复制这段发给开发者）：';
    if (global.console) console.error(head + String.fromCharCode(10) + dump);
    setStatus('error', { error: '卡池反复拉不齐（控制台已输出同步全程日志，复制给开发者）' });
  }

  /* 同步推进：每次本地卡池或对方消息引起变化后都调一次。
   * 幂等 —— 该要的要去、该给的给、齐了就报 sync-ok。 */
  function syncTick() {
    if (!S.peerHello) return;
    const cards = Net.hooks.getPoolCards();
    const myFp = NS.fingerprintPool(cards);
    const myDigest = NS.poolDigest(cards);
    const peerFp = S.peerFp || {};
    S.localFp = myFp;
    S.localDigest = myDigest;

    const isHost = S.role === 'host';
    const differ = Object.keys(peerFp).filter(function (id) { return myFp[id] !== peerFp[id]; });
    const missing = differ.filter(function (id) { return !myFp[id]; });
    const conflicting = differ.filter(function (id) { return !!myFp[id]; });
    S.needIds = missing;
    S.conflicts = conflicting;
    /* ★ 同名同 id 但内容不同（两个人都改过同一张卡）= 冲突。
     *   必须选一个版本当准，否则两边各自保留自己的版本 → 永远拉不齐（实测过死循环）。
     *   规矩：以**房主**为准。房主不接受对方版本、也不改自己；加入方改用房主的版本。 */
    const ask = isHost ? missing : differ;
    // "对方还没有、或版本与我不同"的卡要推过去；加入方不去争冲突卡（等房主推过来）
    const giveAll = Object.keys(myFp).filter(function (id) { return peerFp[id] !== myFp[id]; });
    const give = isHost ? giveAll : giveAll.filter(function (id) { return !peerFp[id]; });

    const round = ++S.syncRounds;   // 每次调用 = 一轮比对（旧版在"要卡"和"收到卡"两处各加一次 → 轮次跳号、12 轮上限提前触发）
    dlog('第 ' + round + ' 轮比对：我 ' + Object.keys(myFp).length + ' 张 digest=' + myDigest +
      ' ｜ 差异 ' + differ.length + ' 张（我缺 ' + missing.length + ' · 内容冲突 ' + conflicting.length + '）' +
      (ask.length ? '；向对方要：' + idList(ask) : '') +
      (give.length ? '；推给对方：' + idList(give) : ''),
      { missing: missing, conflicting: conflicting, give: give });

    if (ask.length) {
      // ★ 只在"我还在等对方给卡"时才算卡住轮次：两边都齐了以后的重复比对不算
      //   （以前拿总轮次当上限 → 已经 ready 的会话被冗余流量推过 12 轮 → 假报"拉不齐"）
      if (++S.stuckRounds > 12) { stuckOnCards(); return; }
      S.iAmComplete = false;
      progress({ phase: 'cards', done: 0, total: ask.length, note: '正在补齐卡池（还差 ' + ask.length + ' 张）' });
      relay({ t: 'need', ids: ask });
      return;
    }
    S.stuckRounds = 0;
    // 我这边已经"最终确定"了（缺的要过了、冲突的按规矩定了）
    S.iAmComplete = true;
    if (conflicting.length && !S.conflictLogged) {
      S.conflictLogged = true;
      log('⚠ 有 ' + conflicting.length + ' 张同名卡两边内容不同，已按房主版本统一（' +
        conflicting.slice(0, 4).join('、') + (conflicting.length > 4 ? '…' : '') + '）');
    }
    const packed = NS.packCards(give, myPoolMap(), null, peerFp);
    if (packed.cards.length) {
      dlog('→ 推送 ' + packed.cards.length + ' 张给对方（依赖闭包共 ' + packed.closure.length + ' 张）');
      relay({ t: 'pool', cards: packed.cards });
    }
    // 只在指纹变化时报一次（否则两边会互相触发 sync-ok 打成无限来回）
    if (myDigest !== S.lastAnnounced) {
      S.lastAnnounced = myDigest;
      dlog('→ 我方已齐，报告 sync-ok digest=' + myDigest);
      relay({ t: 'sync-ok', digest: myDigest, fp: myFp });   // 带上当前指纹：对方据此刷新快照，避免重复推送
    }
    maybeReady();
  }

  function maybeReady() {
    if (!S.iAmComplete || !S.peerSyncOk) return;
    if (S.peerSyncOkDigest !== S.localDigest) {
      // digest 还没收敛：只在本地 digest 变化时记一条（避免每条消息都刷）
      if (S._lastNotReadyNote !== S.localDigest) {
        S._lastNotReadyNote = S.localDigest;
        dlog('数据还没收敛：我方 digest=' + S.localDigest + ' ≠ 对方报告的 ' + S.peerSyncOkDigest + '，继续等');
      }
      return;
    }
    if (S.status === 'ready' || S.status === 'playing') return;
    dlog('★ 数据对等，双方就绪（digest=' + S.localDigest + '）');
    setStatus('ready', { code: S.code, peerName: S.peerName });
    // 数值/效果已经一致，再补卡图（可选）：先把"我有的图"报过去，对方回它缺的
    if (!S.artStarted) {
      S.artStarted = true;
      if (S.syncArt) relay({ t: 'art-hello', ids: Net.hooks.artIds() });
    }
  }

  async function onPeerPayload(p) {
    if (!p || !p.t) return;
    switch (p.t) {
      case 'hello': {
        S.peerName = p.name;
        S.peerHello = p;
        S.peerFp = p.fp || {};
        S.syncRounds = 0; S.stuckRounds = 0;
        dlog('对方 hello：' + Object.keys(S.peerFp).length + ' 张 · digest=' + p.poolDigest +
          '（我方 digest=' + S.localDigest + (p.poolDigest === S.localDigest ? '，一致' : '，不一致 → 开始比对差异') + '）');
        // ★ 协议版本哨兵（2026-09-25）：没有 proto 字段 = 对方跑的是旧页面 ——
        //   旧代码没有 fx-sync / 冲突整卡对齐，同步必然反复拉不齐；先提醒，别让双方白等 12 轮。
        if (!p.proto) {
          dlog('⚠ 对方 hello 没有 proto 版本号 → 对方是旧缓存页面，必须刷新（Ctrl+F5 / Cmd+Option+R）');
          Net.hooks.onLog('⚠ 对方浏览器跑的是旧版页面（缓存），联机对齐会一直失败 —— 让对方强制刷新页面后再连（Windows: Ctrl+F5，Mac Safari: Cmd+Option+R 或清缓存）');
        }
        // ★ 2026-09-25 制作者铁律：「DSL 在每次刷新和连接时都必须强制拉取，主机没有的不管」——
        //   主机在 hello 后把整份效果 DSL 覆盖层推给客机（单向、每次连接必发）。
        //   客机 applyFxOverlay 整体替换 S.hostFx：主机有的条目强制生效，主机没有的卡不动。
        if (S.role === 'host' && Net.hooks.getFxOverlay) {
          const ov = Net.hooks.getFxOverlay();
          if (ov) {
            dlog('→ 主机推送效果 DSL 覆盖层（' + Object.keys(ov).length + ' 条）');
            relay({ t: 'fx-sync', overlay: ov });
          }
        }
        syncTick();
        Net.hooks.onPeerMessage(p);
        return;
      }
      case 'fx-sync': {
        // 客机应用主机的效果 DSL 覆盖层（主机不收，防环）
        if (S.role === 'host') return;
        dlog('收到主机效果 DSL 覆盖层（' + (p.overlay ? Object.keys(p.overlay).length : 0) + ' 条）→ 强制应用');
        if (Net.hooks.applyFxOverlay) Net.hooks.applyFxOverlay(p.overlay);
        S.syncRounds++;
        syncTick();          // 卡池成品可能变了 → 主动推进对齐
        return;
      }
      case 'need': {
        // 对方点名要这些卡：连同它们引用的卡一起打包发过去
        const packed = NS.packCards(p.ids || [], myPoolMap(), null, S.peerFp || {});
        if (!packed.cards.length) { dlog('⚠ 对方要的卡我这边也没有：' + idList(p.ids) + '（对方会一直等不到 → 可能反复拉不齐）'); }
        else dlog('对方要 ' + (p.ids || []).length + ' 张 → 打包 ' + packed.cards.length + ' 张发出（闭包 ' + packed.closure.length + '）');
        relay({ t: 'pool', cards: packed.cards });
        return;
      }
      case 'pool': {
        const cards = (p.cards || []).filter(Boolean);
        if (cards.length) {
          progress({ phase: 'cards', done: 0, total: cards.length, note: '正在本地实现对方的卡' });
          // ★ 对方把这些卡原样发过来了 → 它那边就是这些内容：顺手刷新"对方有什么"的快照。
          //   不刷新的话每轮都会认为"对方缺这些/版本不同" → 反复重推同一批卡（日志刷屏）。
          S.peerFp = S.peerFp || {};
          cards.forEach(function (c) { if (c && c.id) S.peerFp[c.id] = NS.fingerprint(c); });
          // ★ fromPeer：**对端的卡**，只在本局内存里生效，不落本地卡池（联机结束即清）。
          dlog('收到对方 ' + cards.length + ' 张 → 本地实现' +
            (S.role === 'guest' ? '（客机：冲突卡强制对齐房主版本）' : '（房主：只补我缺的卡，冲突卡保留我的版本）'));
          Net.hooks.applyCards(cards, { fromPeer: true });
          progress({ phase: 'cards', done: cards.length, total: cards.length, note: '卡池已对齐' });
        }
        syncTick();
        return;
      }
      case 'sync-ok': {
        S.peerSyncOk = true;
        S.peerSyncOkDigest = p.digest;
        if (p.fp) S.peerFp = p.fp;   // ★ 对方自报的当前指纹（不是 hello 时的旧快照）
        dlog('对方已齐 digest=' + p.digest +
          (p.digest === S.localDigest ? '（与我方一致）' : '（与我方 ' + S.localDigest + ' 不一致 → 继续拉）'));
        syncTick();          // 我可能还没齐 → 继续要
        maybeReady();
        return;
      }
      case 'cards-info': {
        S.peerCardInfo = p.info || null;
        Net.hooks.onPeerMessage(p);
        return;
      }
      /* -------------------------------------------------- 卡图传输
       * ★ 2026-09-27 重写（治"客机卡图加载不出来"）：
       *   旧实现是 JSON + base64 + 一张一张串行：
       *     一张 500KB 的图 → 670KB 的 base64 字符串 → 对方整帧 JSON.parse → 再落 IndexedDB
       *   一次只等一张（RTT 串起来），客机跨网（UU 云联机）时几百张图永远传不完，
       *   中途一断就前功尽弃 —— 表现就是"卡图出不来"。
       *   现在：
       *     ① **二进制分片**：图片不 base64，裸字节走 opcode 0x2（体积直接省 33%）；
       *        大图按 48KB 切块并发，首片带头部（id/总片数/总长度/类型）。
       *     ② **并发 4 路**：不再一张一张等，带宽吃满。
       *     ③ **逐张完成**：某张传完立刻落库 → 牌面马上出图，失败也只丢那一张。 */
      case 'art-hello': {
        if (!S.syncArt) return;
        const theirs = p.ids || [];
        const mine = Net.hooks.artIds();
        const need = theirs.filter(function (id) { return mine.indexOf(id) < 0; });
        S.artQueue = need.slice();
        S.artTotal = need.length; S.artDone = 0; S.artFailed = 0;
        S.artRecv = {};
        progress({ phase: 'art', done: 0, total: need.length, note: '准备接收卡图' });
        if (!need.length) { log('卡图：对方没有我缺的图'); relay({ t: 'art-done' }); return; }
        log('卡图：我缺 ' + need.length + ' 张，开始并发接收（' + ART_CONCURRENCY + ' 路）');
        requestArt();
        return;
      }
      case 'art-get': {
        /* 对方要一张图 → 读出来切成二进制分片发过去 */
        (async function () {
          let img = null;
          try { img = await Net.hooks.getArtRaw(p.id); } catch (e) { img = null; }
          if (!img || !img.bytes || !img.bytes.length) { relay({ t: 'art-none', id: p.id }); return; }
          sendArtChunks(p.id, img);
        })();
        return;
      }
      /* 分片走的是原始二进制帧（见 ws.js 的 sendRaw / net.js 的 ws.onmessage），
       * 到达时进 handleArtChunk，不走这个 JSON 分支。这里只处理"对方没有这张图"。 */
      case 'art-none': {
        S.artDone++; S.artFailed++;
        artProgress(p.id || '', true);
        return;
      }
      case 'art-done':
        log('卡图：对方收完了');
        Net.hooks.onPeerMessage(p);
        return;
      /* -------------------------------------------------- 开局配置 */
      case 'decks':
        S.peerDecks = p.decks || [];
        Net.hooks.onPeerMessage(p);
        return;
      case 'start':
        Net.beginMatch(p);
        return;
      /* -------------------------------------------------- 对局消息 */
      case 'move':
        await Net.hooks.onMove(p.packet);
        return;
      case 'digest':
        Net.onPeerDigest(p);
        return;
      case 'desync':
        onPeerDesync(p);
        return;
      default:
        Net.hooks.onPeerMessage(p);
    }
  }

  /* ------------------------------------------------------- 开局（房主权威） */
  /* 房主决定：种子、谁是先手、双方用哪副卡组（都用**同步后**的卡池校验过）。
   * 加入方只接收，不参与决定 —— 减少"两边各算一套"的机会。 */
  Net.hostStart = function (myDeck, peerDeck, opts) {
    opts = opts || {};
    const seed = opts.seed != null ? opts.seed : ((Math.random() * 1e9) | 0);
    /* ★ 先后手**永远随机**，且不提供人工选择：
     *   种子随机 → 由种子派生先后手，两边算出来必然一致（不需要额外协商，也堵死了"挑先手"）。*/
    const hostFirst = (((seed >>> 0) % 2) === 0);
    const cfg = {
      t: 'start',
      seed: seed,
      hostFirst: hostFirst,
      decks: { host: myDeck.slice(), guest: (peerDeck || []).slice() },
      names: { host: opts.myName || '房主', guest: opts.peerName || '玩家' },
      nationRuleEnabled: opts.nationEnabled !== false,   // ★ 主国/盟国限制：双方必须一致（房主权威）
      matchKey: NS.matchKey({
        seed: seed, decks: [myDeck, peerDeck].map(d => (d || []).slice()),
        names: ['host', 'guest'], poolDigest: Net.hooks.hashPool(),
      }),
    };
    Net.beginMatch(cfg);
    relay(cfg);
    return cfg;
  };

  Net.beginMatch = function (cfg) {
    const iAmHost = S.role === 'host';
    const mySide = (cfg.hostFirst ? 0 : 1) === 0 ? (iAmHost ? 0 : 1) : (iAmHost ? 1 : 0);
    const decks = [cfg.decks.host.slice(), cfg.decks.guest.slice()];
    if (!cfg.hostFirst) decks.reverse();
    const names = [cfg.names.host, cfg.names.guest];
    if (!cfg.hostFirst) names.reverse();
    S.match = { seed: cfg.seed, decks: decks, names: names, mySide: mySide, matchKey: cfg.matchKey,
                nationRuleEnabled: cfg.nationRuleEnabled !== false };
    S.localDigest = null;
    S.moveCount = 0;
    S.digests = {}; S.peerDigests = {}; S.reportedSteps = {};
    dlog('开局：seed=' + cfg.seed + ' · 我方席位 ' + mySide + '（' + (mySide === 0 ? '先手' : '后手') + '）' +
      ' · 双方卡组 ' + decks[0].length + '/' + decks[1].length + ' 张 · matchKey=' + cfg.matchKey);
    setStatus('playing', { mySide: mySide, seed: cfg.seed });
    Net.hooks.onMatchStart(S.match);
  };

  /* --------------------------------------------------------- 动作包收发 */
  /* 本地执行一个动作：录制 chooser 答案 → 发给对方 → 记下自己的状态指纹。
   * runOnce(chooser) 负责真正调用引擎。 */
  Net.execLocal = async function (kind, args, runOnce) {
    if (!S.match) throw new Error('还没有开局');
    if (!Net.iAmActive()) throw new Error('现在不是你的回合');
    const rec = NS.recorder(function (req) { return Net.hooks.localChooser(req); });
    await runOnce(rec.chooser);
    S.moveCount++;
    const packet = rec.packet(kind, args, { n: S.moveCount });
    dlog('我方第 ' + S.moveCount + ' 步：' + kind + '（chooser 答案 ' + rec.answers.length + ' 个）→ 已发动作包');
    relay({ t: 'move', packet: packet });
    Net.recordStep(S.moveCount);          // 记下"我这一步"的指纹（含与对方同一步的比对）
    return packet;
  };

  /* 收到对方的动作包 → 用录好的答案回放 */
  Net.applyRemote = async function (packet) {
    if (!S.match) return;
    const fmts = [];
    const pl = NS.player(packet.answers, function (m) { fmts.push(m); });
    const KG = global.KG;
    try {
      await NS.applyPacket(KG, Net.hooks.getState(), packet, pl.chooser);
    } catch (e) {
      fmts.push('执行抛错：' + e.message);
    }
    if (pl.leftovers() !== 0) fmts.push('答案没用完（剩 ' + pl.leftovers() + '）');
    S.moveCount = Math.max(S.moveCount, packet.n || 0);
    if (fmts.length) Net.reportDesync('回放动作包时发现异常：' + fmts.join('；'));
    else {
      dlog('回放对方第 ' + (packet.n || '?') + ' 步：' + packet.kind + ' 完成（' + (packet.answers || []).length + ' 个答案全部用上）');
      Net.recordStep(packet.n);
    }
  };

  Net.iAmActive = function () {
    const st = Net.hooks.getState();
    return !!(st && S.match && !st.over && st.active === S.match.mySide);
  };

  Net.localDigest = function () {
    const st = Net.hooks.getState();
    const d = st ? NS.stateDigest(st, global.KG) : 'none';
    S.localDigest = d;
    return d;
  };

  /* ★ 逐步记录指纹，并按**同一步号**严格比较。
   *
   * 旧写法是致命 bug：拿对方"第 n 步"的指纹去比我"当前"的状态指纹。
   * 而两边都会回送指纹，所以只要我在收到对方第 n 步的回送之前又走了一步，
   * 就变成"对方的第 n 步 vs 我的第 n+1 步" —— 必然不等 → **误报不同步**。
   * （实测报"第 3 步"正是这种假警报：换牌屏障刚结束、双方连着动作的时候。）
   *
   * 现在：每一步都把"我这一步结束时的指纹"存进 S.digests[n]，只有两边都有第 n 步
   * 的指纹时才比，且只比第 n 步 —— 既不误报，也仍能抓出真正的分叉。 */
  function pruneMap(map, keep) {
    const keys = Object.keys(map).map(Number).sort(function (a, b) { return a - b; });
    while (keys.length > keep) delete map[keys.shift()];
  }

  function compareStep(n) {
    if (n == null) return;
    const mine = S.digests[n], theirs = S.peerDigests[n];
    if (mine === undefined || theirs === undefined) return;   // 还有一边没到这一步，等
    if (mine === theirs) return;
    if (S.reportedSteps[n]) return;
    S.reportedSteps[n] = true;
    Net.reportDesync('第 ' + n + ' 步之后状态不一致（我方 ' + mine + '，对方 ' + theirs + '）');
  }

  /* 记录"我在第 n 步结束时"的指纹并报给对方；顺便比对同一步。 */
  Net.recordStep = function (n) {
    const d = Net.localDigest();
    if (n != null) {
      S.digests[n] = d;
      pruneMap(S.digests, 80);
    }
    compareStep(n);
    if (n != null) relay({ t: 'digest', n: n, d: d });
    return d;
  };

  Net.onPeerDigest = function (p) {
    if (!p || p.n == null) return;
    S.peerDigests[p.n] = p.d;
    S.peerDigest = p.d;
    pruneMap(S.peerDigests, 80);
    compareStep(p.n);
  };

  /* ★ 中途索取卡图 —— 联机进行中通过一致性拉取新拿到的卡，**开局那次"我缺哪些图"的计算早就过去了**，
   *   不补这一步的话：卡定义进了本地（custom/edits 都存了），但**图永远缺** →
   *   联机结束重启后看着就像"没保存在本地"。
   *   把缺图的 id 推进队列；若当前队列是空的（没在收图），立刻发起第一条请求。 */
  Net.requestArt = function (ids) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return 0;
    const idle = !S.artQueue.length;
    list.forEach(function (id) { S.artQueue.push(id); });
    S.artDone = S.artDone || 0;
    S.artTotal = (S.artTotal || 0) + list.length;
    // ★ 走并发通道（同一条 requestArt），别自己单发一张 —— 中途补要常常是十几张，
    //   一张一张等 RTT 就会重现"客机半天不出图"。
    if (idle) requestArt();
    return list.length;
  };

  Net.reportDesync = function (msg) {
    S.resyncCount++;
    const profile = NS.stateProfile(Net.hooks.getState());
    // ★ 附上"我报告时的步号"：两份画像的差异**可能是时间差**（对方报告时我还停在更早/更晚的一步），
    //   不带步号就没法区分"真分叉"和"假警报" —— 只能看到一堆易变字段对不上。
    profile.step = S.moveCount;
    setStatus('error', { error: '⚠ 出现不同步：' + msg + '（把这条发给开发者）' });
    log('不同步：' + msg);
    if (global.console) console.error('[联机] 不同步', msg, profile);
    relay({ t: 'desync', msg: msg, profile: profile });
  };

  /* 收到对方的不同步报告 → 拿两边"状态画像"逐字段比，指出第一处不一样在哪。
   * 这样报告才**可定位**（旧代码永远打印"没发现差异"）。 */
  function onPeerDesync(p) {
    const mine = NS.stateProfile(Net.hooks.getState());
    mine.step = S.moveCount;
    const diff = NS.profileDiff(mine, p.profile || {});
    // ★ 先判断这是不是**时间差造成的假警报**：两边步号不一样 → 比的是"不同时刻"的状态，
    //   那些易变字段（kredits / canAct / hq）本来就该不同，不代表逻辑分叉。
    const peerStep = (p.profile || {}).step;
    const sameStep = peerStep != null && peerStep === S.moveCount;
    const tag = (peerStep == null)
      ? '（对方未报步号，无法判断先后）'
      : sameStep
        ? '（两边同步号 ' + S.moveCount + ' → 真分叉，按下面差异查）'
        : '⚠ 对方步号 ' + peerStep + ' ≠ 我方 ' + S.moveCount +
          ' → 两份画像是**不同时刻**的，易变字段（指挥点/可行动/总部血量）本就不同；' +
          '优先看**不该变**的：单位集合与 uid、牌堆/手牌/弃牌内容、turn/active';
    const detail = (diff.length ? diff.join('；') : '（公开字段全一致 —— 可能是随机数消耗不同步）') + '　' + tag;
    // ★ 2026-09-25：字段级差异可能长达几百字符（含整卡 effects JSON）——全文只进日志抽屉，
    //   状态栏只给短版（前 100 字）。以前全文塞进 setStatus('error') → 巨型 toast 把对战界面全盖住。
    log('不同步定位：' + detail);
    const shortDetail = diff.length
      ? (diff[0].slice(0, 100) + (diff.length > 1 ? '…等 ' + diff.length + ' 处差异' : ''))
      : '公开字段全一致（可能是随机数消耗不同步）';
    setStatus('error', { error: '⚠ 不同步：' + (p.msg || '') + '。第一处差异 → ' + shortDetail + '（全文在联机日志）' });
    if (global.console) console.error('[联机] 不同步定位：', diff, tag);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Net;
})(typeof window !== 'undefined' ? window : globalThis);
