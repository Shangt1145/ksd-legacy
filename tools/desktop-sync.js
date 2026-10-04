/* Maintain Electron code without reading the retired Gamme project.
 * --apply: back up changed files, then update the existing portable app.
 * --stage: copy its resources (including the user's card pool/art) to a
 * separate build input, then overlay maintained code. Never regenerate data.
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const repo = path.resolve(__dirname, '..');
const runtime = process.env.KG_DESKTOP_RESOURCES || path.join(repo, 'resources/app');
const source = path.join(repo, 'electron');
const mode = process.argv[2];
if (!['--apply', '--stage', '--check'].includes(mode)) {
  console.error('Usage: node tools/desktop-sync.js --check|--apply|--stage'); process.exit(2);
}
if (!fs.existsSync(path.join(runtime, 'game/index.html'))) {
  throw new Error('Current Electron resources missing: ' + runtime + '. Set KG_DESKTOP_RESOURCES to the portable app resources/app directory.');
}
const digest = f => fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null;
function files(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const rel = path.join(prefix, e.name);
    return e.isDirectory() ? files(path.join(dir, e.name), rel) : [rel];
  });
}
const shellFiles = ['main.js', 'preload.js', 'player-storage.js'];
const staticFiles = files(source).concat(shellFiles);
const changed = staticFiles.filter(rel => digest(path.join(shellFiles.includes(rel) ? repo : source, rel)) !== digest(path.join(runtime, rel)));
if (mode === '--check') {
  console.log(changed.length ? 'Out of sync: ' + changed.join(', ') : 'Electron code is in sync.');
  process.exitCode = changed.length ? 1 : 0;
} else {
  const destination = mode === '--stage' ? path.join(repo, '.desktop-resources') : runtime;
  if (mode === '--stage') {
    // A fresh versioned directory avoids stale resources and destructive cleanup.
    const stage = path.join(destination, Date.now().toString());
    fs.mkdirSync(stage, { recursive: true });
    fs.cpSync(runtime, stage, { recursive: true, filter: p => !path.basename(p).startsWith('_backup') });
    fs.writeFileSync(path.join(destination, 'current.json'), JSON.stringify({ stage }));
    overlay(stage, staticFiles);
    console.log('Build resources staged: ' + stage);
  } else if (changed.length) {
    const backup = path.join(repo, 'dist', '_backup_desktop_' + Date.now());
    for (const rel of changed) {
      const old = path.join(runtime, rel);
      if (fs.existsSync(old)) { fs.mkdirSync(path.dirname(path.join(backup, rel)), { recursive: true }); fs.copyFileSync(old, path.join(backup, rel)); }
    }
    overlay(destination, changed);
    console.log('Updated ' + changed.length + ' code files. Backup: ' + backup);
  } else console.log('Electron code is in sync.');
}
function overlay(dest, entries) {
  for (const rel of entries) {
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(shellFiles.includes(rel) ? repo : source, rel), target);
  }
}
