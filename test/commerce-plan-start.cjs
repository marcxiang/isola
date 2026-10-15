'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const {createLocalProductService,prepareLocalPhotos,restoreLocalProducts}=require('../src/commerce-local-products.cjs');
const listing={title:'Accessoire local confirme',description:'Description exacte confirmee pour la fixture.',categoryPath:['Maison','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',size:'',color:'Noir',parcel:'Moyen'};
const input=(changes={})=>({profileId:'start-profile-1',productId:'start-product-1',sku:'START-1',listingPriceCents:500,minOfferCents:500,targetCount:1,enabled:false,reuseOwnPhotos:true,listing,...changes});
const clone=value=>JSON.parse(JSON.stringify(value));
async function fixture(t,{backgroundEnabled=true,executeJob}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-plan-start-')),profiles=[1,2].map(n=>({id:'start-profile-'+n,name:'Local start fixture '+n,status:'closed'})),executed=[],polled=[],maintained=[];
 const adapter={readiness:()=>({salesOnly:true,capabilities:{publish:true,autoOpenProfile:true,messages:false,offers:false,saleConfirmation:false,procurement:false}}),requireReady:async()=>{},poll:async(profileId,{plans})=>{polled.push({profileId,plans:plans.map(plan=>plan.id)});return [];},maintenance:async({planIds})=>{maintained.push(planIds===null?null:[...planIds]);},executeJob:async context=>{executed.push(context.plan.id);if(executeJob)return executeJob(context);context.plan.activeListingId='fixture-item-'+context.plan.id;context.job.result={externalId:context.plan.activeListingId};}};
 const engine=new CommerceEngine({dir,profiles:()=>profiles,adapter,clientFactory:()=>({me:async()=>({user:{id:'local-start-supplier'}})}),seal:value=>'fixture-sealed:'+value,unseal:value=>value.slice('fixture-sealed:'.length)});
 t.after(async()=>{await engine.close();const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('isola-plan-start-'));fs.rmSync(resolved,{recursive:true,force:true});});
 await engine.saveSettings({baseURL:'https://supplier.invalid/api/v1',token:'local-only-fixture-token',backgroundEnabled,maxConcurrent:2,perOrderLimitCents:0,dailyLimitCents:0});await engine.connect();
 engine.db.products=[1,2].map(n=>({id:'start-product-'+n,sku:'START-'+n,name:'Local product '+n,stock:3,priceCents:100,photoSetsAvailable:1}));
 for(const n of [1,2])engine.bindMarketAccount('start-profile-'+n,{verified:true,memberId:String(100+n),username:'fixture_start_'+n,profileURL:'https://www.vinted.fr/member/'+(100+n),documentKey:'local-start-doc-'+n});
 const add=(changes={})=>engine.savePlan(input(changes));
 const settled=async count=>{const end=Date.now()+2000;while(engine.ticking||executed.length<count){if(Date.now()>end)throw Error('Fixture scheduler did not settle');await new Promise(resolve=>setTimeout(resolve,5));}};
 return {engine,profiles,adapter,executed,polled,maintained,add,settled};
}

test('starting a plan requires explicit background permission and changes no saved plan on rejection',async t=>{
 const f=await fixture(t,{backgroundEnabled:false}),plan=f.add(),before=fs.readFileSync(f.engine.file,'utf8');
 assert.throws(()=>f.engine.startPlan(plan.id),{code:'BACKGROUND_NOT_ALLOWED'});assert.equal(plan.enabled,false);assert.equal(f.engine.running,false);assert.equal(f.engine.timer,null);assert.deepEqual(f.executed,[]);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);
 assert.throws(()=>f.engine.saveAndStartPlan(input({profileId:'start-profile-2'})),{code:'BACKGROUND_NOT_ALLOWED'});assert.equal(f.engine.db.plans.length,1);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);
});

test('starting one plan immediately schedules only that plan and exposes its runtime scope',async t=>{
 const f=await fixture(t),chosen=f.add(),other=f.add({profileId:'start-profile-2',enabled:true});
 const result=f.engine.startPlan(chosen.id);assert.equal(result.started,true);assert.equal(result.plan.enabled,true);assert.deepEqual(result.state.runningPlanIds,[chosen.id]);await f.settled(1);
 assert.deepEqual(f.executed,[chosen.id]);assert.equal(chosen.enabled,true);assert.equal(other.enabled,true);assert.equal(f.engine.db.jobs.some(job=>job.planId===other.id),false);assert.ok(f.polled.every(row=>row.plans.every(id=>id===chosen.id)));assert.ok(f.maintained.every(ids=>ids.length===1&&ids[0]===chosen.id));assert.deepEqual(f.engine.state().runningPlanIds,[chosen.id]);
 const outside=f.engine.enqueue('listing',other,{cycle:0,listingRevision:0},'listing:'+other.id+':0');assert.equal(f.engine.queueHealth().jobs.find(row=>row.jobId===outside.id).reasonCode,'PLAN_NOT_STARTED');assert.equal(await f.engine.runJob(outside),false);assert.deepEqual(f.executed,[chosen.id]);
});

