'use strict';
// Offline automation: writes output/report only, never edits the source or live player pool.
const fs=require('fs'),path=require('path'),vm=require('vm');
const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
if(!arg('--input')||!arg('--output')){console.error('Usage: node tools/orc/import-cards.js --input cards.json|cards.csv --output ready.json [--report report.json] [--pool dependencies.json] [--atomic-only]');process.exit(1);}
const repo=path.resolve(__dirname,'../..'),game=path.join(repo,'electron/game');
for(const name of ['engine','primitives-extra','primitives','effects','effect-primitives','compiler','effect-contract','orc','card-import'])vm.runInThisContext(fs.readFileSync(path.join(game,'js',name+'.js'),'utf8'),{filename:name});
const input=path.resolve(arg('--input')),output=path.resolve(arg('--output')),reportPath=path.resolve(arg('--report')||output.replace(/\.json$/i,'')+'.report.json');
if(new Set([input,output,reportPath,...(arg('--pool')?[path.resolve(arg('--pool'))]:[])]).size!==(arg('--pool')?4:3))throw Error('输入、依赖、输出和报告必须使用不同文件');
try{
  const pool=arg('--pool')?KG.cardImport.parse(fs.readFileSync(arg('--pool'),'utf8'),arg('--pool')).cards:[];KG.setPool(pool);
  const data=KG.cardImport.parse(fs.readFileSync(input,'utf8'),input),report=KG.cardImport.plan(data.cards,{pool,atomicOnly:args.includes('--atomic-only')});
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(path.dirname(reportPath),{recursive:true});
  const imageKeys=new Set(report.ready.flatMap(c=>[c.file,c.src,c.id].filter(Boolean)));
  fs.writeFileSync(output,JSON.stringify({cards:report.ready,images:Object.fromEntries(Object.entries(data.images).filter(([k])=>imageKeys.has(k)))},null,2)+'\n');
  fs.writeFileSync(reportPath,JSON.stringify({...report,images:data.images},null,2)+'\n');
  console.log(JSON.stringify({summary:report.summary,output,report:reportPath}));
  if(report.pending.length||report.rejected.length)process.exitCode=2;
}catch(e){console.error('OrC import failed: '+e.message);process.exitCode=1;}
