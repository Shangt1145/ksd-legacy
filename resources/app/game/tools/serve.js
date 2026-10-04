/* 极简静态服务器（零依赖）+ 局域网联机 WebSocket
 * 用法:
 *   node game/tools/serve.js [port]          默认监听 0.0.0.0（本机 + 局域网都能连）
 *   node game/tools/serve.js [port] --local  只听 127.0.0.1（不开联机也不占防火墙）
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WS = require('./ws.js');
const { spawn } = require('child_process');
const { scanAltArt, readAltUi } = require('./alt-art-lib.js');
const { deleteCards } = require('./delete-cards.js');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_ROOT = process.env.KG_DATA_ROOT || ROOT;
const args = process.argv.slice(2);
const LOCAL_ONLY = args.indexOf('--local') >= 0;
const PORT = parseInt(args.filter(a => !a.startsWith('--'))[0] || '8731', 10);
const HOST = LOCAL_ONLY ? '127.0.0.1' : '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  // 音效（缺了这些，浏览器拿不到 Content-Type，<audio> 会拒绝播放）
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};

/* ★ 保存到卡池（2026-09-27 招安改制，Alan）：游戏里点【保存到卡池】→ POST 卡数据+卡图到这里 →
 *   服务器把卡/修改**直接写进 nations/*.json（唯一存储）**，然后跑 merge.js + build-effects.js
 *   重建运行时产物 → 返回报告 → 页面刷新。
 *   保存后这些卡就是 nations 正式数据 —— 只能被手动修改，没有任何自动脚本会再碰它。 */
const FIX_MAX = 96 * 1024 * 1024;                 // 卡图 base64，给足空间
function rebuildPool(cb) {
  const env = Object.assign({}, process.env);
  const run = (script, next) => {
    const cp = spawn(process.execPath, [path.join(__dirname, script)], { stdio: ['ignore', 'pipe', 'pipe'], env: env });
    let err = '';
    cp.stdout.on('data', function () { });
    cp.stderr.on('data', function (d) { err += d; });
    cp.on('error', function (e) { next(e.message); });
    cp.on('close', function (code) { next(code === 0 ? null : (script + ' 退出码 ' + code + (err ? '：' + err.slice(0, 400) : ''))); });
  };
  run('merge.js', function (e1) {
    if (e1) return cb(e1);
    run('build-effects.js', cb);
  });
}

