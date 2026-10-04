'use strict';
const fs = require('fs'), path = require('path');
function validate(snapshot) {
  if (!snapshot || snapshot.format !== 'kards-player-data' || snapshot.version !== 1 ||
      !snapshot.storage || typeof snapshot.storage !== 'object' || Array.isArray(snapshot.storage) ||
      !snapshot.images || typeof snapshot.images !== 'object' || Array.isArray(snapshot.images)) throw new Error('无效的玩家存档');
  for (const [key, value] of Object.entries(snapshot.storage)) {
    if (!/^kg[._]/.test(key) || typeof value !== 'string') throw new Error('无效的存档字段');
  }
  for (const [key, value] of Object.entries(snapshot.images)) {
    if (!key || typeof value !== 'string' || !/^data:[^,]*;base64,[A-Za-z0-9+/=]*$/.test(value)) throw new Error('无效的卡图');
  }
  return snapshot;
}
function read(file, check = validate) {
  let error;
  for (const candidate of [file, file + '.previous']) {
    if (!fs.existsSync(candidate)) continue;
    try { return check(JSON.parse(fs.readFileSync(candidate, 'utf8'))); } catch (e) { error = e; }
  }
  if (error) throw error; // Corrupt saves must never be replaced by an empty game.
  return null;
}
function write(file, value, check = validate) {
  check(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  const fd = fs.openSync(temp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) {
    // Keep the last valid generation, even if the primary file was corrupted.
    try { check(JSON.parse(fs.readFileSync(file, 'utf8'))); fs.copyFileSync(file, file + '.previous'); } catch (e) {}
  }
  fs.renameSync(temp, file);
}
module.exports = { read, write, validate };
