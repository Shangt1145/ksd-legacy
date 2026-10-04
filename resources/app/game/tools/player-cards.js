'use strict';
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const storagePath = path.resolve(__dirname, '../../player-storage.js');
const { read, write } = require(fs.existsSync(storagePath) ? storagePath : path.resolve(__dirname, '../../../player-storage.js'));
const clone = v => JSON.parse(JSON.stringify(v));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function catalog(root) {
  const dir = path.join(root, 'game/data/nations'), docs = {}, cards = {};
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); docs[f] = doc;
    if (f === '_meta.json') continue;
    if (!doc.cards || typeof doc.cards !== 'object' || Array.isArray(doc.cards)) throw new Error('无效的国家卡池：' + f);
    for (const [id, card] of Object.entries(doc.cards)) {
      if (!card || typeof card.id !== 'string' || cards[card.id]) throw new Error('卡池 ID 无效或重复：' + id);
      cards[card.id] = card;
    }
  }
  return { docs, cards };
}
function delta(base, card) {
  const patch = {}, unset = [];
  for (const k of Object.keys(base)) if (!(k in card)) unset.push(k);
  for (const [k, v] of Object.entries(card)) if (!equal(v, base[k])) patch[k] = v;
  return { card, patch, unset, created: !Object.keys(base).length };
}
function differences(base, current, previous) {
  const out = { ...previous };
  for (const id of Object.keys(base)) {
    if (!current[id]) out[id] = { deleted: true };
    else if (previous[id] && previous[id].created) out[id] = delta({}, current[id]);
    else if (!equal(base[id], current[id])) out[id] = delta(base[id], current[id]);
    else delete out[id];
  }
  for (const id of Object.keys(current)) if (!base[id]) out[id] = delta({}, current[id]);
  return out;
}
function inside(root, rel) {
  if (!rel || path.isAbsolute(rel) || /^[A-Za-z]+:/.test(rel)) return null;
  const file = path.resolve(root, rel.replace(/\\/g, '/'));
  return file.startsWith(path.resolve(root) + path.sep) ? file : null;
}
function copyArt(source, dest, card) {
  const rel = card.src || String(card.art || '').replace(/^\.\.\//, '');
  const from = inside(source, rel), to = inside(dest, rel);
  if (!from || !to || !fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
  const ext = path.extname(from), alt = from.slice(0, -ext.length) + 'y' + ext;
  if (fs.existsSync(alt)) fs.copyFileSync(alt, to.slice(0, -ext.length) + 'y' + ext);
}
function checkState(s) {
  if (!s || s.version !== 1 || !s.base || !s.overrides || !s.installRoot || !s.installBase) throw new Error('卡池迁移记录损坏');
  for (const [id, v] of Object.entries(s.overrides)) {
    if (!v || (!v.deleted && (!v.card || v.card.id !== id || !v.patch || !Array.isArray(v.unset)))) throw new Error('卡池迁移记录损坏：' + id);
  }
  return s;
}
function legacyRoots(installRoot) {
  // Portable upgrades usually sit beside the old folder, sometimes one level
  // below it. Inspect only nearby application folders, never a whole drive.
  const exeDir = path.resolve(installRoot, '../..'), found = new Set();
  for (const parent of [path.dirname(exeDir), path.dirname(path.dirname(exeDir))]) {
    let entries; try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch (e) { continue; }
    for (const entry of entries.filter(e => e.isDirectory()).slice(0, 100)) {
      const root = path.join(parent, entry.name, 'resources/app');
      if (root === installRoot || found.has(root)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        if (pkg.name === 'kards-diy' && fs.existsSync(path.join(root, 'game/data/nations'))) found.add(root);
      } catch (e) {}
    }
  }
  return [...found].sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}
function prepare(installRoot, playerDir) {
  const root = path.join(playerDir, 'card-pool'), staging = root + '.next';
  const stateFile = path.join(root, '_migration-state.json');
  // A power loss between the two directory renames resumes the completed stage.
  if (!fs.existsSync(root) && fs.existsSync(path.join(staging, '_migration-state.json'))) fs.renameSync(staging, root);
  const incoming = catalog(installRoot), old = read(stateFile, checkState);
  let overrides = {}, working;
  const artwork = [];
  if (old) {
    working = catalog(root); // Fail closed if the player's data is corrupt.
    overrides = differences(old.base, working.cards, old.overrides);
    // Pick up manual changes made in a previously registered portable folder.
    if (fs.existsSync(path.join(old.installRoot, 'game/data/nations'))) {
      const previousInstall = catalog(old.installRoot);
      const external = differences(old.installBase, previousInstall.cards, {});
      // A replacement in the same folder is a release update, not a manual edit.
      if (old.installRoot !== installRoot) {
        for (const [id, change] of Object.entries(external)) overrides[id] = change;
        for (const change of Object.values(external)) if (change.card) artwork.push({ source: old.installRoot, card: change.card });
      }
    }
  } else {
    // Legacy saved DIY cards carry adopted metadata even after becoming builtin.
    for (const [id, card] of Object.entries(incoming.cards)) {
      if (card.adopted || id.startsWith('custom/') || card.set === '自定义') overrides[id] = delta({}, card);
    }
    for (const legacy of legacyRoots(installRoot)) {
      // Corrupt legacy data is reported rather than silently dropped.
      const previous = catalog(legacy);
      for (const [id, card] of Object.entries(previous.cards)) {
        if (!card.adopted && !id.startsWith('custom/') && card.set !== '自定义') continue;
        overrides[id] = delta({}, card);
        artwork.push({ source: legacy, card });
      }
      console.log('[自动迁移] 已收录旧版 DIY 卡：' + legacy);
    }
  }
  const cards = clone(incoming.cards), docs = clone(incoming.docs);
  for (const [id, change] of Object.entries(overrides)) {
    if (change.deleted) { delete cards[id]; continue; }
    if (change.created || !cards[id]) cards[id] = clone(change.card);
    else { Object.assign(cards[id], clone(change.patch)); change.unset.forEach(k => delete cards[id][k]); }
    // Existing user image bytes have priority over release assets.
    const rel = cards[id].src;
    if ((!rel || !inside(root, rel) || !fs.existsSync(inside(root, rel))) && !artwork.some(a => a.card.id === id)) artwork.push({ source: installRoot, card: cards[id] });
  }
  for (const f of Object.keys(docs)) if (f !== '_meta.json') docs[f].cards = {};
  for (const card of Object.values(cards)) {
    const set = card.set || 'misc', file = set + '.json';
    if (!inside(root, 'game/data/nations/' + file) || /[/\\]/.test(set)) throw new Error('无效的卡牌国家：' + set);
    if (!docs[file]) docs[file] = { nation: set, cards: {} };
    docs[file].cards[card.id] = card;
  }
  if (!docs['_meta.json']) docs['_meta.json'] = { orphanAliases: {} };
  // Keep user changes to artwork positioning across releases as well.
  const changed = !old || !equal(old.base, incoming.cards) || old.installRoot !== installRoot || !equal(working.docs, docs);
  if (changed) {
    const backup = path.join(playerDir, 'migration-backups', Date.now().toString());
    if (fs.existsSync(staging)) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.renameSync(staging, backup + '-unfinished'); }
    if (fs.existsSync(root)) fs.cpSync(root, staging, { recursive: true });
    const dir = path.join(staging, 'game/data/nations'); fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(staging, 'game/js'), { recursive: true });
    const alt = path.join(staging, 'game/data/alt-art-ui.json');
    if (!fs.existsSync(alt) && fs.existsSync(path.join(installRoot, 'game/data/alt-art-ui.json'))) fs.copyFileSync(path.join(installRoot, 'game/data/alt-art-ui.json'), alt);
    artwork.forEach(item => copyArt(item.source, staging, item.card));
    // Only our validated nation JSON files are replaced; retain backups and art.
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !docs[f])) fs.unlinkSync(path.join(dir, f));
    for (const [file, doc] of Object.entries(docs)) fs.writeFileSync(path.join(dir, file), JSON.stringify(doc, null, 1));
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', KG_DATA_ROOT: staging };
    for (const script of ['merge.js', 'build-effects.js']) {
      execFileSync(process.execPath, [path.join(installRoot, 'game/tools', script)], { env, windowsHide: true, stdio: 'pipe' });
    }
    write(path.join(staging, '_migration-state.json'), { version: 1, base: incoming.cards, overrides, installRoot, installBase: incoming.cards }, checkState);
    if (fs.existsSync(root)) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.renameSync(root, backup); }
    fs.renameSync(staging, root);
  }
  return root;
}
module.exports = { prepare, catalog, differences, legacyRoots };
