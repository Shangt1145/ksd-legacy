/* ==========================================================================
 * KARDS DIY —— Electron 桌面壳（主进程）
 * --------------------------------------------------------------------------
 * 设计原则：**不改造游戏本身**。主进程只做三件事
 *   1. 找一个空闲端口，把项目里现成的 game/tools/serve.js 拉起来（HTTP + WebSocket 联机
 *      + 固化卡 / 异画对位的 POST 接口全部原样复用，不需要为桌面版再写一份后端）
 *   2. 开一个窗口指向 http://127.0.0.1:<port>/game/index.html
 *   3. 退出时收干净
 *
 * 目录约定（见 package.json 的 extraResources）：
 *   resources/app/game/...      ← 游戏本体（与仓库里的 game/ 一模一样）
 *   resources/app/UN  USG 星盟 av76 deran 自定义 …   ← 卡图目录，必须与 game/ 同级
 *   （serve.js 的 ROOT 是它自己往上两级，所以卡图必须和 game/ 平级，别塞进 game/ 里）
 *
 * 开发模式（npm start，没打包）直接用仓库根目录，行为完全一致。
 * ========================================================================== */
'use strict';
const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('fs');
const { fork } = require('child_process');

/* ★ 关于 ELECTRON_RUN_AS_NODE（踩过的坑，别再踩）：
 *   游戏里点【一键固化所有自定义卡】时，serve.js 会 spawn(process.execPath, ['fix-custom.js'])，
 *   而 Electron 里 process.execPath = KARDS.exe → 不设这个变量，它会再开一个游戏窗口而不是跑脚本。
 *   ⚠ 但**只能在 fork/spawn 子进程的 env 里设**（下面 startServer 里就是这么做的）。
 *   在主进程顶部 `process.env.ELECTRON_RUN_AS_NODE = '1'` 会连主进程一起变成纯 Node 模式
 *   → `require('electron')` 拿到的 app 是 undefined → 启动即崩（实测：Cannot set properties of undefined）。
 *   这个变量是**进程启动时**读取的，不是 spawn 时才读，所以"只影响子进程"的设想不成立。 */

const TITLE = 'KARDS DIY';
/* 自检模式：KG_NO_GUI=1 时只把内嵌服务器拉起来、不建窗口（CI / 冒烟测试用）。
 * 正常双击运行不会带这个变量，行为完全不变。 */
const NO_GUI = !!process.env.KG_NO_GUI;
let win = null;
let serverStarted = false;
let serverPort = null;
let quitting = false;
/* 卡组回填只在本进程里做一次（页面 reload 还会再触发 did-finish-load，别反复写） */
let deckRestoreDone = false;

/* ------------------------------------------------------- 窗口状态记忆 */
/* 玩家上次把窗口拉到多大/放哪里/是不是最大化，这次照旧 —— 游戏应用的常识。
 * ★ 优先写到**游戏目录**（便携 zip 的理念：整个目录拷 U 盘，配置跟着走）；
 *   目录只读（比如有人把 zip 解压进 Program Files）就退回 userData，再失败就当没有。 */
const WIN_STATE_FILE = 'window-state.json';
function loadWindowState() {
  const candidates = [path.join(app.getPath('userData'), WIN_STATE_FILE), path.join(rootDir(), WIN_STATE_FILE)];
  for (const f of candidates) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (s && s.bounds && Number.isFinite(s.bounds.width) && Number.isFinite(s.bounds.height)) return s;
    } catch (e) { /* 没有就当第一次启动 */ }
  }
  return null;
}
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const st = {
    bounds: win.getNormalBounds(),          // 最大化时的"还原后"尺寸，别存铺满全屏的假尺寸
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
  };
  for (const dir of [app.getPath('userData'), rootDir()]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, WIN_STATE_FILE), JSON.stringify(st));
      return;                                 // 第一个写成功的地方就算数
    } catch (e) { /* 只读目录 → 试下一个 */ }
  }
}

