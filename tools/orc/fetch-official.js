'use strict';
// Public official collection, including reserve and generated cards. Text only; no art download.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
if(process.platform==='win32'){
  // Windows' native HTTP stack also works on hosts where Node TLS cannot reach this endpoint.
  const result=require('child_process').spawnSync('pwsh.exe',['-NoProfile','-File',path.join(__dirname,'fetch-official.ps1')],{stdio:'inherit',windowsHide:true});
  if(result.error){console.error(result.error.message);process.exit(1);}process.exit(result.status??1);
}
const endpoint='https://herokuapi.kards.com/graphql',pageSize=100;
const query=`query getCards($language:String,$offset:Int,$showSpawnables:Boolean,$showReserved:Boolean,$showExiles:Boolean){cards(language:$language,first:${pageSize},offset:$offset,showSpawnables:$showSpawnables,showReserved:$showReserved,showExiles:$showExiles){pageInfo{count hasNextPage} edges{node{id cardId importId json reserved}}}}`;
(async()=>{
  const cards=[],seen=new Set();let count=null;
  for(let offset=0;offset<10000;offset+=pageSize){
    let data;for(let attempt=0;attempt<3;attempt++)try{const res=await fetch(endpoint,{method:'POST',headers:{referer:'https://www.kards.com/','content-type':'application/json'},body:JSON.stringify({operationName:'getCards',query,variables:{language:'zh',offset,showSpawnables:true,showReserved:true,showExiles:true}}),signal:AbortSignal.timeout(20000)});if(!res.ok)throw Error('HTTP '+res.status);data=await res.json();if(data.errors)throw Error(JSON.stringify(data.errors));break;}catch(e){if(attempt===2)throw e;console.error('Retry page '+offset+': '+e.message);}
    const page=data.data?.cards;if(!page)throw Error('Official cards response missing');if(count!=null&&count!==page.pageInfo?.count)throw Error('Collection changed during pagination; fetch again');count=page.pageInfo?.count??count;
    for(const {node} of page.edges||[]){if(!seen.has(node.id)){seen.add(node.id);cards.push(node);}}
    console.log('Official collection: '+cards.length+' / '+count);
    if(!page.pageInfo?.hasNextPage)break;
    if(!page.edges?.length)throw Error('Pagination ended before hasNextPage');
  }
  if(!cards.length||count!=null&&cards.length!==count)throw Error('Incomplete official collection: '+cards.length+'/'+count);
  const output=path.resolve(__dirname,'corpus/official-raw.json');fs.mkdirSync(path.dirname(output),{recursive:true});const content=JSON.stringify({source:'https://www.kards.com/zh/decks/collection',endpoint,retrievedAt:new Date().toISOString(),reportedCount:count,includesReserve:true,includesSpawnables:true,includesExiles:true,cards},null,2)+'\n';fs.writeFileSync(output,content);console.log('Saved '+cards.length+' cards, SHA256 '+crypto.createHash('sha256').update(content).digest('hex'));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
