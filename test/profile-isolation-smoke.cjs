'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path');
const {randomUUID}=require('node:crypto');

// Every server, origin, credential and profile below belongs to this local test.
// Positive controls distinguish intentional same-profile tab sharing from leaks
// between two independent profiles. No external site or detector is contacted.
async function writeStores(value){
  document.cookie='isola_identity='+encodeURIComponent(value)+'; path=/; SameSite=Lax';localStorage.setItem('isola-identity',value);sessionStorage.setItem('tab-identity',value);
  await new Promise((resolve,reject)=>{const request=indexedDB.open('isola-profile-isolation',1);request.onupgradeneeded=()=>request.result.createObjectStore('values');request.onerror=()=>reject(Error('Fixture IndexedDB open failed'));request.onsuccess=()=>{const db=request.result,tx=db.transaction('values','readwrite');tx.objectStore('values').put(value,'identity');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(Error('Fixture IndexedDB write failed'));};};});
  const cache=await caches.open('isola-profile-isolation');await cache.put('/cached-private',new Response(value));return true;
}
async function readStores(){
  const cookie=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('isola_identity='));let idb=null;
  if((await indexedDB.databases()).some(db=>db.name==='isola-profile-isolation'))idb=await new Promise((resolve,reject)=>{const request=indexedDB.open('isola-profile-isolation',1);request.onerror=()=>reject(Error('Fixture IndexedDB read failed'));request.onsuccess=()=>{const db=request.result,tx=db.transaction('values'),get=tx.objectStore('values').get('identity');get.onsuccess=()=>resolve(get.result??null);get.onerror=()=>reject(Error('Fixture IndexedDB value failed'));tx.oncomplete=()=>db.close();};});
  const cached=await caches.match('/cached-private');return {cookie:cookie?decodeURIComponent(cookie.slice('isola_identity='.length)):null,local:localStorage.getItem('isola-identity'),idb,cache:cached?await cached.text():null,tab:sessionStorage.getItem('tab-identity')};
}
async function registerWorker(){
  await navigator.serviceWorker.register('/sw.js',{scope:'/'});await navigator.serviceWorker.ready;
  if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',done);resolve();};const timer=setTimeout(()=>{navigator.serviceWorker.removeEventListener('controllerchange',done);reject(Error('Fixture Service Worker did not control its page'));},4000);navigator.serviceWorker.addEventListener('controllerchange',done,{once:true});if(navigator.serviceWorker.controller)done();});return true;
}
async function serviceValue(value){
  const registration=await navigator.serviceWorker.getRegistration('/');if(!registration?.active)return null;
  return new Promise((resolve,reject)=>{const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(Error('Fixture Service Worker reply timed out'));},4000);channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data);};registration.active.postMessage(value,[channel.port2]);});
}
async function sharedValue(value){
  if(!window.isolationShared){window.isolationShared=new SharedWorker('/shared.js','same-isolation-worker');window.isolationShared.port.start();}
  return new Promise((resolve,reject)=>{const port=window.isolationShared.port,timer=setTimeout(()=>reject(Error('Fixture SharedWorker reply timed out')),4000);port.onmessage=event=>{clearTimeout(timer);resolve(event.data);};port.postMessage(value);});
}
const SW=`self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));async function value(set){const cache=await caches.open('isola-sw-isolation');if(typeof set==='string')await cache.put('/sw-private',new Response(set));const response=await cache.match('/sw-private');return response?await response.text():null;}self.addEventListener('message',event=>event.waitUntil(value(event.data.set).then(result=>event.ports[0]?.postMessage(result))));self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/sw-proof')event.respondWith(value().then(result=>new Response(result??'none',{headers:{'Cache-Control':'no-store'}})));});`;
const SHARED=`let value=null;onconnect=event=>{const port=event.ports[0];port.onmessage=event=>{if(typeof event.data.set==='string')value=event.data.set;port.postMessage(value);};port.start();};`;
const expected=(value,tab=value)=>({cookie:value,local:value,idb:value,cache:value,tab});