/* --------------------------------------------------------------- 路径与端口 */
function rootDir() {
  // 打包后：resources/app
  if (app.isPackaged) return path.join(process.resourcesPath, 'app');
  /* 开发入口也使用桌面资源：优先本项目 game/，否则使用现有便携版。
   * Gamme 是废弃的网页版，不再作为运行入口的自动回退路径。 */
  const cands = [
    __dirname,
    path.join(__dirname, 'resources', 'app'),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, 'game', 'index.html'))) return c; } catch (e) { }
  }
  return cands[0];
}

/* ★ 端口必须钉死（2026-09-28）：localStorage 按"协议+IP:端口"分命名空间，
 *   以前每次 listen(0) 随机挑端口 → 每次启动换储物柜 → 卡组"反复消失"。
 *   优先 5912；被占用（僵尸进程/残留 serve）时依次退 5913/5914，再不行才随机兜底。 */
const PREFERRED_PORTS = [5912, 5913, 5914];
function pickPort() {
  return (async () => {
    for (const p of PREFERRED_PORTS) {
      const ok = await new Promise(resolve => {
        const srv = net.createServer();
        srv.on('error', () => resolve(false));
        srv.listen({port:p,host:'0.0.0.0',exclusive:true}, () => { const prt = srv.address().port; srv.close(() => resolve(prt === p)); });
      });
      if (ok) return p;
    }
    // 兜底：全被占才随机（此时卡组会"看起来消失"，控制台里骂一句提醒自己）
    console.warn('[shell] 5912-5914 全被占用，退回随机端口 —— 卡组会串柜！查一下谁占着端口。');
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on('error', reject);
      srv.listen({port:0,host:'0.0.0.0',exclusive:true}, () => { const port = srv.address().port; srv.close(() => resolve(port)); });
    });
  })();
}

let child = null;
function playerDir() { return path.join(app.getPath('userData'), 'player-data'); }

/* 内嵌服务器：fork 项目自带的 serve.js（HTTP + WebSocket 联机 + 固化卡接口全都在里面）。
 * ★ 为什么是 fork 而不是 require：
 *   ① serve.js 用 `process.argv.slice(2)` 取端口 —— Electron 打包后 argv 只有 [exe] 一个元素，
 *      往主进程 argv 里 push 端口会被 slice(2) 整个切掉（实测会回落到默认 8731 并因占用而崩）；
 *      fork 出来的子进程 argv 是标准的 [node, script, port]，slice(2) 拿得到。
 *   ② serve.js 里固化自定义卡会 spawn(process.execPath, ['fix-custom.js'])，
 *      在 Electron 里 process.execPath 是 KARDS.exe；配合上面的 ELECTRON_RUN_AS_NODE=1
 *      子进程会以纯 Node 模式跑脚本，而不是再开一个游戏窗口。
 *   于是仓库里的 serve.js **一个字都不用改**。 */
async function startServer() {
  if (serverStarted) return serverPort;
  const ROOT = rootDir();
  const servePath = path.join(ROOT, 'game', 'tools', 'serve.js');
  if (!fs.existsSync(servePath)) {
    dialog.showErrorBox(TITLE, '没找到游戏本体：\n' + servePath + '\n\n请确认 extraResources 里带了 game/ 目录。');
    app.quit();
    return null;
  }
  const port = await pickPort();
  // Keep the writable card pool outside replaceable release folders.
  const DATA_ROOT = require(path.join(ROOT, 'game/tools/player-cards.js')).prepare(ROOT, playerDir());
  const args = [String(port)];
  // 想只玩单机、不让 Windows 弹防火墙提示 → 打开下面这一行
  // args.push('--local');
  child = fork(servePath, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', KG_DATA_ROOT: DATA_ROOT }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', d => process.stdout.write('[serve] ' + d));
  child.stderr.on('data', d => process.stderr.write('[serve] ' + d));
  child.on('exit', (code) => { if (!quitting) console.warn('[serve] 服务器子进程退出，code=' + code); });
  serverStarted = true;
  serverPort = port;
  return port;
}

