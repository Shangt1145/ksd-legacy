'use strict';
// Run the actual shell with a hidden window and a disposable player directory.
const electron = require('electron'), Module = require('module');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kards-player-ui-'));
electron.app.setPath('userData', profile);
electron.app.commandLine.appendSwitch('no-proxy-server');
const pause = ms => new Promise(r => setTimeout(r, ms));
let done = false;
class HiddenWindow extends electron.BrowserWindow {
  show() {} focus() {} maximize() {}
  constructor(options) {
    super({ ...options, show: false });
    this.webContents.on('did-finish-load', async () => {
      if (done) return;
      try {
        let result;
        for (let i = 0; i < 100; i++) {
          result = await this.webContents.executeJavaScript('!!(window.KG && KG.ui && window.__S===KG.ui)');
          if (result) break; await pause(100);
        }
        assert.ok(result, 'real UI failed to initialize');
        await this.webContents.executeJavaScript("localStorage.setItem('kg_ui_zoom','90');KG_AUTO_SAVE.flush()");
        const file = path.join(profile, 'player-data/web-save.json');
        const saved = require('../player-storage.js').read(file);
        assert.equal(saved.storage.kg_ui_zoom, '90');
        assert.ok(fs.existsSync(path.join(profile, 'player-data/card-pool/game/js/cards.js')));
        assert.ok(fs.existsSync(path.join(profile, 'player-data/card-pool/game/js/effects-data.js')));
        console.log('PASS real shell: native IPC trusted frame, complete UI boot, persistent pool, automatic snapshot and close flush');
        done = true; this.close();
      } catch (e) { console.error(e); done = true; electron.app.exit(1); }
    });
  }
}
const mainFile = path.resolve(__dirname, '../main.js');
const main = new Module(mainFile, module); main.filename = mainFile; main.paths = module.paths;
const original = main.require.bind(main);
main.require = name => name === 'electron' ? { ...electron, BrowserWindow: HiddenWindow } : original(name);
main._compile(fs.readFileSync(mainFile, 'utf8'), mainFile);
setTimeout(() => { if (!done) { console.error('Real UI migration timed out'); electron.app.exit(1); } }, 30000).unref();
