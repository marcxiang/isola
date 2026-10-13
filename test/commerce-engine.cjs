const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CommerceEngine,validatePlan,normalizeProduct}=require('../src/commerce-engine.cjs');

const profiles=[{id:'profile-1',name:'Test account 1'},{id:'profile-2',name:'Test account 2'}];
const rawProduct={id:'product-1',sku:'SKU-1',name:'Test garment',stock:12,unitPriceCents:1000,revision:7};
const planInput=(overrides={})=>({profileId:'profile-1',productId:'product-1',listingPriceCents:2500,minOfferCents:1800,targetCount:2,enabled:true,autoReply:true,autoAcceptOffers:true,reuseOwnPhotos:true,...overrides});
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};

async function fixture(t,{client:clientOverrides={},adapter:adapterOverrides={},settings={},plan={}}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-commerce-test-')),calls=[],counts={listing:0,claim:0,order:0};
  const record=(name,args)=>calls.push({name,args});
  const client={
    me:async()=>({user:{id:'supplier-1',username:'test-supplier'},scopes:['catalog:read','orders:create']}),
    product:async id=>{record('product',id);return {...rawProduct,id,sku:id==='product-1'?'SKU-1':'SKU-2'};},
    claimPhotos:async(payload,options)=>{record('claimPhotos',{payload,options});return {claimId:'claim-'+(++counts.claim),set:{id:'set-'+counts.claim,images:[{id:'image-'+counts.claim,url:'https://example.invalid/photo.jpg'}]}};},
    markListed:async(...args)=>{record('markListed',args);return {ok:true};},
    checkout:async(payload,options)=>{record('checkout',{payload,options});return {warehouses:[{code:'WH-1',canFulfill:true}],recommendedWarehouse:'WH-1',confirmationKey:'checkout-test-1'};},
    createOrder:async(payload,options)=>{record('createOrder',{payload,options});const id=++counts.order;return {id:'supplier-order-'+id,orderId:'wms-'+id,wmsStatus:'submitted'};},
    order:async id=>({order:{id}}),wmsOrder:async id=>({order:{id,status:'submitted'}}),
    ...clientOverrides
  };
  const adapter={
    readiness:()=>({vinted:'test_fixture_only'}),requireReady:async()=>{},poll:async()=>[],
    findListing:async()=>({exists:false}),
    prepareListing:async(p,{claim})=>({productId:p.productId,priceCents:p.listingPriceCents,currency:'EUR',imageCount:claim.images.length,imagesVerified:true,claimId:claim.id,imageIds:claim.images.map(i=>i.id)}),
    publishListing:async(p,draft)=>{record('publishListing',{plan:p.id,draft});return {verified:true,listingId:'listing-'+(++counts.listing),url:'https://www.vinted.fr/items/'+counts.listing,priceCents:p.listingPriceCents};},
    readMessage:async event=>({...event}),draftReply:async()=>({text:'La taille indiquée est M.',factual:true,requiresReview:false}),
    sendReply:async(message,draft)=>{record('sendReply',{message,draft});return {verified:true,messageId:'reply-1'};},
    readOffer:async event=>({...event,status:'pending'}),
    acceptOffer:async offer=>{record('acceptOffer',offer);return {verified:true,priceCents:offer.priceCents};},
    readSale:async event=>({...event}),
    shippingLabel:async sale=>({verified:true,orderId:sale.id,buyerUsername:sale.buyerUsername,data:Buffer.from('%PDF-1.4\nTEST LABEL\n%%EOF'),contentType:'application/pdf',pages:1}),
    purchaseQuote:async()=>({verified:true,currency:'EUR',totalCents:1200,productRevision:7}),
    ...adapterOverrides
  };
  const options={dir,profiles:()=>profiles,clientFactory:()=>client,adapter,seal:value=>Buffer.from(value).toString('base64'),unseal:value=>Buffer.from(value,'base64').toString('utf8')};
  const engine=new CommerceEngine(options);
  t.after(async()=>{await engine.close();fs.rmSync(dir,{recursive:true,force:true});});
  await engine.saveSettings({baseURL:'https://sku.meetist.fr/api/v1',token:'TEST-ONLY-TOKEN',maxConcurrent:2,perOrderLimitCents:2000,dailyLimitCents:10000,fulfillmentMethod:'wms',...settings});
  engine.db.products=[normalizeProduct(rawProduct),normalizeProduct({...rawProduct,id:'product-2',sku:'SKU-2'})];engine.persist();
  const savedPlan=plan===false?null:engine.savePlan(planInput(plan));
  const listed=async(p=savedPlan)=>{p.activeListingId='existing-'+p.id;p.status='listed';engine.persist();return p;};
  const sale=(p=savedPlan,overrides={})=>({verified:true,type:'sale',id:'sale-'+p.id,profileId:p.profileId,listingId:p.activeListingId,paid:true,currency:'EUR',priceCents:2000,quantity:1,buyerUsername:'test-buyer',...overrides});
  return {dir,engine,client,adapter,calls,counts,options,plan:savedPlan,listed,sale};
}

