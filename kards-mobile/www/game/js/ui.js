/* ==========================================================================
 * KG UI —— 对战界面 / 卡组构筑 / 卡牌导入与编辑器
 * 依赖：engine.js effects.js ai.js compiler.js cards.js effects-data.js
 * ========================================================================== */
(function (global) {
  'use strict';
  const KG = global.KG;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.prototype.slice.call(document.querySelectorAll(s));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ------------------------------------------------------------ 卡池装配 */
  const LS = {
    get(k, d) { try { return JSON.parse(localStorage.getItem('kg.' + k)) || d; } catch (e) { return d; } },
    set(k, v) {
      try {
        // ★★ 自定义卡清单**每次覆写前先把上一版存进 `kg.custom.bak`**。
        //    因为「清除导入」是一键全清（S.custom = []）、删除卡也直接 filter 掉，
        //    误点一次就全没了 —— 留一份"上一版"是唯一能自救的东西。
        //    （恢复见 restoreCustomBackup / 控制台 KG.ui.restoreCustomBackup()）
        if (k === 'custom') {
          const prev = localStorage.getItem('kg.custom');
          if (prev && prev !== '[]' && prev !== JSON.stringify(v)) {
            localStorage.setItem('kg.custom.bak', prev);
          }
        }
        localStorage.setItem('kg.' + k, JSON.stringify(v));
      } catch (e) { toast('本地存储写入失败（可能已满）'); }
    },
  };

   const S = {
     pool: [],        // 最终卡池
     base: [],        // 转写得到的原始卡池
     custom: [],      // 导入的自定义卡
     edits: {},       // 对任意卡的修改（按 id）
     images: {},      // id -> objectURL（导入的图）
     deck: [],        // 当前构筑（玩家，= 卡组库里选中的那副的工作副本）
     aiDeck: [],      // AI 卡组
     deckMode: 'player', // 'player' | 'ai'
     mode: 'ai',       // 'ai' = 单机对 AI；'lan' = 局域网联机（两套面板互斥）
     deckLib: { cur: null, decks: [] }, // 卡组库：{ id, name, cards[] }[]
     curDeckId: null, // 正在编辑的已保存卡组 id（null = 尚未保存的新卡组）
     deckDirty: false,// 工作区与已保存内容不一致
     deckRule: null,  // ★ 工作区的主国/盟国/开关 { major, ally, restrict }（跟随当前卡组）
     deckSeq: 0,      // 「卡组 N」自增号
     skipDeckConfirm: false, // 自动化测试用：跳过删除/改名的确认弹窗
     state: null,
     pending: null,   // 正在等待玩家的选择请求 {req, resolve}
    preTarget: null, // 拖拽指向时预置的目标
    aiThinking: false,
    readyForAnim: true,   // 首帧设为 false，避免开局时所有卡都"飞"一遍
    hpSnapshot: null,     // AI 每步前后的血量快照（用于补伤害数字）
    seenDeployUids: null, // 场上单位 uid 基线（用于识别"最新部署的单位"）
    peerOverrides: {},    // ★ 联机强制对齐覆盖层（客机端，内存态）：{卡id: 对方版本卡定义}
                          //   rebuildPool 末尾整卡替换进卡池；不落盘，断开联机即还原本地版本
  };

  /* --------------------------------------------------------- IndexedDB 图 */
  function openDB() {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) { resolve(null); return; }
      let req;
      try { req = indexedDB.open('kg-cards', 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => { try { req.result.createObjectStore('images'); } catch (e) { } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  async function idbPut(key, blob, strict) {
    const db = await openDB(); if (!db) { if (strict) throw Error('图片存储不可用'); return; }
    return new Promise((res, rej) => { const tx = db.transaction('images', 'readwrite'); tx.objectStore('images').put(blob, key); tx.oncomplete = () => { if (global.KG_AUTO_SAVE) global.KG_AUTO_SAVE.imagesChanged(); res(); }; tx.onerror = tx.onabort = () => strict ? rej(tx.error || Error('图片存储失败')) : res(); });
  }
  // 取单张（原始 Blob）—— 联机传卡图时直接拿字节，不用绕 blob URL
  async function idbGet(key) {
    const db = await openDB(); if (!db) return null;
    return new Promise(res => {
      const tx = db.transaction('images', 'readonly');
      const rq = tx.objectStore('images').get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => res(null);
    });
  }
  async function idbAll() {
    const db = await openDB(); if (!db) return {};
    return new Promise(res => {
      const out = {}; const tx = db.transaction('images', 'readonly');
      const cur = tx.objectStore('images').openCursor();
      cur.onsuccess = e => {
        const c = e.target.result;
        if (c) { out[c.key] = URL.createObjectURL(c.value); c.continue(); } else res(out);
      };
      cur.onerror = () => res(out);
    });
  }
  // 拿**原始存进去的值**（Blob），用于招安导出 —— idbAll() 只给显示用的 blob: URL
  async function idbAllRaw() {
    const db = await openDB(); if (!db) return {};
    return new Promise(res => {
      const out = {}; const tx = db.transaction('images', 'readonly');
      const cur = tx.objectStore('images').openCursor();
      cur.onsuccess = e => {
        const c = e.target.result;
        if (c) { out[c.key] = c.value; c.continue(); } else res(out);
      };
      cur.onerror = () => res(out);
    });
  }
  async function idbDel(key) {
    const db = await openDB(); if (!db) return;
    return new Promise(res => { const tx = db.transaction('images', 'readwrite'); tx.objectStore('images').delete(key); tx.oncomplete = () => { if (global.KG_AUTO_SAVE) global.KG_AUTO_SAVE.imagesChanged(); res(); }; tx.onerror = res; });
  }
  async function idbClear() {
    const db = await openDB(); if (!db) return;
    return new Promise(res => { const tx = db.transaction('images', 'readwrite'); tx.objectStore('images').clear(); tx.oncomplete = () => { if (global.KG_AUTO_SAVE) global.KG_AUTO_SAVE.imagesChanged(); res(); }; tx.onerror = res; });
  }

  /* ------------------------------------------------------------- 卡池构建 */
  /* ★ 启动强制同步主机卡牌数据（2026-09-25 制作者要求："手机端每一次刷新和访问都必须
     强制调取主机端的所有卡牌数据，只有手机端有的卡不受影响"）。两层都要同步：
     ① 卡牌定义层：data/cards.json → KG_CARDS / KG_CARD_INDEX（merge.js 产物）；
     ② 效果 DSL 层：js/effects-data.js → KG_EFFECT_OVERLAY（build-effects.js 产物）。
        ★ 这层不同步的话"改了效果手机看不到"——rebuildPool 里 overlay 优先级**高于**
        base（cards.json 收录版），手机钉住的旧 overlay 会把新同步来的效果盖回旧的。
        文件本体是 IIFE，浏览器里执行即重挂 window.KG_EFFECT_OVERLAY / KG_ALIASES，
        尾部还会用"当前 KG_CARDS + 新 overlay"先 setPool 一次（loadPool 随后
        rebuildPool 会用含自定义卡的完整池覆盖之，顺序正好）。
     共同点：URL 带时间戳 + cache:'no-store' 双保险，任何 HTTP 缓存都失效；
     手机本地状态（S.custom / S.edits / S.removed / S.altArt / IndexedDB 卡图）
     **一个字节都不碰** —— "只有手机端有的卡不受影响"；
     拉取失败（file:// / 服务器不在 / 超时 8s）→ 静默用本地数据，不阻塞启动。 */
  async function syncCardsFromHost() {
    if (typeof fetch !== 'function') return;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, 8000) : null;
    try {
      /* ① 卡牌定义层 */
      const r = await fetch('js/cards.js?sync=' + Date.now(),
        { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (r && r.ok) {
        const holder = {};
        new Function('window', 'globalThis', await r.text())(holder, holder);
        const freshWrap = { cards: holder.KG_CARDS, generatedAt: holder.KG_CARDS && holder.KG_CARDS.generatedAt };
        // 以当前重建产物为准，空卡池也是有效结果。
        const fresh = Array.isArray(freshWrap) ? freshWrap
          : (freshWrap && Array.isArray(freshWrap.cards) ? freshWrap.cards : null);
        if (fresh) {
          // ★ 数据戳：服务器 js/cards.js 的生成时间（merge.js 写入）→ 显示在卡池信息栏，
          //   "卡牌没更新"时一眼分辨是服务器数据旧还是浏览器缓存旧
          if (!Array.isArray(freshWrap) && freshWrap.generatedAt) {
            fresh.generatedAt = freshWrap.generatedAt;
            S.dataStamp = freshWrap.generatedAt;
          }
          const cur = global.KG_CARDS || [];
          const curMap = {};
          cur.forEach(function (c) { curMap[c.id] = c; });
          let changed = fresh.length !== cur.length;
          if (!changed) {
            for (let i = 0; i < fresh.length; i++) {
              const o = curMap[fresh[i].id];
              if (!o || JSON.stringify(o) !== JSON.stringify(fresh[i])) { changed = true; break; }
            }
          }
          if (changed) {   // 与主机一致就不折腾
            global.KG_CARDS = fresh;
            global.KG_CARD_INDEX = {};
            fresh.forEach(function (c) { global.KG_CARD_INDEX[c.id] = c; });
            S.cardsSynced = true;
          }
          // ★ 2026-09-25 制作者铁律（新口径，覆盖旧"手机本地一个字节都不碰"）：
          //   「DSL 在每次刷新和连接时都必须强制拉取，主机没有的不管」——
          //   主机 cards.json 里**有的卡**（含固化自定义卡）= 主机为基准，强制覆盖本地
          //   S.custom 里的同 id 卡（固化时 localStorage 留的旧结构会把 base 新数据盖死，
          //   332工程步兵团"客机根本不同步 DSL"的真凶）；主机没有的本地卡原样保留。
          //   落盘 LS.set：让 localStorage 直接变成主机版，下次「一键固化」不会再反杀。
          const freshMap = {};
          fresh.forEach(function (c) { freshMap[c.id] = c; });
          let customOverridden = 0;
          (S.custom || []).forEach(function (c, i) {
            const h = freshMap[c.id];
            if (h) {
              const nc = Object.assign({}, h);
              delete nc.art; delete nc.src;          // 美术图走 IndexedDB，不进卡定义
              S.custom[i] = nc;
              customOverridden++;
            }
          });
          if (customOverridden) LS.set('custom', S.custom);
        }
      }
      /* ② 效果 DSL 层（失败不影响①的结果） */
      try {
        const r2 = await fetch('js/effects-data.js?sync=' + Date.now(),
          { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
        if (r2 && r2.ok) {
          const txt = await r2.text();
          const oldJson = global.KG_EFFECT_OVERLAY ? JSON.stringify(global.KG_EFFECT_OVERLAY) : '';
          new Function(txt)();   // 同源、服务器生成的文件，与 <script> 加载等效
          const now = global.KG_EFFECT_OVERLAY;
          if (now && typeof now === 'object') {
            S.hostFx = now;      // ★ 主机 DSL 强制层（无条件挂载：custom 卡也吃这层）
            if (JSON.stringify(now) !== oldJson) S.fxSynced = true;
          }
        }
      } catch (e2) { /* DSL 层拉取失败：沿用页面已加载的 overlay */ }
    } catch (e) {
      /* 拉不到就算了：用本地内联数据，不阻塞启动 */
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function loadPool() {
    S.images = await idbAll();
    S.custom = LS.get('custom', []);
    S.edits = LS.get('edits', {});
    S.removed = LS.get('removed', {});   // 已删除的**内置卡** {id:1}：rebuildPool 时跳过（逻辑删除，可恢复）
    // 异画开关（每张卡单独记，localStorage 持久化）：{ 卡id: 1 } 表示这张卡用异画图
    S.altArt = LS.get('altArt', {});
    await syncCardsFromHost();   // ★ 每次刷新/访问先对齐主机端最新卡牌数据（本地自定义卡不动）
    const overlay = global.KG_EFFECT_OVERLAY || {};
    S.base = (global.KG_CARDS || []).map(c => Object.assign({}, c));
    rebuildPool();
    if (S.cardsSynced || S.fxSynced) {
      S.cardsSynced = false; S.fxSynced = false;
      try { toast('已同步主机端最新卡牌数据（' + S.pool.length + ' 张）', 2600); } catch (e) { }
    }
    // ★ 2026-09-24 制作者下令拆除 warnStaleEdits()：它拿编译器产物当裁判、
    //   自动清掉 localStorage 里的手工编辑 —— 违反"效果以人工确认为准"。
    //   手工编辑永远优先，哪怕它和编译产物不一致（那才是编辑存在的意义）。
  }

  function rebuildPool() {
    const overlay = global.KG_EFFECT_OVERLAY || {};
    const map = {};
    const all = [];
    // ★ 进池前统一提升卡面级字段（effects[].cardFields → 顶层，幂等）：
    //   制卡台保存的自定义卡 cardFields 只在 effects 条目里，不提升的话
    //   costModByStat / upgradeOn / targetsNeeded 等引擎全都读不到（大规模轰炸报）。
    //   ★ S.hostFx = 主机端 DSL 强制层（2026-09-25 制作者铁律："DSL 在每次刷新和连接时
    //     都必须强制拉取，主机没有的不管"）—— 刷新时来自主机的 effects-data.js，
    //     连接时来自联机 fx-sync 消息；整体替换、只含主机有的条目，主机没有的卡天然不动。
    //     ⚠ **custom 卡也必须吃这层**：固化的自定义卡同时存在于 base（cards.json）与
    //     S.custom（localStorage），以前 custom 分支不掺 overlay/主机层 → 主机改了效果
    //     客机永远看不到（332 工程步兵团"客机不同步 DSL"的真凶）。
    //     优先级：base/custom 原始 < 本地 overlay < 主机 hostFx < S.edits(本地手工) < peerOverrides(联机整卡)。
    const promote = global.KG && KG.promoteCardFields ? KG.promoteCardFields : (x => x);
    const hostFx = S.hostFx || {};
    S.base.forEach(c => {
      if (S.removed && S.removed[c.id]) return;   // 已被删除的内置卡：不进卡池（定义仍在 cards.js，逻辑删除）
      const merged = promote(Object.assign({}, c, overlay[c.id] || {}, hostFx[c.id] || {}, S.edits[c.id] || {}));
      map[c.id] = merged; all.push(merged);
    });
    S.custom.forEach(c => {
      if (S.removed && S.removed[c.id]) return;
      const merged = promote(Object.assign({}, c, hostFx[c.id] || {}, S.edits[c.id] || {}));
      map[c.id] = merged;
      const i = all.findIndex(x => x.id === c.id);
      if (i >= 0) all[i] = merged; else all.push(merged);
    });
    // ★ 联机强制对齐覆盖层（2026-09-25 Alan 定版）：客机在连接/刷新时必须强制对齐主机。
    //   与主机内容不同（或主机有我没有）的卡，本局整卡替换为主机版本 —— 内存态、不落盘，
    //   断开联机清空本层 rebuildPool 即还原。必须**整卡替换**而不是字段合并：
    //   本地多出的字段会残留在成品里 → 两边指纹永远算不出同一个值 → 又是"反复拉不齐"。
    const ov = S.peerOverrides || {};
    Object.keys(ov).forEach(function (id) {
      if (S.removed && S.removed[id]) return;
      const i = all.findIndex(x => x.id === id);
      const card = promote(Object.assign({}, ov[id]));
      if (i >= 0) all[i] = card; else all.push(card);
    });
    S.pool = all;
    KG.setPool(all.map(c => Object.assign({}, c)));
    // ★ 数据戳：显示当前生效卡牌数据的生成时间（js/cards.js 挂的数组属性或同步拉到的
    //   cards.json 顶层 generatedAt）—— "卡牌没更新 / 新机子还是旧数据"时先看这里
    let stamp = '';
    try {
      const ga = (global.KG_CARDS && global.KG_CARDS.generatedAt) || S.dataStamp;
      if (ga) {
        const d = new Date(ga);
        if (!isNaN(d.getTime())) {
          stamp = ' · 数据 ' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' +
            String(d.getMinutes()).padStart(2, '0');
        }
      }
    } catch (e) { }
    $('#poolInfo').textContent = '卡池 ' + all.length + ' 张 · 自定义 ' + S.custom.length + ' 张' + stamp;
  }

  /* ---------------------------------------------------------- 错误提示横幅 */
  function showError(msg) {
    try {
      const banner = $('#errorBanner');
      if (!banner) { console.log(msg); return; }
      const box = $('#errorText');
      box.textContent = (box.textContent ? box.textContent + '\n\n' : '') + msg;
      banner.classList.remove('hidden');
    } catch (e) { console.log(msg); }
  }
  /* ------------------------------------------------------------ 横屏引导
     手机**竖屏**下的战场是没法看的：一行卡就要 156px 宽，竖屏只有 ~390px，
     三条阵线 + 前线 + 手牌纵向堆下去必然互相遮挡。
     所以竖屏时**不假装能用**，直接盖一层提示引导转横屏（横屏才是设计基准）。
     用 CSS 媒体查询控制显隐（媒体查询在迷你 DOM 里测不了，所以用 CSS 而不是 JS 判方向）。 */
  function buildRotateHint() {
    if (typeof document === 'undefined' || !document.body) return;
    if (document.getElementById('rotateHint')) return;
    const d = document.createElement('div');
    d.id = 'rotateHint';
    d.innerHTML = '<div class="rh-icon">📱</div>' +
      '<div class="rh-title">请把手机横过来</div>' +
      '<div class="rh-sub">这个游戏按**横屏**设计：卡牌、前线、手牌都要横向铺开。<br>' +
      '转向横屏后可以点右上角「全屏」，能再让出一条牌的高度。</div>';
    document.body.appendChild(d);
  }

  function installErrorHandlers() {
    if (typeof global.addEventListener !== 'function') return;
    global.addEventListener('error', e => {
      if (e && e.message) showError('JS 错误：' + e.message + (e.filename ? '\n  位置：' + e.filename + ':' + e.lineno + ':' + e.colno : ''));
    });
    global.addEventListener('unhandledrejection', e => {
      const r = e && e.reason;
      showError('未处理的异步错误：' + (r && (r.stack || r.message) ? (r.stack || r.message) : String(r)));
    });
    const close = $('#errClose');
    if (close) close.addEventListener('click', () => $('#errorBanner').classList.add('hidden'));
    const copy = $('#errCopy');
    if (copy) copy.addEventListener('click', () => {
      const t = $('#errorText').textContent || '';
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('已复制错误信息'), () => toast('复制失败，请手动选中'));
      else toast('请手动选中复制');
    });
  }

  /* ------------------------------------------------------ 拖拽与卡牌动画 */
  // 不用 HTML5 drag&drop：卡面里的 <img> 会被浏览器当成原生拖拽源（拖不动/丢不出），
  // 触摸屏也不触发。统一用 pointer 事件自己算，顺带能做落点提示与动画。
  let drag = null;
  let swallowClick = false;
  const DRAG_MIN = 6;

  // ⚠ 向上遍历必须用 `parentNode`：真实 DOM 的 Element 上**没有** `.parent` 属性
  //   （那只是 uitest 沙箱 El 类的自定义属性）。
  //   以前这里写的是 `n = n.parent`，在真实浏览器里第二轮就变成 undefined、循环
  //   直接结束 —— closestData/closestClass 只会检查"起点元素自己"，永远走不到
  //   祖先。于是真实浏览器里 elementFromPoint 返回卡面 <img> 时（卡图盖住整张卡），
  //   从 IMG 找不到所属的 .card[data-uid] → dropInfoAt 返回 null →
  //   **拖拽攻击单位/总部全部失效**（沙箱测试却全绿，因为沙箱的 El 定义了 .parent）。
  //   兼容写法：优先 parentNode（真 DOM），回退 parent（沙箱）。
  function domParentOf(n) {
    return (n && n.parentNode != null) ? n.parentNode : (n && n.parent);
  }

  function closestData(el, key) {
    let n = el;
    while (n) {
      if (n.dataset && n.dataset[key] != null) return n;
      n = domParentOf(n);
    }
    return null;
  }

  function rectOf(el) { try { return el && el.getBoundingClientRect(); } catch (e) { return null; } }
  function unitElByUid(uid) { return document.querySelector('.card[data-uid="' + uid + '"]'); }
  function hqElOf(pi) { return document.querySelector('.hq-card[data-hq="' + pi + '"]'); }
  function slotElOf(zone, side, index) {
    return document.querySelector('.slot[data-zone="' + zone + '"][data-side="' + side + '"][data-slot="' + index + '"]');
  }

  function makeGhost(card, x, y, cls) {
    const art = card && cardArt(card);
    const g = document.createElement('div');
    g.className = cls || 'drag-ghost';
    g.innerHTML = art ? '<img src="' + art + '" alt="">'
      : '<div style="padding:6px;font-size:12px">' + ((card && card.name) || '') + '</div>';
    g.style.left = x + 'px'; g.style.top = y + 'px';
    document.body.appendChild(g);
    return g;
  }
  function moveGhost(g, x, y) { if (g) { g.style.left = x + 'px'; g.style.top = y + 'px'; } }
  function endGhost(g) { if (g && g.parentNode) g.parentNode.removeChild(g); }

  // 飘伤害数字 / 治疗数字
  function floatValue(el, text, heal) {
    const r = rectOf(el);
    if (!r) return;
    const d = document.createElement('div');
    d.className = 'dmg-float' + (heal ? ' heal' : '');
    d.textContent = text;
    d.style.left = (r.left + r.width / 2) + 'px';
    d.style.top = (r.top + r.height * 0.3) + 'px';
    document.body.appendChild(d);
    setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 900);
  }

  // 攻击冲刺：先把攻击者朝目标推过去，再让引擎结算（视觉上像"撞上去"）
  function lunge(sourceEl, targetEl) {
    const a = rectOf(sourceEl), b = rectOf(targetEl);
    if (!a || !b || !sourceEl.style) return Promise.resolve();
    const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
    const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    sourceEl.style.transition = 'transform .13s ease-out';
    sourceEl.style.transform = 'translate(' + (dx * 0.42) + 'px,' + (dy * 0.42) + 'px) scale(1.08)';
    return new Promise(res => setTimeout(() => {
      sourceEl.style.transition = 'transform .16s ease-in';
      sourceEl.style.transform = '';
      setTimeout(res, 170);
    }, 140));
  }

  // 指令：手牌飞到棋盘中央闪一下
  function orderFly(card, srcEl) {
    const r = rectOf(srcEl) || rectOf($('#boardScroll'));
    const board = rectOf($('#boardScroll'));
    if (!r || !board) return;
    const g = makeGhost(card, r.left + r.width / 2, r.top + r.height / 2, 'order-fly');
    g.style.left = (board.left + board.width / 2) + 'px';
    g.style.top = (board.top + board.height / 2) + 'px';
    setTimeout(() => endGhost(g), 520);
    const b = $('#boardScroll');
    b.classList.add('order-flash');
    setTimeout(() => b.classList.remove('order-flash'), 520);
  }

  // FLIP 会不会接管这次重绘？（接管了就别再叠 .moved-in —— 两套 transform 会互踩成"瞬移+掉下来"）
  function flipWillRun() {
    const AN = global.KGAnim;
    return S.readyForAnim !== false && !!(AN && (AN.flipByUid || AN.flip));
  }

  function beginCardDrag(ev, payload, srcEl, card) {
    if (!ev || ev.clientX == null) return;
    if (ev.button != null && ev.button !== 0) return;
    if (ev.target && ev.target.closest && ev.target.closest('button, input, select, a')) return;
    if (drag) return;
    if (isMobileUI() && (payload.kind === 'hand' || payload.kind === 'unit') && (acting || S.pending)) return;
    const AN = global.KGAnim;
    if (AN && AN.interrupt && srcEl) AN.interrupt(srcEl);
    drag = { payload: payload, srcEl: srcEl, pointerId: ev.pointerId, touch: ev.pointerType === 'touch',
      x0: ev.clientX, y0: ev.clientY, moved: false, card: card, ghost: null, arrow: null };
    // ★ 按下**立刻**给"拎起来"的反馈（原版手感：牌在你指头底下就抬起来了）。
    //   移动距离够格转正式拖拽时再换成 ghost / 箭头；点了不动（click）则摘掉，无痕。
    if (srcEl && srcEl.classList) srcEl.classList.add('pressing');
    // ★ 手机上点手牌会展开全屏检视（z88 黑幕）——开始拖拽就该收掉，
    //   否则"先点看详情、再拖去打出"时黑幕一直盖在屏上。
    hideTip();
  }

  function onPointerMove(ev) {
    if (!drag || ev.clientX == null) return;
    if (drag.pointerId != null && ev.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      // ★ 手机端卡池/卡组条目上的拖拽要给**滚动手势让路**（制作者："根本没法滑动翻页"）：
      //   手指主要往下（上）走 = 想滚动列表 → 取消拖拽，浏览器正常滚动。
      //   ⚠ deckRm 例外：手指已经**拖出卡组列表**（往上擦出列表顶）时是"移除"手势，
      //     不能当成滚动 —— 只有手指还压在列表内才让路。
      if (drag.payload && (drag.payload.kind === 'poolAdd' || drag.payload.kind === 'deckRm')) {
        const ddx = ev.clientX - drag.x0, ddy = ev.clientY - drag.y0;
        if (Math.abs(ddy) > Math.abs(ddx) && Math.abs(ddy) > 12) {
          let overList = true;
          if (drag.payload.kind === 'deckRm' && typeof document.elementFromPoint === 'function') {
            const under = document.elementFromPoint(ev.clientX, ev.clientY);
            overList = !!(under && closestClass(under, 'deck-list'));
          }
          if (overList) { cancelDrag(); return; }
        }
      }
      if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < (drag.touch ? 14 : DRAG_MIN)) return;
      drag.moved = true;
      if (drag.srcEl) drag.srcEl.classList.remove('pressing');   // 按下反馈让位给正式拖拽视觉
      document.body.classList.add('dragging-card');
      const AN = global.KGAnim;
      // ★ 指向性手牌（指令/反制里需要选目标的）拖拽时也要伸**瞄准箭头**（bug7）：
      //   原实现只给单位伸箭头，手牌一律走 ghost，于是拖指令瞄准敌人时没有任何指向反馈。
      const _pdef = (drag.payload && drag.payload.kind === "hand") ? handCardDef(drag.payload) : null;
      const _targetedHand = !!(_pdef && _pdef.cardType !== "unit" && _pdef.targetsNeeded && _pdef.targetsNeeded.length);
      if ((drag.payload && drag.payload.kind === "unit") || _targetedHand) {
        // ★ 拖自己的单位 = **从单位伸出一条弹性曲线箭头**，而不是把卡牌拎起来。
        //   卡牌本身只轻微"抬起"（.aiming-from），位置不动 → 不会有"卡跟着鼠标跑"的错觉。
        if (drag.srcEl) drag.srcEl.classList.add('aiming-from');
        const r = drag.srcEl ? rectOf(drag.srcEl) : null;
        if (AN && AN.arrow && r) {
          drag.arrow = AN.arrow({
            x: r.left + r.width / 2, y: r.top + r.height / 2,
            color: '#ffb27a', aimColor: '#ff5a44',
            // 曲线弯向按单位在屏幕上半/下半决定，让箭头"绕开"自己那一排
            bend: r.top + r.height / 2 > (window.innerHeight || 800) * 0.5 ? -1 : 1,
          });
          drag.arrow.set(ev.clientX, ev.clientY);
        }
      } else {
        // 手牌部署 / 指令：仍然用"拖牌"的视觉（手牌本来就不在场上，没有"伸箭头"的语义）
        if (drag.srcEl) drag.srcEl.classList.add('dragging');
        drag.ghost = makeGhost(drag.card, ev.clientX, ev.clientY);
      }
      highlightValidTargets(drag.payload);
    }
    if (drag.arrow) drag.arrow.set(ev.clientX, ev.clientY);
    moveGhost(drag.ghost, ev.clientX, ev.clientY);
    // ⚠ 顺序很重要：先用"未被挤动"的布局算出落点，再插占位格。
    //   之前是先插 gap 再判定，插进去的宽节点把邻近卡片推走，下一帧 elementFromPoint
    //   就落在被推走的卡上 → 拖拽攻击判定失效。这里把顺序倒过来，并缓存本次结果，
    //   让 onPointerUp 复用同一份判定（避免两次判定不一致）。
    let info = dropInfoAt(ev.clientX, ev.clientY);
    const upDistance = drag.y0 - ev.clientY;
    if (upDistance >= 32 && drag.payload && drag.payload.kind === 'unsuspend') info = { kind: 'unsuspend' };
    if (upDistance >= 32 && drag.payload && drag.payload.kind === 'hand') {
      const draggedDef = handCardDef(drag.payload);
      if (draggedDef && draggedDef.cardType === 'counter') info = { kind: 'counterSuspend' };
    }
    drag.lastInfo = info;
    drag.lastXY = { x: ev.clientX, y: ev.clientY };
    // 箭头指向合法目标时变色（红）—— 给"能不能打"一个即时的视觉答复
    if (drag.arrow) drag.arrow.aim(!!(info && (info.kind === 'unit' || info.kind === 'hq')));
    showDropHint(info);
  }

  // 拖单位时把"能打的目标"直接标出来（免得瞎放下、点不到）
  function highlightValidTargets(payload) {
    clearValidTargets();
    const st = S.state, H = S.humanSide || 0, A = 1 - H;
    if (!st || !payload) return;
    if (payload.kind === 'unit') {
      const u = KG.unitByUid(st, payload.uid);
      if (!u) return;
      KG.allUnitsOf(st, A).forEach(t => {
        if (KG.canAttack(st, H, u.uid, { kind: 'unit', uid: t.uid }).ok) {
          const el = unitElByUid(t.uid);
          if (el) el.classList.add('can-hit');
        }
      });
      if (KG.canAttack(st, H, u.uid, { kind: 'hq', player: A }).ok) {
        const el = hqElOf(A);
        if (el) el.classList.add('can-hit');
      }
    }
  }
  function clearValidTargets() {
    document.querySelectorAll('.can-hit').forEach(e => e.classList.remove('can-hit'));
  }

  // ★ 行动串行化（bug8）：一次只允许一个落子在结算。
  //   动画是异步的，玩家可以在上一段动画没结束时再拖一次 —— 两段落子并发会出现动画叠在一起、
  //   甚至两次结算都基于同一份旧状态。这里用一条 promise 链把落子排队：后一次一定等前一次结束。
  let actChain = Promise.resolve();
  let acting = 0;
  function serializeAction(fn) {
    acting++;
    const run = actChain.then(fn, fn);
    actChain = run.then(function () { acting--; }, function () { acting--; });
    return run;
  }
  /* 把拎着的 ghost 飞回卡牌原位（取消拖拽 / 丢到无效位置时）——
   * 原版手感：卡是"放回桌上"，不是原地蒸发。ghost 的 transform 是 translate(-50%,-50%)，
   * 所以 left/top 就等于中心点，直接过渡到 srcEl 中心即可。 */
  function flyGhostBack(g, srcEl) {
    if (!g) return;
    const r = rectOf(srcEl);
    if (!r || !g.style) { endGhost(g); return; }
    g.style.transition = 'left .18s cubic-bezier(.2,.8,.3,1), top .18s cubic-bezier(.2,.8,.3,1), opacity .2s ease';
    g.style.left = (r.left + r.width / 2) + 'px';
    g.style.top = (r.top + r.height / 2) + 'px';
    g.style.opacity = '0';
    setTimeout(() => endGhost(g), 210);
  }

  /* 拖拽进行中取消（ESC / 右键）——原版手感：右键 = 把拎起来的牌收回手里。
   * 只处理"已经真的拖起来了"（moved）的，纯点击不受影响。 */
  function cancelDrag() {
    const d = drag; if (!d) return;
    drag = null;
    document.body.classList.remove('dragging-card');
    clearDropHint();
    clearValidTargets();
    if (d.srcEl) d.srcEl.classList.remove('dragging', 'aiming-from', 'pressing');
    if (d.arrow) d.arrow.destroy();
    flyGhostBack(d.ghost, d.srcEl);
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
  }

  async function onPointerUp(ev) {
    if (drag && drag.pointerId != null && ev.pointerId !== drag.pointerId) return;
    const d = drag; drag = null;
    if (!d) return;
    document.body.classList.remove('dragging-card');
    clearDropHint();
    clearValidTargets();
    if (d.srcEl) d.srcEl.classList.remove('dragging', 'aiming-from', 'pressing');
    if (d.arrow) d.arrow.destroy();
    if (!d.moved) { endGhost(d.ghost); return; }          // 只是点了一下 → 交给 click 处理
    swallowClick = true;
    // 只吞本次松手产生的 click，不能一直吞到抉择/选目标结束。
    setTimeout(() => { swallowClick = false; }, 0);
    // 优先复用 pointermove 里已经算好的落点（那时布局是"干净"的）；
    // 只有指针在按下后没移动过、没有缓存时，才现算一次。
    let info = d.lastInfo;
    if (!info && d.lastXY && Math.abs(d.lastXY.x - ev.clientX) < 3 && Math.abs(d.lastXY.y - ev.clientY) < 3) {
      info = d.lastInfo;
    }
    // clearDropHint() 已经把占位格摘掉、布局恢复原样，此时重算也是安全的
    if (!info) {
      // ★ 重算落点时必须把 drag 放回去：dropInfoAt 要靠 drag.payload 判"手牌是单位还是指令/反制"，
      //   以及"拖的是不是能攻击的单位"。以前这里 drag 已经被置空 → 所有依赖 payload 的落点判定直接失效
      //   （拖指令/反制到敌方单位或敌方总部 = 永远"没放到有效位置"），而 pointermove 的缓存命中与否
      //   还随鼠标轨迹变化 → 表现为"时好时坏、实战里根本放不下去"（反制/解体尤甚）。
      drag = d;
      info = dropInfoAt(ev.clientX, ev.clientY);
      drag = null;
    }
    const point = { x: ev.clientX, y: ev.clientY };
    const sourceRect = rectOf(d.srcEl);
    const dragRect = sourceRect ? {
      left: point.x - sourceRect.width / 2, top: point.y - sourceRect.height / 2,
      width: sourceRect.width, height: sourceRect.height,
    } : null;
    const upward = d.y0 - point.y;
    if (d.payload && d.payload.kind === 'unsuspend') {
      info = upward >= 32 ? { kind: 'unsuspend' } : null;
    } else if (d.payload && d.payload.kind === 'hand') {
      const draggedDef = handCardDef(d.payload);
      if (draggedDef && draggedDef.cardType === 'counter') {
        // 反制牌上拖挂起；松手位置用作滑入反制区的动画起点。
        info = upward >= 32 ? { kind: 'counterSuspend' } : null;
      }
    }
    // 指向可打目标的瞬间弹一下，给"锁定"一个反馈
    if (info && (info.kind === 'unit' || info.kind === 'hq')) {
      const AN = global.KGAnim;
      const el = info.kind === 'unit' ? unitElByUid(info.uid) : hqElOf(info.player);
      // 传目标单位 → 拖到坦克上是金属声、拖到步兵上是泥土声
      const tgtU = info.kind === 'unit' ? KG.unitByUid(S.state, info.uid) : null;
      if (AN && AN.impact && el) AN.impact(el, 'hit', { target: tgtU });
    }
    // ★ 先收掉拖拽 ghost 再结算（修"手机端卡牌 ghost 卡死在松手点"）：
    //   applyDrop 遇到"抉择/选牌"类效果时 promise 会一直挂着等玩家选完，
    //   旧写法把 endGhost/flyGhostBack 放在 await 之后 → 抉择悬而未决的整段时间里
    //   ghost 僵在松手点不动。牌已离手，"无效落点飞回原位"也不该被结算动画拖住。
    if (!info && d.ghost) flyGhostBack(d.ghost, d.srcEl);
    else endGhost(d.ghost);
    await serializeAction(function () { return applyDrop(d.payload, info, { fromEl: d.srcEl, dragRect: dragRect, dropPoint: point }); });
  }

  // 指针位置 → 落点描述：插到第几格 / 阵线 / 单位 / 总部
  function dropInfoAt(x, y) {
    if (typeof document.elementFromPoint !== 'function') return null;
    let el = document.elementFromPoint(x, y);
    if (!el) return null;
    const H = S.humanSide || 0;
    const payload = drag && drag.payload;
    // ⚠ 真实浏览器里 elementFromPoint 常常返回**容器**（.slot / .line-units）而不是 .card 本身：
    //   卡面是 `position:absolute; inset:0`，两张卡之间的缝隙、或卡面尚未铺满的边角，
    //   命中的都是 .slot。这时要自己往下/往上找"这一格里的卡"，
    //   否则拖拽攻击会判定成"没放到有效位置" —— 这就是拖拽攻击最主要的丢判定来源。
    el = resolveCardAt(el, x, y) || el;
    // 手机松手在整条阵线的空白区也算落在该阵线，不要求压中较窄的卡牌容器。
    if (isMobileUI() && payload && (payload.kind === 'hand' || payload.kind === 'unit') && !closestData(el, 'dropZone')) {
      const row = el.closest && el.closest('#mySupport, #foeSupport, #frontline');
      const line = row && row.querySelector('.line-units');
      if (line) el = resolveCardAt(line, x, y) || line;
    }
    // ★ 手机端构筑拖拽（池→卡组加入 / 卡组→拖出移除）：只在"卡组列表"这个容器上分家，
    //   不走下面战场的槽位/单位判定 —— 构筑屏里根本没有那些东西。
    //   poolAdd：丢进卡组列表 = 加入；deckRm：拖出列表 = 移除，拖回列表里 = 反悔（无操作）。
    if (payload && payload.kind === 'poolAdd') {
      return closestClass(el, 'deck-list') ? { kind: 'deckAdd' } : null;
    }
    if (payload && payload.kind === 'deckRm') {
      return closestClass(el, 'deck-list') ? { kind: 'noop' } : { kind: 'deckRemove' };
    }
    // 单位卡 / 自己人 → "放到它那一格"；否则（敌方单位）→ 指定目标（需可攻击）
    const uidEl = closestData(el, 'uid');
    if (uidEl) {
      const uid = uidEl.dataset.uid;
      // ★ 非单位手牌（指令/反制）的落点放宽 —— 实战里拖到"自己人身上 / 敌人身上"都报过"没放到有效位置"，
      //   玩家会以为这张牌根本打不出去（尤其是「解体」这种卡面写着打敌方总部的卡）。
      //   丢在**我方单位**上 = 等于丢在这条线这一格；丢在**敌方单位**上 = 合法落点。
      if (isNonUnitHand(payload)) {
        const tu = KG.unitByUid(S.state, uid);
        const dH = handCardDef(payload);
        if (tu && tu.owner === H) {
          // ★ 指向性指令/反制：目标规格允许友方 → 丢到友方单位 = **指向它**（2026-10-02 修"不能指友方"）。
          //   非指向的指令/反制维持原语义：等于丢在这条线这一格（直接打出）。
          if (orderAllowsFriendlyTarget(dH)) return { kind: "unit", uid: uid };
          const l2 = closestClass(uidEl, "line-units");
          const z2 = l2 && l2.dataset.dropZone;
          if (l2 && z2) return mySupportSlotDrop(z2, l2.dataset.side, l2, x);
        } else if (tu) {
          return { kind: "unit", uid: uid };
        }
      }

      if (!placeOnAlly(uid, payload, H)) {
        // 敌方单位：需验证能否攻击
        if (canAttackEnemyUnit(uid)) return { kind: 'unit', uid: uid };
        return null;
      }
      // ★ 命中**我方单位卡**时的落点语义，按 payload.kind 分层：
      //
      //   • payload.kind === 'unit'（拖自己的单位）：这是"攻击 / 换位 / 归位"，
      //     目标就是这张卡本身 → 返回 {kind:'unit'}，由 applyDrop 裁决（攻击敌方、
      //     与我方单位换位、或拖回自己总部）。
      //
      //   • payload.kind === 'hand'（从手牌部署）：部署**不需要指向任何单位**。
      //     用户诉求："你的单位部署时并不需要指向他们，所以当鼠标悬在一张卡牌的
      //     左侧时就可以直接让开了，并不需要精准地指在缝隙里。"
      //     → 一律降级为"这条线上的插位 slot"，插到第几格完全由几何决定
      //       （insertionIndexAt 按卡的中线判定：光标在卡中心左侧 → 插它前面，
      //        右侧 → 插它后面）。
      //     ★ 返回的 index 是**视觉下标**（含总部那一格），applyDrop 会换算成引擎下标。
      if (payload && payload.kind === 'hand') {
        const lineEl = closestClass(uidEl, 'line-units');
        const zside = lineEl && lineEl.dataset.side;
        const zone = lineEl && lineEl.dataset.dropZone;
        if (lineEl && zone) {
          return mySupportSlotDrop(zone, zside, lineEl, x);
        }
      }
    }
    const hqEl = closestData(el, 'hq');
    if (hqEl && !uidEl) {
      const player = +hqEl.dataset.hq;
      // ★ 部署手牌**落到总部本身上**：总部是支援线上的一个真实位置。
      //   光标压在总部卡**左半边** → 插到它左边（视觉下标 = 总部当前下标，带 hqDisplace:'left'）；
      //   压在**右半边** → 插到它右边（视觉下标 = 总部下标 + 1）。
      //   这正好实现用户要的"单位既能部署在总部左边，也能在右边"。
      if (player === H && payload && payload.kind === 'hand') {
        const lineEl = closestClass(hqEl, 'line-units');
        if (lineEl) {
          return mySupportSlotDrop('support', 'me', lineEl, x);
        }
      }
      // 敌方总部：需要"能攻击"才合法。
      if (player === H) return { kind: 'hq', player: player };
      if (canAttackEnemyHQ(player)) return { kind: 'hq', player: player };
      if (isNonUnitHand(payload)) return { kind: "hq", player: player };   // ★ 非单位手牌：敌方总部也是合法落点
      return null;
    }
    const zoneEl = closestData(el, 'dropZone');
    if (zoneEl) {
      const zside = zoneEl.dataset.side;
      const zone = zoneEl.dataset.dropZone;
      // 敌方阵线：只有"打到敌方单位/总部"才合法，落到空格上不给插位提示
      const zowner = zoneEl.dataset.owner;
      const foeLine = (zowner != null && String(zowner) !== String(H))
        || (zone === 'frontline' && zoneOwnerIsFoe(zoneEl));
      if (foeLine) {
        // ★ 非指向性的指令/反制：丢到敌方阵线空白处也直接打出（实战里最常见的手势）
        const d2 = handCardDef(payload);
        if (d2 && d2.cardType !== "unit" && !(d2.targetsNeeded && d2.targetsNeeded.length)) {
          return { kind: "slot", zone: zone, side: zside, index: insertionIndexAt(zoneEl, x) };
        }
        // ★ 指向性指令/反制丢在敌方线的空白处 → **就近指向最近的敌方单位**
        //   （2026-10-02 修"指向敌方单位有时会失灵"：原来必须精准压在单位卡上，
        //     落在缝隙/空白处直接报"没有有效落点"）
        if (d2 && d2.cardType !== 'unit' && d2.targetsNeeded && d2.targetsNeeded.length) {
          const near = nearestUidInLine(zoneEl, x);
          if (near) return { kind: 'unit', uid: near };
        }
        return null;
      }
      return mySupportSlotDrop(zone, zside, zoneEl, x);
    }
    return null;
  }

  /* ★ 我方支援线的 slot 落点统一从这里造（2026-10-02 修"单位下不到总部左边"）：
     插入视觉下标恰好等于总部格位（= 光标停在总部中线或其左侧）时，
     必须带上 hqDisplace:'left' —— 引擎 insertUnitAt 的默认语义里 at===hqSlot 是
     "总部右邻、不挤"，不带这个标记的话"丢到总部左边"会被静默放到总部右边。 */
  function mySupportSlotDrop(zone, side, lineEl, x) {
    const idx = insertionIndexAt(lineEl, x);
    const disp = (zone === 'support' && side === 'me' && idx === hqSlotOf(S.humanSide || 0));
    return { kind: 'slot', zone: zone, side: side, index: idx, displaceLeft: disp };
  }

  // 光标命中的元素可能是容器（.slot / .line-units / .hq-card / <img> 之类），  // 这里把它归一化成"这一格里那张带 data-uid 的卡（或总部卡）"，找不到就原样返回。
  // 传 x 时可以按几何位置兜底找最近的卡（光标落在卡缝隙上时非常有用）。
  function resolveCardAt(el, x, y) {
    if (!el) return null;
    // 已经在卡上（或卡内部）→ 直接由 closestData 处理
    if (closestData(el, 'uid') || closestData(el, 'hq')) return el;
    // 命中某个 slot：看它怀里有没有卡
    const slot = (el.classList && el.classList.contains('slot')) ? el : closestClass(el, 'slot');
    if (slot) {
      const card = slot.querySelector(':scope > .card[data-uid]') || slot.querySelector('.card[data-uid]');
      if (card) return card;
      // ⚠ slot 里没有单位卡，但**总部卡不是装在 slot 里的**（它是 .line-units 的直接子元素），
      //   所以继续往下走几何兜底，不要在这里 return。
    }
    // 命中整条阵线（卡与卡之间的缝隙 / 总部卡上方 / 只有一个总部时的空白）：
    //   ⚠ 这里是拖拽攻击总部的**关键路径**。
    //   真实浏览器里点总部：卡面用的是 `position:absolute;inset:0`，而总部卡内部有
    //   🛡/数字/文字等多个子元素；光标常常落在 .line-units 本体或子元素之间的空隙上，
    //   elementFromPoint 于是返回 .line-units —— 而不是 .hq-card。
    //   旧代码只按 x 在"单位卡"里找最近的一张，**.hq-card 完全不在候选集**，
    //   于是拖到总部上判定为空 → 表现为"必须拖到总部偏左的空格才生效"。
    const line = (el.classList && el.classList.contains('line-units')) ? el : closestClass(el, 'line-units');
    if (line) {
      // ⚠ 候选集必须覆盖**这条线上的全部可命中卡**：
      //   单位卡（.slot > .card[data-uid]）与总部卡（.hq-card，它是 line 的直接子元素）。
      //
      //   历史坑（拖拽攻击长期失效的真凶，之一）：
      //   选择器写成 `:scope > .slot > .card[data-uid]` 时，只要 DOM 层级稍有不同
      //   （例如选位模式/让位占位格插在中间）就会取空，于是"这条线上没有卡"，
      //   几何兜底拿不到任何候选 → 直接 return line → dropInfoAt 认为"没放到有效位置"。
      //   这里改为**宽选择器 + 运行时归属校验**：先宽松地取候选，再用 closestClass
      //   确认它确实属于本 line，既不会漏卡，也不会误吞别条线的卡。
      const unitCards = Array.from(line.querySelectorAll('.card[data-uid]'))
        .filter(c => closestClass(c, 'line-units') === line);
      const hqCards = Array.from(line.querySelectorAll('.hq-card'))
        .filter(c => closestClass(c, 'line-units') === line);

      // ★ 必须是**几何判定**：光标真的压在总部卡上（或贴得很近）才算"命中总部"。
      //
      //   ── 这里曾经是一段"非几何强判据"（线上没有单位卡 + 恰好一个总部 → 直接返回总部），
      //      本意是修"拖拽攻击总部时 elementFromPoint 返回容器而不是 .hq-card"。
      //      但它**无条件**成立：只要线上没有单位卡（开局支援线上只有总部！），
      //      无论光标落在线上哪个位置都会被判成"指着总部"。
      //      于是拖一张手牌单位到**自己支援线的空白处**（本意是"部署在这里"）
      //      会先被解析成"自己的总部"，而自己的总部不是合法的落点
      //      （下面 `hqEl && !uidEl` 分支只接受"可攻击的敌方总部"）
      //      → dropInfoAt 返回 null → applyDrop 报"没放到有效位置" → **单位完全无法部署**。
      //
      //   现在改为：只有几何上确实靠近总部卡，才返回总部；否则把 `line` 原样返回，
      //   让调用方按"这条线的 slot"来处理（部署/移动/插位）。
      if (x != null) {
        const cands = unitCards.concat(hqCards);
        let best = null, bestD = Infinity;
        const yy = (y != null && isFinite(y)) ? y : null;
        cands.forEach(c => {
          const r = rectOf(c);
          if (!r) return;
          // 卡内距离 0；卡外取到矩形最近边的欧氏距离。
          //   ★ 必须同时看纵轴：前线是敌我混排的一条线，光标可能在两张卡之间
          //     偏上/偏下，只看 x 会把"离得更远的另一张卡"判成命中。
          const dx = (x >= r.left && x <= r.left + r.width) ? 0
            : Math.min(Math.abs(x - r.left), Math.abs(x - (r.left + r.width)));
          const dy = (yy != null && r.top != null && r.height != null)
            ? ((yy >= r.top && yy <= r.top + r.height) ? 0
              : Math.min(Math.abs(yy - r.top), Math.abs(yy - (r.top + r.height))))
            : 0;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < bestD) { bestD = d; best = c; }
        });
        // 命中阈值：压卡上算 0；贴边允许一点余量。
        // ⚠ 这个余量**不能**放宽到"半张卡宽"（曾是 max(6, w/2)）—— 那会让"放在总部旁边的
        //   空白格"被判成"指着总部"，又回到上面那个部署失败的老 bug。这里只用 8px 容差。
        if (best && bestD <= 8) return best;
      } else if (!unitCards.length && hqCards.length === 1) {
        // 无几何可用（极少数环境 getBoundingClientRect 不可用）：退回"线上唯一总部"。
        // 仅在**完全读不到坐标**时走这条；有坐标就以上面的几何判定为准。
        return hqCards[0];
      }
      // 没有命中任何卡 → 原样返回 line（调用方按 slot 处理）
      return line;
    }
    return el;
  }

  function closestClass(el, cls) {
    let n = el;
    while (n) {
      if (n.classList && n.classList.contains(cls)) return n;
      n = domParentOf(n);      // ⚠ 真实 DOM 没有 .parent —— 同 closestData 的说明
    }
    return null;
  }

  // 前线是共享线：判断这条 DOM 线当前是否"有敌方单位占据"
  function zoneOwnerIsFoe(lineEl) {
    const st = S.state, H = S.humanSide || 0;
    if (!st || lineEl.dataset.dropZone !== 'frontline') return false;
    return (st.frontline || []).some(u => u.owner !== H);
  }

  function canAttackEnemyUnit(targetUid) {
    const st = S.state, H = S.humanSide || 0;
    const payload = drag && drag.payload;
    if (!payload || payload.kind !== 'unit') return false;
    const uid = payload.uid;
    const chk = KG.canAttack(S.state, H, uid, { kind: 'unit', uid: targetUid });
    return chk.ok;
  }

  function canAttackEnemyHQ(targetPlayer) {
    const st = S.state, H = S.humanSide || 0;
    const payload = drag && drag.payload;
    if (!payload || payload.kind !== 'unit') return false;
    const uid = payload.uid;
    const chk = KG.canAttack(S.state, H, uid, { kind: 'hq', player: targetPlayer });
    return chk.ok;
  }

  // 丢到自己场上的单位身上 = 放到它那一格（手牌单位 / 自己的单位都算）
  // 从手牌 payload 反查卡定义：非单位手牌（指令/反制）的落点规则与单位卡不同
  function handCardDef(payload) {
    if (!payload || payload.kind !== "hand") return null;
    const st = S.state, H = S.humanSide || 0;
    if (!st || !st.players[H]) return null;
    const inst = st.players[H].hand[payload.index];
    return inst ? KG.cardDef(st, inst.id) : null;
  }
  function isNonUnitHand(payload) {
    const d = handCardDef(payload);
    return !!d && d.cardType !== "unit";
  }

  /* ★ 指向性指令的目标规格判定（2026-10-02 Alan：前提是"指令效果支持指向友方单位"）：
     只有卡的效果真声明了 kind=unit 且 side 含 friendly/any 的目标位，
     丢到友方单位上才算"指向它"；否则维持"指令不能放在自己的单位上"。 */
  function orderAllowsFriendlyTarget(def) {
    if (!def || def.cardType === 'unit' || !def.targetsNeeded || !def.targetsNeeded.length) return false;
    return def.targetsNeeded.some(s =>
      s && s.kind !== 'hq' && s.sel !== 'hqOnly' && (s.side == null || s.side === 'friendly' || s.side === 'any'));
  }
  /* 指令/反制丢在敌方阵线空白处时：就近指向最近的敌方单位（修"指向敌方单位有时失灵"） */
  function nearestUidInLine(lineEl, x) {
    if (!lineEl) return null;
    let best = null, bestD = Infinity;
    Array.prototype.forEach.call(lineEl.querySelectorAll('.card[data-uid]'), function (c) {
      const r = rectOf(c);
      if (!r) return;
      const d = Math.abs((r.left + r.width / 2) - x);
      if (d < bestD) { bestD = d; best = c.dataset.uid; }
    });
    return best;
  }

  function placeOnAlly(uid, payload, H) {
    const u = KG.unitByUid(S.state, uid);
    if (!u || u.owner !== H) return false;
    if (payload && payload.kind === 'unit') return true;
    if (payload && payload.kind === 'hand') {
      const inst = S.state.players[H].hand[payload.index];
      const def = inst ? KG.cardDef(S.state, inst.id) : null;
      return !!(def && def.cardType === 'unit');       // 指令/反制丢到人身上 = 指定目标
    }
    return false;
  }

  // 用几何位置算"插到第几格"（没格数上限，按卡的位置动态放宽）
  //
  // ★ 判定规则（模仿原版让位）：以**卡片中心线**为界。
  //   光标在某卡中心**左侧** → 插到它之前；在中心**右侧** → 插到它之后。
  //   这是最直观、也最可预期的规则：卡会朝光标两侧对称让开。
  //
  //   注意：`.slot` 之间本来有 gap（约 6px），所以"中心线"实际上让光标与卡中心
  //   对齐即可切换插入点，**不需要**去瞄准两卡之间的那条缝。
  //   （历史上之所以感觉"必须精准指在缝隙里"，真正的成因是总部被排到了阵线最右端，
  //     占住了队尾那片区域 —— 见 renderLine 末尾关于总部次序的说明。已修正。）
  //
  //   同时给一点点**向左的容差**（中心左侧 min(8px, 卡宽*0.1) 也算"插到之前"），
  //   让"想插到某卡前面"时更容易命中，但不至于把整张卡都算成"插到它前面"。
  // 用几何位置算"插到视觉第几格"。
  //   ★ 总部**也占一格**（它是线上的真实位置），所以这里要把 `.hq-card` 一起数进去。
  //     返回的是**视觉下标**（0..N），调用方再用 `visualToUnitIdx` 换成引擎的单位下标。
  //   判定以**卡片中心线**为界（原版手感）：光标在某卡中心左侧 → 插到它之前；右侧 → 之后。
  function insertionIndexAt(lineEl, x) {
    const cells = Array.from(lineEl.children || []).filter(c =>
      c.className.indexOf('gap') < 0 && c.className.indexOf('insert-slot') < 0
      && ((c.dataset && c.dataset.slot != null) || (c.dataset && c.dataset.hq != null)));
    let idx = 0;
    for (const c of cells) {
      const r = rectOf(c);
      if (!r) continue;
      const mid = r.left + r.width / 2;
      const bias = Math.min(8, r.width * 0.1);      // 向左的轻微容差
      if (x > mid - bias) idx++; else break;
    }
    return idx;
  }

  /* ===== 支援线「视觉槽位」↔ 引擎「单位槽位」的换算 =====
   *
   * 用户诉求："单位既能部署在总部左边，也能部署在总部右边。"
   * 所以**总部占支援线上的一个真实位置**（`p.hqSlot`，视觉下标），像一张卡：
   *
   *    视觉： [0] [1] [2] [3] ...        ← 其中恰好一个是总部
   *    引擎： support 数组里**只有单位**，不含总部
   *
   * 换算规则（唯一真源）：
   *    · 单位数组下标 `i` → 视觉下标 = i + (hqSlot <= i ? 1 : 0)
   *    · 视觉下标 `v`（要插的位置）→ 单位数组下标 = v - (v > hqSlot ? 1 : 0)
   * 也就是说：总部左侧的单位数组下标不动，右侧的 +1。
   * 这样总部两侧都能插，且引擎侧完全不用改（`slotOf` 语义保持"0=最左的单位"）。 */
  function hqSlotOf(owner) {
    const p = S.state && S.state.players[owner];
    if (!p || p.hqSlot == null) return -1;         // -1 = 视觉线里没有总部这一格
    return p.hqSlot;
  }
  function visualToUnitIdx(owner, v) {
    const hq = hqSlotOf(owner);
    if (hq < 0 || v <= hq) return v;
    return v - 1;
  }
  function unitIdxToVisual(owner, i) {
    const hq = hqSlotOf(owner);
    if (hq < 0 || i < hq) return i;
    return i + 1;
  }

  // 落点提示：插位就"让开一个位置"（插一个占位格，后面的卡自动右移）
  //
  // ⚠ 避让范围（重要）：**只在"我方阵线"上避让**。
  //   敌方支援阵线、以及敌方占据的前线，一律不插占位格 —— 理由有二：
  //     1) 拖到敌方单位身上是要"攻击"，不是要"插位"；插一个宽节点会把敌方卡推走，
  //        下一帧 elementFromPoint 读到的就是被推走后的新坐标，攻击判定随机失效（拖拽攻击 bug 的根因）。
  //     2) 前线的 DOM 是**双方单位混装在同一条 .line-units 里**，插占位格会把敌我 DOM 链一起挤动。
  //   所以这里先判归属，非我方线直接 return false（调用方会退化成"只高亮目标"）。
  function showGap(zone, side, index) {
    const line = document.querySelector('.line-units[data-drop-zone="' + zone + '"][data-side="' + side + '"]');
    if (!line || typeof line.insertBefore !== 'function') return false;
    if (!lineAllowsAvoidance(line)) return false;               // ← 敌方线：不避让

    const g = document.createElement('div');
    g.className = 'slot gap drop-slot';
    // 视觉格子 = 单位格（有 data-slot）+ 总部格（有 data-hq）。
    //   `index` 是**视觉下标**，直接对应"插到第几个视觉格之前"。
    const cells = Array.from(line.children || []).filter(c =>
      c.className.indexOf('gap') < 0 && c.className.indexOf('insert-slot') < 0
      && ((c.dataset && c.dataset.slot != null && c.dataset.side === 'me')
          || (c.dataset && c.dataset.hq != null)));
    const at = cells[Math.max(0, Math.min(index, cells.length))] || null;
    try { line.insertBefore(g, at); } catch (e) { return false; }
    return true;
  }

  // 这条阵线是否允许"卡牌避让"
  //   我方支援阵线 / 我方控制的前线 → 允许
  //   敌方支援阵线 / 敌方占据的前线 → 不允许（拖过去是攻击或非法落点）
  function lineAllowsAvoidance(line) {
    const H = S.humanSide || 0;
    const owner = line.dataset.owner;
    if (owner != null && String(owner) !== String(H)) return false;
    const zone = line.dataset.dropZone;
    if (zone === 'frontline') {
      const st = S.state;
      if (!st) return false;
      // 前线是共享线：只要线上有敌方单位，就不避让（避免挤动敌方 DOM 链）
      const foeOnLine = (st.frontline || []).some(u => u.owner !== H);
      return !foeOnLine;
    }
    return owner == null || String(owner) === String(H);
  }

  // ★ 这次拖拽需要"插位让位"吗？（制作者 2026-09-22 口径）
  //
  //   需要让位的只有**单位**：
  //     · 拖场上的单位（payload.kind === 'unit'）→ 移动 / 同线换位，落点就是"插到第几格"
  //     · 拖手牌里的单位（payload.kind === 'hand' 且 cardType === 'unit'）→ 部署，落点同样按格算
  //
  //   **指令 / 反制不占阵线位置** —— 它们在 applyDrop 里落到 `kind:'slot'` 只是"直接打出"的载体
  //   （指令没有"插到第 N 格"这回事）。旧实现一律按 slot 插占位格，于是指向性指令拖到
  //   我方单位 / 我方阵线上时，场上的单位会无端让开：视觉上像"要把这张牌插进去"，
  //   与"指向性指令 = 选目标"的语义直接冲突（制作者报的"指令和反制触发了不该触发的让位"）。
  function slotNeedsMakeWay() {
    const p = drag && drag.payload;
    if (!p) return false;
    if (p.kind === 'unit') return true;
    if (p.kind === 'hand') {
      const d = handCardDef(p);
      return !!(d && d.cardType === 'unit');
    }
    return false;
  }

  function showDropHint(info) {
    clearDropHint();
    if (!info) return;
    if (info.kind === 'counterSuspend' || info.kind === 'unsuspend') {
      const pile = $('#myCounters');
      if (pile) pile.classList.add('counter-drop-ready');
      return;
    }
    // ★ 手机端构筑：拖池卡悬在卡组列表上 → 整条列表亮起（.drop-ok 由 clearDropHint 统一摘）
    //   deckMode='ai' 时加卡目标是 AI 列表（普通抽屉形态和 AI 构筑界面都是它）→ 亮 #aiDeckList
    if (info.kind === 'deckAdd') {
      const l = $(S.deckMode === 'ai' ? '#aiDeckList' : '#deckList');
      if (l && l.classList) l.classList.add('drop-ok');
      return;
    }
    if (info.kind === 'slot') {
      // 插到第几格（夹到 [0, 现有单位数]）——直接插一个占位格，后面的卡自己让开
      // ⚠ 只有"单位"才让位。指令 / 反制把 slot 当作"可打出的落点"而已，给它们插占位格
      //   会让场上的单位无端让开（指向性指令尤其误导）——判据见 slotNeedsMakeWay()。
      //   注意：这里 return 是安全的（clearDropHint 已在函数开头执行）。
      if (!slotNeedsMakeWay()) return;
      let idx = info.index;
      const H = S.humanSide || 0;
      const owner = info.side === 'me' ? H : 1 - H;
      if (owner === H && S.state) idx = Math.max(0, Math.min(idx, KG.lineOf(S.state, H, info.zone).length));
      if (!showGap(info.zone, info.side, idx)) {
        const el = slotElOf(info.zone, info.side, idx);
        if (el) el.classList.add('drop-slot', 'drop-here');
      }
    } else if (info.kind === 'unit') {
      const el = unitElByUid(info.uid);
      if (el && canAttackCurrentUnit(info.uid)) el.classList.add('drop-target');
    } else if (info.kind === 'hq') {
      const el = hqElOf(info.player);
      if (el && canAttackHQ(info.player)) el.classList.add('drop-target');
    }
  }

  function canAttackCurrentUnit(targetUid) {
    const st = S.state, H = S.humanSide || 0;
    if (!st || !drag || !drag.payload || drag.payload.kind !== 'unit') return true;
    const uid = drag.payload.uid;
    const chk = KG.canAttack(S.state, H, uid, { kind: 'unit', uid: targetUid });
    return chk.ok;
  }

  function canAttackHQ(targetPlayer) {
    const st = S.state, H = S.humanSide || 0;
    if (!st || !drag || !drag.payload || drag.payload.kind !== 'unit') return true;
    const uid = drag.payload.uid;
    const chk = KG.canAttack(S.state, H, uid, { kind: 'hq', player: targetPlayer });
    return chk.ok;
  }
  function clearDropHint() {
    document.querySelectorAll('.gap').forEach(e => { if (e.parentNode && e.parentNode.removeChild) e.parentNode.removeChild(e); });
    document.querySelectorAll('.drop-slot').forEach(e => e.classList.remove('drop-slot', 'drop-here'));
    document.querySelectorAll('.drop-ok').forEach(e => e.classList.remove('drop-ok'));
    document.querySelectorAll('.drop-target').forEach(e => e.classList.remove('drop-target'));
    document.querySelectorAll('.counter-drop-ready').forEach(e => e.classList.remove('counter-drop-ready'));
  }

  /* ------------------------------------------------------------ 落点结算 */
  // 唯一的"拖放落地"入口：指针拖拽和自动化测试都走这里
  async function applyDrop(payload, drop, opts) {
    opts = opts || {};
    const st = S.state, H = S.humanSide || 0;
    // ★ 手机端构筑拖拽（加卡/移卡）**必须放在战场状态守卫之前**：
    //   构筑屏随时可进，此时可能根本没有对局状态（st 为空）或上一局还没结束。
    if (payload && payload.kind === 'poolAdd') {
      if (drop && drop.kind === 'deckAdd') addToDeck(payload.id);
      return true;                                   // 没丢进卡组 = 静默取消，别弹"没放到有效位置"
    }
    if (payload && payload.kind === 'deckRm') {
      if (drop && drop.kind === 'deckRemove') {
        const arr = payload.ai ? S.aiDeck : S.deck;
        const i = arr.indexOf(payload.id);
        if (i >= 0) {
          arr.splice(i, 1);
          if (payload.ai) { renderAiDeckList(); }
          else { S.deckDirty = true; renderDeckList(); renderDeckLib(); }
          renderPoolGrid();
        }
      }
      return true;                                   // 拖回列表里 = 反悔，静默
    }
    if (payload && payload.kind === 'unsuspend') {
      if (!drop || drop.kind !== 'unsuspend') return false;
      if (!st || st.over || st.active !== H || !KG.canUnsuspendCounter(st, H)) return false;
      const inst = st.players[H].hand[payload.index];
      if (!inst || !inst.suspended) return false;
      const def = KG.cardDef(st, inst.id);
      const kreditsBefore = st.players[H].kredits;
      const art = opts.fromEl ? artHtmlOf(opts.fromEl) : '';
      const ok = await mpUnsuspend(st, H, inst);
      if (!ok) { toast('取消失败'); return false; }
      S._counterUnsuspendFromDrag = true;
      renderBattle();
      S._counterUnsuspendFromDrag = false;
      const cardEl = document.querySelector('.card[data-inst="' + payload.index + '"]');
      const AN = global.KGAnim;
      if (cardEl && opts.dragRect && AN && AN.flyCard) {
        cardEl.style.visibility = 'hidden';
        try { await AN.flyCard(opts.dragRect, cardEl, art, { cls: 'counter-return', fade: false }); }
        finally { cardEl.style.visibility = ''; }
      }
      toast('已取消挂起：' + def.name + '（返还 ' + (st.players[H].kredits - kreditsBefore) + ' 指挥点）');
      return true;
    }
    if (!st || st.over) return false;
    if (!drop) {
      const card = payload && payload.kind === 'hand' ? handCardDef(payload) : null;
      if (card && card.cardType === 'counter') return false;
      if (payload) toast('没放到有效位置（拖到槽位/单位/总部上）');
      return false;
    }
    if (st.active !== H) { toast('不是你的回合'); return false; }
    const ownerOf = (m) => (m === 'me' ? H : 1 - H);

    if (payload.kind === 'hand') {
      const i = payload.index;
      const inst = st.players[H].hand[i];
      if (!inst) return false;
      const def = KG.cardDef(st, inst.id);
      const chk = KG.canPlayCard(st, H, i);
      if (!chk.ok) { toast(chk.why); return false; }
      // ① 丢到自己场上某个单位身上 → 就是"放到它那一格"（单位卡）
      //    丢到敌人 / 任意总部上 → 指向性出牌（预置目标，部署效果带指定目标时也走这条）
      if (drop.kind === 'unit') {
        const t = KG.unitByUid(st, drop.uid);
        if (t && t.owner === H) {
          if (def.cardType !== 'unit') {
            // ★ 指向性指令/反制：目标规格允许友方 → 丢到友方单位 = 指向它（2026-10-02 修）。
            //   走下方 S.preTarget 指向流程（含瞄准演出）；规格不允许则维持原拒绝。
            if (!orderAllowsFriendlyTarget(def)) { toast('指令不能放在自己的单位上'); return false; }
            S.preTarget = drop.uid;
          } else {
            // 视觉下标（含总部那一格）→ 引擎单位下标（换算用插入前的 hqSlot，引擎插入时自行挤动总部）
            const visual = unitIdxToVisual(H, Math.max(0, KG.slotOf(st, t)));
            const slot = visualToUnitIdx(H, visual);
            const ok = await mpPlay(st, H, i, uiChooser(),
              { toFrontline: t.zone === 'frontline', slotIndex: slot });
            if (!ok) toast('出牌失败');

            renderBattle();
            return !!ok;
          }
        } else S.preTarget = drop.uid;
      } else if (drop.kind === 'hq') {
        if (drop.player === H) {                            // 丢到自己总部上 = 放到总部那一格
          if (def.cardType !== 'unit') { toast('指令不能放在总部上'); return false; }
          const hv = Math.max(0, hqSlotOf(H));
          // hqDisplace:'left'：卡占总部正上那格、总部被顶开右滑（引擎 insertUnitAt 的显式挤入语义）
          const ok = await mpPlay(st, H, i, uiChooser(), { slotIndex: visualToUnitIdx(H, hv), hqDisplace: 'left' });
          if (!ok) toast('出牌失败');

          renderBattle();
          return !!ok;
        }
        S.preTarget = 'hq' + drop.player;
      }
      if (S.preTarget != null) {
        // ★ 指向性出牌演出：先从手牌向目标伸一条箭头（像单位攻击那样"指"一下），
        //   然后卡牌飞向右侧（playOrderFlyAnim）→ 再真正结算。以前这里是静默结算。
        const srcEl3 = opts.fromEl || document.querySelector('.card[data-inst="' + i + '"]');
        const tEl3 = (String(S.preTarget).indexOf('hq') === 0)
          ? hqElOf(parseInt(String(S.preTarget).slice(2), 10) || (1 - H))
          : unitElByUid(S.preTarget);
        const AN3 = global.KGAnim;
        if (AN3 && AN3.aimShot && srcEl3 && tEl3) { await AN3.aimShot(srcEl3, tEl3); }
        if (AN3 && srcEl3) { await playOrderFlyAnim(srcEl3, def, { sourceRect: opts.dragRect || rectOf(srcEl3) }); }
        else { orderFly(def, srcEl3); }
        const ok = await mpPlay(st, H, i, uiChooser());
        S.preTarget = null;
        if (!ok) toast('出牌失败');

        renderBattle();
        return !!ok;
      }
      // ② 丢到阵线上 → 部署（可选择槽位）
      const zone = drop.zone;
      const owner = drop.side != null ? ownerOf(drop.side) : H;
      if (owner !== H) {
        // ★ 非指向性的指令/反制：丢到敌方那条线的空白处 = 直接打出（它本来就不需要选目标）
        const nonTargeted = def.cardType !== "unit" && !(def.targetsNeeded && def.targetsNeeded.length);
        if (!nonTargeted) { toast("要指定目标就把牌拖到敌方单位/总部上"); return false; }
      }
      if (def.cardType !== 'unit') {                      // 指令/反制直接打出去
        const srcEl = opts.fromEl || document.querySelector('.card[data-inst="' + i + '"]');
        const srcRectHold = opts.dragRect || (srcEl ? rectOf(srcEl) : null);
        const AN = global.KGAnim;
        // 反制埋设是把牌挂入反制区，不是打出指令；只在成功后从松手位置平滑滑入反制堆。
        if (def.cardType !== 'counter') {
          if (AN && srcEl) { await playOrderFlyAnim(srcEl, def, { sourceRect: opts.dragRect || rectOf(srcEl) }); }
          else { orderFly(def, srcEl); }
        }
        const ok = await mpPlay(st, H, i, uiChooser());
        if (!ok) toast('出牌失败');

        if (ok && def.cardType === 'counter') {
          toast('已挂起反制：' + def.name, 2000);
          if (AN && AN.holdCounter) {
            try { AN.holdCounter(srcRectHold, $('#myCounters'), { artHtml: srcEl ? artHtmlOf(srcEl) : '' }); } catch (e) { }
          }
        }
        renderBattle();
        return !!ok;
      }
      if (zone === 'frontline' && !(def.kwMap && def.kwMap.airdrop)) {
        toast('普通单位只能先部署到支援阵线；部署后可以再花行动花费移上前线');
        return false;
      }
      const srcEl2 = opts.fromEl || document.querySelector('.card[data-inst="' + i + '"]');
      const srcRect2 = opts.dragRect || rectOf(srcEl2);
      const artHtml2 = srcEl2 ? artHtmlOf(srcEl2) : '';
      // 支援线部署：把**视觉下标**换算成引擎单位下标；总部是否被挤由引擎在插入时维护
      let slotIndex2 = null;
      let hqDisp2;
      if (drop.kind === 'slot') {
        const vis = drop.index;
        // ★ 丢到总部左侧（插入点=总部格位）→ 显式挤入语义，把总部顶开右滑（2026-10-02 修）
        if (zone === 'support' && owner === H && drop.displaceLeft && vis === hqSlotOf(H)) {
          hqDisp2 = 'left';
        }
        slotIndex2 = visualToUnitIdx(H, vis);
      } else if (zone === 'support') {
        slotIndex2 = null;                              // 落到整条线（未指定格）→ 队尾
      }
      const ok = await mpPlay(st, H, i, uiChooser(),
        { toFrontline: zone === 'frontline', slotIndex: slotIndex2, hqDisplace: hqDisp2 });
      if (!ok) toast('出牌失败');

      // 单位落地：从"刚才那张手牌的位置"飞到棋盘上
      const AN2 = global.KGAnim;
      if (ok && AN2 && srcRect2) {
        const uidNew = newestUidSince(S.seenDeployUids);
        renderBattle();
        const fresh = uidNew ? unitElByUid(uidNew) : null;
        if (fresh) {
          fresh.style.visibility = 'hidden';
          await AN2.flyCard(srcRect2, fresh, artHtml2, { cls: 'fly-deploy' });
          fresh.style.visibility = '';
          await AN2.pulse(fresh, 'pulse', 420);
        }
        markKnownUids();
        return true;
      }
      renderBattle();
      return !!ok;
    }

    if (payload.kind === 'unit') {
      const uid = payload.uid;
      const u = KG.unitByUid(st, uid);
      if (!u || u.owner !== H) return false;
      // ① 丢到自己人身上 → 放到它那一格（同线=换位，跨线=移动）；丢到自己的总部 → 支援线最左
      if (drop.kind === 'unit') {
        const t = KG.unitByUid(st, drop.uid);
        if (t && t.owner === H) {
          const slot = Math.max(0, KG.slotOf(st, t));
          if (t.zone === u.zone) {
            const moved = await mpReposition(st, H, uid, slot);
            renderBattle();
            return !!moved;
          }
          const ok = await mpMove(st, H, uid, t.zone, null, slot);
          if (!ok) toast('移动失败');
          renderBattle();
          return !!ok;
        }
      }
      if (drop.kind === 'hq' && drop.player === H) {
        if (u.zone === 'support') { const moved = await mpReposition(st, H, uid, 0); renderBattle(); return !!moved; }
        const ok = await mpMove(st, H, uid, 'support', null, 0);
        if (!ok) toast('移动失败');
        renderBattle();
        return !!ok;
      }
      // ② 丢到敌人身上 → 攻击
      if (drop.kind === 'unit' || drop.kind === 'hq') {
        return await doAttack(uid, drop.kind === 'hq' ? { kind: 'hq', player: drop.player } : { kind: 'unit', uid: drop.uid });
      }
      // ③ 丢到阵线上 → 移动（同一条线内就是换个位置，不花行动花费）
      const zone = drop.zone;
      const owner = drop.side != null ? ownerOf(drop.side) : H;
      if (owner !== H) { toast('要攻击就把单位拖到敌方单位/总部上'); return false; }
      if (u.zone === zone) {
        const moved = await mpReposition(st, H, uid, drop.kind === 'slot' ? drop.index : null);

        renderBattle();
        // ⚠ 这里**不能**再补 .moved-in：它是"从上方 28px 淡入"的**入场**动画，
        //   语义上根本不是"移动"；而且它加在 renderBattle() 之后是**同步**执行的，
        //   比 flipByUid 量坐标的微任务更早 → isAnimating() 命中 → FLIP 直接跳过这张卡。
        //   位移现在完全由 flipByUid 负责（同线换位也一样）。
        return !!moved;
      }
      const chk = KG.canMove(st, H, uid, zone);
      if (!chk.ok) { toast(chk.why); return false; }
      const ok = await mpMove(st, H, uid, zone, null, drop.kind === 'slot' ? drop.index : null);
      if (!ok) toast('移动失败');

      renderBattle();
      return !!ok;
    }
    return false;
  }
  S.applyDrop = applyDrop;          // 也挂到导出的 S 上（KG.ui === S），方便自动化测试与外部调用
  S.dropInfoAt = dropInfoAt;        // 同上：落点判定（依赖 document.elementFromPoint）
  // 异画（供自动化测试与外部调用）
  S.cardEl = cardEl;
  S.cardArt = cardArt;
  S.hasAltArt = hasAltArt;
  S.toggleAltArt = toggleAltArt;
  // ⚠ 异画表要从 KG.ui 暴露：沙箱里 KG_ALT_ART 是 vm 全局，测试作用域读不到（会得到 0 条）
  S.isCustomCard = isCustomCard;
  // 自定义卡列表（排查用：Console 里 KG.ui.customCards() 就能拿到）
  S.customCards = function () { return (S.custom || []).slice(); };
  S.restoreCustomBackup = restoreCustomBackup;
  S.customBackupInfo = customBackupInfo;
  // 删除内置卡（逻辑删除）/ 恢复 —— 控制台同款：KG.ui.removeBuiltinCard(id) / KG.ui.restoreRemovedCards()
  S.removeBuiltinCard = removeBuiltinCard;
  S.removeBuiltinBatch = removeBuiltinBatch;
  S.restoreRemovedCards = restoreRemovedCards;
  // 2026-10-02：排查"删除内置卡"问题时，控制台第一手就该看清"到底有没有服务器"。
  //   KG.ui.hasWriteServer(true) 强制重探（跳过 30 秒缓存）。
  S.hasWriteServer = hasWriteServer;
  S.serverKnown = serverKnown;
  S.isCustomCard = isCustomCard;
  S.askConfirm = askConfirm;
  S.renderCollection = renderCollection;     // 测试/调试：手动重刷卡牌库列表
  S.removeCustomCard = removeCustomCard;
  S.showCardMenu = showCardMenu;
  S.altArtTable = (typeof KG_ALT_ART !== 'undefined') ? KG_ALT_ART : (global.KG_ALT_ART || {});
  S.beginCardDrag = beginCardDrag;  // 同上：按下（设置"正在拖什么"）
  S.pointerMove = onPointerMove;    // 同上：拖动中（进入拖拽态 + 高亮 + 落点提示）
  S.pointerUp = onPointerUp;        // 同上：松手（落点判定 + applyDrop）

  // 攻击（带冲刺 + 命中冲击 + 飘伤害）
  // 玩家与 AI 共用：冲刺 → 引擎结算 → 弹回 → 刷新（FLIP 自动补其他单位的位移）→ 飘伤害
  async function doAttack(uid, ref) {
    const st = S.state, H = S.humanSide || 0;
    const AN = global.KGAnim;
    const chk = KG.canAttack(st, H, uid, ref);
    if (!chk.ok) { toast(chk.why); return false; }
    const aEl = unitElByUid(uid);
    const tEl = ref.kind === 'hq' ? hqElOf(ref.player) : unitElByUid(ref.uid);
    const before = ref.kind === 'hq' ? st.players[ref.player].hq
      : (KG.unitByUid(st, ref.uid) ? KG.unitByUid(st, ref.uid).defense : 0);
    // 伤害数字按"弹着材质"配色（炮弹/炸弹/枪弹/能量）
    const atkUnit = KG.unitByUid(st, uid);
    const atkKind = (AN && AN.hitKindOf) ? AN.hitKindOf(AN.kindOf(atkUnit)) : null;

    let ok = false;
    if (AN && aEl && tEl) {
      const attacker = KG.unitByUid(st, uid);
      const victim = ref.kind === 'hq' ? null : KG.unitByUid(st, ref.uid);
      // 冲刺 → 命中瞬间才真正结算，视觉与逻辑对得上
      await AN.lunge(aEl, tEl, {
        unit: attacker, target: victim,          // 音效按兵种/防御力分化要用
        onHit: async () => {
          ok = await mpAttack(st, H, uid, ref);
          AN.impact(tEl, null, { target: victim || KG.unitByUid(st, ref.uid), unit: attacker });
        },
      });
    } else {
      ok = await mpAttack(st, H, uid, ref);
    }
    if (!ok) { toast('攻击失败'); renderBattle(); return false; }

    // 目标如果被打死了，tEl 已经不在 DOM 里 ── 飘数字用记录下来的坐标
    const after = ref.kind === 'hq' ? st.players[ref.player].hq
      : (KG.unitByUid(st, ref.uid) ? KG.unitByUid(st, ref.uid).defense : 0);
    renderBattle();
    const tEl2 = ref.kind === 'hq' ? hqElOf(ref.player) : unitElByUid(ref.uid);
    if (after < before) {
      if (AN) AN.floatValue(tEl2 || tEl, '-' + (before - after), atkKind);
      else floatValue(tEl2 || tEl, '-' + (before - after));
    }
    return true;
  }

  async function dropCard(i, zone, slotIndex) {
    return applyDrop({ kind: 'hand', index: i }, { kind: slotIndex == null ? 'zone' : 'slot', zone: zone, index: slotIndex, side: 'me' });
  }

  // ★ hqSlot 的位移维护已全部移交引擎（2026-09-26 Alan）：
  //   引擎 insertUnitAt / removeUnitFromBoard 在插入/离场时对称维护总部格位
  //   （插到总部左 → 右滑；左侧单位离场 → 左滑；「丢到总部上」部署由 UI 显式传
  //   hqDisplace:'left' 声明挤入语义，联机动作包原样透传）。UI 只保留 renderBattle
  //   里的初始化（null → 居中）与越界自愈。旧 afterInsertAt 预写状态已删除 ——
  //   它在 mpPlay 之前就 +1，出牌失败也不回滚，还会和引擎维护叠加成双份。

  // 总部默认位置 = **整条支援线的中点**（用户要求"总部初始居中"）。
  //   在没有单位时就是 0；有 N 个单位时是 floor((N+1)/2)，也就是视觉线正中间那一格。
  function defaultHqSlot(owner) {
    const p = S.state && S.state.players[owner];
    const n = p ? (p.support ? p.support.length : 0) : 0;
    return Math.floor((n + 1) / 2);
  }

  // 把东西丢到敌方单位/总部上（旧的 HTML5 拖拽入口已废弃，保留这个薄封装给外部调用）
  async function onDropToTarget(payload, uid, isHQ) {
    const H = S.humanSide || 0, A = 1 - H;
    const drop = isHQ ? { kind: 'hq', player: A } : { kind: 'unit', uid: uid };
    if (payload && payload.indexOf('unit:') === 0) {
      return doAttack(payload.slice(5), drop);
    }
    const idx = parseInt(payload, 10);
    if (isNaN(idx)) return false;
    return applyDrop({ kind: 'hand', index: idx }, drop);
  }

  // 对比上一帧，给"刚进场/刚受伤/刚掉血"的元素加动画
  // 注意：现在 renderBattle 走 FLIP 路径时不会调用这个（FLIP 已经负责位移动画），
  // 保留它用于"无 FLIP"场景（首帧、选位模式重建、以及每次刷新时补状态动画）。
  function animateDiff(st) {
    const H = S.humanSide || 0, A = 1 - H;
    const snap = {
      units: {}, zones: {}, types: {}, vets: {}, hq: [st.players[0].hq, st.players[1].hq],
      kredits: [st.players[0].kredits, st.players[1].kredits],
      slots: [st.players[0].maxKredits, st.players[1].maxKredits],
      counters: [(st.players[0].counters || []).length, (st.players[1].counters || []).length],
      counterRefs: [(st.players[0].counters || []).slice(), (st.players[1].counters || []).slice()],
      deck: [st.players[0].deck.length, st.players[1].deck.length],
      first: !S.prev,
    };
    const all = (st.frontline || []).concat(st.players[0].support, st.players[1].support);
    // types：留给死亡音效用 —— 单位被消灭后就从 state 里消失了，
    //   但播死亡音还想知道它是什么兵种、多厚（重单位炸得更沉）。见 renderLine 的 AN.die。
    all.forEach(u => { snap.units[u.uid] = u.defense; snap.zones[u.uid] = u.zone; snap.types[u.uid] = u.unitType; snap.vets[u.uid] = !!u.isVeteran; });
    if (!S.prev) { S.prev = snap; return; }
    const prev = S.prev;
    // 新进场（部署）→ **拍桌动画**，力度由防御力分级
    const AN = global.KGAnim;
    document.querySelectorAll('.card[data-uid]').forEach(el => {
      const uid = el.dataset.uid;
      if (el.classList.contains('dying')) return;   // 正在播死亡动画，别叠入场动画
      if (!(uid in prev.units)) {
        const u = all.find(x => String(x.uid) === String(uid));
        const def = u ? u.defense : 3;
        if (AN && u && u.isVeteran && AN.veteranUp) {
          // ★ 老兵升级 = 同一格被**老兵形态**替换（新 uid）→ 应该"金光升级"，不是"新单位拍桌"
          AN.veteranUp(el);
        } else if (AN && AN.slam) {
          // 拍桌：砸在桌面上 + 震屏 + 灰尘（力度按防御力）
          AN.slam(el, def, { boardEl: $('#boardScroll'), unit: u });   // 传单位 → 音效按防御力调音调
        } else {
          el.classList.remove('enter');
          void el.offsetWidth;
          el.classList.add('enter');
          setTimeout(() => el.classList.remove('enter'), 620);
        }
      } else if (prev.zones && prev.zones[uid] != null && snap.zones[uid] !== prev.zones[uid]) {
        // ★ 阵线之间移动（支援线 ↔ 前线）：**位移全部由 flipByUid 负责**
        //   （平滑缓动 + 弧线，见 renderBattle 的 arc:true）。
        //   这里只补"落地那一刻"的反馈：落地音 + 扬尘/浪花。
        //   ⚠ 绝不能再往卡面叠任何 transform 动画（.moved-in / .glide-land 都不行）：
        //     CSS 动画优先级高于内联 transform，会把正在播的位移**抢掉** →
        //     表现得像"滑一半突然跳过去"。制作者口径：移动后不需要落地压扁。
        if (AN && AN.glide) AN.glide(el, { duration: (AN.ANIM && AN.ANIM.move) || 360, unit: all.find(x => String(x.uid) === String(uid)) });
      } else if (prev.vets && prev.vets[uid] === false && snap.vets[uid] === true) {
        // ★ 老兵升级（**原地 +1+1** 的兜底形态：uid 不变，走不到上面"新进场"分支）→ 金光升级
        //   （换形态卡的那种升级是"新 uid"，由上面 isVeteran 分支播）
        if (AN && AN.veteranUp) AN.veteranUp(el);
      } else if (prev.units[uid] > snap.units[uid]) {
        el.classList.add('hit');
        setTimeout(() => el.classList.remove('hit'), 460);
      } else if (prev.units[uid] < snap.units[uid]) {
        el.classList.add('flash-buff');
        setTimeout(() => el.classList.remove('flash-buff'), 540);
      }
    });
    // ⚠ 必须按 H 映射：'#myHq' 是**人类那一方**的总部卡（renderHq 里按 owner===H 定 id）。
    //   原来写死 [[0,'#myHq'],[1,'#foeHq']] → 人类是后手（H=1）时，打到"我"总部却闪"对手"那张。
    [[H, '#myHq'], [A, '#foeHq']].forEach(([i, sel]) => {
      if (snap.hq[i] < prev.hq[i]) {
        const el = $(sel);
        if (!el) return;
        el.classList.remove('hit');
        void el.offsetWidth;
        el.classList.add('hit');
        setTimeout(() => el.classList.remove('hit'), 520);
      }
    });
    // 反制堆 / 牌库的变化：埋设→松手位置滑入 + 封印环；触发→**把反制牌亮出来**；
    //   手动取消挂起→从拖动位置滑回手牌。牌库变厚→卡影洗入。
    [[0, '#foeCounters', '#foeDeck'], [1, '#myCounters', '#myDeck']].forEach(function (row) {
      const i = row[0], cEl = $(row[1]), dEl = $(row[2]);
      const pc = (prev.counters && prev.counters[i] != null) ? prev.counters[i] : snap.counters[i];
      const pd = (prev.deck && prev.deck[i] != null) ? prev.deck[i] : snap.deck[i];
      const dc = (snap.counters[i] || 0) - (pc || 0);
      const dd = (snap.deck[i] || 0) - (pd || 0);
      if (AN) {
        if (dc > 0 && cEl && AN.counterSet) {
          AN.counterSet(cEl);
        } else if (dc < 0 && cEl) {
          // 挂起列表里"消失的那一条"：卡 id 出现在弃牌堆 = 真触发了（亮卡面）；
          // 否则 = 玩家取消挂起（牌回手）→ 只闪一下。
          const now = (st.players[i].counters || []);
          const gone = ((prev.counterRefs && prev.counterRefs[i]) || []).filter(function (c) { return now.indexOf(c) < 0; });
          const fired = gone.filter(function (c) {
            if (!c) return false;
            const stillInHand = c.inst && KG.findHandIndexByInst && KG.findHandIndexByInst(st.players[i], c.inst) >= 0;
            return !stillInHand && (st.players[i].discard || []).indexOf(c.cardId) >= 0;
          })[0];
          const def = fired ? uiCardById(fired.cardId) : null;
          const art = def ? (cardArt(def) ? '<img src="' + cardArt(def) + '" alt="">' : '<div class="fly-text">' + def.name + '</div>') : '';
          if (fired && def) {
            // ★ 制作者口径：反制触发 = **和指令完全同款**的演出：
            //   卡面飞到棋盘中央（playOrderCard）+ 指令分类特效（orderFx）+ 音效。
            //   逐步 try 包裹：任何一步在精简环境里不可用，都不能把整段演出打断。
            const AN5 = global.KGAnim;
            if (AN5 && AN5.orderFx) { try { AN5.orderFx(fxCategoryOf(def), { boardEl: $('#boardScroll') }); } catch (e) { } }
            const art5 = cardArt(def) ? '<img src="' + cardArt(def) + '" alt="">' : '<div class="fly-text">' + def.name + '</div>';
            if (AN5 && AN5.playOrderCard) {
              try { AN5.playOrderCard({ artHtml: art5, name: def.name, holdMs: 1000, side: (i === H ? 'self' : 'foe') }); } catch (e) { }
            } else {
              orderFly(def, cEl);
            }
            try { if (global.KGSfx && global.KGSfx.counterFire) global.KGSfx.counterFire(); } catch (e) { }
            toast('反制触发：' + def.name, 2200);
          } else if (S._counterUnsuspendFromDrag) {
            // 向上拖动取消挂起：牌会从手指松开处回到手牌，不播反制触发爆闪。
            S._counterUnsuspendFromDrag = false;
          } else if (AN.counterFire) {
            AN.counterFire(cEl, '反制取消');
          }
        }
        if (dd > 0 && dEl && AN.deckShuffle) AN.deckShuffle(dEl, dd);
      }
    });
    // ★ 烧牌（手牌满了抽到的牌）：和抽牌同款"从手牌区最右边滑进来"，然后焦化飞进弃牌堆
    if (st.burnPops && st.burnPops.length && AN) {
      const pops = st.burnPops.splice(0, st.burnPops.length);
      pops.forEach(function (b) {
        const handEl = (b.pi === H) ? $('#myHand') : $('#foeHand');
        const disEl = (b.pi === H) ? $('#myDiscard') : null;
        const def2 = uiCardById(b.id);
        const art2 = def2 ? (cardArt(def2) ? '<img src="' + cardArt(def2) + '" alt="">' : '<div class="fly-text">' + def2.name + '</div>') : '';
        if (AN.burnCard) { try { AN.burnCard(handEl, disEl, art2); } catch (e) { } }
      });
    }
    // 指挥点 / 指挥点上限的变化：在 HUD 数字上飘一个 +N / -N（原版回合开始是跳字的）
    // ⚠ 同样按 H 映射：'#myKredits'/'#mySlots' 是人类那方的（paintBattleStatus 里 me = players[H]）。
    [[H, '#myKredits', '#mySlots'], [A, '#foeKredits', '#foeSlots']].forEach(function (row) {
      const i = row[0], kEl = $(row[1]), sEl = $(row[2]);
      const pk = (prev.kredits && prev.kredits[i] != null) ? prev.kredits[i] : snap.kredits[i];
      const ps = (prev.slots && prev.slots[i] != null) ? prev.slots[i] : snap.slots[i];
      const dk = (snap.kredits[i] || 0) - (pk || 0);
      const ds = (snap.slots[i] || 0) - (ps || 0);
      if (AN && AN.kreditFloat) {
        if (dk && kEl) AN.kreditFloat(kEl, (dk > 0 ? '+' : '') + dk, 'kredit');
        if (ds && sEl) AN.kreditFloat(sEl, (ds > 0 ? '+' : '') + ds, 'kredit');
      }
    });
    S.prev = snap;
  }

  /* ★ 消费引擎的演出事件（state.fxPops）：单位效果 / 指令 / 疲劳造成的伤害。
   *   引擎只在**非对战**伤害时记（对战那条路 doAttack / playAiAttackFX 已经播了冲刺）。
   *   有来源单位 → 播和"攻击"完全同款的冲刺动画（lunge）冲向目标，命中瞬间打冲击 + 飘伤害；
   *   没有来源（指令 / 疲劳 / 来源已阵亡）→ 直接对目标打冲击 + 飘伤害。
   *   ⚠ 同一来源只冲刺一次：群体效果（对所有敌方单位造成N点）否则会让同一张卡同时播 N 段位移。 */
  function playFxPops(st, animate) {
    const AN = global.KGAnim;
    const pops = st && st.fxPops;
    if (!pops || !pops.length) return;
    const list = pops.splice(0, pops.length);          // 无论播不播都要清空，避免积压到下一帧
    if (!AN || animate === false) return;
    const lunged = {};
    let delay = 0;
    list.forEach(function (ev) {
      if (!ev || ev.k !== 'dmg') return;
      const tgtEl = ev.tgt === 'hq' ? hqElOf(ev.player) : unitElByUid(ev.uid);
      if (!tgtEl) return;                              // 目标已不在场（多半已被消灭）→ 交给死亡演出
      const tgtU = ev.tgt === 'unit' ? KG.unitByUid(st, ev.uid) : null;
      const srcU = ev.src != null ? KG.unitByUid(st, ev.src) : null;
      const srcEl = (srcU && !srcU.dead) ? unitElByUid(ev.src) : null;
      const kind = (AN.hitKindOf && srcU) ? AN.hitKindOf(AN.kindOf(srcU)) : null;
      const hit = function () {
        if (AN.impact) { try { AN.impact(tgtEl, kind, { target: tgtU, unit: srcU }); } catch (e) { } }
        if (AN.floatValue) { try { AN.floatValue(tgtEl, '-' + ev.amount, kind); } catch (e) { } }
      };
      const start = function () {
        if (srcEl && srcEl !== tgtEl && AN.lunge && !lunged[ev.src]) {
          lunged[ev.src] = true;
          try { AN.lunge(srcEl, tgtEl, { unit: srcU, target: tgtU, onHit: hit }); } catch (e) { hit(); }
        } else {
          hit();
        }
      };
      if (delay) setTimeout(start, delay); else start();
      delay += (srcEl && srcEl !== tgtEl) ? 640 : 220;
    });
  }

  /* ------------------------------------------------ 布局自检 / 诊断面板 */
  // 如果卡池"看起来应该能滚"却滚不动（scrollHeight <= clientHeight），
  // 说明高度链没生效。此时启用兜底：让整个界面自身可滚动，至少不会看不到卡。
  function layoutSelfCheck() {
    const grid = $('#poolGrid');
    const screen = $('#screen-deck');
    if (!grid || !screen) return null;
    const info = {
      winH: window.innerHeight, winW: window.innerWidth,
      gridClient: grid.clientHeight, gridScroll: grid.scrollHeight,
      gridCards: grid.children.length,
    };
    const shouldScroll = grid.children.length > 12;
    const canScroll = grid.scrollHeight > grid.clientHeight + 4;
    info.broken = shouldScroll && !canScroll;
    if (info.broken) {
      // 兜底：让卡池自身脱离父容器约束，直接给出固定可滚高度
      grid.style.maxHeight = Math.max(240, window.innerHeight - 190) + 'px';
      grid.style.overflowY = 'auto';
      screen.classList.add('fallback-scroll');
      setTimeout(updatePager, 30);
      info.fallback = true;
      info.gridClientAfter = grid.clientHeight;
      info.gridScrollAfter = grid.scrollHeight;
    }
    return info;
  }

  function showDiag() {
    const grid = $('#poolGrid');
    const pick = (sel) => {
      const el = $(sel);
      if (!el) return sel + ': (没有这个元素)';
      const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(el) : {};
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { height: 0 };
      return sel + ': 高=' + Math.round(r.height) + ' clientH=' + el.clientHeight + ' scrollH=' + el.scrollHeight +
        ' | overflow=' + (cs.overflowY || '?') + ' minH=' + (cs.minHeight || '?') + ' flex=' + (cs.flex || cs.flexGrow || '?');
    };
    const lines = [
      '时间: ' + new Date().toLocaleString(),
      '窗口: ' + window.innerWidth + ' x ' + window.innerHeight + '  dpr=' + (window.devicePixelRatio || 1),
      pick('#app'), pick('#topbar'), pick('.screen.active'), pick('.deck-layout'),
      pick('.pool-main'), pick('#poolGrid'), pick('.deck-list'),
      '卡池卡片数: ' + (grid ? grid.children.length : '?'),
      '卡池能滚动: ' + (grid ? (grid.scrollHeight > grid.clientHeight + 4) : '?'),
      '兜底滚动已启用: ' + (grid && grid.style.maxHeight ? '是' : '否'),
      '',
      '（判断标准：若"卡池能滚动: false"但卡片数很多，说明高度链仍然没生效）',
    ];
    const box = $('#diagText');
    if (box) box.textContent = lines.join('\n');
    const diag = $('#diag');
    if (diag) diag.classList.remove('hidden');
    console.log('[布局诊断]\n' + lines.join('\n'));
    return lines.join('\n');
  }

  /* ---------------------------------------------------------------- 备份 */
  /* ------------------------------------------------------- 异画（alternate art）
   * 约定：卡的图是 `A/B/-13.png`，异画就是 `A/B/-13y.png`（同名 + 后缀 y）。
   * 由 `node game/tools/scan-alt-art.js` 扫出**确实存在**的异画，生成 KG_ALT_ART（卡id → 路径）。
   * ★ 只有出现在 KG_ALT_ART 里的卡才能切换 —— 没有异画的卡**不给切换入口**，
   *   免得切出一张破图（用户的"没有 y 则不能切换"）。
   * 开关状态存在 S.altArt（localStorage 'altArt'），每张卡独立记。 */
  function altArtOf(c) {
    const T = (typeof KG_ALT_ART !== 'undefined') ? KG_ALT_ART : (global.KG_ALT_ART || null);
    return (c && T && T[c.id]) || null;
  }
  function hasAltArt(c) { return !!altArtOf(c); }
  /* ★★ 判定「当前页面背后有没有 serve.js 在跑」——**唯一权威判据**，别再用
   *   `location.protocol !== 'file:'` 猜（2026-10-02 实测踩坑，见下）。
   *
   *   为什么不能用协议猜 —— 实测三种环境：
   *     ① serve.js（正确）        protocol = http:  → /__save-cards/ping 回 {ok:true,root}
   *     ② file://（正确退逻辑删）  protocol = file:  → 压根不发请求
   *     ③ **Android APK（Capacitor）protocol = https:** ← 致命
   *        capacitor.config.json 设了 androidScheme:"https"，WebView 用
   *        https://localhost/… 提供 assets。而 WebViewAssetLoader 拿不到的路径
   *        **不返回 404，而是 fallback 回 index.html**（HTTP 200 + text/html）。
   *        于是 `location.protocol !== 'file:'` 判 true → 走进"服务器真删"分支 →
   *        POST /__delete-card → 拿回一坨 HTML → `r.json()` 抛 → `fail++` → 静默失败。
   *        **表现：点删除 → 一张没删 → 只有一句"失败 234 张"，日志里什么都没有。**
   *
   *   所以：先 ping，ping 到 {ok:true} 才算有服务器；ping 不通/返回不是 JSON
   *   → 一律按"无服务器"处理（逻辑删除，删了能恢复）。
   *   结果缓存 30 秒，避免连点时反复发探测请求。 */
  let _serverProbe = null;                 // null=没探过；true/false=结论
  let _serverProbeAt = 0;
  async function hasWriteServer(force) {
    if (typeof fetch !== 'function') return false;
    if (typeof location !== 'undefined' && location.protocol === 'file:') return false;
    const now = Date.now();
    if (!force && _serverProbe != null && (now - _serverProbeAt) < 30000) return _serverProbe;
    let ok = false;
    try {
      const r = await fetch('/__save-cards/ping', { cache: 'no-store' });
      if (r && r.ok) {
        const j = await r.json();          // ← 关键：fallback 的 HTML 会在这里抛，被 catch 吃掉
        ok = !!(j && j.ok && j.canWrite);
        if (ok && j.root) S.serverRoot = j.root;
      }
    } catch (e) { ok = false; }
    _serverProbe = ok; _serverProbeAt = now;
    return ok;
  }
  /* 同步版（供那些不想 await 的老调用点用）：只读上次探测结论，
     没探过就按"无服务器"处理（保守——宁可退逻辑删除，也不要静默卡死）。 */
  function serverKnown() {
    if (typeof location !== 'undefined' && location.protocol === 'file:') return false;
    return _serverProbe === true;
  }

  /* ★ 异画自动发现：启动（或手动调用）时问本地服务器一句"现在有哪些 y 后缀的卡图"
   *   （serve.js 的 GET /__alt-art，现扫文件系统）→ 直接换掉异画表。
   *   于是**往卡图旁边丢一张 `<原名>y.png`，刷新浏览器就能切**，不用跑 scan-alt-art.js、
   *   也不用 bump ?v=。拿不到服务器（file:// / 别的静态服务器 / fetch 不可用）→ 静默沿用
   *   js/alt-art.js 的静态表（那份是 node game/tools/scan-alt-art.js 生成的）。
   * 返回：扫到的异画张数（拿不到返回 0，绝不抛）。 */
  async function refreshAltArt() {
    if (typeof fetch !== 'function') return 0;
    if (typeof location !== 'undefined' && location.protocol === 'file:') return 0;
    try {
      const r = await fetch('/__alt-art', { cache: 'no-store' });
      if (!r || !r.ok) return 0;
      const j = await r.json();
      const alt = (j && j.alt) || null;
      if (!alt) return 0;
      let T = (typeof KG_ALT_ART !== 'undefined') ? KG_ALT_ART : (global.KG_ALT_ART || null);
      if (!T) { T = {}; try { global.KG_ALT_ART = T; } catch (e) { } }
      Object.keys(T).forEach(function (k) { delete T[k]; });      // 删掉的异画图也要跟着消失
      Object.keys(alt).forEach(function (k) { T[k] = alt[k]; });
      S.altArtTable = T;
      // 对位表（异画攻防块位置/大小）一起来了：game/data/alt-art-ui.json
      const ui = j.ui || {};
      const U = altUiTable();
      Object.keys(U).forEach(function (k) { delete U[k]; });
      Object.keys(ui).forEach(function (k) { U[k] = ui[k]; });
      return Object.keys(alt).length;
    } catch (e) { return 0; }
  }
  S.refreshAltArt = refreshAltArt;
  function useAltArt(c) { return !!(S.altArt && c && S.altArt[c.id]); }
  function toggleAltArt(c) {
    if (!hasAltArt(c)) return false;
    S.altArt = S.altArt || {};
    if (S.altArt[c.id]) delete S.altArt[c.id]; else S.altArt[c.id] = 1;
    LS.set('altArt', S.altArt);
    return true;
  }

  /* ---------------------------------------------- 异画『对位』（叠加的攻防块跟着图走）
   * 卡图是原版 500×701 整卡模板、**图里画着攻防块**，UI 叠加的那套数字要盖在图上画的块上
   * （默认：攻击块中心在卡宽 25%、防御 76%，块中心距底 24.5%、块高 14%，见 style.css 那段）。
   * 异画可能换了模板 → 叠加块必须跟着挪，否则**数字和图上画的块错位两层**。
   * 数据源：game/data/alt-art-ui.json（手填，或游戏里右键 →「异画对位…」调完保存）。 */
  const STAT_DEFAULT = { atk: { x: 25, y: 24.5, h: 14 }, def: { x: 76, y: 24.5, h: 14 } };
  function altUiTable() {
    if (!S.altArtUi) {
      S.altArtUi = (typeof KG_ALT_ART_UI !== 'undefined') ? KG_ALT_ART_UI : (global.KG_ALT_ART_UI || {});
    }
    return S.altArtUi;
  }
  function altUiOf(c) { return (c && altUiTable()[c.id]) || null; }
  // 这张卡当前该用的对位（只有**正在用异画**时才生效）；返回 null = 走 CSS 默认
  function altGeoOf(c, kind) {
    if (!useAltArt(c)) return null;
    const u = altUiOf(c);
    return (u && u[kind]) || null;
  }
  S.altUiOf = altUiOf;
  /* 底：0 = 透明（异画自带数字）；1 = **实心底，盖住图内画的数字**（图里的值和真实值不符时用）；
   * 其它合法颜色串 = 用那个颜色当底色。返回 0 / 1 / 颜色串 / null（没配 = 用 CSS 默认半透明底）。
   * ⚠ 只在**用异画时**才可能生效（对位整体就是异画专用），原图完全不受影响。 */
  function altCoverOf(o) {
    if (!o || typeof o !== 'object') return null;
    if (o.bg === 1 || o.bg === true) return 1;
    if (typeof o.bg === 'string' && /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(o.bg.trim())) return o.bg.trim();
    return null;
  }
  /* 把对位换算成**内联样式字符串**（必须序列化进 cardEl 的模板字符串：
   * 复用节点走的是 el.innerHTML = fresh.innerHTML，渲染后再改子元素不可靠 —— 见 kards-ui-skin skill） */
  function statAttrs(c, kind) {
    // ★ 只要用异画就挂 .alt-font（攻防数字换「连筋」字体）——
    //   没配对位的异画卡也要换字体，所以判断的是 useAltArt 而不是"有没有对位"
    if (!useAltArt(c)) return { cls: '', style: '' };
    const o = altGeoOf(c, kind);
    if (!o) return { cls: ' alt-font', style: '' };
    const d = STAT_DEFAULT[kind];
    const x = (o.x == null ? d.x : o.x), y = (o.y == null ? d.y : o.y), h = (o.h == null ? d.h : o.h);
    let css = 'left:' + x + '%;bottom:' + (y - h / 2) + '%;height:' + h + '%;';
    if (o.w != null) css += 'width:' + o.w + '%;';
    const scaled = (o.fs != null && o.fs !== 1);
    if (scaled) css += '--fs:' + o.fs + ';';
    if (o.color) css += 'color:' + o.color + ';';
    // ★ 盖住图内数字：bg:1 = 实心底（默认深色）；bg 是颜色串 = 用自定义底色
    const cover = altCoverOf(o);
    if (cover && cover !== 1) css += 'background:' + cover + ';';
    return {
      cls: (scaled ? ' alt-fs' : '') + ' alt-font' + (o.bg === 0 ? ' alt-nobg' : (cover ? ' alt-cover' : '')),
      style: ' style="' + css + '"',
    };
  }
  S.statAttrs = statAttrs;
  function setVar(n, k, v) {
    if (!n || !n.style) return;
    if (typeof n.style.setProperty === 'function') n.style.setProperty(k, v); else n.style[k] = v;
  }
  function delVar(n, k) {
    if (!n || !n.style) return;
    if (typeof n.style.removeProperty === 'function') n.style.removeProperty(k); else delete n.style[k];
  }
  /* 就地刷新某个已渲染卡元素的两个数字块（右键切异画时只换 img.src，不会整卡重渲） */
  function applyAltGeometry(el, c) {
    if (!el || typeof el.querySelector !== 'function') return;
    ['atk', 'def'].forEach(function (kind) {
      const n = el.querySelector('.card-stat.' + kind);
      if (!n) return;
      // ★ 字体：用异画 → 连筋；回原图 → 摘掉（两个分支都要，因为切回时内联样式会被清光）
      if (n.classList) { if (useAltArt(c)) n.classList.add('alt-font'); else n.classList.remove('alt-font'); }
      const o = altGeoOf(c, kind);
      if (!o) {                                   // 回到原图 → 清掉内联，交还 CSS 默认对位
        if (n.removeAttribute) n.removeAttribute('style');
        ['alt-fs', 'alt-nobg', 'alt-cover'].forEach(function (k) { if (n.classList) n.classList.remove(k); });
        delVar(n, '--fs');
        return;
      }
      const d = STAT_DEFAULT[kind];
      const x = (o.x == null ? d.x : o.x), y = (o.y == null ? d.y : o.y), h = (o.h == null ? d.h : o.h);
      if (n.style) {
        n.style.left = x + '%';
        n.style.bottom = (y - h / 2) + '%';
        n.style.height = h + '%';
        n.style.width = (o.w == null ? '' : o.w + '%');
      }
      const scaled = (o.fs != null && o.fs !== 1);
      if (scaled) { setVar(n, '--fs', String(o.fs)); if (n.classList) n.classList.add('alt-fs'); }
      else { delVar(n, '--fs'); if (n.classList) n.classList.remove('alt-fs'); }
      if (n.style) n.style.color = o.color || '';
      const cover = altCoverOf(o);
      if (n.classList) {
        if (o.bg === 0) n.classList.add('alt-nobg'); else n.classList.remove('alt-nobg');
        if (cover) n.classList.add('alt-cover'); else n.classList.remove('alt-cover');
      }
      // 自定义底色 → 写内联；bg:1 走 CSS 默认深色，清掉可能残留的内联底色
      if (n.style) n.style.background = (cover && cover !== 1) ? cover : '';
    });
  }
  S.applyAltGeometry = applyAltGeometry;
  /* 这张卡"可能是的图片路径"全集（原图 + 异画）。用来在**已渲染的卡**里认出
   * "这个元素显示的是不是这张卡" —— 卡牌库的卡片不带 data-id，只能认 image。
   * ⚠ 必须用**完整路径**比对，不能用文件名：`星盟/c/-13.png`、`av76/command/-13.png`、
   *   `UN/unit/-13.png` 的文件名全是 `-13.png`，按文件名认会把别的卡一起改掉（换成错图）。 */
  function altArtViewKeys(c) {
    const ks = [];
    // 每个候选都要同时收"原图路径 + 缩略图路径"：页面上现在显示的是缩略图，
    // 只认原图的话刷新异画时认不出元素 → 切了异画别的副本不跟着变。
    const add = function (u) {
      if (!u) return;
      ks.push(u);
      const t = thumbOf(u);
      if (t !== u) ks.push(t);
    };
    add(altArtOf(c));
    add(S.images[c.id]);
    add(c.art);
    add(c.src ? '../' + c.src : '');
    return ks.filter(Boolean);
  }
  /* 换成"这张卡的**所有**可见副本都跟着变"：
   *   构筑页（左边卡池 + 右边卡组可能同时有）、手牌里两张同名、卡牌库网格……
   *   以前只改**被点的那一个**元素 → 别处的副本图/攻防块全是旧的（看着像没生效）。
   * 返回刷到的元素数。 */
  function refreshAltViews(c) {
    if (!c || typeof document === 'undefined' || !document.querySelectorAll) return 0;
    const keys = altArtViewKeys(c);
    if (!keys.length) return 0;
    const want = cardArt(c);
    const all = document.querySelectorAll('.card');
    let n = 0;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const img = el.querySelector('img');
      const cur = img ? String(img.getAttribute('src') || '').split('?')[0] : '';
      if (keys.indexOf(cur) < 0) continue;            // 不是这张卡
      if (img && img.setAttribute) img.setAttribute('src', want);
      if (el.classList) { if (useAltArt(c)) el.classList.add('alt-on'); else el.classList.remove('alt-on'); }
      applyAltGeometry(el, c);
      n++;
    }
    return n;
  }
  S.refreshAltViews = refreshAltViews;

  /* ★ 缩略图（2026-09-27）：牌面只显示 104x146 px（小屏 78x110），而卡图原图是
   *   500x701 的 PNG、平均 500 KB —— 为了一格小图下载 25 倍的像素。
   *   实测卡牌库一页就要下 35 MB、全池 230 MB，局域网都慢，跨网联机（UU 云联机）
   *   的客机更是经常加载不出来。改成 208px 宽（104 的 2 倍，照顾高分屏）的 JPEG 后
   *   单张 ~15 KB，总量压到 3%。
   *   清单 game/js/thumbs.js 由 `node game/tools/make-thumbs.js` 生成；**没生成过的图
   *   原样用原图**（不会 404），所以新加卡图忘了跑脚本也只是慢，不会坏。
   *   ⚠ 只替换 '../' 开头的文件系统路径：自定义卡图是 blob: URL，不动。 */
  function thumbOf(u) {
    if (!u || String(u).indexOf('../') !== 0) return u;
    const T = global.KG_THUMBS;
    if (!T) return u;
    const rel = u.slice(3);
    // 0 = 这张图根本不存在（清单里确认过）→ 返回空，让 cardEl 画占位卡面，别发 404
    if (T[rel] === 0) return '';
    if (!T[rel]) return u;
    return '../thumbs/' + rel.replace(/\.png$/i, '.jpg');
  }
  S.thumbOf = thumbOf;

  function cardArt(c) {
    if (useAltArt(c)) {
      const a = altArtOf(c);
      if (a) return thumbOf(a);
    }
    if (S.images[c.id]) return S.images[c.id];
    if (c.art) return thumbOf(c.art);
    if (c.src) return thumbOf('../' + c.src);
    return '';
  }

  function kwLabel(c) {
    const ids = Object.keys(c.kwMap || {});
    return ids.map(k => (KG.KEYWORDS[k] ? KG.KEYWORDS[k].cn : k) + (c.kwValues && c.kwValues[k] ? c.kwValues[k] : '')).join(' ');
  }

  // ★ 按 id 取卡定义（界面权威源）：S.pool 是**数组**，绝不能用 S.pool[id]。
  //   顺序：界面卡池（含自定义/编辑）→ 引擎卡池 → state 卡池 → KG.cardDef 兜底。
  function uiCardById(id) {
    if (!id) return null;
    const arr = Array.isArray(S.pool) ? S.pool : [];
    return arr.find(c => c && c.id === id) ||
      (KG.pool && KG.pool[id]) ||
      (S.state && S.state.pool && S.state.pool[id]) ||
      (KG.cardDef ? KG.cardDef(S.state, id) : null);
  }
  S.uiCardById = uiCardById;

  function cardEl(c, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'card' + (opts.cls ? ' ' + opts.cls : '');
    const art = cardArt(c);
    // ★ 没有卡图的卡 → 用 CSS 画一张占位卡面（见 style.css 的 .card.no-art），
    //   并且**强制显示卡名**（否则整张牌白板一块，根本认不出是哪张卡）。
    if (!art) {
      el.classList.add('no-art');
      // 兵种色边 + 兵种小字（CSS 读 data 属性）
      const TY = { infantry:'步兵', tank:'坦克', artillery:'火炮', fighter:'战斗机', spacefighter:'太空战机', bomber:'轰炸机', landcruiser:'巡地舰', cruiser:'巡航舰' };
      // 通用卡面的兵种水印（CSS 的 .card.no-art::after 读 data-unitglyph）
      const GLY = { infantry:'♟', tank:'⬢', artillery:'◎', fighter:'✈', spacefighter:'✈', bomber:'✈', landcruiser:'⬢', cruiser:'⬢' };
      if (c.unitType && TY[c.unitType]) {
        el.dataset.unittype = c.unitType; el.dataset.unittypename = TY[c.unitType];
        el.dataset.unitglyph = GLY[c.unitType] || '◆';
      } else if (c.cardType === 'order') {
        el.dataset.unittype = 'order'; el.dataset.unittypename = '指令'; el.dataset.unitglyph = '✦';
      } else {
        el.dataset.unitglyph = '◆';
      }
    }
    const showName = !!c.showName || !art;
    const rar = c.rarity ? '<div class="rarity ' + c.rarity + '" title="' +
      ((KG.RARITY_INFO && KG.RARITY_INFO[c.rarity]) ? (KG.RARITY_INFO[c.rarity].cn + '：同名最多带 ' + KG.RARITY_INFO[c.rarity].limit + ' 张') : '') + '"></div>' : '';
    el.dataset.cname = c.name || '';
    // ★ 记下卡 id：联机收到卡图后要按它把**已经在屏幕上的这张牌**换图（见 flushArtDirty）。
    //   卡牌库/构筑页是一次性渲染的，图是之后才到的；没有 id 就只能在"图路径对得上"时
    //   认出元素 —— 而对方自制卡本地压根没路径（画的是占位卡面），永远认不出。
    el.dataset.cid = c.id || '';
    // ★★ 图片**加载失败**（路径有值但图没了/404）也要退化成占位卡面 ——
    //   以前只处理了"路径为空"，于是"配过图但图丢了"的卡会显示成**一块黑**（用户反馈）。
    const imgTag = art
      ? '<img src="' + art + '" alt="" loading="lazy" onerror="' +
        "var p=this.parentNode;p.classList.add('no-art');this.remove();" +
        // ★ 图挂了就退回占位卡面：**顺手清掉异画对位的内联样式**，
        //   否则叠加的攻防块还按异画的位置摆着，而图上什么都没有（错位 + 看着像 bug）
        "p.classList.remove('alt-on');" +
        "var st=p.querySelectorAll('.card-stat');for(var i=0;i<st.length;i++){st[i].removeAttribute('style');st[i].className=st[i].className.replace(/ ?alt-(fs|nobg|font|cover)/g,'');}" +
        "if(!p.querySelector('.card-name')){var n=document.createElement('div');n.className='card-name';n.textContent=p.dataset.cname||'';p.appendChild(n);}" +
        '">'
      : '';
    el.innerHTML =
      imgTag +
      // ★ costCls / costTitle：给左上角数字加**附加类与悬停说明**（场上单位用它把角标
      //   变成"行动花费"）。⚠ 必须在这里写进 HTML 字符串 —— 复用节点时走的是
      //   `el.innerHTML = fresh.innerHTML`，渲染后再用 DOM 改子元素不可靠。
      (c.cost != null ? '<div class="card-cost' + (c.costCls ? ' ' + c.costCls : '') + '"' +
        (c.costTitle ? ' title="' + String(c.costTitle).replace(/"/g, '&quot;') + '"' : '') + '>' + c.cost + '</div>' : '') +
      rar +
      // ★ 卡名叠字**默认关闭**（制作者 2026-09-21 要求）：卡面图多半自带名字，
      //   UI 再叠一层白字就重复了。想显示的卡在编辑器里勾「显示卡名叠字」（showName: true）。
      //   ⚠ 但**没有卡图**的卡例外：占位卡面必须显示卡名，否则认不出是哪张。
      (showName ? '<div class="card-name' + (c.rarity ? ' has-rarity' : '') + '">' + (c.name || '') + '</div>' : '') +
      // ★ 异画角标：**真实 DOM 元素**（2026-09-25 起取代 ::after 伪元素）——
      //   伪元素 pointer-events:none 且没法单独绑事件，手机上"点图标切换"就无从谈起。
      //   金色态由宿主 .alt-on class 驱动（CSS：.card.has-alt.alt-on .alt-badge），
      //   右键/长按切换路径里已有的 classList 增删不用改，角标颜色自动跟。
      (hasAltArt(c) ? '<div class="alt-badge">异</div>' : '') +
      (c.cardType === 'unit'
        // ★ 异画对位：用异画且配了对位时，把攻防块的内联位置/字号写进模板字符串
        //   （`.alt-fs` 走 CSS 里的 calc(12px * var(--fs))，普通卡与大卡面同时等比放大）
        ? (c.dualAttack
          // ★ 巡航舰：卡面**两个攻击值**都要显示（对太空 / 其他），和引擎 attackPowerAgainst 同一口径
          ? '<div class="card-stat atk dual' + statAttrs(c, 'atk').cls + '"' + statAttrs(c, 'atk').style +
            ' title="巡航舰：对太空 ' + c.dualAttack.value + ' 点 / 其他 ' + c.dualAttack.normal + ' 点">' +
            '<b>' + (c.dualAttack.value == null ? '?' : c.dualAttack.value) + '</b>' +
            '<i>' + (c.dualAttack.normal == null ? '?' : c.dualAttack.normal) + '</i></div>'
          : '<div class="card-stat atk' + statAttrs(c, 'atk').cls + '"' + statAttrs(c, 'atk').style + '>' +
            (c.attack == null ? '?' : c.attack) + '</div>') +
        '<div class="card-stat def' + statAttrs(c, 'def').cls + '"' + statAttrs(c, 'def').style + '>' +
        (c.defense == null ? '?' : c.defense) + '</div>'
        : '') +
      '<div class="card-badges">' +
      (c.cardType === 'counter' ? '<span class="badge counter">反制</span>' : '') +
      Object.keys(c.kwMap || {}).map(k =>
        '<span class="badge kw">' + (KG.KEYWORDS[k] ? KG.KEYWORDS[k].cn : k) + '</span>').join('') + '</div>';
    if (opts.uid) el.dataset.uid = opts.uid;
    if (opts.inst != null) el.dataset.inst = opts.inst;
    // ★ 右键：异画切换 / 删除卡牌（2026-09-24 起内置卡也可删，不再局限于自定义卡）。
    //   手感规则：
    //     · 内置卡 + 有异画 → 右键**直接切换**（老手感），Shift+右键 = 强制弹菜单（对位…够得着）
    //     · 自定义卡 / 无异画的内置卡 → 右键直接弹菜单（菜单里必有"删除"项）
    //     · 令牌卡是效果产物：不提供删除（是自定义卡则仍可删）
    const removable = !isCustomCard(c);
    if (hasAltArt(c) || isCustomCard(c) || removable) {
      if (hasAltArt(c)) {
        el.classList.add('has-alt');
        if (useAltArt(c)) el.classList.add('alt-on');
      }
      el.addEventListener('contextmenu', function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        const direct = hasAltArt(c) && !isCustomCard(c);   // 内置卡老手感：右键=直接切换
        if (direct && !(ev && ev.shiftKey)) {
          toggleAltArt(c);
          const img = el.querySelector('img');
          if (img && img.setAttribute) img.setAttribute('src', cardArt(c));
          if (el.classList) {
            if (useAltArt(c)) el.classList.add('alt-on'); else el.classList.remove('alt-on');
          }
          // ★ 叠加的攻防块必须跟图上画的块同步 —— **两个方向都要**：
          //   切到异画要挪过去，**切回原图要把内联样式清干净**（不然一直停在异画位置）。
          //   ⚠ 这条"直接切换"路径和 showCardMenu 的菜单项是**两条独立的代码**，
          //     以前只在菜单项里调了 applyAltGeometry → 内置卡切了图但 UI 不动
          //     （制作者 2026-09-23 报的）。写测试/探针要真派发 contextmenu，别直接调内部函数。
          refreshAltViews(c);                   // 同一张卡的**所有**可见副本一起刷
          toast(useAltArt(c) ? '已切到异画（攻防块已按异画对位）· 长按卡牌可调对位'
            : '已切回原图', useAltArt(c) ? 4000 : 1500);
          return;
        }
        showCardMenu(ev, c, el);
      });
      // ★ 手机端：没有鼠标右键 → **长按 500ms** 等价于右键（弹菜单 / 切异画）。
      //   长按期间移动超过 10px 视为拖拽，直接取消（拖牌部署不能被长按菜单打断）。
      if (isMobileUI()) bindLongPress(el, function (evLike) {
        if (drag && drag.moved) return;
        if (S.pending || el.getAttribute('data-tap-default') === '1') return;
        if (el.closest('#myHand, .line-units')) { cancelDrag(); return; }
        const direct = hasAltArt(c) && !isCustomCard(c);
        if (direct) {
          toggleAltArt(c);
          const img2 = el.querySelector('img');
          if (img2 && img2.setAttribute) img2.setAttribute('src', cardArt(c));
          if (el.classList) {
            if (useAltArt(c)) el.classList.add('alt-on'); else el.classList.remove('alt-on');
          }
          refreshAltViews(c);
          toast(useAltArt(c) ? '已切到异画 · 长按可再切回' : '已切回原图', 1800);
          return;
        }
        showCardMenu(evLike, c, el);
      });
    }
    // ★ 手机端：**直接点「异」角标切换异画**（Alan 2026-09-25："直接点那个异画图标切换不就行了？"）。
    //   委托绑在宿主 el 上 —— 场上单位复用节点只换 innerHTML 不换监听，角标是 innerHTML
    //   的一部分，委托照样命中；切换逻辑照抄右键"直接切换"分支（两条独立代码，别合并着改）。
    //   ⚠ 必须绑在 bindTipTap **之前**：stopImmediatePropagation 才拦得住"点一下弹详情"，
    //     且同一元素的 listener 按注册顺序执行。
    // ★ 手机端没有"悬浮"这回事 —— 卡牌详情只能靠**点一下展开**。
    //   桌面保留悬停预览；对战中的普通点击只查看详情。
    //   ⚠ 这里**不绑 mouseenter/mouseleave**：触摸设备上浏览器会在 tap 之后补发一次
    //     mouseenter，会跟 tap 切换打架，表现为"点一下详情闪一下就没了"。
    bindTipTap(el, c);
    return el;
  }

  /* 手机端：点卡 → 展开/收起详情。再点同一张卡 = 收起。
     ⚠ showTip 要读 e.currentTarget 求坐标 —— 这里造一个最小的事件壳复用，
       不去改它的签名（桌面端还在按原样调它）。 */
  function bindTipTap(el, c) {
    if (!isMobileUI()) {
      el.addEventListener('mouseenter', e => showTip(e, c));
      el.addEventListener('mouseleave', hideTip);
    }
    el.addEventListener('click', function (ev) {
      if (!isMobileUI() && !(el.closest && el.closest('#myHand, #mySupport, #foeSupport, #frontline'))) return;
      if (swallowClick || (drag && drag.moved)) return;
      // ★ 这张牌的"点击"已经被别的用途占用了（换牌点选 / 提示里选牌 / 取消挂起）
      //   → 让位给它，不弹详情，否则一次点击会同时干两件事。
      if (el.getAttribute && el.getAttribute('data-tap-default') === '1') return;
      if (S.pending || (isMobileUI() && acting)) return;
      if (S.pending || (isMobileUI() && acting)) return;
      const t = $('#tooltip');
      if (!t) return;
      if (S._tipAnchor === el && !t.classList.contains('hidden')) { hideTip(); return; }
      S._tipAnchor = el;
      showTip({ currentTarget: el, clientX: (ev && ev.clientX) || 0, clientY: (ev && ev.clientY) || 0 }, c);
    });
  }

  /* 手机端：长按 = 右键（弹出卡牌菜单 / 切换异画）。
     长按 500ms 触发；期间指针移动超过 10px、或提前抬起 → 取消。
     ⚠ 用 pointer 事件而不是 touch 事件：本项目所有拖拽都走 pointer，
       混用两套会让"拖到一半被判成长按"。
     ⚠ 触发后要吞掉随之而来的 click（否则会又当成"点牌"打开详情）。 */
  function bindLongPress(el, onLong) {
    if (!el.addEventListener) return;
    let timer = null, sx = 0, sy = 0, fired = false;
    const cancel = function () {
      if (timer) { clearTimeout(timer); timer = null; }
    };
    el.addEventListener('pointerdown', function (ev) {
      if (ev && ev.pointerType === 'mouse') return;    // 有鼠标就用右键，别把长按也挂上
      if (ev.target.closest && ev.target.closest('button, input, select')) return;
      sx = ev.clientX; sy = ev.clientY; fired = false;
      cancel();
      timer = setTimeout(function () {
        timer = null; fired = true;
        if (global.navigator && global.navigator.vibrate) { try { global.navigator.vibrate(18); } catch (e) { } }
        onLong({ clientX: sx, clientY: sy, preventDefault: function () { }, shiftKey: false });
      }, 500);
    });
    el.addEventListener('pointermove', function (ev) {
      if (!timer) return;
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 10) cancel();
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('click', function (ev) {
      if (!fired) return;
      fired = false;
      if (ev && ev.stopPropagation) ev.stopPropagation();
      if (ev && ev.preventDefault) ev.preventDefault();
    }, true);
  }

  // ★ 放大卡面：给没有美术图的"纯文字卡"在 tooltip 顶部渲染一张**大号卡面**，
  //   让悬停看到的是一张卡，而不是一坨字。有美术图的卡保持"大图 + 详情"不变。
  function bigFace(c) {
    const el = cardEl(c);
    el.classList.add('mini-big');
    return el.outerHTML;    // tooltip 是一次性 innerHTML，不需要保留事件
  }

  function showTip(e, c) {
    const t = $('#tooltip');
    const art = cardArt(c);
    /* ★ 大图预览优先**原图**（2026-09-27）：卡面在牌桌上走的是 208px 缩略图（省 97% 流量），
     *   但 tooltip 是放大到 ~300px 的检视视图，还放缩略图就是一嘴马赛克。
     *   所以这里取"不走 thumbOf 的原始路径"；原图 404（比如便携版没带某个卡图包）时
     *   onerror 退回缩略图 —— 清晰度优先，糊也比白板强。 */
    const full = (function () {
      if (useAltArt(c)) { const a = altArtOf(c); if (a) return a; }
      if (S.images[c.id]) return S.images[c.id];
      if (c.art) return c.art;
      if (c.src) return '../' + c.src;
      return '';
    })();
    const shown = full || art;
    const imgTag = shown
      ? '<img src="' + shown + '" onerror="this.onerror=null;this.src=\'' + (art || shown) + '\'">'
      : '';
    const kws = Object.keys(c.kwMap || {}).map(k => {
      const K = KG.KEYWORDS[k];
      return K ? '<div class="t-kw">' + K.cn + '：' + K.desc + '</div>' : '';
    }).join('');
    // ★ 文字部分包一层 .t-body：手机上 tooltip 走**横向布局**（左图右文），
    //   没有这层包裹的话所有 <div> 会变成 flex 兄弟横着排开。桌面端多一层 div 无副作用。
    t.innerHTML = (shown ? imgTag : bigFace(c)) +
      '<div class="t-body">' +
      '<div class="t-name">' + (c.name || '') + '　' + (c.cost != null ? c.cost + ' 指挥点' : '') + '</div>' +
      (c.rarity && KG.RARITY_INFO[c.rarity]
        ? '<div style="color:#cbbf9a">稀有度：' + KG.RARITY_INFO[c.rarity].cn +
          (KG.RARITY_INFO[c.rarity].limit > 0 ? '（同名最多 ' + KG.RARITY_INFO[c.rarity].limit + ' 张）' : '（不可放入卡组，只能由其他卡牌产生）') + '</div>'
        : '') +
      (c.cardType === 'unit' ? '<div>' + (c.attack == null ? '?' : c.attack) + ' / ' + (c.defense == null ? '?' : c.defense) +
        (c.opCost ? '　行动花费 ' + c.opCost : '') + '</div>' : '<div>' + (KG.cardTypeCn ? KG.cardTypeCn(c.cardType) : '指令') + '</div>') +
      (c.dualAttack ? '<div style="color:#ffd9a0">巡航舰双攻击值：对太空 ' + c.dualAttack.value +
        ' 点 / 其他 ' + c.dualAttack.normal + ' 点</div>' : '') +
      kws +
      (c.text ? '<div style="margin-top:6px;color:#c9c9c9">' + c.text.replace(/\n/g, '<br>') + '</div>' : '') +
      (c.unimplemented ? '<div style="margin-top:6px;color:#ffb27a">≈ 部分效果为近似实现（引擎缺原语）</div>' : '') +
      (c.notes ? '<div style="margin-top:4px;color:#6f7684;font-size:11px">' + c.notes.slice(0, 160) + '</div>' : '') +
      '</div>' +
      '<button class="t-close only-mobile" type="button" aria-label="关闭">✕</button>';
    t.classList.remove('hidden');
    if (isMobileUI()) {
      const cb = t.querySelector('.t-close');
      if (cb && cb.addEventListener) cb.addEventListener('click', function () { hideTip(); });
      document.body.classList.add('mobile-inspecting');
      document.body.classList.remove('tip-expanded');
      t.setAttribute('role', 'dialog'); t.setAttribute('aria-label', '卡牌详情');
      const actions = document.createElement('div'); actions.className = 't-actions';
      const expand = document.createElement('button'); expand.type = 'button'; expand.className = 'ghost t-expand'; expand.textContent = '放大';
      expand.addEventListener('click', function () {
        const on = document.body.classList.toggle('tip-expanded'); expand.textContent = on ? '收起' : '放大';
      });
      actions.appendChild(expand);
      t.appendChild(actions);
      if (S.fitBoardScale) requestAnimationFrame(function () { S.fitBoardScale(true); });
    }
    const r = e.currentTarget.getBoundingClientRect();
    // ★ 必须按**渲染后的真实尺寸**夹取（bug2：手牌详情越界）。
    //   旧写法把 250/260 这两个数字写死在夹取公式里，而带放大卡面的 tooltip
    //   实高可达 400+；手牌本来就在屏幕底部 → 下缘直接溢出到视口外。
    const m = 8, gap = 10;
    const vw = window.innerWidth || 1400, vh = window.innerHeight || 900;
    // ★ 手机端：详情是**贴底的横条**，位置完全由 CSS 定（left/right/bottom 都是 !important），
    //   这里再写内联 left/top 只会打架 —— 直接跳过坐标计算。
    if (isMobileUI()) return;
    const tw = t.offsetWidth || 230, th = t.offsetHeight || 200;
    let left = r.right + gap;
    if (left + tw > vw - m) {                    // 右边放不下 → 翻到卡左侧
      const leftSide = r.left - tw - gap;
      left = leftSide >= m ? leftSide : vw - tw - m;
    }
    left = Math.max(m, Math.min(left, Math.max(m, vw - tw - m)));
    // 竖向：优先与卡顶对齐；下方放不下就整体上移；比视口还高就只能贴顶（宁可下缘被裁）
    const top = th >= vh - 2 * m ? m : Math.max(m, Math.min(r.top, vh - th - m));
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }
  function hideTip() {
    const t = $('#tooltip');
    if (t && t.classList) t.classList.add('hidden');
    S._tipAnchor = null;
    if (document.body) document.body.classList.remove('mobile-inspecting', 'tip-expanded');
    if (isMobileUI() && S.fitBoardScale) requestAnimationFrame(function () { S.fitBoardScale(true); });
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }

  /* ★ 页面内输入框（2026-09-29）：Electron 的 Chromium 里 prompt() 是**废的**。
   *   ⚠ 坑在于 `typeof prompt === 'function'` 返回 **true** —— 它是个函数，
   *     只是**一调用就抛** `Uncaught Error: prompt() is not supported`。
   *     所以老代码那种"存在才调"的守卫完全骗人，点了就白屏级报错（实测 ui.js:5396）。
   *   → 自造模态输入框顶上：askText(opt) → Promise<string|null>；
   *     Esc / 取消 / 点遮罩 / 点✕ = null（= 用户放弃，等价 prompt 返回 null）。
   *   ⚠ 浮层挂 **document.body**（不是 #screen-battle）：后者有 isolation:isolate，
   *     挂进去 z-index 出不来会被盖住（这坑已发作过两次，见 style.css 末尾）。 */
  function askText(opt) {
    opt = opt || {};
    const multiline = !!opt.multiline;
    return new Promise(function (resolve) {
      let done = false;
      const prevFocus = document.activeElement;

      const mask = document.createElement('div');
      mask.className = 'kg-ask-mask';
      const box = document.createElement('div');
      box.className = 'kg-ask';
      box.setAttribute('role', 'dialog');

      if (opt.title) {
        const h = document.createElement('div');
        h.className = 'kg-ask-title';
        h.textContent = opt.title;
        box.appendChild(h);
      }
      if (opt.label) {
        const l = document.createElement('div');
        l.className = 'kg-ask-label';
        l.textContent = opt.label;
        box.appendChild(l);
      }

      const field = document.createElement(multiline ? 'textarea' : 'input');
      field.className = 'kg-ask-field';
      if (!multiline) field.type = 'text';
      field.value = opt.value == null ? '' : String(opt.value);
      if (opt.placeholder) field.placeholder = opt.placeholder;
      if (opt.readonly) { field.readOnly = true; field.setAttribute('readonly', 'readonly'); }
      if (opt.maxlength) field.maxLength = opt.maxlength;
      box.appendChild(field);

      if (opt.hint) {
        const hp = document.createElement('div');
        hp.className = 'kg-ask-hint';
        hp.textContent = opt.hint;
        box.appendChild(hp);
      }

      const acts = document.createElement('div');
      acts.className = 'kg-ask-acts';
      const mk = function (text, cls, fn) {
        const b = document.createElement('button');
        b.className = cls; b.type = 'button'; b.textContent = text;
        b.addEventListener('click', fn);
        return b;
      };
      const cancelBtn = mk(opt.cancelText || '取消', 'ghost', function () { finish(null); });
      const okBtn = mk(opt.okText || '确定', 'primary', function () { finish(field.value); });
      acts.appendChild(cancelBtn);
      acts.appendChild(okBtn);
      box.appendChild(acts);

      mask.appendChild(box);
      document.body.appendChild(mask);

      function finish(v) {
        if (done) return;
        done = true;
        try { document.removeEventListener('keydown', onKey, true); } catch (e) {}
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) {}
        resolve(v);
      }
      function onKey(e) {
        if (e && (e.key === 'Escape' || e.keyCode === 27)) { e.preventDefault(); finish(null); return; }
        if (e && (e.key === 'Enter' || e.keyCode === 13)) {
          // 多行框里 Enter 是换行，只有 Ctrl/Cmd+Enter 才提交
          if (!multiline || e.ctrlKey || e.metaKey) { e.preventDefault(); finish(field.value); }
        }
      }
      document.addEventListener('keydown', onKey, true);
      mask.addEventListener('mousedown', function (e) { if (e && e.target === mask) finish(null); });

      try {
        field.focus();
        if (opt.readonly) { field.select(); }
        else if (field.setSelectionRange) field.setSelectionRange(0, field.value.length);
      } catch (e) {}
    });
  }

  /* 剪贴板彻底不可用时（Electron 里 execCommand 也可能失败）的最后兜底：
   * 弹个只读框把代码摆出来让用户手动复制，别再调 prompt()。 */
  function copyFallbackBox(text, okMsg) {
    askText({
      title: '复制卡组代码',
      label: '自动复制没成功，请手动全选下面这段发给对方：',
      value: text, multiline: true, readonly: true,
      okText: '重试复制', cancelText: '关闭',
    }).then(function (v) { if (v != null) copyText(text, okMsg); })
      .catch(function () { toast(okMsg, 7000); });
  }

  /* ★ 页面内确认框（2026-10-02）→ Promise<boolean>。
   *   为什么不用原生 confirm()：Electron 的 prompt() 已经栽过一次（typeof 是 function，
   *   一调用就抛）。confirm() 同属宿主注入的原生弹窗，Electron/部分 WebView 上表现
   *   不一（有的直接返回 false、有的压根不弹），**失败形态都是"静默 return false"** ——
   *   用户看到的就是"点了没反应"。删除内置卡这种破坏性操作绝不能建立在这种地基上。
   *   Esc / 取消 / 点遮罩 / 点✕ = false；确定 = true。 */
  function askConfirm(msg, opt) {
    opt = opt || {};
    return new Promise(function (resolve) {
      let done = false;
      const prevFocus = document.activeElement;
      const mask = document.createElement('div');
      mask.className = 'kg-ask-mask';
      const box = document.createElement('div');
      box.className = 'kg-ask';
      box.setAttribute('role', 'dialog');

      const h = document.createElement('div');
      h.className = 'kg-ask-title';
      h.textContent = opt.title || '确认';
      box.appendChild(h);

      const body = document.createElement('div');
      body.className = 'kg-ask-body';
      // 保留换行（确认文案里带 \n\n 分段），CSS 侧 white-space:pre-wrap
      body.textContent = msg == null ? '' : String(msg);
      box.appendChild(body);

      const acts = document.createElement('div');
      acts.className = 'kg-ask-acts';
      const mk = function (text, cls, val) {
        const b = document.createElement('button');
        b.className = cls; b.type = 'button'; b.textContent = text;
        b.addEventListener('click', function () { finish(val); });
        return b;
      };
      acts.appendChild(mk(opt.cancelText || '取消', 'ghost', false));
      acts.appendChild(mk(opt.okText || '确定', opt.danger ? 'danger' : 'primary', true));
      box.appendChild(acts);

      mask.appendChild(box);
      document.body.appendChild(mask);

      function finish(v) {
        if (done) return;
        done = true;
        try { document.removeEventListener('keydown', onKey, true); } catch (e) { }
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) { }
        resolve(v);
      }
      function onKey(e) {
        if (e && (e.key === 'Escape' || e.keyCode === 27)) { e.preventDefault(); finish(false); }
        else if (e && (e.key === 'Enter' || e.keyCode === 13)) { e.preventDefault(); finish(true); }
      }
      document.addEventListener('keydown', onKey, true);
      mask.addEventListener('mousedown', function (e) { if (e && e.target === mask) finish(false); });
      // 危险操作默认聚焦「取消」，避免回车顺手删掉
      setTimeout(function () {
        const cancelBtn = acts.children[0], okBtn = acts.children[1];
        try { (opt.danger ? cancelBtn : okBtn || cancelBtn).focus(); } catch (e) { }
      }, 0);
    });
  }


  /* ================================================================ 联机对战 */
  /* 两边各跑一份确定性引擎，只同步「动作 + 每一步 chooser 的答案」。
   * 数据对等：先交换卡池指纹 → 一方独有的卡把「定义 + 效果 DSL」取过来本地实现
   * （连同它引用的卡），同名不同内容按房主版本统一；做完再校验总指纹。 */
  const MP = {
    on: false, inited: false,
    myName: '', peerName: '',
    myDeckCards: null, peerDeckCards: null,
    myDeckName: '', peerDeckName: '',
    myRestrict: true, peerRestrict: true, myRuleOk: true, peerRuleOk: true, myRuleError: null,
    myPicks: null, peerPicks: null,
    status: 'idle', info: {},
    syncArt: true,
    logs: [],            // 联机日志（最近 200 条）：排查"反复拉不齐/不同步"不用开控制台
    unreadErr: 0,        // 未读错误数（侧边栏把手上的徽标）
  };

  // 联机时在回合标签上标出"这是联机局、对手是谁"，免得误以为是电脑
  function mpTurnSuffix(st, H) {
    if (!MP.on) return '';
    return (st.active === H ? ' · 你' : (' · ' + (MP.peerName || '对方'))) + '（联机）';
  }

  /* 模式分开：单机（对 AI）/ 联机（局域网）。
   * 两套面板互斥显示；切到联机后本地不再跑 AI；切回单机时断开联机并重开一局。 */
  function mpSetMode(mode) {
    mode = (mode === 'lan') ? 'lan' : 'ai';
    const changed = S.mode !== mode;
    S.mode = mode;
    const aiPanel = $('#aiPanel'), mpPanel = $('#mpPanel');
    if (aiPanel) aiPanel.classList.toggle('hidden', mode !== 'ai');
    if (mpPanel) mpPanel.classList.toggle('hidden', mode !== 'lan');
    const aiBtn = $('#modeAiBtn'), lanBtn = $('#modeLanBtn');
    if (aiBtn) aiBtn.classList.toggle('active', mode === 'ai');
    if (lanBtn) lanBtn.classList.toggle('active', mode === 'lan');
    // 战报只在单机显示（联机时它是信息泄露口）
    const logDrawer = $('#logDrawer');
    if (logDrawer) logDrawer.classList.add('hidden');
    // 「重开」是单机语义；联机要重开得断开重来
    const restart = $('#restartBtn');
    if (restart) restart.classList.toggle('hidden', mode === 'lan');
    if (mode === 'lan') {
      mpLog(MP.on ? '联机对局进行中' : '建房或加入房间后开始对局（此模式下不会跑 AI）');
    } else if (changed) {
      if (MP.on || (mpNet() && mpNet().isOpen())) mpDisconnect(true);
      startGame();
      mpLog('');
    }
    renderLog();
    if (changed) renderBattle();
    // 联机但还没进房间：回合标签直说"未连接"，免得对着一盘旧棋盘发懵
    if (mode === 'lan' && !MP.on) {
      const tl = $('#turnLabel');
      if (tl) tl.textContent = '联机模式 · 未连接';
    }
  }

  function mpDisconnect(silent) {
    const Net = mpNet();
    if (Net) {
      if (Net.isOpen()) Net.relay({ t: 'bye' });
      Net.leave();
    }
    MP.on = false; S.mpActive = false;
    MP.myDeckCards = null; MP.peerDeckCards = null;
    MP.myPicks = null; MP.peerPicks = null;
    // ★ 对端给的卡只在本局有效 → 断开时清掉（本地自己做的卡不受影响）
    mpDropPeerCards();
    mpSetStatus('idle', {});
    ['#mpHostBtn', '#mpJoinBtn'].forEach(function (sel) { const b = $(sel); if (b) b.disabled = false; });
    if (!silent) mpLog('已断开联机，回到单机对战');
  }

  /* 把下拉框里当前选中的卡组告诉对方。
   * ★ 这个函数的存在本身就是一个修复：以前**只有手动改下拉框**才会发送卡组，
   *   而下拉框是预选好的（默认就是你上次编辑的那副），没人会去动它 ——
   *   于是两边都收不到对方的卡组，「开始对局」永远是灰的（双方互相等，死锁）。 */
  function mpAnnounceDeck() {
    const d = mpPickDeck();
    if (!d) return null;
    const Net = mpNet();
    if (Net) Net.relay({ t: 'deck', id: d.id, name: d.name, cards: d.cards,
      restrict: d.restrict, major: d.major, ally: d.ally, ruleOk: d.ruleOk });
    mpLog('已选卡组「' + d.name + '」（' + d.cards.length + ' 张）' +
      (MP.peerDeckCards ? '' : '，等对方也选好'));
    return d;
  }

  // 开局还差什么？直接写在面板上 —— 按钮灰着却不给原因，只能瞎猜
  function mpStartHint() {
    const Net = mpNet();
    if (!MP.on) return '先建房或加入房间';
    if (MP.status === 'playing') return '对局进行中';
    if (MP.status !== 'ready') return '正在同步双方的卡池，完成前不能开局';
    if (!MP.myDeckCards) return '你还没选卡组 —— 在上面下拉框里选一副';
    if (!MP.peerDeckCards) return '都卡在等对方选卡组 —— 让对方在下拉框里选一副';
    if ((MP.myRestrict !== false) !== (MP.peerRestrict !== false)) {
      return '主国/盟国限制开关必须一致：你' + (MP.myRestrict !== false ? '开' : '关') + '、对方' + (MP.peerRestrict !== false ? '开' : '关');
    }
    if (MP.myRestrict !== false && MP.myRuleOk === false) return '你的卡组不符合主国/盟国限制：' + (MP.myRuleError || '请检查');
    if (MP.peerRestrict !== false && MP.peerRuleOk === false) return '对方的卡组不符合主国/盟国限制，让他改一下';
    if (!(Net && Net.state.role === 'host')) return '两边都准备好了 —— 由房主点「开始对局」';
    return '两边都准备好了 —— 点「开始对局」';
  }

  function mpRenderStartHint() {
    const el = $('#mpStartHint');
    if (el) el.textContent = mpStartHint();
  }

  // 联机模式下还没进房间 → 不许操作（否则会在本地跑起一盘"单机"）
  function lanBlocked() {
    if (S.mode !== 'lan' || MP.on) return false;
    toast('联机对战：先建房或加入房间', 2000);
    return true;
  }

  function mpLog(msg) {
    if (global.console) console.log('[联机] ' + msg);
    mpPushLog(msg, /⚠|不同步|出错|失败|反复拉不齐/.test(msg) ? 'err' : '');
    const el = $('#mpHint');
    if (el) el.textContent = msg;
  }

  /* 联机日志缓冲 + 折叠侧边栏（2026-09-25）：报错不该只活 6 秒的 toast 里，
   * 控制台在手机上又开不了 —— 全部收进 #mpLogDrawer，出问题点开就能看全程。 */
  function mpPushLog(msg, kind) {
    MP.logs.push({ t: Date.now(), msg: msg, kind: kind || '' });
    if (MP.logs.length > 200) MP.logs.shift();
    if (kind === 'err' && !mpLogOpen()) MP.unreadErr++;
    mpRenderLogBadge();
  }
  function mpLogOpen() {
    const d = $('#mpLogDrawer');
    return !!(d && !d.classList.contains('hidden'));
  }
  function mpRenderLogBadge() {
    const b = $('#mpLogToggle');
    if (!b) return;
    const n = MP.unreadErr;
    b.textContent = n > 0 ? ('联机日志 ⚠' + n) : '联机日志';
    b.classList.toggle('mp-log-alert', n > 0);
  }
  function mpRenderLog() {
    const box = $('#mpLogList');
    if (!box) return;
    box.innerHTML = '';
    MP.logs.forEach(function (l) {
      const div = document.createElement('div');
      div.className = 'mp-log-line' + (l.kind === 'err' ? ' err' : '');
      const t = new Date(l.t).toTimeString().slice(0, 8);
      div.textContent = t + '  ' + l.msg;
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;          // 最新在底部
    MP.unreadErr = 0;
    mpRenderLogBadge();
  }
  function mpLogCopy() {
    // 优先导出网络层的全量日志（带明细 detail），没有网络层时退回面板缓冲
    let text = '';
    try {
      const Net2 = mpNet();
      if (Net2 && Net2.dumpLog && Net2.state.logs && Net2.state.logs.length) text = Net2.dumpLog();
    } catch (e) { /* 忽略 */ }
    if (!text) text = MP.logs.map(function (l) {
      return new Date(l.t).toTimeString().slice(0, 8) + '  ' + l.msg;
    }).join('\n');
    const done = function () { toast('已复制联机日志（' + MP.logs.length + ' 条）', 2000); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { mpLogCopyFallback(text, done); });
        return;
      }
    } catch (e) { /* 走 fallback */ }
    mpLogCopyFallback(text, done);
  }
  function mpLogCopyFallback(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) { toast('复制失败：请手动选中日志文本复制'); }
  }

  function mpNet() { return global.KGNet; }

  /* ------------------------------------------------------------------
   * 房主"该把哪个地址发给对方"（2026-09-27：UU 加速器 / 虚拟局域网）
   * 服务器多半是后台起的，控制台那几行打印根本没人看 —— 房主得在面板里直接看到。
   * 数据来自服务器 /kg-net（浏览器自己拿不到网卡列表）；拿不到（跨源/旧服务器）就静默不显示。
   * ★ UU 云联机给的是虚拟 IP，跨网必须发它，发物理局域网 IP 对方一定连不上 —— 所以
   *   UU / TAP 这两类标金色并排在前面，别让用户发错。 */
  function mpCopyText(text, done) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { mpLogCopyFallback(text, done); });
        return;
      }
    } catch (e) { /* 走 fallback */ }
    mpLogCopyFallback(text, done);
  }

  function mpShowAddresses() {
    const box = $('#mpAddrList');
    const Net2 = mpNet();
    if (!box || !Net2 || !Net2.fetchNetInfo) return;
    Net2.fetchNetInfo().then(function (info) {
      if (!info || !info.addresses || !info.addresses.length) { box.classList.add('hidden'); return; }
      box.innerHTML = '';
      const rec = info.recommended;
      const head = document.createElement('div');
      head.className = 'mp-addr-head';
      head.textContent = rec
        ? ('把 ' + rec.address + ':' + info.port + ' 发给对方（' + (rec.label || rec.kind) + '）')
        : '本机地址（挑一条发给对方）';
      box.appendChild(head);
      info.addresses.forEach(function (a) {
        if (a.kind === 'apipa' || a.kind === 'vm') return;      // 这两类对方连不上，不占版面
        const virt = (a.kind === 'uu' || a.kind === 'tap');
        const row = document.createElement('div');
        row.className = 'mp-addr';
        const u = document.createElement('span');
        u.className = 'u';
        u.textContent = a.address + ':' + info.port;
        const k = document.createElement('span');
        k.className = virt ? 'k' : 'nm';
        k.textContent = virt ? ('★ ' + (a.label || a.kind)) : (a.name || a.kind);
        const b1 = document.createElement('button');
        b1.className = 'ghost small';
        b1.textContent = '复制链接';
        b1.addEventListener('click', function () {
          mpCopyText(a.url, function () { toast('已复制：' + a.url, 1800); });
        });
        const b2 = document.createElement('button');
        b2.className = 'ghost small';
        b2.textContent = '复制 relay';
        b2.title = '对方如果在自己机器上打开游戏（不是从这个地址进的），用这条带 relay 参数的链接';
        b2.addEventListener('click', function () {
          mpCopyText(a.url + '?relay=' + a.relay, function () { toast('已复制带 relay 的直链', 1800); });
        });
        row.appendChild(u); row.appendChild(k); row.appendChild(b1); row.appendChild(b2);
        box.appendChild(row);
      });
      box.classList.remove('hidden');
      if (rec) mpLog('本机地址 ' + rec.address + ':' + info.port + '（' + (rec.label || rec.kind) + '）—— 这条 + 房间码发给对方');
    });
  }

  function mpSetStatus(st, info) {
    MP.status = st; MP.info = info || {};
    if (st === 'error' && info && info.error) mpPushLog('状态：出错 —— ' + info.error, 'err');
    const labels = {
      idle: '未连接', connecting: '连接中…',
      waiting: '等待对方加入 · 房间码 ' + (MP.info.code || ''),
      syncing: '正在同步数据…', ready: '已就绪',
      playing: '对局中', over: '对局结束', error: '出错',
    };
    const el = $('#mpStatus');
    // ★ 2026-09-25：error 文本可能带字段级差异 dump（几百字符的卡定义 JSON）——
    //   状态栏/toast 只显示前 120 字，全文在联机日志抽屉里（mpPushLog 已收）。
    const shortErr = info && info.error ? String(info.error).slice(0, 120) + (String(info.error).length > 120 ? '…（全文在联机日志）' : '') : '';
    if (el) {
      el.textContent = (labels[st] || st) + (shortErr && st !== 'waiting' ? ('：' + shortErr) : '');
      el.className = 'mp-status ' + st;
    }
    const isHost = mpNet() && mpNet().state.role === 'host';
    // ★ 一进入就绪就自动把"已选中的卡组"发过去（不用手动去动下拉框）
    if (st === 'ready' && !MP.myDeckCards) mpAnnounceDeck();
    const startBtn = $('#mpStartBtn');
    if (startBtn) {
      startBtn.disabled = !(isHost && st === 'ready' && MP.myDeckCards && MP.peerDeckCards);
      startBtn.textContent = isHost ? '开始对局（房主）' : '等房主开始';
    }
    mpRenderStartHint();
    const leaveBtn = $('#mpLeaveBtn');
    if (leaveBtn) leaveBtn.disabled = (st === 'idle' || st === 'connecting');
    const deckSel = $('#mpDeck');
    if (deckSel) deckSel.disabled = (st === 'playing' || st === 'over');
    if (st === 'playing' || st === 'over' || st === 'error') {
      ['#mpHostBtn', '#mpJoinBtn'].forEach(function (sel) { const b = $(sel); if (b) b.disabled = true; });
    }
    if (shortErr) toast('联机：' + shortErr, 6000);
  }

  function mpProgress(p) {
    const box = $('#mpProgress'), bar = $('#mpProgressBar');
    if (!box || !bar) return;
    const total = p.total || 0, done = p.done || 0;
    if (!total) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    bar.style.width = Math.round(done / total * 100) + '%';
    bar.textContent = (p.note || '同步中') + ' ' + done + '/' + total;
  }

  /* 把对方独有的卡在本地"原样实现"：定义（数值/词条/兵种）+ 效果 DSL 一起落进卡池。
   * 独有卡按用户在编辑器里手工改一张卡的方式落盘（S.custom / S.edits + rebuildPool）；
   * 冲突卡（以房主为准）与"本地删过、对方还有"的卡走内存覆盖层 S.peerOverrides，
   * 只在本局有效、断开联机即还原 —— 对引擎来说它们和本地 DIY 卡没有任何区别。 */
  function mpApplyCards(cards, opts) {
    // ★ fromPeer = 这些卡是**对端**通过联机拉来的（不是我本地 DIY 的）。
    //   它们**不能落盘**：客机自制的卡不该被塞进主机的本地卡池 ——
    //   联机结束就该消失（否则对方每联一次，我本地就多一堆别人做的卡，还清不掉）。
    //
    // ★ 对齐总规则（2026-09-25 Alan 定版，两条）：
    //   ① 主机没有、客机有的卡 → 主机从客机拉取（协议侧：host 的 ask=missing → need → 对方打包发来）；
    //   ② 一旦出现任何冲突（同 id 不同内容，且**这张卡我池里已经有**）→ **一律按照主机来**：
    //      客机把主机版本塞进内存覆盖层 S.peerOverrides（rebuildPool 末尾整卡替换，
    //      不落盘、断开联机还原）；主机永远保留自己的版本，绝不被对方反向覆盖。
    //      ①与②的分界是"我池里有没有这张卡"，**不是**"我认不认识这个 id"：
    //      本地把内置卡删注（S.removed）后 id 还在 S.base 里，但它属于"我缺的卡"。
    //      （旧版只看 S.base → 主机永远拉不到这张卡： ask 永远非空、digest 永远对不上
    //        → 12 轮后报"卡池反复拉不齐"（实测 2026-09-25）。）
    const fromPeer = !!(opts && opts.fromPeer);
    let added = 0, updated = 0, unknown = 0, forced = 0, keptLocal = 0;
    const forcedIds = [];
    const netState = mpNet() && mpNet().state;
    const iAmGuest = !!(netState && netState.role === 'guest');
    // ★ 当前**在池里**的 id。判断"对方这张卡我到底有没有"不能只看 S.base / S.custom：
    //   本地把内置卡删掉后（S.removed）它仍在 S.base 里、池里却没有 —— 那必须算"我缺的卡"。
    const inPoolIds = {};
    (S.pool || []).forEach(function (x) { if (x && x.id) inPoolIds[x.id] = true; });
    (cards || []).forEach(function (c) {
      if (!c || !c.id) { unknown++; return; }
      const clean = Object.assign({}, c);
      delete clean.art; delete clean.src;         // 美术图走卡图同步，不塞进卡定义
      if (fromPeer) clean._fromPeer = true;       // 标记来源，联机结束时按它清理
      const label = clean.id + (clean.name ? ('「' + clean.name + '」') : '');
      const ci = S.custom.findIndex(function (x) { return x.id === clean.id; });
      if (ci >= 0) {
        if (!S.custom[ci]._fromPeer) {
          // 本地自制卡与对方版本同 id 不同内容 = 冲突 → 一律按主机来：
          // 客机换主机版（覆盖层），主机保留自己的。
          if (fromPeer && iAmGuest) {
            S.peerOverrides = S.peerOverrides || {};
            S.peerOverrides[clean.id] = clean;
            forced++; forcedIds.push(label);
            return;
          }
          keptLocal++; return;                    // 主机：保留本地版
        }
        S.custom[ci] = Object.assign({}, S.custom[ci], clean); updated++; return;
      }
      if ((S.base || []).some(function (x) { return x.id === clean.id; })) {
        // ★ 只有"池里已经有这张内置卡"才算真冲突（一律按主机来，主机保留自己的版本）。
        //   池里没有 = 本地把它删了（S.removed）或本地版本里就没有 → 对方有、我没有，
        //   这就是"我缺的卡"，必须本局临时补上（内存覆盖层，断开联机即还原）。
        //   否则对方永远有、我永远缺 → 指纹永远对不上 → 反复拉不齐。
        if (fromPeer && (iAmGuest || !inPoolIds[clean.id])) {
          S.peerOverrides = S.peerOverrides || {};
          S.peerOverrides[clean.id] = clean;
          forced++; forcedIds.push(label);
          return;
        }
        if (fromPeer) { keptLocal++; return; }    // 主机：保留自己的内置版
        S.edits[clean.id] = Object.assign({}, S.edits[clean.id] || {}, clean);
        updated++;
        return;
      }
      S.custom.push(clean);
      added++;
    });
    // ★ 只有**本地**的改动才落盘。对端给的一律只留在内存（本局有效）。
    if (!fromPeer) {
      LS.set('custom', S.custom);
      LS.set('edits', S.edits);
    }
    // ★ 卡定义到这里已经落盘（localStorage）。但**图**还得补 —— 开局那次"我缺哪些图"的计算
    //   在对局开始时就跑完了，中途拉来的卡错过了它 → 卡在本地、图永远缺，
    //   联机结束重启后看着就像"没保存在本地"。这里主动向对方补要。
    try {
      const Net2 = mpNet();
      if (Net2 && Net2.requestArt) {
        const missing = (cards || []).filter(function (c) { return c && c.id && !S.images[c.id]; })
          .map(function (c) { return c.id; });
        if (missing.length) {
          Net2.requestArt(missing);
          mpLog('顺带向对方补要 ' + missing.length + ' 张卡图');
        }
      }
    } catch (e) { /* 单机/未联机时忽略 */ }
    rebuildPool();
    mpRefreshDecks();                       // 卡池变了 → 可参战的卡组列表也刷一遍
    mpLog('已本地实现对方的卡：新增 ' + added + ' 张 · 强制对齐 ' + forced + ' 张 · 覆盖 ' + updated + ' 张' +
      (keptLocal ? (' · 保留本地 ' + keptLocal + ' 张（冲突一律按主机来）') : '') +
      (unknown ? (' · 跳过 ' + unknown + ' 张无效数据') : '') +
      (fromPeer ? '（对端的卡**只在本局有效**，不会保存到本地）' : ''));
    if (forcedIds.length) {
      mpLog('强制对齐（以对方版本为准，断开联机后还原）：' + forcedIds.slice(0, 6).join('、') +
        (forcedIds.length > 6 ? '…共 ' + forcedIds.length + ' 张' : ''));
    }
  }

  /* ★ 联机结束时清掉"对端给的卡"：它们只在本局有效（见 mpApplyCards 的 fromPeer）。
   *   本地自己 DIY 的卡一张不动。 */
  function mpDropPeerCards() {
    // ★ 先撤"强制对齐覆盖层"：被主机版本临时替换的本地卡（自制/内置修改）全部还原
    const ovIds = Object.keys(S.peerOverrides || {});
    if (ovIds.length) S.peerOverrides = {};
    // ★ 主机 DSL 强制层同批还原（联机推送的 S.hostFx 只在本局有效；
    //   刷新场景的 S.hostFx 下次 syncCardsFromHost 会重新拉，不受影响）
    const hadHostFx = !!S.hostFx;
    S.hostFx = null;
    const before = (S.custom || []).length;
    S.custom = (S.custom || []).filter(function (c) { return !c._fromPeer; });
    const removed = before - S.custom.length;
    // edits 里来自对端的覆盖也撤掉（按记录恢复本地原值：直接删键即可，rebuildPool 会用内置版）
    let editedBack = 0;
    Object.keys(S.altArtPeerEdits || {}).forEach(function (id) {
      if (S.edits && S.edits[id]) { delete S.edits[id]; editedBack++; }
    });
    S.altArtPeerEdits = {};
    if (removed || editedBack || ovIds.length || hadHostFx) {
      LS.set('custom', S.custom);
      LS.set('edits', S.edits);
      rebuildPool();
      mpLog('已清掉对端给的 ' + removed + ' 张卡' +
        (ovIds.length ? (' · 还原本地版本 ' + ovIds.length + ' 张') : '') +
        (hadHostFx ? ' · 已还原主机效果层' : '') +
        (editedBack ? ('（含 ' + editedBack + ' 处覆盖）') : '') +
        '—— 它们只在本局有效');
    }
  }

  function dataUrlToBlob(d) {
    if (typeof global.atob !== 'function') return null;
    const i = String(d).indexOf(',');
    if (i < 0) return null;
    const mime = (String(d).slice(0, i).match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = global.atob(String(d).slice(i + 1));
    const arr = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
    return new Blob([arr], { type: mime });
  }

  /* ★ 联机传卡图（2026-09-27 改成二进制）：
   *   旧路是 readAsDataURL → base64 字符串（+33% 体积）走 JSON，对方再解析。
   *   现在直接给**裸字节**，由 net.js 切成 48KB 分片并发发出去。
   *   注意：优先用本地文件（c.src / 缩略图）而不是 S.images 里的 blob URL ——
   *   blob URL 在不同源之间不可 fetch，而且原图比缩略图清晰（联机是想让对方看到真图）。 */
  async function mpGetArtRaw(id) {
    // 1) 原生 File/Blob（自定义卡图存在 IndexedDB 里）
    try {
      if (typeof idbGet === 'function') {
        const raw = await idbGet(id);
        if (raw && raw.size) return { bytes: new Uint8Array(await raw.arrayBuffer()), mime: raw.type || 'image/png' };
      }
    } catch (e) { /* 落到文件路径 */ }
    // 2) 本地文件路径（内置卡图 / 刚导入的自定义卡图）
    const c = (S.pool || []).filter(function (x) { return x && x.id === id; })[0]
           || (S.custom || []).filter(function (x) { return x && x.id === id; })[0];
    const cands = [];
    if (c) { if (c.src) cands.push('../' + c.src); if (c.art) cands.push(c.art); }
    cands.push(S.images[id]);
    for (let i = 0; i < cands.length; i++) {
      const u = cands[i];
      if (!u || typeof fetch !== 'function') continue;
      try {
        const r = await fetch(u);
        if (!r.ok) continue;
        const buf = await r.arrayBuffer();
        return { bytes: new Uint8Array(buf), mime: r.headers ? (r.headers.get('content-type') || 'image/png') : 'image/png' };
      } catch (e) { /* 试下一个 */ }
    }
    return null;
  }

  async function mpSetArt(id, payload) {
    try {
      const blob = (payload && payload.bytes)
        ? new Blob([payload.bytes], { type: payload.mime || 'image/png' })   // 二进制路（新）
        : dataUrlToBlob(payload);                                            // 兼容旧 dataURL
      if (!blob) return;
      await idbPut(id, blob);
      if (S.images[id]) { try { URL.revokeObjectURL(S.images[id]); } catch (e) { } }
      S.images[id] = URL.createObjectURL(blob);
      markArtDirty(id);
    } catch (e) { /* 落库失败不该中断整局联机 */ }
  }

  /* ★ 图到了要**刷到屏幕上**（2026-09-27，治"客机卡图加载不出来"的最后一环）
   *   卡图是异步到的，而客机的卡牌库 / 构筑页 / 手牌早在图到达**之前**就渲染完了 ——
   *   光把图写进 IndexedDB 和 S.images，屏幕上还是一片占位卡面。用户看到的就是
   *   "图加载不出来"，可图其实早就在本地了。所以每收到一张就把对应的牌换掉。
   *   一张张刷太贵（每次都要全表扫 .card），攒 120ms 批量刷一次：
   *   网络侧是 4 路并发，视觉上依然是一批一批地"图冒出来"。 */
  const artDirty = new Set();
  let artDirtyTimer = 0;
  function markArtDirty(id) {
    if (!id) return;
    artDirty.add(id);
    if (artDirtyTimer) return;
    artDirtyTimer = setTimeout(flushArtDirty, 120);
  }
  function flushArtDirty() {
    artDirtyTimer = 0;
    if (typeof document === 'undefined' || !document.querySelectorAll) { artDirty.clear(); return; }
    const ids = [];
    artDirty.forEach(function (id) { ids.push(id); });
    artDirty.clear();
    if (!ids.length) return;
    // 两种认法：① data-cid 对得上（连"现在还是占位卡面"的牌也能认出）
    //           ② <img> 现在的 src 是这张卡的旧图路径（含缩略图/异画两种形态）
    const byId = {}, bySrc = {};
    ids.forEach(function (id) {
      const c = uiCardById(id);
      if (!c) return;
      const w = cardArt(c);
      if (!w) return;
      byId[id] = { c: c, src: w };
      altArtViewKeys(c).forEach(function (k) { if (k && k !== w) bySrc[k] = { c: c, src: w }; });
    });
    if (!Object.keys(byId).length) return;
    const all = document.querySelectorAll('.card');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const img = el.querySelector('img');
      const cur = img ? String(img.getAttribute('src') || '').split('?')[0] : '';
      const hit = (el.dataset && byId[el.dataset.cid]) ? byId[el.dataset.cid] : (cur ? bySrc[cur] : null);
      if (!hit) continue;
      const c = hit.c, src = hit.src;
      if (img) {
        if (cur !== src) img.setAttribute('src', src);
      } else {
        // 之前是占位卡面（压根没有 <img>）→ 现在有图了，补一个进去，并撤掉占位态
        const im = document.createElement('img');
        im.setAttribute('src', src); im.setAttribute('alt', ''); im.setAttribute('loading', 'lazy');
        el.insertBefore(im, el.firstChild);
        el.classList.remove('no-art');
        // 占位态是**强制**显示卡名的；真图上自带名字，除非作者勾了 showName 否则要撤掉
        if (!c.showName) {
          const nm = el.querySelector('.card-name');
          if (nm && nm.parentNode) nm.parentNode.removeChild(nm);
        }
      }
      if (el.classList) { if (useAltArt(c)) el.classList.add('alt-on'); else el.classList.remove('alt-on'); }
      applyAltGeometry(el, c);
    }
  }
  S.flushArtDirty = flushArtDirty;
  S.markArtDirty = markArtDirty;     // 控制台/探针可手动触发（排查"图到了但屏幕没更新"）

  /* 保留旧接口（别的地方可能在用）：给一张 dataURL */
  async function mpGetArt(id) {
    const url = S.images[id];
    if (!url || typeof fetch !== 'function' || typeof FileReader !== 'function') return null;
    try {
      const blob = await (await fetch(url)).blob();
      return await new Promise(function (res) {
        const fr = new FileReader();
        fr.onload = function () { res(fr.result); };
        fr.onerror = function () { res(null); };
        fr.readAsDataURL(blob);
      });
    } catch (e) { return null; }
  }

  function mpRefreshDecks() {
    const sel = $('#mpDeck');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '';
    (S.deckLib.decks || []).forEach(function (d) {
      const o = document.createElement('option');
      o.value = d.id;
      const _on = d.restrict !== false;
      o.textContent = d.name + '（' + d.cards.length + ' 张' +
        (_on ? ' · ' + (d.major || '未选') + (d.ally ? '+' + d.ally : '') : ' · 不限制') + '）';
      sel.appendChild(o);
    });
    const opts = Array.from(sel.options || []);
    if (cur && opts.some(function (o) { return o.value === cur; })) sel.value = cur;
    else if (S.curDeckId) sel.value = S.curDeckId;
  }

  // 选一副卡组参战：必须用**同步后**的卡池校验一遍，别把对面没有的卡带进对局
  function mpPickDeck() {
    const sel = $('#mpDeck');
    const d = getSavedDeck(sel && sel.value) || getSavedDeck(S.curDeckId);
    if (!d) { toast('还没选卡组：先去「卡组构筑」存一副'); return null; }
    const cards = sanitizeDeckIds(d.cards);
    if (!cards.length) { toast('这副卡组里没有能用的卡'); return null; }
    if (cards.length < d.cards.length) {
      toast('这副卡组有 ' + (d.cards.length - cards.length) + ' 张在当前卡池里不存在，已跳过', 5000);
    }
    const ni = deckNationInfo({ cards: cards, major: d.major, ally: d.ally, restrict: d.restrict });
    MP.myDeckCards = cards; MP.myDeckName = d.name;
    MP.myRestrict = ni.restrict; MP.myRuleOk = ni.ok; MP.myRuleError = ni.error;
    return { id: d.id, name: d.name, cards: cards, restrict: ni.restrict, major: ni.major, ally: ni.ally, ruleOk: ni.ok };
  }

  function mpOnPeerMessage(p) {
    if (!p) return;
    if (p.t === 'deck') {
      MP.peerDeckCards = (p.cards || []).slice();
      MP.peerDeckName = p.name || '对方的卡组';
      MP.peerRestrict = p.restrict !== false;
      MP.peerRuleOk = p.ruleOk !== false;
      mpLog('对方选了「' + MP.peerDeckName + '」（' + MP.peerDeckCards.length + ' 张）· 主国/盟国限制 '
        + (MP.peerRestrict ? '开' : '关') + (p.major ? '（' + p.major + (p.ally ? ' + ' + p.ally : '') + '）' : ''));
      mpSetStatus(MP.status, MP.info);
      return;
    }
    if (p.t === 'mulligan') { MP.peerPicks = p.picks || []; mpMulliganBarrier(); return; }
    // （desync 现在由 net.js 内部统一处理，并会给出逐字段的差异定位）
    if (p.t === 'bye') { mpSetStatus('error', { error: '对方退出了对局' }); return; }
  }

  function mpCheckOver() {
    const st = S.state;
    if (st && st.over) {
      mpSetStatus('over', {});
      toast(st.winner === S.humanSide ? '你赢了！' : '你输了', 5000);
    }
  }

  /* 对手动作的演出：与他自己那边**看的是同一套动画**（部署飞入 / 指令过场 / 攻击冲刺 / 移动滑行）。
   * 口径与单机 AI 回合的 afterStep 完全一致：引擎先结算，再补视觉。
   * ⚠ info 必须在 applyRemote **之前**取：手牌下标结算后可能指向别的牌。 */
  function mpFxInfo(packet) {
    const st = S.state;
    if (!st) return null;
    const a = packet.args || {}, H = S.humanSide || 0;
    const info = { side: (a.pi === H) ? 'self' : 'foe' };
    if (packet.kind === 'play') {
      const p = st.players[a.pi];
      const inst = (p && p.hand) ? p.hand[a.handIdx] : null;
      const def = inst ? KG.cardDef(st, inst.id) : null;
      if (def) { info.cardName = def.name; info.cardType = def.cardType; }
    } else if (packet.kind === 'attack') {
      info.attackerUid = a.uid;
      info.target = a.ref;
    } else if (packet.kind === 'move' || packet.kind === 'reposition') {
      info.unitUid = a.uid;
    }
    return info;
  }

  async function mpPlayFx(packet, info) {
    const AN = global.KGAnim;
    if (!AN || !info || !S.state) return;
    try {
      if (packet.kind === 'play') {
        if (info.cardType === 'unit') await playDeployFX(info);
        else await playOrderFX(info);
      } else if (packet.kind === 'attack') {
        await playAiAttackFX(S.state, (packet.args || {}).pi, info);
      } else if (packet.kind === 'move' || packet.kind === 'reposition') {
        await playMoveFX(info);
      }
    } catch (e) { if (global.console) console.error('联机动画出错', e); }
  }

  async function mpOnMove(packet) {
    const Net = mpNet();
    if (!Net) return;
    const info = mpFxInfo(packet);
    snapshotHp(S.state);                 // 伤害数字的基线（与 AI 回合同一口径）
    await Net.applyRemote(packet);
    // ★ 先演完再重绘：playDeployFX 靠"没见过的 uid 差集"找刚入场的单位，
    //   提前 renderBattle() 会把新单位记进 seenUids，飞入动画就没了。
    await mpPlayFx(packet, info);
    renderBattle();
    if (packet.kind === 'endTurn') {
      if (S.state && !S.state.over && S.state.active === (S.humanSide || 0)) {
        const AN = global.KGAnim;
        if (AN) { try { await AN.turnBanner('你的回合', '第 ' + S.state.turn + ' 回合', 'mine'); } catch (e) { } }
      }
    } else if (packet.kind === 'attack' || packet.kind === 'move' || packet.kind === 'reposition') {
      toast('对手' + global.KGNetSync.describePacket(packet, S.state, KG), 1500);
    }
    mpCheckOver();
  }

  /* ★ 准备阶段的两边屏障。
   *   换牌会洗牌（消耗 rng），所以**两边必须用完全相同的顺序**结算：
   *   先按 0 号、1 号依次换牌，再依次确认。顺序不同 → 牌库不同 → 之后全歪。 */
  function mpMulliganBarrier() {
    const st = S.state;
    if (!MP.on || !st || st.phase !== 'mulligan') return;
    if (MP.myPicks == null || MP.peerPicks == null) return;      // 还没两边都确认
    const Net = mpNet();
    const picksOf = function (i) { return (i === S.humanSide ? MP.myPicks : MP.peerPicks) || []; };
    const packet = {
      kind: 'mulligan', args: {}, answers: [],
      n: Net ? ++Net.state.moveCount : 0,
    };
    for (let i = 0; i < 2; i++) {
      const picks = picksOf(i);
      if (picks.length) KG.mulliganReplace(st, i, picks);
    }
    KG.mulliganDone(st, 0);
    KG.mulliganDone(st, 1);
    MP.myPicks = null; MP.peerPicks = null;
    S.mulliganPicks = new Set();
    const prevRects = captureHandRects();                    // 重绘前：手牌还在中间大图形态
    renderBattle(); flyHandToBar(prevRects);                 // 重绘后：FLIP 平滑落回手牌区
    renderMulligan();
    if (st.phase === 'play') toast('准备阶段结束，对局开始', 2200);
    // 换牌屏障本身也是一"步"：走同一套逐步记录/比对，别在这里另搞一套计数
    if (Net && Net.recordStep) Net.recordStep(packet.n);
  }

  async function mpStep(kind, args, runOnce) {
    const Net = mpNet();
    if (!Net) { toast('联机模块未加载'); return false; }
    if (!Net.iAmActive()) { toast('现在是对手的回合'); return false; }
    let result = null;
    await Net.execLocal(kind, args, async function (ch) { result = await runOnce(ch); });
    mpCheckOver();
    return result;
  }

  /* 引擎入口包装：联机时走"录制 → 发送 → 对方回放"，单机时原样直调。
   * 参数全部显式（哪张牌 / 打谁 / 移到哪一格），对方不做任何自行判断。 */
  async function mpPlay(st, H, i, chooser, opts) {
    if (MP.on && mpNet()) {
      return await mpStep('play', { pi: H, handIdx: i, opts: opts || null },
        function (ch) { return KG.playCard(st, H, i, ch, opts); });
    }
    if (lanBlocked()) return false;
    return await KG.playCard(st, H, i, chooser, opts);
  }
  async function mpMove(st, H, uid, zone, chooser, slot) {
    if (MP.on && mpNet()) {
      return await mpStep('move', { pi: H, uid: uid, to: zone, slot: slot == null ? null : slot },
        function (ch) { return KG.move(st, H, uid, zone, ch, slot); });
    }
    if (lanBlocked()) return false;
    return await KG.move(st, H, uid, zone, chooser, slot);
  }
  async function mpAttack(st, H, uid, ref, chooser) {
    if (MP.on && mpNet()) {
      return await mpStep('attack', { pi: H, uid: uid, ref: ref },
        function (ch) { return KG.attack(st, H, uid, ref, ch); });
    }
    if (lanBlocked()) return false;
    return await KG.attack(st, H, uid, ref, chooser);
  }
  async function mpReposition(st, H, uid, slot) {
    if (MP.on && mpNet()) {
      return await mpStep('reposition', { pi: H, uid: uid, slot: slot == null ? null : slot },
        function () { return KG.reposition(st, H, uid, slot); });
    }
    if (lanBlocked()) return false;
    return KG.reposition(st, H, uid, slot);
  }
  async function mpUnsuspend(st, H, inst) {
    if (MP.on && mpNet()) {
      return await mpStep('unsuspend', { pi: H, cardId: inst && inst.id },
        function () { return KG.unsuspendCounter(st, H, inst); });
    }
    if (lanBlocked()) return false;
    return KG.unsuspendCounter(st, H, inst);
  }
  async function mpEndTurn(st, chooser) {
    if (MP.on && mpNet()) {
      const r = await mpStep('endTurn', { pi: st.active }, function (ch) { return KG.endTurn(st, ch); });
      // 交棒给对手：播"对手回合"横幅（和单机 AI 回合一样的观感）
      if (S.state && !S.state.over && S.state.active !== S.humanSide) {
        const AN = global.KGAnim;
        if (AN) { try { await AN.turnBanner('对手回合', '第 ' + S.state.turn + ' 回合', 'foe'); } catch (e) { } }
        renderBattle();
      }
      return r;
    }
    if (lanBlocked()) return false;
    return await KG.endTurn(st, chooser);
  }

  /* 开局：用双方商定的种子/卡组/先后手各建一份完全相同的对局 */
  function startMpGame(cfg) {
    MP.on = true;
    S.mpActive = true;
    S.mode = 'lan';                     // 确保面板/门禁都在联机语义下
    S.state = KG.createGame({ decks: cfg.decks, names: cfg.names, seed: cfg.seed, pool: KG.pool });
    S.humanSide = cfg.mySide;
    S.pending = null;
    S.prev = null;
    S.seenUids = new Set();
    S.hpSnapshot = null;
    S.readyForAnim = false;
    MP.myPicks = null; MP.peerPicks = null;
    renderBattle({ animate: false });
    markKnownUids();
    snapshotHp(S.state);
    S.readyForAnim = true;
    // 手机横屏：屏幕矮，先把棋盘滚到"前线"附近（单机/联机开局都要）
    if (S.centerBoardOnFrontline) setTimeout(function () { S.centerBoardOnFrontline(); }, 60);
    S.mulliganPicks = new Set();
    renderBattle(); renderMulligan();
    mpSetStatus('playing', {});
    mpLog('对局开始：种子 ' + cfg.seed + '，你是' + (cfg.mySide === 0 ? '先手' : '后手'));
    toast('联机对局开始（你是' + (cfg.mySide === 0 ? '先手' : '后手') + '）', 2600);
  }

  function mpStart(matchCfg) {
    MP.peerName = (matchCfg.names || [])[1 - matchCfg.mySide] || '对手';
    startMpGame(matchCfg);
  }

  function mpBind() {
    const Net = mpNet(), NS = global.KGNetSync;
    if (!Net || !NS || MP.inited) return;
    MP.inited = true;
    // 本地能力交给网络层：网络层只管协议与同步，不直接碰卡池/存储（也方便单独测）
    Net.hooks.getPoolCards = function () { return S.pool; };
    Net.hooks.hashPool = function () { return NS.poolDigest(S.pool); };
    Net.hooks.applyCards = mpApplyCards;
    // ★ 主机 DSL 强制层（2026-09-25 制作者铁律）：连接时主机推送效果覆盖层，
    //   客机整体替换 S.hostFx 并重算卡池 —— 主机有的条目强制生效（custom 卡也吃），
    //   主机没有的条目不在覆盖层里 → 本地卡原样（"主机没有的不管"）。
    Net.hooks.getFxOverlay = function () { return global.KG_EFFECT_OVERLAY || null; };
    Net.hooks.applyFxOverlay = function (ov) {
      if (!ov || typeof ov !== 'object') return;
      S.hostFx = ov;
      rebuildPool();
      try { console.log('[联机] 已强制同步主机端效果 DSL（' + Object.keys(ov).length + ' 条）'); } catch (e) { }
    };
    Net.hooks.getArt = mpGetArt;
    Net.hooks.getArtRaw = mpGetArtRaw;   // ★ 二进制路：读裸字节，net.js 切分片并发发
    Net.hooks.setArt = mpSetArt;
    Net.hooks.artIds = function () { return Object.keys(S.images || {}); };
    // ★ 建房/加入前强制刷新本地卡数据（拉服务器最新 cards.json + effects-data.js）：
    //   "每次刷新和连接时都必须强制拉取"——不当房主时刷新路已覆盖；一旦当房主，
    //   自己的 localStorage 就是权威（冲突按主机来），权威是旧的会把对方也拉成旧的。
    Net.hooks.refreshCards = function () { return syncCardsFromHost(); };
    Net.hooks.getDecks = function () { return S.deckLib.decks; };
    Net.hooks.onStatus = mpSetStatus;
    Net.hooks.onProgress = mpProgress;
    Net.hooks.onPeerMessage = mpOnPeerMessage;
    Net.hooks.onMove = mpOnMove;
    Net.hooks.onLog = mpLog;
    Net.hooks.getState = function () { return S.state; };
    Net.hooks.localChooser = function (req) { return uiChooser()(req); };
    Net.hooks.onMatchStart = mpStart;

    const hostBtn = $('#mpHostBtn'), joinBtn = $('#mpJoinBtn'), leaveBtn = $('#mpLeaveBtn');
    const startBtn = $('#mpStartBtn'), artBox = $('#mpArt'), deckSel = $('#mpDeck');

    if (artBox) {
      MP.syncArt = !!artBox.checked;
      Net.state.syncArt = MP.syncArt;
      artBox.addEventListener('change', function () {
        MP.syncArt = !!artBox.checked;
        Net.state.syncArt = MP.syncArt;
        mpLog(MP.syncArt ? '联机时会一起同步卡图' : '联机时只同步数值与效果（对方缺的卡用纯文字卡面）');
      });
    }
    if (hostBtn) hostBtn.addEventListener('click', async function () {
      try {
        MP.myName = ($('#mpName') && $('#mpName').value) || '房主';
        Net.setName(MP.myName);
        hostBtn.disabled = true;
        await Net.host({});                 // 对方加入时会自动打招呼（早发会被服务端丢掉）
        mpRefreshDecks();
        mpLog('房间已建立：把本机地址 + 房间码 ' + (Net.state.code || '') + ' 发给对方');
        mpShowAddresses();                  // 把"该发哪条地址"（含 UU 虚拟 IP）列在面板上
      } catch (e) {
        hostBtn.disabled = false;
        mpSetStatus('error', { error: e.message });
      }
    });
    if (joinBtn) joinBtn.addEventListener('click', async function () {
      const code = String(($('#mpRoom') && $('#mpRoom').value) || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) { toast('房间码是 4 位字母数字'); return; }
      try {
        MP.myName = ($('#mpName') && $('#mpName').value) || '玩家';
        Net.setName(MP.myName);
        joinBtn.disabled = true;
        await Net.join(code);               // 进房间后会自动打招呼
        mpRefreshDecks();
      } catch (e) {
        joinBtn.disabled = false;
        mpSetStatus('error', { error: e.message });
      }
    });
    // ★ 服务器地址（跨网 / UU 加速器）：对方填房主的虚拟 IP:端口，下次自动带上。
    //   留空 = 用当前页面的地址（同一个 WiFi、或对方就是从这个地址打开页面的情况）。
    const relayInput = $('#mpRelay'), relayBtn = $('#mpRelayBtn'), relayClear = $('#mpRelayClear');
    const relayDisplay = function (v) {
      return String(v || '').replace(/^wss?:\/\//i, '').replace(/\/kg-ws\/?$/i, '').replace(/\/+$/, '');
    };
    if (relayInput && Net.getRelay) relayInput.value = relayDisplay(Net.getRelay());
    if (relayBtn) relayBtn.addEventListener('click', function () {
      const v = String((relayInput && relayInput.value) || '').trim();
      if (!v) {
        Net.clearRelay();
        mpLog('已清除服务器地址：下次连接用当前页面的地址');
        toast('已清除服务器地址', 1600);
        return;
      }
      const full = Net.setRelay(v);
      mpLog('服务器地址已设为 ' + full + '（已记住，建房/加入时生效）');
      // 已经连着的话改地址不会立刻生效：WebSocket 还开着，下次连接才用新地址
      toast(Net.isOpen() ? ('服务器地址已记住，下次连接生效：' + full) : ('服务器地址已应用：' + full), 3000);
    });
    if (relayClear) relayClear.addEventListener('click', function () {
      if (relayInput) relayInput.value = '';
      Net.clearRelay();
      mpLog('已清除服务器地址：下次连接用当前页面的地址');
      toast('已清除服务器地址', 1600);
    });

    if (deckSel) deckSel.addEventListener('change', function () {
      if (!mpAnnounceDeck()) return;
      mpSetStatus(MP.status, MP.info);       // 重新算按钮是否可点 + 刷新提示
    });
    if (startBtn) startBtn.addEventListener('click', function () {
      const d = mpPickDeck();
      if (!d) return;
      if (!MP.peerDeckCards) { toast('等对方也选好卡组'); return; }
      // ★ 主国/盟国：双方开关必须一致；都开时各自卡组必须合规
      if ((MP.myRestrict !== false) !== (MP.peerRestrict !== false)) {
        toast('主国/盟国限制开关必须一致：你' + (MP.myRestrict !== false ? '开' : '关') + '、对方' + (MP.peerRestrict !== false ? '开' : '关'), 6000); return;
      }
      if (MP.myRestrict !== false && MP.myRuleOk === false) { toast('你的卡组不符合主国/盟国限制：' + (MP.myRuleError || ''), 6000); return; }
      if (MP.peerRestrict !== false && MP.peerRuleOk === false) { toast('对方的卡组不符合主国/盟国限制，让他改一下', 6000); return; }
      // 先后手不提供人工选择：由房主定的种子随机决定，两边算出来一致
      Net.hostStart(d.cards, MP.peerDeckCards, {
        myName: MP.myName || '房主',
        peerName: MP.peerName || '玩家',
        nationEnabled: (MP.myRestrict !== false),
      });
      startBtn.disabled = true;
    });
    if (leaveBtn) leaveBtn.addEventListener('click', function () { mpDisconnect(false); });

    // 联机日志侧边栏（折叠抽屉）：出问题点开看全程，一键复制发开发者
    const logToggle2 = $('#mpLogToggle'), logDrawer2 = $('#mpLogDrawer');
    if (logToggle2 && logDrawer2) {
      logToggle2.addEventListener('click', function () {
        logDrawer2.classList.toggle('hidden');
        mpRenderLog();                          // 打开时重渲染 + 清未读徽标
      });
    }
    const logCopy2 = $('#mpLogCopy');
    if (logCopy2) logCopy2.addEventListener('click', mpLogCopy);
    const logClose2 = $('#mpLogClose');
    if (logClose2) logClose2.addEventListener('click', function () {
      if (logDrawer2) logDrawer2.classList.add('hidden');
      mpRenderLogBadge();
    });

    // 模式切换按钮
    const modeAiBtn = $('#modeAiBtn'), modeLanBtn = $('#modeLanBtn');
    if (modeAiBtn) modeAiBtn.addEventListener('click', function () { mpSetMode('ai'); });
    if (modeLanBtn) modeLanBtn.addEventListener('click', function () { mpSetMode('lan'); });
    mpSetMode(S.mode || 'ai');
    mpRefreshDecks();
    mpSetStatus('idle', {});
  }

  /* ---------------------------------------------------------------- 屏幕 */
  function show(screen) {
    // ★ 切屏必须收起弹着的卡牌详情 —— 手机端的详情是 **tap 打开、常驻** 的
    //   （没有 mouseleave 来帮你关），切屏后它会像幽灵一样浮在新界面上
    //   （2026-09-25 构筑屏截图里就残留了一张"卫星计划"）。
    hideTip();
    S._tipAnchor = null;
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + screen));
    // ★ 当前屏记到 body 上：CSS 侧用它做"对战屏藏主菜单"这类按屏定制
    //   （2026-09-25 十一轮 UI 瘦身：手机对战时顶栏 nav 整条藏掉）
    try { document.body.dataset.screen = screen; } catch (e) { }
    // 'deck'（构筑）是 'decklib'（选择卡组）的下级界面 → 顶栏仍高亮「卡组」
    const navKey = screen === 'deck' ? 'decklib' : screen;
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.screen === navKey));
    // ★ 'decklib'（选择卡组）也要渲染：#deckLib 列表就挂在这个界面上
    if (screen === 'deck' || screen === 'decklib') renderDeckScreen();
    if (screen === 'collection') renderCollection();
    if (screen === 'battle' && !S.state) { startGame(); if (!S.state) renderBattle({animate:false}); }
    // 切回对战屏要重算一次"战场铺满缩放"（切屏时 #boardScroll 的高度会变）
    if (screen === 'battle' && S.fitBoardScale) setTimeout(function () { S.fitBoardScale(true); }, 30);
  }

  /* ================================================================ 对战 */
  function startGame(deckIds, mpCfg) {
    if (mpCfg) return startMpGame(mpCfg);      // 联机：种子/卡组/先后手都由双方商定
    if (!deckIds) {                            // ★ 单机：卡组必须符合主国/盟国限制（联机在开局前已校验）
      const ni0 = currentRuleDeck();
      if (ni0.restrict && S.deck.length && !ni0.ok) { toast('卡组不符合主国/盟国限制：' + ni0.error, 6000); return; }
    }
    MP.on = false; S.mpActive = false;         // 单机：确保不会被上一次联机残留影响
    const deck = deckIds || (S.deck.length ? S.deck.slice() : autoDeckForRule());
    if (!S.deck.length) { S.deck = deck.slice(); LS.set('deck', S.deck); }
    const useAiOrders = $('#optAiOrders') ? $('#optAiOrders').checked : true;
    const aiDeck = S.aiDeck.length >= 8 ? S.aiDeck.slice() : null;
    const foeDeck = aiDeck || KG.autoDeck(S.pool, { useOrders: useAiOrders });
    S.prev = null;
    // 对战设置
    const firstOpt = ($('#optFirst') && $('#optFirst').value) || '0';
    const aiRaw = ($('#optAi') && $('#optAi').value) || '0';
    const aiLvl = aiRaw === 'mild' ? 1 : (parseInt(aiRaw, 10) || 0);
    const aiFirst = firstOpt === 'r' ? (Math.random() < 0.5 ? 1 : 0) : parseInt(firstOpt, 10);
    S.state = KG.createGame({
      decks: aiFirst === 0 ? [deck, foeDeck] : [foeDeck, deck],
      names: aiFirst === 0 ? ['你', '对手'] : ['对手', '你'],
      seed: (Math.random() * 1e9) | 0,
      pool: KG.pool,
    });
    S.state.aiBonusKredit = aiLvl;
    S.state.aiBonusEvery = 1;
    S.state.aiBonusFromTurn = aiRaw === 'mild' ? 5 : 1;
    S.humanSide = aiFirst === 0 ? 0 : 1;
    S.pending = null;
    S.prev = null;
    S.seenUids = new Set();
    S.hpSnapshot = null;
    // 首帧不做 FLIP：新对局时所有卡都是"新出现"，不该从旧位置飞过来
    S.readyForAnim = false;
    renderBattle({ animate: false });
    markKnownUids();
    snapshotHp(S.state);
    S.readyForAnim = true;
    // 手机横屏：屏幕矮，先把棋盘滚到"前线"附近（单机/联机开局都要）
    if (S.centerBoardOnFrontline) setTimeout(function () { S.centerBoardOnFrontline(); }, 60);
    // ★ 准备阶段（mulligan）：人类先换牌。AI 的换牌在其 takeTurn 的守卫里自动完成。
    //   autoMulligan（测试用）：双方直接确认，不换牌。
    if (S.state.phase === 'mulligan') {
      if (S.autoMulligan) {
        KG.mulliganDone(S.state, 0); KG.mulliganDone(S.state, 1);
        renderBattle();
        if (S.state.active !== S.humanSide) aiTurn();
        else { const AN = global.KGAnim; if (AN) AN.turnBanner('你的回合', '第 ' + S.state.turn + ' 回合', 'mine'); }
        return;
      }
      S.mulliganPicks = new Set();
      renderBattle();
      renderMulligan();
      return;
    }
    if (S.state.active !== S.humanSide) aiTurn();
    else {
      const AN = global.KGAnim;
      if (AN) AN.turnBanner('你的回合', '第 ' + S.state.turn + ' 回合', 'mine');
      else toast('你的回合', 1200);
    }
  }

  /* ------------------------------------------------- AI 回合：完整逐步演出 */
  // 原版 KARDS 的对手回合是"一步一步演给你看"：每张牌从手牌飞向棋盘、
  // 单位弹入、攻击冲刺、移动滑行，中间留出停顿让人看清，战报同步高亮。
  // 这套演出由 ai.js 的 afterStep 钩子驱动，reason 告诉我们是哪一类动作。
  //
  // 并发安全：AI 回合的演出一共要 1~2 秒，而玩家可能在这个窗口里又点了一次
  // "结束回合"（自动化测试的轮询节奏更快）。旧的写法是 `if (S.aiThinking) return;`
  // —— 那样会把这一个**新的、合法的** AI 回合直接丢掉，回合永远推进不下去。
  // 现在改成：把 aiTurn 串成一条链，后来的调用排在前面那次之后，等前一次收尾
  // 再重新判断"是不是真的轮到我行动"。
  let aiTurnChain = Promise.resolve();
  function aiTurn() {
    // ★ 联机模式下一律不跑 AI：对手是真人，本地跑 AI 两边状态会立刻分叉
    if (MP.on || S.mode === 'lan') return Promise.resolve();
    const next = aiTurnChain.then(() => runAiTurnOnce(), () => runAiTurnOnce());
    // 链上只保留"是否完成"，不让异常污染后续调用
    aiTurnChain = next.catch(() => { });
    return next;
  }

  async function runAiTurnOnce() {
    const ai = 1 - (S.humanSide || 0);
    // 上一次已经把我方回合交回来了 / 对局已结束 → 这一次什么都没得做
    if (S.state.over || S.state.active !== ai) return;
    // ★ 准备阶段：AI 先完成自己的换牌（默认不换），然后等人类确认。不播横幅、不行动。
    if (S.state.phase === 'mulligan') {
      if (!S.state.mulligan.done[ai]) { KG.mulliganDone(S.state, ai); renderBattle(); renderMulligan(); }
      return;
    }
    if (S.aiThinking) return;                 // 理论上不会走到（链已串行），保底
    S.aiThinking = true;
    const AN = global.KGAnim;
    const sleepA = ms => new Promise(r => setTimeout(r, ms));
    showAiThinking(true);
    try {
      // 回合横幅：对手回合
      if (AN) await AN.turnBanner('对手回合', '第 ' + (S.state.turn) + ' 回合', 'foe');
      await sleepA(240);

      // 记录 AI 回合开始前的日志位置，用于增量高亮
      const logStart = (S.state.log || []).length;
      const flashNewLogs = () => {
        const rows = $$('#battleLog div');
        const logs = S.state.log || [];
        const newCount = logs.length - logStart;
        if (newCount <= 0) return;
        // 战报只渲染最后 120 条，所以"新增的 N 条"就是末尾 N 条
        for (let k = Math.max(0, rows.length - newCount); k < rows.length; k++) {
          const r = rows[k];
          if (!r) continue;
          r.classList.remove('log-flash');
          void r.offsetWidth;
          r.classList.add('log-flash');
        }
        const box = $('#battleLog');
        if (box) box.scrollTop = box.scrollHeight;
      };

      // 每步动作的演出：出牌 → 卡面从"对手手牌"飞到棋盘；攻击 → 冲刺 + 命中；
      // 移动 → FLIP 滑动（renderBattle 自动补）。演出完再刷新 + 高亮战报 + 停顿。
      // 注意：afterStep 在引擎已结算**之后**触发，所以 hpSnapshot 记录的是"上一步结束时的血量"，
      // 正好可以用来算这一步造成的伤害。
      const afterStep = async (state, pi, info) => {
        const kind = (info && info.kind) || info || 'play';
        try {
          if (kind === 'play' && info && info.cardType === 'order') {
            await playOrderFX(info);
          } else if (kind === 'play') {
            await playDeployFX(info);
          } else if (kind === 'attack') {
            await playAiAttackFX(state, pi, info);
          } else if (kind === 'move') {
            await playMoveFX(info);
          }
        } catch (e) { console.error('ai step fx', e); }
        renderBattle();
        flashNewLogs();
        snapshotHp(state);                    // 为下一步的伤害数字打底
        await sleepA(kind === 'attack' ? 560 : 500);
      };

      snapshotHp(S.state);                    // 第一步之前的基线

      if (!S.state.over && S.state.active === ai) {
        await KG.ai.takeTurn(S.state, ai, { delay: 420, afterStep: afterStep });
      }
      renderBattle();
      flashNewLogs();
      await sleepA(220);
      if (!S.state.over && S.state.active === (S.humanSide || 0)) {
        if (AN) await AN.turnBanner('你的回合', '第 ' + S.state.turn + ' 回合', 'mine');
      }
    } catch (e) {
      console.error(e); toast('AI 出错：' + e.message);
    }
    showAiThinking(false);
    S.aiThinking = false;
    // 兜底：演出结束、对手仍该行动（例如 takeTurn 内部被某个 await 打断），
    // 再排一次，避免回合彻底停住。
    // ⚠ 准备阶段（mulligan）不重试：AI 已 done、在等人类确认，重试只会空转。
    if (!S.state.over && S.state.phase !== 'mulligan' && S.state.active === ai && !S.aiTurnRetry) {
      S.aiTurnRetry = true;
      setTimeout(() => { S.aiTurnRetry = false; aiTurn(); }, 60);
    }
  }

  function showAiThinking(on) {
    let el = $('#aiThinking');
    if (on) {
      if (el) return;
      el = document.createElement('div');
      el.id = 'aiThinking';
      el.className = 'ai-thinking';
      el.innerHTML = '<span>对手正在部署</span><i class="dot"></i><i class="dot"></i><i class="dot"></i>';
      document.body.appendChild(el);
    } else if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }

  /* ------------------------- AI 单步动作的视觉演出 ------------------------- */
  // 对手手牌区/牌库的位置（当作"AI 出牌"的起点）
  function foeHandAnchor() {
    const el = $('#foeDeck') || $('#foeHand');
    const r = rectOf(el);
    if (r) return { left: r.left + r.width / 2 - 30, top: r.top + r.height / 2 - 40, width: 60, height: 84 };
    const bar = $('#boardScroll');
    const rb = rectOf(bar);
    return rb ? { left: rb.left + rb.width / 2, top: rb.top + 10, width: 60, height: 84 } : null;
  }

  // 指令牌的过场式演出 —— 从屏幕上方落下 → 横移到屏侧 → 停 1 秒 → 移出屏幕外
  // （原版 KARDS 里打指令就是这种"亮牌过场"，比在棋盘中央闪一下更有存在感）
  //
  // ⚠ 敌我共用同一套动画（时长/缓动/呼吸光晕完全一致），只有停靠侧不同：
  //     对手 → 左侧；我方 → 右侧（用户指定）。
  // 指令的"效果类别"（伤害/消灭/增益/削弱/情报/治疗/召唤/补给）→ 决定用哪套演出。
  //   op 从该卡的效果树里递归收集（条件/抉择/循环都是嵌套对象）。
  function fxCategoryOfId(id) {
    const AN = global.KGAnim;
    if (!AN || !AN.classifyOps || !id) return 'generic';
    const overlay = global.KG_EFFECT_OVERLAY || {};
    // 界面卡池优先（和调用方 want=classify(orderDef.effects) 同一份数据，避免"分类演出落到 generic"）
    const def = uiCardById(id);
    const src = (overlay[id] && overlay[id].effects) || (def && def.effects) || [];
    return AN.classifyOps(AN.collectOps(src, [], 0));
  }
  function fxCategoryByName(name) {
    if (!name) return 'generic';
    // ⚠ S.pool 是**数组**：以前用 Object.keys().find() 拿到的是"下标字符串"，
    //   再当成 id 传下去 → 查不到卡 → 分类演出静默退化成 generic（本轮的假红就是这个）。
    const arr = Array.isArray(S.pool) ? S.pool : Object.keys(S.pool || {}).map(k => S.pool[k]);
    const hit = (arr || []).find(c => c && c.name === name);
    return (hit && hit.id) ? fxCategoryOfId(hit.id) : 'generic';
  }
  function fxCategoryOf(def) {
    if (!def) return 'generic';
    const overlay = global.KG_EFFECT_OVERLAY || {};
    if (def.id && (overlay[def.id] || (KG.pool && KG.pool[def.id]) || (S.pool || []).some(c => c.id === def.id))) return fxCategoryOfId(def.id);
    return fxCategoryByName(def.name);
  }

  async function playOrderFX(info) {
    const AN = global.KGAnim;
    if (!AN) return;
    const name = (info && info.cardName) || '指令';
    const isSelf = !!(info && info.side === 'self');
    const artHtml = orderArtHtml(info);
    // 先按效果类别铺一层棋盘演出（火光/碎裂/金光/扫描…），再走卡牌过场
    const cat = (info && info.fxCat) || fxCategoryByName(name);
    // 不 await：分类演出是"背景层"，与亮牌过场并行，不给指令再多加延迟
    try { if (AN.orderFx) AN.orderFx(cat, { boardEl: $('#boardScroll') }); } catch (e) { }
    // 音效按指令分类区分（fire=榴弹炮 / destroy=爆炸 / buff=明亮咔哒 / supply=纸张…）
    try { if (global.KGSfx && global.KGSfx.order) global.KGSfx.order(cat); } catch (e) { }
    const fn = AN.playOrderCard || AN.playOpponentOrder;
    if (typeof fn === 'function') {
      await fn({ artHtml: artHtml, name: name, holdMs: 1000, side: isSelf ? 'self' : 'foe', sourceRect: info && info.sourceRect });
    }
    // 演出收尾的轻微提示：战报侧闪一下 + 飘一条 toast
    const b = $('#boardScroll');
    if (b) { b.classList.add('order-flash'); setTimeout(() => b.classList.remove('order-flash'), 520); }
    if (info && info.cardName) toast((isSelf ? '你使用了指令：' : '对手使用指令：') + info.cardName, 1600);
  }

  // 取"这张指令牌"的卡面 HTML（有图用图，没图退化成卡名文字块）
  function orderArtHtml(info) {
    const st = S.state;
    const name = info && info.cardName;
    let def = null;
    if (st && name) {
      const id = Object.keys(S.pool || {}).find(k => (S.pool[k] || {}).name === name);
      if (id) def = S.pool[id];
    }
    const art = def ? cardArt(def) : null;
    if (art) {
      return '<img src="' + art + '" alt="">' +
        '<div class="opp-order-name">' + name + '</div>';
    }
    return '<div class="fly-text opp-order-text">' + name + '</div>';
  }

  // AI 部署/埋设：先渲染出"新单位"，让新卡从对手方向飞入
  async function playDeployFX(info) {
    const AN = global.KGAnim;
    if (!AN) return;
    const src = foeHandAnchor();
    // 先重绘，让新单位节点出现在场上
    renderBattle();
    // 找到刚出现的那个新单位（用 seenUids 差集）
    if (!S.seenUids) S.seenUids = new Set();
    let fresh = null;
    $$('.card[data-uid]').forEach(el => {
      if (el.dataset.uid && !S.seenUids.has(el.dataset.uid)) {
        if (!fresh) fresh = el;
        S.seenUids.add(el.dataset.uid);
      }
    });
    if (fresh && src) {
      const freshRect = rectOf(fresh);
      if (freshRect) {
        // 卡面先隐藏，等飞行结束再显形
        fresh.style.visibility = 'hidden';
        await AN.flyCard(src, fresh,
          '<div class="fly-text">' + (info.cardName || '') + '</div>',
          { cls: 'fly-deploy' });
        fresh.style.visibility = '';
        await AN.pulse(fresh, 'pulse', 460);
      }
    } else if (fresh) {
      await AN.pulse(fresh, 'pulse', 460);
    }
    if (info.cardName) toast('对手打出：' + info.cardName, 1700);
  }

  // AI 攻击：单位向目标冲刺 → 命中 → 弹回（引擎已结算，这里补视觉）
  // 伤害数字用"这一步之前记录的 HP 快照"来算，所以外部需要先 snapshotHp()。
  async function playAiAttackFX(state, pi, info) {
    const AN = global.KGAnim;
    if (!AN) return;
    const aEl = info && info.attackerUid ? unitElByUid(info.attackerUid) : null;
    let tEl = null;
    if (info && info.target && info.target.kind === 'hq') tEl = hqElOf(S.humanSide || 0);
    else if (info && info.target && info.target.uid) tEl = unitElByUid(info.target.uid);
    if (!aEl || !tEl) return;
    const before = S.hpSnapshot || {};
    const key = info && info.target && info.target.kind === 'hq' ? ('hq' + (S.humanSide || 0))
      : (info && info.target && info.target.uid ? info.target.uid : null);
    const aiAttacker = info && info.attackerUid ? KG.unitByUid(state, info.attackerUid) : null;
    const aiVictim = info && info.target && info.target.uid ? KG.unitByUid(state, info.target.uid) : null;
    await AN.lunge(aEl, tEl, {
      unit: aiAttacker, target: aiVictim,          // 音效按兵种/防御力分化
      onHit: () => {
        AN.impact(tEl, null, { target: aiVictim || (info && info.target && info.target.uid ? KG.unitByUid(state, info.target.uid) : null), unit: aiAttacker });
        if (key) {
          const after = key.indexOf('hq') === 0
            ? (state.players[+key.slice(2)] || {}).hq
            : (KG.unitByUid(state, key) ? KG.unitByUid(state, key).defense : 0);
          const delta = (before[key] || 0) - (after || 0);
          const ak = AN.hitKindOf ? AN.hitKindOf(AN.kindOf(aiAttacker)) : null;
          if (delta > 0) AN.floatValue(tEl, '-' + delta, ak);
        }
      },
    });
  }

  // 记录当前场上所有单位与总部的 HP（用于给"下一步"算伤害数字）
  function snapshotHp(state) {
    const snap = {};
    if (!state) { S.hpSnapshot = snap; return snap; }
    (state.frontline || []).concat(state.players[0].support, state.players[1].support)
      .forEach(u => { snap[u.uid] = u.defense; });
    snap['hq0'] = state.players[0].hq;
    snap['hq1'] = state.players[1].hq;
    S.hpSnapshot = snap;
    return snap;
  }
  S.snapshotHp = snapshotHp;

  // AI 移动：靠 renderBattle 的 FLIP 补滑动，这里只补一个"起手"脉冲
  async function playMoveFX(info) {
    const AN = global.KGAnim;
    if (!AN || !info || !info.unitUid) return;
    const el = unitElByUid(info.unitUid);
    if (el) await AN.pulse(el, 'pulse', 380);
  }

  // 给"新出现的单位"加入场动画：对比上一帧见过的 uid 集合
  function enterNewUnits() {
    if (!S.seenUids) S.seenUids = new Set();
    const all = document.querySelectorAll('.card[data-uid]');
    all.forEach(el => {
      const uid = el.dataset.uid;
      if (!uid) return;
      if (!S.seenUids.has(uid)) {
        el.classList.remove('enter');
        void el.offsetWidth;            // 重启动画
        el.classList.add('enter');
        S.seenUids.add(uid);
      }
    });
  }

  /* ------------------------------------------- 光环来源高亮（谁在给谁加成） */
  // 原版里光环是有"来源"标记的：悬停来源能看出它罩住了谁，悬停被罩的单位能反查是谁在加。
  function auraEffectsOf(u) {
    if (!u || u.silenced) return [];
    return ((u.def && u.def.effects) || []).filter(function (e) { return e && e.aura; });
  }
  // 用**引擎自己的** selectUnits 算作用范围（保证与 recomputeAuras 完全一致，不另写一套口径）
  function auraTargetsOf(src, st) {
    const out = [];
    const aes = auraEffectsOf(src);
    if (!aes.length) return out;
    const sel = (KG.effects && KG.effects.selectUnits) || null;
    if (!sel) return out;
    aes.forEach(function (e) {
      const ctx = { owner: src.owner, unit: src, source: src, vars: {} };
      let hit = null;
      try { hit = sel(st, ctx, Object.assign({ sel: 'all' }, (e.aura && e.aura.target) || {})); } catch (err) { hit = null; }
      (hit || []).forEach(function (u2) { if (out.indexOf(u2) < 0) out.push(u2); });
    });
    return out;
  }
  function auraSourcesOf(u, st) {
    const out = [];
    [0, 1].forEach(function (i) {
      KG.allUnitsOf(st, i).forEach(function (s) {
        if (s === u || out.indexOf(s) >= 0) return;
        if (auraTargetsOf(s, st).indexOf(u) >= 0) out.push(s);
      });
    });
    return out;
  }
  function clearAuraHighlight() {
    $$('.card.aura-hit, .card.aura-src-on').forEach(function (el) {
      el.classList.remove('aura-hit');
      el.classList.remove('aura-src-on');
    });
  }
  // 悬停一个单位：它自己是光环来源 → 亮起受它加成的单位；它是被加成的 → 亮起来源
  function auraHover(uid, on) {
    const st = S.state;
    clearAuraHighlight();
    if (!st || on === false) return;
    const u = KG.unitByUid(st, uid);
    if (!u) return;
    const AN = global.KGAnim;
    const pulse = function (el) { if (el && AN && AN.pulse) { try { AN.pulse(el, 'pulse', 460); } catch (e) { } } };
    const targets = auraTargetsOf(u, st);
    if (targets.length) {
      const se = unitElByUid(u.uid);
      if (se) { se.classList.add('aura-src-on'); pulse(se); }
      targets.forEach(function (t2) {
        const el = unitElByUid(t2.uid);
        if (el) el.classList.add('aura-hit');
      });
      return;
    }
    const srcs = auraSourcesOf(u, st);
    if (!srcs.length) return;
    const me = unitElByUid(u.uid);
    if (me) me.classList.add('aura-hit');
    srcs.forEach(function (s2) {
      const el = unitElByUid(s2.uid);
      if (el) { el.classList.add('aura-src-on'); pulse(el); }
    });
  }
  S.auraHover = auraHover;        // 供自动化测试/外部调用

  function unitBadges(u) {
    const out = [];
    Object.keys(u.kws || {}).forEach(k => {
      if (!u.kws[k]) return;
      const K = KG.KEYWORDS[k];
      out.push('<span class="badge kw">' + (K ? K.cn : k) + (u.kwValues[k] ? u.kwValues[k] : '') + '</span>');
    });
    // ★ 制作者口径：卡面**只出现对战词条**。沉默 / 前线 / ≈ / 光环 这类都不是词条 → 不上卡面
    //   （沉默仍靠 .silenced 灰化 + 悬停详情，前线看阵线本身，≈ 看悬停 title）。
    return out.join('');
  }

  function unitEl(u, interactive) {
    // ★ 场上单位左上角 = **行动花费**（制作者 2026-09-22 要求），不是部署花费。
    //   部署花费只在手牌/卡库里有意义；上了场之后玩家关心的是"这一下要不要花指挥点"。
    //   取 KG.effOpCost（含自身修正 / 光环 / 全局修正），跟引擎实际扣费口径一致。
    const baseOp = (u.def.opCost == null ? 0 : u.def.opCost);
    const opNow = (S.state && KG.effOpCost) ? KG.effOpCost(S.state, u.owner, u) : baseOp;
    const c = Object.assign({}, u.def, {
      attack: u.attack, defense: u.defense,
      kwMap: u.kws, kwValues: u.kwValues,
      cost: opNow,
      // 类与悬停说明直接交给 cardEl 渲染（见那里关于 innerHTML 复用的注释）
      costCls: 'op' + (opNow === 0 ? ' zero' : '') +
        (opNow < baseOp ? ' op-down' : opNow > baseOp ? ' op-up' : ''),
      costTitle: (opNow === baseOp)
        ? ('行动花费 ' + opNow)
        : ('行动花费：基础 ' + baseOp + ' → 当前 ' + opNow),
    });
    // 巡航舰：两套攻击值都要带上"增益差值"（引擎 attackPowerAgainst = dual 基础 + permAtk/修正）
    if (u.def.dualAttack) {
      const dlt = (u.attack || 0) - (u.def.attack || 0);
      c.dualAttack = {
        vsType: u.def.dualAttack.vsType,
        value: (u.def.dualAttack.value || 0) + dlt,
        normal: (u.def.dualAttack.normal || 0) + dlt,
      };
    }
    const H = S.humanSide || 0;
    const mine = u.owner === H;
    // ★ 隐蔽（制作者词条）：对手的隐蔽单位「卡背朝上」——盖一层不透明遮罩，
    //   名字/效果/词条/悬停说明全部不可见，直到被攻击（kws.conceal 移除后遮罩消失）。
    //   自己的隐蔽单位对自己正常显示。
    const concealed = !!(u.kws && u.kws.conceal && !mine);
    const canActNow = mine && u.canAct && u.actionsLeft > 0 && S.state && S.state.active === H && !S.state.over;
    const stCls = (canActNow ? 'playable' : 'exhausted') + (interactive ? ' selectable' : '') +
      (u.silenced ? ' silenced' : '') + (((u.kws && u.kws.pin) || (u.pinnedTurns > 0)) ? ' pinned' : '');
    // ★ 攻防被改过（增益/减益/编辑）时：**角落的数字**直接反映当前值并变色 + 写明"基础 → 当前"，
    //   不再往词条行塞 "x/x"（制作者口径）。
    //   ⚠ 状态类挂在**卡元素本身**（atk-up/atk-down/def-up/def-down）：按 uid 复用节点时是
    //     复制 className + innerHTML，挂在子元素上的类在"复制后被重新解析"的路径上不可靠。
    const baseAtk = u.def.attack == null ? 0 : u.def.attack;
    const baseDef = u.def.defense == null ? 1 : u.def.defense;
    const statCls = [];
    if (u.attack !== baseAtk) statCls.push(u.attack > baseAtk ? 'atk-up' : 'atk-down');
    if (u.defense !== baseDef) statCls.push(u.defense > baseDef ? 'def-up' : 'def-down');
    const el = cardEl(c, { uid: u.uid, cls: stCls + ' kw-out' + (statCls.length ? ' ' + statCls.join(' ') : '') + (concealed ? ' concealed' : '') });
    if (concealed) {
      const cover = document.createElement('div');
      cover.className = 'conceal-cover';
      cover.textContent = '？';
      el.appendChild(cover);
    }
    const atkEl = el.querySelector('.card-stat.atk');
    const defEl = el.querySelector('.card-stat.def');
    if (atkEl && u.attack !== baseAtk) atkEl.title = '基础 ' + baseAtk + ' → 当前 ' + u.attack;
    if (defEl && u.defense !== baseDef) defEl.title = '基础 ' + baseDef + ' → 当前 ' + u.defense;
    // 光环来源：**卡面不再挂角标**（制作者口径：卡面只留对战词条）；
    //   悬停时仍然双向点亮（来源 ↔ 受加成单位），光环的存在感靠高亮表达。
    if (auraEffectsOf(u).length) el.dataset.auraSrc = '1';
    el.onmouseenter = function () { auraHover(u.uid, true); };
    el.onmouseleave = function () { auraHover(u.uid, false); };
    // ★ 战场单位的词条排到**卡牌外侧**（贴着边缘的竖排一列，样式由 .card.kw-out 作用域控制），
    //   卡面本身不再被底部那条渐变遮住。
    const badgeBox = el.querySelector('.card-badges');
    badgeBox.innerHTML = concealed ? '' : unitBadges(u);   // 只放对战词条（≈ 等状态看悬停 title）
    el.title = concealed ? '' : (u.def.unimplemented ? '这张卡的部分效果是近似实现（引擎缺少对应原语）' : '');
    // 点击场上单位只显示详情；攻击/移动使用拖拽，避免点击同时承担两种操作。
    // 拖拽（移动/攻击）由 renderBattle 里的 bindUnit 用 pointer 事件绑定
    return el;
  }

  /* 总部画成一张卡：支援阵线最左端那一格 */
  function hqCardEl(owner, H, opts) {
    const st = S.state, p = st.players[owner];
    const el = document.createElement('div');
    el.className = 'hq-card ' + (owner === H ? 'mine' : 'foe');
    el.id = owner === H ? 'myHq' : 'foeHq';
    el.dataset.hq = String(owner);
    el.dataset.side = (owner === H) ? 'me' : 'foe';   // 几何判定/测试沙箱按 side 分左右两排
    el.innerHTML = '<div class="hq-art">🛡</div>' +
      '<div class="hq-hp">' + Math.max(0, p.hq) + '</div>' +
      '<div class="hq-sub">' + Math.max(0, p.hq) + '/' + p.hqMax + '</div>' +
      '<div class="hq-label">' + (owner === H ? '我方总部' : '敌方总部') + '</div>';
    return el;
  }

  // 一条阵线：**整排居中**（总部也是一张卡，跟单位一起居中），拖拽时显示落点提示
  //
  // ⚠ 关键改造：不再整排 innerHTML='' 重建。
  //   改为**按 uid 复用 DOM 节点**（diff 式）：已存在的单位卡原地更新数值与样式，
  //   这样 FLIP 才能看到"同一个节点换了位置"，从而播放滑动动画。
  //   卡牌动画（FLIP）默认开启；让位占位格/选位模式会退化为全量重建（那时不需要 FLIP）。
  function renderLine(box, owner, zone, units, H, interactive, bindUnit) {
    const st = S.state;
    box.dataset.owner = String(owner);
    let line = box.querySelector(':scope > .line-units');
    const wantSide = owner === H ? 'me' : 'foe';

    // 阵线容器本身（保持节点稳定，避免 FLIP 丢失参照）
    if (!line || line.dataset.dropZone !== zone || line.dataset.side !== wantSide) {
      if (line && line.parentNode) line.parentNode.removeChild(line);
      line = document.createElement('div');
      line.className = 'line-units';
      line.dataset.dropZone = zone;
      line.dataset.side = wantSide;
      line.dataset.owner = String(owner);
      box.appendChild(line);
    } else {
      line.dataset.owner = String(owner);
    }

    // 总部：支援线上的**一个真实位置**（`p.hqSlot`，视觉下标），像一张卡一样参与排布。
    //   初始居中（`defaultHqSlot`）；被挤动后位置由 `p.hqSlot` 记录，随重排更新。
    //   节点会被 replaceWith 换成新的（刷血量），**位置必须继承过来**。
    let hqEl = null;
    if (zone === 'support') {
      // 初始化 / 纠正：没有 hqSlot、或越界时，回到"居中"
      const p = st.players[owner];
      const nUnits = (units || []).length;
      if (p.hqSlot == null || p.hqSlot < 0 || p.hqSlot > nUnits) p.hqSlot = defaultHqSlot(owner);
      hqEl = line.querySelector(':scope > .hq-card');
      const fresh = hqCardEl(owner, H);
      // 把视觉位置印在 DOM 上：几何判定（resolveCardAt / insertionIndexAt）和
      // 测试沙箱都需要知道"总部在线上第几格"，不必再从状态里反查。
      fresh.dataset.hqSlot = String(p.hqSlot);
      if (!hqEl) { hqEl = fresh; line.appendChild(hqEl); }
      else {
        const keepRect = rectOf(hqEl);          // FLIP 需要"改前坐标"落在同一个节点上
        hqEl.replaceWith(fresh);
        hqEl = line.querySelector(':scope > .hq-card');
        if (keepRect) fresh.__flipFrom = keepRect;   // 让 FLIP 认它是"同一个卡换了位置"
      }
    } else {
      const old = line.querySelector(':scope > .hq-card');
      if (old) old.parentNode.removeChild(old);
    }

    // 普通模式：按 uid 复用节点 ──────────────────────────────
    // 这里要做三件事，缺一不可（否则阵线里会堆出上百个格子，拖拽判定被拖垮）：
    //   1) 清掉"选位模式"残留的 ＋ 插位格；
    //   2) 清掉没有卡的格子；
    //   3) **同一个 uid 只保留一个格子** —— 重复的格子全部删掉。
    //      （曾经的写法只判断"uid 是否还在场上"，同一 uid 的多份副本会全部幸存，
    //        于是每渲染一帧就多留一批旧格，几十帧后前线累积到 100+ 格。）
    const seenUid = new Set();
    Array.prototype.slice.call(line.querySelectorAll(':scope > .slot')).forEach(cell => {
      cell.classList.remove('insert-slot', 'gap', 'drop-slot');
      const card = cell.querySelector(':scope > .card[data-uid]');
      const uid = card && card.dataset.uid;
      if (!uid || seenUid.has(uid)) {                 // 无卡的格 / 重复的副本 → 删
        if (cell.parentNode) cell.parentNode.removeChild(cell);
        return;
      }
      seenUid.add(uid);
    });
    // 现有 cell：cell 的第一个子元素是 .card[data-uid]
    const cellOf = (uid) => line.querySelector(':scope > .slot > .card[data-uid="' + uid + '"]');
    const cellByUid = (uid) => { const c = cellOf(uid); return c ? c.parentNode : null; };
    const wanted = new Set();
    const seq = [];
    (units || []).forEach((u, i) => {
      wanted.add(u.uid);
      let cell = cellByUid(u.uid);
      if (!cell) {
        cell = document.createElement('div');
        cell.className = 'slot';
        cell.dataset.zone = zone;
        cell.dataset.side = line.dataset.side;
      }
      cell.dataset.slot = String(i);
      cell.dataset.owner = String(owner);
      cell.classList.remove('mine-slot', 'foe-slot');
      if (zone === 'frontline') cell.classList.add(owner === H ? 'mine-slot' : 'foe-slot');

      // 复用卡面：保留同一 DOM 节点（FLIP 需要它），只刷新内容与类名
      let el = cell.querySelector(':scope > .card');
      const fresh = unitEl(u, interactive);
      if (el) {
        el.className = fresh.className;
        el.innerHTML = fresh.innerHTML;
        el.title = fresh.title;
        // ★ 节点复用时 dataset 不会跟着 innerHTML 走：不补 id/名字，这个格子换了单位后
        //   dataset.cid 还留着上一张卡的 → 联机补图会补到错的牌上（且 onerror 显示错名字）
        el.dataset.cid = fresh.dataset.cid || '';
        el.dataset.cname = fresh.dataset.cname || '';
      } else {
        el = fresh;
        cell.appendChild(el);
      }
      if (bindUnit) bindUnit(el, u);
      seq.push(cell);
    });
    // 收尾：只保留 seq 里用到的 cell（清掉不在场上的卡、无卡的空格、以及重复副本）
    const keep = new Set(seq);
    const AN = global.KGAnim;
    Array.prototype.slice.call(line.querySelectorAll(':scope > .slot')).forEach(cell => {
      if (keep.has(cell)) return;
      // ★ 死亡动画：这个 cell 不在"要保留"名单里，且里面是一张**已不在场上的单位卡**
      //   （uid 已从 state 里消失 = 被消灭），播 die 淡出后再删，杜绝"瞬移/闪现"。
      //   仅当里面确实有卡、且那张卡不是"移到别的线"（uid 还在场上）时才算死亡。
      const card = cell.querySelector(':scope > .card[data-uid]');
      if (card && card.dataset.uid) {
        const stillAlive = st.frontline.concat(st.players[0].support, st.players[1].support)
          .some(function (u) { return String(u.uid) === card.dataset.uid; });
        if (!stillAlive && AN && AN.die) {
          cell.style.pointerEvents = 'none';                 // 死亡中不可交互
          // 单位已从 state 移除、拿不到对象 → 用**上一帧快照**还原它的兵种与防御力，
          //   死亡音效据此选材质、调音调（重单位炸得更沉）。
          const pu = (S.prev && S.prev.units) || {}, pt = (S.prev && S.prev.types) || {};
          const ghost = pt[card.dataset.uid]
            ? { unitType: pt[card.dataset.uid], defense: pu[card.dataset.uid] } : null;
          AN.die(cell, { duration: AN.ANIM ? AN.ANIM.die : 380, unit: ghost }).then(function () {
            if (cell.parentNode) cell.parentNode.removeChild(cell);
          });
          return;                                            // 不立即删，等动画播完
        }
      }
      if (cell.parentNode) cell.parentNode.removeChild(cell);
    });
    // 按顺序重排（FLIP 会把位移补成动画）。
    //
    //   ⚠ 总部的次序：**总部占支援线上的一个真实位置**（`p.hqSlot`，视觉下标）。
    //
    //   模型（关键，别再走极端）：
    //     · 支援线的**视觉线** = 单位与总部混排的一条线；其中恰好一格是总部。
    //       总部初始**居中**（`defaultHqSlot`），之后被挤动就停在原地。
    //     · 单位**可以在总部左边，也可以在总部右边** —— 这正是用户要的。
    //     · 视觉下标 ↔ 引擎单位下标的换算只在 `hqSlotOf/visualToUnitIdx/unitIdxToVisual`
    //       三个函数里，引擎侧完全不用改（`slotOf` 语义保持"0 = 最左的单位"）。
    //
    //   历史上走过的三个坑（为什么最后是这个写法）：
    //     ① 初版 `insertBefore(hq, line.firstChild)` 硬钉最左 —— 每帧重新钉，
    //        总部不参与 FLIP，新单位插进来它一动不动。
    //     ② 第四轮 `order.push(hqEl)` —— 总部跑到**最右端**：线上最右那片区域在几何上
    //        就是总部，于是"光标移到队尾空白松手"被判成"指着总部" → 部署到最左。
    //        用户："**卡牌只能往左边放**"。
    //     ③ 第七轮 `order.unshift(hqEl)` —— 又每帧钉死在第一 → 用户："**总部又变成固定第一个了**"。
    //
    //   现在：总部位置由 `p.hqSlot` 决定，`insertionIndexAt` 把总部**也数进视觉下标**，
    //         落点换算由 `visualToUnitIdx` 完成 —— 所以两侧都能插。
    const order = seq.slice();
    if (hqEl) {
      const p = st.players[owner];
      let hqPos = (p && p.hqSlot != null) ? p.hqSlot : 0;
      if (!(hqPos >= 0) || hqPos > seq.length) hqPos = defaultHqSlot(owner);
      order.splice(hqPos, 0, hqEl);
    }
    let cursor = line.firstChild;
    order.forEach((node) => {
      if (node === cursor) { cursor = node.nextSibling; return; }
      line.insertBefore(node, cursor);
    });
  }

  function renderBattle(opts) {
    opts = opts || {};
    const st = S.state;
    document.body.classList.toggle('battle-idle', !st);
    const empty = $('#battleEmpty');
    if (empty) empty.classList.toggle('hidden', !!st);
    if (!st && $('#endTurnBtn')) $('#endTurnBtn').disabled = true;
    if (!st) return;
    // ★ 原版观感·沉浸模式（2026-09-27 参考原版 KARDS 截图）：对局进行中给 body 挂 in-battle，
    //   CSS 据此把顶栏上滑、右侧面板收进右缘（都能 hover 展开），战场铺满全屏。
    //   对局结束（st.over）立即退出沉浸模式，导航条回来方便点「卡组/卡牌库」。
    document.body.classList.toggle('in-battle', !st.over);
    const H = S.humanSide || 0, A = 1 - H;
    const AN = global.KGAnim;
    // 动画开关：默认开；首帧/重开时关掉（否则会看到一堆卡"从乱七八糟的位置飞过来"）
    const animate = opts.animate !== false && S.readyForAnim !== false;
    if (animate && AN && AN.flip) {
      // FLIP：先测变更前坐标 → 执行重绘 → 反推位移 → 播放过渡。
      // 状态类（顶栏数字 / 按钮 / 提示 / 战报）同步更新，不参与位移动画。
      // 选择器含 .hq-card —— 总部现在也参与自动避让，同样要有滑动动画。
      //
      // ★ 单位卡用 **flipByUid**（按 data-uid 关联前后节点）：单位在阵线之间移动时
      //   它的 DOM 节点会被"旧线删除 + 新线新建"，普通 flip 按同一 DOM 节点做 key 会
      //   完全丢失位移 → 移动**没有任何动画**（用户反馈的"移动还是没有移动动画"）。
      //   总部卡片没有 uid，仍用普通 flip（它在同一条线内换位置，节点是复用的）。
      const dur = (AN.ANIM && AN.ANIM.move) || 360;
      // ⚠ animateDiff 必须在**同一帧**里调用：它做的是"新进场/移动/掉血"的差集判定，
      //   以前它只在非 FLIP 路径被调用 → 有 FLIP 时**拍桌/平移落地动画永远不会播**
      //   （用户看到的"部署没有动画"就是这个原因）。这里在 mutate 之后立刻补上。
      let p = null;
      if (AN.flipByUid) {
        // 单位卡按 uid、总部卡按 hq 关联（key 按顺序回退），一次 mutate 完成。
        // ★ arc:true → 跨阵线移动（支援线 ↔ 前线）走**弧线关键帧**，平滑滑过去而不是硬平移。
        p = AN.flipByUid('.card[data-uid], .hq-card', () => { paintBattle(opts); animateDiff(st); },
          { duration: dur, key: ['uid', 'hq'], arc: true });
      } else {
        p = AN.flip('.card[data-uid], .hq-card', () => { paintBattle(opts); animateDiff(st); }, { duration: dur });
      }
      void p;   // 位移播放是"后台进行"的，这里不阻塞后续状态刷新
      paintBattleStatus(st, H, A);
      renderLog();
      renderPrompt();
      if (S.fitBoardScale) S.fitBoardScale();   // 手机：内容超了就整体缩到刚好铺满（不出滚动条）
      if (S.fitFrontCards) S.fitFrontCards();   // 阵线卡宽自适应（平板/桌面：卡少放大、满线收缩）
      if (st.over) {
        const iWon = st.winner === H;
        const txt = st.winner === -1 ? '平局' : (iWon ? '🎉 你赢了！' : '💀 你输了');
        toast(txt + '（点"重开"再来一局）', 6000);
      }
      return;
    }
    paintBattle(opts);
    paintBattleStatus(st, H, A);
    renderLog();
    renderPrompt();
    animateDiff(st);
    if (S.fitBoardScale) S.fitBoardScale();     // 手机：内容超了就整体缩到刚好铺满（不出滚动条）
    if (S.fitFrontCards) S.fitFrontCards();     // 阵线卡宽自适应（平板/桌面：卡少放大、满线收缩）
    if (st.over) {
      const iWon = st.winner === H;
      const txt = st.winner === -1 ? '平局' : (iWon ? '🎉 你赢了！' : '💀 你输了');
      toast(txt + '（点"重开"再来一局）', 6000);
    }
  }

  // 情报明牌：把对手手牌里被"探明"的牌摆成一条小卡带（原版里明牌是对面手牌上盖着看的）
  function renderFoeRevealed(st, A) {
    const box = $('#foeRevealed');
    if (!box) return;
    const foe = st.players[A] || {};
    const rev = (foe.hand || []).filter(function (i) { return i && i.revealed; });
    const sig = rev.map(function (i) { return i.id; }).join(',');
    if (sig === (S._foeRevSig || '')) return;      // 没变化就不重建（保住正在播的动画）
    const firstTime = (S._foeRevSig || '') === '' && sig !== '';
    S._foeRevSig = sig;
    box.innerHTML = '';
    if (!rev.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    rev.slice(0, 8).forEach(function (inst) {
      const el = cardEl(KG.cardDef(st, inst.id));
      el.classList.add('revealed-mini');
      box.appendChild(el);
    });
    const AN = global.KGAnim;
    if (firstTime && AN && AN.intelScan) AN.intelScan(box);
  }

  // 只更新"非棋盘"的状态显示（顶栏数字、按钮、回合标签）
  function paintBattleStatus(st, H, A) {
    const me = st.players[H], foe = st.players[A];
    $('#myKredits').textContent = me.kredits;
    $('#mySlots').textContent = me.maxKredits;
    // ★ 原版那种"一排指挥点方片"：亮起 = 本回合可用（当前指挥点），总数 = 上限
    (function () {
      const pips = $('#myKreditPips');
      const cur = Math.max(0, me.kredits | 0), cap = Math.max(0, me.maxKredits | 0);
      if (pips && (pips.__cur !== cur || pips.__cap !== cap)) {
        pips.__cur = cur; pips.__cap = cap;
        let html = '';
        for (let i = 0; i < cap; i++) html += '<i class="' + (i < cur ? 'on' : '') + '"></i>';
        pips.innerHTML = html;
      }
      // ★ 原版规格（2026-09-22）：上面是**当前指挥点**（CSS 里自动补 "K"），
      //   下面那行小字 = **指挥点槽**（不再写成 "/N"）
      const num = $('#myKreditNum'), capEl = $('#myKreditCap');
      if (num) num.textContent = cur;
      if (capEl) capEl.textContent = cap;
    })();
    $('#myDeck').textContent = me.deck.length;
    $('#myDiscard').textContent = me.discard.length;
    $('#myCounters').textContent = (me.counters || []).length;
    // ★ 对手指挥点：同样按原版规格（大数字K + 下面小字槽数）—— **友方也能看到对手的指挥点槽**
    {
      const foeNum = $('#foeKreditNum'), foeCap = $('#foeKreditCap');
      if (foeNum) foeNum.textContent = Math.max(0, foe.kredits | 0);
      else { const legacy = $('#foeKredits'); if (legacy) legacy.textContent = foe.kredits; }
      if (foeCap) foeCap.textContent = Math.max(0, foe.maxKredits | 0);
    }
    $('#foeHand').textContent = foe.hand.length;
    $('#foeDeck').textContent = foe.deck.length;
    $('#foeCounters').textContent = (foe.counters || []).length;
    const turnLabel = $('#turnLabel');
    turnLabel.textContent = '第 ' + st.turn + ' 回合 · ' + (st.active === H ? '你的回合' : '对手回合') + mpTurnSuffix(st, H);
    turnLabel.classList.toggle('is-mine', st.active === H && !st.over);
    turnLabel.classList.toggle('is-foe', st.active !== H && !st.over);
    turnLabel.classList.toggle('is-over', !!st.over);
    const myTurn = st.active === H && !st.over;
    $('#endTurnBtn').disabled = !myTurn || st.phase !== 'play' || !!S.pending;
    if (isMobileUI()) {
      const backs=$('#mobileFoeHand'),count=foe.hand.length;
      if (backs && backs.dataset.count !== String(count)) {
        backs.dataset.count=String(count);backs.setAttribute('aria-label','对手手牌 '+count+' 张');
        backs.innerHTML=Array.from({length:Math.min(count,8)},(_,i)=>'<i style="--back-r:'+((i-(Math.min(count,8)-1)/2)*5)+'deg"></i>').join('');
      }
      const deckCount=$('#mobileDeckCount');
      if (deckCount) deckCount.innerHTML=me.deck.length+'<small>牌库</small>';
    }
    $('#endTurnBtn').textContent = st.over ? '对局结束' : (S.pending ? '等待选择' : (myTurn ? '结束回合' : '等待对手'));
    renderFoeRevealed(st, A);
  }

  function paintBattle(opts) {
    // 清掉旧界面遗留的点击操作状态，避免恢复后再次进入已删除的模式。
    delete S.handPick;delete S.selection;document.body.classList.remove('place-mode');
    opts = opts || {};
    const st = S.state;
    if (!st) return;
    const H = S.humanSide || 0, A = 1 - H;
    const me = st.players[H], foe = st.players[A];
    $('#turnLabel').textContent = '第 ' + st.turn + ' 回合 · ' + (st.active === H ? '你的回合' : '对手回合') + mpTurnSuffix(st, H);

    const myTurn = st.active === H && !st.over;
    // ★ 准备阶段（mulligan）**与回合无关**：双方各自独立换牌，后手也要能点牌。
    //   ⚠ myTurn 只看 st.active，而 mulligan 期间 active 恒为先手(0) →
    //     人类是后手时 myTurn 为假 → 手牌的 click **压根没绑上** → 点牌毫无反应。
    //     （只改 onMulliganClick 内部条件是没用的：请求根本走不到那里。）
    const myMulligan = st.phase === 'mulligan' && !st.over
      && !(st.mulligan && st.mulligan.done[H]);
    // 手牌可交互 = 自己回合，或准备阶段尚未确认
    const handInteractive = myTurn || myMulligan;
    $('#endTurnBtn').disabled = !myTurn || !!S.pending;

    const markTargets = S.pending && S.pending.req && S.pending.req.kind === 'target';
    const targetable = new Set(markTargets ? (S.pending.req.options || []).map(o => String(o.value)) : []);

    // 点击只处理效果目标；pointerdown 每次替换，复用卡牌节点不累积旧操作。
    const bindUnit = (el,u) => {
      const mine=u.owner===H,canActNow=mine&&u.canAct&&u.actionsLeft>0&&myTurn&&!S.pending;
      el.removeAttribute('data-tap-default');el.onclick=null;
      if(targetable.has(u.uid)){
        el.classList.add('targetable');el.setAttribute('data-tap-default','1');
        el.onclick=ev=>{ev.stopPropagation();resolvePending(u.uid);};
      }
      el.style.cursor=canActNow?'grab':'default';
      el.onpointerdown=canActNow?ev=>beginCardDrag(ev,{kind:'unit',uid:u.uid},el,u.def):null;
    };

    renderLine($('#mySupport'), H, 'support', me.support, H, myTurn, bindUnit);
    renderLine($('#foeSupport'), A, 'support', foe.support, H, false, bindUnit);

    // 前线：双方共抢的一条线（按 state.frontline 原始顺序混排，我方/敌方单位用 CSS 区分）
    // 同样按 uid 复用节点 —— 单位"走上前线"才会有 FLIP 滑动动画。
    const fl = st.frontline || [];
    const flMine = fl.filter(u => u.owner === H);
    const flFoe = fl.filter(u => u.owner !== H);
    const flBox = $('#frontline');
    let flLine = flBox.querySelector(':scope > .line-units');
    const flFoeOnLine = flFoe.length > 0;
    if (!flLine) {
      flLine = document.createElement('div');
      flLine.className = 'line-units fl-common';
      flLine.dataset.dropZone = 'frontline';
      flLine.dataset.side = 'me';
      flBox.appendChild(flLine);
    }
    // 前线归属：只有**由我方独占**时才允许插位避让；线上有敌方单位就标 foe（不避让，防挤动）
    flLine.dataset.owner = flFoeOnLine ? String(A) : String(H);

    const cellOf = (uid) => flLine.querySelector(':scope > .slot > .card[data-uid="' + uid + '"]');
    {
      // 普通模式：按 uid 复用节点 ──────────────────────────────
      // 同支援线：清插位格 / 清空格子 / **同 uid 只留一份**（防累积）
      const seenUidFl = new Set();
      Array.prototype.slice.call(flLine.querySelectorAll(':scope > .slot')).forEach(cell => {
        cell.classList.remove('insert-slot', 'gap', 'drop-slot');
        const card = cell.querySelector(':scope > .card[data-uid]');
        const uid = card && card.dataset.uid;
        if (!uid || seenUidFl.has(uid)) {
          if (cell.parentNode) cell.parentNode.removeChild(cell);
          return;
        }
        seenUidFl.add(uid);
      });
      const wanted = new Set();
      const seq = [];
      let mySlot = 0;
      fl.forEach(u => {
        const isMine = u.owner === H;
        wanted.add(u.uid);
        let card = cellOf(u.uid);
        let cell = card ? card.parentNode : null;
        if (!cell) {
          cell = document.createElement('div');
          cell.className = 'slot';
          cell.dataset.zone = 'frontline';
        }
        cell.dataset.slot = isMine ? String(mySlot) : 'foe';
        cell.dataset.side = isMine ? 'me' : 'foe';
        cell.classList.remove('mine-slot', 'foe-slot');
        cell.classList.add(isMine ? 'mine-slot' : 'foe-slot');
        const fresh = unitEl(u, isMine ? myTurn : false);
        if (card) {
          card.className = fresh.className;
          card.innerHTML = fresh.innerHTML;
          card.title = fresh.title;
          card.dataset.cid = fresh.dataset.cid || '';      // 同上：dataset 不跟 innerHTML 走
          card.dataset.cname = fresh.dataset.cname || '';
        } else {
          card = fresh;
          cell.appendChild(card);
        }
        if (bindUnit) bindUnit(card, u);
        seq.push(cell);
        if (isMine) mySlot++;
      });
      // 收尾：清掉"不在场上"的格子（含无卡的空格，以及刚才没被复用的重复副本）。
      // 只保留 seq 里用到的那些 cell —— 这样无论前面漏了什么，最后都会归一到"每 uid 一格"。
      const keep = new Set(seq);
      Array.prototype.slice.call(flLine.querySelectorAll(':scope > .slot')).forEach(cell => {
        if (keep.has(cell)) return;
        if (cell.parentNode) cell.parentNode.removeChild(cell);
      });
      let cursor = flLine.firstChild;
      seq.forEach(cell => {
        if (cell === cursor) { cursor = cell.nextSibling; return; }
        flLine.insertBefore(cell, cursor);
      });
    }
    $('#flCount').textContent = flMine.length;
    $('#flMax').textContent = KG.RULES.frontlineMax;
    const ctl = flMine.length && !flFoe.length ? 1 : (flFoe.length && !flMine.length ? -1 : 0);
    const ctlEl = $('#flControl');
    ctlEl.className = 'fl-control ' + (ctl === 1 ? 'mine' : ctl === -1 ? 'foe' : '');
    ctlEl.textContent = (ctl === 1 ? '你控制前线' : ctl === -1 ? '对手占据前线（先打掉他的前线单位）' : (fl.length ? '争夺中' : '空')) +
      '（你 ' + flMine.length + ' / 对手 ' + flFoe.length + '）';

    // 总部仅在卡牌效果要求选择目标时接受点击。
    [[H, '#myHq'], [A, '#foeHq']].forEach(([owner, sel]) => {
      const el = $(sel);
      if (!el) return;
      const key = 'hq' + owner;
      if (targetable.has(key)) {
        el.classList.add('targetable');
        el.onclick = () => resolvePending(key);
      } else {
        el.onclick = null;
      }
    });

    // 手牌
    const hand = $('#myHand');
    // ★ 新增手牌检测：按**实例 uid 集合**对比上一帧，找出**任何位置**的新增牌。
    //   旧写法只认"新增牌追加在末尾"（handSig 前缀匹配）——而效果加入手牌走的是
    //   `hand.unshift`（插到最前），指令/单位效果的"抽一张牌""将X加入手牌"因此
    //   **永远检测不到、没有动画**（制作者 2026-09-22 报）。uid 比对与位置无关。
    const prevUids = S._prevHandUids || [];
    const handInsts = me.hand || [];
    const curUids = handInsts.map(inst => inst.uid);
    const addedIdx = [];
    if (prevUids.length) {
      const prevSet = new Set(prevUids);
      curUids.forEach((u, i) => { if (u && !prevSet.has(u)) addedIdx.push(i); });
    }
    S._prevHandUids = curUids;
    hand.innerHTML = '';
    // ⚠ 「从敌方三张手牌中选择一张」的 owner 是**对手**：那种请求不能把我自己的手牌标成可点选
    //   （索引会撞上，点我的手牌就选错牌了）。它走提示栏里的候选按钮。
    const handPickReq = (S.pending && S.pending.req && S.pending.req.from === 'hand' &&
      (S.pending.req.owner == null || S.pending.req.owner === H)) ? S.pending.req : null;
    const pickable = new Set(handPickReq ? (handPickReq.options || []).map(o => String(o.value)) : []);
    me.hand.forEach((inst, i) => {
      const c = KG.cardDef(st, inst.id);
      const chk = KG.canPlayCard(st, H, i);
      const cost = KG.instCost(st, H, inst, c);
      const isPick = pickable.has(String(i));
      const isSusp = !!inst.suspended;                       // 挂起反制：留在手上、可取消
      // ★ 准备阶段：选中的"待替换"牌高亮
      const isMulliganPick = st.phase === 'mulligan' && S.mulliganPicks && S.mulliganPicks.has(i);
      let cls;
      if (isMulliganPick) {
        cls = 'selected';
      } else if (isSusp) {
        // 挂起态：仅自己回合允许拖拽取消挂起
        cls = 'suspended' + (myTurn ? ' selectable' : ' inactive');
      } else if (isPick) {
        cls = 'targetable';
      } else if (myMulligan) {
        // 准备阶段：牌不能"打出"，但要看起来**可以点**（换牌用）
        cls = 'selectable';
      } else {
        cls = (myTurn && chk.ok ? 'playable selectable' : 'exhausted');
      }
      const el = cardEl(Object.assign({}, c, { cost: cost }), { inst: i, cls: cls });

      const mob = isMobileUI();
      if (isPick) {
        el.title = '点击选择这张手牌';
        el.addEventListener('click', () => resolvePending(i));
        if (mob) el.setAttribute('data-tap-default', '1');
      } else if (isSusp) {
        // 挂起牌：向上拖出 = 取消挂起并返还指挥点。
        if (myTurn && !S.pending) {
          el.title = '向上拖动取消挂起并返还指挥点';
          el.style.cursor = 'grab';
          el.addEventListener('pointerdown', ev => beginCardDrag(ev, { kind: 'unsuspend', index: i }, el, c));
        } else {
          el.title = '已挂起，等待敌方回合触发（敌方回合中无法操作）';
        }
      } else if (myTurn && S.pending) {
        // 正在等待选择时，别的牌不可点
      } else if (handInteractive) {
        if (myMulligan) {
          el.setAttribute('data-tap-default', '1');
          el.title = '点击标记或取消替换';
          if (mob) {
            const toggle = document.createElement('button');
            toggle.type = 'button';toggle.className = 'card-action mulligan-toggle';
            toggle.textContent = isMulliganPick ? '✓' : '换';
            toggle.setAttribute('aria-label', isMulliganPick ? '取消替换标记' : '标记为待替换');
            toggle.addEventListener('click', ev => {ev.preventDefault();ev.stopPropagation();onMulliganClick(i);});
            el.appendChild(toggle);
          }
          el.addEventListener('click',()=>onMulliganClick(i));
        } else {
          el.title = c.cardType === 'counter' ? '向上拖动以挂起反制；点击查看详情' : '拖拽打出；点击查看详情';
          el.style.cursor = chk.ok ? 'grab' : 'default';
        }
        if (chk.ok && myTurn && !myMulligan) el.addEventListener('pointerdown',ev=>beginCardDrag(ev,{kind:'hand',index:i},el,c));
      }
      hand.appendChild(el);
    });

    // ★ 进手动画（制作者口径）：**抽牌和"加入手牌"同款** —— 都是从手牌区最右边
    //   平滑滑进它在手牌里的位置（一次多张时错开 70ms）。不再从牌库飞。
    //   ⚠ S._skipHandSlide：开发/抉择已经播了"从选择界面飞到手牌"的飞行动画，
    //     这一帧就不再重复播滑入（两套动画叠一起会打架）。一次性标记，用完即清。
    if (addedIdx.length && hand.children.length && !S._skipHandSlide) {
      const AN2 = global.KGAnim;
      addedIdx.forEach((idx, k) => {
        const el2 = hand.children[idx];
        if (el2 && AN2 && AN2.slideInFromRight) {
          (function (node, delay) { setTimeout(function () { AN2.slideInFromRight(node, hand); }, delay); })(el2, k * 70);
        }
      });
    }
    S._skipHandSlide = false;

    layoutHandFan();
    animateDiff(st);
    // ★ 引擎记下的"非对战伤害"演出（单位效果 / 指令 / 疲劳）：交给 UI 播冲刺 + 命中 + 飘伤害
    playFxPops(st, opts.animate !== false && S.readyForAnim !== false);
  }

  /* ★ 原版观感：手牌扇形（2026-09-27 参考原版 KARDS 截图）。
   * 每张手牌写 --fan-r（外倾旋转）/ --fan-y（边缘下沉），姿态由 CSS 应用（body.in-battle 下）。
   * 角度封顶 ±7°，手牌多时只压低弧度不出屏。hover / pressing 的 CSS 变换会带上同款基础姿态。
   * 不在沉浸模式（如重开后的导航态）时清掉变量，避免残留。 */
  function layoutHandFan() {
    const hand = $('#myHand');
    if (!hand) return;
    const cards = hand.children;
    const n = cards.length;
    if (isMobileUI() && n && S.state && S.state.phase !== 'mulligan') {
      const width=cards[0].offsetWidth||96;
      const step=n>1?Math.min(58,Math.max(18,(hand.clientWidth-width-12)/(n-1))):width;
      hand.style.setProperty('--hand-overlap',Math.max(0,width-step)+'px');
    } else hand.style.removeProperty('--hand-overlap');
    if (!n || !document.body.classList.contains('in-battle')) {
      for (let i = 0; i < cards.length; i++) {
        cards[i].style.removeProperty('--fan-r');
        cards[i].style.removeProperty('--fan-y');
      }
      return;
    }
    const mid = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      const off = i - mid;
      const r = Math.max(-7, Math.min(7, off * 1.9));
      const y = Math.abs(off) * 5.5;
      cards[i].style.setProperty('--fan-r', r.toFixed(2) + 'deg');
      cards[i].style.setProperty('--fan-y', y.toFixed(1) + 'px');
    }
  }

  function renderLog() {
    const box = $('#battleLog');
    if (!box) return;
    // ★ 联机不显示战报：state.log 是双方共用的一份，里面有"情报看到了对手哪张手牌"
    //   这类私有信息 —— 显示出来就等于免费送给对手看。单机才渲染。
    if (S.mode === 'lan' || !S.state) { box.innerHTML = ''; return; }
    box.innerHTML = S.state.log.slice(-120).map(l => '<div class="k-' + l.kind + '">' + l.text + '</div>').join('');
    box.scrollTop = box.scrollHeight;
  }

  function renderPrompt() {
    const p = $('#prompt');
    // ★ 选卡面板居中（原版观感 2026-09-27）：有 pending 且**不是**棋盘目标（点场上单位/总部）
    //   也**不是**手牌选择（点手牌本身）→ body.picking-center，CSS 把面板挪到屏幕正中。
    //   renderBattle 每次状态变化都会调到这里，class 的挂/摘全由本函数统一负责。
    const _req = S.pending && S.pending.req;
    const _opts = (_req && _req.options) || [];
    const _boardTgt = _opts.some(o => o && (o.kind === 'unit' || o.kind === 'hq'));
    const _handPick = _req && _req.from === 'hand';
    document.body.classList.toggle('picking-center', !!(_req && !_boardTgt && !_handPick));
    // ★ 选卡面板弹出时收掉开着的全屏检视（手机 z88 黑幕会盖住选卡面板 z41，
    //   用户上一击点开的手牌详情不能挡住这一轮抉择）
    if (_req) {
      hideTip();
      if (isMobileUI()) document.body.classList.remove('nav-open', 'side-open');
    }
    if (isMobileUI() && S.fitBoardScale) requestAnimationFrame(function () { S.fitBoardScale(true); });
    if (S.pending) {
      const req = S.pending.req;
      const opts = req.options || [];
      // 非棋盘目标（例如"选一张手牌"）→ 直接列按钮；棋盘目标靠点击场上单位/总部
      const boardTarget = opts.some(o => o && (o.kind === 'unit' || o.kind === 'hq'));
      let extra = '';
      if (!boardTarget && opts.length) {
        extra = opts.slice(0, 24).map((o, i) => '<button class="ghost" data-pick="' + i + '">' + o.label + '</button>').join('');
      }
      // ★ 开发/选牌：**只要能解析出卡定义就渲染完整小卡面**（cardEl 自带悬停详情）。
      //   以前只有"有美术图的卡"才显示卡面，纯文字卡（无 art 字段）只剩一个孤零零的文字按钮。
      //   ⚠ 必须用 DOM 方式插入 cardEl —— outerHTML 字符串化会丢掉 mouseenter 悬停事件绑定。
      //   ⚠⚠ 只有 **字符串 id 且池里真有这张卡** 才渲染卡面：
      //     a) cardDef 查不到会返回**假卡兜底**（{name:id,...}），永远不返回 null —— 直接信它
      //        会给"选项索引 0/1"渲染出两张不相干的卡面（二选一显示"空白+补给"就是这么来的）；
      //     b) value 是数字 = 手牌索引/选项索引，不是卡 id，同样不能查。
      const poolFind = (v) => {
        if (typeof v !== 'string' || !v) return null;
        return (S.state && S.state.pool && S.state.pool[v]) || (KG.pool && KG.pool[v]) || null;
      };
      // 按卡名反查（研发/抉择的选项可能只写了名字）。同名卡取首个匹配。
      const poolByName = (nm) => {
        if (!nm) return null;
        const src = (S.state && S.state.pool) || KG.pool || {};
        const k = Object.keys(src).find(function (kk) { return (src[kk] || {}).name === nm; });
        return k ? src[k] : null;
      };
      // 选项 → 卡定义（返回 null 表示"这项没有可显示的卡"，走纯文字兜底）
      //   ① 选项本身是卡 id 字符串（开发/选牌类）
      //   ② option.cardId / option.cardName —— 引擎在 chooseOne 里带出的"这个选项给你哪张卡"（研发/抉择）
      //   ③ option.value 是字符串卡 id
      //   ⚠ 一律**直查卡池**，不走 KG.cardDef（它有假卡兜底、永不返回 null）；
      //     数字（手牌索引/选项索引）必须返回 null，否则会渲染出不相干的卡面。
      const optDef = (o) => {
        if (!o) return null;
        if (typeof o === 'string') return poolFind(o);
        if (o.cardId) return poolFind(o.cardId);
        if (o.cardName) return poolByName(o.cardName);
        if (typeof o.value === 'string') return poolFind(o.value);
        return null;
      };
      const pickGrid = document.createElement('div');
      pickGrid.className = 'pick-grid';
      let hasPick = false;
      // ★ 选中第 i 个选项（统一入口）：从被点的卡面平滑飞到手牌区，再 resolve。
      //   「开发/抉择：选中的卡从选择界面平滑飞到手牌区域」（制作者 2026-09-22 口径）；
      //   飞行期间置 S._skipHandSlide：这一帧不再重复播"滑入"（两套动画会打架）。
      const pickOption = (i, sourceEl) => {
        const o = S.pending.req.options[i];
        try {
          const ANp = global.KGAnim;
          const handEl = $('#myHand');
          if (ANp && ANp.flyFromEl && handEl) { S._skipHandSlide = true; ANp.flyFromEl(sourceEl, handEl, {}); }
        } catch (e) { }
        resolvePending(o.value);
      };
      if (!boardTarget && opts.length) {
        opts.slice(0, 12).forEach((o, i) => {
          const dd = optDef(o);
          const b = document.createElement('div');
          b.className = 'ghost pick';
          if (dd) {
            // ★ 选卡面板 = 换牌同款（制作者 2026-09-27）：**大卡、无边框盒、无按钮无标签，
            //   点卡面本身即选中**（hover 抬升+金边）。悬停详情由 cardEl 自带。
            b.classList.add('has-card');
            const ce = cardEl(dd);
            // ★ 手机：这一击已被 pickOption 占用（点卡=选中）——打上 data-tap-default
            //   让 bindTipTap 让位。否则点候选卡会**同时**弹 z88 全屏检视（黑幕盖屏，
            //   看起来像"点了没反应/被黑幕吞了"），选择却在黑幕后面静默完成了。
            ce.setAttribute('data-tap-default', '1');
            b.appendChild(ce);
            hasPick = true;
            b.addEventListener('click', () => pickOption(i, ce));
          } else {
            const sp = document.createElement('span');
            sp.textContent = o.label;                       // 解析不出卡定义的兜底（纯文字）
            b.appendChild(sp);
          }
          // 卡面选项不再挂 label / 「选择」按钮（点卡即选）；纯文字兜底仍走按钮路径
          if (!dd) {
            const lab = document.createElement('span');
            lab.className = 'pick-label';
            lab.textContent = o.label;
            b.appendChild(lab);
            const choose = document.createElement('button');
            choose.type = 'button';
            choose.className = 'ghost small pick-select';
            choose.dataset.pick = String(i);
            choose.textContent = '选择';
            b.appendChild(choose);
          }
          pickGrid.appendChild(b);
        });
      }
      // ★ 先把「提示文字 + 兜底文字按钮」用**字符串**拼好，再 append 取消按钮；
      //   有卡面时把 pickGrid 单次插到取消按钮之前。
      //   ⚠ 别用 `while (tmp.firstChild) p.insertBefore(...)` 搬 DOM 节点 ——
      //     沙箱（uitest 的迷你 DOM）的 insertBefore **不把节点从源容器摘除**，
      //     tmp.firstChild 永远不为空 → **死循环**，整轮测试卡死（排查了很久）。
      p.innerHTML = '<div>' + (req.prompt || '请选择') + '</div>' + (hasPick ? '' : extra) +
        '<button class="ghost" data-cancel="1">取消</button>';
      if (hasPick) p.insertBefore(pickGrid, p.querySelector('[data-cancel]'));
      // ★ 有卡面网格 → 面板"素面"化（换牌同款）：CSS 摘掉面板背景/边框，卡直接浮在暗化遮罩上
      p.classList.toggle('pick-plain', hasPick);
      const wasHidden = p.classList.contains('hidden');
      p.classList.remove('hidden');
      if (wasHidden) { p.classList.remove('prompt-in'); void p.offsetWidth; p.classList.add('prompt-in'); }
      p.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
        pickOption(parseInt(b.dataset.pick, 10), b);
      }));
    } else {
      p.classList.add('hidden');
      p.innerHTML = '';
    }
    const c = p.querySelector('[data-cancel]');
    if (c) c.addEventListener('click', () => cancelPending());
  }

  /* --------------------------------------------------- 出牌（含目标选择） */
  function uiChooser() {
    return function (req) {
      if (req.kind === 'target') {
        if (!req.options || !req.options.length) return Promise.resolve(null);
        // 拖到目标身上时预置的选择：如果它在候选里就直接生效
        if (S.preTarget != null) {
          const hit = req.options.find(o => String(o.value) === String(S.preTarget));
          if (hit) { S.preTarget = null; return Promise.resolve(hit.value); }
        }
        return new Promise(resolve => {
          S.pending = { req: req, resolve: resolve };
          renderBattle();
        });
      }
      // 抉择 / 开发 / 其它：直接弹按钮
      return new Promise(resolve => {
        S.pending = { req: req, resolve: resolve };
        renderBattle();
      });
    };
  }

  function resolvePending(value) {
    if (!S.pending) return;
    const p = S.pending; S.pending = null;
    p.resolve(value);
    setTimeout(() => renderBattle(), 30);
  }

  function cancelPending() {
    if (!S.pending) return;
    const p = S.pending; S.pending = null;
    p.resolve(null);
    toast('已取消选择');
    setTimeout(() => renderBattle(), 30);
  }

  /* ★ 换牌 FLIP（原版观感 2026-09-27）：确认换牌前后各抓一次手牌卡位姿，
   *   保留的牌按 uid 对齐做"中间大图 → 底部手牌区"的平滑过渡；
   *   换进来的新牌交给既有 drawn-in 滑入动画，不叠加。 */
  function captureHandRects() {
    const st = S.state; if (!st) return null;
    const H = S.humanSide || 0;
    const hand = (st.players[H] && st.players[H].hand) || [];
    const out = {};
    hand.forEach(function (inst, i) {
      if (!inst || !inst.uid) return;
      const el = document.querySelector('#myHand > .card[data-inst="' + i + '"]');
      if (!el) return;
      const r = el.getBoundingClientRect();
      out[inst.uid] = { l: r.left, t: r.top, w: r.width, h: r.height };
    });
    return out;
  }
  function flyHandToBar(prev) {
    if (!prev) return;
    const st = S.state; if (!st) return;
    const H = S.humanSide || 0;
    const hand = (st.players[H] && st.players[H].hand) || [];
    hand.forEach(function (inst, i) {
      const el = document.querySelector('#myHand > .card[data-inst="' + i + '"]');
      if (!el || typeof el.animate !== 'function') return;
      const old = prev[inst.uid];
      if (!old) return;                                    // 新换进的牌：走 drawn-in
      const r = el.getBoundingClientRect();
      const dx = (old.l + old.w / 2) - (r.left + r.width / 2);
      const dy = (old.t + old.h / 2) - (r.top + r.height / 2);
      const sx = old.w / Math.max(1, r.width), sy = old.h / Math.max(1, r.height);
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2 && Math.abs(sx - 1) < 0.02) return;
      el.animate([
        { transform: 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + sx.toFixed(3) + ',' + sy.toFixed(3) + ')' },
        { transform: 'none' }
      ], { duration: 500, easing: 'cubic-bezier(.2,.8,.3,1)' });
    });
  }

  // ★ 准备阶段（mulligan）UI：显示/隐藏提示条 + 更新提示文字
  //   同时 toggle body.mulligan-phase：CSS 据此把手牌放大并提到屏幕中间（原版观感）。
  //   ⚠ 2026-10-02：真机反馈"换牌还是没居中" —— CSS 补丁③在部分 WebView 上可能整条
  //   失效（min()/嵌套 calc() 兼容风险）。这里补一层 **JS 兜底**：直接把 .hand 写成
  //   fixed + flex 居中，宽度按视口夹紧。CSS 生效时两者等价；CSS 失效时靠它保命。
  function applyMulliganLayout(on) {
    const hand = document.querySelector('#myHand');
    const bar = $('#mulliganBar');
    if (!hand) return;
    if (!on) {
      ['position', 'left', 'right', 'top', 'bottom', 'transform', 'height',
        'padding', 'margin', 'gap', 'justify-content', 'z-index'].forEach(function (k) {
          hand.style.removeProperty(k);
        });
      for (let i = 0; i < hand.children.length; i++) {
        ['width', 'height', 'margin-left', 'margin-right', 'flex'].forEach(function (k) {
          hand.children[i].style.removeProperty(k);
        });
      }
      if (bar) {
        ['position', 'left', 'right', 'bottom', 'transform'].forEach(function (k) {
          bar.style.removeProperty(k);
        });
      }
      return;
    }
    const n = Math.max(1, hand.children.length);
    const vw = window.innerWidth || 844, vh = window.innerHeight || 390;
    // n 张牌 + 间隙必须**严格**塞进视口宽度：算式减掉左右各 12px 安全边 + 间隙。
    // 用 !important 压过 CSS（CSS 里 .hand>.card 有负 margin 叠放，会把牌挤出容器）。
    const gap = 8, pad = 12;
    const cw = Math.max(56, Math.min(116, Math.floor((vw - pad * 2 - gap * (n - 1)) / n)));
    const portrait = vh > vw;
    hand.style.setProperty('position', 'fixed', 'important');
    hand.style.setProperty('left', '0', 'important');
    hand.style.setProperty('right', '0', 'important');
    hand.style.setProperty('bottom', Math.round(vh * (portrait ? 0.30 : 0.40)) + 'px', 'important');
    hand.style.setProperty('transform', 'none', 'important');
    hand.style.setProperty('height', 'auto', 'important');
    hand.style.setProperty('padding', '0', 'important');
    hand.style.setProperty('margin', '0', 'important');
    hand.style.setProperty('gap', gap + 'px', 'important');
    hand.style.setProperty('justify-content', 'center', 'important');
    hand.style.setProperty('z-index', '6', 'important');
    for (let i = 0; i < hand.children.length; i++) {
      const c = hand.children[i];
      c.style.setProperty('width', cw + 'px', 'important');
      c.style.setProperty('height', Math.round(cw * 1.4) + 'px', 'important');
      c.style.setProperty('margin-left', '0', 'important');
      c.style.setProperty('margin-right', '0', 'important');
      c.style.setProperty('flex', '0 0 auto', 'important');
    }
    if (bar) {
      bar.style.setProperty('position', 'fixed', 'important');
      bar.style.setProperty('left', '50%', 'important');
      bar.style.setProperty('right', 'auto', 'important');
      bar.style.setProperty('bottom', Math.round(vh * 0.12) + 'px', 'important');
      bar.style.setProperty('transform', 'translateX(-50%)', 'important');
    }
  }

  function renderMulligan() {
    const st = S.state;
    const bar = $('#mulliganBar');
    if (!bar) return;
    const inMulligan = st && st.phase === 'mulligan';
    document.body.classList.toggle('mulligan-phase', !!inMulligan);
    applyMulliganLayout(!!inMulligan);
    if (!inMulligan) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const msg = $('#mulliganMsg');
    const n = S.mulliganPicks ? S.mulliganPicks.size : 0;
    if (msg) msg.textContent = n ? ('已选 ' + n + ' 张待替换，确认后替换并重抽')
      : '准备阶段：点击要替换的牌（可多选），然后确认';
  }

  // ★ 准备阶段确认：替换选中的牌，并完成自己的 mulligan（**只能进行一次**）；随后 AI 也确认并开局
  async function confirmMulligan() {
    const H = S.humanSide || 0;
    const st = S.state;
    if (!st || st.phase !== 'mulligan') return;
    if (st.mulligan && st.mulligan.done[H]) return;          // 已确认过，不能重复
    // ★ 联机：不能只确认自己 —— 换牌要洗牌（消耗 rng），必须等两边都给了选择，
    //   再按"0 号先、1 号后"的固定顺序在两边同时结算，否则牌库顺序会不一样。
    if (MP.on && mpNet()) {
      MP.myPicks = S.mulliganPicks ? Array.from(S.mulliganPicks) : [];
      mpNet().relay({ t: 'mulligan', picks: MP.myPicks });
      if (MP.peerPicks == null) toast('已确认换牌，等对方确认…', 2000);
      mpMulliganBarrier();
      return;
    }
    const picks = S.mulliganPicks ? Array.from(S.mulliganPicks) : [];
    if (picks.length) {
      KG.mulliganReplace(st, H, picks);                      // 换牌（这一次）
      S.mulliganPicks = new Set();
    }
    KG.mulliganDone(st, H);
    // ★ AI 默认不换牌：人类确认后立即让 AI 也确认，推动 phase → play（否则会卡在准备阶段）
    if (st.phase === 'mulligan') {
      KG.mulliganDone(st, 1 - H);
    }
    S.mulliganPicks = new Set();
    const prevRects = captureHandRects();                    // 重绘前：手牌还在中间大图形态
    renderBattle();
    flyHandToBar(prevRects);                                 // 重绘后：FLIP 平滑落回手牌区
    renderMulligan();
    if (st.phase === 'play') {
      // 双方都确认了，正式开局
      if (st.active !== H) aiTurn();
      else { const AN = global.KGAnim; if (AN) AN.turnBanner('你的回合', '第 ' + st.turn + ' 回合', 'mine'); }
    }
  }

  // 点击只用于开局换牌；正常对战的出牌统一走拖拽。
  function onMulliganClick(i) {
    const st=S.state,H=S.humanSide||0;
    if(!st||st.phase!=='mulligan'||st.over||st.mulligan?.done[H]||!st.players[H].hand[i])return;
    if(!S.mulliganPicks)S.mulliganPicks=new Set();
    if(S.mulliganPicks.has(i))S.mulliganPicks.delete(i);else S.mulliganPicks.add(i);
    renderBattle();renderMulligan();
  }

  // 记录"当前场上所有单位 uid"，用于识别最新部署的那个
  function markKnownUids() {
    S.seenDeployUids = new Set();
    $$('.card[data-uid]').forEach(el => { if (el.dataset.uid) S.seenDeployUids.add(el.dataset.uid); });
  }
  function newestUidSince(known) {
    if (!known) return null;
    let found = null;
    $$('.card[data-uid]').forEach(el => {
      const uid = el.dataset.uid;
      if (uid && !known.has(uid) && !found) found = uid;
    });
    return found;
  }
  function artHtmlOf(srcEl) {
    const img = srcEl && srcEl.querySelector && srcEl.querySelector('img');
    if (img) return '<img src="' + img.getAttribute('src') + '" alt="">';
    const nameEl = srcEl && srcEl.querySelector && srcEl.querySelector('.card-name');
    return '<div class="fly-text">' + ((nameEl && nameEl.textContent) || '') + '</div>';
  }

  // 指令卡：与 AI 出指令**同一套过场动画**（从上方落下 → 横移到屏侧 → 停 1 秒 → 移出）。
  //   区别只有一个：我方停靠**右侧**，AI 停靠左侧（用户指定）。
  //   srcEl 仅用于在卡面图取不到时做降级（老版本是"飞到棋盘中央放大淡出"）。
  async function playOrderFlyAnim(srcEl, def, opts) {
    const AN = global.KGAnim;
    if (!AN) { orderFly(def, srcEl); return; }
    // 复用统一演出：orderArtHtml 按卡名从卡池反查卡面图
    await playOrderFX({ cardName: def && def.name, cardType: 'order', side: 'self', fxCat: fxCategoryOf(def), sourceRect: opts && opts.sourceRect });
  }

  /* ============================================================== 构筑 */
  /* ------------------------------------------------------ 卡池翻页 / 滚轮 */
  function pageScroll(delta) {
    const g = $('#poolGrid');
    if (!g) return;
    const step = Math.max(120, g.clientHeight * 0.9);
    g.scrollBy({ top: delta * step, behavior: 'smooth' });
    setTimeout(updatePager, 260);
  }
  function updatePager() {
    const g = $('#poolGrid');
    if (!g) return;
    const info = $('#pageInfo');
    if (!info) return;
    const pages = Math.max(1, Math.ceil(g.scrollHeight / Math.max(1, g.clientHeight)));
    const cur = Math.min(pages, Math.floor(g.scrollTop / Math.max(1, g.clientHeight)) + 1);
    info.textContent = cur + '/' + pages;
  }
  function bindPager() {
    const g = $('#poolGrid');
    if (!g) return;
    g.addEventListener('scroll', updatePager, { passive: true });
    const prev = $('#pagePrev'), next = $('#pageNext'), top = $('#pageTop');
    if (prev) prev.addEventListener('click', () => pageScroll(-1));
    if (next) next.addEventListener('click', () => pageScroll(1));
    if (top) top.addEventListener('click', () => { g.scrollTo({ top: 0, behavior: 'smooth' }); setTimeout(updatePager, 260); });
    // 鼠标在卡池上滚动时用滚轮翻页（原生滚动 + 页码同步）；在左右面板上滚也带着卡池一起翻
    const main = document.querySelector('.pool-main');
    if (main) main.addEventListener('wheel', ev => {
      if (ev.target.closest('.pool-grid')) return;      // 卡片区域本身就用原生滚动
      if (!ev.deltaY) return;
      ev.preventDefault();
      g.scrollTop += ev.deltaY;
      updatePager();
    }, { passive: false });
    // 键盘翻页
    document.addEventListener('keydown', ev => {
      if (!$('#screen-deck').classList.contains('active')) return;
      const tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (ev.key === 'PageDown') { ev.preventDefault(); pageScroll(1); }
      else if (ev.key === 'PageUp') { ev.preventDefault(); pageScroll(-1); }
      else if (ev.key === 'Home') { ev.preventDefault(); if (top) top.click(); }
      else if (ev.key === 'End') { ev.preventDefault(); g.scrollTo({ top: g.scrollHeight, behavior: 'smooth' }); setTimeout(updatePager, 260); }
    });
    updatePager();
  }

  function renderDeckScreen() {
    syncDeckLibCurrent();          // 工作区被改过 → 显示「未保存」，但不覆盖工作区
    renderDeckLib();
    const sets = Array.from(new Set(S.pool.map(c => c.set))).sort();
    const sel = $('#setFilter');
    if (sel.options.length <= 1) sets.forEach(s => sel.add(new Option(s, s)));
    const costs = Array.from(new Set(S.pool.map(c => c.cost).filter(v => v != null))).sort((a, b) => a - b);
    const cf = $('#costFilter');
    if (cf.options.length <= 1) costs.forEach(v => cf.add(new Option(v + ' 费', String(v))));
    renderNationBar();
    renderDeckList();
    renderAiDeckList();
    renderPoolGrid();
    updateDeckModeUI();
    updateDeckScreenTitles();
  }

  /* ★ 卡组选择 / 构筑 分离（制作者 2026-09-25）：
       · #screen-decklib（上级）：选一副卡组 → 载入工作区 → 点「进入构筑」
       · #screen-deck（下级）：只管改牌，左栏全部留给"当前卡组"
     标题和提示在这里统一刷新，避免两个界面显示不同步。 */
  function updateDeckScreenTitles() {
    const d = getSavedDeck(S.curDeckId);
    const t = $('#deckTitle');
    if (t) t.textContent = '构筑' + (d ? '：' + d.name : '（未选择卡组）');
    const hint = $('#decksetHint');
    if (hint) {
      hint.textContent = d
        ? ('当前：' + d.name + '（' + d.cards.length + ' 张）' + (S.deckDirty ? ' · 有未保存改动' : ''))
        : '当前没有选中卡组，点「新建」建一副';
    }
  }

  function currentDeck() { return S.deck; }
  function currentAiDeck() { return S.aiDeck; }
  /* ---------------------------------------------------------- 卡组库（参考原版 KARDS）
   * 卡组库 = 若干「具名的已保存卡组」；工作区（右栏 + 卡池点击）始终编辑其中一副。
   * 落盘：localStorage kg.deckLib；旧版单卡组 kg.deck 只在首次启动时迁移。
   * -------------------------------------------------------------------- */
  function persistDeckLib() {
    LS.set('deckLib', { cur: S.curDeckId, decks: S.deckLib.decks, seq: S.deckSeq });
  }

  // 与旧版单卡组存储保持同步（旧 key 仍可读），并清掉“未保存”标记
  function publishDeck() {
    LS.set('deck', S.deck);
    S.deckDirty = false;
    persistDeckLib();
  }

  function deckNameTaken(name, exceptId) {
    name = String(name || '').trim();
    return S.deckLib.decks.some(function (d) { return d.id !== exceptId && d.name === name; });
  }

  function usedDeckNumbers() {                 // 从已有名字「卡组 3」推出最大编号
    let max = 0;
    S.deckLib.decks.forEach(function (d) {
      const m = /^卡组\s*(\d+)$/.exec(d.name || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return max;
  }

  function nextDeckNumberedName(exceptId) {    // 「卡组 N」里取下一个不重名的编号
    let n = Math.max(1, S.deckSeq | 0);
    for (;;) {
      const name = '卡组 ' + n;
      if (!deckNameTaken(name, exceptId)) { S.deckSeq = Math.max(S.deckSeq, n); return name; }
      n++;
    }
  }

  function nextDeckName(baseName) {            // 复制卡组用：「X 副本」「X 副本 2」
    baseName = String(baseName || '卡组').trim();
    let name = baseName + ' 副本';
    if (!deckNameTaken(name, null)) return name;
    for (let i = 2; i < 999; i++) {
      name = baseName + ' 副本 ' + i;
      if (!deckNameTaken(name, null)) return name;
    }
    return baseName + ' 副本 ' + Date.now();
  }

  /* ★ 主国/盟国（2026-09-25 制作者口径）：一套卡组只能由**两个主游戏国家**的卡组成
   *   （主国 + 盟国），盟国最多 12 张；每副卡组各存 { major, ally, restrict }，
   *   restrict=false = 关掉这条限制。建卡组时选主国/盟国；联机时双方 restrict 必须一致。
   *   国家只认这 8 个主游戏国家；天气/天气附加/misc/自定义/进攻模式不算国家。AI 卡组不受限。 */
  const NATIONS = ['USG', '星盟', 'av76', 'deran', 'UN', '犹猪', 'BSN', 'BSUC'];
  const ALLY_MAX = 12;
  function isNation(s) { return NATIONS.indexOf(s) >= 0; }
  function guessNations(cards) {
    const counts = {};
    (cards || []).forEach(function (id) {
      const c = KG.pool && KG.pool[id];
      if (!c || !isNation(c.set)) return;
      counts[c.set] = (counts[c.set] || 0) + 1;
    });
    const sorted = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    return { major: sorted[0] || null, ally: (sorted[1] && counts[sorted[1]] <= ALLY_MAX) ? sorted[1] : null };
  }
  function deckNationInfo(deck) {
    const cards = (deck && deck.cards) || [];
    const major = (deck && deck.major) || null;
    const ally = (deck && deck.ally) || null;
    const restrict = !(deck && deck.restrict === false);
    let majorCount = 0, allyCount = 0; const other = [];
    cards.forEach(function (id) {
      const c = KG.pool && KG.pool[id];
      if (major && c && c.set === major) majorCount++;
      else if (ally && c && c.set === ally) allyCount++;
      else other.push(c ? c.name : id);
    });
    let error = null;
    if (restrict) {
      if (!major) error = '还没选主国';
      else if (allyCount > ALLY_MAX) error = '盟国（' + ally + '）超过 ' + ALLY_MAX + ' 张';
      else if (other.length) error = '含 ' + other.length + ' 张非主国/盟国的卡';
    }
    return { restrict: restrict, major: major, ally: ally, majorCount: majorCount, allyCount: allyCount,
             other: other, ok: !error, error: error };
  }
  function currentRuleDeck() {
    const r = S.deckRule || { major: null, ally: null, restrict: true };
    return deckNationInfo({ cards: S.deck, major: r.major, ally: r.ally, restrict: r.restrict });
  }
  function syncDeckRuleFromSaved() {
    const d = getSavedDeck(S.curDeckId);
    S.deckRule = d ? { major: d.major || null, ally: d.ally || null, restrict: d.restrict !== false }
                   : { major: null, ally: null, restrict: true };
  }
  function renderNationBar() {
    const bar = $('#nationBar'); if (!bar) return;
    if (!S.deckRule) syncDeckRuleFromSaved();
    const r = S.deckRule;
    const mk = $('#majorSel'), ak = $('#allySel'), ck = $('#nationRuleChk');
    if (mk && mk.options.length <= 1) { mk.add(new Option('（未选主国）', '')); NATIONS.forEach(function (n) { mk.add(new Option(n, n)); }); }
    if (ak && ak.options.length <= 1) { ak.add(new Option('（无盟国）', '')); NATIONS.forEach(function (n) { ak.add(new Option(n, n)); }); }
    const on = r.restrict !== false;
    if (ck) ck.checked = on;
    if (mk) { mk.value = r.major || ''; mk.disabled = !on; }
    if (ak) { ak.value = r.ally || ''; ak.disabled = !on; }
    bar.classList.toggle('off', !on);
  }
  function setDeckRule(patch) {
    const r = Object.assign({ major: null, ally: null, restrict: true }, S.deckRule || {}, patch);
    if (r.major && r.ally === r.major) r.ally = null;
    S.deckRule = r;
    S.deckDirty = true;
    renderDeckScreen();
  }

  /* 按主国/盟国自动构筑一副合规卡组：主国填满，盟国最多 12 张（替换主国卡组的尾部）。 */
  function autoDeckNations(pool, major, ally) {
    const usable = (pool || []).filter(function (c) { return !c.referenceCard && KG.copyLimit(c) > 0; });
    const counts0 = {};
    usable.forEach(function (c) { if (isNation(c.set)) counts0[c.set] = (counts0[c.set] || 0) + 1; });
    const ranked = Object.keys(counts0).sort(function (a, b) { return counts0[b] - counts0[a]; });
    if (!major || !isNation(major)) major = ranked[0] || null;
    if (!ally || !isNation(ally) || ally === major) ally = ranked.filter(function (n) { return n !== major; })[0] || null;
    if (!major) return KG.autoDeck(pool);
    const main = KG.autoDeck(pool, { sets: [major] });
    if (!ally) return main.slice(0, KG.RULES.deckSize);
    const allyDeck = KG.autoDeck(pool, { sets: [ally] });
    const out = main.slice(0, KG.RULES.deckSize);
    const counts = {}; out.forEach(function (id) { counts[id] = (counts[id] || 0) + 1; });
    let taken = 0;
    for (let k = 0; k < allyDeck.length && taken < ALLY_MAX; k++) {
      const id = allyDeck[k], c = KG.pool[id]; if (!c) continue;
      const lim = KG.copyLimit(c); if (lim <= 0 || (counts[id] || 0) >= lim) continue;
      let idx = -1, majorLeft = 0;
      for (let i = out.length - 1; i >= 0; i--) { const cc = KG.pool[out[i]]; if (cc && cc.set === major) { if (idx < 0) idx = i; majorLeft++; } }
      if (idx < 0 || majorLeft <= 1) break;
      const removed = out[idx]; counts[removed] = (counts[removed] || 0) - 1;
      out[idx] = id; counts[id] = (counts[id] || 0) + 1; taken++;
    }
    return out.slice(0, KG.RULES.deckSize);
  }
  function autoDeckForRule() {
    const r = S.deckRule || { major: null, ally: null, restrict: true };
    if (r.restrict === false) return KG.autoDeck(S.pool);
    const deck = autoDeckNations(S.pool, r.major, r.ally);
    const g = guessNations(deck);
    S.deckRule = { major: r.major || g.major, ally: r.ally || g.ally, restrict: true };
    return deck;
  }

  function newDeckId() {
    return 'deck-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function getSavedDeck(id) {
    return S.deckLib.decks.filter(function (d) { return d.id === id; })[0] || null;
  }

  function sanitizeDeckIds(ids) {              // 剔除已删除 / 不可构筑 / 超上限 / 超长的卡
    const counts = {};
    return (ids || []).filter(function (id) {
      const c = KG.pool && KG.pool[id];
      if (!c) return false;
      const lim = KG.copyLimit(c);
      if (lim <= 0) return false;
      counts[id] = (counts[id] || 0) + 1;
      return counts[id] <= lim;
    }).slice(0, KG.RULES.deckSize);
  }

  function defaultDeckLibrary() {              // 首次启动：用自动构筑给一副起手卡组
    const cards = sanitizeDeckIds(autoDeckNations(S.pool, null, null));
    const g = guessNations(cards);
    return [{ id: newDeckId(), name: nextDeckNumberedName(null), cards: cards,
              major: g.major, ally: g.ally, restrict: true, updated: Date.now() }];
  }

  // 只碰存储，绝不碰工作区（boot 时两边各按自己的顺序归一化，不能相互覆盖）
  function loadDeckLibrary() {
    const raw = LS.get('deckLib', null);
    S.deckSeq = 0;
    if (raw && raw.decks && raw.decks.length) {
      S.deckLib.decks = raw.decks.map(function (d) {
        const cards = sanitizeDeckIds(d.cards);
        const restrict = d.restrict !== false;                 // ★ 默认开
        let major = isNation(d.major) ? d.major : null;
        let ally = isNation(d.ally) ? d.ally : null;
        if (!major && restrict) { const g = guessNations(cards); major = g.major; ally = ally || g.ally; }
        return { id: d.id, name: String(d.name || '卡组'), cards: cards,
                 major: major, ally: ally, restrict: restrict, updated: d.updated || 0 };
      });
      S.curDeckId = S.deckLib.decks.some(function (d) { return d.id === raw.cur; }) ? raw.cur : S.deckLib.decks[0].id;
    } else {
      S.deckLib.decks = defaultDeckLibrary();
      S.curDeckId = S.deckLib.decks[0].id;
      // 旧版单卡组（kg.deck 是个裸数组）→ 迁移成库里的第一副
      const legacy = LS.get('deck', null);
      if (legacy && legacy.length) {
        S.deckLib.decks[0].cards = sanitizeDeckIds(legacy);
        const g = guessNations(S.deckLib.decks[0].cards);
        S.deckLib.decks[0].major = g.major; S.deckLib.decks[0].ally = g.ally;
      }
    }
    S.deckLib.cur = S.curDeckId;
    S.deckSeq = Math.max(1, (raw && raw.seq ? raw.seq | 0 : 1), usedDeckNumbers());
    persistDeckLib();
  }

  function setCurrentDeckId(id) {
    S.curDeckId = id || null;
    S.deckLib.cur = S.curDeckId;
    persistDeckLib();
  }

  function loadDeckIntoWorkspace(id) {         // 点卡组库里的一副 = 载入它来编辑
    const d = getSavedDeck(id);
    if (!d) return;
    S.deck = d.cards.slice();
    S.deckDirty = false;
    setCurrentDeckId(d.id);
    syncDeckRuleFromSaved();
    LS.set('deck', S.deck);
    syncDeckLibCurrent();
  }

  // 打开构筑页时，库里的“当前卡组”必须与工作区一致；不一致 = 工作区被改过（未保存）
  function syncDeckLibCurrent() {
    const d = getSavedDeck(S.curDeckId);
    if (!d) { S.curDeckId = null; S.deckLib.cur = null; S.deckDirty = S.deck.length > 0; return; }
    const r = S.deckRule || { major: null, ally: null, restrict: true };
    const same = d.cards.length === S.deck.length && d.cards.every(function (id, i) { return id === S.deck[i]; })
      && (d.major || null) === (r.major || null) && (d.ally || null) === (r.ally || null)
      && (d.restrict !== false) === (r.restrict !== false);
    S.deckDirty = !same;
  }

  function saveCurrentToSelected() {           // 「保存」：有选中卡组就覆盖，没有则新建一副
    if (S.deck.length > KG.RULES.deckSize) S.deck = S.deck.slice(0, KG.RULES.deckSize);
    let d = getSavedDeck(S.curDeckId);
    if (!d) {
      d = { id: newDeckId(), name: nextDeckNumberedName(null), cards: [], updated: 0 };
      S.deckLib.decks.push(d);
    }
    const r = S.deckRule || { major: null, ally: null, restrict: true };
    d.cards = S.deck.slice();
    d.major = r.major || null; d.ally = r.ally || null; d.restrict = r.restrict !== false;
    d.updated = Date.now();
    setCurrentDeckId(d.id);
    publishDeck();
    toast('已保存「' + d.name + '」（' + d.cards.length + ' 张）');
  }

  function newDeck() {                         // 「新建」：另起一副空卡组
    const d = { id: newDeckId(), name: nextDeckNumberedName(null), cards: [], major: null, ally: null, restrict: true, updated: Date.now() };
    S.deckLib.decks.push(d);
    S.deck = [];
    S.deckRule = { major: null, ally: null, restrict: true };
    S.deckDirty = true;
    setCurrentDeckId(d.id);
    persistDeckLib();
    toast('已新建「' + d.name + '」，选好牌后点保存');
  }

  function duplicateDeck() {                   // 「复制」：复制当前卡组
    if (!S.deck.length) { toast('当前卡组是空的，先加几张牌'); return; }
    const src = getSavedDeck(S.curDeckId);
    const r = S.deckRule || { major: null, ally: null, restrict: true };
    const d = { id: newDeckId(), name: nextDeckName(src ? src.name : '卡组'), cards: S.deck.slice(),
                major: r.major || null, ally: r.ally || null, restrict: r.restrict !== false, updated: Date.now() };
    S.deckLib.decks.push(d);
    setCurrentDeckId(d.id);
    publishDeck();
    toast('已复制为「' + d.name + '」');
  }

  async function renameDeck() {                // 「改名」
    const d = getSavedDeck(S.curDeckId);
    if (!d) { toast('当前不是已保存的卡组，先点「保存」'); return; }
    /* Electron 里 prompt() 会抛异常，走页面内输入框（见 askText 注释） */
    const raw = await askText({ title: '卡组改名', label: '卡组名称：', value: d.name, maxlength: 24, okText: '改名' });
    if (raw == null) return;
    const name = String(raw).trim().slice(0, 24);
    if (!name) { toast('卡组名不能为空'); return; }
    if (deckNameTaken(name, d.id)) { toast('已有一副叫「' + name + '」的卡组'); return; }
    d.name = name;
    persistDeckLib();
    syncDeckLibCurrent();
    toast('已改名为「' + name + '」');
  }

  function deleteDeck() {                      // 「删除」
    const d = getSavedDeck(S.curDeckId);
    if (!d) { toast('当前没有选中的卡组'); return; }
    if (!S.skipDeckConfirm && typeof global.confirm === 'function' &&
      !global.confirm('删除卡组「' + d.name + '」？此操作不可撤销。')) return;
    const i = S.deckLib.decks.indexOf(d);
    if (i >= 0) S.deckLib.decks.splice(i, 1);
    if (S.curDeckId === d.id) {
      S.curDeckId = S.deckLib.decks.length ? S.deckLib.decks[Math.min(i, S.deckLib.decks.length - 1)].id : null;
      S.deckLib.cur = S.curDeckId;
      if (!S.curDeckId) { S.deck = []; S.deckRule = null; S.deckDirty = false; }
    }
    persistDeckLib();
    if (S.curDeckId) loadDeckIntoWorkspace(S.curDeckId); else LS.set('deck', S.deck);
    toast('已删除「' + d.name + '」');
  }

  function deckDisplayName() {
    const d = getSavedDeck(S.curDeckId);
    if (!d) return '新卡组（未保存）';
    return d.name + (S.deckDirty ? ' ＊' : '');
  }

  /* ------------------------------------------------------------ 卡组分享码
   * 目标：一串**短、纯文本、可直接粘贴**的字符串，把一副卡组（名字 + 卡）带走。
   *
   * 格式： KDS1<校验2字符>|<名字>|<旗标,主国,盟国>|<条目><条目>…（旧码只有 名字|条目 两段，仍可读）
   *   条目 = <张数(1个base36字符)><与上一条共用前缀长度(1个base36字符)><剩下的后缀>;
   *
   *   · 条目按卡 id **排序后**做「前缀共用」（front coding）：相邻 id 常常只差最后几位
   *     （deran/units/31、deran/units/32 …），所以只存"共用了几个字符 + 尾巴"，
   *     40 张的卡组压到 200 字符上下（整串 id 平铺要 390+）。
   *   · **用卡 id 明文，不用卡池下标** —— 下标会随卡池增删整体漂移，而对方卡池跟我
   *     不完全一样是常态（自定义卡）。id 明文 = 认得出就用、认不出就明说"N 张不在
   *     你的卡池里"，**绝不会悄悄换成别的卡**。
   *   · 校验位 = 名字+正文的简单散列（2 个 base36 字符），防粘一半 / 被聊天软件吃掉字符。
   */
  const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  function b36ch(n) { n = Math.max(0, Math.min(35, n | 0)); return B36.charAt(n); }
  function b36val(ch) { const i = B36.indexOf(String(ch || '').toLowerCase()); return i; }
  function deckCodeChecksum(s) {
    let h = 7;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1296;
    return b36ch(Math.floor(h / 36)) + b36ch(h % 36);
  }

  function encodeDeckCode(cards, name, major, ally, restrict) {
    const counts = {};
    (cards || []).forEach(function (id) { if (id) counts[id] = (counts[id] || 0) + 1; });
    let prev = '', body = '';
    Object.keys(counts).sort().forEach(function (id) {
      let sh = 0;
      const max = Math.min(prev.length, id.length, 35);
      while (sh < max && prev.charAt(sh) === id.charAt(sh)) sh++;
      body += b36ch(counts[id]) + b36ch(sh) + id.slice(sh) + ';';
      prev = id;
    });
    const nm = String(name || '').replace(/[|;\r\n]/g, ' ').trim().slice(0, 24);
    // 调用方没给国家信息（老调用/老代码）→ 仍写旧的两段格式，导入端按卡牌猜
    if (major == null && ally == null && restrict == null) {
      return 'KDS1' + deckCodeChecksum(nm + '|' + body) + '|' + nm + '|' + body;
    }
    // ★ 主国/盟国/开关也进码：<旗标>,<主国>,<盟国>（旗标 1=开 0=关；国家名不含 | , ;）
    const nf = (restrict === false ? '0' : '1') + ',' +
      String(major || '').replace(/[|;,\r\n]/g, '') + ',' + String(ally || '').replace(/[|;,\r\n]/g, '');
    return 'KDS1' + deckCodeChecksum(nm + '|' + nf + '|' + body) + '|' + nm + '|' + nf + '|' + body;
  }

  // 返回 {name, cards, missing}；不是我们的码 / 校验不过 → null
  function decodeDeckCode(code) {
    const raw = String(code || '').trim();
    let name, nf = null, body;
    // 新格式（带主国/盟国）：KDS1<ck>|<名字>|<旗标,主国,盟国>|<正文>；旧格式（两段）回退
    let m = /^KDS1([0-9a-z]{2})\|([^|]*)\|([^|]*)\|([\s\S]*)$/i.exec(raw);
    if (m && deckCodeChecksum(m[2].trim() + '|' + m[3] + '|' + m[4]).toLowerCase() === m[1].toLowerCase()) {
      name = m[2].trim(); nf = m[3]; body = m[4];
    } else {
      m = /^KDS1([0-9a-z]{2})\|([^|]*)\|([\s\S]*)$/i.exec(raw);
      if (!m) return null;
      name = m[2].trim(); body = m[3];
      if (deckCodeChecksum(name + '|' + body).toLowerCase() !== m[1].toLowerCase()) return null;
    }
    const cards = [], missing = [];
    let prev = '';
    const parts = body.split(';');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const cnt = b36val(p.charAt(0)), sh = b36val(p.charAt(1));
      if (cnt < 1 || sh < 0 || p.length < 3) return null;      // 形态不对 = 不是卡组码
      const id = prev.slice(0, sh) + p.slice(2);
      prev = id;
      if (KG.pool && !KG.pool[id]) { if (missing.indexOf(id) < 0) missing.push(id); continue; }
      for (let k = 0; k < cnt; k++) cards.push(id);
    }
    let major = null, ally = null, restrict = null;      // 旧码没有国家段 → restrict 保持 null（由调用方猜）
    if (nf != null) {
      const f = nf.split(',');
      restrict = (f[0] !== '0');
      major = isNation(f[1]) ? f[1] : null;
      ally = isNation(f[2]) ? f[2] : null;
    }
    return { name: name, cards: cards, missing: missing, major: major, ally: ally, restrict: restrict };
  }
  S.encodeDeckCode = encodeDeckCode;   // 也给自动化测试/控制台用（KG.ui.encodeDeckCode）
  S.decodeDeckCode = decodeDeckCode;
  S.deckCodeChecksum = deckCodeChecksum;

  function copyText(text, okMsg) {
    try {
      if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
        global.navigator.clipboard.writeText(text).then(function () { toast(okMsg, 7000); },
          function () { fallbackCopy(text, okMsg); });
        return;
      }
    } catch (e) { }
    fallbackCopy(text, okMsg);
  }
  function fallbackCopy(text, okMsg) {
    try {
      if (document.body && document.body.appendChild && document.createElement) {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta);
        if (ta.focus) ta.focus(); if (ta.select) ta.select();
        const okExec = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        document.body.removeChild(ta);
        if (okExec) { toast(okMsg, 7000); return; }
      }
    } catch (e) { }
    copyFallbackBox(text, okMsg);
  }

  /* 「分享代码」：把**工作区里当前这副**（所见即所得，含未保存的改动）编成码并复制 */
  function shareDeckCode() {
    if (!S.deck.length) { toast('当前卡组是空的，先加几张牌'); return; }
    const d = getSavedDeck(S.curDeckId);
    const name = d ? d.name : '未命名卡组';
    const r = S.deckRule || { major: null, ally: null, restrict: true };
    const code = encodeDeckCode(S.deck, name, r.major, r.ally, r.restrict);
    copyText(code, '卡组代码已复制（' + S.deck.length + ' 张 / ' + code.length + ' 字符）→ 发给别人，对方在「导入代码」里粘贴');
  }

  /* 「导入代码」：粘贴 → 建成**一副新卡组**（不动你已有的，重名自动加「副本」） */
  async function importDeckCode() {
    /* Electron 里 prompt() 会抛异常，走页面内输入框（见 askText 注释） */
    let raw = await askText({
      title: '导入卡组代码',
      label: '粘贴对方发来的卡组代码（以 KDS1 开头）：',
      value: '', multiline: true, okText: '导入',
      hint: 'Ctrl+Enter 也可提交；导入后会建成一副**新卡组**，不会动你已有的。',
    });
    if (raw == null) return;
    raw = String(raw).trim();
    if (!raw) return;
    const res = decodeDeckCode(raw);
    if (!res) { toast('这不是有效的卡组代码（应以 KDS1 开头，且不能被截断/改动）', 8000); return; }
    if (!res.cards.length) {
      toast('这副卡的 ' + res.missing.length + ' 张都不在你的卡池里（卡池不同步，先导入对应卡）', 8000);
      return;
    }
    const want = res.name || '导入的卡组';
    const name = deckNameTaken(want, null) ? nextDeckName(want) : want;
    const impCards = sanitizeDeckIds(res.cards);
    // ★ 码里带了主国/盟国就用它；旧码（没有国家段，res.restrict===null）按卡牌猜 + 默认开启
    const hasNationField = (res.restrict !== null && res.restrict !== undefined) &&
      (res.major || res.ally || res.restrict === false);   // 只有旗标没有国家 = 没信息，仍按卡牌猜
    const g = hasNationField ? { major: res.major || null, ally: res.ally || null } : guessNations(impCards);
    const impRestrict = hasNationField ? (res.restrict !== false) : true;
    const d = { id: newDeckId(), name: name, cards: impCards, major: g.major, ally: g.ally, restrict: impRestrict, updated: Date.now() };
    S.deckLib.decks.push(d);
    S.deck = d.cards.slice();
    S.deckRule = { major: g.major, ally: g.ally, restrict: impRestrict };
    S.deckDirty = false;
    setCurrentDeckId(d.id);
    publishDeck();
    const skipped = res.missing.length;
    toast('已导入「' + name + '」（' + d.cards.length + ' 张' +
      (skipped ? '；' + skipped + ' 张你的卡池里没有，已跳过' : '') + '）· ' +
      (impRestrict ? ('主国 ' + (g.major || '未选') + (g.ally ? ' + 盟国 ' + g.ally : '')) : '主国/盟国限制：关'), 8000);
  }

  function renderDeckLib() {
    const box = $('#deckLib');
    if (!box) return;
    box.innerHTML = '';
    if (!S.deckLib.decks.length) {
      const empty = document.createElement('div');
      empty.className = 'deck-lib-empty';
      empty.textContent = '（还没有保存过卡组，点「新建」或直接编辑后点保存）';
      box.appendChild(empty);
      return;
    }
    S.deckLib.decks.forEach(function (d) {
      const row = document.createElement('div');
      row.className = 'deck-lib-item' + (d.id === S.curDeckId ? ' active' : '');
      row.dataset.deckId = d.id;
      row.title = d.id === S.curDeckId ? '正在编辑（点一下重新载入）' : '点击载入这副卡组';
      const del = document.createElement('button');
      del.className = 'dl-del';
      del.dataset.del = d.id;
      del.textContent = '✕';
      del.title = '删除这副卡组';
      del.onclick = function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        S.curDeckId = d.id; S.deckLib.cur = d.id;   // 先选中再删，别删错别的
        deleteDeck();
        renderDeckScreen();
      };
      const ni = deckNationInfo(d);
      const tag = ni.restrict ? ((ni.major || '未选') + (ni.ally ? ' + ' + ni.ally : '')) : '不限制';
      row.innerHTML = '<span class="dl-name">' + d.name + '</span>' +
        '<span class="dl-num">' + tag + ' · ' + d.cards.length + ' 张' + (ni.ok ? '' : ' ⚠') + '</span>';
      row.appendChild(del);
      row.onclick = function () {
        if (d.id === S.curDeckId && !S.deckDirty) { toast('「' + d.name + '」就是正在编辑的卡组'); return; }
        loadDeckIntoWorkspace(d.id);
        renderDeckScreen();
        toast('已载入「' + d.name + '」（' + d.cards.length + ' 张）');
      };
      box.appendChild(row);
    });
  }

  function renderAiDeckList() {
    const counts = {};
    currentAiDeck().forEach(function(id) { counts[id] = (counts[id] || 0) + 1; });
    const list = $('#aiDeckList');
    list.innerHTML = '';
    Object.keys(counts).sort(function(a, b) { return (KG.cardDef(null, a).cost || 0) - (KG.cardDef(null, b).cost || 0); }).forEach(function(id) {
      const c = KG.cardDef(null, id);
      const d = document.createElement('div');
      d.className = 'deck-item';
      d.innerHTML = '<span>' + c.name + '</span><span class="c">x' + counts[id] + '</span>';
      if (isMobileUI()) {
        // ★ 同 renderDeckList：手机端点击 = 详情，拖出列表 = 移除一张（AI 卡组同口径）
        d.title = '拖出AI卡组 = 移除一张（点击看详情）';
        bindTipTap(d, c);
        d.addEventListener('pointerdown', ev => beginCardDrag(ev, { kind: 'deckRm', id: id, ai: true }, d, c));
      } else {
        d.title = '点击移除一张';
        d.onclick = function() { const i = S.aiDeck.indexOf(id); if (i >= 0) S.aiDeck.splice(i, 1); renderAiDeckList(); renderPoolGrid(); };
        // ★ AI 卡组列表同样补悬停详情
        d.addEventListener('mouseenter', function (e) { showTip(e, c); });
        d.addEventListener('mouseleave', hideTip);
      }
      list.appendChild(d);
    });
    const curve = {};
    S.aiDeck.forEach(function(id) { const c = KG.cardDef(null, id); const k = c.cost == null ? '?' : c.cost; curve[k] = (curve[k] || 0) + 1; });
    $('#aiDeckStats').innerHTML = '共 <b>' + S.aiDeck.length + '</b> / ' + KG.RULES.deckSize + ' 张<br>' +
      Object.keys(curve).sort(function(a, b) { return (a === '?' ? 99 : +a) - (b === '?' ? 99 : +b); })
        .map(function(k) { return k + '费:' + curve[k]; }).join('　');
  }

  function updateDeckModeUI() {
    const isAi = S.deckMode === 'ai';
    const playerSide = $('#playerDeckSide');
    const aiSide = $('#aiDeckSide');
    const switchBtn = $('#switchDeckMode');        // 老按钮（已移进抽屉），留着兼容
    // ★ AI 卡组现在是**右侧抽屉**（.deck-drawer），不再靠"隐藏我的卡组栏"来切换：
    //   左栏恒显示"我的卡组"，抽屉的开合由 #aiDeckToggle / #aiDeckClose 控制。
    if (playerSide) playerSide.style.display = '';
    if (aiSide) aiSide.style.display = '';
    if (switchBtn) switchBtn.textContent = isAi ? '切换到我的卡组' : '切换到AI卡组';
    // ★ 抽屉的开合**只认 deckMode**（唯一真源）—— 首次进入构筑屏时按保存值决定开合，
    //   按钮点击只需改 deckMode，视觉由这里统一同步（避免两处各写一半对不上）。
    //   ★ body.ai-build（AI 构筑界面）由 **S.aiBuild 独立状态**控制，绝不能挂 deckMode：
    //     普通构筑里点「AI 卡组 ▸」开抽屉也会把 deckMode 置 'ai'，若挂 deckMode
    //     会把抽屉形态整个撕成左栏形态 —— 两个"AI 模式"语义不同，各管各的。
    if (document.body && document.body.classList) {
      document.body.classList.toggle('ai-deck-open', isAi);
      document.body.classList.toggle('ai-build', !!S.aiBuild);
    }
    const tg = $('#aiDeckToggle');
    if (tg) {
      tg.classList.toggle('on', isAi);
      tg.textContent = isMobileUI() ? (isAi ? 'AI ▾' : 'AI ▸') : (isAi ? 'AI 卡组 ▾' : 'AI 卡组 ▸');
    }
    // Update pool grid hint
    const grid = $('#poolGrid');
    if (grid) grid.title = isAi ? '点击卡牌加入AI卡组' : '点击卡牌加入我的卡组';
  }

  /* AI 卡组抽屉：左栏「AI 卡组 ▸」开，抽屉里「✕ 收起」关。
     只改 deckMode（+ 落盘），视觉交给 updateDeckModeUI 统一同步。 */
  function setAiDeckDrawer(open) {
    S.deckMode = open ? 'ai' : 'player';
    LS.set('deckMode', S.deckMode);
  }

  function renderDeckList() {
    const counts = {};
    currentDeck().forEach(id => counts[id] = (counts[id] || 0) + 1);
    const list = $('#deckList');
    list.innerHTML = '';
    Object.keys(counts).sort((a, b) => (KG.cardDef(null, a).cost || 0) - (KG.cardDef(null, b).cost || 0)).forEach(id => {
      const c = KG.cardDef(null, id);
      const d = document.createElement('div');
      d.className = 'deck-item';
      d.innerHTML = '<span>' + c.name + '</span><span class="c">×' + counts[id] + '</span>';
      if (isMobileUI()) {
        // ★ 手机端（制作者 2026-09-25 定版）：点击只看详情；**拖出卡组列表 = 移除一张**
        //   （拖回列表里 = 反悔）。桌面端保持"点击移除"不变。
        d.title = '拖出卡组 = 移除一张（点击看详情）';
        bindTipTap(d, c);
        d.addEventListener('pointerdown', ev => beginCardDrag(ev, { kind: 'deckRm', id: id, ai: false }, d, c));
      } else {
        d.title = '点击移除一张';
        d.onclick = () => { const i = S.deck.indexOf(id); if (i >= 0) S.deck.splice(i, 1); S.deckDirty = true; renderDeckList(); renderDeckLib(); renderPoolGrid(); };
        // ★ 卡组列表是纯文字行，悬停也要能看到放大卡面 + 详情（与 cardEl 的悬停行为一致）
        d.addEventListener('mouseenter', e => showTip(e, c));
        d.addEventListener('mouseleave', hideTip);
      }
      list.appendChild(d);
    });
    const curve = {};
    S.deck.forEach(id => { const c = KG.cardDef(null, id); const k = c.cost == null ? '?' : c.cost; curve[k] = (curve[k] || 0) + 1; });
    const ni = currentRuleDeck();
    let nationLine;
    if (ni.restrict) {
      nationLine = '<br>主国 <b>' + (ni.major || '未选') + '</b>（' + ni.majorCount + '）' +
        ' · 盟国 <b>' + (ni.ally || '无') + '</b>（' + ni.allyCount + '/' + ALLY_MAX + '）' +
        (ni.ok ? '' : '<br><span class="deck-warn">⚠ ' + ni.error + '</span>');
    } else {
      nationLine = '<br><span class="muted">主国/盟国限制：已关闭</span>';
    }
    $('#deckStats').innerHTML = '<b class="deck-name">' + deckDisplayName() + '</b><br>' +
      '共 <b>' + S.deck.length + '</b> / ' + KG.RULES.deckSize + ' 张' + nationLine + '<br>' +
      Object.keys(curve).sort((a, b) => (a === '?' ? 99 : +a) - (b === '?' ? 99 : +b))
        .map(k => k + '费:' + curve[k]).join('　');
  }

  function poolFiltered() {
    const q = ($('#cardSearch').value || '').trim();
    const set = $('#setFilter').value, type = $('#typeFilter').value, ut = $('#unitTypeFilter').value, cost = $('#costFilter').value;
    const owned = $('#onlyOwned').checked;
    const hideUnbuildable = $('#hideToken') ? $('#hideToken').checked : false;
    const rule = currentRuleDeck();
    return S.pool.filter(c => {
      if (c.referenceCard) return false;
      if (hideUnbuildable && KG.copyLimit(c) <= 0) return false;
      if (set && c.set !== set) return false;
      // ★ 主国/盟国：开启限制且已选主国时，卡池只显示这两国（AI 卡组不受限）
      if (S.deckMode !== 'ai' && rule.restrict && rule.major && c.set !== rule.major && c.set !== rule.ally) return false;
      if (type && c.cardType !== type) return false;
      if (ut && c.unitType !== ut) return false;
      if (cost !== '' && String(c.cost) !== cost) return false;
      if (owned && !S.custom.some(x => x.id === c.id)) return false;
      if (q && (c.name + ' ' + (c.text || '')).indexOf(q) < 0) return false;
      return true;
    });
  }

  /* ★ 卡池展示顺序：按费用升序；同费按 系列 → 卡名，保证稳定（与左栏卡组列表同一口径）。 */
  function poolForDisplay() {
    return poolFiltered().slice().sort(function (a, b) {
      const ca = (a.cost == null ? 999 : a.cost), cb = (b.cost == null ? 999 : b.cost);
      if (ca !== cb) return ca - cb;
      const sa = a.set || '', sb = b.set || '';
      if (sa !== sb) return sa < sb ? -1 : 1;
      const na = a.name || '', nb = b.name || '';
      return na < nb ? -1 : (na > nb ? 1 : 0);
    });
  }

  function renderPoolGrid() {
    const grid = $('#poolGrid');
    grid.innerHTML = '';
    const curDeck = S.deckMode === 'ai' ? S.aiDeck : S.deck;
    const counts = {};
    curDeck.forEach(id => counts[id] = (counts[id] || 0) + 1);
    poolForDisplay().forEach(c => {
      const wrap = document.createElement('div');
      const lim = KG.copyLimit(c);
      wrap.className = 'grid-card' + (lim <= 0 ? ' unbuildable' : '');
      wrap.appendChild(cardEl(c));
      const meta = document.createElement('div');
      meta.className = 'meta';
      const rar = c.rarity && KG.RARITY_INFO[c.rarity] ? KG.RARITY_INFO[c.rarity].cn : '';
      // ⚠ counts[c.id] 对"一张都没加过的卡"是 undefined —— 直接拼字符串会显示成
      //   「undefined/1」。必须 (counts[c.id] || 0)。
      meta.innerHTML = '<span>' + rar + ' ' + (c.set || '') + '</span><span>' +
        (lim <= 0 ? '不可构筑' : (counts[c.id] || 0) + '/' + lim) + '</span>';
      wrap.appendChild(meta);
      if (counts[c.id]) {
        const b = document.createElement('div'); b.className = 'count-badge'; b.textContent = counts[c.id];
        wrap.appendChild(b);
      }
      const addLabel = S.deckMode === 'ai' ? '加入AI卡组' : '加入我的卡组';
      if (isMobileUI()) {
        // ★ 手机端（2026-10-02 Alan 二次定版）：**点击 = 详情，拖拽 = 加入卡组**（维持 09-25 口径）。
        wrap.title = '拖到左侧卡组 = 加入（点击看详情）';
        wrap.addEventListener('pointerdown', ev => beginCardDrag(ev, { kind: 'poolAdd', id: c.id }, wrap, c));
      } else {
        wrap.onclick = () => addToDeck(c.id);
      }
      grid.appendChild(wrap);
    });
    updatePager();
    layoutSelfCheck();
  }

  function addToDeck(id) {
    if (S.deckMode === 'ai') { addToAiDeck(id); return; }
    const card = KG.cardDef(null, id);
    const lim = KG.copyLimit(card);
    const n = S.deck.filter(x => x === id).length;
    if (lim <= 0) {
      const rar = card.rarity && KG.RARITY_INFO[card.rarity] ? KG.RARITY_INFO[card.rarity].cn : '特殊';
      toast('「' + card.name + '」是' + rar + '卡，不能放入卡组 —— 只能通过其他卡牌的效果产生');
      return;
    }
    // ★ 主国/盟国限制：只能加主国/盟国的卡；盟国最多 12 张
    const rule = currentRuleDeck();
    if (rule.restrict) {
      if (!rule.major) { toast('先选主国（左栏「主国/盟国限制」）'); return; }
      if (card.set !== rule.major && card.set !== rule.ally) {
        toast('「' + card.name + '」是 ' + (card.set || '无系列') + '，不属于主国 ' + rule.major +
          (rule.ally ? ' / 盟国 ' + rule.ally : '') + '，加不进去'); return;
      }
      if (rule.ally && card.set === rule.ally && rule.allyCount >= ALLY_MAX) {
        toast('盟国（' + rule.ally + '）最多 ' + ALLY_MAX + ' 张'); return;
      }
    }
    if (S.deck.length >= KG.RULES.deckSize) { toast('卡组已满 ' + KG.RULES.deckSize + ' 张'); return; }
    if (n >= lim) {
      const rar = card.rarity && KG.RARITY_INFO[card.rarity] ? KG.RARITY_INFO[card.rarity].cn : '';
      toast('同名上限：' + rar + '卡最多 ' + lim + ' 张');
      return;
    }
    S.deck.push(id);
    S.deckDirty = true;
    renderDeckList(); renderDeckLib(); renderPoolGrid();
  }

  function addToAiDeck(id) {
    const card = KG.cardDef(null, id);
    const lim = KG.copyLimit(card);
    const n = S.aiDeck.filter(function(x) { return x === id; }).length;
    if (lim <= 0) {
      const rar = card.rarity && KG.RARITY_INFO[card.rarity] ? KG.RARITY_INFO[card.rarity].cn : '特殊';
      toast('「' + card.name + '」是' + rar + '卡，不能放入AI卡组');
      return;
    }
    if (S.aiDeck.length >= KG.RULES.deckSize) { toast('AI卡组已满 ' + KG.RULES.deckSize + ' 张'); return; }
    if (n >= lim) {
      const rar = card.rarity && KG.RARITY_INFO[card.rarity] ? KG.RARITY_INFO[card.rarity].cn : '';
      toast('同名上限：' + rar + '卡最多 ' + lim + ' 张');
      return;
    }
    S.aiDeck.push(id);
    renderAiDeckList(); renderPoolGrid();
  }

  /* ====================================================== 卡牌库 / 导入 */
  // 卡牌库检索：卡名 / 卡面文本 / 卡号 / 词条 / 系列，支持空格分词（都要命中）
  function collectionFiltered() {
    const showRef = $('#showRef') ? $('#showRef').checked : false;
    const q = (($('#collSearch') && $('#collSearch').value) || '').trim().toLowerCase();
    const words = q ? q.split(/\s+/).filter(Boolean) : [];
    const wantSet = $('#collSet') ? $('#collSet').value : '';
    const wantType = $('#collType') ? $('#collType').value : '';
    const wantRar = $('#collRarity') ? $('#collRarity').value : '';
    const onlyFx = $('#collOnlyFx') ? $('#collOnlyFx').checked : false;
    return S.pool.filter(c => {
      if (!showRef && c.referenceCard) return false;
      if (wantSet && c.set !== wantSet) return false;
      if (wantType && c.cardType !== wantType) return false;
      if (wantRar && (c.rarity || '') !== wantRar) return false;
      if (onlyFx && !(c.effects && c.effects.length)) return false;
      if (words.length) {
        const hay = [c.name, c.id, c.set, c.text, (c.keywords || []).join(',')].join(' ').toLowerCase();
        if (!words.every(w => hay.indexOf(w) >= 0)) return false;
      }
      return true;
    });
  }

  function refreshCollSets() {
    const sel = $('#collSet');
    if (!sel) return;
    const sets = Array.from(new Set(S.pool.map(c => c.set).filter(Boolean))).sort();
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部系列</option>' + sets.map(s => '<option value="' + s + '">' + s + '</option>').join('');
    if (sets.indexOf(cur) >= 0) sel.value = cur;
  }

  /* 排序用的费用：没有费用的卡（令牌等）排最后（999），别用 0 冲到最前面。 */
  function cost4sort(c) { return (c && c.cost != null) ? c.cost : 999; }

  function renderCollection() {
    const grid = $('#collGrid');
    grid.innerHTML = '';
    refreshCollSets();
    const list = collectionFiltered()
      // ★ 默认**按费用正序**（低的在前）。同费用再按系列、id 稳定排序。
      //   没写费用的卡（令牌/特殊卡）排最后 —— 用 999 而不是 0，
      //   否则一打开页面最前面全是"无费用"的卡，很反直觉。
      .sort((a, b) => cost4sort(a) - cost4sort(b) ||
        (a.set || '').localeCompare(b.set || '') || String(a.id).localeCompare(String(b.id)));
    S.lastCollCards = list;    // 供自动化测试断言排序（沙箱 DOM 不支持 querySelectorAll，读不到网格）
    const cnt = $('#collCount');
    if (cnt) cnt.textContent = '共 ' + list.length + ' / ' + S.pool.length + ' 张';
    list.forEach(c => {
      const wrap = document.createElement('div');
      wrap.className = 'grid-card' + (S.custom.some(x => x.id === c.id) ? ' owned' : '');
      wrap.appendChild(cardEl(c));
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '<span>' + (c.name || '') + '</span><span>' + (c.set || '') + '</span>';
      wrap.appendChild(meta);
      if (isMobileUI()) {
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ghost mobile-edit-card';
        edit.textContent = '编辑'; edit.setAttribute('aria-label', '编辑' + (c.name || '卡牌'));
        edit.addEventListener('click', function (ev) { ev.stopPropagation(); hideTip(); openEditor(c); });
        wrap.appendChild(edit);
      } else wrap.onclick = () => openEditor(c);
      grid.appendChild(wrap);
    });
  }
  S.collectionFiltered = collectionFiltered;

  let editing = null;
  let editorEffectStatus = 'manual-confirmed';
  /* ★ 新建一张自定义卡（导入流程的首选入口）。
   *   流程：新建空卡 → 在右侧填 数值 / 词条 / 效果（可点「自动解析效果」也可手写 DSL）
   *        → 需要的话点「配图」选一张 png → 「保存修改」。
   *   ⚠ 与"批量加入"的区别：批量是**先看图**（一堆 png 一起进），
   *     新建是**先填数值**（适合还没画图 / 想先把效果定下来的情况）。 */
  function newCustomCard() {
    const id = 'custom/new-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4).toString(36);
    const c = {
      id: id, name: '新卡', cardType: 'unit',
      cost: 1, attack: 1, defense: 1, opCost: 0,
      set: '自定义', rarity: 'common', text: '', effects: [],
      token: false,          // ⚠ 必须显式 false：extra 分支默认 token:true 会让它**进不了卡组**
    };
    S.custom = S.custom || [];
    S.custom.push(c);
    LS.set('custom', S.custom);
    rebuildPool();
    renderCollection();
    openEditor((KG && KG.pool && KG.pool[id]) ? KG.pool[id] : c);   // 内部会切到制卡界面
    toast('已新建一张卡 —— 填数值 / 词条 / 效果，再点「保存修改」');
    return c;
  }

  /* ★ 给当前编辑的卡配一张图（存 IndexedDB，key = 卡 id）。 */
  async function setEditorArt(file) {
    if (!file || !editing) return false;
    try { await idbPut(editing.id, file); } catch (e) { }
    try { S.images[editing.id] = URL.createObjectURL(file); } catch (e) { }
    const img = $('#edArt');
    if (img) img.src = S.images[editing.id] || '';
    renderCollection();
    toast('已设置卡图：' + file.name);
    return true;
  }

  function openEditor(c) {
    editing = c;
    editorEffectStatus = c.effectStatus || 'unreviewed';
    // ★ 编辑器现在是**独立的全屏界面**（#screen-editor），不再是卡牌库的侧边栏
    show('editor');
    $('#edArt').src = cardArt(c);
    $('#edName').value = c.name || '';
    $('#edCost').value = c.cost == null ? '' : c.cost;
    $('#edAtk').value = c.attack == null ? '' : c.attack;
    $('#edDef').value = c.defense == null ? '' : c.defense;
    $('#edOp').value = c.opCost == null ? '' : c.opCost;
    // 巡航舰的双攻击值（第二攻击力 = 打非太空目标时用）
    const dual = c.dualAttack || null;
    $('#edDual').checked = !!dual;
    $('#edAtk2').value = dual && dual.normal != null ? dual.normal : '';
    $('#edDualVs').value = dual && dual.vsType ? (Array.isArray(dual.vsType) ? dual.vsType[0] : dual.vsType) : 'space';
    $('#edCardType').value = c.cardType || 'unit';
    $('#edUnitType').value = c.unitType || '';
    $('#edSet').value = c.set || '';
    // ★ 体系（卡牌元数据，与 attack/cost 同级）：数组用「，」回填，便于继续编辑
    if ($('#edSystem')) $('#edSystem').value = Array.isArray(c.system) ? c.system.join('，') : (c.system || '');
    if ($('#edRarity')) $('#edRarity').value = c.rarity || '';
    if ($('#edShowName')) $('#edShowName').checked = !!c.showName;   // 卡名叠字开关
    // ★ 词条要**连数值一起回填**：带 x 的词条（重甲3 / 充能2）光有 key 没有值是不生效的。
    //   以前只写 Object.keys(kwMap) → 回填后数值丢失，再一保存数值就没了。
    $('#edKeywords').value = Object.keys(c.kwMap || {}).map(function (k) {
      const v = (c.kwValues || {})[k];
      return (v == null || v === true || v === '') ? k : (k + v);
    }).join(',');
    $('#edText').value = c.text || '';
    $('#edEffects').value = JSON.stringify(c.effects || [], null, 1);
    const openNotes = [];
    if (c.notes) openNotes.push('转写备注：' + c.notes);
    if (Array.isArray(c.compileWarnings) && c.compileWarnings.length) openNotes.push('自动解析警告：\n' + c.compileWarnings.join('\n'));
    $('#edWarn').textContent = openNotes.join('\n\n');
    const status = $('#edParseStatus');
    if (status) {
      const labels = { 'auto-confirmed': '已完整自动解析', 'manual-confirmed': '已人工确认 DSL', 'needs-review': '需要人工确认', 'unreviewed': '尚未解析或确认' };
      status.textContent = '效果状态：' + (labels[editorEffectStatus] || labels.unreviewed);
      status.className = 'parse-status ' + editorEffectStatus;
    }
  }

  function saveEditor() {
    if (editing && editing.orcImportDraft && !['auto-confirmed', 'manual-confirmed'].includes(editorEffectStatus)) {
      $('#edWarn').textContent = '此卡仍在待核对列表。请完整解析，或核对并修改效果后再保存。';
      return;
    }
    if (!editing) return;
    let fx;
    try { fx = JSON.parse($('#edEffects').value || '[]'); } catch (e) { $('#edWarn').textContent = '效果 DSL 不是合法 JSON：' + e.message; return; }
    const kws = ($('#edKeywords').value || '').split(/[,，\s]+/).filter(Boolean);
    // ★★ 带数值的词条（重甲3 / 充能2 / 情报2）：**必须写进 kwValues**，光有 kwMap 引擎不认。
    //    词条栏写 `armor3` 或 `重甲3` 都行，保存时拆成 key + 数值。
    //    ★ 中文名**必须**反查成引擎 key（KEYWORDS 的 cn → key，如 老兵→veteran、流亡→exile）。
    //      ⚠ 以前的写法是先拿原始名填 kwMap、再 `kwMap[name]!=null ? name : CN2KEY[name]`
    //      —— raw 名永远已在 kwMap 里 → 反查是**死代码**，中文 key 原样存下去，
    //      引擎（只认英文 key）全部静默失效（2026-09-24 老兵升不了级的真凶）。
    const CN2KEY = {};
    Object.keys(KG.KEYWORDS || {}).forEach(function (k) {
      const cn = (KG.KEYWORDS[k] || {}).cn; if (cn) CN2KEY[cn] = k;
    });
    const kwMap = {}, kwValuesSaved = {};
    kws.forEach(function (k0) {
      const m = String(k0).trim().match(/^(.*?)(\d+)$/);
      const name = (m ? m[1] : k0).trim();
      if (!name) return;
      const key = CN2KEY[name] || name;
      kwMap[key] = true;
      if (m && m[2] != null) kwValuesSaved[key] = parseInt(m[2], 10);
    });
    const patch = {
      id: editing.id,
      name: $('#edName').value || editing.name,
      cost: $('#edCost').value === '' ? null : parseInt($('#edCost').value, 10),
      attack: $('#edAtk').value === '' ? null : parseInt($('#edAtk').value, 10),
      defense: $('#edDef').value === '' ? null : parseInt($('#edDef').value, 10),
      opCost: $('#edOp').value === '' ? null : parseInt($('#edOp').value, 10),
      cardType: $('#edCardType').value,
      unitType: $('#edUnitType').value || null,
      set: $('#edSet').value || editing.set,
      // ★ 体系（与 attack/cost 同级、不进 DSL）：允许「，」分隔的多个体系；
      //   清空输入框 = 明确去掉体系（所以这里不学 set 写 `|| 原值`，否则永远删不掉）
      system: (function () {
        const raw = $('#edSystem') ? String($('#edSystem').value || '').trim() : '';
        const arr = raw.split(/[，,、]/).map(function (x) { return x.trim(); }).filter(Boolean);
        if (!arr.length) return null;
        return arr.length === 1 ? arr[0] : arr;
      })(),
      // ★ 卡名叠字开关（默认关：卡面图多半自带名字）
      showName: !!(($('#edShowName') || {}).checked),
      // 自定义稀有度（决定卡组里最多能带几张）
      rarity: $('#edRarity') && $('#edRarity').value ? $('#edRarity').value : editing.rarity,
      token: $('#edRarity') && $('#edRarity').value
        ? ($('#edRarity').value === 'token')
        : editing.token,
      keywords: kws, kwMap: kwMap, kwValues: kwValuesSaved,
      // ★ 卡面机制字段一并保存（drawOnTurn / startInHand / autoUse …）——
      //   它们是**卡牌 meta**，不在 DSL 里，但引擎要读，漏存就等于没写。
      drawOnTurn: (editing.drawOnTurn != null ? editing.drawOnTurn : null),
      startInHand: !!editing.startInHand,
      autoUse: !!editing.autoUse,
      text: $('#edText').value,
      effects: fx,
      effectStatus: editorEffectStatus,
      orc: editing.orc || null,
      compileWarnings: editorEffectStatus === 'needs-review' ? (editing.compileWarnings || []) : [],
      // ★ 卡面级字段一并写顶层（从效果块提取合并）——运行时 promoteCardFields 会做
      //   同样的提升，这里落一份进 localStorage 让数据自描述、编辑器重开能看到。
      cardFields: (function () {
        const out = {};
        (fx || []).forEach(e => { if (e && e.cardFields) Object.assign(out, e.cardFields); });
        return Object.keys(out).length ? out : null;
      })(),
    };
    // 巡航舰的双攻击值
    if ($('#edDual') && $('#edDual').checked) {
      patch.dualAttack = {
        vsType: $('#edDualVs') ? $('#edDualVs').value : 'space',
        value: patch.attack,
        normal: $('#edAtk2').value === '' ? patch.attack : parseInt($('#edAtk2').value, 10),
      };
    } else {
      patch.dualAttack = null;
    }
    S.edits[editing.id] = Object.assign({}, S.edits[editing.id], patch);
    LS.set('edits', S.edits);
    // 自定义卡也写回 custom
    if (editing.orcImportDraft && !S.custom.some(x => x.id === editing.id)) {
      const card = Object.assign({}, editing, patch); delete card.orcImportDraft;
      const drafts = LS.get('orcDrafts', []).filter(d => d.id !== card.id);
      try { writeOrCData(S.custom.concat(card), drafts); S.custom = S.custom.concat(card); }
      catch (e) { $('#edWarn').textContent = '卡牌未保存：' + e.message; return; }
    }
    const ci = S.custom.findIndex(x => x.id === editing.id);
    if (ci >= 0) { S.custom[ci] = Object.assign({}, S.custom[ci], patch); LS.set('custom', S.custom); }
    rebuildPool();
    const merged = S.pool.find(x => x.id === editing.id);
    editing = merged;
    $('#edWarn').textContent = '已保存。';
    renderCollection();
    toast('已保存：' + merged.name);
  }

  function compileEditor() {
    const text = $('#edText').value;
    // 把当前编辑器里的完整卡面参数一并喂给编译器：部分规则（花费、词条、单位类型）依赖它们。
    const meta = {
      id: editing && editing.id,
      cardType: $('#edCardType').value,
      unitType: $('#edUnitType') ? ($('#edUnitType').value || null) : null,
      cost: $('#edCost') && $('#edCost').value !== '' ? parseInt($('#edCost').value, 10) : null,
      attack: $('#edAtk') && $('#edAtk').value !== '' ? parseInt($('#edAtk').value, 10) : null,
      defense: $('#edDef') && $('#edDef').value !== '' ? parseInt($('#edDef').value, 10) : null,
      name: $('#edName') ? ($('#edName').value || '') : '',
    };
    const res = KG.OrC.compile(text, meta, {pool:S.pool.concat(editing ? [Object.assign({}, editing, meta)] : [])});
    let parsedKeywords;
    try { parsedKeywords = KG.cardImport.normalize({name:meta.name||'卡牌',keywords:$('#edKeywords').value}); }
    catch (e) { res.warnings.push(e.message); res.complete = false; }
    editing = Object.assign(editing || {}, { compileWarnings: res.warnings.slice() });
    // 部分失败时只展示诊断，不把不完整产物写进 DSL，避免覆盖已有的手工效果。
    if (!res.warnings.length) $('#edEffects').value = JSON.stringify(res.effects, null, 1);
    /* ★★ 卡面字段（cardFields）**不进 DSL** —— 它们是卡牌 meta 机制（如
     *   「在第N回合抽取」→ drawOnTurn:N、「在第一回合抽取，抽取：使用」→ startInHand/autoUse），
     *   不是对战效果原语，所以 DSL 里看不到是**正常的**。
     *   但它们**必须存进卡数据**，否则引擎读不到 → 表现为"点了自动解析、保存了，还是没反应"。
     *   以前这里把 cardFields 直接丢掉 → 「在第N回合抽取」永远不生效。 */
    if (res.complete && res.cardFields && Object.keys(res.cardFields).length) {
      editing = Object.assign(editing || {}, res.cardFields);
    }
    if (res.complete) {
      editing.orc = {version:res.version,legacyOps:res.legacyOps,origin:'text'};
      const kw = parsedKeywords;
      Object.assign(kw.kwMap,res.kwMap);Object.assign(kw.kwValues,res.kwValues);
      $('#edKeywords').value = Object.keys(kw.kwMap).map(k => k + (kw.kwValues[k] == null ? '' : kw.kwValues[k])).join(',');
    }
    const parts = [];
    if (res.warnings.length) {
      editorEffectStatus = 'needs-review';
      parts.push('自动解析未完整：已保留当前 DSL，没有应用部分结果。请按下方警告修订原文或手写 DSL。修改 DSL 后保存会记录为人工确认。\n' + res.warnings.join('\n'));
    } else {
      editorEffectStatus = 'auto-confirmed';
      parts.push('解析通过：已生成效果与词条；实际结算仍需对战核对。');
    }
    const status = $('#edParseStatus');
    if (status) {
      const labels = { 'auto-confirmed': '完整自动解析', 'needs-review': '需要人工确认' };
      status.textContent = '效果状态：' + labels[editorEffectStatus];
      status.className = 'parse-status ' + editorEffectStatus;
    }
    // 只有当"当前生效的效果"与"按卡面文本重新解析的结果"**不同**时才提示会被覆盖。
    //   ★ 落盘（effects-data.js 由编译器生成）之后，两者通常一致 —— 此时再提示
    //     "有手工校对过的效果"会**误导**用户以为没解析成功。
    const overlay = global.KG_EFFECT_OVERLAY || {};
    const id = editing && editing.id;
    if (id && overlay[id] && overlay[id].effects && overlay[id].effects.length) {
      const same = JSON.stringify(overlay[id].effects) === JSON.stringify(res.effects);
      if (!same) {
        parts.push('提示：这张卡当前生效的效果与自动解析结果不同（' + overlay[id].effects.length + ' 块）。完整解析结果写入 DSL 后，保存才会应用。');
      }
    }
    $('#edWarn').textContent = parts.join('\n\n');
  }

  /* ------------------------------------------------------------ 文件导入 */
  function writeOrCData(custom, drafts) {
    const changes = [['kg.custom', JSON.stringify(custom)], ['kg.orcDrafts', JSON.stringify(drafts)]];
    const old = changes.map(([key]) => [key, localStorage.getItem(key)]);
    try {
      if (old[0][1] && old[0][1] !== '[]' && old[0][1] !== changes[0][1]) localStorage.setItem('kg.custom.bak', old[0][1]);
      changes.forEach(([key, value]) => localStorage.setItem(key, value));
    } catch (e) {
      old.forEach(([key, value]) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (_) {} });
      throw e;
    }
  }
  function showOrCReport(report, notes) {
    S.lastOrCReport = report;
    const st = $('#importStatus'); if (!st) return;
    const sum = report.summary;
    st.textContent = '已导入 ' + sum.ready + ' 张，待核对 ' + sum.pending + ' 张，资料错误 ' + sum.rejected + ' 条，保留已有卡 ' + sum.skipped + ' 张。';
    const log = document.createElement('div'); log.className = 'import-log';
    log.textContent = (notes || []).concat(report.pending.concat(report.rejected).map(x => (x.name || '第' + x.row + '条') + '：' + x.messages.join('；'))).slice(0, 30).join('\n'); st.appendChild(log);
    const download = document.createElement('button'); download.textContent = '导出解析报告与待核对资料';
    download.onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type:'application/json'})); const a = document.createElement('a'); a.href=url; a.download='orc-import-report.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }; st.appendChild(download);
    const drafts = LS.get('orcDrafts', []);
    if (drafts.length) {
      const label = document.createElement('label'); label.textContent = '待核对卡牌：'; const select = document.createElement('select');
      drafts.forEach((d,i) => { const o=document.createElement('option');o.value=i;o.textContent=d.card.name;select.appendChild(o); }); label.appendChild(select); st.appendChild(label);
      const edit = document.createElement('button');edit.textContent='编辑待核对卡牌';edit.onclick=()=>{const d=drafts[Number(select.value)];if(d)openEditor(Object.assign({}, d.card, {effects:d.draftEffects||[], orcImportDraft:true}));};st.appendChild(edit);
    }
  }
  async function importFiles(files) {
    if (S.orcImportBusy) { toast('正在导入，请稍候'); return; }
    S.orcImportBusy = true;
    try {
      const list=Array.from(files), records=[], notes=[], rejected=[], embedded=new Map(), attached=new Map();
      for (const f of list.filter(f=>/\.(json|csv|txt)$/i.test(f.name))) {
        try { const data=KG.cardImport.parse(await f.text(),f.name);records.push(...data.cards);
          Object.entries(data.images).forEach(([name,value])=>embedded.set(name,value));
        } catch(e) { rejected.push({name:f.name,messages:[e.message]}); }
      }
      for (const f of list.filter(f=>/\.(png|jpe?g|webp|gif)$/i.test(f.name))) {
        const rel=f.webkitRelativePath||f.name,stem=f.name.replace(/\.[^.]+$/,''),imageId='custom/'+rel.replace(/\\/g,'/').replace(/\.[^.]+$/,'');
        const matches=records.filter(c=>c&&(c.file===rel||c.file===f.name||c.src===rel||c.id===imageId||c.id===stem||c.name===stem));
        if(matches.length>1){notes.push('图片 '+f.name+' 对应多张卡，未自动分配。');continue;}
        const raw=matches[0]||{id:imageId,name:stem,set:rel.includes('/')?rel.split('/')[0]:'自定义',cardType:'unit',cost:1,attack:1,defense:1,text:'',src:rel};
        if(!matches.length)records.push(raw);
        if(f.size>12*1024*1024){notes.push('图片超过12MB，未保存：'+f.name);continue;}
        attached.set(raw,f);
      }
      const report=KG.cardImport.plan(records,{existing:S.custom,pool:S.pool});
      report.rejected.push(...rejected);report.summary.rejected=report.rejected.length;
      const normalized = new Map(); records.forEach(raw=>{try{normalized.set(KG.cardImport.normalize(raw).id,raw);}catch(_){} });
      const imageUrls={};
      for (const entry of report.entries) {
        const raw=normalized.get(entry.id);let blob=attached.get(raw);
        const b64=raw&&embedded.get(raw.file||raw.src||raw.id);
        if(!blob&&b64){try{const data=String(b64),encoded=data.startsWith('data:')?data.split(',')[1]:data;if(encoded.length>16*1024*1024)throw Error('超过12MB');const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));blob=new Blob([bytes],{type:data.match(/^data:([^;,]+)/)?.[1]||'image/png'});}catch(e){notes.push('卡图格式错误：'+entry.name+'（'+e.message+'）');}}
        if(blob){try{await idbPut(entry.id,blob,true);imageUrls[entry.id]=URL.createObjectURL(blob);}catch(e){notes.push('卡图未能保存：'+entry.name+'（'+e.message+'）');}}
      }
      const custom=S.custom.concat(report.ready), drafts=LS.get('orcDrafts',[]).filter(d=>!report.ready.some(c=>c.id===d.id)&&!report.pending.some(x=>x.id===d.id)).concat(report.pending);
      writeOrCData(custom,drafts);
      S.custom=custom;Object.assign(S.images,imageUrls);rebuildPool();renderCollection();showOrCReport(report,notes);
      toast('导入 '+report.summary.ready+' 张，'+report.summary.pending+' 张待核对');return report;
    } catch(e) {
      const st=$('#importStatus');if(st)st.textContent='导入未保存，原卡牌数据已保留：'+e.message;
      toast('导入未保存：'+e.message);return {error:e.message};
    } finally {S.orcImportBusy=false;}
  }

  /* 保存到基础卡池的卡属于内置卡；未保存的本地导入卡属于自定义卡。 */
  function isCustomCard(c) {
    if (!c || !c.id) return false;
    // 保存到卡池后属于内置卡；只保护尚未保存的本地自定义卡。
    if ((S.base || []).some(function (x) { return x.id === c.id; })) return false;
    if (c.set === '自定义') return true;
    if (typeof c.id === 'string' && c.id.indexOf('custom/') === 0) return true;
    return (S.custom || []).some(function (x) { return x.id === c.id; });
  }

  /* ★ 从 `kg.custom.bak`（上一版自定义卡清单）恢复。
   *   「清除导入」是一键全清、删除卡也是直接把条目滤掉，误操作一次就全没了 ——
   *   这是唯一的自救入口。**只补不覆盖**：现有同 id 的卡保持不动。
   *   控制台也能直接敲：KG.ui.restoreCustomBackup() */
  function restoreCustomBackup() {
    let bak = null;
    try { bak = JSON.parse(localStorage.getItem('kg.custom.bak') || 'null'); } catch (e) { bak = null; }
    if (!Array.isArray(bak) || !bak.length) { toast('没有可恢复的备份（kg.custom.bak 为空）'); return 0; }
    const have = {};
    (S.custom || []).forEach(function (c) { if (c && c.id) have[c.id] = 1; });
    let added = 0;
    bak.forEach(function (c) {
      if (c && c.id && !have[c.id]) { S.custom.push(c); added++; }
    });
    if (!added) { toast('备份里的卡都在（没有需要恢复的）'); return 0; }
    LS.set('custom', S.custom);
    rebuildPool();
    renderCollection();
    toast('已从备份恢复 ' + added + ' 张自定义卡');
    return added;
  }

  function customBackupInfo() {
    try {
      const bak = JSON.parse(localStorage.getItem('kg.custom.bak') || 'null');
      return Array.isArray(bak) ? bak.length : 0;
    } catch (e) { return 0; }
  }

  /* 把某张卡从**所有卡组**里摘掉（删除自定义卡 / 删除内置卡共用）。
   * 卡组里留着已删除卡的 id，开局就会拿到一张不存在的卡 —— 所以删除必摘。 */
  function pruneCardFromDecks(id) {
    let touched = 0;
    ((S.deckLib && S.deckLib.decks) || []).forEach(function (d) {
      if (!d || !d.cards) return;
      const before = d.cards.length;
      d.cards = d.cards.filter(function (x) { return (x && x.id ? x.id : x) !== id; });
      if (d.cards.length !== before) touched++;
    });
    if (touched) { try { LS.set('deckLib', S.deckLib); } catch (e) { } }
    return touched;
  }

  /* ★ 删除**指定的一张**自定义卡（区别于"清除导入"的整批清空）。
   *   四处都要清，漏一处就会留下"幽灵卡"：
   *     ① S.custom（卡定义）  ② IndexedDB 里的卡图  ③ 内存里的 S.images 缓存
   *     ④ **所有卡组的引用** —— 卡组里留着已删除卡的 id，开局就会拿到一张不存在的卡。 */
  async function removeCustomCard(id) {
    if (!id) return false;
    const hit = (S.custom || []).find(function (x) { return x.id === id; });
    if (!hit) return false;
    S.custom = (S.custom || []).filter(function (x) { return x.id !== id; });
    LS.set('custom', S.custom);

    // ②③ 图：删库 + 清内存缓存（objectURL 顺手回收）
    try { await idbDel(id); } catch (e) { }
    if (S.images && S.images[id]) {
      try { URL.revokeObjectURL(S.images[id]); } catch (e) { }
      delete S.images[id];
    }

    // ④ 卡组引用：把这张卡从所有卡组里摘掉
    const touched = pruneCardFromDecks(id);

    // ⑤ 已保存进 nations 的自定义卡 → 一并彻底删除（有服务器时；2026-09-27 存储唯一化）
    //   ⚠ 2026-10-02：用 serverKnown()（ping 探测结论）而不是 location.protocol !==
    //     'file:' —— Android APK 是 https 协议，老判据会误判成"有服务器"，
    //     POST 拿回 Capacitor 的 fallback HTML → 静默失败。同 hasWriteServer() 注释。
    if (serverKnown()) {
      try {
        fetch('/__delete-card', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }),
        }).then(function (r) { return r.json(); }).then(function (rep) {
          if (rep && rep.ok) toast('已从 nations/ 同步删除「' + (hit.name || id) + '」→ 页面即将刷新', 5000) ||
            setTimeout(function () { location.reload(); }, 1400);
        }).catch(function () { });
      } catch (e) { }
    }

    rebuildPool();
    renderCollection();
    try { mpRefreshDecks(); } catch (e) { }
    toast('已删除自定义卡「' + (hit.name || id) + '」' +
      (touched ? ('，并从 ' + touched + ' 个卡组中摘除') : ''));
    return true;
  }

  // 内置卡由是否已在基础卡池中决定，不按 custom/ 前缀或创建时间判断。
  // 删除标记在所有装配层生效，避免本地副本和旧覆盖层把卡补回来。
  function applyBuiltinRemoval(ids, permanent) {
    const removed = Object.assign({}, S.removed || {}), wanted = new Set(ids);
    ids.forEach(function (id) { removed[id] = 1; });
    // 持久化失败时不能显示删除成功，刷新后也不能凭空恢复。
    localStorage.setItem('kg.removed', JSON.stringify(removed));
    S.removed = removed;
    const before = (S.custom || []).length;
    S.custom = (S.custom || []).filter(function (c) { return !wanted.has(c.id); });
    if (before !== S.custom.length) LS.set('custom', S.custom);
    ids.forEach(function (id) { if (S.peerOverrides) delete S.peerOverrides[id]; });
    if (permanent) {
      S.base = (S.base || []).filter(function (c) { return !wanted.has(c.id); });
      global.KG_CARDS = (global.KG_CARDS || []).filter(function (c) { return !wanted.has(c.id); });
      ids.forEach(function (id) {
        if (S.edits) delete S.edits[id];
        if (S.hostFx) delete S.hostFx[id];
        if (global.KG_EFFECT_OVERLAY) delete global.KG_EFFECT_OVERLAY[id];
        if (global.KG_CARD_INDEX) delete global.KG_CARD_INDEX[id];
      });
      LS.set('edits', S.edits || {});
    }
    let touched = 0;
    ids.forEach(function (id) { touched += pruneCardFromDecks(id); });
    const strip = function (deck) { return (deck || []).filter(function (x) { return !wanted.has(x && x.id || x); }); };
    const deck = strip(S.deck); if (deck.length !== (S.deck || []).length) S.deckDirty = true;
    S.deck = deck; S.aiDeck = strip(S.aiDeck);
    rebuildPool(); renderCollection();
    try { mpRefreshDecks(); } catch (e) { }
    return touched;
  }

  async function removeBuiltinCard(id) {
    const result = await removeBuiltinBatch([id], '这张内置卡');
    return !!(result && result.ok && result.deleted);
  }

  async function removeBuiltinBatch(ids, label) {
    if (S.removingBuiltins) { toast('正在删除，请稍候'); return { ok: false }; }
    const valid = [];
    Array.from(new Set(ids || [])).forEach(function (id) {
      const saved = (S.base || []).find(function (c) { return c.id === id; });
      if (!saved || (S.removed && S.removed[id])) return;
      const card = (S.pool || []).find(function (c) { return c.id === id; }) || saved;
      valid.push({ id: id, card: card });
    });
    if (!valid.length) { toast('该范围内没有可删除的内置卡'); return { ok: true, deleted: 0 }; }
    const button = $('#delBuiltinBtn');
    S.removingBuiltins = true; if (button) button.disabled = true;
    try {
      const withServer = await hasWriteServer();
      const message = '删除' + label + '的 ' + valid.length + ' 张卡？\n\n包括已保存到卡池的自定义卡、令牌和衍生卡。尚未保存的本地自定义卡不受影响。\n删除后刷新或重启也不会重新出现；卡牌定义会先备份。';
      if (!await askConfirm(message, { title: '删除内置卡', okText: '删除 ' + valid.length + ' 张', danger: true })) return { ok: false, cancelled: true };
      try {
        let backup = JSON.parse(localStorage.getItem('kg.removed.bak') || '{}');
        if (!backup || typeof backup !== 'object' || Array.isArray(backup)) backup = {};
        valid.forEach(function (v) { backup[v.id] = v.card; });
        localStorage.setItem('kg.removed.bak', JSON.stringify(backup));
      } catch (error) { throw new Error('无法备份卡牌，已停止删除：' + error.message); }
      const wanted = valid.map(function (v) { return v.id; });
      if (withServer) {
        toast('正在删除 ' + wanted.length + ' 张卡…', 5000);
        const response = await fetch('/__delete-cards', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: wanted }),
        });
        let report = null; try { report = await response.json(); } catch (e) { }
        if (!report || !report.ok) {
          if (report && report.sourceChanged) applyBuiltinRemoval(wanted, true);
          const why = report && report.error || (response.status === 404 ? '请重启 PC 游戏后重试' : '删除服务未返回有效结果');
          toast('删除未完成：' + why, 9000);
          return { ok: false, error: why };
        }
      }
      const touched = applyBuiltinRemoval(wanted, withServer);
      const remaining = wanted.filter(function (id) { return S.pool.some(function (c) { return c.id === id; }); });
      if (remaining.length) throw new Error('仍有 ' + remaining.length + ' 张卡未移除');
      toast('已删除 ' + wanted.length + ' 张内置卡' + (touched ? '，并清理相关卡组引用' : ''), 5000);
      return { ok: true, deleted: wanted.length };
    } catch (error) {
      console.error('[删除内置卡]', error);
      toast('删除失败：' + error.message, 9000);
      return { ok: false, error: error.message };
    } finally {
      S.removingBuiltins = false; if (button) button.disabled = false;
    }
  }

  function restoreRemovedCards() {
    const ids = Object.keys(S.removed || {});
    if (!ids.length) { toast('没有被删除的内置卡'); return 0; }
    const available = ids.filter(function (id) { return (S.base || []).some(function (c) { return c.id === id; }); });
    S.removed = {}; LS.set('removed', {});
    rebuildPool(); renderCollection();
    try { mpRefreshDecks(); } catch (e) { }
    toast(available.length ? '已恢复 ' + available.length + ' 张内置卡' : '这些卡已从保存的卡池删除，卡牌定义备份仍然保留');
    return available.length;
  }

  /* 卡牌右键菜单：把"切换异画"和"删除这张自定义卡"放在一起。
   *   ⚠ 异画原先直接用右键切换 —— 现在删除也要用右键，两者会打架。
   *   规则：**有删除项时弹菜单**（让用户选）；只有异画可用时保持"右键直接切换"的手感。 */
  function showCardMenu(ev, c, el) {
    const old = document.getElementById('cardMenu');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const items = [];
    if (hasAltArt(c)) {
      items.push({
        text: useAltArt(c) ? '用原图' : '用异画',
        fn: function () {
          toggleAltArt(c);
          // ★ 攻防块**同步**挪到异画图内块的位置（对位表里配了就有，没配就是默认）；
          //   同一张卡的所有可见副本一起刷（**两个方向都要**：切回原图要把内联样式清掉）
          refreshAltViews(c);
          if (useAltArt(c)) toast('已切到异画（攻防块已按异画对位）· Shift+右键可调对位', 5000);
        },
      });
      items.push({
        text: '异画对位…',
        fn: function () { openAltTune(c); },
      });
    }
    if (isCustomCard(c)) {
      items.push({
        text: '删除这张自定义卡', danger: true,
        fn: async function () {
          if (!await askConfirm('删除自定义卡「' + (c.name || c.id) + '」？\n（会同时从所有卡组里摘除，不可撤销）',
            { title: '删除自定义卡', okText: '删除', danger: true })) return;
          removeCustomCard(c.id);
        },
      });
    } else {
      // 2026-09-24：内置卡也可删除。⚠ 2026-10-02：确认框搬进 removeBuiltinCard 内部了
      //   （要按"有没有服务器"给不同文案，且统一用页面内 askConfirm，不用原生 confirm），
      //   这里**不要再弹一次** —— 原先是双确认，且原生 confirm 在 Electron/WebView 上会静默 false。
      items.push({
        text: '删除这张卡（内置卡）', danger: true,
        fn: function () { removeBuiltinCard(c.id); },
      });
    }
    if (!items.length) return false;

    const menu = document.createElement('div');
    menu.id = 'cardMenu';
    menu.className = 'card-menu';
    items.forEach(function (it) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'card-menu-item' + (it.danger ? ' danger' : '');
      b.textContent = it.text;
      b.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        const m = document.getElementById('cardMenu');
        if (m && m.parentNode) m.parentNode.removeChild(m);
        it.fn();
      });
      menu.appendChild(b);
    });
    // 点别处/滚动就关掉
    const closer = function () {
      const m = document.getElementById('cardMenu');
      if (m && m.parentNode) m.parentNode.removeChild(m);
      document.removeEventListener('click', closer);
    };
    document.addEventListener('click', closer);
    if (document.body && document.body.appendChild) document.body.appendChild(menu);
    const x = (ev && (ev.clientX || 0)) || 0, y = (ev && (ev.clientY || 0)) || 0;
    // 弹出位置：贴着鼠标，但**不许溢出屏幕**（右/下边缘往回收一收，不然最后一条点不到）
    const mw = menu.offsetWidth || 170, mh = menu.offsetHeight || 100;
    const vw2 = (typeof innerWidth === 'number' ? innerWidth : 1280);
    const vh2 = (typeof innerHeight === 'number' ? innerHeight : 800);
    menu.style.left = Math.max(4, Math.min(x, vw2 - mw - 6)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, vh2 - mh - 6)) + 'px';
    return true;
  }

  /* ============================================================ 异画对位面板
   * 卡图里画着攻防块，叠加的数字要盖上去；异画换了模板就得调。
   * 面板里改 = **立刻**写进内存里的对位表（预览/所有卡同步），
   * 「保存到项目」才 POST 给 serve.js 写 game/data/alt-art-ui.json（file:// 下只能复制 JSON 手贴）。 */
  const TUNE_FIELDS = [
    { k: 'x', label: 'X', title: '攻防块**中心**距卡左边的百分比（默认 攻击25 / 防御76）', step: '0.5' },
    { k: 'y', label: 'Y', title: '攻防块**中心**距卡底边的百分比（默认 24.5）', step: '0.5' },
    { k: 'w', label: '宽', title: '块宽（卡宽 %），留空 = 按数字自适应', step: '0.5' },
    { k: 'h', label: '高', title: '块高（卡高 %，默认 14）', step: '0.5' },
    { k: 'fs', label: '字号', title: '字号倍数（1 = 默认大小；0.9 = 小一点，1.15 = 大一点）', step: '0.05' },
  ];
  function closeAltTune() {
    const old = document.getElementById('altTune');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    // ★ 面板里改的对位只刷了预览 → 关掉时把**页面上真实的卡**也刷一遍，
    //   否则"调完存了、卡还是旧的"（制作者口径：改了就要看得见）
    refreshAltViews(S._tuneCard);
  }
  function openAltTune(c) {
    if (!c || !hasAltArt(c)) { toast('这张卡没有异画，先放一张 <卡名>y.png'); return; }
    S._tuneCard = c;                      // 关面板时按这张卡回刷
    closeAltTune();
    // 对位是给"用异画"时看的 → 打开面板就强制用异画，不然你在对着原图调
    S.altArt = S.altArt || {};
    if (!S.altArt[c.id]) { S.altArt[c.id] = 1; LS.set('altArt', S.altArt); }
    refreshAltViews(c);                   // 面板后面那些卡也立刻换成异画

    const box = document.createElement('div');
    box.id = 'altTune';
    box.className = 'alt-tune';
    const head = document.createElement('div');
    head.className = 'at-head';
    head.innerHTML = '<span>异画对位 · ' + (c.name || c.id) + '</span>';
    const xBtn = document.createElement('button');
    xBtn.type = 'button'; xBtn.className = 'at-x'; xBtn.textContent = '✕'; xBtn.title = '关闭（改动只留在本次会话，除非点保存）';
    xBtn.addEventListener('click', closeAltTune);
    head.appendChild(xBtn);
    box.appendChild(head);

    // 预览：一张放大到 200px 宽的卡面，改动即时反映
    const pv = document.createElement('div');
    pv.className = 'at-preview';
    const pvCard = cardEl(c);
    pvCard.style.width = '200px';
    pvCard.style.height = Math.round(200 * 701 / 500) + 'px';
    if (pvCard.classList) pvCard.classList.add('alt-on');
    pv.appendChild(pvCard);
    box.appendChild(pv);

    const inputs = {};
    ['atk', 'def'].forEach(function (kind) {
      const row = document.createElement('div');
      row.className = 'at-row';
      const tag = document.createElement('span');
      tag.className = 'at-tag';
      tag.textContent = kind === 'atk' ? '攻击' : '防御';
      row.appendChild(tag);
      inputs[kind] = {};
      TUNE_FIELDS.forEach(function (f) {
        const cell = document.createElement('label');
        cell.className = 'at-cell';
        cell.title = f.title;
        cell.innerHTML = '<i>' + f.label + '</i>';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.step = f.step; inp.placeholder = '默认';
        inp.dataset.kind = kind; inp.dataset.field = f.k;
        inp.addEventListener('input', readTune);
        cell.appendChild(inp);
        row.appendChild(cell);
        inputs[kind][f.k] = inp;
      });
      box.appendChild(row);
    });

    // 样式开关（两组共用）：异画自己画了数字时，勾上「不画深底」让叠加数字直接落在图上
    const optRow = document.createElement('div');
    optRow.className = 'at-row at-opt';
    const bgLab = document.createElement('label');
    bgLab.className = 'at-check';
    bgLab.title = '异画图里已经画了攻防数字时勾上：叠加块不再画深色底，只留数字（动态加成照样看得到）';
    const bgChk = document.createElement('input');
    bgChk.type = 'checkbox';
    bgChk.addEventListener('change', function () { if (bgChk.checked) covChk.checked = false; readTune(); });
    bgLab.appendChild(bgChk);
    bgLab.appendChild(document.createTextNode('不画底（透明）'));
    optRow.appendChild(bgLab);
    // ★ 盖住图内画的数字（2026-09-24 制作者：异画图里画的攻击力和真实值不一致 → 用实心底盖掉）
    //   和「不画底」互斥，两个都勾按"盖住"算
    const covLab = document.createElement('label');
    covLab.className = 'at-check';
    covLab.title = '图里画的攻防数字和真实值不一致时勾上：叠加块画**实心底**把图内数字盖掉（宽度不够就用上面的「宽/高」撑大）';
    const covChk = document.createElement('input');
    covChk.type = 'checkbox';
    covChk.addEventListener('change', function () { if (covChk.checked) bgChk.checked = false; readTune(); });
    covLab.appendChild(covChk);
    covLab.appendChild(document.createTextNode('盖住图内数字（实心底）'));
    optRow.appendChild(covLab);
    const colorInp = document.createElement('input');
    colorInp.type = 'text'; colorInp.className = 'at-color'; colorInp.placeholder = '颜色（留空=白）';
    colorInp.title = '数字颜色，CSS 颜色值（如 #ffffff / #1b1b1b）；留空 = 默认白';
    colorInp.addEventListener('input', readTune);
    optRow.appendChild(colorInp);
    box.appendChild(optRow);

    const hint = document.createElement('div');
    hint.className = 'at-hint';
    hint.textContent = 'X/Y 是攻防块的**中心**位置（%卡宽/卡高）。改完点「保存到项目」，下次开游戏还在。';
    box.appendChild(hint);

    const acts = document.createElement('div');
    acts.className = 'at-actions';
    const mkBtn = function (text, cls, fn, title) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = cls || 'ghost'; b.textContent = text;
      if (title) b.title = title;
      b.addEventListener('click', fn);
      acts.appendChild(b);
      return b;
    };
    mkBtn('重置为默认', 'ghost', function () {
      const T = altUiTable();
      delete T[c.id];
      fillInputs();
      applyAltGeometry(pvCard, c);
      toast('已重置（点「保存到项目」才会写文件）');
    });
    mkBtn('复制 JSON', 'ghost', function () {
      const T = altUiTable();
      const snippet = T[c.id] ? ('"' + c.id + '": ' + JSON.stringify(T[c.id])) : ('"' + c.id + '": {}');
      copyText(snippet, '已复制该卡的 JSON 片段 → 粘进 game/data/alt-art-ui.json');
    });
    mkBtn('保存到项目', 'primary', function () { saveAltTune(c, pvCard, this); },
      '写进 game/data/alt-art-ui.json（需要 serve.js 起的服务器；file:// 下请用「复制 JSON」）');
    box.appendChild(acts);

    if (document.body && document.body.appendChild) document.body.appendChild(box);
    fillInputs();
    applyAltGeometry(pvCard, c);

    function curVal(kind, k) {
      const p = kind + '.' + k;
      const T = altUiTable()[c.id] || {};
      const g = T[kind] || {};
      return (g[k] == null) ? '' : String(g[k]);
    }
    function fillInputs() {
      ['atk', 'def'].forEach(function (kind) {
        TUNE_FIELDS.forEach(function (f) { inputs[kind][f.k].value = curVal(kind, f.k); });
      });
      const T = altUiTable()[c.id] || {};
      bgChk.checked = !!((T.atk && T.atk.bg === 0) || (T.def && T.def.bg === 0));
      covChk.checked = !!(altCoverOf(T.atk) || altCoverOf(T.def));
      colorInp.value = (T.atk && T.atk.color) || (T.def && T.def.color) || '';
    }
    /* 输入即写进内存表（预览/场上所有卡都能同步看到），合法值才写 */
    function readTune() {
      const T = altUiTable();
      const one = {};
      const noBg = !!bgChk.checked;
      const cover = !!covChk.checked;
      const col = String(colorInp.value || '').trim();
      const color = /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(col) ? col : null;
      ['atk', 'def'].forEach(function (kind) {
        const g = {};
        TUNE_FIELDS.forEach(function (f) {
          const v = inputs[kind][f.k].value;
          if (v === '' || v == null) return;
          const n = parseFloat(v);
          if (!isFinite(n)) return;
          g[f.k] = n;
        });
        if (noBg && !cover) g.bg = 0;             // 两个都勾 → 按"盖住"算（互斥）
        else if (cover) g.bg = 1;
        if (color) g.color = color;
        if (Object.keys(g).length) one[kind] = g;
      });
      if (Object.keys(one).length) T[c.id] = one; else delete T[c.id];
      applyAltGeometry(pvCard, c);
    }
    S.altTuneRead = readTune;      // 给自动化测试用
    S.altTunePreview = pvCard;
  }
  S.openAltTune = openAltTune;

  function saveAltTune(c, pvCard, btn) {
    const ui = altUiTable()[c.id] || null;
    // ⚠ 2026-10-02：serverKnown() 取代"协议不是 file: 就当有服务器"。
    //   Android APK 是 https://localhost（Capacitor），拿不到 /__alt-art-ui，
    //   POST 会 fallback 回 index.html → r.json() 抛 → 只剩一句"保存失败"。
    if (!serverKnown()) {
      copyText('"' + c.id + '": ' + JSON.stringify(ui || {}), '已复制（服务器不可用）→ 粘进 game/data/alt-art-ui.json');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    fetch('/__alt-art-ui', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.id, ui: ui }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (btn) { btn.disabled = false; btn.textContent = '保存到项目'; }
      if (j && j.ok) toast('已写入 ' + j.file + '（对位随之生效，刷新也在）', 7000);
      else { toast('保存失败：' + ((j && j.error) || '未知') + ' → 可用「复制 JSON」手贴', 9000); if (btn) { btn.disabled = false; } }
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '保存到项目'; }
      toast('保存失败（' + (e && e.message) + '）→ 可用「复制 JSON」手贴', 9000);
    });
  }

  function exportCards() {
    const data = JSON.stringify({ cards: S.pool }, null, 1);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cards.json';
    a.click();
  }

  /* 招安自定义卡（原"固化"，2026-09-24 制作者改名）的**共用打包逻辑**（两个入口都用它）：
   *   · 自定义卡的元数据在 localStorage（kg.custom），卡图在 IndexedDB（kg-cards）—— 都是浏览器私有存储，
   *     换浏览器/清缓存就没了，也拷不进项目。
   *   · 这个包把卡图转成 base64，交给 game/tools/fix-custom.js → 图落成真实 png、卡写进 extra-cards.json。
   * ⚠ effects 是**当前生效的那一份**，原样带走 —— 招安过程不会重新解析卡面（以人工确认为准）。 */
  async function buildCustomFixPack() {
    const custom = (S.custom || []);
    // ★ 内置卡的手工修改（S.edits，按 id 存 localStorage）也要一起招安（2026-09-25 制作者要求）：
    //   否则"在制卡台里改过的内置卡"永远只活在这台电脑的浏览器里，手机/别的浏览器永远看不到。
    const builtinEditIds = Object.keys(S.edits || {}).filter(id => id && id.indexOf('custom/') !== 0);
    if (!custom.length && !builtinEditIds.length) { toast('没有自定义卡，也没有内置卡修改'); return null; }
    // ⚠ idbAll() 返回的是**卡图的 blob: URL**（显示用），不是 Blob 本身。
    //   直接把 URL 丢给 FileReader 会报 "parameter 1 is not of type 'Blob'" → 走 idbAllRaw()。
    const imgs = await idbAllRaw();                    // {id: Blob}
    // 统一入口：Blob / blob:URL / dataURL 都能吃 → 纯 base64 字符串
    const asDataUrl = async (b) => {
      if (!b) return null;
      if (typeof b === 'string' && /^blob:/i.test(b)) {
        if (typeof fetch !== 'function') return null;
        try { b = await (await fetch(b)).blob(); } catch (e) { return null; }
      } else if (typeof b === 'string' && /^data:/i.test(b)) {
        return b;                                      // 已经是 dataURL
      }
      if (!b || typeof Blob === 'undefined' || !(b instanceof Blob)) return null;
      return await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => res(null);
        fr.readAsDataURL(b);
      });
    };
    const blobToB64 = async (b) => {
      const d = await asDataUrl(b);
      return d ? d.replace(/^data:[^,]*,/, '') : null;
    };
    const out = { format: 'kards-custom-export', version: 1, cards: [], edits: [], images: {} };
    for (const c of custom) {
      // ★ 自定义卡自己的手工修改（如果有）在导出时就地合并 —— 它走 cards 通道，不进 edits
      const c2 = Object.assign({}, c, (S.edits && S.edits[c.id]) || {});
      const base = String(c2.src || (c2.name + '.png')).replace(/\\/g, '/').replace(/^.*\//, '');
      const file = '自定义/' + base;                    // 招安时统一收进项目根的「自定义/」目录
      out.cards.push({
        id: c2.id, name: c2.name, set: c2.set, cardType: c2.cardType, unitType: c2.unitType,
        cost: c2.cost, attack: c2.attack, defense: c2.defense, opCost: c2.opCost,
        keywords: c2.keywords || [], text: c2.text || '', effects: c2.effects || [],
        rarity: c2.rarity, file: file,
      });
      const b = (imgs && imgs[c.id]) || null;
      if (b) {
        const b64 = await blobToB64(b);
        if (b64) out.images[file] = b64;               // 取不到就跳过（后面计数会显示为"缺图"）
      }
    }
    // ★ 内置卡修改：**补丁原样打包**（和 saveEditor 写进 S.edits 的形状一致 —— 部分字段）。
    //   fix-custom.js 把它落到 game/data/builtin-edits.json，merge.js 重建卡池时按 id 叠加
    //   到内置卡上（合并顺序与运行时 cardDef 的 Object.assign 相同，电脑看到什么就落什么）。
    out.edits = builtinEditIds.map(id => Object.assign({ id: id }, S.edits[id]));
    out.__withImg = Object.keys(out.images).length;
    out.__noImg = out.cards.length - out.__withImg;
    out.__edits = out.edits.length;
    return out;
  }
  S.buildCustomFixPack = buildCustomFixPack;

  /* 「导出保存名单」——打包下载 JSON（拿不到服务器时的退路）。
   *   下载的 kards-custom-export.json 需要人工把它并进 nations/*.json（命令行工具已随存储唯一化禁用）。 */
  async function exportCustomForFix() {
    const pack = await buildCustomFixPack();
    if (!pack) return;
    const withImg = pack.__withImg, noImg = pack.__noImg;
    delete pack.__withImg; delete pack.__noImg;
    const blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kards-custom-export.json';
    a.click();
    toast('保存名单已导出 ' + pack.cards.length + ' 张（含卡图 ' + withImg + (noImg ? '，缺图 ' + noImg : '') +
      (pack.edits && pack.edits.length ? '，内置卡修改 ' + pack.edits.length + ' 条' : '') +
      '）→ 离线导出只是备份；正式保存请从「启动游戏.cmd / node game/tools/serve.js」打开后一键保存', 8000);
  }

  /* ★★ 「保存到卡池」（2026-09-27 由"一键招安"改制，Alan）：把包直接 POST 给本地服务器
   *   （serve.js 的 /__save-cards），服务器把卡与修改**直接写进 nations/*.json（唯一存储）**、
   *   卡图落成真实 png，然后自动重建运行时产物并刷新页面 ——
   *   保存后只能被手动修改（所有自动写入脚本已禁用）。 */
  async function fixAllCustom() {
    const pack = await buildCustomFixPack();
    if (!pack) return;
    const withImg = pack.__withImg, noImg = pack.__noImg;
    delete pack.__withImg; delete pack.__noImg;
    // ⚠ 2026-10-02：先真探测服务器，别只看协议。Android APK 是 https://localhost，
    //   protocol 不是 file:，老判据会当成"能写" → POST 拿回 fallback 的 index.html →
    //   r.json() 抛 → 只剩一句"保存失败"。同理 fetch 不可用时也直接说清楚。
    if (typeof fetch !== 'function') {
      toast('当前环境没有 fetch，无法保存 → 请从「启动游戏.cmd / node game/tools/serve.js」打开', 10000);
      return;
    }
    if (!await hasWriteServer()) {
      toast('没检测到本地服务器（启动游戏.cmd / serve.js），无法写入 nations/ → ' +
        '手机版 / 离线版只能导出备份（点「导出保存名单」），改不动源文件', 12000);
      console.warn('[保存到卡池] hasWriteServer() = false，protocol=' + location.protocol);
      return;
    }
    toast('正在保存 ' + pack.cards.length + ' 张（含卡图 ' + withImg +
      (pack.edits && pack.edits.length ? '，内置卡修改 ' + pack.edits.length + ' 条' : '') + '）…', 4000);
    try {
      const r = await fetch('/__save-cards', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pack),
      });
      let rep = null;
      try { rep = await r.json(); } catch (e) { rep = null; }
      if (!rep || !rep.ok) {
        toast('保存失败：' + ((rep && rep.error) || ('HTTP ' + r.status)), 12000);
        return;
      }
      toast('已保存进 nations/（新增 ' + rep.added + ' / 更新 ' + rep.replaced +
        '，修改 ' + rep.edits + ' 条，卡图 ' + rep.images + ' 张' + (rep.imgMiss && rep.imgMiss.length ? '，缺图 ' + rep.imgMiss.length : '') +
        '）→ 只能手动修改，页面即将刷新', 9000);
      setTimeout(function () { location.reload(); }, 1600);
    } catch (e) {
      toast('保存失败（' + (e && e.message) + '）：需要从「启动游戏.cmd / node game/tools/serve.js」打开', 12000);
    }
  }
  S.fixAllCustom = fixAllCustom;

  // 「重新解析」：把卡面文本重新喂给编译器。
  //   ★ 落盘（effects-data.js 由编译器生成）之后，overlay 里存的**就是编译器产物**，
  //     所以判据是"重编译结果 vs 当前生效效果"的对比，而不是"overlay 有 effects 就跳过"——
  //     后者会让每张卡都 noChange、按钮形同失效（用户看到的正是"点了没反应/无法自动解析"）。
  //   只自动更新来源明确标记为 auto-confirmed 的旧解析结果。人工确认或旧版本来源不明的
  //   S.edits 都作为权威效果保留；有编译警告的卡也跳过。并如实汇报变更与待审核项。
  function textHasSentence(text) {
    // 卡面除了"词条单词"之外还有没有真正的句子？只有词条（如"闪击 游击"）的卡不需要效果，
    // 编译器产出空 = 正常，不能算"未解析"，否则报告里全是噪音。
    let t = String(text || '');
    const kws = (global.KG && global.KG.KEYWORDS) || {};
    Object.keys(kws).forEach(k => {
      if (kws[k] && kws[k].cn) t = t.split(kws[k].cn).join(' ');
    });
    t = t.replace(/[a-zA-Z]+/g, ' ').replace(/[0-9]+/g, ' ');   // 英文词条 id / 数字（如"重甲1"）
    t = t.replace(/[ 　\t\r\n，,。、；;：:（）()「」“”"'·—\-]+/g, '');
    return t.length > 1;
  }
  function recompileAll() {
    const edits=Object.assign({},S.edits),notes=[];let changed=0,preserved=0,review=0,same=0;
    for(const c of S.pool){
      if(!c.text)continue;
      const r=KG.OrC.compile(c.text,c,{pool:S.pool});
      if(!r.complete){review++;notes.push(c.name+'：'+r.warnings.join('；'));continue;}
      const fields=Object.assign({},r.cardFields,{effects:r.effects,kwMap:Object.assign({},c.kwMap,r.kwMap),kwValues:Object.assign({},c.kwValues,r.kwValues),keywords:[...new Set([...(c.keywords||[]),...r.keywords])],effectStatus:'auto-confirmed',compileWarnings:[],orc:{version:r.version,legacyOps:r.legacyOps,origin:'text'}});
      if(JSON.stringify(c.effects||[])===JSON.stringify(r.effects)&&Object.keys(r.cardFields).every(k=>JSON.stringify(c[k])===JSON.stringify(r.cardFields[k]))&&Object.keys(r.kwMap).every(k=>c.kwMap?.[k]===r.kwMap[k])&&Object.keys(r.kwValues).every(k=>c.kwValues?.[k]===r.kwValues[k])){same++;continue;}
      if(c.effectStatus!=='auto-confirmed'&&((c.effects||[]).length||S.edits[c.id])){preserved++;continue;}
      edits[c.id]=Object.assign({},edits[c.id],fields);changed++;
    }
    try{localStorage.setItem('kg.edits',JSON.stringify(edits));}catch(e){toast('重新解析未保存，原效果已保留：'+e.message);return;}
    S.edits=edits;rebuildPool();renderCollection();
    const msg='重新解析：更新 '+changed+' 张，相同 '+same+' 张，保留手工效果 '+preserved+' 张，待核对 '+review+' 张。';
    const st=$('#importStatus');if(st){st.textContent=msg;const log=document.createElement('div');log.className='import-log';log.textContent=notes.slice(0,30).join('\n');st.appendChild(log);}toast(msg);
  }

  /* ---------------------------------------------------------------- 绑定 */
  /* ==========================================================================
   * ★ 手机端总开关（2026-09-25）
   *
   * 判定规则（写在 <html> 的 .mobile-ui 类上，CSS 全部以它为前提）：
   *   宽度 ≤ 1000 且 高度 ≤ 560        → 手机横屏（主力场景）
   *   宽度 ≤ 560 或 主指针为 coarse    → 手机竖屏 / 触摸设备（引导用户转横屏）
   * 用类而不是纯 @media：平板横屏、折叠屏展开、桌面窄窗口都能落到正确分支，
   * 而且**测试可以直接给 <html> 加类**来覆盖手机路径（迷你 DOM 里没法模拟媒体查询）。
   *
   * ⚠ 这个类只影响**布局**，不参与任何引擎/规则逻辑。
   * ========================================================================== */
  function detectMobileUI() {
    if (typeof document === 'undefined' || !document.documentElement) return false;
    const w = (global.innerWidth != null) ? global.innerWidth : 1280;
    const h = (global.innerHeight != null) ? global.innerHeight : 800;
    let coarse = false;
    try {
      if (global.matchMedia) coarse = global.matchMedia('(pointer: coarse)').matches;
    } catch (e) { }
    // ★ 平板修正（2026-09-25）：coarse（触屏）不再一票否决 —— 否则 iPad 横屏 1180x820
    //   也落进手机分支，全套 52px 蚂蚁卡摊在大屏上。触屏但短边 ≥600（平板/折叠屏展开）
    //   走桌面布局（触屏交互另有 hover:none / touch-action 适配，不靠 mobile-ui 分支）。
    //   短边卡 600：主流手机短边 ≤430，小平板（iPad mini）768，中间没有真实机型。
    const shortSide = Math.min(w, h);
    const isPhone = coarse ? (shortSide < 600) : ((w <= 1000 && h <= 560) || w <= 560);
    document.documentElement.classList.toggle('mobile-ui', !!isPhone);
    if (typeof document.body !== 'undefined' && document.body && document.body.classList) {
      document.body.classList.toggle('mobile-ui', !!isPhone);
    }
    S.mobileUI = !!isPhone;
    return isPhone;
  }
  function isMobileUI() { return !!(S.mobileUI != null ? S.mobileUI : detectMobileUI()); }

  /* 手机端额外的 DOM（只建一次）：
     · #navDrawerBtn —— 顶栏「☰」，把导航收进抽屉（横屏放不下 4 个导航按钮）
     · #navDrawer   —— 导航抽屉
     · #mobileTools —— 右上的「⛶ 全屏 / ★设置」工具组
     桌面端这些节点一律 display:none（CSS 里控制），DOM 存在也无害。 */
  function buildMobileChrome() {
    if (typeof document === 'undefined') return;
    const topbar = $('#topbar');
    if (!topbar) return;
    /* ★ 2026-10-02 顶边栏取消：手机端 #topbar 整条 display:none（CSS 末段），
       导航全部走左侧抽屉。抽屉项不再镜像顶栏（顶栏都藏了，镜像没有意义），
       改为显式四项：对战 / 卡牌库 / 卡组构筑 / 界面设置（规则不进手机导航）。 */
    if (!$('#navDrawerBtn')) {
      const b = document.createElement('button');
      b.id = 'navDrawerBtn'; b.className = 'nav-btn only-mobile';
      b.type = 'button'; b.title = '菜单'; b.textContent = '☰';
      // 挂 #app 直下而不是 topbar 里 —— topbar 整条隐藏后按钮必须浮在层外才可见
      (topbar.parentElement || document.body).insertBefore(b, topbar.nextSibling);
      b.addEventListener('click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        hideTip(); document.body.classList.remove('side-open');
        if (document.body) document.body.classList.toggle('nav-open');
      });
    }
    if (!$('#navDrawer')) {
      const d = document.createElement('div');
      d.id = 'navDrawer';
      // 显式导航项（不镜像顶栏）：规则不进手机端导航；「界面设置」是手机专属屏
      [['battle', '对战'], ['collection', '卡牌库'], ['decklib', '卡组构筑'], ['settings', '界面设置']]
        .forEach(function (pair) {
          const m = document.createElement('button');
          m.type = 'button';
          m.className = 'nav-btn';                 // show() 按 .nav-btn 切高亮
          m.dataset.screen = pair[0];
          m.textContent = pair[1];
          m.addEventListener('click', function () {
            if (document.body) document.body.classList.remove('nav-open');
            show(m.dataset.screen);
          });
          d.appendChild(m);
        });
      if (document.body) document.body.appendChild(d);
      if (document.addEventListener) {
        document.addEventListener('click', function (ev) {
          if (!document.body || !document.body.classList) return;
          if (!document.body.classList.contains('nav-open')) return;
          const t = ev.target;
          if (t && t.closest && (t.closest('#navDrawer') || t.closest('#navDrawerBtn'))) return;
          document.body.classList.remove('nav-open');
        });
        // ★ 手机：设置抽屉（side-open）点外部关闭 —— 原来抽屉打开后 ★设置 藏在
        //   自动隐藏的顶栏里，没有任何关闭途径（"侧边栏收不回去"）。与 nav-open 同款：
        //   点抽屉本体 / ★设置 / 常驻 ☰ 以外的地方 = 收起。
        document.addEventListener('click', function (ev) {
          if (!document.body || !document.body.classList) return;
          if (!document.body.classList.contains('side-open')) return;
          const t = ev.target;
          if (t && t.closest && (t.closest('#sidePanel') || t.closest('#sideToggle') || t.closest('#sidePinBtn'))) return;
          document.body.classList.remove('side-open');
        });
      }
    }
    if (!$('#mobileTools')) {
      const t = document.createElement('div');
      t.id = 'mobileTools';
      // 把桌面顶栏里那两个 only-mobile 按钮**搬**进来（不新建，事件绑定跟着节点走）
      // ★ 2026-10-02：topbar 整条隐藏后，#mobileTools 挂 body 直下由 CSS 浮在右上角
      ['#fsToggle', '#sideToggle'].forEach(function (sel) {
        const n = topbar.querySelector(sel);
        if (n) t.appendChild(n);
      });
      if (document.body) document.body.appendChild(t);
      else topbar.appendChild(t);
    }
    if (isMobileUI() && !$('#mobileBackdrop')) {
      const mask = document.createElement('div'); mask.id = 'mobileBackdrop';
      mask.addEventListener('click', function () { document.body.classList.remove('nav-open', 'side-open'); });
      document.body.appendChild(mask);
      const prompt = $('#prompt'), battle = $('#battle'), hand = $('#handBar');
      if (prompt && battle && hand) battle.insertBefore(prompt, hand);
      // 抽屉和遮罩放在相同的根层，避免被战场的 isolation 困住。
      const side = $('#sidePanel');
      if (side) {
        document.body.appendChild(side);
        const close = document.createElement('button'); close.id = 'mobileSideClose'; close.type = 'button';
        close.className = 'ghost'; close.textContent = '关闭对局设置';
        close.addEventListener('click', function () { document.body.classList.remove('side-open'); });
        side.insertBefore(close, side.firstChild);
      }
      const pin = $('#sidePinBtn'); if (pin) { pin.textContent = '⚙'; pin.setAttribute('aria-label', '对局设置'); }
      const fullscreen = $('#fsToggle'), nav = $('#navDrawer');
      if (fullscreen && nav) nav.appendChild(fullscreen);
      const tools = $('#screen-collection .coll-actions');
      if (tools) {
        const details = document.createElement('details'); details.id = 'mobileCardTools';
        const summary = document.createElement('summary'); summary.textContent = '管理'; details.appendChild(summary);
        tools.parentNode.insertBefore(details, tools); details.appendChild(tools);
      }
      // Keep search and pagination visible; secondary filters open in a popover.
      function foldFilters(id, host, keep, label) {
        if (!host || $('#'+id)) return;
        const details=document.createElement('details');details.id=id;details.className='mobile-filter';
        const summary=document.createElement('summary');summary.textContent=label;details.appendChild(summary);
        const fields=document.createElement('div');fields.className='mobile-filter-fields';details.appendChild(fields);
        Array.from(host.children).filter(el=>!keep.includes(el.id)&&!el.classList.contains('pager')).forEach(el=>fields.appendChild(el));
        const pager=host.querySelector('.pager');host.insertBefore(details,pager||null);
      }
      foldFilters('mobileCollectionFilters',$('.coll-filters'),['collSearch','collCount'],'筛选');
      foldFilters('mobileDeckFilters',$('#screen-deck .filters'),['cardSearch'],'筛选');
      const nation=$('#nationBar'),head=$('#playerDeckSide .deck-side-head');
      if(nation&&head&&!$('#mobileDeckNation')){
        const details=document.createElement('details');details.id='mobileDeckNation';details.className='mobile-filter';
        const summary=document.createElement('summary');summary.textContent='国家';details.appendChild(summary);
        const fields=document.createElement('div');fields.className='mobile-filter-fields';fields.appendChild(nation);details.appendChild(fields);head.appendChild(details);
      }
      const battleBox=$('#battle');
      for(const id of ['mobileFoeHand','mobileDeckCount'])if(battleBox&&!$('#'+id)){
        const e=document.createElement('div');e.id=id;battleBox.appendChild(e);
      }
      const back=$('#backToDeckLib');if(back)back.textContent='← 返回';
      const ai=$('#aiDeckToggle');if(ai)ai.textContent='AI';
      const prev=$('#pagePrev'),next=$('#pageNext'),top=$('#pageTop');
      if(prev){prev.textContent='‹';prev.setAttribute('aria-label','上一页');}
      if(next){next.textContent='›';next.setAttribute('aria-label','下一页');}
      if(top&&$('#mobileDeckFilters .mobile-filter-fields'))$('#mobileDeckFilters .mobile-filter-fields').appendChild(top);
      document.addEventListener('click',function(ev){
        $$('.mobile-filter[open],#mobileCardTools[open]').forEach(d=>{if(!d.contains(ev.target))d.open=false;});
      });
      const choose=$('#battleChooseDeck');if(choose)choose.addEventListener('click',()=>show('decklib'));
      const setup=$('#battleOpenSetup');if(setup)setup.addEventListener('click',()=>document.body.classList.add('side-open'));
      // 关闭预览的这一击只负责关闭，不能穿透到结束回合/阵线操作。
      document.addEventListener('click', function (ev) {
        const tip = $('#tooltip');
        if (!document.body.classList.contains('mobile-inspecting') || !tip || tip.contains(ev.target)) return;
        if (ev.target.closest && ev.target.closest('.card, .deck-item')) return;
        hideTip(); ev.preventDefault(); ev.stopImmediatePropagation();
      }, true);
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('resize', function () {
        detectMobileUI();
        if (S.fitBoardScale) S.fitBoardScale(true);
      });
      if (global.screen && global.screen.orientation && global.screen.orientation.addEventListener) {
        global.screen.orientation.addEventListener('change', function () { detectMobileUI(); });
      }
    }
  }

  function bind() {
    // ── ★ 手机判定（放在最前：它决定后面所有绑定走哪条分支） ──────────────
    detectMobileUI();
    buildMobileChrome();

    // ── ★ 网页版废弃标注（2026-09-27）：桌面壳（Electron）与浏览器共用本页。
    //   UA 含 Electron = 桌面版 → 横幅不显示；纯浏览器打开 serve.js = 显示。
    //   显示 8 秒自动淡出（页面加载即自动开局，常驻会一直遮对战顶缘）；✕ 立即关 +
    //   sessionStorage 记住（本次会话不再出，不落盘——别给"永久屏蔽"的机会）。
    //   ★ 手机端（2026-10-02）不显示：手机没有桌面 exe 可换，浏览器就是手机版唯一的
    //     运行时 —— 这条横幅在手机上只是白占一条屏高还指错路（手机横屏 390px 高度很贵）。
    try {
      const wd = $('#webDeprecated');
      if (wd && !/Electron/i.test(navigator.userAgent) && !isMobileUI() && !sessionStorage.getItem('webDepDismissed')) {
        wd.classList.remove('hidden');
        if (S._webDepTimer) clearTimeout(S._webDepTimer);
        S._webDepTimer = setTimeout(function () {
          wd.classList.add('wd-fade');
          setTimeout(function () { wd.classList.add('hidden'); }, 600);
        }, 8000);
        const wdClose = $('#webDepClose');
        if (wdClose) wdClose.addEventListener('click', function () {
          if (S._webDepTimer) clearTimeout(S._webDepTimer);
          wd.classList.add('hidden');
          try { sessionStorage.setItem('webDepDismissed', '1'); } catch (e) { }
        });
      }
    } catch (e) { /* UA/sessionStorage 异常就当桌面版，不挡游戏 */ }

    $$('.nav-btn').forEach(b => b.addEventListener('click', () => {
      if (!b.dataset.screen) return;                       // 「☰ 设置」不是屏幕切换
      show(b.dataset.screen);
      document.body.classList.remove('side-open');         // 手机上选完屏自动收起抽屉
      const tg = $('#sideToggle');
      if (tg) tg.textContent = '☰ 设置';
    }));

    /* ── ★ 界面设置屏（2026-10-02）：音效音量 + 界面大小 ────────────────
       音量 → sfx 的 S.setVolume（kg_sfx_volume）；
       大小 → documentElement 的 --ui-zoom（kg_ui_zoom），只作用于菜单系界面
       （对战布局固定 —— 缩放会牵连拖拽落点/FLIP 判定，不碰）。 */
    (function bindSettings() {
      const vol = $('#setVol'), volVal = $('#setVolVal');
      if (vol) {
        const v0 = Math.round((typeof S.getVolume === 'function' ? S.getVolume() : 0.45) * 100);
        vol.value = v0;
        if (volVal) volVal.textContent = v0 + '%';
        vol.addEventListener('input', function () {
          const v = parseInt(vol.value, 10) / 100;
          if (typeof S.setVolume === 'function') S.setVolume(v);
          if (volVal) volVal.textContent = vol.value + '%';
        });
      }
      const zm = $('#setZoom'), zmVal = $('#setZoomVal');
      const LS_ZOOM = 'kg_ui_zoom';
      function applyZoom(pct) {
        const f = Math.max(0.7, Math.min(1.4, pct / 100));
        try { document.documentElement.style.setProperty('--ui-zoom', String(f)); } catch (e) { }
        if (zmVal) zmVal.textContent = pct + '%';
      }
      if (zm) {
        const z0 = parseInt(LS.get(LS_ZOOM, 100), 10) || 100;
        zm.value = z0; applyZoom(z0);
        zm.addEventListener('input', function () {
          applyZoom(parseInt(zm.value, 10));
          LS.set(LS_ZOOM, parseInt(zm.value, 10));
        });
      }
    })();
    // ★ 手机：全屏 + 尝试锁定横屏（横屏玩时没有浏览器标题栏，能多让出一条牌的高度）
    const fsBtn = $('#fsToggle');
    if (fsBtn) fsBtn.addEventListener('click', function () {
      const elDoc = document.documentElement;
      const done = function (on) { fsBtn.textContent = on ? '退出全屏' : '进入全屏'; };
      try {
        if (!document.fullscreenElement) {
          if (elDoc.requestFullscreen) {
            Promise.resolve(elDoc.requestFullscreen()).then(function () {
              done(true);
              try { if (screen.orientation && screen.orientation.lock) Promise.resolve(screen.orientation.lock('landscape')).catch(function () { }); } catch (e) { }
            }).catch(function () { toast('这台设备/浏览器不允许全屏'); });
          } else toast('这个浏览器不支持全屏 API');
        } else {
          if (document.exitFullscreen) Promise.resolve(document.exitFullscreen()).then(function () { done(false); }).catch(function () { });
        }
      } catch (e) { toast('全屏失败：' + (e && e.message)); }
    });
    // ★ 手机横屏：屏幕矮 → 初始把棋盘滚到"前线"附近，一眼看到行动区。
    //   ⚠ 老实现用的是 `fl.offsetTop`，但 #handBar 一出现，#boardScroll 的视口高度就被
    //     压掉一截，offsetTop 的参考系和"可见区中心"对不上 → 滚完仍然看不到前线两侧。
    //     现在改成**按前线元素的实际几何**算，并且滚到"让前线落在可见区正中间"。
    //   （桌面端也一样受益：窗口矮时会自动把视野对准前线。）
    S.centerBoardOnFrontline = function () {
      const b = $('#boardScroll'), fl = $('#frontlineBar');
      if (!b || !fl || !b.getBoundingClientRect) return;
      const bh = b.clientHeight || 0;
      if (!bh) return;
      const flTop = fl.offsetTop || 0, flH = fl.offsetHeight || 0;
      const want = flTop - (bh - flH) / 2;         // 让前线落在可见区正中
      const max = Math.max(0, (b.scrollHeight || 0) - bh);
      const top = Math.max(0, Math.min(max, want));
      if (Math.abs((b.scrollTop || 0) - top) < 2) return;
      try { b.scrollTop = top; } catch (e) { }
    };

    /* ★ 手机横屏「战场铺满且不滚动」的最后兜底（2026-09-25）：
       手机上 #boardScroll 是 overflow:hidden 的，若内容仍比容器高（更矮的机型，
       比如 667×375 的 SE），就把 #boardInner 整体 scale 到刚好塞进去 ——
       宁可整体小 3%，也不要冒出一条滚动条（制作者要求：对战界面不能出现滚动条）。

       ⚠ 只在**缩放系数真的变了**时才写 style：一局里棋盘高度基本不变，
       所以这个函数绝大多数调用都是 no-op，不会打断拖拽 / FLIP 动画
       （那些都走 getBoundingClientRect，读到的是缩放后的真实坐标，判定照样准）。 */
    S._lastFitK = 0;
    S.fitBoardScale = function (force) {
      const inner = document.getElementById('boardInner');
      const sc = document.getElementById('boardScroll');
      if (!inner || !sc) return;
      if (force) S._lastFitK = 0;
      if (!isMobileUI()) {
        if (S._lastFitK) { inner.style.transform = ''; S._lastFitK = 0; }
        return;
      }
      if (S.fitFrontCards) S.fitFrontCards();
      const avail = sc.clientHeight || 0;
      inner.style.transform = 'none';                 // 先归零再量，避免量到上一次的缩放
      const need = inner.offsetHeight || 0;
      if (!avail || !need) { inner.style.transform = ''; return; }
      const k = Math.round(Math.min(1, avail / need) * 1000) / 1000;
      // 没变 → 恢复原样即可，不产生额外重排（一局里棋盘高度基本不变，所以多半是 no-op）
      if (Math.abs(k - S._lastFitK) >= 0.004) {
        S._lastFitK = k;
        inner.style.transformOrigin = 'top center';
      }
      inner.style.transform = (S._lastFitK && S._lastFitK < 0.998) ? 'scale(' + S._lastFitK + ')' : '';
    };

    /* ★ 阵线卡宽自适应（2026-09-25，制作者提议）：平板/桌面上"卡牌小成蚂蚁"的另一面——
       线上卡少时大屏幕在空转。按三条线（双方支援线 + 前线）的卡数算出"都放得下"的
       最大卡宽，上限按视口高度分档（卡高×3 行 + 杂项 ≈ 视口高，超了就得滚动，违背
       "看得更大"的初衷）：≥950→150px，≥800→112px，否则=基准（矮窗口的基准已被
       max-height 媒询调过，不放不缩）。四行取最小 fitW 保证卡牌大小一致。
       结果写 #boardInner 的 --fl-card-w / --fl-card-h，CSS 只在 .line-units 里消费，
       缺省回落 --card-w/--card-h → 手机与未启用路径零影响。
       手机不参与：三条阵线 ~280px 高预算，52px 已是高度的唯一解（有 fitBoardScale 兜底）。 */
    S._lastFlW = 0;
    S.fitFrontCards = function () {
      const inner = document.getElementById('boardInner');
      if (!inner) return;
      if (isMobileUI()) {
        // Three rows share the available board height, including when details
        // replace the hand. Fit seven support objects (six units plus HQ).
        const lines=Array.from(inner.querySelectorAll('.line-units'));
        const maxH=Math.min(86,Math.max(58,((global.innerHeight||390)-92)/4));
        let width=Math.min(maxH,Math.max(24,(inner.clientHeight-14)/3-2))/1.404;
        lines.forEach(line=>{
          const n=line.querySelectorAll('.card,.hq-card').length;
          if(n)width=Math.min(width,(line.clientWidth-Math.max(0,n-1)*8)/n);
        });
        width=Math.max(18,Math.floor(width));
        inner.style.setProperty('--fl-card-w',width+'px');
        inner.style.setProperty('--fl-card-h',Math.floor(width*1.404)+'px');
        S._lastFlW=width;
        return;
      }
      const lines = [];
      ['#mySupport', '#foeSupport', '#frontline'].forEach(function (sel) {
        const box = document.querySelector(sel);
        const line = box && box.querySelector(':scope > .line-units');
        if (line) lines.push(line);
      });
      if (!lines.length) return;
      const base = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 104;
      const vh = global.innerHeight || 900;
      let cap = base;
      if (vh >= 950) cap = 150;
      else if (vh >= 800) cap = 112;
      let fit = Infinity;
      lines.forEach(function (line) {
        const n = line.querySelectorAll('.card, .hq-card').length;
        if (!n) return;
        const cs = getComputedStyle(line);
        const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        let gap = parseFloat(cs.columnGap);
        if (isNaN(gap)) gap = 16;
        const w = (line.clientWidth - pad - (n - 1) * gap) / n;
        if (w > 0 && w < fit) fit = w;
      });
      const target = Math.round(Math.max(60, Math.min(fit, cap)));
      if (Math.abs(target - S._lastFlW) < 1) return;   // 没变化不写 style（别打断 FLIP/拖拽）
      S._lastFlW = target;
      inner.style.setProperty('--fl-card-w', target + 'px');
      inner.style.setProperty('--fl-card-h', Math.round(target * 1.404) + 'px');
    };
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', function () {
        S.centerBoardOnFrontline();
        S.fitBoardScale(true);                        // resize 后强制重算一次
        if (S.fitFrontCards) S.fitFrontCards();       // 视口变了 → 卡宽档位/行宽约束重算
      });
    }

    // ★ 手机端：设置/战报侧栏变成右侧抽屉，用顶栏这个按钮开关
    const sideTog = $('#sideToggle');
    if (sideTog) sideTog.addEventListener('click', function () {
      const open = !document.body.classList.contains('side-open');
      document.body.classList.toggle('side-open', open);
      sideTog.textContent = open ? '✕ 关闭' : '☰ 设置';
    });
    $('#endTurnBtn').addEventListener('click', async () => {
      const H = S.humanSide || 0;
      const turnState = S.state;
      if (!turnState || turnState.over || turnState.phase !== 'play' || turnState.active !== H || S.pending) return;
      // ★ 排进行动串行链：上一段出牌/攻击动画没演完时点这里，结束回合会**排队**到
      //   动画+结算收尾之后才执行，而不是插进中间把那次出牌搅失败。
      //   执行时重验一遍：排队期间状态可能已经变了（对局结束 / 轮到对手 / 弹了选择）。
      await serializeAction(async function () {
        if (S.state !== turnState || turnState.over || turnState.phase !== 'play' || turnState.active !== H || S.pending) return;

        await mpEndTurn(S.state, uiChooser());
        renderBattle();
        if (!S.state.over) {
          // 交给 aiTurn 播"对手回合"横幅 + 逐步演出
          aiTurn();
        }
      });
    });
    // ★ 准备阶段：确认换牌按钮
    const mulliganBtn = $('#mulliganConfirmBtn');
    if (mulliganBtn) mulliganBtn.addEventListener('click', confirmMulligan);
    $('#restartBtn').addEventListener('click', () => startGame());
    // ★ 对战界面常驻「☰」（制作者 2026-09-27：对战里根本没法回原界面）——
    //   一键同时滑出侧栏 + 下拉顶栏（nav 导航回到卡组/卡牌库/规则），再点收起。
    const sidePinBtn = $('#sidePinBtn');
    if (sidePinBtn) sidePinBtn.addEventListener('click', () => {
      // ★ 手机：常驻 ☰ 直接开关抽屉（side-open）。原来切的是桌面"钉住"语义
      //   （side-pinned），而 ★设置 在对战里随顶栏一起 translateY(-100%) 藏掉了
      //   → 抽屉打开后没有任何可达的关闭入口，表现为"侧边栏收不回去"。
      //   桌面保持原语义不动（收不回的根因是按钮被顶栏盖住，见 index.html 的
      //   sidePinBtn 搬家注释，这里只补收起动画期的 hover 锁）。
      if (isMobileUI()) { hideTip(); document.body.classList.remove('nav-open'); document.body.classList.toggle('side-open'); }
      else {
        const wasPinned = document.body.classList.contains('side-pinned');
        document.body.classList.toggle('side-pinned', !wasPinned);
        // ★ 收起动画期间锁住 :hover：面板 translateX 回移途中仍在屏内，
        //   鼠标路过右侧会命中 #sidePanel:hover 又把面板拉出来（"刚收又弹开"）。
        if (wasPinned) {
          document.body.classList.add('side-closing');
          if (S._sideClosingTimer) clearTimeout(S._sideClosingTimer);
          S._sideClosingTimer = setTimeout(function () {
            document.body.classList.remove('side-closing');
          }, 420);
        } else {
          document.body.classList.remove('side-closing');
        }
      }
    });
    // ★ AI 对战「开始游戏」显式入口（与联机 mpStartBtn 对齐）：按当前设置重开一局
    const aiStartBtn = $('#aiStartBtn');
    if (aiStartBtn) aiStartBtn.addEventListener('click', () => startGame());
    mpBind();                                  // 联机面板（建房/加入/选卡组/开始）
    const logToggle = $('#logToggle'), logClose = $('#logClose'), logDrawer = $('#logDrawer');
    if (logToggle) logToggle.addEventListener('click', () => {
      const hidden = logDrawer.classList.toggle('hidden');
      logToggle.textContent = hidden ? '显示战报' : '隐藏战报';
    });
    if (logClose) logClose.addEventListener('click', () => {
      logDrawer.classList.add('hidden');
      if (logToggle) logToggle.textContent = '显示战报';
    });
    /* ★ 卡组选择 ↔ 构筑 的往返（制作者 2026-09-25：构筑是"选择卡组"的下级界面）。
       顶栏的「卡组」进的是**选择界面**；选好（或新建）之后点「进入构筑」才到改牌界面。
       ★ 「AI 卡组构筑」走的是同一个构筑屏，但 S.aiBuild=true → body.ai-build：
         左栏整条换成 AI 卡组（纯 CSS 切形态，DOM 零搬移），加卡/保存全指向 AI。
         普通构筑入口必须把 aiBuild 摘掉，否则从 AI 界面返回后再点「进入构筑」
         会一直卡在 AI 形态里。 */
    const backLib = $('#backToDeckLib');
    if (backLib) backLib.addEventListener('click', function () { S.aiBuild = false; show('decklib'); });
    const editDeck = $('#editDeckBtn');
    if (editDeck) editDeck.addEventListener('click', function () {
      if (!getSavedDeck(S.curDeckId)) { toast('先选一副卡组（或点「新建」）'); return; }
      S.aiBuild = false;                       // 普通构筑：退出 AI 构筑形态
      S.deckMode = 'player';                   // ★ 两个入口对称给干净初始态：从 AI 构筑
      LS.set('deckMode', 'player');            //   返回后进普通构筑，抽屉不该自己开着
      show('deck');
    });
    const editAiDeck = $('#editAiDeckBtn');
    if (editAiDeck) editAiDeck.addEventListener('click', function () {
      S.aiBuild = true;
      S.deckMode = 'ai';                       // 卡池加卡 / 拖拽 drop 全部指向 AI 卡组
      LS.set('deckMode', 'ai');
      show('deck');
    });
    const aiBack = $('#aiBuildBack');          // AI 构筑界面左栏里的返回按钮
    if (aiBack) aiBack.addEventListener('click', function () { S.aiBuild = false; show('decklib'); });

    // 我的手牌 / 卡组库：自动构筑与清空只改工作区（标记未保存），保存才落盘
    $('#autoDeckBtn').addEventListener('click', () => { S.deck = autoDeckForRule(); S.deckDirty = true; renderDeckScreen(); toast('已自动构筑 ' + S.deck.length + ' 张，点「保存」写入卡组库'); });
    $('#clearDeckBtn').addEventListener('click', () => { S.deck = []; S.deckDirty = true; renderDeckScreen(); });
    $('#saveDeckBtn').addEventListener('click', () => { saveCurrentToSelected(); renderDeckScreen(); });
    // ★ 主国/盟国控件
    {
      const ck = $('#nationRuleChk');
      if (ck) ck.addEventListener('change', () => setDeckRule({ restrict: ck.checked }));
      const mk = $('#majorSel');
      if (mk) mk.addEventListener('change', () => setDeckRule({ major: mk.value || null }));
      const ak = $('#allySel');
      if (ak) ak.addEventListener('change', () => setDeckRule({ ally: ak.value || null }));
    }
    const newDeckBtn = $('#newDeckBtn');
    if (newDeckBtn) newDeckBtn.addEventListener('click', () => { newDeck(); renderDeckScreen(); });
    const dupDeckBtn = $('#dupDeckBtn');
    if (dupDeckBtn) dupDeckBtn.addEventListener('click', () => { duplicateDeck(); renderDeckScreen(); });
    const renameDeckBtn = $('#renameDeckBtn');
    // ⚠ renameDeck / importDeckCode 是 async（要等页面内输入框），必须 await 完再重渲染，
    //   否则界面在用户还没输入时就刷新了
    if (renameDeckBtn) renameDeckBtn.addEventListener('click', async () => { await renameDeck(); renderDeckScreen(); });
    const deleteDeckBtn = $('#deleteDeckBtn');
    if (deleteDeckBtn) deleteDeckBtn.addEventListener('click', () => { deleteDeck(); renderDeckScreen(); });
    // 卡组分享码：分享 = 当前工作区编成码复制；导入 = 粘贴码建成一副新卡组
    const shareDeckBtn = $('#shareDeckBtn');
    if (shareDeckBtn) shareDeckBtn.addEventListener('click', () => { shareDeckCode(); renderDeckScreen(); });
    const importDeckBtn = $('#importDeckBtn');
    if (importDeckBtn) importDeckBtn.addEventListener('click', async () => { await importDeckCode(); renderDeckScreen(); });
    // AI卡组按钮
    $('#autoAiDeckBtn').addEventListener('click', () => { S.aiDeck = KG.autoDeck(S.pool, { useOrders: $('#optAiOrders') ? $('#optAiOrders').checked : true }); LS.set('aiDeck', S.aiDeck); renderDeckScreen(); toast('AI卡组自动构筑完成（' + S.aiDeck.length + ' 张）'); });
    $('#clearAiDeckBtn').addEventListener('click', () => { S.aiDeck = []; LS.set('aiDeck', []); renderDeckScreen(); });
    $('#saveAiDeckBtn').addEventListener('click', () => { LS.set('aiDeck', S.aiDeck); toast('AI卡组已保存（' + S.aiDeck.length + ' 张）'); });
    // ★ AI 卡组抽屉（左栏「AI 卡组 ▸」/ 抽屉里「✕ 收起」）
    const aiTog = $('#aiDeckToggle');
    if (aiTog) aiTog.addEventListener('click', function () {
      const open = !(document.body && document.body.classList.contains('ai-deck-open'));
      setAiDeckDrawer(open);
      renderDeckScreen();
    });
    const aiCls = $('#aiDeckClose');
    if (aiCls) aiCls.addEventListener('click', function () { setAiDeckDrawer(false); renderDeckScreen(); });
    // 老按钮（若还在 DOM 里）保持原语义：切模式并同步抽屉开合
    const switchBtn = $('#switchDeckMode');
    if (switchBtn) switchBtn.addEventListener('click', () => {
      S.deckMode = S.deckMode === 'player' ? 'ai' : 'player';
      LS.set('deckMode', S.deckMode);
      setAiDeckDrawer(S.deckMode === 'ai');
      renderDeckScreen();
    });
    // 音效开关 + 预加载（Kenney CC0 素材，见 js/sfx.js）
    if (global.KGSfx) {
      const sfxBox = $('#optSfx');
      if (sfxBox) {
        sfxBox.checked = !global.KGSfx.isMuted();
        sfxBox.addEventListener('change', function () {
          global.KGSfx.setMuted(!sfxBox.checked);
          if (sfxBox.checked) global.KGSfx.ui({ gain: 1.2 });   // 开启时给个即时反馈
        });
      }
      global.KGSfx.preload();
    }
    // 演出速度档位（原版 / 快 / 极快）：KGAnim.ms() 统一缩放所有演出时长
    (function bindFxSpeed() {
      const AN = global.KGAnim;
      if (!AN || !AN.setSpeed) return;
      const cur = AN.speedName ? AN.speedName() : 'normal';
      AN.setSpeed(cur);                       // 把已保存的档位落到 <body> 上（CSS 侧覆盖）
      const sel = $('#optFx');
      if (!sel) return;
      sel.value = cur;
      sel.addEventListener('change', function () {
        AN.setSpeed(sel.value);
        try { if (global.KGSfx) global.KGSfx.ui({ gain: 1 }); } catch (e) { }
      });
    })();
    $('#cardSearch').addEventListener('input', renderPoolGrid);
    ['#setFilter', '#typeFilter', '#unitTypeFilter', '#costFilter', '#onlyOwned', '#hideToken'].forEach(s => {
      const el = $(s);
      if (el) el.addEventListener('change', renderPoolGrid);
    });
    $('#importFiles').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
    const showRef = $('#showRef');
    if (showRef) showRef.addEventListener('change', renderCollection);
    // 卡牌库检索控件（输入即过滤）
    ['collSearch', 'collSet', 'collType', 'collRarity', 'collOnlyFx'].forEach(function (id) {
      const el = $('#' + id);
      if (!el) return;
      el.addEventListener(id === 'collSearch' ? 'input' : 'change', renderCollection);
    });
    const cc = $('#collClear');
    if (cc) cc.addEventListener('click', function () {
      ['collSearch', 'collSet', 'collType', 'collRarity'].forEach(function (id) { const el = $('#' + id); if (el) el.value = ''; });
      const fx = $('#collOnlyFx'); if (fx) fx.checked = false;
      renderCollection();
    });
    const dirInput = $('#importDir');
    if (dirInput) dirInput.addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
    $('#exportCardsBtn').addEventListener('click', exportCards);
    const exCustBtn = $('#exportCustomBtn');
    if (exCustBtn) exCustBtn.addEventListener('click', exportCustomForFix);
    const fixAllBtn = $('#fixAllCustomBtn');
    if (fixAllBtn) fixAllBtn.addEventListener('click', fixAllCustom);
    const restRemBtn = $('#restoreRemovedBtn');
    if (restRemBtn) restRemBtn.addEventListener('click', restoreRemovedCards);
    /* ★ 批量删除内置卡（2026-10-02 Alan）：范围下拉（全部 / 各国家·系列）+ 删除按钮。
       范围选项从内置卡池的真实 set 值生成（不写死——卡池加国家这里自动跟）。 */
    (function bindDelBuiltin() {
      const sel = $('#delBuiltinSel'), btn = $('#delBuiltinBtn');
      if (!sel || !btn) return;
      const sets = [];
      (S.base || []).forEach(function (c) {
        const s = c.set || '（无系列）';
        if (sets.indexOf(s) < 0) sets.push(s);
      });
      sets.forEach(function (s) {
        const o = document.createElement('option');
        o.value = s; o.textContent = s;
        sel.appendChild(o);
      });
      btn.addEventListener('click', function () {
        const v = sel.value;
        const ids = (S.base || []).filter(function (c) {
          if (isCustomCard(c) || (S.removed && S.removed[c.id])) return false;
          return v === '__all__' || (c.set || '（无系列）') === v;
        }).map(function (c) { return c.id; });
        if (!ids.length) { toast('该范围内没有可删除的内置卡'); return; }
        removeBuiltinBatch(ids, v === '__all__' ? '全部内置卡' : ('系列「' + v + '」'));
      });
    })();
    $('#rebuildFxBtn').addEventListener('click', recompileAll);
    // ★「清除手工编辑」：早期在编辑器里保存过的效果存在 localStorage，优先级**高于**落盘产物，
    //   会一直压着修复后的编译结果（"改了没生效"的元凶之一）。这里一键清掉，回到编译器产物。
    const clearEditsBtn = $('#clearEditsBtn');
    if (clearEditsBtn) clearEditsBtn.addEventListener('click', () => {
      const n = Object.keys(S.edits || {}).length;
      if (!n) { toast('没有手工编辑记录'); return; }
      if (!confirm('将清除 ' + n + ' 张卡的手工编辑效果，全部改用编译器产物。\n\n（卡名/花费等非效果改动会一并清除）\n确定？')) return;
      S.edits = {}; LS.set('edits', {}); rebuildPool(); renderCollection();
      toast('已清除 ' + n + ' 张卡的手工编辑，现全部使用编译器产物');
    });
    $('#resetImportBtn').addEventListener('click', async () => {
      const n = (S.custom || []).length;
      if (!n) { toast('当前没有导入的自定义卡'); return; }
      // ★ 必须二次确认：这里会把**全部**自定义卡连图一起清掉（idbClear），不可撤销。
      //   以前没有确认框，误点一次就全没了。
      const bakN = customBackupInfo();
      const msg = '确定清除全部 ' + n + ' 张自定义卡？（卡图也会一起删除）\n' +
        (bakN ? '上一版（' + bakN + ' 张）已留有备份，可用 KG.ui.restoreCustomBackup() 或重新导入找回。'
              : '⚠ 这次没有可用备份，删除后无法恢复。建议先点「导出 cards.json」留一份。');
      if (global.confirm && !global.confirm(msg)) return;
      S.custom = []; LS.set('custom', []); await idbClear(); S.images = {}; rebuildPool(); renderCollection();
      toast('已清除导入的自定义卡' + (bakN ? '（可用 KG.ui.restoreCustomBackup() 找回）' : ''));
    });
    // ★ 体系：编辑器里一改就把体系词表同步给编译器 —— 正在编的这张卡还没进卡池，
    //   但卡面里可能就写着它自己的体系（「部署两辆 Mk坦克」），编译器必须现在就认得它。
    //   （词表 = 卡池里所有卡的 system 字段 + window.__kgNewSystems，见 primitives.js 的 systemWords()）
    (function syncSystems() {
      const el = $('#edSystem');
      if (!el) return;
      const push = function () {
        window.__kgNewSystems = String(el.value || '')
          .split(/[，,、]/).map(function (x) { return x.trim(); }).filter(Boolean);
      };
      el.addEventListener('input', push);
      el.addEventListener('change', push);
      push();
    })();
    $('#edCompileBtn').addEventListener('click', compileEditor);
    const edEffects = $('#edEffects');
    if (edEffects) edEffects.addEventListener('input', () => {
      editorEffectStatus = 'manual-confirmed';
      const status = $('#edParseStatus');
      if (status) { status.textContent = '效果状态：已人工确认 DSL（保存后生效）'; status.className = 'parse-status manual-confirmed'; }
    });
    const edText = $('#edText');
    if (edText) edText.addEventListener('input', () => {
      editorEffectStatus = 'unreviewed';
      $('#edWarn').textContent = '';
      const status = $('#edParseStatus');
      if (status) { status.textContent = '效果状态：卡面原文已修改，需重新解析或确认 DSL'; status.className = 'parse-status unreviewed'; }
    });
    $('#edSaveBtn').addEventListener('click', saveEditor);
    const edClose = $('#edCloseBtn');
    // 关闭制卡界面 → 回卡牌库（并刷新，让改动立刻可见）
    if (edClose) edClose.addEventListener('click', () => { renderCollection(); show('collection'); });

    // 新建卡牌（单张：先填数值/词条/效果，再配图）→ 跳到**独立的制卡界面**
    const newBtn = $('#newCardBtn');
    if (newBtn) newBtn.addEventListener('click', () => { newCustomCard(); });
    // 制卡界面里的批量加入（与卡牌库那两个入口用同一个 importFiles 处理函数）
    const impF2 = $('#importFiles2');
    if (impF2) impF2.addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
    const impD2 = $('#importDir2');
    if (impD2) impD2.addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
    // 给当前这张卡配图
    const artFile = $('#edArtFile');
    if (artFile) artFile.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) await setEditorArt(f);
      e.target.value = '';           // 清空，允许再选同一张
    });

    /* ★ 规范文档（制卡者手册）：内容来自 game/docs/CUSTOM-CARD-GUIDE.md，
     *   由 build-card-guide.js 生成为内联的 KG_CARD_GUIDE —— 不需要 fetch，file:// 也能看。
     *   改了 md 记得重跑一次那个脚本，否则这里显示的是旧的。 */
    const guideBtn = $('#edGuideBtn'), guideBox = $('#edGuide'), guideBody = $('#edGuideBody');
    if (guideBtn && guideBox) {
      guideBtn.addEventListener('click', () => {
        if (guideBody && !guideBody.textContent) {
          const src = (typeof KG_CARD_GUIDE !== 'undefined') ? KG_CARD_GUIDE : null;
          guideBody.textContent = src ||
            '（没读到规范文档。请先跑：node game/tools/build-card-guide.js）';
        }
        guideBox.hidden = !guideBox.hidden;
        guideBtn.setAttribute('aria-expanded', String(!guideBox.hidden));
        if (!guideBox.hidden && guideBody) guideBody.scrollTop = 0;
      });
      const guideClose = $('#edGuideClose');
      if (guideClose) guideClose.addEventListener('click', () => {
        guideBox.hidden = true;
        guideBtn.setAttribute('aria-expanded', 'false');
      });
    }

    const diagBtn = $('#diagBtn'), diagClose = $('#diagClose');
    if (diagBtn) diagBtn.addEventListener('click', showDiag);
    if (diagClose) diagClose.addEventListener('click', () => $('#diag').classList.add('hidden'));
    document.addEventListener('keydown', e => {
      if (e.key === 'F2') { e.preventDefault(); showDiag(); }
      if (e.key === 'Escape') {
        if (S.pending) cancelPending();
        else if (drag && drag.moved) cancelDrag();     // 拖到一半按 ESC = 收回这张牌
      }
      if (e.key === ' ' && $('#screen-battle').classList.contains('active') && !S.pending) {
        e.preventDefault(); $('#endTurnBtn').click();
      }
    });

    // 指针拖拽：window 级监听，保证拖出手牌区也不会丢
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', function (ev) {
        if (drag && (drag.pointerId == null || ev.pointerId === drag.pointerId)) cancelDrag();
      });
      // 拖拽中右键 = 收回这张牌（原版手感）。capture 阶段截住，别让它落到卡牌自己的
      // contextmenu 上（那里是"切异画 / 弹菜单"——拖到一半弹菜单会很怪）。
      window.addEventListener('contextmenu', function (ev) {
        if (drag && drag.moved) {
          if (ev && ev.preventDefault) ev.preventDefault();
          if (ev && ev.stopPropagation) ev.stopPropagation();
          cancelDrag();
        }
      }, true);
    }
    // 刚刚完成一次拖拽时吞掉随之而来的 click（否则会又当成"点牌"）
    document.addEventListener('click', ev => {
      if (!swallowClick) return;
      swallowClick = false;
      ev.stopPropagation();
      if (ev.preventDefault) ev.preventDefault();
    }, true);
  }

  /* ---------------------------------------------------------------- 启动 */
  KG.ui = S;   // 便于调试与自动化测试访问内部状态
  // ★ 主国/盟国：暴露给自动化测试
  S.NATIONS = NATIONS; S.ALLY_MAX = ALLY_MAX;
  S.deckNationInfo = deckNationInfo; S.guessNations = guessNations;
  S.currentRuleDeck = currentRuleDeck; S.setDeckRule = setDeckRule;
  S.autoDeckNations = autoDeckNations; S.autoDeckForRule = autoDeckForRule;
  S.addToDeck = addToDeck; S.saveCurrentToSelected = saveCurrentToSelected;
  S.syncDeckRuleFromSaved = syncDeckRuleFromSaved;
  S.MP = MP; S.mpStartHint = mpStartHint;
  S.poolFiltered = poolFiltered; S.poolForDisplay = poolForDisplay;
  S.importFiles = importFiles;
  S.saveEditor = saveEditor;
  S.compileEditor = compileEditor;
  S.recompileAll = recompileAll;
  S.openEditor = openEditor;
  S.exportCards = exportCards;
  S.recompileAll = recompileAll;
  S.startGame = startGame;
  S.loadDeckLibrary = loadDeckLibrary;
  S.saveCurrentToSelected = saveCurrentToSelected;
  S.loadDeckIntoWorkspace = loadDeckIntoWorkspace;
  S.renderDeckLib = renderDeckLib;
  S.mp = MP;                    // 联机状态（自动化测试/排查用）
  S.mpBind = mpBind;
  S.mpSetMode = mpSetMode;
  S.mpDisconnect = mpDisconnect;
  S.mpPlay = mpPlay;            // 引擎入口包装（自动化测试用：验证联机门禁与动作转发）
  S.mpOnMove = mpOnMove;        // 对手动作的演出入口（测试里直接喂动作包，不需要联网）
  S.lanBlocked = lanBlocked;
  S.mpSetStatus = mpSetStatus;
  S.mpApplyCards = mpApplyCards;        // 联机强制对齐（自动化测试用）
  S.mpDropPeerCards = mpDropPeerCards;  // 断开联机还原（自动化测试用）
  S.mpAnnounceDeck = mpAnnounceDeck;
  S.mpStartHint = mpStartHint;
  S.renderBattle = renderBattle;
  S.aiTurn = aiTurn;          // 暴露给自动化测试打断点用
  S.showDiag = showDiag;
  S.pageScroll = pageScroll;
  S.updatePager = updatePager;
  (async function boot() {
    installErrorHandlers();
    buildRotateHint();
    if (global.KG_AUTO_SAVE) {
      try { await global.KG_AUTO_SAVE.init(); }
      catch (e) { showError('自动迁移未完成，原存档已保留。请勿清除数据。\n' + e.message); return; }
      global.addEventListener('kg-save-error', e => toast('自动备份失败：' + e.detail, 5000));
    }
    // ★ 2026-10-02：先探一次"背后有没有 serve.js"。所有写盘功能（删除内置卡 / 保存到卡池 /
    //   异画对位保存）都靠这个结论决定走真删还是逻辑删除。**必须在 bind() 之前**，
    //   否则玩家在界面里点第一个按钮时 serverKnown() 还是 null（= 当成没服务器）。
    try {
      const ok = await hasWriteServer();
      console.log('[启动] 本地服务器：' + (ok ? ('有（' + (S.serverRoot || 'serve.js') + '）→ 写盘功能可用')
        : '无 → 写盘功能走本机模式（删除=本机隐藏，保存请用导出）') +
        '（protocol=' + location.protocol + '）');
    } catch (e) { /* 探不到就按"无服务器"，绝不因此拦住启动 */ }
    if (typeof location !== 'undefined' && location.protocol === 'file:') {
      showError('提示：当前是用 file:// 直接打开的，游戏能玩，但浏览器会禁止保存卡组与导入的卡图。\n' +
        '建议改用 game\\启动游戏.cmd 启动本地服务器后访问 http://127.0.0.1:8731/ 。');
    }
    await loadPool();
    // 异画：现扫一次文件系统（需要 serve.js），所以新加的 `<原名>y.png` 刷新就能切
    {
      const n = await refreshAltArt();
      if (n) console.log('KG 异画：' + n + ' 张（/__alt-art 现扫）');
    }
    loadDeckLibrary();                       // 首次启动顺便迁移旧版单卡组（kg.deck）
    S.deck = LS.get('deck', []);
    S.aiDeck = LS.get('aiDeck', []);
    S.deckMode = LS.get('deckMode', 'player');
    {
      const counts = {};
      S.aiDeck = S.aiDeck.filter(function(id) {
        const c = KG.pool && KG.pool[id];
        if (!c) return false;
        const lim = KG.copyLimit(c);
        if (lim <= 0) return false;
        counts[id] = (counts[id] || 0) + 1;
        return counts[id] <= lim;
      });
      S.aiDeck = S.aiDeck.slice(0, KG.RULES.deckSize);
      if (!S.aiDeck.length) S.aiDeck = KG.autoDeck(S.pool, { useOrders: true });
    }
    // 清理卡组里已删除的卡 / 超出稀有度上限的卡 / 不可构筑卡
    {
      const counts = {};
      S.deck = S.deck.filter(function (id) {
        const c = KG.pool && KG.pool[id];
        if (!c) return false;
        const lim = KG.copyLimit(c);
        if (lim <= 0) return false;
        counts[id] = (counts[id] || 0) + 1;
        return counts[id] <= lim;
      });
      S.deck = S.deck.slice(0, KG.RULES.deckSize);
    }
    if (!S.deck.length) {
      const cd0 = getSavedDeck(S.curDeckId);
      S.deck = (cd0 && cd0.cards.length) ? cd0.cards.slice() : autoDeckNations(S.pool, cd0 && cd0.major, cd0 && cd0.ally);
    }
    // 卡组库里的「当前卡组」= 工作区的真源（上面可能已经归一化过）
    {
      const cur = getSavedDeck(S.curDeckId);
      if (cur) { cur.cards = S.deck.slice(); cur.updated = Date.now(); S.deckDirty = false; }
      else { S.deckDirty = S.deck.length > 0; }
      syncDeckRuleFromSaved();                   // ★ 主国/盟国/开关（跟随当前卡组）
      LS.set('deck', S.deck);
      persistDeckLib();
    }
    bind();
    const orcDrafts = LS.get('orcDrafts', []);
    if (orcDrafts.length) showOrCReport({summary:{ready:0,pending:orcDrafts.length,rejected:0,skipped:0},ready:[],pending:orcDrafts,rejected:[],skipped:[],entries:[]}, ['上次导入的待核对资料已恢复。']);
    bindPager();
    // ★ 手机首屏 = 卡牌库（2026-10-02 Alan 定）：不自动开局，进对战时 show('battle') 会自启
    if (!S.pool.length || (typeof isMobileUI === 'function' && isMobileUI())) {
      show('collection');
    } else {
      show('battle');
      startGame();
    }
    console.log('KG 就绪：卡池', S.pool.length);
    window.__S = S; window.__KG = KG;
  })();
})(typeof window !== 'undefined' ? window : globalThis);