test('explicit starts append to the scope without duplicate jobs while a global start still includes all enabled plans',async t=>{
 const f=await fixture(t),first=f.add(),second=f.add({profileId:'start-profile-2'});
 f.engine.startPlan(first.id);f.engine.startPlan(first.id);f.engine.startPlan(second.id);await f.settled(2);assert.deepEqual(new Set(f.executed),new Set([first.id,second.id]));assert.equal(f.executed.length,2);assert.equal(f.engine.db.jobs.length,2);assert.deepEqual(new Set(f.engine.state().runningPlanIds),new Set([first.id,second.id]));
 f.engine.setRunning(false);assert.deepEqual(f.engine.state().runningPlanIds,[]);
 const third=f.add({productId:'start-product-2',sku:'START-2',enabled:true});f.engine.setRunning(true);assert.equal(f.engine.state().runningPlanIds,null);await f.settled(3);assert.equal(f.executed.at(-1),third.id);assert.ok(f.maintained.includes(null));
});

test('saving and starting a new plan commits its complete snapshot and starts without a separate runner action',async t=>{
 const f=await fixture(t),result=f.engine.saveAndStartPlan(input());assert.equal(result.started,true);assert.equal(result.plan.enabled,true);assert.equal(f.engine.db.plans.length,1);assert.equal(result.state.running,true);await f.settled(1);assert.deepEqual(f.executed,[result.plan.id]);assert.deepEqual(f.engine.db.plans[0].listing,listing);
});

test('plain plan save and enable remain silent CRUD and do not create a timer or job',async t=>{
 const f=await fixture(t),plan=f.add({enabled:true});f.engine.setPlanEnabled(plan.id,false);f.engine.setPlanEnabled(plan.id,true);await new Promise(resolve=>setTimeout(resolve,15));assert.equal(f.engine.running,false);assert.equal(f.engine.timer,null);assert.equal(f.engine.db.jobs.length,0);assert.deepEqual(f.executed,[]);
});

test('missing fields, supplier identity, account binding, stock and capabilities fail before enabling or saving',async t=>{
 const scenarios=[
  [f=>f.engine.db.marketAccounts=[], 'ACCOUNT_NOT_BOUND'],
  [f=>f.engine.db.encryptedToken='', 'SUPPLIER_NOT_CONNECTED'],
  [f=>f.engine.db.supplierAccountId=null, 'SUPPLIER_NOT_CONNECTED'],
  [f=>f.engine.db.products[0].stock=0, 'NO_STOCK'],
  [f=>f.engine.db.products[0].sku='CHANGED', 'PRODUCT_MISMATCH'],
  [f=>f.adapter.readiness=()=>({capabilities:{publish:false}}), 'CAPABILITY_UNVERIFIED'],
  [(_f,plan)=>plan.listing={...listing,title:''}, 'LISTING_INCOMPLETE'],
  [(_f,plan)=>plan.listing={...listing,parcel:'Unconfirmed'}, 'LISTING_INCOMPLETE']
 ];
 for(const [change,code] of scenarios){const f=await fixture(t),plan=f.add();change(f,plan);const before=clone(f.engine.db);assert.throws(()=>f.engine.startPlan(plan.id),{code});assert.equal(plan.enabled,false);assert.equal(f.engine.running,false);assert.deepEqual(f.engine.db,before);assert.deepEqual(f.executed,[]);}
});

test('starting cannot bypass manual account stops, unknown operations or an explicitly cancelled original task',async t=>{
 for(const kind of ['manual','unknown','cancelled']){
  const f=await fixture(t),plan=f.add();f.engine.setPlanEnabled(plan.id,true);f.engine.seed();f.engine.setPlanEnabled(plan.id,false);const job=f.engine.db.jobs[0];
  if(kind==='manual')Object.assign(job,{state:'needs_review',blockedReason:'PROFILE_CLOSED'});else if(kind==='unknown')job.state='uncertain';else job.state='cancelled';
  const before=clone(f.engine.db);assert.throws(()=>f.engine.startPlan(plan.id),{code:kind==='manual'?'PROFILE_MANUALLY_PAUSED':kind==='unknown'?'RECONCILE_REQUIRED':'JOB_REVIEW_REQUIRED'});assert.equal(plan.enabled,false);assert.deepEqual(f.engine.db,before);assert.deepEqual(f.executed,[]);
 }
});

test('save and start rejects incomplete edited data atomically and preserves the original plan snapshot',async t=>{
 const f=await fixture(t),plan=f.add(),before=clone(plan);assert.throws(()=>f.engine.saveAndStartPlan({...plan,listing:{...listing,description:''}}),{code:'LISTING_INCOMPLETE'});assert.deepEqual(plan,before);assert.equal(f.engine.running,false);assert.equal(f.engine.db.jobs.length,0);
});

