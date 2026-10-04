'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const game=process.env.KG_GAME_DIR||path.resolve(__dirname,'../../electron/game');
for(const name of ['engine','primitives-extra','primitives','effects','effect-primitives','compiler','effect-contract','orc','card-import'])vm.runInThisContext(fs.readFileSync(path.join(game,'js',name+'.js'),'utf8'),{filename:name});
const K=KG,O=K.OrC,I=K.cardImport,tests=[];
const card=(name,fields={})=>({id:name,name,cardType:'unit',unitType:'infantry',cost:1,attack:2,defense:8,opCost:1,kwMap:{},effects:[],...fields});
const base=[card('source'),card('tank',{unitType:'tank'}),card('token',{name:'测试,衍生单位',token:true})];K.setPool(base);
const compile=(text,fields={},pool=base)=>O.compile(text,card('source',fields),{pool});
const check=(name,fn)=>tests.push([name,fn]);
const complete=r=>{assert.equal(r.complete,true,JSON.stringify(r.diagnostics));return r;};
const state=()=>{const d=Array(40).fill('source'),s=K.createGame({decks:[d,d],pool:K.pool,seed:55});s.phase='play';s.players.forEach(p=>{p.hand=[];p.kredits=5;p.maxKredits=5;});return s;};
const put=(s,id='source',owner=0)=>{const u=K.makeUnit(s,id,owner);s.players[owner].support.push(u);return u;};
const run=(s,u,r)=>K.effects.exec(s,{owner:u.owner,source:u,unit:u,vars:{},targets:{}},r.effects,async()=>0,r.effects[0].trigger);
check('Keywords and quantified DIY metadata',()=>{const r=complete(compile('闪击、伏击。轻甲二；磁反应装甲２；充能3'));assert.equal(r.kwMap.blitz,true);assert.equal(r.kwValues.lightArmor,2);assert.equal(r.kwValues.magnetic,2);assert.equal(r.kwValues.charge,3);assert.deepEqual(r.effects,[]);assert.equal(O.number('二十三'),23);assert.equal(O.number('一百零二'),102);});
check('Keyword separators survive typography normalization',()=>{const r=complete(compile('闪击 游击\n重甲3 守护\n部署：压制一个单位'));assert.equal(r.kwMap.blitz,true);assert.equal(r.kwMap.guerrilla,true);assert.equal(r.kwMap.guard,true);assert.equal(r.kwValues.armor,3);assert.equal(r.effects.length,1);});
check('General comparisons and filters produce only atoms',async()=>{const r=complete(compile('部署：对所有攻击力大于2且防御力不大于5的敌方坦克造成3点伤害。'));assert.deepEqual(r.legacyOps,[]);const s=state(),u=put(s),a=put(s,'tank',1),b=put(s,'tank',1),c=put(s,'source',1);a.attack=4;a.defense=5;b.attack=1;b.defense=5;c.attack=4;c.defense=5;await run(s,u,r);assert.deepEqual([a.defense,b.defense,c.defense],[2,5,5]);});
check('Dynamic counts and branch scope execute correctly',async()=>{const r=complete(compile('部署：若友方手牌数量小于2，抽取三张牌。获得2个指挥点槽。'));const s=state(),u=put(s);await run(s,u,r);assert.equal(s.players[0].hand.length,3);assert.equal(s.players[0].maxKredits,7);assert.equal(s.players[0].kredits,5);});
check('Dynamic attribute expressions',async()=>{const r=complete(compile('部署：本单位的攻击力增加本单位防御力的2倍。'));const s=state(),u=put(s);await run(s,u,r);assert.equal(u.attack,18);});
check('Counted effects compose query and loop',async()=>{const r=complete(compile('部署：每有一个其他友方步兵，抽一张牌。'));const s=state(),u=put(s);put(s);put(s);put(s,'tank');await run(s,u,r);assert.equal(s.players[0].hand.length,2);});
check('Random recipient is captured for following pronoun',async()=>{const r=complete(compile('部署：对随机一个敌方单位造成1点伤害，使其获得闪击。'));const s=state(),u=put(s),a=put(s,'tank',1),b=put(s,'source',1);await run(s,u,r);const damaged=[a,b].filter(v=>v.defense===7);assert.equal(damaged.length,1);assert.equal(damaged[0].kws.blitz,true);assert.equal([a,b].filter(v=>v.kws.blitz).length,1);});
check('Temporary buff and combined keywords',async()=>{const r=complete(compile('部署：使本单位获得+2/+3，本回合。'));const s=state(),u=put(s);await run(s,u,r);assert.equal(u.attack,4);assert.equal(u.maxDefense,11);assert.equal(u.tempBuffs[0].untilTurn,s.turn);});
check('Collective units, national and land/air predicates are composable',async()=>{
  const r=complete(compile('使友方英国空军获得+1攻击力和奋战',{cardType:'order'}));const s=state(),u=put(s),a=put(s,'tank'),b=put(s,'tank'),enemy=put(s,'tank',1);
  for(const v of [a,b,enemy]){v.unitType='fighter';v.set='英国';}b.set='德国';await run(s,u,r);
  assert.equal(a.attack,3);assert.equal(a.kws.fury,true);assert.equal(b.attack,2);assert.equal(enemy.attack,2);
});
check('Adjacent passive count updates without stacking and stops at HQ',()=>{
  const r=complete(compile('每有 1 个相邻单位，具有 +2 攻击力。'));
  const def=card('aura',{effects:r.effects});K.setPool([...base,def]);const s=state(),a=put(s),u=put(s,'aura'),b=put(s);s.players[0].hqSlot=0;
  K.recomputeAuras(s);assert.equal(u.attack,6);K.recomputeAuras(s);assert.equal(u.attack,6);
  s.players[0].hqSlot=2;K.recomputeAuras(s);assert.equal(u.attack,4);K.killUnit(s,a);assert.equal(u.attack,2);K.setPool(base);
});
check('Multiple filtered draws keep every actual instance for a following buff',async()=>{
  const r=complete(compile('部署：抽 2 个单位，使其获得 +1+1。'));const s=state(),u=put(s);s.players[0].deck=['tank','source','tank'];await run(s,u,r);
  assert.equal(s.players[0].hand.length,2);assert.ok(s.players[0].hand.every(h=>h.mods.attack===1&&h.mods.defense===1));
});
check('Each drawn unit counts its own distinct combat abilities',async()=>{
  const r=complete(compile('部署：抽2个单位，其每具有1个对战词条，使其与本单位获得+1+1。'));
  K.setPool([...base,card('one',{kwMap:{blitz:true}}),card('two',{kwMap:{blitz:true,guard:true}})]);const s=state(),u=put(s);s.players[0].deck=['one','two'];await run(s,u,r);
  assert.deepEqual(s.players[0].hand.map(h=>h.mods.attack),[1,2]);assert.equal(u.attack,5);K.setPool(base);
});
check('Friendly deployment listener counts event card keywords and never strengthens the wrong unit',async()=>{
  const r=complete(compile('友方单位部署时，其每具有 1 个对战词条，使其获得一次 +1+1。'));
  const def=card('listener',{effects:r.effects}),ally=card('ally',{kwMap:{blitz:true,guard:true}});K.setPool([...base,def,ally]);
  const s=state(),u=put(s,'listener'),a=put(s,'ally'),enemy=put(s,'ally',1);await K.runTrigger(s,{trigger:'unitDeployed',owner:0,source:a,unit:a});
  assert.equal(a.attack,4);assert.equal(u.attack,2);await K.runTrigger(s,{trigger:'unitDeployed',owner:1,source:enemy,unit:enemy});assert.equal(enemy.attack,2);K.setPool(base);
});
check('Granted abilities retain their condition and passive behavior after suppression',async()=>{
  const r=complete(compile('使 1 个友方单位获得：“友方回合结束时，若友方手牌数小于2，获得 +1+1。”',{cardType:'order'}));
  const passive=complete(compile('使 1 个友方单位获得：“相邻陆军具有 +1 攻击力和 -1 行动花费。”',{cardType:'order'}));
  const s=state(),a=put(s),u=put(s),b=put(s);s.players[0].hqSlot=0;await K.effects.OPS.silence(s,{owner:0,source:a,unit:a},{target:{sel:'ref',ref:'self'}});
  const ctx={owner:0,source:u,unit:u,vars:{},targets:{orcTarget1:[{kind:'unit',value:a.uid,unit:a}]}};
  await K.effects.exec(s,ctx,r.effects,async()=>0,'order');assert.ok(a.extraEffects[0].actions[0].test);
  s.players[0].hand=[K.makeHandInst('tank'),K.makeHandInst('tank')];await K.runTrigger(s,{trigger:'turnEnd',owner:0});assert.equal(a.attack,2);
  s.players[0].hand=[];await K.runTrigger(s,{trigger:'turnEnd',owner:0});assert.equal(a.attack,3);
  await K.effects.exec(s,ctx,passive.effects,async()=>0,'order');assert.equal(u.attack,3);K.recomputeAuras(s);assert.equal(u.attack,3);assert.equal(K.effOpCost(s,0,u),0);assert.equal(b.attack,2);
});
check('Official metadata imports faithfully and unsupported attributes become drafts',()=>{
  const node={id:1,cardId:'official-unit',importId:'x',reserved:true,json:{id:'official-unit',title:{'zh-Hans':'官方单位'},text:{},type:'tank',faction:'Soviet',set:'Homefront',rarity:'Elite',kredits:0,attack:0,defense:3,operationCost:0,attributes:['shock','heavyArmor2','intel3']}};
  const c=I.normalize(node);assert.equal(c.cost,0);assert.equal(c.attack,0);assert.equal(c.kwMap.impact,true);assert.equal(c.kwValues.armor,2);assert.equal(c.kwValues.intel,3);assert.equal(c.set,'苏联');assert.equal(c.reserved,true);
  assert.equal(I.plan([node],{pool:[]}).ready.length,1);const bad={...node,json:{...node.json,attributes:['futureKeyword']}};const r=I.plan([bad],{pool:[]});assert.equal(r.pending.length,1);assert.match(r.pending[0].messages.join(' '),/futureKeyword/);
  const baseNode={...node,json:{...node.json,attributes:['BecomesVeteran:official-vet']}};assert.equal(I.plan([baseNode],{pool:[]}).pending.length,1);
});
check('Replacement damage chooses one branch before dealing any damage',async()=>{
  const r=complete(compile('对 1 个单位造成 1 点伤害。若其没有相邻单位，改为造成 2 点伤害。',{cardType:'order'}));
  for(const isolated of [true,false]){const s=state(),source=put(s),victim=put(s,'tank',1);if(!isolated)put(s,'tank',1);s.players[1].hqSlot=0;
    await K.effects.exec(s,{owner:0,source,unit:source,vars:{},targets:{orcTarget1:[{kind:'unit',value:victim.uid,unit:victim}]}},r.effects,async()=>0,'order');
    assert.equal(victim.defense,isolated?6:7,'replacement never adds the base damage');
  }
});
check('Already pinned is checked before pinning, and destruction after damage uses the actual victim',async()=>{
  const r=complete(compile('压制 1 个敌方单位。若其已被压制，将其消灭。',{cardType:'order'}));
  for(const pinned of [false,true]){const s=state(),u=put(s),v=put(s,'tank',1);if(pinned)v.pinnedTurns=2;
    await K.effects.exec(s,{owner:0,source:u,unit:u,vars:{},targets:{orcTarget1:[{kind:'unit',value:v.uid,unit:v}]}},r.effects,async()=>0,'order');assert.equal(!!v.dead,pinned);
  }
  const death=complete(compile('对 1 个敌方单位造成 2 点伤害。若将其消灭，抽 1 张牌。',{cardType:'order'}));
  const s=state(),u=put(s),v=put(s,'tank',1);v.defense=1;await K.effects.exec(s,{owner:0,source:u,unit:u,vars:{},targets:{orcTarget1:[{kind:'unit',value:v.uid,unit:v}]}},death.effects,async()=>0,'order');assert.equal(s.players[0].hand.length,1);
});
check('Selected unit and original neighbors are destroyed without a moving chain',async()=>{
  const r=complete(compile('消灭一个单位及其相邻单位',{cardType:'order'}));assert.deepEqual(r.legacyOps,[]);
  const s=state(),source=put(s),units=Array.from({length:5},()=>put(s,'tank',1));s.players[1].hqSlot=0;
  await K.effects.exec(s,{owner:0,source,unit:source,targets:{orcTarget1:[{kind:'unit',value:units[2].uid,unit:units[2]}]},vars:{}},r.effects,async()=>0,'order');
  assert.deepEqual(units.map(u=>!!u.dead),[false,true,true,true,false]);
});
check('Adjacent selection stops at HQ and never reaches a different line',async()=>{
  const r=complete(compile('消灭一个单位及其相邻单位',{cardType:'order'})),s=state(),source=put(s),left=put(s,'tank',1),anchor=put(s,'tank',1),right=put(s,'tank',1);
  s.players[1].hqSlot=2;const other=K.makeUnit(s,'tank',1);s.frontline.push(other);
  await K.effects.exec(s,{owner:0,source,unit:source,targets:{orcTarget1:[{kind:'unit',value:anchor.uid,unit:anchor}]},vars:{}},r.effects,async()=>0,'order');
  assert.equal(left.dead,true);assert.equal(anchor.dead,true);assert.equal(right.dead,false);assert.equal(other.dead,false);assert.equal(s.players[1].hq,20);
});
check('Filtered draw counts combat abilities once and buffs the actual hand instance plus source',async()=>{
  const r=complete(compile('部署：抽1个单位，其每具有1个对\n战词条，使其与本单位获得+1+1。'));assert.deepEqual(r.legacyOps,[]);
  const token=card('combat',{kwMap:{blitz:true,guard:true,armor:true,valor:true,fury:true,alpine:true,charge:true},kwValues:{armor:3}}),order=card('order',{cardType:'order'});K.setPool([...base,token,order]);
  const s=state(),source=put(s);s.players[0].deck=['order','combat','tank'];await run(s,source,r);
  assert.deepEqual(s.players[0].deck,['order','tank']);assert.equal(s.players[0].hand[0].id,'combat');assert.equal(source.attack,6);assert.equal(source.maxDefense,12);
  assert.equal(s.players[0].hand[0].mods.attack,4);assert.equal(s.players[0].hand[0].mods.defense,4);
  assert.equal(K.cardDef(s,'combat').attack,2,'does not edit global card definition');
  assert.equal(await K.playCard(s,0,0,async()=>0),true);const deployed=s.players[0].support.find(x=>x.cardId==='combat');
  assert.equal(deployed.attack,6);assert.equal(deployed.defense,12,'hand enhancement survives deployment');K.setPool(base);
});
check('Death adjacency preserves the HQ boundary after the source leaves',async()=>{
  const s=state(),left=put(s),anchor=put(s),right=put(s);s.players[0].hqSlot=2;
  K.killUnit(s,anchor);assert.deepEqual(anchor.__adjacentUids,[left.uid]);
  const neighbors=K.effects.composition.query({sel:'adjacent',ref:'self'},s,{owner:0,source:anchor,vars:{}});
  assert.deepEqual(neighbors.map(x=>x.uid),[left.uid]);assert.equal(right.dead,false);
});
check('Failed or burned filtered draw does not buff source',async()=>{
  const r=complete(compile('部署：抽1个单位，其每具有1个对战词条，使其与本单位获得+1+1。'));const s=state(),u=put(s);s.players[0].deck=[];await run(s,u,r);assert.equal(u.attack,2);
  s.players[0].hand=Array.from({length:9},()=>K.makeHandInst('source'));s.players[0].deck=['tank'];await run(s,u,r);assert.equal(u.attack,2);assert.equal(s.players[0].discard.at(-1),'tank');
});
check('Hand selection uses real filtered indices and only modifies that instance',async()=>{
  const expensive=card('expensive',{cost:6}),cheap=card('cheap',{cost:1});K.setPool([...base,expensive,cheap]);const s=state(),u=put(s);s.players[0].hand=[K.makeHandInst('cheap'),K.makeHandInst('expensive'),K.makeHandInst('expensive')];
  const r=complete(compile('选择1张花费不小于5的手牌，使其获得-2花费。',{cardType:'order'},[...base,expensive,cheap]));
  let req;await K.effects.exec(s,{owner:0,source:u,unit:u,vars:{},targets:{}},r.effects,async x=>{req=x;return 0;},'order');
  assert.deepEqual(req.options.map(x=>x.value),[1,2]);assert.equal(s.players[0].hand[0].costMod,0);assert.equal(s.players[0].hand[1].costMod,-2);assert.equal(s.players[0].hand[2].costMod,0);assert.equal(expensive.cost,6);K.setPool(base);
});
check('Draw then discard tracks exactly the drawn card, not another copy',async()=>{
  const s=state(),u=put(s),old=K.makeHandInst('tank');s.players[0].hand=[old];s.players[0].deck=['tank'];await run(s,u,complete(compile('友方回合结束时，抽1张牌，将其弃掉。')));assert.deepEqual(s.players[0].hand,[old]);assert.deepEqual(s.players[0].discard,['tank']);
});
check('Selected hand returns to deck top with its modifiers and survives another draw',async()=>{
  const s=state(),u=put(s),inst=K.makeHandInst('tank');inst.costMod=-1;inst.mods={attack:3,defense:2,keywords:[]};s.players[0].hand=[K.makeHandInst('source'),inst];s.players[0].deck=['source','tank'];
  const r=complete(compile('部署：选择1张手牌。将其返回卡组顶。'));
  await K.effects.exec(s,{owner:0,source:u,unit:u,vars:{},targets:{}},r.effects,async()=>1,'deploy');assert.equal(s.players[0].hand.length,1);assert.equal(s.players[0].deck[0].id,'tank');assert.equal(K.cardDef(s,s.players[0].deck[0]).name,'tank');
  const drawn=K.drawCard(s,s.players[0],false);assert.equal(drawn.costMod,-1);assert.equal(drawn.mods.attack,3);assert.deepEqual(s.players[0].deck,['source','tank']);
  assert.equal(await K.playCard(s,0,1,async()=>0),true);assert.equal(s.players[0].support.at(-1).attack,5);assert.equal(s.players[0].support.at(-1).defense,10);
});
check('Moving and redrawing a globally discounted card never applies the discount twice',async()=>{
  const s=state(),u=put(s);s.players[0].cardMods={tank:{cost:-1}};s.players[0].deck=['tank'];const inst=K.drawCard(s,s.players[0],false);assert.equal(inst.costMod,-1);
  await run(s,u,complete(compile('部署：选择1张手牌。将其返回卡组顶。')));assert.equal(K.drawCard(s,s.players[0],false).costMod,-1);
});
check('Develop samples three distinct eligible cards and binds the created hand card',async()=>{
  const pool=[...base,...Array.from({length:4},(_,i)=>card('brit'+i,{set:'英国',rarity:'gold',cost:6})),card('reserved',{set:'英国',rarity:'gold',reserved:true}),card('token2',{set:'英国',rarity:'gold',token:true})];K.setPool(pool);const s=state(),u=put(s);
  const r=complete(compile('从3张随机英国精英单位中选择1张加入手牌。使其获得-1花费。',{cardType:'order'},pool));assert.deepEqual(r.legacyOps,[]);let options;
  await K.effects.exec(s,{owner:0,source:u,unit:u,vars:{},targets:{}},r.effects,async req=>{options=req.options;return req.options[1].value;},'order');assert.equal(options.length,3);assert.equal(new Set(options.map(x=>x.value)).size,3);assert.equal(s.players[0].hand[0].id,options[1].value);assert.equal(s.players[0].hand[0].costMod,-1);assert.equal(s.players[0].deck.length,36);
  const empty=complete(compile('随机将1张日本精英单位加入手牌。',{cardType:'order'},pool));await run(s,u,empty);assert.equal(s.players[0].hand.length,1);K.setPool(base);
});
check('Hidden enemy hand cannot be selected without an explicit reveal effect',async()=>{
  const s=state(),u=put(s);s.players[1].hand=[K.makeHandInst('tank')];let called=false;await assert.rejects(K.effects.composition.run([{op:'selectObjects',as:'picked',target:{sel:'all',zone:'hand',side:'enemy'}}],s,{owner:0,source:u,vars:{},chooser:async()=>{called=true;}}),/未公开/);assert.equal(called,false);
});
check('Left and right hand queries grant one play ability when only one card remains',async()=>{
  const s=state(),u=put(s),victim=put(s,'tank',1);s.players[0].hand=[K.makeHandInst('tank')];const r=complete(compile('使最左侧和最右侧手牌获得：“使用时，随机消灭1个敌方单位。”',{cardType:'order'}));await run(s,u,r);assert.equal(s.players[0].hand[0].playEffects.length,1);assert.equal(await K.playCard(s,0,0,async()=>0),true);assert.equal(victim.dead,true);
});
check('Double damage belongs to attacker, including HQ and frontline restrictions',()=>{
  const r=complete(compile('对坦克造成双倍伤害。')),hq=complete(compile('对步兵和总部造成双倍伤害。')),front=complete(compile('对前线单位造成双倍伤害。'));
  const pool=[...base,card('double',{effects:r.effects}),card('doublehq',{effects:hq.effects}),card('doublefront',{effects:front.effects})];K.setPool(pool);const s=state(),a=put(s,'double'),b=put(s,'tank',1),c=put(s,'doublehq'),d=put(s,'doublefront');K.recomputeAuras(s);
  assert.equal(K.attackPowerAgainst(s,a,b),4);assert.equal(K.attackPowerAgainst(s,a,'hq'),2);K.damageUnit(s,a,2,b,{attacker:b});assert.equal(a.defense,6,'incoming tank attack is not doubled');assert.equal(K.attackPowerAgainst(s,c,'hq'),4);assert.equal(K.attackPowerAgainst(s,d,b),2);s.players[1].support=[];s.frontline.push(b);assert.equal(K.attackPowerAgainst(s,d,b),4);K.setPool(base);
});
check('Choice resolves only the chosen branch target and never affects the other branch',async()=>{
  const r=complete(compile('抉择：对1个单位造成3点伤害 或 使1个单位获得+2+3。',{cardType:'order'}));assert.deepEqual(r.legacyOps,[]);assert.equal(r.effects[0].targets.length,0);
  for(const option of [0,1]){const s=state(),u=put(s),v=put(s,'tank',1),requests=[];await K.effects.exec(s,{owner:0,source:u,unit:u,vars:{},targets:{}},r.effects,async req=>{requests.push(req);return req.kind==='chooseOne'?option:v.uid;},'order');assert.equal(requests.length,2);assert.equal(requests[0].kind,'chooseOne');assert.equal(requests[1].kind,'target');assert.equal(v.defense,option?11:5);assert.equal(v.attack,option?4:2);}
});
check('Choice expands shared card destinations while keeping quoted names exact',async()=>{
  const pool=[...base,card('a',{name:'候选甲'}),card('b',{name:'候选乙'})];const r=complete(compile('抉择：将1张“候选甲” 或 2张“候选乙”加入手牌。',{cardType:'order'},pool));K.setPool(pool);const s=state(),u=put(s);await K.effects.exec(s,{owner:0,source:u,unit:u,vars:{},targets:{}},r.effects,async()=>1,'order');assert.deepEqual(s.players[0].hand.map(x=>x.id),['b','b']);K.setPool(base);
});
check('Attribute equality remains after aura recomputation and reads updated recipient defense',async()=>{
  const s=state(),u=put(s),v=put(s);const r=complete(compile('使1个单位获得+4防御力，使其攻击力等同于其防御力。',{cardType:'order'}));await K.effects.exec(s,{owner:0,source:u,unit:u,vars:{},targets:{orcTarget1:[{kind:'unit',value:v.uid,unit:v}]}},r.effects,async()=>0,'order');assert.equal(v.attack,12);assert.equal(v.defense,12);K.recomputeAuras(s);assert.equal(v.attack,12);assert.equal(v.defense,12);
});
check('Card effect battle uses simultaneous combat without spending normal actions',async()=>{
  const s=state(),u=put(s),v=put(s,'tank',1);u.attack=20;v.attack=20;const before=u.actionsLeft,r=complete(compile('部署：与1个敌方单位战斗。'));await K.effects.exec(s,{owner:0,source:u,unit:u,vars:{},targets:{orcTarget1:[{kind:'unit',value:v.uid,unit:v}]}},r.effects,async()=>0,'deploy');assert.equal(u.dead,true);assert.equal(v.dead,true);assert.equal(u.actionsLeft,before);
});
check('Legacy deck buffs now affect each selected instance exactly once',async()=>{
  const s=state(),u=put(s);s.players[0].deck=['tank','tank'];await K.effects.OPS.buffCardsInPiles(s,{owner:0,unit:u,source:u,vars:{}},{piles:'deck',attack:1,cost:-1});assert.equal(s.players[0].deck[0].mods.attack,1);assert.equal(s.players[0].deck[1].mods.attack,1);
  const one=K.drawCard(s,s.players[0],false),two=K.drawCard(s,s.players[0],false);assert.equal(one.costMod,-1);assert.equal(two.costMod,-1);assert.equal(await K.playCard(s,0,0,async()=>0),true);assert.equal(s.players[0].support.at(-1).attack,3);K.recomputeAuras(s);assert.equal(s.players[0].support.at(-1).attack,3);
});
check('Legacy deck-to-field preserves stored instance buffs and the full ability condition',async()=>{
  const s=state(),u=put(s),inst=K.makeHandInst('tank');inst.mods={attack:2,defense:1,keywords:['ambush'],effects:[{trigger:'turnEnd',condition:{op:'predicate',test:{test:'compare',left:{expr:'count',query:{sel:'all',zone:'hand',side:'friendly'}},cmp:'==',right:0}},actions:[{op:'changeAttribute',target:{sel:'self'},property:'attack',mode:'add',value:1}]}]};s.players[0].deck=[inst];
  await K.effects.OPS.deckToField(s,{owner:0,unit:u,source:u,vars:{}},{count:1});const pulled=s.players[0].support.at(-1);assert.equal(pulled.cardId,'tank');assert.equal(pulled.attack,4);assert.equal(pulled.defense,9);assert.equal(pulled.ambushReady,true);assert.ok(pulled.extraEffects[0].condition);await K.runTrigger(s,{owner:0,trigger:'turnEnd'});assert.equal(pulled.attack,5);
});
check('Network digest sees instance buff and deck identity differences',()=>{
  vm.runInThisContext(fs.readFileSync(path.join(game,'js/netsync.js'),'utf8'),{filename:'netsync'});const s=state();s.players[0].hand=[K.makeHandInst('tank')];s.players[0].deck=[K.makeHandInst('tank')];const initial=KGNetSync.stateDigest(s,K);s.players[0].hand[0].mods={attack:1};const modified=KGNetSync.stateDigest(s,K);assert.notEqual(initial,modified);s.players[0].deck[0].id='source';assert.notEqual(modified,KGNetSync.stateDigest(s,K));
});
check('Unparsed tail never becomes a successful import',()=>{assert.equal(compile('部署：抽一张牌，立即赢得游戏').complete,false);assert.equal(compile('闪击。量子纠缠所有敌军').complete,false);});
check('Metadata-only effect remains available',()=>{const r=complete(compile('在第三回合抽取'));assert.equal(r.cardFields.drawOnTurn,3);assert.equal(complete(compile('在第二十三回合抽取')).cardFields.drawOnTurn,23);});
check('Targets before a condition are not lost',()=>{for(const text of ['压制一个敌方单位，如果其已被压制\n随机消灭一个敌方单位。抽一张牌','造成3点伤害，如果是单位，\n获得两个指挥点']){const r=complete(compile(text,{cardType:'order'}));assert.equal(r.effects[0].targets[0].id,'t1');}});
check('Unresolved or ambiguous names block automatic acceptance',()=>{assert.equal(compile('部署：将一张“未提供的衍生单位”加入手牌。').complete,false);assert.equal(compile('部署：将一张“重复”加入手牌。',{},[...base,card('a',{name:'重复'}),card('b',{name:'重复'})]).complete,false);});
check('Atomic lowering is deterministic across compilations',()=>{const a=compile('部署：友方步兵获得+2+2。');const b=compile('部署：友方步兵获得+2+2。');assert.deepEqual(a,b);});
check('Quoted CSV commas, newlines and escaped quotes',()=>{const r=I.parse('\uFEFFname,cost,text,keywords\r\n"逗号,卡",2,"部署：抽一张牌。\n获得2个指挥点。",闪击\r\n"引号""卡",1,,轻甲2','cards.csv');assert.equal(r.cards[0].name,'逗号,卡');assert.ok(r.cards[0].text.includes('\n'));assert.equal(r.cards[1].name,'引号"卡');assert.throws(()=>I.parse('name,text\n坏卡,"未闭合','cards.csv'));assert.throws(()=>I.parse('{bad','cards.json'));});
check('Data-only batch links references before compiling',()=>{const records=[card('creator',{text:'部署：将一张“批次衍生”加入手牌。',effects:[]}),card('batch-token',{name:'批次衍生',rarity:'token',token:true,text:'闪击、轻甲2',system:'保留体系'})];const r=I.plan(records,{pool:base});assert.deepEqual(r.summary,{ready:2,pending:0,rejected:0,skipped:0});assert.equal(r.ready[0].effects[0].actions[0].cardId,'batch-token');assert.equal(r.ready[1].token,true);assert.equal(r.ready[1].system,'保留体系');assert.equal(r.ready[1].kwValues.lightArmor,2);});
check('Existing cards and manual effects are never overwritten',()=>{const existing=card('mine',{effects:[{trigger:'deploy',actions:[{op:'drawOne'}]}],effectStatus:'manual-confirmed'});const r=I.plan([card('mine',{text:'部署：抽三张牌'})],{pool:base,existing:[existing]});assert.equal(r.skipped.length,1);assert.equal(existing.effects[0].actions[0].op,'drawOne');});
check('Stable IDs and strict data errors',()=>{const r=I.plan([{name:'稳定卡',text:'闪击'}, {name:'坏卡',cost:'NaN'}],{pool:base});assert.equal(r.ready.length,1);assert.equal(r.rejected.length,1);assert.equal(I.normalize({name:'稳定卡'}).id,r.ready[0].id);const dup=I.plan([{id:'d',name:'甲'},{id:'d',name:'乙'}],{pool:base});assert.equal(dup.rejected.length,2);});
check('Incomplete dependencies move the whole chain to drafts',()=>{const r=I.plan([card('chain',{text:'部署：将一张“未完成”加入手牌。'}),card('missing',{name:'未完成',text:'部署：立即赢得游戏'})],{pool:base});assert.equal(r.ready.length,0);assert.equal(r.pending.length,2);assert.ok(r.pending.every(x=>x.card.effects.length===0));assert.ok(r.pending.some(x=>x.draftEffects.length));});
check('Provided invalid DSL cannot bypass validation',()=>{const r=I.plan([card('invalid',{effects:[{trigger:'deploy',actions:[{op:'dealDamage',amount:'',target:{sel:'all'}}]}]})],{pool:base});assert.equal(r.pending.length,1);});
check('Malformed supplied DSL is retained as a diagnostic draft',()=>{const r=I.plan([card('malformed',{effects:[null,{trigger:'deploy',actions:[{op:'choice',options:7}]}]})],{pool:base});assert.equal(r.pending.length,1);});
check('Non-unit card cannot be summoned as a unit',()=>{assert.equal(compile('部署：将一张“指令衍生”加入支援阵线。',{},[...base,card('order-token',{name:'指令衍生',cardType:'order'})]).complete,false);});
check('Unimplemented markers cannot count as valid supplied effects',()=>{const r=I.plan([card('legacy-placeholder',{effects:[{trigger:'deploy',unimplemented:true,actions:[{op:'log',text:'未实现：测试'}]}]})],{pool:base});assert.equal(r.pending.length,1);});

