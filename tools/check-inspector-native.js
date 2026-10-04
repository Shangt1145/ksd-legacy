'use strict';
// Exercise navigation, native IPC and the game consuming an inspector edit.
const electron=require('electron'),Module=require('module');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'kards-inspector-native-'));
electron.app.setPath('userData',profile);electron.app.commandLine.appendSwitch('no-proxy-server');
const pause=ms=>new Promise(r=>setTimeout(r,ms));let phase=0,done=false,id;
class HiddenWindow extends electron.BrowserWindow {
  show(){} focus(){} maximize(){}
  constructor(options){
    super({...options,show:false});
    this.webContents.on('did-finish-load',async()=>{
      if(done)return;
      try {
        const ready=phase===1?'!!window.KG_INSPECTOR':'!!(window.KG && KG.ui && KG.ui.pool && KG.ui.pool.length)';
        let ok=false;for(let n=0;n<100;n++){ok=await this.webContents.executeJavaScript(ready);if(ok)break;await pause(100);}
        assert.ok(ok,'page failed to initialize in phase '+phase);
        if(phase===0){
          await this.webContents.executeJavaScript("localStorage.setItem('kg.inspector-test','native-marker');KG_AUTO_SAVE.flush()");
          phase=1;await this.loadURL(this.webContents.getURL().replace('index.html','inspector.html'));return;
        }
        if(phase===1){
          assert.equal(await this.webContents.executeJavaScript("localStorage.getItem('kg.inspector-test')"),'native-marker');
          id=await this.webContents.executeJavaScript(`(async()=>{
            const i=KG_INSPECTOR,c=i.api.newCard({name:'native composition',effects:[{trigger:'deploy',actions:[{op:'loop',times:2,actions:[{op:'changeResource',side:'self',property:'kredits',mode:'add',value:1}]}]}]});
            await i.select(i.api.list().find(r=>r.id===c.id));
            const field=document.querySelector('[data-focus-key="card.name"]');field.closest('details').open=true;field.focus();field.value+='中文草稿';field.dispatchEvent(new InputEvent('input'));return c.id;
          })()`);
          this.close();let dialogReady=false;for(let n=0;n<100;n++){if(await this.webContents.executeJavaScript('!!document.querySelector("[role=dialog]")')){dialogReady=true;break;}await pause(20);}assert.ok(dialogReady,'close displays in-page draft guard');
          await this.webContents.executeJavaScript('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await pause(50);assert.equal(this.isDestroyed(),false);
          this.webContents.focus();await this.webContents.insertText('恢复');
          assert.ok((await this.webContents.executeJavaScript('document.activeElement.value')).includes('恢复'),'typing works after native close cancellation');
          await this.webContents.executeJavaScript('KG_INSPECTOR.save()');await this.webContents.executeJavaScript('KG_AUTO_SAVE.flush()');
          const save=require('../player-storage').read(path.join(profile,'player-data/web-save.json'));
          assert.ok(JSON.parse(save.storage['kg.custom']).some(c=>c.id===id&&c.effects[0].actions[0].op==='loop'));
          phase=2;await this.loadURL(this.webContents.getURL().replace('inspector.html','index.html'));return;
        }
        const found=await this.webContents.executeJavaScript(`KG.ui.pool.find(c=>c.id===${JSON.stringify(id)})`);
        assert.ok(found,'saved card is available in the game');assert.equal(found.effects[0].actions[0].op,'loop');
        assert.equal(found.effects[0].actions[0].times,2);
        console.log('PASS real shell: draft blocks close, cancellation restores typing, index → inspector → index, native snapshot and primitive DSL consumed by game');
        done=true;this.close();
      } catch(e){console.error(e.stack);done=true;electron.app.exit(1);}
    });
  }
}
const file=path.resolve(__dirname,'../main.js'),entry=new Module(file,module);entry.filename=file;entry.paths=module.paths;
const original=entry.require.bind(entry);entry.require=n=>n==='electron'?{...electron,BrowserWindow:HiddenWindow}:original(n);
entry._compile(fs.readFileSync(file,'utf8'),file);
setTimeout(()=>{if(!done){console.error('Native inspector navigation timed out');electron.app.exit(1);}},45000).unref();