/* 读 nations 全部文件 → {file: doc}，供按 id 定位卡所在国家文件 */
function readNations() {
  const dir = path.join(DATA_ROOT, 'game', 'data', 'nations');
  const out = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_meta.json').sort(); } catch (e) { }
  files.forEach(f => {
    try { out[f] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { }
  });
  out.__dir = dir;
  return out;
}

function handleSaveCustom(req, res) {
  const chunks = [];
  let size = 0, aborted = false;
  req.on('data', function (c) {
    size += c.length;
    if (size > FIX_MAX) { aborted = true; try { req.destroy(); } catch (e) {} return; }
    chunks.push(c);
  });
  req.on('end', function () {
    const send = function (code, obj) {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(obj));
    };
    if (aborted) return send(413, { ok: false, error: '包太大（超过 ' + Math.round(FIX_MAX / 1048576) + 'MB）' });
    let pack = null;
    try { pack = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(400, { ok: false, error: 'JSON 解析失败' }); }
    const cards = (pack && Array.isArray(pack.cards)) ? pack.cards : [];
    const edits = (pack && Array.isArray(pack.edits)) ? pack.edits : [];
    const images = (pack && pack.images && typeof pack.images === 'object') ? pack.images : {};
    if (!cards.length && !edits.length) return send(400, { ok: false, error: '包里没有卡，也没有修改' });

    let added = 0, replaced = 0, editOk = 0, imgOk = 0;
    const imgMiss = [];
    const touched = new Set();          // 所有被改动的 nations 文件，最后统一落盘
    const nations = readNations();
    const dir = nations.__dir;

    /* ① 自定义卡 → nations/<国家>.json（upsert；图片 → ROOT/<file> 真实 png）
     * ★ 2026-09-28：卡面选了已知国家 → 卡搬进那个国家的文件（支持改国家）；
     *   没选/未知 → 落 自定义.json。同 id 的旧文件残留会删掉（搬家不留下影子）。 */
    if (cards.length) {
      for (const c of cards) {
        if (!c || !c.id) continue;
        let target = String(c.set || '').trim();
        if (!target || !nations[target + '.json']) target = '自定义';
        let doc = nations[target + '.json'];
        if (!doc || typeof doc !== 'object' || !doc.cards) { doc = { nation: target, cards: {} }; nations[target + '.json'] = doc; }
        if (!doc.cards || typeof doc.cards !== 'object') doc.cards = {};
        // 搬家：删掉其它国家文件里的同 id 旧版本
        for (const f of Object.keys(nations).filter(k => k.charAt(0) !== '_' && k !== target + '.json')) {
          const d2 = nations[f];
          if (d2 && d2.cards && d2.cards[c.id]) { delete d2.cards[c.id]; touched.add(f); }
        }
        touched.add(target + '.json');
        const src = String(c.file || c.src || (c.name + '.png')).replace(/\\/g, '/').replace(/^\.\.\//, '');
        const existed = !!doc.cards[c.id];
        doc.cards[c.id] = {
          id: c.id,
          src: src,
          art: '../' + src,
          name: c.name || c.id, set: target, sub: c.sub || '',   // ★ set 强制=落盘文件（2026-09-28），二者永远一致
          system: c.system || null,
          cardType: c.cardType || 'order', unitType: c.unitType || null,
          cost: c.cost != null ? c.cost : null, attack: c.attack != null ? c.attack : null,
          defense: c.defense != null ? c.defense : null, opCost: c.opCost != null ? c.opCost : null,
          keywords: c.keywords || [], kwMap: c.kwMap || {}, kwValues: c.kwValues || {}, keywordsRaw: c.keywordsRaw || [],
          rarity: c.rarity || 'bronze', token: !!c.token,
          text: c.text || '', flavor: c.flavor || '',
          variableStats: !!c.variableStats, confidence: c.confidence || 'manual',
          effects: Array.isArray(c.effects) ? c.effects : [],
          adopted: true, adoptedAt: new Date().toISOString(),
          notes: c.notes || '制卡台保存（2026-09-27 存储唯一化：直接落 nations，只能手动修改）',
        };
        if (existed) replaced++; else added++;
      }
    }

    /* ② 内置卡修改补丁 → 直接合并进对应 nations 国家文件的卡本体（不再有 builtin-edits 中转） */
    for (const ed of edits) {
      if (!ed || !ed.id) continue;
      let hit = null;
      for (const f of Object.keys(nations).filter(k => k.charAt(0) !== '_')) {
        const doc = nations[f];
        if (doc && doc.cards && doc.cards[ed.id]) { hit = { f: f, doc: doc, card: doc.cards[ed.id] }; break; }
      }
      if (!hit) { imgMiss.push('edit:' + ed.id); continue; }
      const patch = Object.assign({}, ed); delete patch.id;
      // ★ 改国家（2026-09-28）：patch 带了与所在文件不同的 set → 把卡搬到目标国家的文件
      const newNat = String(patch.set || '').trim();
      const curNat = hit.doc.nation || hit.f.replace('.json', '');
      if (newNat && newNat !== curNat && nations[newNat + '.json']) {
        delete hit.doc.cards[ed.id];
        touched.add(hit.f);
        const nd = nations[newNat + '.json'];
        if (!nd.cards || typeof nd.cards !== 'object') nd.cards = {};
        nd.cards[ed.id] = hit.card;
        hit.doc = nd; hit.f = newNat + '.json';
      } else if (newNat && newNat !== curNat) {
        patch.set = curNat;   // 目标国家文件不存在 → 拉回当前国家，绝不落成错位
      }
      touched.add(hit.f);
      // effects 属效果覆盖层：写卡本体时把 effects 挂进 overlayFields（与 merge/build-effects 的剥离口径一致）
      if (patch.effects !== undefined) {
        const ov = Array.isArray(hit.card.overlayFields) ? hit.card.overlayFields.slice() : [];
        if (ov.indexOf('effects') < 0) ov.push('effects');
        hit.card.overlayFields = ov;
      }
      Object.assign(hit.card, patch);
      editOk++;
    }
    // 统一落盘：所有被改动（保存卡 / 修改补丁）的 nations 文件
    for (const f of touched) {
      try { fs.writeFileSync(path.join(dir, f), JSON.stringify(nations[f], null, 1), 'utf8'); }
      catch (e) { return send(500, { ok: false, error: '写 ' + f + ' 失败：' + e.message }); }
    }

    /* ③ 卡图 → ROOT/<file>（真实 png） */
    for (const file of Object.keys(images)) {
      const safe = String(file).replace(/\\/g, '/').replace(/\.\./g, '');
      const dest = path.join(DATA_ROOT, safe);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(String(images[file]).replace(/^data:[^,]*,/, ''), 'base64'));
        imgOk++;
      } catch (e) { imgMiss.push(file); }
    }

    /* ④ 重建运行时产物（merge.js + build-effects.js） */
    rebuildPool(function (err) {
      if (err) return send(500, { ok: false, error: '卡已保存进 nations，但重建产物失败：' + err });
      send(200, { ok: true, cards: cards.length, added: added, replaced: replaced,
        edits: editOk, images: imgOk, imgMiss: imgMiss, rebuilt: true,
        msg: '已保存进 nations/（唯一存储，只能手动修改）' });
    });
  });
}

