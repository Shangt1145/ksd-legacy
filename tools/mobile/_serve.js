/* 诊断用静态服务器（node tools/mobile/_serve.js <root> <port> [--cap]）
 * --cap 模拟 Capacitor：任何没落盘的路径（含 POST）一律回 index.html（SPA fallback），
 *       这正是 APK 里 fetch('/__delete-card') 会遇到的真实情况。 */
const http=require('http'),fs=require('fs'),path=require('path'),url=require('url');
const ROOT=path.resolve(process.argv[2]||'.'),PORT=+(process.argv[3]||8899);
const CAP=process.argv.includes('--cap');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2'};
http.createServer((req,res)=>{
  let p=decodeURIComponent(url.parse(req.url).pathname);
  if(p.endsWith('/'))p+='index.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)){res.writeHead(403);return res.end();}
  fs.readFile(f,(e,d)=>{
    if(e){
      if(CAP){ // Capacitor WebViewAssetLoader 行为：找不到 → 回 index.html
        return fs.readFile(path.join(ROOT,'index.html'),(e2,d2)=>{
          if(e2){res.writeHead(404,{'Content-Type':'text/plain'});return res.end('404');}
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(d2);
        });
      }
      res.writeHead(404,{'Content-Type':'text/plain'});return res.end('404 '+p);
    }
    res.writeHead(200,{'Content-Type':MIME[path.extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(d);
  });
}).listen(PORT,'127.0.0.1',()=>console.log('serve '+ROOT+' on '+PORT+(CAP?' [cap-mode]':'')));
