'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const clone=value=>JSON.parse(JSON.stringify(value));
const listing={title:'Archived IPC fixture item',description:'An isolated item for archive lifecycle checks only.',categoryPath:['Maison','Accessoires'],condition:'Très bon état',brand:'Sans marque',color:'Noir',parcel:'Moyen'};

// Real commerce IPC with an isolated engine graph. Every provider and browser
// request is denied locally; this module never starts a runner or clicks a page.
module.exports=async function commercePlanArchiveMainSmoke(api,check){
 assert.ok(process.env.ISOLA_TEST_DATA,'Plan archive IPC smoke requires isolated test data');assert.equal(path.resolve(path.dirname(api.dataFile())),path.resolve(process.env.ISOLA_TEST_DATA));
 const engine=api.getCommerce();assert.equal(engine.running,false);assert.equal(engine.ticking,false);assert.equal(engine.active.size,0);
 const original={db:engine.db,connection:engine.connection,clientFactory:engine.clientFactory,adapter:engine.adapter},calls=[];let profile,session,view,product,draft,plan,job,originalJob;
 const invoke=(method,...args)=>view.webContents.executeJavaScript(`window.commerce[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
 const input=(changes={})=>({profileId:profile.id,productId:product.id,sku:product.sku,listing,listingPriceCents:600,minOfferCents:500,targetCount:2,enabled:false,...changes});
 const idle=()=>{assert.equal(engine.running,false);assert.equal(engine.ticking,false);assert.equal(engine.active.size,0);assert.equal(engine.timer,null);assert.deepEqual(engine.state().runningPlanIds,[]);assert.deepEqual(calls,[]);assert.equal(api.windows.has(profile.id),false);};
 const snapshot=()=>({db:clone(engine.db),disk:fs.readFileSync(engine.file,'utf8')});
 const unchanged=before=>{assert.deepEqual(engine.db,before.db);assert.equal(fs.readFileSync(engine.file,'utf8'),before.disk);idle();};
 const rejected=async(method,...args)=>{const before=snapshot();await assert.rejects(invoke(method,...args),/已删除并归档/);unchanged(before);};
 try{
  engine.db=clone(original.db);for(const key of ['products','productListings','localProducts','localPhotoPreparations','photoSets','photoPreparations','plans','planArchives','jobs','claims','sales','reservations','publicationSupplierSync','marketAccounts'])engine.db[key]=[];engine.db.publications={version:1,submissions:[]};engine.db.encryptedToken='';engine.db.supplierAccountId=null;engine.db.settings.backgroundEnabled=false;engine.connection={status:'not_connected'};
  engine.clientFactory=()=>{calls.push('supplier');throw Error('Archive fixture forbids provider requests');};engine.adapter=new Proxy(original.adapter,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);return typeof value==='function'&&key!=='readiness'?(..._args)=>{calls.push(String(key));throw Error('Archive fixture forbids browser adapter operations');}:value;}});engine.persist();engine.emit();
  profile=api.saveProfile({name:'QA archive lifecycle IPC',windowType:'automation',fingerprintMode:'native',url:'https://www.vinted.fr/items/new'});session=api.sesFor(profile);const deny=request=>{calls.push('network:'+request.method);return new Response('Archive fixture forwards no network traffic',{status:403});};session.protocol.handle('https',deny);session.protocol.handle('http',deny);
  await api.openCommerce('plans');view=api.getCommerceView();product=(await invoke('saveManualProduct',{name:'Archive IPC independent local item',stock:2,listing,listingPriceCents:600,minOfferCents:500})).product;
  await check('real IPC physically deletes an empty plan and cannot restore a nonexistent draft',async()=>{
   draft=await invoke('savePlan',input());assert.deepEqual(await invoke('deletePlan',draft.id),{deleted:true,id:draft.id});assert.equal(engine.db.plans.some(row=>row.id===draft.id),false);assert.equal(engine.db.planArchives.some(row=>row.planId===draft.id),false);const before=snapshot();await assert.rejects(invoke('restorePlan',draft.id),/不存在/);unchanged(before);return {physicalDraftDeletion:true,missingRestoreRejected:true,runnerStarted:false};
  });
  await check('deleting a queued plan archives its original ID and cancels the same job without erasing dedupe or payload',async()=>{
   plan=await invoke('savePlan',input({enabled:true}));const beforePlan=clone(engine.db.plans.find(row=>row.id===plan.id));job=engine.enqueue('listing',engine.plan(plan.id),{cycle:0,listingRevision:0},'listing:'+plan.id+':0');originalJob=clone(job);
   assert.deepEqual(await invoke('deletePlan',plan.id),{deleted:true,id:plan.id,archived:true});const stored=engine.db.plans.find(row=>row.id===plan.id),archivedJob=engine.db.jobs.find(row=>row.id===job.id);assert.equal(stored.enabled,false);assert.equal(stored.status,'paused');for(const key of ['id','profileId','productId','sku','listing','listingPriceCents','minOfferCents','createdAt'])assert.deepEqual(stored[key],beforePlan[key]);
   assert.equal(archivedJob.state,'cancelled');assert.equal(archivedJob.blockedReason,'PLAN_ARCHIVED');for(const key of ['id','planId','profileId','productId','dedupeKey','payload','operation','mutationPending','result','createdAt'])assert.deepEqual(archivedJob[key],originalJob[key]);assert.equal(engine.db.jobs.length,1);assert.equal(engine.db.planArchives.length,1);assert.equal(engine.db.planArchives[0].planId,plan.id);idle();return {archivedPlanId:plan.id,originalJobPreserved:true,originalDedupePreserved:true,queuedJobCancelled:true};
  });
  await check('real state DTO retains the archived plan and original cancelled task while disabling retry',async()=>{
   const state=await invoke('state'),saved=state.plans.find(row=>row.id===plan.id),task=state.jobs.find(row=>row.id===job.id);assert.equal(saved.archived,true);assert.equal(saved.archivedAt,engine.db.planArchives[0].archivedAt);assert.equal(saved.enabled,false);assert.equal(saved.profileId,profile.id);assert.equal(saved.productId,product.id);assert.equal(saved.sku,product.sku);assert.equal(task.dedupeKey,originalJob.dedupeKey);assert.equal(task.state,'cancelled');assert.equal(task.canRetry,false);assert.equal(Object.hasOwn(task,'payload'),false);assert.deepEqual(state.runningPlanIds,[]);const disk=JSON.parse(fs.readFileSync(engine.file,'utf8'));assert.deepEqual(disk.planArchives,engine.db.planArchives);assert.equal(disk.jobs[0].id,originalJob.id);assert.equal(disk.jobs[0].dedupeKey,originalJob.dedupeKey);idle();return {archivedDTO:true,originalTaskVisible:true,retryEnabled:false,persisted:true};
  });
  await check('archived plans reject old start, save, enable, resolution and manual publication IPC paths before any external call',async()=>{
   await rejected('startPlan',plan.id);await rejected('savePlan',input({id:plan.id,listingPriceCents:700}));await rejected('saveAndStartPlan',input({id:plan.id,enabled:true}));await rejected('savePlan',input());await rejected('saveAndStartPlan',input({enabled:true}));await rejected('setPlanEnabled',plan.id,true);
   for(const action of ['retry','cancel','reconcile'])await rejected('resolve',job.id,action,{});
   for(const method of ['openListing','openActiveListing','inspectAccount','preflight','prepareDraft','inspectPhotos','preparePhotos','photoPreview','uploadPhotos','submitPublication','inspectPublishedListing'])await rejected(method,plan.id);
   const before=snapshot(),report=await invoke('inspectPublication',plan.id);assert.equal(report.readyForPublication,false);assert.ok(report.blockers.some(text=>/已删除并归档/.test(text)));unchanged(before);assert.equal(engine.db.plans.length,1);assert.equal(engine.db.jobs.length,1);return {realIPCGuarded:true,newPlanIdBypassRejected:true,resolutionsBlocked:3,manualExternalCalls:0};
  });
  await check('restoring through real IPC keeps the original plan disabled and its cancelled job unchanged without rescheduling',async()=>{
   const beforeJob=clone(engine.db.jobs[0]);assert.deepEqual(await invoke('restorePlan',plan.id),{restored:true,id:plan.id});const state=await invoke('state'),restored=state.plans.find(row=>row.id===plan.id);assert.equal(restored.archived,false);assert.equal(restored.archivedAt,null);assert.equal(restored.enabled,false);assert.equal(restored.status,'paused');assert.equal(restored.id,plan.id);assert.deepEqual(restored.listing,engine.db.plans[0].listing);assert.deepEqual(engine.db.jobs,[beforeJob]);assert.deepEqual(engine.db.planArchives,[]);assert.equal(state.jobs[0].dedupeKey,originalJob.dedupeKey);assert.equal(state.jobs[0].state,'cancelled');assert.equal(state.jobs[0].canRetry,true);
   const before=snapshot();await assert.rejects(invoke('restorePlan',plan.id),/不在已删除记录/);unchanged(before);const disk=JSON.parse(fs.readFileSync(engine.file,'utf8'));assert.equal(disk.plans[0].enabled,false);assert.equal(disk.jobs[0].id,originalJob.id);assert.equal(disk.jobs[0].dedupeKey,originalJob.dedupeKey);return {restoredSamePlan:true,enabled:false,sameCancelledJob:true,newJobs:0,externalOperations:0};
  });
 }finally{
  const w=profile&&api.windows.get(profile.id);if(w&&!w.isDestroyed()){w.close();const end=Date.now()+8000;while(!w.isDestroyed()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,25));assert.equal(w.isDestroyed(),true,'Unexpected fixture browser must close before cleanup');}
  if(session){session.protocol.unhandle('https');session.protocol.unhandle('http');}
  engine.db=original.db;engine.connection=original.connection;engine.clientFactory=original.clientFactory;engine.adapter=original.adapter;engine.persist();engine.emit();if(profile&&!api.windows.has(profile.id))await api.deleteProfile(profile.id);
 }
};
