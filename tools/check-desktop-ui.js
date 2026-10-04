/* Run with node_modules/electron/dist/electron.exe tools/check-desktop-ui.js.
 * Hidden window, temporary profile, synthetic game. Does not touch player saves.
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), http = require('http');
const { fork } = require('child_process');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..'), runtime = path.join(repo, 'resources/app');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'kards-ui-check-')));
let server, win;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function ready(port) {
  for (let i = 0; i < 70; i++) {
    const ok = await new Promise(resolve => { const req = http.get(`http://127.0.0.1:${port}/game/index.html`, r => { r.resume(); resolve(r.statusCode === 200); }); req.on('error', () => resolve(false)); });
    if (ok) return; await pause(100);
  }
  throw new Error('Test server did not start');
}
app.whenReady().then(async () => {
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  server = fork(path.join(runtime, 'game/tools/serve.js'), [String(port), '--local'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
  try {
    await ready(port);
    win = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { backgroundThrottling: false, partition: 'kards-check-' + Date.now() } });
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    await win.loadURL(`http://127.0.0.1:${port}/game/index.html`);
    await pause(500);
    await win.webContents.executeJavaScript(`(() => {
      const K = window.KG, ui = K.ui;
      const unit = (id, extra = {}) => ({ id, name: id, set: 'UN', cardType: 'unit', unitType: 'fighter', cost: 1, opCost: 1, attack: 2, defense: 6, rarity: 'iron', kwMap: {}, effects: [], ...extra });
      const additions = [unit('__ui_a'), unit('__ui_b'), unit('__ui_smoke', {kwMap:{smokescreen:true}}),
        { id: '__ui_order', name: '目标指令', set: 'UN', cardType: 'order', cost: 1, rarity: 'iron', kwMap:{},
          targetsNeeded: [{id:'t',kind:'unit',side:'enemy'}], effects:[{trigger:'order', targets:[{id:'t',kind:'unit',side:'enemy'}], actions:[{op:'damage',target:'t',amount:1}]}] }];
      ui.pool.push(...additions); K.setPool(ui.pool);
      const deck = Array(40).fill('__ui_a'), st = K.createGame({decks:[deck,deck],pool:K.pool,seed:71});
      st.phase='play'; st.mulligan.done=[true,true]; st.active=0; st.turn=5;
      st.players[0].hand=['__ui_a','__ui_order','__ui_b'].map(id=>K.makeHandInst(id)); st.players[0].kredits=6; st.players[0].maxKredits=6;
      st.players[1].hand=[]; ui.state=st; ui.humanSide=0; ui.pending=null; ui.selection=null; ui.handPick=null;
      for (const [id,owner] of [['__ui_a',0],['__ui_b',1],['__ui_smoke',1]]) {
        const u=K.makeUnit(st,id,owner); u.canAct=true; u.summonedTurn=0; st.players[owner].support.push(u);
      }
      document.body.classList.remove('mulligan-phase');
      document.querySelector('#myHand').removeAttribute('style');
      document.querySelector('#mulliganBar').classList.add('hidden');
      document.querySelector('[data-screen="battle"]').click();
      ui.renderBattle({animate:false});
    })()`);
    await pause(600);
    for (const [width, height] of [[1440,1000],[1280,800]]) {
      win.setSize(width, height); await pause(400);
      const layout = await win.webContents.executeJavaScript(`(() => {
        const rect = s => { const r=document.querySelector(s).getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; };
        return {width:innerWidth,height:innerHeight,button:rect('#endTurnBtn'),board:rect('#boardScroll'),
          sidebar:getComputedStyle(document.querySelector('#sidePanel')).visibility,
          duplicate:getComputedStyle(document.querySelector('#myKredits').closest('.pile')).display,
          body:document.body.className,phase:KG.ui.state.phase,mobile:document.documentElement.className};
      })()`);
      assert.ok(layout.button.left > layout.width / 2, JSON.stringify(layout));
      assert.ok(layout.button.right <= layout.width, JSON.stringify(layout));
      assert.equal(layout.sidebar, 'hidden'); assert.equal(layout.duplicate, 'none');
      assert.ok(layout.board.top < 5, JSON.stringify(layout));
      console.log('PASS battle layout ' + width + 'x' + height);
    }

    const read=code=>win.webContents.executeJavaScript(code);
    const wait=async code=>{for(let i=0;i<100;i++){if(await read(code))return;await pause(50);}throw Error('Timeout '+code);};
    const snapshot=()=>read(`KGNetSync.stateDigest(KG.ui.state,KG)`);
    const beforeClicks=await snapshot();
    for(const selector of ['#myHand .card[data-inst="0"]','#myHand .card[data-inst="1"]','#mySupport .card[data-uid]','#foeSupport .card[data-uid]']){
      const result=await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.click();const r={details:!document.querySelector('#tooltip').classList.contains('hidden'),prompt:document.querySelector('#prompt').classList.contains('hidden'),slots:document.querySelectorAll('.insert-slot').length};e.dispatchEvent(new MouseEvent('mouseleave'));return r;})()`);
      assert.ok(result.details&&result.prompt&&result.slots===0,JSON.stringify(result));assert.equal(await snapshot(),beforeClicks);
    }
    await read(`KG.ui.handPick=0;KG.ui.selection={uid:KG.ui.state.players[0].support[0].uid,action:'attack'};document.body.classList.add('place-mode');KG.ui.renderBattle({animate:false})`);
    assert.equal(await read(`!document.querySelector('.insert-slot')&&!document.body.classList.contains('place-mode')&&document.querySelector('#prompt').classList.contains('hidden')`),true);assert.equal(await snapshot(),beforeClicks);
    console.log('PASS normal clicks only inspect; legacy placement/action state cannot render or change the game');
    const picked=await read(`(()=>{let picked=null;const uid=KG.ui.state.players[1].support[0].uid;KG.ui.pending={req:{kind:'target',options:[{kind:'unit',value:uid,label:'目标'}]},resolve:v=>picked=v};KG.ui.renderBattle({animate:false});document.querySelector('#foeSupport .card[data-uid]').click();return {picked,uid};})()`);assert.equal(picked.picked,picked.uid);await pause(100);
    assert.equal(await read(`(()=>{const e=document.querySelector('#foeSupport .card[data-uid]');e.click();const shown=!document.querySelector('#tooltip').classList.contains('hidden');e.dispatchEvent(new MouseEvent('mouseleave'));return shown;})()`),true);
    console.log('PASS effect target clicks remain valid and normal inspection resumes afterwards');
    await read(`KG.ui.state.phase='mulligan';KG.ui.state.mulligan.done=[false,false];KG.ui.mulliganPicks=new Set();KG.ui.renderBattle({animate:false});document.querySelector('#myHand .card[data-inst="0"]').click()`);assert.equal(await read(`KG.ui.mulliganPicks.has(0)`),true);
    await read(`document.querySelector('#myHand .card[data-inst="0"]').click()`);assert.equal(await read(`KG.ui.mulliganPicks.has(0)`),false);await read(`KG.ui.state.phase='play';KG.ui.state.mulligan.done=[true,true];document.body.classList.remove('mulligan-phase');KG.ui.renderBattle({animate:false});document.querySelector('#myHand').removeAttribute('style');document.querySelector('#mulliganBar').classList.add('hidden')`);await pause(200);
    console.log('PASS opening mulligan still uses click selection');
    const highlights = await win.webContents.executeJavaScript(`(() => {
      const ui=KG.ui, el=document.querySelector('#myHand .card[data-inst="1"]'), r=el.getBoundingClientRect();
      const event=(x,y)=>({button:0,pointerId:77,clientX:x,clientY:y,preventDefault(){},stopPropagation(){},target:el});
      ui.beginCardDrag(event(r.left+r.width/2,r.top+r.height/2),{kind:'hand',index:1},el,KG.cardDef(ui.state,'__ui_order'));
      ui.pointerMove(event(r.left+r.width/2,r.top+r.height/2-40));
      const ids=Array.from(document.querySelectorAll('.can-hit')).map(e=>e.dataset.uid);
      const expected=ui.state.players[1].support.map(u=>u.uid);
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      return {ids,expected};
    })()`);
    assert.deepEqual(highlights.ids.sort(), highlights.expected.sort());
    console.log('PASS targeted hand drag highlights enemy units (including Smokescreen)');
    async function mouseDrag(source,destination){
      const points=await read(`(()=>{const s=document.querySelector(${JSON.stringify(source)}).getBoundingClientRect(),d=document.querySelector(${JSON.stringify(destination)}).getBoundingClientRect();return {sx:s.left+s.width*.2,sy:Math.min(s.top+20,innerHeight-10),tx:d.left+d.width*.5,ty:d.top+d.height*.5};})()`);
      const send=(type,x,y)=>win.webContents.sendInputEvent({type,x:Math.round(x),y:Math.round(y),button:'left',clickCount:1});
      send('mouseMove',points.sx,points.sy);send('mouseDown',points.sx,points.sy);
      for(let i=1;i<=8;i++){send('mouseMove',points.sx+(points.tx-points.sx)*i/8,points.sy+(points.ty-points.sy)*i/8);await pause(30);}send('mouseUp',points.tx,points.ty);
    }
    await mouseDrag('#myHand .card[data-inst="0"]','#mySupport');await wait(`KG.ui.state.players[0].hand.length===2`);await pause(800);assert.equal(await read(`KG.ui.state.players[0].support.length`),2);
    const originalUid=await read(`KG.ui.state.players[0].support.find(u=>u.summonedTurn===0).uid`);
    await mouseDrag('#mySupport .card[data-uid="'+originalUid+'"]','#frontline');await wait(`KG.ui.state.frontline.length===1`);await pause(700);
    await read(`const u=KG.ui.state.frontline[0];u.canAct=true;u.actionsLeft=1;KG.ui.renderBattle({animate:false})`);
    await mouseDrag('#frontline .card[data-uid]','#foeSupport .card[data-uid]');await wait(`KG.ui.state.players[1].support[0].defense===4`);await pause(700);
    await mouseDrag('#myHand .card[data-inst="0"]','#mySupport');await wait(`!!KG.ui.pending`);await read(`document.querySelector('#foeSupport .card[data-uid]').click()`);await wait(`KG.ui.state.players[0].hand.length===1`);assert.equal(await read(`KG.ui.state.players[1].support[0].defense`),3);
    console.log('PASS native mouse drag: deployment, movement, combat and targeted order; clicks only resolve effect choices');

    await win.webContents.executeJavaScript(`document.querySelector('#sidePinBtn').click()`); await pause(400);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#sidePanel')).visibility`), 'visible');
    await win.webContents.executeJavaScript(`document.querySelector('#sidePinBtn').click()`); await pause(400);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#sidePanel')).visibility`), 'hidden');
    console.log('PASS explicit sidebar open/close');
    const out = path.join(repo, 'dist', 'desktop-ui-check.png'); fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log('PASS no renderer errors. Screenshot: ' + out);
    server.kill(); app.exit(0);
  } catch (e) { console.error(e.stack); if (server) server.kill(); app.exit(1); }
}).finally(() => { if (server) server.kill(); });
app.on('before-quit', () => { if(server) server.kill(); });
