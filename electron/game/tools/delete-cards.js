'use strict';
const fs = require('fs'), path = require('path');

// All cards stored in nations are saved cards, including adopted custom cards
// and tokens. Remove every occurrence, then let the server rebuild once.
function deleteCards(root, requested) {
  const ids = [...new Set(requested.map(id => String(id).trim()).filter(Boolean))];
  if (!ids.length || ids.length > 10000) throw new Error('需要 1 至 10000 个卡牌 id');
  const wanted = new Set(ids), deleted = new Set(), names = {}, changed = [];
  const dir = path.join(root, 'game/data/nations');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_meta.json').sort()) {
    const filename = path.join(dir, file), original = fs.readFileSync(filename, 'utf8');
    const doc = JSON.parse(original), cards = doc.cards || {};
    let touched = false;
    for (const key of Object.keys(cards)) {
      const card = cards[key], id = card && card.id || key;
      if (!wanted.has(id) && !wanted.has(key)) continue;
      const requestedId = wanted.has(id) ? id : key;
      names[requestedId] = card && card.name || requestedId;
      deleted.add(requestedId); delete cards[key]; touched = true;
    }
    if (touched) changed.push({ file, filename, original, doc });
  }
  let backup = null;
  if (changed.length) {
    backup = path.join(root, 'game/data', '_backup_delete_' + Date.now() + '_' + process.pid);
    fs.mkdirSync(backup, { recursive: true });
    for (const item of changed) fs.writeFileSync(path.join(backup, item.file), item.original, 'utf8');
    try {
      for (const item of changed) fs.writeFileSync(item.filename, JSON.stringify(item.doc, null, 1), 'utf8');
    } catch (error) {
      for (const item of changed) fs.writeFileSync(item.filename, item.original, 'utf8');
      throw error;
    }
  }
  return { deletedIds: [...deleted], missingIds: ids.filter(id => !deleted.has(id)), names, backup, files: changed.map(item => item.file) };
}
module.exports = { deleteCards };