/* ------------------------------------------------------------------- 菜单 */
function buildMenu() {
  const tpl = [
    {
      label: '游戏',
      submenu: [
        // ⚠ 故意**不绑** Ctrl+R / F5：对战打到一半误触刷新 = 局面全丢。想刷新走菜单点。
        { label: '重新载入（放弃当前对局）', click: () => win && win.reload() },
        { label: '强制刷新（清缓存）', click: () => win && win.webContents.reloadIgnoringCache() },
        { label: '全屏', accelerator: 'F11', click: () => win && win.setFullScreen(!win.isFullScreen()) },
        { type: 'separator' },
        { label: '打开数据目录', click: () => shell.openPath(playerDir()) },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '调试',
      submenu: [
        { label: '开发者工具', accelerator: 'Ctrl+Shift+I', click: () => win && win.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: '强制回填卡组（清标记并刷新）', click: () => {
          if (!win) return;
          const skipFile = path.join(__dirname, '_deck_restore.done');
          try { fs.existsSync(skipFile) && fs.unlinkSync(skipFile); } catch (e) {}
          deckRestoreDone = false;                 // 让 did-finish-load 里的自检重新跑一遍
          win.webContents.reload();
        } },
        { label: '打开卡组诊断文件', click: () => {
          const f = path.join(__dirname, '_deck_diag.json');
          try {
            if (!fs.existsSync(f)) fs.writeFileSync(f, '（还没生成：说明自检没跑起来）', 'utf8');
            shell.showItemInFolder(f);
          } catch (e) {}
        } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

/* 等内嵌服务器真正能应答再加载页面 —— 否则 fork 出来的服务还没 listen 就 loadURL，会白屏。
 * ★ 用 net.connect 做 TCP 探活，**不要用 fetch**：
 *   Electron 主进程的 fetch 走 Chromium 网络栈，会被系统代理 / PAC 探测拖住甚至拦掉，
 *   实测同一份代码一会儿就绪一会儿超时。TCP 连上就说明 listen 完成，足够可靠。 */
function probe(port) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port: port });
    let done = false;
    const end = v => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(v); };
    sock.setTimeout(800);
    sock.on('connect', () => end(true));
    sock.on('error', () => end(false));
    sock.on('timeout', () => end(false));
  });
}

async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    if (await probe(port)) return true;
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
}

