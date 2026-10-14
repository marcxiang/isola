'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {VintedSalesRuntime}=require('../src/vinted-sales-runtime.cjs');
const USER_URL='https://www.vinted.fr/?fixture=original-user-tab';
const MEMBER_ID='987654321001',CATALOG_URL='https://www.vinted.fr/member/'+MEMBER_ID;
const html=(catalog=false)=>`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Local sales runtime ${catalog?'catalog':'user'} fixture</title><main><h1>${catalog?'Catalog fixture intentionally incomplete':'Original user page'}</h1><input id="user-note" value="fixture note must survive"><p>No external assets, forms, or submission controls.</p></main>`;
const until=async predicate=>{const end=Date.now()+8000;while(!predicate()){if(Date.now()>end)throw Error('Sales main fixture timed out');await new Promise(resolve=>setTimeout(resolve,25));}};

module.exports=async function salesMainSmoke(api,check){
 assert.ok(process.env.ISOLA_TEST_DATA,'Sales main smoke requires an isolated data directory');
 assert.equal(path.resolve(path.dirname(api.dataFile())),path.resolve(process.env.ISOLA_TEST_DATA));
 let profile,w,session,engine,originalDB,originalInspect,originalAIState;
 const requests=[],catalogReads=[];
 try{
  engine=api.getCommerce();assert.equal(engine.running,false);assert.equal(engine.ticking,false);assert.equal(engine.active.size,0);assert.equal(engine.db.plans.length,0);assert.equal(engine.db.jobs.length,0);assert.deepEqual(engine.db.publicationSupplierSync,[]);assert.deepEqual(engine.db.publications.submissions,[]);assert.deepEqual(engine.db.photoPreparations,[]);assert.deepEqual(engine.db.claims,[]);
  assert.ok(engine.adapter instanceof VintedSalesRuntime,'Must exercise the production runtime installed by main');
  assert.equal(engine.adapter.readiness().capabilities.publish,true);assert.equal(engine.adapter.readiness().capabilities.procurement,false);
  originalDB=engine.db;engine.db=JSON.parse(JSON.stringify(originalDB));originalInspect=engine.adapter.inspectCatalog;
  profile=api.saveProfile({name:'QA sales main local fixture',url:USER_URL,fingerprintMode:'native',width:1180,height:900});session=api.sesFor(profile);
  session.protocol.handle('https',request=>{
   requests.push({method:request.method,url:request.url});const url=new URL(request.url);
   if(request.method!=='GET'||url.origin!=='https://www.vinted.fr')return new Response('Fixture denies this request',{status:403});
   if(request.url===USER_URL)return new Response(html(),{headers:{'content-type':'text/html; charset=utf-8'}});
   if(request.url===CATALOG_URL)return new Response(html(true),{headers:{'content-type':'text/html; charset=utf-8'}});
   return new Response('No live network access in this fixture',{status:404});
  });
  await api.launch(profile.id);w=api.windows.get(profile.id);const userTab=w.tabs[0],userContents=userTab.view.webContents;
  await userContents.executeJavaScript('document.querySelector("#user-note").value="original user draft preserved"');
  engine.db.products=[{id:'fixture-sales-main-product',sku:'FIXTURE-SALES-MAIN',name:'Local sales runtime fixture product',stock:5,priceCents:100,photoSetsAvailable:1}];
  const plan=engine.savePlan({profileId:profile.id,productId:'fixture-sales-main-product',listingPriceCents:500,minOfferCents:400,targetCount:2,enabled:true,reuseOwnPhotos:true,listing:{title:'Local fixture accessory',description:'Local testing fixture, never published.',categoryPath:['Maison','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'}});
  engine.bindMarketAccount(profile.id,{verified:true,memberId:MEMBER_ID,username:'fixture_sales_main',profileURL:CATALOG_URL,documentKey:'fixture-original-user-document'});
  engine.adapter.inspectCatalog=async function(profileId,{signal,expectedAccount}){
   assert.equal(profileId,profile.id);assert.equal(expectedAccount.memberId,MEMBER_ID);
   const active=engine.active.get(profileId),job=engine.db.jobs.find(row=>row.planId===plan.id),lease=engine.leases.snapshot().find(row=>row.profileId===profileId);
   assert.equal(active.signal,signal);assert.equal(signal.aborted,false);assert.equal(job.state,'running');assert.equal(lease.jobId,job.id);
   // Calling the inherited current() is important: the production adapter must
   // recognize its own lease instead of rejecting main's active-operation flag.
   const selected=this.current(profileId,{signal});assert.equal(selected.tab.view.webContents.getURL(),CATALOG_URL);assert.notEqual(selected.tab.id,userTab.id);assert.equal(w.navigationPending,false);
   const heading=await selected.tab.view.webContents.executeJavaScript('document.querySelector("h1").textContent');assert.equal(heading,'Catalog fixture intentionally incomplete');
   catalogReads.push({tabId:selected.tab.id,jobId:job.id,leaseJobId:lease.jobId});
   return {complete:false,duplicate:false,reason:'Fixture catalog is deliberately incomplete; no supplier or publication step may run.'};
  };
  const assertNoBusinessMutation=()=>{
   assert.deepEqual(engine.db.photoPreparations,[]);assert.deepEqual(engine.db.claims,[]);assert.deepEqual(engine.db.publications.submissions,[]);assert.deepEqual(engine.db.publicationSupplierSync,[]);assert.equal(plan.activeListingId,null);
   assert.equal(engine.active.size,0);assert.deepEqual(engine.leases.snapshot(),[]);assert.equal(engine.adapter.uiOwner,null);
   assert.ok(requests.every(row=>row.method==='GET'&&[USER_URL,CATALOG_URL].includes(row.url)),'Every request must stay within the static local fixture');
  };
  await check('production sales runtime uses its own lease to create a dedicated catalog tab and preserves the original user page',async()=>{
   await engine.runOnce();const job=engine.db.jobs.find(row=>row.planId===plan.id);
   assert.equal(job.state,'needs_review');assert.equal(job.blockedReason,'CATALOG_INCOMPLETE');assert.equal(job.operation,null);assert.equal(job.mutationPending,false);assert.equal(job.result,null);
   assert.equal(catalogReads.length,1);assert.equal(w.tabs.length,2);assert.equal(w.activeTab,catalogReads[0].tabId);assert.equal(userContents.getURL(),USER_URL);assert.equal(await userContents.executeJavaScript('document.querySelector("#user-note").value'),'original user draft preserved');assertNoBusinessMutation();
   return {productionRuntime:true,mainNavigation:true,ownLeaseAccepted:true,dedicatedCatalogTab:true,userDraftPreserved:true,publicationAttempts:0};
  });
  await check('requeued catalog inspection reuses its original dedicated tab without creating or loading another page',async()=>{
   const job=engine.db.jobs.find(row=>row.planId===plan.id),beforeRequests=requests.length;
   await w.webContents.executeJavaScript('window.browser.navigate("switch",'+JSON.stringify(userTab.id)+')');assert.equal(w.activeTab,userTab.id);
   await engine.resolve(job.id,'retry');await engine.runOnce();
   assert.equal(engine.db.jobs.length,1);assert.equal(job.state,'needs_review');assert.equal(job.blockedReason,'CATALOG_INCOMPLETE');assert.equal(catalogReads.length,2);assert.equal(catalogReads[1].tabId,catalogReads[0].tabId);assert.equal(catalogReads[1].jobId,job.id);assert.equal(w.tabs.length,2);assert.equal(requests.length,beforeRequests);assert.equal(userContents.getURL(),USER_URL);assertNoBusinessMutation();
   return {sameJob:true,sameDedicatedTab:true,additionalNavigations:0};
  });
  await check('an account already controlled by AI keeps its active user tab and queues sales work without navigation',async()=>{
   const job=engine.db.jobs.find(row=>row.planId===plan.id);await engine.resolve(job.id,'retry');
   await w.webContents.executeJavaScript('window.browser.navigate("switch",'+JSON.stringify(userTab.id)+')');const beforeRequests=requests.length,beforeReads=catalogReads.length;
   originalAIState=w.aiAgent.state;w.aiAgent.state={...originalAIState,running:true,status:'running'};
   try{
    await engine.runOnce();assert.equal(job.state,'queued');assert.equal(job.blockedReason,'PAGE_BUSY');assert.equal(job.attempts,0);assert.ok(Date.parse(job.retryAt)>Date.now());assert.equal(w.activeTab,userTab.id);assert.equal(catalogReads.length,beforeReads);assert.equal(requests.length,beforeRequests);assert.equal(w.tabs.length,2);assert.equal(await userContents.executeJavaScript('document.querySelector("#user-note").value'),'original user draft preserved');assertNoBusinessMutation();
    return {queued:true,reason:job.blockedReason,additionalNavigations:0,originalTabStillActive:true};
   }finally{w.aiAgent.state=originalAIState;originalAIState=null;}
  });
 }finally{
  if(originalAIState&&w)w.aiAgent.state=originalAIState;
  if(engine&&originalInspect)engine.adapter.inspectCatalog=originalInspect;
  if(engine&&originalDB){engine.db=originalDB;if(profile)engine.accountObservations.delete(profile.id);engine.persist();engine.emit();}
  if(w&&!w.isDestroyed()){w.close();await until(()=>w.isDestroyed());}
  if(session)session.protocol.unhandle('https');
  if(profile)await api.deleteProfile(profile.id);
 }
};