/* ★ 彻底删除卡（Alan：内置卡也能删）：从 nations 条目里真删（不是 localStorage 逻辑删除），
 *   然后重建产物。卡图文件保留（共享资产，可能被同名卡引用）。 */
let deletingCards = false;
function handleDeleteCard(req, res) {
  const chunks = [];
  let bytes = 0;
  req.on('data', function (c) { bytes += c.length; if (bytes <= 1024 * 1024) chunks.push(c); });
  req.on('end', function () {
    let replied = false;
    const send = function (code, obj) {
      if (replied) return;
      replied = true;
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(obj));
    };
    if (bytes > 1024 * 1024) return send(413, { ok: false, error: '删除请求过大' });
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(400, { ok: false, error: 'JSON 解析失败' }); }
    const ids = body && (Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : []);
    if (!ids || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== 'string' || !id.trim())) return send(400, { ok: false, error: '需要有效的卡牌 id 列表' });
    if (deletingCards) return send(409, { ok: false, error: '正在删除卡牌，请稍后重试' });
    deletingCards = true;
    let result;
    try { result = deleteCards(DATA_ROOT, ids); }
    catch (error) { deletingCards = false; return send(500, { ok: false, error: '删除失败：' + error.message }); }
    rebuildPool(function (err) {
      deletingCards = false;
      if (err) return send(500, Object.assign({ ok: false, error: '已删除卡牌，但卡池重建失败：' + err, sourceChanged: true }, result));
      send(200, Object.assign({ ok: true, id: body.id, name: result.names[body.id], deleted: result.deletedIds.length, rebuilt: true, msg: '卡池已更新' }, result));
    });
  });
}

/* 「异画对位」保存：body = { id, ui:{atk:{…},def:{…}} }（ui 为 null = 删掉这张卡的配置）
 * 只动 game/data/alt-art-ui.json，写法与 fix-custom 同思路：先读旧值 → 合并 → 整份写回。 */