test('commerce plans require integer cents and a minimum at or below the listing price',()=>{
  const context={profiles,products:[normalizeProduct(rawProduct)]};
  for(const change of [{listingPriceCents:10.99},{minOfferCents:-1},{minOfferCents:2501},{listingPriceCents:0},{targetCount:1.5},{currency:'USD'}])assert.throws(()=>validatePlan(planInput(change),context));
  const plan=validatePlan(planInput(),context);assert.equal(plan.listingPriceCents,2500);assert.equal(plan.minOfferCents,1800);
});

test('a plan with activity cannot be rebound to another product or browser account',async t=>{
  const {engine,plan}=await fixture(t);const job=engine.enqueue('listing',plan,{},'test-completed');job.state='completed';engine.persist();
  assert.throws(()=>engine.savePlan({...plan,productId:'product-2'}));assert.throws(()=>engine.savePlan({...plan,profileId:'profile-2'}));
  assert.equal(engine.plan(plan.id).productId,'product-1');assert.equal(engine.plan(plan.id).profileId,'profile-1');
});

test('one active listing is retained, own photos are reused, and the sales target stops relisting',async t=>{
  const f=await fixture(t);await f.engine.runOnce();assert.equal(f.counts.listing,1);assert.ok(f.plan.activeListingId);await f.engine.runOnce();assert.equal(f.counts.listing,1);
  f.engine.ingestEvent(f.plan.id,f.sale(f.plan,{id:'paid-sale-1'}));await f.engine.runOnce();assert.equal(f.counts.order,1);await f.engine.runOnce();assert.equal(f.counts.listing,2);assert.equal(f.counts.claim,1);
  f.engine.ingestEvent(f.plan.id,f.sale(f.plan,{id:'paid-sale-2'}));await f.engine.runOnce();await f.engine.runOnce();assert.equal(f.counts.order,2);assert.equal(f.counts.listing,2);assert.equal(f.plan.completedCount,2);
});

test('repeated delivery of the same paid sale maps to one job and one sales increment',async t=>{
  const f=await fixture(t);await f.listed();const event=f.sale();const first=f.engine.ingestEvent(f.plan.id,event),second=f.engine.ingestEvent(f.plan.id,{...event});assert.equal(second.id,first.id);assert.equal(f.engine.db.sales.length,1);assert.equal(f.plan.completedCount,1);await f.engine.runOnce();assert.equal(f.counts.order,1);
});

test('conflicting data for a previously recorded sale cannot replace its buyer, item or amount',async t=>{
  const f=await fixture(t);await f.listed();const event=f.sale(),job=f.engine.ingestEvent(f.plan.id,event);for(const change of [{buyerUsername:'another-buyer'},{priceCents:2300},{listingId:'another-item'},{paid:false}])assert.throws(()=>f.engine.ingestEvent(f.plan.id,{...event,...change}));assert.equal(job.payload.buyerUsername,'test-buyer');assert.equal(job.payload.priceCents,2000);assert.equal(f.plan.completedCount,1);
});

test('unpaid, bundled, under-minimum and mismatched-account sale events cannot procure inventory',async t=>{
  const f=await fixture(t);await f.listed();for(const change of [{paid:false},{quantity:2},{priceCents:1799},{profileId:'profile-2'},{verified:false},{currency:'USD'}])assert.throws(()=>f.engine.ingestEvent(f.plan.id,f.sale(f.plan,change)));assert.equal(f.engine.db.jobs.length,0);assert.equal(f.counts.order,0);
});

