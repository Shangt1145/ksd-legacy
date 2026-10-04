'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const repo=path.resolve(__dirname,'../..'),game=path.join(repo,'electron/game'),fallback=path.join(repo,'resources/app/game');
for(const name of ['engine','primitives-extra','primitives','effects','effect-primitives','compiler','effect-contract','orc','card-import','cards','effects-data']){
  const source=[game,fallback].map(d=>path.join(d,'js',name+'.js')).find(fs.existsSync);vm.runInThisContext(fs.readFileSync(source,'utf8'),{filename:name});
}
KG.setPool(KG_CARDS);const rows=KG_CARDS.filter(c=>c.text&&!c.referenceCard).map(c=>{const old=KG.compiler.compile(c.text,c),r=KG.OrC.compile(c.text,c,{pool:KG_CARDS});return {id:c.id,name:c.name,legacyComplete:!old.warnings.length,complete:r.complete,atomicOnly:r.complete&&!r.legacyOps.length,legacyOps:r.legacyOps,diagnostics:r.diagnostics};});
const totals={cards:rows.length,legacyComplete:rows.filter(r=>r.legacyComplete).length,complete:rows.filter(r=>r.complete).length,atomicOnly:rows.filter(r=>r.atomicOnly).length,needsReview:rows.filter(r=>!r.complete).length};
const ops={};for(const row of rows)for(const op of row.legacyOps)ops[op]=(ops[op]||0)+1;
fs.mkdirSync(path.join(repo,'dist'),{recursive:true});fs.writeFileSync(path.join(repo,'dist/orc-pool-audit.json'),JSON.stringify({totals,legacyOperations:ops,cards:rows},null,2));console.log(JSON.stringify({totals,legacyOperations:ops}));