function handleAltUi(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', function (c) { size += c.length; if (size > 1 << 20) { try { req.destroy(); } catch (e) { } return; } chunks.push(c); });
  req.on('end', function () {
    const send = function (code, obj) {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(400, { ok: false, error: 'JSON 解析失败' }); }
    const id = body && String(body.id || '').trim();
    if (!id) return send(400, { ok: false, error: '缺少卡 id' });
    const file = path.join(DATA_ROOT, 'game', 'data', 'alt-art-ui.json');
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { cur = {}; }
    if (body.ui) cur[id] = body.ui; else delete cur[id];
    // 保持说明键在最前，方便手改
    const ordered = {};
    Object.keys(cur).filter(function (k) { return k.charAt(0) === '_'; }).forEach(function (k) { ordered[k] = cur[k]; });
    Object.keys(cur).filter(function (k) { return k.charAt(0) !== '_'; }).sort().forEach(function (k) { ordered[k] = cur[k]; });
    try { fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n', 'utf8'); }
    catch (e) { return send(500, { ok: false, error: '写文件失败：' + e.message }); }
    send(200, { ok: true, file: path.relative(ROOT, file), saved: !!body.ui, count: Object.keys(ordered).filter(function (k) { return k.charAt(0) !== '_'; }).length });
  });
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  /* ★ 2026-09-27 招安改制为「保存」（Alan）：写 nations 唯一存储 + 自动重建产物。
   *   保存后只能被手动修改（所有自动写入脚本已禁用）。 */
  if (p === '/__save-cards/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: true, canWrite: true, root: DATA_ROOT }));
    return;
  }
  if (req.method === 'POST' && p === '/__save-cards') { handleSaveCustom(req, res); return; }
  if (req.method === 'POST' && (p === '/__delete-card' || p === '/__delete-cards')) { handleDeleteCard(req, res); return; }
  /* 旧固化端点：已改名保存，老页面打过来给个明确提示 */
  if (p === '/__fix-custom/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: false, canWrite: false, reason: '招安已改制为「保存到卡池」—— 刷新页面使用新端点 /__save-cards' }));
    return;
  }
  if (req.method === 'POST' && p === '/__fix-custom') {
    res.writeHead(410, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: false, error: '「一键招安」已改制为「保存到卡池」（直接写 nations/ 唯一存储）—— 刷新页面后再保存' }));
    return;
  }
  /* ★ 异画自动发现：页面每次启动都来问一次"现在有哪些 y 后缀的卡图" —— 现扫文件系统，
   *   所以**往卡图旁边丢一张 `<原名>y.png`，刷新浏览器就能切异画**，不用跑脚本、不用改版本号。
   *   （file:// / 别的静态服务器拿不到这个接口 → 前端自动退回 js/alt-art.js 静态表） */
  if (p === '/__alt-art') {
    try {
      const alt = Object.assign({}, scanAltArt(ROOT), DATA_ROOT === ROOT ? {} : scanAltArt(DATA_ROOT));
      const ui = readAltUi(DATA_ROOT);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, count: Object.keys(alt).length, alt: alt, ui: ui }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return;
  }
  /* ★ 游戏里「异画对位」面板调完点保存 → 写回 game/data/alt-art-ui.json（只并这一张卡，别的卡不动） */
  if (req.method === 'POST' && p === '/__alt-art-ui') { handleAltUi(req, res); return; }
  /* ★ 联机：把本机的网卡地址（分类好、带"推荐哪条"）发给房主页面（2026-09-27）。
   *   浏览器拿不到服务端的网卡列表，而服务器多半是后台起的、控制台没人看 ——
   *   有了它，房主在联机面板里就能看到"该把哪个地址发给对方"（UU 虚拟 IP 会标出来）。 */
  if (p === '/kg-net') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(netInfo(PORT)));
    return;
  }
  // 根路径必须重定向到 /game/index.html：
  // 否则页面里的相对路径 css/style.css、js/ui.js 会被解析成 /css/… /js/… 而 404，
  // 结果就是"没有样式、没有脚本、点什么都没反应"。
  if (p === '/' || p === '/index.html') {
    res.writeHead(302, { Location: '/game/index.html' });
    res.end();
    return;
  }
  const tryFiles = [p];
  if (p.startsWith('/') && !p.startsWith('/game/')) tryFiles.push('/game' + p);   // 兜底：/js/x.js → /game/js/x.js
  for (const cand of tryFiles) {
    const relative = cand.replace(/^\/+/, '');
    const installed = path.resolve(ROOT, relative), stored = path.resolve(DATA_ROOT, relative);
    if (!installed.startsWith(ROOT + path.sep) || !stored.startsWith(DATA_ROOT + path.sep)) continue;
    // Native snapshots and migration records are never exposed over HTTP.
    const canOverride = /^(?:game\/(?:data\/|js\/(?:cards|effects-data)\.js$))/.test(relative) || /\.(png|jpe?g|webp|gif|svg)$/i.test(relative);
    const file = canOverride && fs.existsSync(stored) ? stored : installed;
    let st = null;
    try { st = fs.statSync(file); } catch (e) { }
    if (st && st.isFile()) {
      // ★ 缓存策略（2026-09-25）：html 用 no-store —— 手机浏览器（尤其安卓各家壳浏览器）
      //   对 no-cache 执行得很烂，会把旧 index.html 钉在缓存里，于是它引用的还是旧 ?v=
      //   的 cards.js → "卡牌招安了手机上还是不更新"。html 连存都不让它存。
      //   ★ 卡牌数据（cards.js / cards.json / effects-data.js）同 html 待遇 no-store
      //     （2026-09-25 制作者要求手机每次访问强制取主机最新卡牌数据；effects-data.js 是
      //     效果 DSL 覆盖层，不同步它 = 改了效果手机看不到）—— ui.js 启动时还会带时间戳
      //     fetch cards.json / effects-data.js 做双保险，这里是 HTTP 层的治本。
      //   ★ 图片走浏览器缓存（2026-09-25 晚）：原先 png 也发 no-cache，而本服务器**不支持
      //     304** → 浏览器每次进来把几百张卡图**完整重下**（165MB+），局域网有线感觉不到，
      //     跨网/手机 Wi-Fi 就是"朋友加载图片加载一辈子"。改为 max-age=1 天 + Last-Modified，
      //     过期后再问走 304（只传头不传图）。改图当天想立刻生效 → Ctrl+F5 强刷一次。
      const isHtml = /\.html?$/i.test(file);
      const isCardData = /(cards\.(?:js|json)|effects-data\.js)$/i.test(file);
      const isImg = /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file);
      const noStore = isHtml || isCardData;
      const lm = isImg ? st.mtime.toUTCString() : null;
      if (isImg && lm && req.headers['if-modified-since'] === lm) {
        res.writeHead(304, { 'Cache-Control': 'public, max-age=86400', 'Last-Modified': lm });
        res.end();
        return;
      }
      // ★ 2026-09-25 Safari 补丁：老 WebKit 对裸 no-store 有无视的记录（iOS Safari 缓存 bug），
      //   三件套（no-store + no-cache + Pragma/Expires 0）一起上才压得住 —— 头不一样就重新取。
      //   ⚠ 头对象不能塞 undefined 值（ERR_HTTP_INVALID_HEADER_VALUE 会整个崩掉服务器），
      //     所以条件构造：非 no-store 文件只给 Cache-Control 一项。
      const headers = {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': noStore ? 'no-store, no-cache, must-revalidate, max-age=0'
                       : isImg   ? 'public, max-age=86400'
                                 : 'no-cache',
      };
      if (isImg) headers['Last-Modified'] = lm;
      if (noStore) { headers['Pragma'] = 'no-cache'; headers['Expires'] = '0'; }
      res.writeHead(200, headers);
      res.end(fs.readFileSync(file));
      return;
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 ' + p);
});