test('an offer below the configured minimum is never accepted',async t=>{
  const f=await fixture(t);await f.listed();const job=f.engine.ingestEvent(f.plan.id,f.sale(f.plan,{type:'offer',id:'offer-low',priceCents:1799}));await f.engine.runOnce();assert.equal(job.state,'completed');assert.equal(f.calls.filter(c=>c.name==='acceptOffer').length,0);assert.equal(f.counts.order,0);
});

test('an acceptable offer is accepted without creating a supplier order before payment',async t=>{
  const f=await fixture(t);await f.listed();const job=f.engine.ingestEvent(f.plan.id,f.sale(f.plan,{type:'offer',id:'offer-good',priceCents:1800}));await f.engine.runOnce();assert.equal(job.state,'completed');assert.equal(f.calls.filter(c=>c.name==='acceptOffer').length,1);assert.equal(f.counts.order,0);assert.equal(f.plan.completedCount,0);assert.ok(f.plan.activeListingId);
});

test('a quotation above the displayed item price is stopped for review',async t=>{
  const f=await fixture(t);await f.listed();const job=f.engine.ingestEvent(f.plan.id,f.sale(f.plan,{type:'offer',id:'offer-total-misread',priceCents:2800}));await f.engine.runOnce();assert.equal(job.state,'needs_review');assert.equal(f.calls.filter(c=>c.name==='acceptOffer').length,0);
});

test('a supplier write with an unknown result is retained and never automatically replayed',async t=>{
  let attempts=0;const f=await fixture(t,{client:{createOrder:async()=>{attempts++;const error=Error('Connection lost after upload');error.ambiguous=true;throw error;}}});await f.listed();const job=f.engine.ingestEvent(f.plan.id,f.sale());await f.engine.runOnce();assert.equal(job.state,'uncertain');assert.equal(attempts,1);await f.engine.runOnce();assert.equal(attempts,1);assert.equal(job.mutationPending,true);
});

test('restart quarantines an interrupted mutation even after its response was recorded',async t=>{
  const f=await fixture(t);const job=f.engine.enqueue('message',f.plan,{},'crash-message');job.state='running';job.operation={kind:'reply',idempotencyKey:'same-write',fingerprint:'request-digest',receipt:{verified:true,messageId:'already-sent'}};job.mutationPending=false;f.engine.persist();
  const recovered=new CommerceEngine(f.options);try{assert.equal(recovered.db.jobs.find(j=>j.id===job.id).state,'uncertain');await recovered.runOnce();assert.equal(f.calls.filter(c=>c.name==='sendReply').length,0);}finally{await recovered.close();}
});

test('a recorded operation cannot be replayed with a different body under the same idempotency key',async t=>{
  const f=await fixture(t);const job=f.engine.enqueue('message',f.plan,{},'request-identity');let count=0;await f.engine.external(job,'reply',{text:'first'},async()=>{count++;return {messageId:'reply-original'};});const repeat=await f.engine.external(job,'reply',{text:'first'},async()=>{count++;return {messageId:'unexpected'};});assert.equal(repeat.messageId,'reply-original');assert.equal(count,1);await assert.rejects(f.engine.external(job,'reply',{text:'different'},async()=>{count++;return {messageId:'wrong'};}));assert.equal(count,1);
});

test('concurrent accounts reserve the all-in daily budget before any supplier write',async t=>{
  const f=await fixture(t,{settings:{dailyLimitCents:2000,perOrderLimitCents:1500}}),other=f.engine.savePlan(planInput({profileId:'profile-2'}));await f.listed();await f.listed(other);const a=f.engine.ingestEvent(f.plan.id,f.sale()),b=f.engine.ingestEvent(other.id,f.sale(other));await f.engine.runOnce();assert.equal(f.counts.order,1);assert.deepEqual([a.state,b.state].sort(),['completed','needs_review']);assert.equal(f.engine.db.reservations.reduce((sum,r)=>sum+r.cents,0),1200);
});

test('stopping during a prepared listing prevents publication after the awaited work finishes',async t=>{
  const entered=deferred(),release=deferred();const f=await fixture(t,{adapter:{prepareListing:async(p,{claim})=>{entered.resolve();await release.promise;return {productId:p.productId,priceCents:p.listingPriceCents,currency:'EUR',imageCount:claim.images.length,imagesVerified:true,claimId:claim.id,imageIds:claim.images.map(i=>i.id)};}}});const running=f.engine.runOnce();await entered.promise;f.engine.setRunning(false);release.resolve();await running;assert.equal(f.counts.listing,0);assert.equal(f.engine.active.size,0);
});

