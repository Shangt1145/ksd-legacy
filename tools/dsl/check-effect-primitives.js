'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const game=process.env.KG_GAME_DIR||path.resolve(__dirname,'../../electron/game');
for(const file of ['engine','primitives-extra','primitives','effects','effect-primitives','effect-contract'])vm.runInThisContext(fs.readFileSync(path.join(game,'js',file+'.js'),'utf8'),{filename:file});
const K=KG,F=K.effects,P=F.composition,tests=[];
const body=(id,extras={})=>({id,name:id,cardType:'unit',unitType:'infantry',attack:2,defense:10,cost:1,opCost:2,kwMap:{},effects:[],...extras});
K.setPool([body('basic'),body('tank',{unitType:'tank',cost:6,customStats:{counter:7}}),body('aura')]);
const state=()=>{const d=Array(40).fill('basic'),s=K.createGame({decks:[d,d],pool:K.pool,seed:71});s.phase='play';s.players.forEach(p=>{p.hand=[];p.kredits=5;});return s;};
const put=(s,id='basic',owner=0)=>{const u=K.makeUnit(s,id,owner);s.players[owner].support.push(u);return u;};
const ctx=u=>({owner:u.owner,source:u,unit:u,vars:{},targets:{}});
const read=(path,of='candidate')=>({expr:'read',of,path});
const cmp=(left,op,right)=>({test:'compare',left,cmp:op,right});
const all=where=>({sel:'all',side:'both',zone:'field',where});
const run=(s,c,actions)=>F.exec(s,c,[{trigger:'order',actions}],async()=>0,'order');
const test=(name,fn)=>tests.push([name,fn]);
test('Arbitrary properties, cross-property comparison and nested logic',()=>{
 const s=state(),a=put(s),b=put(s,'tank'),c=ctx(a);a.attack=11;b.kws.guard=true;
 const where={test:'any',items:[{test:'all',items:[cmp(read('attack'),'>',read('defense')),{test:'not',item:cmp(read('keywords'),'contains','guard')}]},cmp(read('customStats.counter'),'>=',7)]};
 assert.deepEqual(P.query(all(where),s,c).map(x=>x.uid),[a.uid,b.uid]);
 assert.equal(P.test(cmp(read('printed.attack'),'==',2),s,c,a),true);
 assert.equal(P.test({test:'exists',left:read('notCreatedYet')},s,c,a),false);
 assert.equal(P.test(cmp(read('unitType'),'in',['tank','infantry']),s,c,b),true);
 assert.throws(()=>P.value(read('__proto__.x'),s,c,a));
});
test('Filter runs before random draw, including custom card fields',()=>{
 const s=state(),a=put(s);put(s);const tank=put(s,'tank');
 for(let i=0;i<30;i++)assert.equal(P.query({sel:'random',side:'friendly',where:cmp(read('cost'),'>',5),count:1},s,ctx(a))[0],tank);
});
test('Read current operation cost and pin status',async()=>{
 const s=state(),u=put(s),c=ctx(u);await run(s,c,[{op:'changeAttribute',target:{sel:'self'},property:'opCost',mode:'set',value:4},{op:'setPinned',target:{sel:'self'},enabled:true,turns:1}]);
 assert.equal(P.read(u,'opCost',s),4);assert.equal(P.read(u,'printed.opCost',s),2);assert.equal(P.read(u,'pinned',s),true);
});
test('Queries count all card zones with generic predicates',()=>{
 const s=state(),u=put(s),c=ctx(u);s.players[0].hand=[{id:'basic'},{id:'tank',revealed:true}];s.players[0].discard=['tank'];
 assert.equal(P.value({expr:'count',query:{sel:'all',side:'friendly',zone:'hand',where:cmp(read('revealed'),'==',true)}},s,c),1);
 assert.equal(P.query({sel:'all',zone:'discard',where:cmp(read('cost'),'>=',6)},s,c).length,1);
});
test('Covert and enemy ability immunity cannot be bypassed by named queries',async()=>{
 const s=state(),u=put(s),v=put(s,'tank',1),c=ctx(u);c.vars.hidden=[v];v.kws.conceal=true;
 await run(s,c,[{op:'dealDamage',target:{sel:'refAll',ref:'hidden'},amount:5}]);assert.equal(v.defense,10);
 delete v.kws.conceal;v.mods.immuneUnitEffects=true;assert.equal(P.query({sel:'refAll',ref:'hidden'},s,c).length,0);
});
test('Named HQ and side zero resolve to the correct player',async()=>{
 const s=state(),u=put(s),c=ctx(u);c.targets.h=[{kind:'hq',value:'hq0',player:0}];
 await run(s,c,[{op:'dealDamage',target:'h',amount:3},{op:'restoreHealth',target:{sel:'all',side:0,zone:'hq'},amount:1}]);
 assert.equal(s.players[0].hq,18);assert.equal(s.players[1].hq,20);
});
test('Variables, math, traversal and branches compose without exponential doubling',async()=>{
 const s=state(),u=put(s),v=put(s),c=ctx(u);c.orderDouble=true;
 await run(s,c,[{op:'let',name:'n',value:{expr:'math',operator:'add',items:[1,1]}},{op:'branch',test:cmp({expr:'variable',name:'n'},'==',2),then:[{op:'iterate',target:all(),as:'recipient',actions:[{op:'loop',times:2,actions:[{op:'changeAttribute',target:{sel:'refAll',ref:'recipient'},property:'attack',mode:'add',value:1}]}]}],else:[]}]);
 assert.deepEqual([u.attack,v.attack],[6,6]);
});
test('Scoped current reference reads the iterated object',async()=>{
 const s=state(),u=put(s),v=put(s,'tank');v.attack=5;
 await run(s,ctx(u),[{op:'iterate',target:all(),as:'current',actions:[{op:'changeAttribute',target:{sel:'refAll',ref:'current'},property:'attack',mode:'set',value:{expr:'math',operator:'add',items:[read('attack','current'),1]}}]}]);
 assert.deepEqual([u.attack,v.attack],[3,6]);
});
test('Persistent counter expresses every third event with ordinary primitives',async()=>{
 const s=state(),u=put(s),actions=[{op:'store',scope:'unit',key:'events',value:{expr:'math',operator:'add',items:[{expr:'memory',scope:'unit',key:'events'},1]}},{op:'branch',test:cmp({expr:'memory',scope:'unit',key:'events'},'==',3),then:[{op:'dealDamage',target:{sel:'all',side:'enemy',zone:'hq'},amount:2},{op:'store',scope:'unit',key:'events',value:0}],else:[]}];
 for(let i=0;i<6;i++)await run(s,ctx(u),actions);assert.equal(s.players[1].hq,16);assert.equal(u.effectMemory.events,0);
});
test('Attribute expressions read candidate per target',async()=>{
 const s=state(),a=put(s),b=put(s,'tank');b.attack=4;
 await run(s,ctx(a),[{op:'changeAttribute',target:all(),property:'attack',mode:'add',value:read('attack')}]);assert.deepEqual([a.attack,b.attack],[4,8]);
});
test('Legacy expansion captures source numerical values and random recipients once',async()=>{
 const original=[{op:'buff',target:{sel:'random',side:'friendly',count:1},attack:{stat:'attack',of:'self'},defense:{stat:'attack',of:'self'}}];
 const exec=async expanded=>{const s=state(),a=put(s);put(s);await run(s,ctx(a),expanded?P.expand(original,'test').actions:original);return s.players[0].support.map(u=>[u.attack,u.defense]);};
 assert.deepEqual(await exec(true),await exec(false));
});
test('Unproven legacy operations and fields survive explicit expansion',()=>{
 const a=[{op:'scrapAirDraw',future:'x'},{op:'buff',target:{sel:'self'},attack:2,keyword:'guard'},{op:'draw',count:2.5}];
 const r=P.expand(a,'x');assert.deepEqual(r.actions,a);assert.equal(r.unresolved.length,3);
});
test('Continuous primitive flow tracks arrivals and source removal without stacking',()=>{
 const s=state(),a=put(s,'aura'),b=put(s);a.def={...a.def,effects:[{trigger:'passive',actions:[{op:'let',name:'n',value:2},{op:'branch',test:cmp(read('hq','friendlyPlayer'),'>',10),then:[{op:'changeAttribute',target:{sel:'all',side:'friendly',excludeSelf:true},property:'attack',mode:'add',value:{expr:'variable',name:'n'}}],else:[]}]}]};
 F.recomputeAuras(s);assert.equal(b.attack,4);F.recomputeAuras(s);assert.equal(b.attack,4);const added=put(s);F.recomputeAuras(s);assert.equal(added.attack,4);a.silenced=true;F.recomputeAuras(s);assert.deepEqual([b.attack,added.attack],[2,2]);
});
test('Validator follows generic expression, filter and loop scope',()=>{
 const schema=KG_EFFECT_CONTRACT.build({},F,{}),valid=[{trigger:'deploy',actions:[{op:'let',name:'x',value:3},{op:'iterate',as:'recipient',target:all(cmp(read('custom.unknown'),'==',3)),actions:[{op:'changeAttribute',target:{sel:'ref',ref:'recipient'},property:'attack',mode:'add',value:{expr:'variable',name:'x'}}]}]}];
 assert.deepEqual(KG_EFFECT_CONTRACT.validate(valid,schema).errors,[]);assert.deepEqual(KG_EFFECT_CONTRACT.validate(valid,schema).warnings,[]);
 const bad=[{trigger:'passive',actions:[{op:'branch',test:{test:'all',items:[]},then:[{op:'drawOne',side:'self'}],else:[]}]}];assert.equal(KG_EFFECT_CONTRACT.validate(bad,schema).warnings.length,1);
});
test('Invalid arithmetic and unsafe memory names fail explicitly',async()=>{
 const s=state(),u=put(s),c=ctx(u);assert.throws(()=>P.value({expr:'math',operator:'divide',items:[4,0]},s,c));
 await assert.rejects(P.run([{op:'store',scope:'unit',key:'__proto__',value:1}],s,c));
});
test('Removal stays distinct from destruction and does not overwrite old handlers',async()=>{
 const s=state(),a=put(s),b=put(s);b.def={...b.def,effects:[{trigger:'death',actions:[{op:'damageHQ',side:'enemy',amount:3}]}]};
 await run(s,ctx(a),[{op:'leaveUnit',target:{sel:'all',where:cmp(read('uid'),'==',b.uid)}}]);
 assert.equal(s.players[1].hq,20);assert.ok(s.players[0].removed.includes('basic'));assert.equal(b.dead,true);
 const other=put(s);assert.equal(F.OPS.removeUnit.toString().includes('leaveFieldWithoutDestroy'),true);
 await run(s,ctx(a),[{op:'destroyUnit',target:{sel:'all',where:cmp(read('uid'),'==',other.uid)}}]);assert.equal(other.dead,true);
});
test('Generic modifier stores scalar and structured values and expires this turn',async()=>{
 const s=state(),a=put(s),c=ctx(a),q={sel:'self'};
 await run(s,c,[{op:'setModifier',target:q,property:'immuneOrders',value:true,duration:'turn'},{op:'setModifier',target:q,property:'vsType',value:{expr:'literal',value:{tank:{damage:3}}},duration:'permanent'}]);
 F.recomputeAuras(s);assert.equal(a.mods.immuneOrders,true);assert.equal(a.mods.vsType.tank.damage,3);
 await K.endTurn(s,0,async()=>0);assert.equal(!!a.mods.immuneOrders,false);assert.equal(a.mods.vsType.tank.damage,3);
});
test('Event binding attaches a composed ability to the recipient',async()=>{
 const s=state(),a=put(s),b=put(s,'tank');
 await run(s,ctx(a),[{op:'bindEvent',target:{sel:'all',where:cmp(read('uid'),'==',b.uid)},trigger:'death',actions:[{op:'dealDamage',target:{sel:'all',side:'enemy',zone:'hq'},amount:2}]}]);
 K.killUnit(s,b,a);for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));assert.equal(s.players[1].hq,18);
});
test('Temporary set and add operation cost, attack and keywords expire correctly',async()=>{
 const s=state(),a=put(s),c=ctx(a),target={sel:'self'};
 await run(s,c,[{op:'changeAttribute',target,property:'opCost',mode:'add',value:2,duration:'turn'},{op:'changeAttribute',target,property:'opCost',mode:'set',value:7,duration:'turn'},{op:'changeAttribute',target,property:'attack',mode:'set',value:8,duration:'turn'},{op:'setKeyword',target,keyword:'guard',enabled:true,value:1,duration:'turn'}]);
 F.recomputeAuras(s);assert.equal(K.effOpCost(s,0,a),7);assert.equal(a.attack,8);assert.equal(a.kws.guard,true);
 await K.endTurn(s,0,async()=>0);assert.equal(K.effOpCost(s,0,a),2);assert.equal(a.attack,2);assert.equal(!!a.kws.guard,false);
});
test('Quantified keyword aura does not stack between recomputations',()=>{
 const s=state(),a=put(s,'aura'),b=put(s);a.def={...a.def,effects:[{trigger:'passive',actions:[{op:'setKeyword',target:{sel:'all',side:'friendly',excludeSelf:true},keyword:'armor',value:2,enabled:true}]}]};
 for(let i=0;i<5;i++)F.recomputeAuras(s);assert.equal(b.kwValues.armor,2);a.silenced=true;F.recomputeAuras(s);assert.equal(!!b.kws.armor,false);assert.equal(b.kwValues.armor,undefined);
});
test('Declared unit and HQ targets consume the same universal predicate',async()=>{
 const s=state(),a=put(s),b=put(s,'tank',1),c=ctx(a);s.players[1].hq=9;let options;
 await F.resolveDeclaredTargets(s,c,[{targets:[{id:'chosen',kind:'any',side:'enemy',filter:{where:{test:'any',items:[cmp(read('cost'),'>=',6),cmp(read('hq'),'<',10)]}}}]}],async request=>{options=request.options;return 'hq1';});
 assert.equal(options.length,2);assert.ok(options.some(t=>t.value===b.uid));assert.equal(P.query('chosen',s,c)[0].owner,1);
});
(async()=>{let count=0;for(const [name,fn]of tests){try{await fn();count++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+e.stack);process.exitCode=1;}}console.log(count+'/'+tests.length+' passed ('+game+')');})();
