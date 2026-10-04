'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),assert=require('node:assert/strict');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kards-orc-cli-')),input=path.join(temp,'input.json'),output=path.join(temp,'ready.json'),cli=path.resolve(__dirname,'import-cards.js');
fs.writeFileSync(input,JSON.stringify([{id:'auto-a',name:'引用者',cardType:'unit',text:'部署：将一张“后置衍生”加入手牌。'},{id:'auto-b',name:'后置衍生',cardType:'unit',text:'闪击、轻甲2'}]));
const original=fs.readFileSync(input,'utf8');let r=cp.spawnSync(process.execPath,[cli,'--input',input,'--output',output,'--atomic-only'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(fs.readFileSync(output)).cards.length,2);assert.equal(fs.readFileSync(input,'utf8'),original);
fs.writeFileSync(input,JSON.stringify([{id:'bad',name:'待核对',text:'立即赢得游戏。'}]));r=cp.spawnSync(process.execPath,[cli,'--input',input,'--output',output],{encoding:'utf8'});assert.equal(r.status,2,r.stderr);assert.equal(JSON.parse(fs.readFileSync(output)).cards.length,0);const report=JSON.parse(fs.readFileSync(output.replace(/\.json$/,'.report.json')));assert.equal(report.pending.length,1);
console.log('PASS offline CLI forward references, basic primitives, deterministic output, source preservation and CI review exit code');