test('a missing or unverified all-in purchase quote stops before reserving or ordering',async t=>{
  for(const quote of [null,{verified:false,currency:'EUR',totalCents:1200,productRevision:7},{verified:true,currency:'USD',totalCents:1200,productRevision:7},{verified:true,currency:'EUR',totalCents:12.5,productRevision:7}]){
    const f=await fixture(t,{adapter:{purchaseQuote:async()=>quote}});await f.listed();const job=f.engine.ingestEvent(f.plan.id,f.sale());await f.engine.runOnce();assert.equal(job.state,'needs_review');assert.equal(f.counts.order,0);assert.equal(f.engine.db.reservations.length,0);
  }
});

test('the all-in quote including fulfillment charges, rather than the unit price, controls the limit',async t=>{
  const f=await fixture(t,{settings:{perOrderLimitCents:1100}});await f.listed();const job=f.engine.ingestEvent(f.plan.id,f.sale());await f.engine.runOnce();assert.equal(job.state,'needs_review');assert.equal(f.counts.order,0);assert.equal(f.engine.db.reservations.length,0);
});

test('an unverified WMS response preserves the original supplier id without submitting again',async t=>{
  let attempts=0;const f=await fixture(t,{client:{createOrder:async()=>{attempts++;return {id:'supplier-unknown',orderId:'wms-unknown',wmsStatus:'uncertain'};}}});await f.listed();const job=f.engine.ingestEvent(f.plan.id,f.sale());await f.engine.runOnce();assert.equal(job.state,'uncertain');assert.equal(job.result.externalId,'supplier-unknown');await f.engine.runOnce();assert.equal(attempts,1);
});

test('supplier endpoints cannot be swapped underneath existing plans and photo history',async t=>{
  const f=await fixture(t);await assert.rejects(async()=>f.engine.saveSettings({baseURL:'https://different.example/api/v1',maxConcurrent:2,perOrderLimitCents:2000,dailyLimitCents:10000}));assert.equal(f.engine.db.settings.baseURL,'https://sku.meetist.fr/api/v1');
});

test('only one queued task per browser account starts in a scheduling cycle',async t=>{
  const f=await fixture(t);f.engine.savePlan(planInput({productId:'product-2'}));await f.engine.runOnce();assert.equal(f.counts.listing,1);assert.equal(f.engine.db.jobs.filter(j=>j.state==='queued').length,1);await f.engine.runOnce();assert.equal(f.counts.listing,2);
});

test('a storage failure while starting a job releases the account lock and prevents all external writes',async t=>{
  const f=await fixture(t);f.engine.enqueue('listing',f.plan,{cycle:0},'listing:'+f.plan.id+':0');const persist=f.engine.persist;
  f.engine.persist=function(){if(this.db.jobs.some(j=>j.state==='running')){this.faulted=true;throw Error('Simulated full disk');}return persist.call(this);};
  try{await f.engine.runOnce();assert.equal(f.engine.faulted,true);assert.equal(f.engine.active.size,0);assert.equal(f.counts.claim,0);assert.equal(f.counts.listing,0);assert.equal(f.counts.order,0);}finally{f.engine.persist=persist;f.engine.faulted=false;}
});

test('a starting or storage-locked browser account cannot acquire a new sales plan',()=>{
  assert.throws(()=>validatePlan(planInput(),{profiles:[{id:'profile-1',status:'starting'}],products:[normalizeProduct(rawProduct)]}),/启动或清理/);
});

test('stopping during an in-flight poll prevents the old cycle from seeding or starting any work',async t=>{
  const entered=deferred(),response=deferred();let pollSignal;
  const f=await fixture(t,{adapter:{poll:async(id,{signal})=>{pollSignal=signal;entered.resolve();return response.promise;}}});f.engine.running=true;const cycle=f.engine.runOnce();await entered.promise;f.engine.setRunning(false);await cycle;assert.equal(pollSignal.aborted,true);assert.equal(f.engine.db.jobs.length,0);assert.equal(f.counts.listing,0);
  response.resolve([]);await Promise.resolve();assert.equal(f.engine.db.jobs.length,0);await f.engine.runOnce();assert.equal(f.counts.listing,1);assert.equal(f.engine.running,false);
});