/* ------------------------------------------------------------------- 窗口 */
async function createWindow() {
  const port = await startServer();
  if (port == null) return;
  const ready = await waitPort(port);
  if (!ready) {
    dialog.showErrorBox(TITLE, '本地服务器没能在 15 秒内启动（端口 ' + port + '）。\n可以试试关掉已经开着的 serve.js。');
    app.quit();
    return;
  }
  console.log('[shell] 服务器就绪 → http://127.0.0.1:' + port + '/game/index.html');
  if (NO_GUI) { console.log('[selfcheck] OK（KG_NO_GUI=1：服务器起来了，不建窗口，自动退出）'); app.quit(); return; }

  const saved = loadWindowState();
  win = new BrowserWindow({
    title: TITLE,
    // 上次的窗口尺寸/位置；没存过就 1440×900 并居中
    x: saved ? saved.bounds.x : undefined,
    y: saved ? saved.bounds.y : undefined,
    width: saved ? saved.bounds.width : 1440,
    height: saved ? saved.bounds.height : 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#101318',
    show: false,
    autoHideMenuBar: true,              // Alt 键才显示菜单条，游戏画面优先
    webPreferences: {
      nodeIntegration: false,           // 游戏是纯前端，不需要 node 权限
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
    },
  });
  // 上次是最大化（或第一次启动）→ 直接铺满工作区：游戏应用的常识，没人是"玩一小格"的
  if (!saved || saved.maximized) win.maximize();
  if (saved && saved.fullscreen) win.setFullScreen(true);
  // 拖动窗口 / 改尺寸 / 最大化还原都记下来（防抖 400ms，move 是高频事件别每次写盘），
  // 真正落盘靠 debounce + 关闭时兜底各一次
  let winStateTimer = null;
  const saveWindowStateSoon = () => {
    if (winStateTimer) clearTimeout(winStateTimer);
    winStateTimer = setTimeout(() => { winStateTimer = null; saveWindowState(); }, 400);
  };
  ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach(ev =>
    win.on(ev, () => { if (!quitting) saveWindowStateSoon(); }));

  win.once('ready-to-show', () => { win.show(); win.focus(); });
  let closeReady = false;
  win.on('close', e => {
    if (winStateTimer) { clearTimeout(winStateTimer); winStateTimer = null; }
    saveWindowState();
    if (closeReady) return;
    e.preventDefault();
    const closing = win;
    closing.webContents.executeJavaScript('(async () => { if(window.KG_BEFORE_CLOSE && !(await window.KG_BEFORE_CLOSE()))return false; if(window.KG_AUTO_SAVE)await window.KG_AUTO_SAVE.flush(); return true; })()').then(approved => {
      if (!approved || closing.isDestroyed()) return;
      closeReady = true; closing.close();
    }).catch(error => {
      dialog.showErrorBox(TITLE, '自动存档失败，窗口暂时保留，请腾出磁盘空间后重试。\n' + error.message);
    });
  });
  win.on('closed', () => { win = null; });
  // 加载状态打到主进程日志：白屏/404 时一眼看出是"没起来"还是"页面炸了"
  win.webContents.on('did-finish-load', () => console.log('[shell] 页面加载完成：' + win.webContents.getTitle()));
  win.webContents.on('did-fail-load', (e, code, desc) => console.error('[shell] 页面加载失败：' + code + ' ' + desc));

  // 外链交给系统浏览器，不要在壳里弹窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  win.loadURL('http://127.0.0.1:' + port + '/game/index.html');

  /* ★ 卡组自检+回填（2026-09-29 修）：did-finish-load 后读页面 localStorage 里的 kg.deckLib，
   *   库空且存在 _deck_restore.json → 回填 + 刷新。诊断一律落 _deck_diag.json。
   *   ⚠ 踩过的两个坑，别再踩：
   *     ① 这里**不能用 ROOT** —— 它是 startServer() 里的局部变量，用了就是
   *        "ReferenceError: ROOT is not defined" 弹框盖住整个游戏。取路径用 rootDir()。
   *     ② 整块必须 try/catch 包死：did-finish-load 的监听器里抛异常 = Electron 弹错误框。 */
  win.webContents.on('did-finish-load', async () => {
    const diagFile = path.join(__dirname, '_deck_diag.json');
    const skipFile = path.join(__dirname, '_deck_restore.done');
    let log = ['fired @' + new Date().toISOString()];
    const flush = () => { try { fs.writeFileSync(diagFile, log.join('\n'), 'utf8'); } catch (e) {} };
    try {
      if (deckRestoreDone) { log.push('本次会话已处理，跳过'); flush(); return; }
      if (fs.existsSync(skipFile)) { log.push('已回填过（' + skipFile + ' 存在），跳过；想再来一次就删掉这个文件'); flush(); return; }
      const nativeRestored = await win.webContents.executeJavaScript('(async function(){if(!window.KG_AUTO_SAVE)return false;await KG_AUTO_SAVE.init();return !!KG_AUTO_SAVE.restored;})()', false);
      if (nativeRestored) { log.push('已恢复原生玩家存档，跳过旧卡组回填'); deckRestoreDone = true; flush(); return; }

      /* 回填文件可能在 app 目录 / 仓库根 / tools 下（开发模式布局不一样），都找一遍 */
      const cands = [
        path.join(__dirname, '_deck_restore.json'),
        path.join(rootDir(), '_deck_restore.json'),
        path.join(__dirname, 'tools', '_deck_restore.json'),
      ];
      let migFile = null, payload = null;
      for (const f of cands) {
        try { if (fs.existsSync(f)) { migFile = f; payload = fs.readFileSync(f, 'utf8'); break; } } catch (e) {}
      }
      if (!payload) { log.push('没找到 _deck_restore.json（找过：' + cands.join(' / ') + '）'); flush(); return; }
      const pj = JSON.parse(payload);
      if (!pj || !Array.isArray(pj.decks) || !pj.decks.length) { log.push('回填文件里没有卡组'); flush(); return; }
      log.push('回填文件=' + migFile + '，卡组数=' + pj.decks.length);

      const code = '(function(){try{'
        + 'var raw=localStorage.getItem("kg.deckLib");'
        + 'var cur=null;try{cur=JSON.parse(raw)}catch(e){}'
        + 'var n=cur&&cur.decks?cur.decks.length:-1;'
        + 'var act="noS";try{if(window.S&&S.deckLib&&S.deckLib.decks)act=S.deckLib.decks.map(function(d){return d.name+":"+d.cards.length}).join("|")}catch(e){act="Serr:"+e.message}'
        + 'return JSON.stringify({n:n,act:act,origin:location.origin,lsLen:raw?raw.length:0})'
        + '}catch(e){return "err:"+e.message}})()';

      // WebContents returns a Promise; it does not invoke a third-argument callback.
      // A failed read must stop migration so existing decks cannot be overwritten.
      const out = String(await win.webContents.executeJavaScript(code, false));
      log.push('页面状态=' + out);
      const status = JSON.parse(out);
      if (!Number.isInteger(status.n) || status.n < -1) throw new Error('无效的卡组检测结果');
      if (status.n > 0) { log.push('卡组已在（' + status.n + ' 套），无需回填'); deckRestoreDone = true; flush(); return; }

      const setCode = '(function(){'
        + 'localStorage.setItem("kg.deckLib",' + JSON.stringify(payload) + ');'
        + 'var v=JSON.parse(localStorage.getItem("kg.deckLib"));'
        + 'if(!v||!Array.isArray(v.decks)||v.decks.length!==' + pj.decks.length + ')throw new Error("卡组写回验证失败");'
        + 'return v.decks.length;'
        + '})()';
      const restored = await win.webContents.executeJavaScript(setCode, false);
      log.push('回填结果=成功，卡组数=' + restored);
      deckRestoreDone = true;
      try { fs.writeFileSync(skipFile, new Date().toISOString() + ' -> ' + migFile, 'utf8'); } catch (e) {}
      log.push('写回成功，刷新页面');
      flush();
      win.webContents.reload();
    } catch (eTop) {
      log.push('顶层异常:' + (eTop && eTop.message));
      flush();
    }
  });
}

/* ------------------------------------------------------------------- 生命周期 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    const store = require('./player-storage.js'), file = path.join(playerDir(), 'web-save.json');
    const trusted = event => win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame &&
      ['index.html', 'inspector.html'].some(page => event.senderFrame.url.split(/[?#]/)[0] === 'http://127.0.0.1:' + serverPort + '/game/' + page);
    ipcMain.handle('kg-player-read', event => { if (!trusted(event)) throw new Error('不允许访问玩家存档'); return store.read(file); });
    ipcMain.handle('kg-player-write', (event, snapshot) => { if (!trusted(event)) throw new Error('不允许写入玩家存档'); store.write(file, snapshot); return { ok: true }; });
    buildMenu();
    try { await createWindow(); }
    catch (error) { dialog.showErrorBox(TITLE, '自动迁移失败，原数据已保留。\n' + error.message); app.quit(); }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { if (child) { try { child.kill(); } catch (e) {} } });
  app.on('window-all-closed', () => app.quit());
}
