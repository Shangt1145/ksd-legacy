/* Hidden Electron regression checks with disposable card files and profiles.
 * Run: node_modules/electron/dist/electron.exe tools/check-builtin-deletion.js
 * No player cards, decks or application windows are touched.
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), http = require('http');
const { fork, execFileSync } = require('child_process');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..');
const runtime = path.join(repo, 'resources/app');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kards-delete-check-'));
app.setPath('userData', path.join(root, 'profile'));
const servers = [], windows = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const card = (id, set = 'UN', extra = {}) => ({ id, name: id, set, cardType: 'unit', unitType: 'infantry',
  cost: 1, opCost: 1, attack: 1, defense: 1, rarity: 'iron', keywords: [], keywordsRaw: [], kwMap: {}, effects: [], ...extra });
const saved = [card('release/unit'), card('custom/saved-later'), card('token/unit', 'UN', { token: true }),
  card('other/unit', 'GE'), card('custom/saved-series', '自定义')];
const local = card('custom/unsaved', '自定义');
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
function nationCards(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_meta.json')
    .flatMap(f => Object.values(JSON.parse(fs.readFileSync(path.join(dir, f))).cards));
}
function helperChecks() {
  const { deleteCards } = require('../electron/game/tools/delete-cards.js');
  const folder = path.join(root, 'helper'), nations = path.join(folder, 'game/data/nations');
  write(path.join(nations, 'A.json'), { cards: { duplicate: card('duplicate'), keep: card('keep') } });
  write(path.join(nations, 'B.json'), { cards: { duplicate: card('duplicate'), alias: card('custom/saved') } });
  write(path.join(nations, '_meta.json'), { orphanAliases: {} });
  const result = deleteCards(folder, ['duplicate', 'custom/saved', 'duplicate', 'absent']);
  assert.deepEqual(result.deletedIds.sort(), ['custom/saved', 'duplicate']);
  assert.deepEqual(result.missingIds, ['absent']);
  assert.deepEqual(nationCards(nations).map(c => c.id), ['keep']);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(result.backup, 'A.json'))).cards).length, 2);
  assert.equal(deleteCards(folder, ['duplicate']).deletedIds.length, 0);
  const original = fs.readFileSync(path.join(nations, 'A.json'), 'utf8');
  fs.writeFileSync(path.join(nations, 'Z.json'), '{broken');
  assert.throws(() => deleteCards(folder, ['keep']));
  assert.equal(fs.readFileSync(path.join(nations, 'A.json'), 'utf8'), original);
  console.log('PASS disk batch: duplicates, saved custom cards, backups, missing IDs, parse failure before writes');
}
function fixture(name, mobile) {
  const folder = path.join(root, name), game = path.join(folder, 'game');
  const web = mobile ? path.join(repo, 'kards-mobile/www/game') : path.join(runtime, 'game');
  for (const sub of ['js', 'css', 'fonts']) {
    if (fs.existsSync(path.join(web, sub))) fs.cpSync(path.join(web, sub), path.join(game, sub), { recursive: true });
  }
  fs.copyFileSync(path.join(mobile ? web : path.join(repo, 'electron/game'), 'index.html'), path.join(game, 'index.html'));
  if (!mobile) {
    for (const sub of ['js', 'css']) fs.cpSync(path.join(repo, 'electron/game', sub), path.join(game, sub), { recursive: true });
  }
  for (const set of [...new Set(saved.map(c => c.set))]) {
    write(path.join(game, 'data/nations', set + '.json'), { nation: set, cards: Object.fromEntries(saved.filter(c => c.set === set).map(c => [c.id, c])) });
  }
  write(path.join(game, 'data/nations/_meta.json'), { orphanAliases: {} });
  // An obsolete export must never bring deleted cards back on refresh.
  write(path.join(game, 'data/cards.json'), { cards: saved });
  const toolsDir = path.join(game, 'tools'); fs.mkdirSync(toolsDir, { recursive: true });
  for (const name of ['ws.js', 'alt-art-lib.js', 'merge.js', 'build-effects.js']) {
    fs.copyFileSync(path.join(runtime, 'game/tools', name), path.join(toolsDir, name));
  }
  for (const name of ['serve.js', 'delete-cards.js']) fs.copyFileSync(path.join(repo, 'electron/game/tools', name), path.join(toolsDir, name));
  for (const script of ['merge.js', 'build-effects.js']) execFileSync(process.execPath, [path.join(toolsDir, script)],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe' });
  fs.copyFileSync(path.join(repo, 'kards-mobile/www/index.html'), path.join(folder, 'index.html'));
  return folder;
}
async function startServer(folder, mobile) {
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => {
    const p = s.address().port; s.close(() => resolve(p)); }); });
  const script = mobile ? path.join(repo, 'tools/mobile/_serve.js') : path.join(folder, 'game/tools/serve.js');
  const args = mobile ? [folder, String(port), '--cap'] : [String(port), '--local'];
  const child = fork(script, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' }); servers.push(child);
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise(resolve => { const req = http.get(`http://127.0.0.1:${port}/game/index.html`, r => {
      r.resume(); resolve(r.statusCode === 200); }); req.on('error', () => resolve(false)); });
    if (ok) return `http://127.0.0.1:${port}/game/index.html`; await pause(100);
  }
  throw new Error('Fixture server failed to start');
}
async function until(win, expression) {
  for (let i = 0; i < 200; i++) { if (await win.webContents.executeJavaScript(expression)) return; await pause(50); }
  throw new Error('Timed out: ' + expression);
}
async function snapshot(win) {
  return win.webContents.executeJavaScript(`(() => { const s=KG.ui; return {
    pool:s.pool.map(c=>c.id).sort(), custom:s.custom.map(c=>c.id).sort(),
    decks:s.deckLib.decks.map(d=>d.cards), backup:Object.keys(JSON.parse(localStorage.getItem('kg.removed.bak')||'{}')).sort(),
    error:document.querySelector('#errorText').textContent, removed:Object.keys(s.removed||{}).sort()
  }; })()`);
}
async function remove(win, set, count, cancel = false) {
  await win.webContents.executeJavaScript(`document.querySelector('#delBuiltinSel').value=${JSON.stringify(set)}; document.querySelector('#delBuiltinBtn').click()`);
  await until(win, `!!document.querySelector('.kg-ask-mask')`);
  const text = await win.webContents.executeJavaScript(`document.querySelector('.kg-ask-acts .danger').textContent`);
  assert.equal(text, '删除 ' + count + ' 张');
  await win.webContents.executeJavaScript(`document.querySelector('.kg-ask-acts .${cancel ? 'ghost' : 'danger'}').click()`);
  await until(win, `!KG.ui.removingBuiltins`);
}
async function uiChecks(name, mobile, byNation) {
  const folder = fixture(name, mobile), url = await startServer(folder, mobile);
  const win = new BrowserWindow({ width: mobile ? 900 : 1400, height: mobile ? 500 : 900, show: false,
    webPreferences: { backgroundThrottling: false, partition: name } }); windows.push(win);
  await win.loadURL(url); await until(win, `!!window.KG?.ui?.pool?.length && !!document.querySelector('#delBuiltinSel option[value="UN"]')`);
  await win.webContents.executeJavaScript(`localStorage.setItem('kg.custom', ${JSON.stringify(JSON.stringify([saved[1], local]))});
    localStorage.setItem('kg.deck', ${JSON.stringify(JSON.stringify(saved.map(c=>c.id).concat(local.id)))});
    localStorage.setItem('kg.deckLib', ${JSON.stringify(JSON.stringify({ cur: null, decks: [{id:'fixture', name:'fixture', restrict:false, cards:saved.map(c=>c.id).concat(local.id)}] }))});`);
  await win.loadURL(url); await until(win, `window.KG?.ui?.pool?.length===6 && !!document.querySelector('#delBuiltinSel option[value="自定义"]')`);
  assert.equal(await win.webContents.executeJavaScript(`KG.ui.isCustomCard(KG.ui.pool.find(c=>c.id==='custom/saved-later'))`), false);
  assert.equal(await win.webContents.executeJavaScript(`KG.ui.isCustomCard(KG.ui.pool.find(c=>c.id==='custom/unsaved'))`), true);
  await remove(win, '__all__', 5, true);
  assert.equal((await snapshot(win)).pool.length, 6);
  if (byNation) {
    await remove(win, 'UN', 3);
    assert.deepEqual((await snapshot(win)).pool, ['custom/saved-series', local.id, 'other/unit'].sort());
    await win.loadURL(url); await until(win, `window.KG?.ui?.pool?.length===3 && !!document.querySelector('#delBuiltinSel')`);
    await remove(win, '__all__', 2);
  } else await remove(win, '__all__', 5);
  let state = await snapshot(win);
  assert.deepEqual(state.pool, [local.id]); assert.deepEqual(state.custom, [local.id]);
  assert.deepEqual(state.decks, [[local.id]]); assert.equal(state.backup.length, 5);
  assert.equal(state.error, '');
  assert.equal(nationCards(path.join(folder, 'game/data/nations')).length, mobile ? 5 : 0);
  await win.loadURL(url); await until(win, `window.KG?.ui?.pool?.length===1`);
  state = await snapshot(win); assert.deepEqual(state.pool, [local.id]); assert.equal(state.error, '');
  // Local copies restored from a backup must obey deletion marks too.
  await win.webContents.executeJavaScript(`KG.ui.peerOverrides={'custom/saved-later':${JSON.stringify(saved[1])}};
    localStorage.setItem('kg.custom.bak',${JSON.stringify(JSON.stringify([saved[1]]))}); KG.ui.restoreCustomBackup()`);
  assert.deepEqual((await snapshot(win)).pool, [local.id]);
  console.log(`PASS ${name}: ${byNation ? 'nation then All' : 'All'}, saved custom + tokens, cancel, local cards, decks, backup, refresh, peer snapshots`);
  win.destroy();
}
app.whenReady().then(async () => {
  try {
    helperChecks();
    await uiChecks('desktop-all', false, false);
    await uiChecks('desktop-nation', false, true);
    await uiChecks('phone-all', true, false);
    await uiChecks('phone-nation', true, true);
    for (const s of servers) s.kill(); app.exit(0);
  } catch (error) { console.error(error.stack); for (const s of servers) s.kill(); app.exit(1); }
});
app.on('before-quit', () => { for (const s of servers) s.kill(); });
app.on('window-all-closed', () => {});