test('closing waits for the polling cycle to settle and discards a late result even if the adapter ignores abort',async t=>{
  const entered=deferred(),response=deferred();const f=await fixture(t,{adapter:{poll:async()=>{entered.resolve();return response.promise;}}});f.engine.running=true;const cycle=f.engine.runOnce();await entered.promise;
  let timer;try{await Promise.race([f.engine.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Close remained stuck on a cancelled poll')),1500);})]);}finally{clearTimeout(timer);}await cycle;assert.equal(f.engine.ticking,false);assert.equal(f.engine.active.size,0);assert.equal(f.engine.db.jobs.length,0);response.resolve([]);await Promise.resolve();await assert.rejects(f.engine.runOnce(),e=>e.code==='STOPPED');assert.equal(f.counts.listing,0);
});

test('connection verification and a later endpoint change are serialized and clear the previous supplier catalog',async t=>{
  const entered=deferred(),response=deferred();const f=await fixture(t,{plan:false,client:{me:async()=>{entered.resolve();return response.promise;}}});f.engine.db.supplierAccountId='supplier-old';f.engine.db.photoSets=[{id:'old-photo-set'}];f.engine.persist();const connection=f.engine.connect();await entered.promise;
  const settings=f.engine.saveSettings({baseURL:'https://new-supplier.example/api/v1',token:'NEW-TOKEN',maxConcurrent:2,perOrderLimitCents:2000,dailyLimitCents:10000});assert.throws(()=>f.engine.setRunning(true),/配置正在更新/);await assert.rejects(f.engine.runOnce(),/配置正在更新/);assert.throws(()=>f.engine.savePlan(planInput()),/配置正在更新/);
  response.resolve({user:{id:'supplier-old',username:'Old supplier'}});await connection;await settings;assert.equal(f.engine.db.settings.baseURL,'https://new-supplier.example/api/v1');assert.equal(f.engine.db.supplierAccountId,null);assert.equal(f.engine.db.products.length,0);assert.equal(f.engine.db.photoSets.length,0);assert.equal(f.engine.connection.status,'not_connected');assert.equal(f.engine.state().configBusy,false);
});

test('an old catalog synchronization cannot overwrite the catalog after a queued credential change',async t=>{
  const entered=deferred(),response=deferred();let readSignal;
  const f=await fixture(t,{plan:false,client:{products:async(query,{signal})=>{readSignal=signal;entered.resolve();return response.promise;},photoSets:async()=>({sets:[{id:'old-set',productId:'old-product',images:[]}],total:1})}});f.engine.db.supplierAccountId='supplier-old';const syncing=f.engine.sync();await entered.promise;const change=f.engine.saveSettings({token:'ACCOUNT-B-TOKEN',maxConcurrent:2,perOrderLimitCents:2000,dailyLimitCents:10000});assert.ok(readSignal instanceof AbortSignal);response.resolve({products:[{...rawProduct,id:'old-product',sku:'OLD'}],total:1});await syncing;await change;assert.equal(f.engine.db.products.length,0);assert.equal(f.engine.db.photoSets.length,0);assert.equal(f.engine.db.supplierAccountId,null);assert.equal(f.engine.unseal(f.engine.db.encryptedToken),'ACCOUNT-B-TOKEN');
});

test('concurrent same-account key rotations validate and commit in request order',async t=>{
  const entered=deferred(),release=deferred(),keys=[];const f=await fixture(t);await f.engine.connect();f.engine.clientFactory=({token})=>({...f.client,me:async()=>{keys.push(token);if(token==='ROTATION-A'){entered.resolve();await release.promise;}return {user:{id:'supplier-1'}};}});
  const first=f.engine.saveSettings({token:'ROTATION-A',maxConcurrent:2,perOrderLimitCents:1200,dailyLimitCents:4000});await entered.promise;const second=f.engine.saveSettings({token:'ROTATION-B',maxConcurrent:3,perOrderLimitCents:1300,dailyLimitCents:5000});release.resolve();await Promise.all([first,second]);assert.deepEqual(keys,['ROTATION-A','ROTATION-B']);assert.equal(f.engine.unseal(f.engine.db.encryptedToken),'ROTATION-B');assert.equal(f.engine.db.settings.perOrderLimitCents,1300);assert.equal(f.engine.db.settings.maxConcurrent,3);assert.equal(f.engine.db.supplierAccountId,'supplier-1');
});

test('closing aborts a read-only connection check and prevents its late account data from committing',async t=>{
  const entered=deferred(),response=deferred();let readSignal;const f=await fixture(t,{plan:false,client:{me:async({signal})=>{readSignal=signal;entered.resolve();return response.promise;}}});const connecting=f.engine.connect().catch(error=>error);await entered.promise;await f.engine.close();assert.equal(readSignal.aborted,true);const error=await connecting;assert.equal(error.code,'STOPPED');const saved=JSON.parse(fs.readFileSync(f.engine.file,'utf8'));response.resolve({user:{id:'unexpected-late-account'}});await Promise.resolve();await Promise.resolve();assert.equal(f.engine.db.supplierAccountId,saved.supplierAccountId);assert.notEqual(f.engine.connection.status,'connected');assert.equal(f.engine.state().configBusy,false);
});

test('connecting a different account with no business history invalidates all cached products and photo sets',async t=>{
  const f=await fixture(t,{plan:false,client:{me:async()=>({user:{id:'supplier-new'}})}});f.engine.db.supplierAccountId='supplier-old';f.engine.db.photoSets=[{id:'old-private-set'}];await f.engine.connect();assert.equal(f.engine.db.supplierAccountId,'supplier-new');assert.equal(f.engine.db.products.length,0);assert.equal(f.engine.db.photoSets.length,0);
});

test('an unsubmitted blocked or cancelled listing retries the original job and publishes only once',async t=>{
  for(const cancel of [false,true]){
    let ready=false;const f=await fixture(t,{adapter:{requireReady:async()=>{if(!ready)throw Error('Fixture page is not ready');}}});
    await f.engine.runOnce();const job=f.engine.db.jobs[0],identity={id:job.id,dedupeKey:job.dedupeKey,payload:{...job.payload}};
    assert.equal(job.state,'needs_review');assert.equal(job.operation,null);assert.equal(f.counts.claim,0);
    if(cancel)await f.engine.resolve(job.id,'cancel');
    ready=true;await f.engine.resolve(job.id,'retry');
    assert.equal(job.state,'queued');assert.equal(job.step,'pending');assert.equal(job.error,'');
    assert.deepEqual({id:job.id,dedupeKey:job.dedupeKey,payload:job.payload},identity);
    await f.engine.runOnce();await f.engine.runOnce();assert.equal(job.state,'completed');assert.equal(f.engine.db.jobs.length,1);assert.equal(f.counts.claim,1);assert.equal(f.counts.listing,1);
  }
});

test('retrying a cancelled job preserves a disabled plan and waits for explicit re-enabling',async t=>{
  const f=await fixture(t);f.engine.seed();const job=f.engine.db.jobs[0];await f.engine.resolve(job.id,'cancel');f.engine.setPlanEnabled(f.plan.id,false);
  await f.engine.resolve(job.id,'retry');assert.equal(f.plan.enabled,false);assert.equal(f.plan.status,'paused');await f.engine.runOnce();assert.equal(job.state,'queued');assert.equal(f.counts.claim,0);assert.equal(f.counts.listing,0);
  f.engine.setPlanEnabled(f.plan.id,true);await f.engine.runOnce();assert.equal(job.state,'completed');assert.equal(f.counts.listing,1);
});

test('retry rejects every submitted, ambiguous, result-bearing or malformed mutation record',async t=>{
  const f=await fixture(t);f.engine.seed();const job=f.engine.db.jobs[0];
  for(const change of [{operation:{}},{operation:{kind:'claim',receipt:{claimId:'already-claimed'}}},{operation:{kind:'claim',rejected:true}},{mutationPending:true},{mutationPending:undefined},{mutationPending:null},{result:{}},{result:{externalId:'existing'}},{result:{summary:'Already checked'}}]){
    Object.assign(job,{state:'needs_review',operation:null,mutationPending:false,result:null},change);const before=JSON.stringify(job);await assert.rejects(f.engine.resolve(job.id,'retry'),/提交记录或结果/);assert.equal(JSON.stringify(job),before);
  }
  assert.equal(f.counts.claim,0);assert.equal(f.counts.listing,0);
});

test('retry rejects unknown or ineligible job states and types without modifying their records',async t=>{
  const f=await fixture(t);f.engine.seed();const job=f.engine.db.jobs[0];
  for(const state of ['queued','running','completed','rejected','uncertain','unknown',undefined]){
    job.state=state;const before=JSON.stringify(job);await assert.rejects(f.engine.resolve(job.id,'retry'),/待核对或已取消/);assert.equal(JSON.stringify(job),before);
  }
  job.state='needs_review';job.type='unknown';await assert.rejects(f.engine.resolve(job.id,'retry'),/待核对或已取消/);assert.equal(job.type,'unknown');
});

test('retry cannot restore a stale listing cycle, completed target, existing listing or mismatched plan',async t=>{
  const f=await fixture(t);f.engine.seed();const job=f.engine.db.jobs[0];job.state='cancelled';
  for(const change of [{completedCount:1},{targetCount:0},{activeListingId:'already-live'},{profileId:'profile-2'},{productId:'product-2'}]){
    const before={...f.plan};Object.assign(f.plan,change);await assert.rejects(f.engine.resolve(job.id,'retry'));assert.equal(job.state,'cancelled');Object.assign(f.plan,before);
  }
  assert.equal(f.counts.listing,0);
});

test('one sale commits its task, sale identity, count and consumed listing in a single durable snapshot',async t=>{
  const f=await fixture(t);await f.listed();const snapshots=[],persist=f.engine.persist;
  f.engine.persist=function(){persist.call(this);snapshots.push(JSON.parse(fs.readFileSync(this.file,'utf8')));};
  try{
    const event=f.sale(),job=f.engine.ingestEvent(f.plan.id,event);assert.equal(snapshots.length,1);
    const saved=snapshots[0],plan=saved.plans.find(p=>p.id===f.plan.id);assert.equal(saved.jobs.length,1);assert.equal(saved.sales.length,1);assert.equal(saved.jobs[0].id,job.id);assert.equal(saved.sales[0].jobId,job.id);assert.equal(saved.sales[0].platformOrderId,event.id);assert.equal(plan.completedCount,1);assert.equal(plan.activeListingId,null);assert.equal(plan.status,'fulfilling');
    event.buyerUsername='caller-mutated';assert.equal(job.payload.buyerUsername,'test-buyer');
    const recovered=new CommerceEngine(f.options);try{const duplicate=recovered.ingestEvent(f.plan.id,{...job.payload});assert.equal(duplicate.id,job.id);assert.equal(recovered.plan(f.plan.id).completedCount,1);assert.equal(recovered.db.jobs.length,1);}finally{await recovered.close();}
  }finally{f.engine.persist=persist;}
});

test('a failed sale commit leaves the old complete disk snapshot available for recovery',async t=>{
  const f=await fixture(t);await f.listed();const event=f.sale(),before=fs.readFileSync(f.engine.file,'utf8'),persist=f.engine.persist;
  f.engine.persist=function(){this.faulted=true;throw Error('Simulated disk failure before atomic rename');};
  try{
    assert.throws(()=>f.engine.ingestEvent(f.plan.id,event),/disk failure/);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);await assert.rejects(f.engine.runOnce(),/存储不可用/);assert.equal(f.counts.order,0);
    const recovered=new CommerceEngine(f.options);try{assert.equal(recovered.db.jobs.length,0);assert.equal(recovered.db.sales.length,0);assert.equal(recovered.plan(f.plan.id).completedCount,0);assert.equal(recovered.plan(f.plan.id).activeListingId,event.listingId);const job=recovered.ingestEvent(f.plan.id,event);assert.equal(recovered.db.jobs.length,1);assert.equal(recovered.db.sales[0].jobId,job.id);assert.equal(recovered.plan(f.plan.id).completedCount,1);}finally{await recovered.close();}
  }finally{f.engine.persist=persist;}
});

test('an orphaned legacy sale task cannot create a duplicate task or advance the sales target',async t=>{
  const f=await fixture(t);await f.listed();const event=f.sale();f.engine.enqueue('fulfillment',f.plan,event,'vinted-order:'+event.id);const before=fs.readFileSync(f.engine.file,'utf8');
  assert.throws(()=>f.engine.ingestEvent(f.plan.id,event),e=>e.code==='SALE_CONFLICT');assert.equal(f.engine.db.jobs.length,1);assert.equal(f.engine.db.sales.length,0);assert.equal(f.plan.completedCount,0);assert.equal(f.plan.activeListingId,event.listingId);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);
});

test('job retry eligibility is shared by public state and resolve without exposing internal payloads',async t=>{
  const f=await fixture(t);f.engine.seed();const job=f.engine.db.jobs[0];job.state='needs_review';
  const before=JSON.stringify(job);assert.equal(f.engine.canRetry(job),true);const exposed=f.engine.state().jobs[0];assert.equal(exposed.canRetry,true);assert.equal(Object.hasOwn(exposed,'operation'),false);assert.equal(Object.hasOwn(exposed,'payload'),false);assert.equal(JSON.stringify(job),before);
  job.operation={kind:'claim',receipt:{claimId:'already-claimed'}};assert.equal(f.engine.canRetry(job),false);assert.equal(f.engine.state().jobs[0].canRetry,false);await assert.rejects(f.engine.resolve(job.id,'retry'));
  assert.equal(f.engine.canRetry(null),false);assert.equal(f.engine.canRetry({...job,operation:null,planId:'missing-plan'}),false);
});

test('a blocked unsubmitted plan can be edited without requeueing or rebinding its job',async t=>{
  const f=await fixture(t,{adapter:{requireReady:async()=>{throw Error('Missing listing details');}}});await f.engine.runOnce();const job=f.engine.db.jobs[0],before={...job};
  const updated=f.engine.savePlan({...f.plan,replyPolicy:'Use only the confirmed material and dimensions.',listingPriceCents:2800,minOfferCents:1900});
  assert.equal(updated.replyPolicy,'Use only the confirmed material and dimensions.');assert.equal(f.plan.listingPriceCents,2800);assert.equal(f.plan.minOfferCents,1900);assert.equal(job.state,'needs_review');assert.equal(job.id,before.id);assert.equal(job.dedupeKey,before.dedupeKey);assert.equal(job.operation,null);assert.equal(f.engine.canRetry(job),true);
  assert.throws(()=>f.engine.savePlan({...f.plan,profileId:'profile-2'}),/不能更换窗口或 SKU/);assert.throws(()=>f.engine.savePlan({...f.plan,productId:'product-2'}),/不能更换窗口或 SKU/);assert.equal(f.counts.claim,0);assert.equal(f.counts.listing,0);
});

test('plan editing rejects any running, queued, uncertain or mutation-bearing unfinished job',async t=>{
  const f=await fixture(t);f.engine.seed();const job=f.engine.db.jobs[0],originalPrice=f.plan.listingPriceCents;
  for(const change of [{state:'queued'},{state:'running'},{state:'uncertain'},{state:'unknown'},{state:'needs_review',operation:{kind:'claim',receipt:{claimId:'original'}}},{state:'needs_review',mutationPending:true},{state:'needs_review',result:{externalId:'original'}}]){
    Object.assign(job,{state:'needs_review',operation:null,mutationPending:false,result:null},change);assert.throws(()=>f.engine.savePlan({...f.plan,listingPriceCents:2900}),/执行中或已提交/);assert.equal(f.plan.listingPriceCents,originalPrice);
  }
  Object.assign(job,{state:'needs_review',operation:null,mutationPending:false,result:null});const another=f.engine.enqueue('message',f.plan,{},'other-unfinished');assert.equal(f.engine.canRetry(job),true);assert.equal(another.state,'queued');assert.throws(()=>f.engine.savePlan({...f.plan,listingPriceCents:2900}),/执行中或已提交/);assert.equal(f.plan.listingPriceCents,originalPrice);
});

test('a safe blocked plan remains uneditable while an account action or polling cycle is active',async t=>{
  const f=await fixture(t);f.engine.seed();f.engine.db.jobs[0].state='needs_review';
  f.engine.active.set('profile-2',new AbortController());try{assert.throws(()=>f.engine.savePlan({...f.plan,replyPolicy:'changed'}),/执行中或已提交/);}finally{f.engine.active.clear();}
  f.engine.ticking=true;try{assert.throws(()=>f.engine.savePlan({...f.plan,replyPolicy:'changed'}),/执行中或已提交/);}finally{f.engine.ticking=false;}
  assert.equal(f.plan.replyPolicy,'');assert.equal(f.engine.savePlan({...f.plan,replyPolicy:'ready to retry'}).replyPolicy,'ready to retry');
});
