'use strict';
// Reproducible, read-only coverage against the downloaded official collection.
const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto');
const repo=path.resolve(__dirname,'../..'),game=process.env.KG_GAME_DIR||path.join(repo,'electron/game');
for(const name of ['engine','primitives-extra','primitives','effects','effect-primitives','compiler','effect-contract','orc','card-import'])vm.runInThisContext(fs.readFileSync(path.join(game,'js',name+'.js'),'utf8'),{filename:name});
const input=path.join(__dirname,'corpus/official-raw.json'),content=fs.readFileSync(input,'utf8'),data=JSON.parse(content);
if(!data.includesReserve||!data.includesSpawnables||!data.includesExiles||data.cards.length!==data.reportedCount||new Set(data.cards.map(c=>c.cardId)).size!==data.cards.length)throw Error('Incomplete or duplicate official corpus');
const pool=data.cards.map(KG.cardImport.normalize);KG.setPool(pool);
const cards=pool.map(c=>{const r=KG.OrC.compile(c.text,c,{pool});return {id:c.id,name:c.name,text:c.text,type:c.cardType,reserved:c.reserved,token:c.token,textComplete:!r.diagnostics.some(d=>d.code!=='metadata-runtime-gap'),complete:r.complete,atomicOnly:r.complete&&!r.legacyOps.length,diagnostics:r.diagnostics,legacyOps:r.legacyOps};});
const importPlan=KG.cardImport.plan(data.cards,{pool:[]});
const totals={records:cards.length,textComplete:cards.filter(c=>c.textComplete).length,structureComplete:cards.filter(c=>c.complete).length,atomicOnly:cards.filter(c=>c.atomicOnly).length,importReady:importPlan.ready.length,pending:importPlan.pending.length,rejected:importPlan.rejected.length,runtimeVerified:0};
const groups={};for(const c of cards.filter(c=>!c.complete))for(const d of c.diagnostics){const key=d.code+': '+d.message.replace(/第 \d+ 个|actions\[\d+\]|effects\[\d+\]/g,'#');(groups[key]||(groups[key]=[])).push(c.id);}
const report={version:KG.OrC.version,source:data.source,retrievedAt:data.retrievedAt,corpusSHA256:crypto.createHash('sha256').update(content).digest('hex'),totals,limitations:['结构通过不代表实际结算已核验。','importReady 额外排除了缺少或未完成的形态、衍生卡依赖。','此报告不修改玩家卡池，也不把未知效果替换为空效果。'],gaps:Object.entries(groups).map(([reason,ids])=>({reason,count:ids.length,ids})).sort((a,b)=>b.count-a.count),cards};
const output=path.join(repo,'dist/orc-official-audit.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(totals));console.log('Top gaps:');for(const g of report.gaps.slice(0,15))console.log(g.count+' '+g.reason);console.log(output);
if(process.argv.includes('--require-complete')&&totals.importReady!==totals.records)process.exitCode=2;