test('a failed durable start rolls back the enabled state and cannot create a runner timer or external work',async t=>{
 const f=await fixture(t),plan=f.add(),before=clone(plan),originalPersist=f.engine.persist;
 f.engine.db.events=Array.from({length:300},(_,index)=>({kind:'info',time:'2026-10-15T09:00:00.000Z',text:'Original event '+index}));const originalEvents=clone(f.engine.db.events);
 f.engine.persist=()=>{f.engine.faulted=true;f.engine.running=false;throw Error('fixture disk write rejected');};assert.throws(()=>f.engine.startPlan(plan.id),/disk write rejected/);assert.deepEqual(plan,before);assert.deepEqual(f.engine.db.events,originalEvents);assert.equal(f.engine.running,false);assert.equal(f.engine.timer,null);assert.deepEqual(f.executed,[]);f.engine.persist=originalPersist;
});

test('local product plans derive their source from saved catalog data and can start without supplier credentials',async t=>{
 const f=await fixture(t),image=Buffer.from('ffd8ffc00011080002000203011100021100031100ffd9','hex'),file=path.join(f.engine.dir,'local-start-source.jpg');fs.writeFileSync(file,image);
 const service=createLocalProductService({selectFiles:async()=>[file],normalizeImage:async bytes=>({bytes,width:2,height:2})});
 const selected=await service.importPhotos(f.engine),saved=service.saveManualProduct(f.engine,{name:'My own local fixture product',stock:1,listing,listingPriceCents:500,minOfferCents:500,photoToken:selected.photoToken});
 f.engine.db.encryptedToken='';f.engine.db.supplierAccountId=null;f.engine.connection={status:'not_connected'};
 const result=f.engine.saveAndStartPlan(input({productId:saved.product.id,sku:saved.product.sku,source:'supplier'}));assert.equal(result.plan.source,'local');await f.settled(1);assert.deepEqual(f.executed,[result.plan.id]);assert.equal(f.engine.db.publicationSupplierSync.length,0);
});

test('local products without imported photos cannot be enabled and remote products cannot forge a local source',async t=>{
 const f=await fixture(t),service=createLocalProductService({selectFiles:async()=>[],normalizeImage:async()=>{throw Error('No decoding expected');}}),saved=service.saveManualProduct(f.engine,{name:'Local draft without photos',stock:1,listing,listingPriceCents:500,minOfferCents:500});
 const local=f.add({productId:saved.product.id,sku:saved.product.sku,source:'supplier'});assert.equal(local.source,'local');assert.throws(()=>f.engine.startPlan(local.id),{code:'PHOTO_UNVERIFIED'});assert.equal(local.enabled,false);
 const remote=f.add({source:'local'});assert.equal(remote.source,'supplier');f.engine.db.encryptedToken='';assert.throws(()=>f.engine.startPlan(remote.id),{code:'SUPPLIER_NOT_CONNECTED'});assert.equal(remote.enabled,false);assert.deepEqual(f.executed,[]);
});

test('supplier credential resets preserve local product templates and do not treat local history as supplier history',async t=>{
 const f=await fixture(t),service=createLocalProductService({selectFiles:async()=>[],normalizeImage:async()=>{throw Error('No decoding expected');}}),saved=service.saveManualProduct(f.engine,{name:'Independent local fixture',stock:1,listing,listingPriceCents:500,minOfferCents:500});
 f.add({productId:saved.product.id,sku:saved.product.sku});const localBefore=clone(f.engine.db.localProducts),templatesBefore=clone(f.engine.db.productListings);
 await f.engine.saveSettings({baseURL:'https://another-supplier.invalid/api/v1',token:'another-local-fixture-token',backgroundEnabled:true,maxConcurrent:1});assert.deepEqual(f.engine.db.localProducts,localBefore);assert.deepEqual(f.engine.db.productListings,templatesBefore);assert.equal(f.engine.db.products.length,0);assert.equal(f.engine.catalog()[0].source,'local');
});

test('local photo history prevents rebinding a plan before its first scheduler job exists',async t=>{
 const f=await fixture(t),image=Buffer.from('ffd8ffc00011080002000203011100021100031100ffd9','hex'),file=path.join(f.engine.dir,'local-rebind-source.jpg');fs.writeFileSync(file,image);
 const service=createLocalProductService({selectFiles:async()=>[file],normalizeImage:async bytes=>({bytes,width:2,height:2})}),selected=await service.importPhotos(f.engine),saved=service.saveManualProduct(f.engine,{name:'Local product with prepared photos',stock:1,listing,listingPriceCents:500,minOfferCents:500,photoToken:selected.photoToken}),plan=f.add({productId:saved.product.id,sku:saved.product.sku});
 prepareLocalPhotos(f.engine,plan.id);assert.equal(f.engine.db.jobs.length,0);assert.equal(f.engine.db.localPhotoPreparations.length,1);const before=clone(f.engine.db);
 assert.throws(()=>f.engine.savePlan({...plan,profileId:'start-profile-2'}),/不能更换窗口或 SKU/);assert.throws(()=>f.engine.savePlan({...plan,productId:'start-product-1',sku:'START-1'}),/不能更换 SKU|不能更换窗口或 SKU/);assert.deepEqual(f.engine.db,before);assert.doesNotThrow(()=>restoreLocalProducts(clone(f.engine.db)));assert.deepEqual(f.executed,[]);
});
