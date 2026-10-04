'use strict';
// Every save, profile, release and image in this test is disposable.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kards-migration-'));
app.setPath('userData', path.join(temp, 'profile'));
app.commandLine.appendSwitch('no-proxy-server');
app.on('window-all-closed', () => {});
const { prepare, catalog } = require('../electron/game/tools/player-cards.js');
const store = require('../player-storage.js');
const wins = [], servers = [];
function write(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); }
const card = (id, extra = {}) => ({ id, name: id, set: 'UN', cardType: 'unit', unitType: 'infantry',
  cost: 1, opCost: 1, attack: 2, defense: 3, rarity: 'iron', keywords: [], keywordsRaw: [], kwMap: {}, kwValues: {}, effects: [], ...extra });
function release(name, cards) {
  const root = path.join(temp, name);
  for (const set of new Set(cards.map(c => c.set))) write(path.join(root, 'game/data/nations', set + '.json'),
    { nation: set, cards: Object.fromEntries(cards.filter(c => c.set === set).map(c => [c.id, c])) });
  write(path.join(root, 'game/data/nations/_meta.json'), { orphanAliases: {} });
  fs.mkdirSync(path.join(root, 'game/tools'), { recursive: true });
  for (const name of ['merge.js', 'build-effects.js']) fs.copyFileSync(path.join(repo, 'electron/game/tools', name), path.join(root, 'game/tools', name));
  return root;
}
function diskChecks() {
  const diy = card('custom/saved', { adopted: true, set: '自定义', src: '自定义/同名.png', dualAttack: true,
    kwMap: { magneticreactivearmor: true }, kwValues: { magneticreactivearmor: 3 }, effects: [{ trigger: 'deploy', actions: [] }] });
  const r1 = release('old-release', [card('builtin'), card('deleted'), diy]);
  fs.mkdirSync(path.join(r1, '自定义'), { recursive: true }); fs.writeFileSync(path.join(r1, diy.src), 'IMAGE');
  fs.writeFileSync(path.join(r1, '自定义/同名y.png'), 'ALT-IMAGE');
  const original = fs.readFileSync(path.join(r1, 'game/data/nations/UN.json'), 'utf8');
  const player = path.join(temp, 'player'), root = prepare(r1, player);
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'game/data/nations/UN.json')));
  doc.cards.builtin.cost = 8; doc.cards.builtin.effects = [{ trigger: 'deploy', actions: [{ op: 'draw', count: 2 }] }];
  doc.cards.builtin.overlayFields = ['effects']; delete doc.cards.deleted;
  doc.cards['custom/added'] = card('custom/added', { adopted: true, dualAttack: true, targetsNeeded: [{ kind: 'unit' }] });
  write(path.join(root, 'game/data/nations/UN.json'), doc);
  const r2 = release('new-release', [card('builtin', { attack: 9, text: '新版修复文本' }), card('deleted'), card('new-builtin')]);
  assert.equal(prepare(r2, player), root);
  const result = catalog(root).cards;
  assert.equal(result.builtin.cost, 8); assert.equal(result.builtin.attack, 9); assert.equal(result.builtin.text, '新版修复文本');
  assert.deepEqual(result.builtin.effects, doc.cards.builtin.effects);
  assert.deepEqual(result['custom/saved'], diy); assert.ok(result['custom/added'].dualAttack);
  assert.equal(result.deleted, undefined); assert.ok(result['new-builtin']);
  assert.equal(fs.readFileSync(path.join(root, diy.src), 'utf8'), 'IMAGE');
  assert.equal(fs.readFileSync(path.join(root, '自定义/同名y.png'), 'utf8'), 'ALT-IMAGE');
  assert.equal(fs.readFileSync(path.join(r1, 'game/data/nations/UN.json'), 'utf8'), original);
  const backups = fs.readdirSync(path.join(player, 'migration-backups'));
  prepare(r2, player); assert.deepEqual(fs.readdirSync(path.join(player, 'migration-backups')), backups);
  console.log('PASS release-folder migration: saved/new DIY, full keyword/DSL fields, images, deletion marks, builtin updates, idempotence');
  const before = JSON.stringify(catalog(root));
  const broken = release('broken-release', [card('builtin')]);
  fs.writeFileSync(path.join(broken, 'game/data/nations/UN.json'), '{broken');
  assert.throws(() => prepare(broken, player)); assert.equal(JSON.stringify(catalog(root)), before);
  const failed = release('failed-release', [card('builtin', { attack: 42 })]);
  fs.writeFileSync(path.join(failed, 'game/tools/build-effects.js'), 'process.exit(9)');
  assert.throws(() => prepare(failed, player)); assert.equal(JSON.stringify(catalog(root)), before);
  prepare(r2, player); assert.equal(JSON.stringify(catalog(root)), before);
  console.log('PASS migration failure: malformed release and failed rebuild retain the entire old pool');
  const nearby = path.join(temp, 'nearby');
  const oldPortable = release('nearby/old/resources/app', [diy]);
  write(path.join(oldPortable, 'package.json'), { name: 'kards-diy' });
  fs.mkdirSync(path.join(oldPortable, '自定义'), { recursive: true }); fs.writeFileSync(path.join(oldPortable, diy.src), 'LEGACY-ART');
  const newPortable = release('nearby/new/resources/app', [card('builtin')]);
  const migrated = prepare(newPortable, path.join(nearby, 'player'));
  assert.deepEqual(catalog(migrated).cards[diy.id], diy);
  assert.equal(fs.readFileSync(path.join(migrated, diy.src), 'utf8'), 'LEGACY-ART');
  console.log('PASS first upgrade: nearby legacy portable directory is found automatically and DIY/art adopted');
}
async function server() {
  const s = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body>migration fixture</body></html>');
  }); servers.push(s);
  await new Promise(r => s.listen(0, '127.0.0.1', r)); return 'http://127.0.0.1:' + s.address().port;
}
const code = fs.readFileSync(path.join(repo, 'electron/game/js/auto-save.js'), 'utf8');
async function windowAt(url) {
  const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, preload: path.join(repo, 'preload.js') } });
  wins.push(w); await w.loadURL(url); return w;
}
const js = (w, s) => w.webContents.executeJavaScript(s);
async function webChecks() {
  const save = path.join(temp, 'web-save.json');
  ipcMain.handle('kg-player-read', () => store.read(save));
  ipcMain.handle('kg-player-write', (_e, s) => { store.write(save, s); return { ok: true }; });
  const url1 = await server(), first = await windowAt(url1);
  // This is an old version: only web storage, no native backup yet.
  await js(first, `(async()=>{
    localStorage.setItem('kg.custom',JSON.stringify([{id:'custom/local',name:'同名',kwValues:{charge:7},dualAttack:true}]));
    localStorage.setItem('kg.edits',JSON.stringify({'custom/local':{effects:[{trigger:'order',actions:[]} ]}}));
    localStorage.setItem('kg.deckLib',JSON.stringify({cur:'d',decks:[{id:'d',cards:['custom/local']}]}));
    localStorage.setItem('kg.removed',JSON.stringify({'builtin/gone':1}));localStorage.setItem('kg_ui_zoom','85');
    const db=await new Promise((res,rej)=>{const r=indexedDB.open('kg-cards',1);r.onupgradeneeded=()=>r.result.createObjectStore('images');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
    await new Promise((res,rej)=>{const tx=db.transaction('images','readwrite');tx.objectStore('images').put(new Blob(['IMAGE-BYTES'],{type:'image/png'}),'custom/local');tx.oncomplete=res;tx.onerror=rej});db.close();
  })()`);
  await js(first, code); await js(first, 'KG_AUTO_SAVE.init()');
  assert.equal(store.read(save).storage.kg_ui_zoom, '85');
  await js(first, "localStorage.setItem('kg.custom', JSON.stringify([{id:'custom/local',name:'更新后',kwValues:{charge:8},dualAttack:true}]));KG_AUTO_SAVE.flush()");
  first.destroy();
  const second = await windowAt(await server());
  await js(second, code); await js(second, 'KG_AUTO_SAVE.init()');
  const result = await js(second, `(async()=>{
    const db=await new Promise(res=>{const r=indexedDB.open('kg-cards',1);r.onsuccess=()=>res(r.result)});
    const blob=await new Promise(res=>{const r=db.transaction('images').objectStore('images').get('custom/local');r.onsuccess=()=>res(r.result)});db.close();
    return {card:JSON.parse(localStorage.getItem('kg.custom'))[0],deck:JSON.parse(localStorage.getItem('kg.deckLib')),removed:JSON.parse(localStorage.getItem('kg.removed')),image:await blob.text(),zoom:localStorage.getItem('kg_ui_zoom')};
  })()`);
  assert.equal(result.card.name, '更新后'); assert.equal(result.card.kwValues.charge, 8); assert.ok(result.card.dualAttack);
  assert.deepEqual(result.deck.decks[0].cards, ['custom/local']); assert.equal(result.image, 'IMAGE-BYTES');
  assert.equal(result.removed['builtin/gone'], 1); assert.equal(result.zoom, '85');
  await js(second, "localStorage.setItem('kg.custom','[]');localStorage.setItem('kg.deckLib',JSON.stringify({decks:[]}));KG_AUTO_SAVE.flush()");
  second.destroy(); const third = await windowAt(await server()); await js(third, code); await js(third, 'KG_AUTO_SAVE.init()');
  assert.equal(await js(third, "localStorage.getItem('kg.custom')"), '[]');
  assert.equal(await js(third, "JSON.parse(localStorage.getItem('kg.deckLib')).decks.length"), 0);
  console.log('PASS native snapshot: adopt legacy save, new origin/port, byte-exact card art, all fields, decks/settings/deletions, intentional empty data');
  await js(third, "localStorage.setItem('kg_ui_zoom','90');KG_AUTO_SAVE.flush()"); third.destroy();
  fs.writeFileSync(save, '{corrupt'); assert.ok(store.read(save));
  fs.writeFileSync(save + '.previous', '{also-corrupt');
  const last = await windowAt(await server()); await js(last, code);
  assert.equal(await js(last, "KG_AUTO_SAVE.init().then(()=>false,()=>true)"), true);
  assert.equal(fs.readFileSync(save, 'utf8'), '{corrupt');
  console.log('PASS snapshot safety: valid prior generation recovered, irrecoverable saves block boot without overwriting files');
}
app.whenReady().then(async () => {
  try { diskChecks(); await webChecks(); console.log('All automatic migration checks passed.'); }
  catch (e) { console.error(e); process.exitCode = 1; }
  finally { wins.forEach(w => { if (!w.isDestroyed()) w.destroy(); }); servers.forEach(s => s.close()); app.exit(process.exitCode || 0); }
});