// ★ 联机：WebSocket 与静态文件共用同一个端口（/kg-ws），这样对方只要访问
//   http://<你的IP>:<端口>/game/index.html 就能一起玩，不需要额外开端口/再确认一次防火墙。
const ws = WS.attach(server, { log: m => console.log('  ' + m) });

/* 找出本机所有可用的 IPv4，并**按用途分类**（联机时要把正确的地址念给对方听）。
 * ★ 不能只挑"看起来像局域网"的前 3 条就打印：
 *   Radmin VPN 用的是 26.x.x.x，Tailscale 是 100.x，都长得不像 192.168/10.x，
 *   之前一刀切 slice(0,3) 会把它们直接截掉 —— 用 VPN 联机的人根本看不到该发哪个地址。 */
function classifyNic(name, address, hints) {
  const n = String(name || '');
  // ★ 169.254.x 是系统自动分配的"没拿到 DHCP"地址（APIPA），任何网卡上出现它都是无效的，
  //   必须最先判掉 —— 否则会把一个连不上的地址标成 Tailscale/局域网发出去。
  if (/^169\.254\./.test(address)) return 'apipa';
  // 用户自定义规则优先（写错也只影响"多认出一块"，不会打乱内置分类）
  if (hints) {
    const hk = Object.keys(hints);
    for (let i = 0; i < hk.length; i++) {
      const res = hints[hk[i]];
      for (let j = 0; j < res.length; j++) if (res[j].test(n)) return hk[i];
    }
  }
  /* ★ UU 加速器「云联机」/ 各类"一键建房"虚拟局域网（2026-09-27）：
   *   这类工具会在系统里插一块虚拟网卡，给同房间的每个人发一个**虚拟 IP**；
   *   跨网联机必须发这个虚拟 IP，发物理局域网 IP（192.168.x）对方一定连不上。
   *   ⚠ 网段判不出来：UU 给的多半是 172.16-31 / 10.x 这种普通私有段，跟家里路由器重合，
   *     所以只能按**网卡名**认（中文名"UU加速器 / 网易UU"和英文名 "NetEase UU" 都匹配）。 */
  if (/uu|网易|netease|云联机/i.test(n)) return 'uu';
  if (/radmin/i.test(n) || /^26\./.test(address)) return 'radmin';
  if (/tailscale/i.test(n) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 'tailscale';
  if (/zerotier|hamachi|wireguard|openvpn|\bvpn\b|nordlynx|proton/i.test(n)) return 'vpn';
  /* ★ TAP / Wintun 虚拟网卡：UU、各类加速器和内网穿透工具多半用它们，但网卡名可能是通用的
   *   "TAP-Windows Adapter V9" —— 认不出是哪家，只知道"这是块虚拟网卡"。
   *   必须在 vm 判定**之前**，否则带 Virtual 字样的通用名会被当成虚拟机网卡丢掉。 */
  if (/tap-|tun-|wintun|tap\s*adapter/i.test(n)) return 'tap';
  if (/vmware|virtualbox|vbox|hyper-?v|qemu|docker|vmnet|loopback|virtual|utun/i.test(n)) return 'vm';
  if (/^192\.168\./.test(address) || /^10\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 'lan';
  return 'other';
}

const NIC_LABEL = {
  lan: '同 WiFi / 同路由器 —— 同一局域网内用这条',
  uu: 'UU 加速器「云联机」虚拟局域网 —— 双方都在 UU 的同一个房间里，发这条（别发物理局域网 IP）',
  tap: '虚拟网卡（TAP / Wintun）—— 加速器或内网穿透软件建的；对方在同一个虚拟网里就发这条',
  radmin: 'Radmin VPN —— 双方先在 Radmin 里进同一个网络，再用这条',
  tailscale: 'Tailscale —— 双方在同一 tailnet 里用这条',
  vpn: 'VPN 网卡 —— 双方在同一个 VPN 网络里可用',
  other: '其它网卡 —— 一般用不上',
  apipa: '系统自动分配的无效地址（对方连不上，别发）',
  vm: '虚拟机网卡（对方连不上，别发）',
  host: '本机回环 —— 只有自己能用',
};

/* ★ 网卡别名 → 分类的**外置规则**（2026-09-27）：加速器软件改个网卡名，内置正则就全废了；
 *   与其每次改代码，不如让用户自己声明。文件不存在 = 没有自定义规则，行为完全不变。
 *   格式（game/data/nic-hints.json），键是分类名、值是网卡名正则数组（不分大小写）：
 *     { "_说明": "…", "uu": ["uu加速器", "netease"], "radmin": ["我的vpn"] }
 *   坏正则只跳过那一条，不会搞崩服务器。 */
const NIC_HINT_FILE = path.join(ROOT, 'game', 'data', 'nic-hints.json');
function loadNicHints() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(NIC_HINT_FILE, 'utf8')); } catch (e) { return {}; }
  const out = {};
  Object.keys(raw || {}).forEach(function (kind) {
    if (String(kind).charAt(0) === '_') return;              // _ 开头的是说明键，不是规则
    const list = (raw[kind] || []).filter(function (s) { return typeof s === 'string' && s; });
    if (!list.length) return;
    const res = [];
    list.forEach(function (s) { try { res.push(new RegExp(s, 'i')); } catch (e) { } });
    if (res.length) out[kind] = res;
  });
  return out;
}