module.exports=async function profileIsolation(api,check){
  assert.ok(process.env.ISOLA_TEST_DATA,'Profile isolation requires an isolated QA userData');
  const profiles=[],servers=[];let cacheRequests=0,heldResponse=null;
  const start=async handler=>{const server=http.createServer(handler);server.on('clientError',(_error,socket)=>socket.destroy());await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});servers.push(server);return server;};
  const until=async(predicate,label='Fixture state')=>{const end=Date.now()+8000;while(!await predicate()){if(Date.now()>=end)throw Error(label+' timed out');await new Promise(resolve=>setTimeout(resolve,25));}};
  const js=async(c,expression)=>{let timer;try{return await Promise.race([c.executeJavaScript(expression),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Local isolation fixture read timed out')),8000);})]);}finally{clearTimeout(timer);}};
  const call=(c,fn,value)=>js(c,'('+fn.toString()+')('+(value===undefined?'':JSON.stringify(value))+')');
  const close=async row=>{const w=api.windows.get(row.id);if(w&&!w.isDestroyed())w.close();await until(()=>!api.windows.has(row.id),'Profile close');};
  const create=async input=>{const p=api.saveProfile({name:'QA profile isolation',fingerprintMode:'native',width:1050,height:760,...input});profiles.push(p);return p;};
  const open=async p=>{await api.launch(p.id);const w=api.windows.get(p.id),c=w.tabs[0].view.webContents;c.setBackgroundThrottling(false);return {p,w,c,tab:w.tabs[0]};};
  let a,b,a2,copy;
  try{
    const server=await start((request,response)=>{
      const url=new URL(request.url,'http://fixture.invalid');
      if(url.pathname==='/http-cache'){response.setHeader('Cache-Control','public, max-age=3600');response.setHeader('Content-Type','text/plain');response.end('cache-response-'+(++cacheRequests));return;}
      response.setHeader('Cache-Control','no-store');
      if(url.pathname==='/sw.js'||url.pathname==='/shared.js'){response.setHeader('Content-Type','application/javascript');response.end(url.pathname==='/sw.js'?SW:SHARED);return;}
      if(url.pathname==='/heartbeat'){response.end('alive');return;}
      if(url.pathname==='/hold'){heldResponse=response;request.on('aborted',()=>{if(heldResponse===response)heldResponse=null;});return;}
      response.setHeader('Content-Type','text/html');response.end('<!doctype html><meta charset="utf-8"><title>Local profile isolation fixture</title><h1>Local profile isolation fixture</h1>');
    });
    const origin='http://127.0.0.1:'+server.address().port;
    const pa=await create({id:'QA-Isolation-'+randomUUID(),name:'QA isolated A',url:origin}),pb=await create({name:'QA isolated B',url:origin});
    a=await open(pa);b=await open(pb);
    await check('case-only IDs are rejected and every distinct environment has a distinct persistent directory',async()=>{
      const count=api.list().length;assert.throws(()=>api.saveProfile({id:pa.id.toLowerCase(),name:'Must not alias A',url:origin}),/标识|大小写|重复/);assert.throws(()=>api.saveProfile({id:123,name:'Must not coerce a numeric ID',url:origin}),/标识/);assert.equal(api.list().length,count);assert.ok(api.list().some(p=>p.id===pa.id));assert.ok(!api.list().some(p=>p.id===pa.id.toLowerCase()));
      const paths=profiles.map(p=>{const value=api.sesFor(p).storagePath;assert.equal(typeof value,'string');return path.resolve(value).toLowerCase();});assert.equal(new Set(paths).size,paths.length);assert.notEqual(a.c.session,b.c.session);assert.equal(a.c.session,api.sesFor(pa));assert.equal(b.c.session,api.sesFor(pb));
      return {caseAliasRejected:true,numericAliasRejected:true,independentPersistentDirectories:paths.length};
    });
    await check('same-origin cookies, localStorage, IndexedDB and CacheStorage are isolated in both directions',async()=>{
      await call(a.c,writeStores,'A');assert.deepEqual(await call(b.c,readStores),expected(null));await call(b.c,writeStores,'B');assert.deepEqual(await call(a.c,readStores),expected('A'));assert.deepEqual(await call(b.c,readStores),expected('B'));
      await api.sesFor(pa).cookies.set({url:origin,name:'isola_http_only',value:'A-private',httpOnly:true,path:'/'});assert.equal((await api.sesFor(pb).cookies.get({url:origin,name:'isola_http_only'})).length,0);await api.sesFor(pb).cookies.set({url:origin,name:'isola_http_only',value:'B-private',httpOnly:true,path:'/'});assert.equal((await api.sesFor(pa).cookies.get({url:origin,name:'isola_http_only'}))[0].value,'A-private');assert.equal(await js(a.c,'document.cookie.includes("isola_http_only")'),false);
      return {directions:2,cookies:true,httpOnlyCookies:true,localStorage:true,indexedDB:true,cacheStorage:true};
    });
    await check('a second tab shares its own environment session and storage while sessionStorage remains tab-local',async()=>{
      await a.w.webContents.executeJavaScript('window.browser.navigate("new")');const tab=a.w.tabs.find(t=>t.id===a.w.activeTab);assert.notEqual(tab,a.tab);await tab.view.webContents.loadURL(origin+'/tab');a2=tab.view.webContents;a2.setBackgroundThrottling(false);assert.equal(a2.session,a.c.session);assert.deepEqual(await call(a2,readStores),expected('A',null));assert.deepEqual(await call(a.c,readStores),expected('A'));assert.equal((await a2.session.cookies.get({url:origin,name:'isola_http_only'}))[0].value,'A-private');
      return {sameProfileSharedSession:true,sharedPersistentStores:true,separateTabSessionStorage:true};
    });
    await check('Service Worker registration, cache and controlled fetch stay inside their owning profile',async()=>{
      await call(a.c,registerWorker);assert.equal(await call(a.c,serviceValue,{set:'A-worker'}),'A-worker');assert.equal(await js(b.c,'navigator.serviceWorker.getRegistrations().then(rows=>rows.length)'),0);assert.equal(await js(a2,'navigator.serviceWorker.getRegistrations().then(rows=>rows.length)'),1);assert.equal(await call(a2,serviceValue,{read:true}),'A-worker');
      await call(b.c,registerWorker);assert.equal(await call(b.c,serviceValue,{read:true}),null);assert.equal(await call(b.c,serviceValue,{set:'B-worker'}),'B-worker');assert.equal(await call(a.c,serviceValue,{read:true}),'A-worker');
      assert.equal(await js(a.c,'fetch("/sw-proof",{cache:"no-store"}).then(r=>r.text())'),'A-worker');assert.equal(await js(b.c,'fetch("/sw-proof",{cache:"no-store"}).then(r=>r.text())'),'B-worker');
      return {differentProfilesIsolated:true,sameProfileTabShared:true,realControlledFetch:true};
    });
    await check('same-named SharedWorkers share only their own profile memory',async()=>{
      assert.equal(await call(a.c,sharedValue,{set:'A-shared'}),'A-shared');assert.equal(await call(a2,sharedValue,{read:true}),'A-shared');assert.equal(await call(b.c,sharedValue,{read:true}),null);assert.equal(await call(b.c,sharedValue,{set:'B-shared'}),'B-shared');assert.equal(await call(a.c,sharedValue,{read:true}),'A-shared');return {sameProfilePositiveControl:true,differentProfileMemoryIsolated:true};
    });
    await check('BroadcastChannel messages reach same-profile tabs and never the other profile',async()=>{
      const channel='isola-channel-'+randomUUID(),setup='window.isolationMessages=[];window.isolationChannel=new BroadcastChannel('+JSON.stringify(channel)+');isolationChannel.onmessage=event=>isolationMessages.push(event.data);true;';await js(a.c,setup);await js(a2,setup);await js(b.c,setup);await js(a.c,'isolationChannel.postMessage("A-only");true');await until(async()=>(await js(a2,'isolationMessages.length'))===1,'Same-profile broadcast');await new Promise(resolve=>setTimeout(resolve,120));assert.deepEqual(await js(a2,'isolationMessages'),['A-only']);assert.deepEqual(await js(b.c,'isolationMessages'),[]);
      await js(b.c,'isolationChannel.postMessage("B-only");true');await new Promise(resolve=>setTimeout(resolve,120));assert.deepEqual(await js(a.c,'isolationMessages'),[]);assert.deepEqual(await js(a2,'isolationMessages'),['A-only']);return {sameProfileMessageDelivered:true,crossProfileMessages:0};
    });
    await check('HTTP cache is reused by same-profile tabs while another profile makes its own request',async()=>{
      const get=c=>js(c,'fetch("/http-cache").then(r=>r.text())'),first=await get(a.c),count=cacheRequests;assert.equal(await get(a.c),first);assert.equal(await get(a2),first);assert.equal(cacheRequests,count);const other=await get(b.c);assert.notEqual(other,first);assert.equal(cacheRequests,count+1);assert.equal(await get(b.c),other);assert.equal(cacheRequests,count+1);return {sameProfileCacheReused:true,differentProfileNetworkFetch:true};
    });
    await check('configuration copies open with empty storage, workers and history metadata',async()=>{
      copy=api.duplicateProfile(pa.id);profiles.push(copy);assert.notEqual(copy.id,pa.id);assert.equal(copy.lastOpenedAt,null);assert.equal(copy.proxyCheck,null);const opened=await open(copy);assert.deepEqual(await call(opened.c,readStores),expected(null));assert.equal(await js(opened.c,'navigator.serviceWorker.getRegistrations().then(rows=>rows.length)'),0);assert.equal(await call(opened.c,sharedValue,{read:true}),null);assert.equal((await api.sesFor(copy).cookies.get({url:origin,name:'isola_http_only'})).length,0);assert.notEqual(path.resolve(api.sesFor(copy).storagePath).toLowerCase(),path.resolve(api.sesFor(pa).storagePath).toLowerCase());assert.deepEqual(await call(a.c,readStores),expected('A'));assert.deepEqual(await call(b.c,readStores),expected('B'));await close(copy);return {newEmptySession:true,sourceDataPreserved:true,openingAndProxyHistoryCleared:true};
    });
    await check('closing and clearing one profile preserves the other profile data, workers and in-flight connection',async()=>{
      await js(b.c,'window.isolationHold={done:false,failed:false};fetch("/hold",{cache:"no-store"}).then(r=>r.text()).then(value=>{isolationHold.value=value;isolationHold.done=true;},()=>{isolationHold.failed=true;isolationHold.done=true;});window.isolationHeartbeat=0;window.isolationHeartbeatErrors=0;window.isolationTimer=setInterval(()=>fetch("/heartbeat",{cache:"no-store"}).then(r=>r.text()).then(()=>isolationHeartbeat++,()=>isolationHeartbeatErrors++),40);true');
      await until(()=>!!heldResponse,'Other-profile in-flight request');await until(async()=>(await js(b.c,'isolationHeartbeat'))>=2,'Other-profile heartbeat');const before=await js(b.c,'isolationHeartbeat');await close(pa);await api.clearProfile(pa.id);assert.ok(heldResponse&&!heldResponse.destroyed,'Clearing A must not close B connection');heldResponse.end('B-still-connected');heldResponse=null;await until(async()=>(await js(b.c,'isolationHold.done')),'Other-profile held response');assert.deepEqual(await js(b.c,'isolationHold'),{done:true,failed:false,value:'B-still-connected'});await until(async()=>(await js(b.c,'isolationHeartbeat'))>before,'Other-profile continued heartbeat');assert.equal(await js(b.c,'isolationHeartbeatErrors'),0);assert.deepEqual(await call(b.c,readStores),expected('B'));assert.equal(await call(b.c,serviceValue,{read:true}),'B-worker');assert.equal(await call(b.c,sharedValue,{read:true}),'B-shared');assert.equal(await js(b.c,'fetch("/sw-proof",{cache:"no-store"}).then(r=>r.text())'),'B-worker');
      a=await open(pa);assert.deepEqual(await call(a.c,readStores),expected(null));assert.equal(await js(a.c,'navigator.serviceWorker.getRegistrations().then(rows=>rows.length)'),0);assert.equal((await api.sesFor(pa).cookies.get({url:origin,name:'isola_http_only'})).length,0);assert.equal(await call(a.c,sharedValue,{read:true}),null);await js(b.c,'clearInterval(isolationTimer);true');return {clearedProfileEmpty:true,otherProfileStoragePreserved:true,otherProfileWorkersPreserved:true,otherProfileConnectionPreserved:true};
    });
    await check('two profiles using the same proxy endpoint and realm retain separate authentication caches',async()=>{
      let challenges=0;const authA='Basic '+Buffer.from('isolation-a:local-a-password').toString('base64'),authB='Basic '+Buffer.from('isolation-b:local-b-password').toString('base64');const proxy=await start((request,response)=>{response.setHeader('Cache-Control','no-store');const identity=request.headers['proxy-authorization']===authA?'A':request.headers['proxy-authorization']===authB?'B':null;if(!identity){challenges++;response.writeHead(407,{'Proxy-Authenticate':'Basic realm="shared-local-proxy-realm"'});response.end('Local authentication fixture');return;}response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Local proxy identity</title><body data-identity="'+identity+'">'+identity+'</body>');});
      const target='http://isola-profile-proxy.invalid/',px={type:'http',host:'127.0.0.1',port:proxy.address().port},one=await create({name:'QA proxy identity A',url:target,proxy:{...px,username:'isolation-a',password:'local-a-password'}}),two=await create({name:'QA proxy identity B',url:target,proxy:{...px,username:'isolation-b',password:'local-b-password'}}),aa=await open(one),bb=await open(two);assert.equal(await js(aa.c,'document.body.dataset.identity'),'A');assert.equal(await js(bb.c,'document.body.dataset.identity'),'B');
      const read=c=>js(c,'fetch("/same-resource",{cache:"no-store"}).then(r=>r.text()).then(text=>new DOMParser().parseFromString(text,"text/html").body.dataset.identity)');assert.equal(await read(aa.c),'A');assert.equal(await read(bb.c),'B');const before=challenges;await api.sesFor(one).clearAuthCache();await api.sesFor(one).closeAllConnections();assert.equal(await read(bb.c),'B');assert.equal(challenges,before,'Clearing A must not evict B authentication');return {sameEndpointAndRealm:true,differentCredentialsIsolated:true,clearingOneAuthCachePreservesOther:true};
    });
  }finally{
    if(heldResponse&&!heldResponse.destroyed)heldResponse.end('Fixture cleanup');
    for(const profile of profiles){await close(profile);await api.deleteProfile(profile.id);}
    for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
};
