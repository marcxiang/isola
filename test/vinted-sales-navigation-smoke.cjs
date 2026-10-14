'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {BrowserWindow}=require('electron');
const {loadSalesPage}=require('../src/sales-navigation.cjs');
const TARGET='https://www.vinted.fr/member/123456';
const REFRESH='https://www.vinted.fr/session-refresh?ref_url='+encodeURIComponent('/member/123456');
const IMAGE='https://www.vinted.fr/unfinished-fixture-image.png';
const page=script=>'<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Local sales navigation fixture</title><main><h1>Local catalog fixture</h1><p>No forms, product controls or remote resources.</p></main><script>'+script+'</script>';
const replace=(url,delay)=>'setTimeout(()=>location.replace('+JSON.stringify(url)+'),'+delay+');';

module.exports=async function salesNavigationSmoke(api,check){
 assert.ok(process.env.ISOLA_TEST_DATA,'Navigation smoke requires isolated test data');
 assert.equal(path.resolve(path.dirname(api.dataFile())),path.resolve(process.env.ISOLA_TEST_DATA));
 const engine=api.getCommerce(),beforeBusiness=JSON.stringify({plans:engine.db.plans,jobs:engine.db.jobs,claims:engine.db.claims,publications:engine.db.publications,sales:engine.db.sales});
 assert.equal(engine.running,false);assert.equal(engine.active.size,0);
 let profile,session,scenario,window;
 const allRequests=[],pendingResponses=new Set();
 const response=body=>new Response(body,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
 try{
  profile=api.saveProfile({name:'QA sales navigation local fixture',url:TARGET,fingerprintMode:'native',width:800,height:600});session=api.sesFor(profile);
  session.protocol.handle('https',request=>{
   const row={method:request.method,url:request.url};allRequests.push(row);scenario?.requests.push(row);
   if(request.method!=='GET')return new Response('Fixture denies mutation',{status:403});
   if(request.url===IMAGE){
    scenario.imageRequests++;
    // Keep the initial document loading while its script starts the refresh.
    // The response is always released during fixture cleanup.
    return new Promise(resolve=>{const release=()=>{pendingResponses.delete(release);resolve(new Response('',{status:404}));};pendingResponses.add(release);});
   }
   if(request.url===REFRESH){
    scenario.refreshRequests++;
    return response(page(replace(TARGET,scenario.mode==='cancel'?2000:100)));
   }
   if(request.url===TARGET){
    scenario.targetRequests++;
    if(scenario.targetRequests>1)return response(page('window.fixtureReturned=true;'));
    if(scenario.mode==='early-refresh')return response(page('const image=new Image();image.src='+JSON.stringify(IMAGE)+';document.body.append(image);'+replace(REFRESH,80)));
    if(scenario.mode==='delayed-refresh')return response(page('addEventListener("load",()=>{'+replace(REFRESH,60)+'},{once:true});'));
    if(scenario.mode==='cancel')return response(page(replace(REFRESH,60)));
    if(scenario.mode==='forbidden')return response(page(replace(scenario.destination,60)));
    if(scenario.mode==='new-window')return response(page('setTimeout(()=>window.open('+JSON.stringify(TARGET)+',"_blank"),60);'));
    return response(page(''));
   }
   // Even forbidden destinations stay intercepted; no request leaves this session.
   return new Response('Fixture denies external or login destination',{status:403});
  });
  async function run(mode,{destination,cancelAtRefresh=false}={}){
   scenario={mode,destination,requests:[],targetRequests:0,refreshRequests:0,imageRequests:0,newWindows:0,loadCalls:0,loadOutcome:null,continued:0,monitor:null};
   const current=scenario,controller=new AbortController();
   window=new BrowserWindow({show:false,width:800,height:600,webPreferences:{session,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
   const contents=window.webContents,originalWindows=BrowserWindow.getAllWindows().length;
   contents.setWindowOpenHandler(()=>{current.newWindows++;current.monitor?.rejectNewWindow();return {action:'deny'};});
   if(cancelAtRefresh)contents.on('did-navigate',(_event,url)=>{if(url===REFRESH)controller.abort();});
   // The helper receives real WebContents operations. This transparent facade
   // only records how Chromium settles the original loadURL promise.
   const observed={
    on:(...args)=>contents.on(...args),removeListener:(...args)=>contents.removeListener(...args),
    getURL:()=>contents.getURL(),isDestroyed:()=>contents.isDestroyed(),isLoadingMainFrame:()=>contents.isLoadingMainFrame(),
    loadURL:url=>{current.loadCalls++;return contents.loadURL(url).then(value=>{current.loadOutcome={state:'resolved'};return value;},error=>{current.loadOutcome={state:'rejected',code:error.code,errno:error.errno};throw error;});}
   };
   try{
    current.result=await loadSalesPage({contents:observed,target:TARGET,signal:controller.signal,guard:()=>{if(controller.signal.aborted)throw Object.assign(Error('Fixture cancelled'),{code:'STOPPED'});},onMonitor:value=>{current.monitor=value;},timeoutMs:5000,settleMs:220,pollMs:20});
    current.continued++;
   }catch(error){current.error={code:error.code,message:error.message};}
   finally{
    current.finalURL=contents.isDestroyed()?null:contents.getURL();current.windowCount=BrowserWindow.getAllWindows().length;current.originalWindows=originalWindows;
    if(!window.isDestroyed())window.destroy();window=null;
    for(const release of [...pendingResponses])release();
   }
   assert.equal(current.loadCalls,1,'The helper must never retry loadURL');
   assert.equal(current.monitor,null,'Navigation monitor must be cleared after success or failure');
   assert.equal(current.windowCount,current.originalWindows,'Fixture must never create another native window');
   assert.ok(current.requests.every(row=>row.method==='GET'));
   return current;
  }
  await check('sales navigation waits through an allowed refresh that aborts the initial native loadURL',async()=>{
   const result=await run('early-refresh');assert.equal(result.error,undefined);assert.equal(result.result.url,TARGET);assert.equal(result.result.sessionRefreshed,true);assert.equal(result.finalURL,TARGET);assert.equal(result.targetRequests,2);assert.equal(result.refreshRequests,1);assert.equal(result.imageRequests,1);assert.equal(result.loadOutcome.state,'rejected');assert.ok(result.loadOutcome.code==='ERR_ABORTED'||result.loadOutcome.errno===-3);assert.equal(result.continued,1);
   return {initialLoadAborted:true,allowedRefreshReturned:true,loadCalls:1,publicationAttempts:0};
  });
  await check('sales navigation waits for a delayed refresh after the initial native loadURL resolves',async()=>{
   const result=await run('delayed-refresh');assert.equal(result.error,undefined);assert.equal(result.result.sessionRefreshed,true);assert.equal(result.finalURL,TARGET);assert.equal(result.loadOutcome.state,'resolved');assert.equal(result.targetRequests,2);assert.equal(result.refreshRequests,1);assert.equal(result.continued,1);
   return {initialLoadResolved:true,lateRefreshSettled:true,loadCalls:1};
  });
  await check('sales navigation rejects off-origin and login redirects without entering business work',async()=>{
   for(const destination of ['https://outside.example.invalid/','https://www.vinted.fr/member/login']){const result=await run('forbidden',{destination});assert.equal(result.error?.code,'PAGE_CHANGED');assert.equal(result.continued,0);assert.equal(result.targetRequests,1);assert.equal(result.refreshRequests,0);}
   return {offOriginRejected:true,loginRejected:true,businessContinuations:0};
  });
  await check('sales navigation cancellation during refresh cannot continue into account or listing work',async()=>{
   const result=await run('cancel',{cancelAtRefresh:true});assert.equal(result.error?.code,'STOPPED');assert.equal(result.continued,0);assert.equal(result.targetRequests,1);assert.equal(result.refreshRequests,1);
   return {cancelledDuringRefresh:true,loadCalls:1,businessContinuations:0};
  });
  await check('sales navigation rejects a new-window request while waiting for the catalog to settle',async()=>{
   const result=await run('new-window');assert.equal(result.error?.code,'PAGE_CHANGED');assert.equal(result.newWindows,1);assert.equal(result.continued,0);
   return {newWindowDenied:true,additionalWindows:0,businessContinuations:0};
  });
  await check('sales navigation fixtures leave operational records unchanged and forward no network traffic',async()=>{
   assert.equal(JSON.stringify({plans:engine.db.plans,jobs:engine.db.jobs,claims:engine.db.claims,publications:engine.db.publications,sales:engine.db.sales}),beforeBusiness);assert.equal(engine.running,false);assert.equal(engine.active.size,0);assert.ok(allRequests.every(row=>row.method==='GET'));
   return {changedBusinessRecords:0,publicationAttempts:0,forwardedNetworkRequests:0,source:'temporary WebContents and locally intercepted HTTPS fixtures'};
  });
 }finally{
  if(window&&!window.isDestroyed())window.destroy();
  for(const release of [...pendingResponses])release();
  if(session)session.protocol.unhandle('https');
  if(profile)await api.deleteProfile(profile.id);
 }
};