/* 虚拟局域网类：检测到就说明用户在用组网工具，UI 里的"推荐地址"优先给它们 */
const VIRTUAL_KINDS = { uu: 1, tap: 1, radmin: 1, tailscale: 1, vpn: 1 };

function lanAddresses() {
  const hints = loadNicHints();
  const out = [];
  const nics = os.networkInterfaces();
  Object.keys(nics).forEach(function (name) {
    (nics[name] || []).forEach(function (a) {
      if (a.family !== 'IPv4' || a.internal) return;
      out.push({ name: name, address: a.address, kind: classifyNic(name, a.address, hints) });
    });
  });
  const order = { lan: 0, uu: 1, tap: 2, radmin: 3, tailscale: 4, vpn: 5, other: 6, apipa: 7, vm: 8 };
  out.sort(function (a, b) {
    const d = (order[a.kind] == null ? 9 : order[a.kind]) - (order[b.kind] == null ? 9 : order[b.kind]);
    return d !== 0 ? d : a.address.localeCompare(b.address);
  });
  return out;
}

/* "该发哪条地址"：检测到虚拟局域网（UU / TAP / Radmin / Tailscale / VPN）就推荐它 ——
 * 用户既然装了组网工具，多半就是为了跨网联机；没有就退回第一条物理局域网地址。
 * ⚠ 只是推荐：UI 和控制台都会把全部地址列出来，用户想发哪条都行。 */