check('Fixed three-choice uses the explicit ordered pool, including intentional tokens',async()=>{
 const s=state(),u=put(s),ctx={owner:0,source:u,unit:u,vars:{},chooser:async req=>{assert.deepEqual(req.options.map(o=>o.value),['token','tank','source']);return 'tank';}};
 await K.effects.composition.run([{op:'threeChoice',mode:'fixed',pool:{source:'cards',cardIds:['token','tank','source']},as:'received'}],s,ctx);
 assert.equal(s.players[0].hand[0].id,'tank');assert.equal(ctx.vars.received[0].instance,s.players[0].hand[0]);assert.equal(s.eventCounts?.['0|developed'],undefined);
});
check('Custom random pool excludes unrelated cards and deduplicates before sampling',async()=>{
 const s=state(),u=put(s),ctx={owner:0,source:u,unit:u,vars:{},chooser:async req=>{assert.deepEqual(new Set(req.options.map(o=>o.value)),new Set(['tank','source']));return 'source';}};
 const before=s.players[0].deck=['tank','tank','source','tank'];await K.effects.composition.run([{op:'threeChoice',mode:'random',pool:{source:'deck'},as:'copy'}],s,ctx);
 assert.equal(s.players[0].deck,before);assert.equal(before.length,4);assert.equal(s.players[0].hand[0].id,'source');assert.equal(ctx.vars.copy.length,1);
});
check('Develop emits its event, empty pools emit nothing, and a full hand clears the result',async()=>{
 const listener=card('developer-listener',{effects:[{trigger:'developed',actions:[{op:'changeResource',side:'self',property:'kredits',mode:'add',value:1}]}]});K.setPool([...base,listener]);
 try{const s=state(),u=put(s,'developer-listener'),ctx={owner:0,source:u,unit:u,vars:{},chooser:async()=> 'tank'};
 await K.effects.composition.run([{op:'developCard',pool:{source:'cards',cardIds:['tank']},as:'made'}],s,ctx);assert.equal(s.players[0].kredits,6);assert.equal(s.eventCounts['0|developed'],1);
 await K.effects.composition.run([{op:'developCard',pool:{source:'pool',where:{test:'compare',left:{expr:'read',path:'id'},cmp:'==',right:'missing'}},as:'made'}],s,ctx);assert.deepEqual(ctx.vars.made,[]);assert.equal(s.eventCounts['0|developed'],1);
 s.players[0].hand=Array.from({length:9},()=>K.makeHandInst('source'));await K.effects.composition.run([{op:'developCard',pool:{source:'cards',cardIds:['tank']},as:'made'}],s,ctx);assert.equal(s.players[0].hand.length,9);assert.deepEqual(ctx.vars.made,[]);assert.equal(s.eventCounts['0|developed'],2);
 }finally{K.setPool(base);}
});
check('Offer composites expand recursively into existing selection and creation atoms',()=>{
 const action={op:'developCard',pool:{source:'cards',cardIds:['tank']},as:'made'},expanded=K.effects.composition.expand([{op:'branch',test:{test:'all',items:[]},then:[action],else:[]}],'test');assert.deepEqual(expanded.actions[0].then.map(a=>a.op),['selectObjects','let','createCard','emitEvent']);
 const r=complete(O.compile('部署：若友方手牌数量小于2，开发1张单位。',card('source'),{pool:base,atomicOnly:true}));let composite=false;O.walk(r.effects.flatMap(e=>e.actions),a=>{if(K.effects.composition.catalog[a.op]?.composite)composite=true;});assert.equal(composite,false);
 assert.equal(complete(compile('部署：从卡组中开发1张单位。')).effects[0].actions[0].pool.source,'deck');assert.equal(complete(compile('部署：开发1张“测试,衍生单位”。')).effects[0].actions[0].pool.cardIds[0],'token');
});
check('Invalid and unavailable candidate pools remain diagnostic drafts',()=>{
 const schema=KG_EFFECT_CONTRACT.build({},K.effects,{}),fx=pool=>[{trigger:'deploy',actions:[{op:'threeChoice',mode:'fixed',pool}]}];
 for(const pool of [{source:'cards',cardIds:[]},{source:'cards',cardIds:{}},{source:'cards',cardIds:['a','b','c','d']}])assert.ok(KG_EFFECT_CONTRACT.validate(fx(pool),schema).errors.length);
 assert.equal(I.plan([card('missing-offer',{effects:fx({source:'cards',cardIds:['missing']})})],{pool:base}).pending.length,1);
 const r=I.plan([card('dependent-offer',{effects:fx({source:'cards',cardIds:['bad-candidate']})}),card('bad-candidate',{text:'部署：立即赢得游戏'})],{pool:base});assert.equal(r.ready.length,0);assert.equal(r.pending.length,2);
});
(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS '+name);passed++;}catch(e){console.error('FAIL '+name+'\n'+e.stack);process.exitCode=1;}}console.log(passed+'/'+tests.length+' OrC checks ('+game+')');})();
