'use strict';
// Disposable profiles and a read-only server: no player cards or saves are changed.
const {app, BrowserWindow} = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'kards-inspector-')));
app.commandLine.appendSwitch('no-proxy-server');
app.on('window-all-closed',()=>{});
let server, win;
const pause = ms => new Promise(r => setTimeout(r, ms));
const beginnerChecks = async function () {
 const assert=(v,m)=>{if(!v)throw Error(m);},I=KG_INSPECTOR;
 const card=I.api.newCard({name:'练习：补给',effects:[{trigger:'deploy',actions:[]}]});await I.select(card);
 document.querySelector('[data-example="draw"]').click();
 assert(I.getEffects().length===1&&I.getEffects()[0].actions[0].times===2,'example replaces only empty starter');
 const n=document.querySelector('[data-focus-key="fx.0.actions.0.times.literal"]');n.value='3';n.dispatchEvent(new InputEvent('input'));assert(I.getEffects()[0].actions[0].times===3,'example numbers edit directly');
 const before=JSON.stringify(I.getEffects());document.getElementById('insBtnMode').click();document.getElementById('insBtnMode').click();assert(JSON.stringify(I.getEffects())===before,'display mode never rewrites data');
 I.flushHistory();document.getElementById('insBtnUndo').click();assert(I.getEffects()[0].actions[0].times===2,'undo beginner number');document.getElementById('insBtnUndo').click();assert(!I.getEffects()[0].actions.length,'undo example');document.getElementById('insBtnRedo').click();
 document.querySelector('[data-example="damage"]').click();document.querySelector('[data-example="damage"]').click();
 const effects=I.getEffects(),ids=effects.flatMap(e=>(e.targets||[]).map(t=>t.id));assert(new Set(ids).size===2,'repeated examples do not collide');assert(effects.slice(1).every(e=>e.actions[0].target===e.targets[0].id&&e.trigger==='deploy'),'unit examples keep target references and deploy timing');assert(effects[0].actions[0].times===2,'adding examples preserves existing effects');
 document.querySelector('[data-example="buff"]').click();document.querySelector('[data-example="heal"]').click();assert(await I.save(),'all four examples validate and save');
 const order=I.api.newCard({name:'练习：支援指令',cardType:'order',effects:[]});await I.select(order);for(const b of document.querySelectorAll('[data-example]'))b.click();assert(I.getEffects().every(e=>e.trigger==='order'),'order examples use order timing');assert(await I.save(),'order examples save');
 await I.select(card);document.querySelector('.ins-more-tools').open=true;assert(getComputedStyle(document.getElementById('insBtnRaw')).display!=='none','raw tools remain available');document.querySelector('.ins-more-tools').open=false;
 const raw=document.getElementById('insRaw');raw.value=JSON.stringify([{trigger:'deploy',actions:[{op:'loop',times:2,actions:[{op:'drawOne',side:'self'}]}]}]);raw.dispatchEvent(new Event('input'));await I.save();
 return true;
};
const checks = async function () {
 const check=(x,m)=>{if(!x)throw Error(m);},same=(a,b,m)=>check(JSON.stringify(a)===JSON.stringify(b),m);
 const I=KG_INSPECTOR,C=KG_EFFECT_CONTRACT;
 for(const card of I.api.list()){const original=I.api.getFx(card.id);await I.select(card);same(I.getEffects(),original,'view mutates '+card.id);}
 check(!I.hasUnsavedChanges(),'viewing never marks dirty');
 const catalog=I.primitiveCatalog();check(catalog.branch&&catalog.changeAttribute&&!catalog.scrapAirDraw&&!catalog.fightRepeatedly,'add menu must use atoms');
 const schema=C.build({},KG.effects,{});check(schema.ops.changeAttribute.params.property.type==='attribute','explicit primitive parameter contract');
 const bad=C.validate([{trigger:'deploy',actions:[{op:'branch',test:{test:'compare',cmp:'???'},then:[],else:[]}]}],schema);check(bad.errors.length>=2,'malformed generic predicates diagnosed');
 const c=I.api.newCard({name:'组合输入测试',text:'保留文本',kwMap:{guard:true},art:'keep-art',effects:[{trigger:'deploy',actions:[]}]});await I.select(c);
 const add=(container,op)=>{const box=container.querySelector('.ins-add-action'),sel=box.querySelector('select');sel.value=op;box.querySelector('button').click();};
 add(document.querySelector('.ins-effect'),'branch');
 add(document.querySelector('.ins-action'),'loop');
 check(I.getEffects()[0].actions[0].then[0].op==='loop','nested actions attached');I.flushHistory();document.getElementById('insBtnUndo').click();check(I.getEffects()[0].actions[0].then.length===0,'undo');document.getElementById('insBtnRedo').click();check(I.getEffects()[0].actions[0].then[0].op==='loop','redo');
 const name=document.querySelector('[data-focus-key="card.name"]');name.closest('details').open=true;name.focus();
 name.dispatchEvent(new CompositionEvent('compositionstart'));name.value='中文输入连续';name.dispatchEvent(new InputEvent('input',{isComposing:true}));name.dispatchEvent(new CompositionEvent('compositionend',{data:'中文输入连续'}));
 for(let n=0;n<20;n++){name.value+='a';name.dispatchEvent(new InputEvent('input'));}
 check(name===document.activeElement&&name.isConnected,'typing preserves same focused input');

 const helpButton=document.querySelector('[data-inspector-tutorial]');helpButton.closest('details').open=true;helpButton.focus();const beforeHelp=JSON.stringify(I.getEffects());helpButton.click();const helpDialog=document.querySelector('.ins-tutorial-dialog');check(helpDialog.open,'tutorial opens in page');check(I.hasUnsavedChanges()&&JSON.stringify(I.getEffects())===beforeHelp,'tutorial preserves unsaved effects');helpDialog.querySelector('button').click();check(!helpDialog.open&&document.activeElement===helpButton,'tutorial close restores focus');
 helpButton.click();const shellClose=window.KG_BEFORE_CLOSE();check(!helpDialog.open&&!!document.querySelector('.ins-modal'),'shell close exposes unsaved dialog over tutorial');document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));check(!(await shellClose),'cancel shell close preserves editing');name.focus();
 const leaving=I.leave();check(!!document.querySelector('[role="dialog"]'),'DOM unsaved dialog');document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));check(!(await leaving),'cancel navigation');check(document.activeElement===name,'cancel restores text field focus');
 name.value+='回';name.dispatchEvent(new InputEvent('input'));await I.save();check(!I.hasUnsavedChanges(),'saved clean');
 const saved=I.api.list().find(x=>x.id===c.id);check(saved.name.endsWith('回')&&saved.kwMap.guard&&saved.art==='keep-art','save CJK and preserve unrelated metadata');
 const raw=document.getElementById('insRaw'),input=x=>{raw.value=x;raw.dispatchEvent(new Event('input'));};
 input(JSON.stringify([{trigger:'deploy',actions:[null,{op:'choice',options:7}]}]));check(!(await I.save()),'malformed actions safely render and block save');
 input(JSON.stringify([{trigger:'deploy',actions:[{op:'dealDamage',target:{sel:'self'},amount:''}]}]));check(!(await I.save()),'unfinished numerical input blocks save');
 const stored=localStorage.getItem('kg.custom');input('{');check(!(await I.save()),'invalid raw blocks save');same(localStorage.getItem('kg.custom'),stored,'invalid raw never overwrites');
 input(JSON.stringify([{trigger:'deploy',actions:[{op:'changeAttribute',target:{sel:'self'},property:'attack',mode:'add',value:2}]}]));await I.save();
 const qsel=document.querySelector('[data-focus-key="fx.0.actions.0.target.sel"]');qsel.value='all';qsel.dispatchEvent(new Event('change'));
 document.querySelector('.add-filter').click();const pred=document.querySelector('.ins-query .ins-predicate');Array.from(pred.querySelectorAll('button')).find(b=>b.textContent==='＋ 条件').click();
 const prop=document.querySelector('[data-focus-key="fx.0.actions.0.target.where.0.property"]');prop.focus();prop.value='customStats.counter';prop.dispatchEvent(new InputEvent('input'));
 check(document.activeElement===prop,'filter typing retains focus');check(I.getEffects()[0].actions[0].target.where.items[0].left.path==='customStats.counter','arbitrary paths supported');await I.save();
 const invalid=C.validate([{trigger:'deploy',actions:[{op:'changeAttribute',target:{sel:'all',where:{test:'compare',left:{expr:'read',of:'candidate',path:'customStats.counter'},cmp:'>=',right:1}},property:'attack',mode:'add',value:1}]}],schema);same(invalid.errors,[],'sample cards never restrict custom properties');

 input(JSON.stringify([{trigger:'deploy',actions:[{op:'threeChoice',mode:'fixed',pool:{source:'cards',cardIds:[]},side:'self'}]}]));
 check(!(await I.save()),'empty candidate pool blocks save');
 const poolSearch=document.querySelector('[aria-label="搜索候选卡牌"]');poolSearch.focus();poolSearch.value=c.id;poolSearch.dispatchEvent(new InputEvent('input'));check(document.activeElement===poolSearch&&poolSearch.isConnected,'candidate search retains focused input');check(!I.getEffects()[0].actions[0].pool.cardIds.length,'search does not edit pool');
 const poolPicker=document.querySelector('[aria-label="候选卡牌"]');poolPicker.value=c.id;check(poolPicker.value===c.id,'search finds custom card');Array.from(document.querySelectorAll('.ins-card-pool button')).find(b=>b.textContent==='加入候选卡池').click();same(I.getEffects()[0].actions[0].pool.cardIds,[c.id],'exact candidate saved by ID');check(await I.save(),'valid fixed pool saves');same(I.api.getFx(c.id)[0].actions[0].pool.cardIds,[c.id],'saved pool retained');
 const mode=document.querySelector('[data-focus-key="fx.0.actions.0.mode"]');mode.value='random';mode.dispatchEvent(new Event('change'));const source=document.querySelector('[data-focus-key="fx.0.actions.0.pool.source"]');source.value='deck';source.dispatchEvent(new Event('change'));check(I.getEffects()[0].actions[0].pool.source==='deck','custom deck pool edits');
 Array.from(document.querySelectorAll('.ins-action>button')).find(b=>b.textContent==='展开为基本动作').click();same(I.getEffects()[0].actions.map(a=>a.op),['selectObjects','let','createCard'],'offer expands into atoms');I.flushHistory();document.getElementById('insBtnUndo').click();check(I.getEffects()[0].actions[0].op==='threeChoice','expanded offer can be undone');document.getElementById('insBtnRedo').click();check(await I.save(),'expanded offer saves');
 input(JSON.stringify([{trigger:'deploy',actions:[{op:'developCard',pool:{source:'cards',cardIds:['missing-fixture']},side:'self'}]}]));check(!(await I.save()),'missing candidate cannot silently save');
 input(JSON.stringify([{trigger:'deploy',actions:[{op:'developCard',pool:{source:'cards',cardIds:[c.id]},side:'self'}]}]));check(await I.save(),'custom development pool saves');
 input(JSON.stringify([{trigger:'deploy',actions:[{op:'loop',times:2,actions:[{op:'drawOne',side:'self'}]}]}]));
 const original=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error('quota fixture');};check(!(await I.save()),'quota failure');Storage.prototype.setItem=original;check(I.hasUnsavedChanges(),'failed save retains draft');await I.save();
 const inline=KG_CARDS.find(c=>c.effects?.length&&!KG_EFFECT_OVERLAY[c.id]);check(inline,'inline fixture');same(I.api.getFx(inline.id),inline.effects,'inline effects preserved');
 const name2=document.querySelector('[data-focus-key="card.name"]');name2.closest('details').open=true;name2.focus();name2.value='重载草稿';name2.dispatchEvent(new InputEvent('input'));I.flushHistory();await new Promise(r=>setTimeout(r,400));check(JSON.parse(localStorage.getItem('kg.inspectorDraft')).patch.name==='重载草稿','draft backup');
 return {cards:I.api.list().length,atomicActions:Object.keys(catalog).length,focusKey:'card.name',cardId:c.id};
};
app.whenReady().then(async()=>{
  try {
    server=http.createServer((req,res)=>{
      const url=new URL(req.url,'http://localhost'), mobile=url.pathname.startsWith('/mobile/');
      const rel=decodeURIComponent(url.pathname.replace(/^\/(?:mobile|desktop)\//,''));
      const sources=[path.join(repo,mobile?'kards-mobile/www':'electron'),path.join(repo,'resources/app')];
      const file=sources.map(s=>path.resolve(s,rel)).find(f=>sources.some(s=>f.startsWith(s+path.sep))&&fs.existsSync(f)&&fs.statSync(f).isFile());
      if(!file){res.writeHead(404);res.end();return;}
      const type={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png'}[path.extname(file)]||'application/octet-stream';
      res.writeHead(200,{'Content-Type':type});fs.createReadStream(file).pipe(res);
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
    for(const surface of ['desktop','mobile']){
      win=new BrowserWindow({show:false,width:1365,height:900,webPreferences:{partition:'inspector-'+surface+'-'+Date.now(),backgroundThrottling:false}});
      const exceptions=[];win.webContents.on('console-message',(_e,l,m)=>{if(l>=3&&!/404|favicon/.test(m))exceptions.push(m);});
      await win.loadURL(`http://127.0.0.1:${port}/${surface}/game/inspector.html`);
      for(let n=0;n<100;n++){if(await win.webContents.executeJavaScript('!!window.KG_INSPECTOR'))break;await pause(50);}
      await win.webContents.executeJavaScript('('+beginnerChecks.toString()+')()');
      fs.mkdirSync(path.join(repo,'dist'),{recursive:true});
      if(surface==='mobile')win.setContentSize(390,844);
      await pause(100);fs.writeFileSync(path.join(repo,'dist','inspector-beginner-'+surface+'.png'),(await win.webContents.capturePage()).toPNG());
      win.setContentSize(1365,900);console.log('PASS '+surface+' beginner examples, editable numbers, display mode, undo, target IDs and card timing');
      const result=await win.webContents.executeJavaScript('('+checks.toString()+')()');console.log('PASS '+surface+' composition, CJK focus, filters, drafts, undo, validation, storage: '+JSON.stringify(result));
      await win.webContents.executeJavaScript('document.activeElement.setSelectionRange(document.activeElement.value.length,document.activeElement.value.length)');win.webContents.focus();win.webContents.sendInputEvent({type:'char',keyCode:'Z'});await pause(50);await win.webContents.insertText('汉字');await pause(50);
      const typed=await win.webContents.executeJavaScript('({value:document.activeElement.value,key:document.activeElement.dataset.focusKey})');assert.equal(typed.key,'card.name');assert.ok(typed.value.endsWith('Z汉字'),'native Electron typing after modal '+JSON.stringify(typed));
      await win.reload();for(let n=0;n<100;n++){if(await win.webContents.executeJavaScript('!!window.KG_INSPECTOR'))break;await pause(50);}
      assert.equal(await win.webContents.executeJavaScript('KG_INSPECTOR.current().id'),result.cardId);assert.equal(await win.webContents.executeJavaScript('KG_INSPECTOR.hasUnsavedChanges()'),true);
      console.log('PASS '+surface+' native keystrokes and reload draft recovery');
      await win.webContents.executeJavaScript(`(()=>{const raw=document.querySelector('#insRaw');raw.value=JSON.stringify([{trigger:'deploy',actions:[{op:'threeChoice',mode:'fixed',pool:{source:'cards',cardIds:KG_INSPECTOR.api.list().slice(0,3).map(c=>c.id)},side:'self'},{op:'developCard',pool:{source:'pool'},side:'self'}]}]);raw.dispatchEvent(new Event('input'));})()`);
      for(const [label,width,height] of surface==='desktop'?[['desktop',1365,900]]:[['phone-portrait',390,844],['phone-landscape',844,390]]){
        win.setContentSize(width,height);await pause(150);
        const layout=await win.webContents.executeJavaScript(`(()=>{const root=document.querySelector('.ins-root'),r=root.getBoundingClientRect(),save=document.querySelector('#insBtnSave').getBoundingClientRect(),main=document.querySelector('.ins-main').getBoundingClientRect();return {width:innerWidth,height:innerHeight,rootBottom:r.bottom,saveBottom:save.bottom,mainHeight:main.height,saveHeight:save.height,listHidden:getComputedStyle(document.querySelector('.ins-list')).display==='none',overflow:document.body.scrollWidth>innerWidth};})()`);
        assert.ok(layout.rootBottom<=height+1&&layout.saveBottom<=height+1&&!layout.overflow,JSON.stringify(layout));assert.ok(layout.mainHeight>100,JSON.stringify(layout));
        if(label==='phone-portrait'){const shot=await win.webContents.capturePage();fs.mkdirSync(path.join(repo,'dist'),{recursive:true});fs.writeFileSync(path.join(repo,'dist/inspector-card-pool-phone.png'),shot.toPNG());}
        if(width<1000)assert.ok(layout.saveHeight>=44,JSON.stringify(layout));if(width<600)assert.equal(layout.listHidden,true);
        fs.writeFileSync(path.join(repo,'dist','inspector-check-'+label+'.png'),(await win.webContents.capturePage()).toPNG());console.log('PASS layout '+label+' '+width+'x'+height);
      }


      await win.webContents.executeJavaScript(`document.querySelector('[data-inspector-tutorial]').click()`);await pause(250);
      const helpFrame=win.webContents.mainFrame.frames.find(f=>f.url.includes('/game/inspector-tutorial.html'));assert.ok(helpFrame,'offline help frame loaded');assert.equal(await helpFrame.executeJavaScript(`document.querySelectorAll('main h2[id]').length`),12);
      const popup=await win.webContents.executeJavaScript(`(()=>{const dialog=document.querySelector('.ins-tutorial-dialog').getBoundingClientRect(),close=document.querySelector('.ins-tutorial-heading button').getBoundingClientRect();return {fits:dialog.left>=0&&dialog.top>=0&&dialog.right<=innerWidth&&dialog.bottom<=innerHeight,closeHeight:close.height};})()`);assert.ok(popup.fits&&popup.closeHeight>=44,JSON.stringify(popup));fs.writeFileSync(path.join(repo,'dist','guide-popup-'+surface+'.png'),(await win.webContents.capturePage()).toPNG());
      await helpFrame.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await pause(50);assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.ins-tutorial-dialog').open`),false);console.log('PASS '+surface+' embedded offline guide, accessible close and iframe Escape');
      await win.loadURL(`http://127.0.0.1:${port}/${surface}/game/inspector-tutorial.html`);
      for(const [label,width,height] of surface==='desktop'?[['guide-desktop',1365,900]]:[['guide-phone-portrait',390,844],['guide-phone-landscape',844,390]]){
        win.setContentSize(width,height);await pause(100);
        const guide=await win.webContents.executeJavaScript(`(()=>({title:document.title,chapters:document.querySelectorAll('main h2[id]').length,brokenLinks:[...document.querySelectorAll('a[href^="#"]')].filter(a=>!document.getElementById(a.hash.slice(1))).length,overflow:document.body.scrollWidth>innerWidth,tocOpen:document.getElementById('tutorial-toc').open}))()`);
        assert.equal(guide.chapters,12);assert.equal(guide.brokenLinks,0);assert.equal(guide.overflow,false,JSON.stringify(guide));if(width<760)assert.equal(guide.tocOpen,false);fs.writeFileSync(path.join(repo,'dist',label+'.png'),(await win.webContents.capturePage()).toPNG());console.log('PASS '+label+' offline chapters, anchors and responsive layout');
      }
      assert.deepEqual(exceptions,[]);win.destroy();win=null;
    }
    server.close();app.exit(0);
  } catch(e) {console.error(e.stack);if(win)win.destroy();if(server)server.close();app.exit(1);}
});
setTimeout(()=>{console.error('Inspector check timed out');app.exit(1);},90000).unref();