function pickRecommended(list) {
  const usable = list.filter(function (a) { return a.kind !== 'apipa' && a.kind !== 'vm'; });
  const virt = usable.filter(function (a) { return VIRTUAL_KINDS[a.kind]; });
  return virt[0] || usable[0] || list[0] || null;
}
function addressUrl(a, port) { return 'http://' + a.address + ':' + port + '/game/index.html'; }

/* 房主 UI 用的一份网络信息（GET /kg-net）：浏览器拿不到服务端的网卡列表，只能问服务器要。 */
function netInfo(port) {
  const list = lanAddresses();
  const rec = pickRecommended(list);
  return {
    ok: true, port: port, lan: !LOCAL_ONLY,
    recommended: rec ? { name: rec.name, address: rec.address, kind: rec.kind,
                         label: NIC_LABEL[rec.kind] || rec.kind, url: addressUrl(rec, port) } : null,
    addresses: list.map(function (a) {
      return { name: a.name, address: a.address, kind: a.kind, label: NIC_LABEL[a.kind] || a.kind,
               url: addressUrl(a, port), relay: a.address + ':' + port };
    }),
    virtual: list.some(function (a) { return VIRTUAL_KINDS[a.kind]; }),
  };
}

function printAddresses(port) {
  const list = lanAddresses();
  if (!list.length) {
    console.log('  （没检测到任何可用网卡地址，只能本机玩）');
    return;
  }
  // 同类合并：同一类的地址打在一个小标题下面
  const groups = [];
  list.forEach(function (a) {
    const g = groups.filter(function (x) { return x.kind === a.kind; })[0];
    if (g) g.items.push(a); else groups.push({ kind: a.kind, items: [a] });
  });
  console.log('  ── 把下面某一条地址发给对方（对方用浏览器直接打开即可）──');
  groups.forEach(function (g) {
    console.log('');
    console.log('    ' + (NIC_LABEL[g.kind] || g.kind) + '：');
    g.items.forEach(function (a) {
      console.log('      http://' + a.address + ':' + port + '/game/index.html      [' + a.name + ']');
    });
  });
  console.log('');
  console.log('  对方打开后：进「对战」页 → 右侧顶部点「联机 · 局域网」→ 填你显示的 4 位房间码 → 加入。');
  if (list.some(function (a) { return a.kind === 'radmin'; })) {
    console.log('  Radmin：两边都要在 Radmin 里加入**同一个网络**（网络名+密码一致）才能互相访问；');
    console.log('          首次运行若弹防火墙提示，必须点「允许访问」。');
  }
  /* ★ UU 加速器 / 虚拟局域网（2026-09-27）：UU 的「云联机」是给同房间每人发一个虚拟 IP，
   *   我们的游戏没被收录 → 用「通用联机」建房。关键只有一句：**发虚拟 IP，别发物理局域网 IP**。 */
  if (list.some(function (a) { return a.kind === 'uu' || a.kind === 'tap'; })) {
    console.log('  UU / 虚拟局域网：两边都要在加速器里进**同一个房间**，然后发**软件分配的虚拟 IP**');
    console.log('          （上面标着「UU 加速器」或「虚拟网卡」的那条）—— 发物理局域网 IP 对方连不上。');
    console.log('          游戏没被 UU 收录就选「通用联机」建房；对方那边把虚拟 IP:端口 填进联机面板的');
    console.log('          「服务器地址」，或者打开带 ?relay=虚拟IP:端口 的链接，效果一样。');
  }
}

/* ★ 导出的都是纯函数（不启服务器、不占端口）—— 网卡分类规则可以单测，
 *   见 game/tools/serve-nic-selftest.js。只有直接 `node serve.js` 时才真正监听端口。 */
module.exports = {
  classifyNic: classifyNic, lanAddresses: lanAddresses, netInfo: netInfo,
  pickRecommended: pickRecommended, addressUrl: addressUrl,
  NIC_LABEL: NIC_LABEL, loadNicHints: loadNicHints,
};

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  KG 游戏地址: http://127.0.0.1:' + PORT + '/game/index.html');
    if (!LOCAL_ONLY) {
      console.log('');
      printAddresses(PORT);
    } else {
      console.log('  （--local：只听本机，联机功能不可用）');
    }
    console.log('');
    console.log('  Ctrl+C 停止');
    console.log('');
  });
}
