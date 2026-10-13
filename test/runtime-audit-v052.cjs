'use strict';
// Supplementary local-only audit. Invoke from the Electron QA runner with isolated data.
// No third-party website, live account, detector endpoint or supplier API is contacted.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
module.exports=async function runtimeAudit(api,check){
 assert.ok(process.env.ISOLA_TEST_DATA,'Audit requires an isolated QA userData directory');
 assert.equal(path.resolve(path.dirname(api.dataFile())),path.resolve(process.env.ISOLA_TEST_DATA));
 const profiles=[],servers=[];
 const start=async handler=>{const server=http.createServer(handler);server.on('clientError',(_,socket)=>socket.destroy());await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});servers.push(server);return server;};
 const until=async fn=>{const end=Date.now()+8000;while(!fn()){if(Date.now()>end)throw Error('Audit cleanup timed out');await new Promise(r=>setTimeout(r,20));}};
 const create=async input=>{const p=api.saveProfile({name:'QA supplementary audit',fingerprintMode:'native',...input});profiles.push(p);await api.launch(p.id);return {profile:p,w:api.windows.get(p.id),c:api.windows.get(p.id).tabs[0].view.webContents};};
 const script=fs.readFileSync(path.join(__dirname,'../src/device-probe.cjs'),'utf8');
 let authRound=1,authChallenges=0;
 try{
  const proxy=await start((req,res)=>{
   res.setHeader('Cache-Control','no-store');
   if(req.headers['proxy-authorization']!=='Basic '+Buffer.from('qa-retry:qa-secret').toString('base64')){authChallenges++;res.writeHead(407,{'Proxy-Authenticate':`Basic realm="qa-round-${authRound}"`,'Connection':'close'});res.end('Authentication required');return;}
   res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Proxy fixture</title><body data-round="${authRound}">Authenticated proxy fixture ${authRound}</body>`);
  });
  await check('browser HTTP proxy authenticates three legitimate challenges in one tab lifecycle',async()=>{
   const target='http://proxy-audit.invalid/';const p=await create({url:target,proxy:{type:'http',host:'127.0.0.1',port:proxy.address().port,username:'qa-retry',password:'qa-secret'}});
   const rounds=[];
   for(authRound=1;authRound<=3;authRound++){
    if(authRound>1){await api.sesFor(p.profile).clearAuthCache();await api.sesFor(p.profile).closeAllConnections();await p.c.loadURL(target+'?round='+authRound);}
    const value=await p.c.executeJavaScript('document.body.dataset.round||null');rounds.push(value);assert.equal(value,String(authRound),`Proxy authentication round ${authRound} failed after ${authChallenges} challenges`);
   }
   assert.ok(authChallenges>=3,'Fixture must challenge at least three times');return {rounds,challenges:authChallenges,origin:'local fake HTTP proxy; no real proxy subscription'};
  });
  const server=await start((req,res)=>{
   res.setHeader('Cache-Control','no-store');
   if(req.url==='/sw.js'){res.setHeader('Content-Type','application/javascript');res.end("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));");return;}
   if(req.url==='/shared.js'){res.setHeader('Content-Type','application/javascript');res.end("let value=null;onconnect=e=>{const p=e.ports[0];p.onmessage=e=>{if(e.data.set)value=e.data.set;p.postMessage(value);};p.start();};");return;}
   res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Supplementary environment audit</title><script>'+script+'</script>');
  });
  const origin='http://127.0.0.1:'+server.address().port,a=await create({name:'QA audit partition A',url:origin}),b=await create({name:'QA audit partition B',url:origin});
  await check('CacheStorage and Service Worker registrations remain isolated across profiles',async()=>{
   await a.c.executeJavaScript(`(async()=>{const cache=await caches.open('qa-audit-cache');await cache.put('/private-item',new Response('partition-A'));await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;return true;})()`);
   const independent=await b.c.executeJavaScript(`(async()=>({caches:await caches.keys(),registrations:(await navigator.serviceWorker.getRegistrations()).map(r=>r.scope)}))()`);
   assert.deepEqual(independent.caches,[]);assert.deepEqual(independent.registrations,[]);
   assert.equal(await a.c.executeJavaScript(`caches.open('qa-audit-cache').then(c=>c.match('/private-item')).then(r=>r.text())`),'partition-A');return {cacheStorageIsolated:true,serviceWorkerRegistrationIsolated:true};
  });
  await check('named SharedWorker memory remains isolated across profiles',async()=>{
   const read=value=>`new Promise((resolve,reject)=>{const worker=new SharedWorker('/shared.js','same-worker-name');const timer=setTimeout(()=>{worker.port.close();reject(Error('SharedWorker timeout'))},4000);worker.port.onmessage=e=>{clearTimeout(timer);worker.port.close();resolve(e.data)};worker.port.start();worker.port.postMessage(${JSON.stringify(value)});})`;
   assert.equal(await a.c.executeJavaScript(read({set:'partition-A'})),'partition-A');assert.equal(await b.c.executeJavaScript(read({read:true})),null);return {sharedWorkerMemoryIsolated:true};
  });
  await check('custom environment cross-context audit records real mismatches without a device-pass claim',async()=>{
   const p=await create({name:'QA explicit custom-context audit',url:origin,fingerprintMode:'custom',language:'ja-JP',timezone:'Asia/Tokyo',hardwareConcurrency:2});
   const result=await p.c.executeJavaScript('IsolaDeviceProbe.run()');assert.equal(result.page.language,'ja-JP');assert.equal(result.page.cpu,2);assert.equal(result.page.timezone,'Asia/Tokyo');
   return {scope:'Observation only, not an anti-detection pass',page:{language:result.page.language,cpu:result.page.cpu,timezone:result.page.timezone},worker:result.comparisons.worker,iframe:result.comparisons.iframe};
  });
 }finally{
  for(const p of profiles){const w=api.windows.get(p.id);if(w&&!w.isDestroyed())w.close();await until(()=>!api.windows.has(p.id));await api.deleteProfile(p.id);}
  for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 }
};
