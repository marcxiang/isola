const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CommerceEngine,validatePlan,normalizeProduct}=require('../src/commerce-engine.cjs');

const profiles=[{id:'profile-1',name:'Test account 1'},{id:'profile-2',name:'Test account 2'}];
const rawProduct={id:'product-1',sku:'SKU-1',name:'Test garment',stock:12,unitPriceCents:1000,revision:7};
const planInput=(overrides={})=>({profileId:'profile-1',productId:'product-1',listingPriceCents:2500,minOfferCents:1800,targetCount:2,enabled:true,autoReply:true,autoAcceptOffers:true,reuseOwnPhotos:true,...overrides});
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};

test('one verified marketplace member cannot be bound to two browser environments',async t=>{
 const {engine}=await fixture(t,{plan:false});const observed={verified:true,memberId:'123456',username:'fixture_seller',profileURL:'https://www.vinted.fr/member/123456',documentKey:'fixture-doc'};
 engine.bindMarketAccount('profile-1',observed);assert.throws(()=>engine.bindMarketAccount('profile-2',observed),{code:'ACCOUNT_CONFLICT'});assert.equal(engine.db.marketAccounts.length,1);assert.equal(engine.accountObservations.has('profile-2'),false);
});

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
  const sale=(p=savedPlan,overrides={})=>({verified:true,type:'sale',id:'sale-'+p.id,profileId:p.profileId,listingId:p.activeListingId,paid:true,cancelled:false,observedAt:new Date().toISOString(),currency:'EUR',priceCents:2000,quantity:1,buyerUsername:'test-buyer',...overrides});
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

test('an internal stopped read pauses its original job instead of endlessly reopening the environment',async t=>{
 let reads=0,interrupt=true;const f=await fixture(t,{adapter:{readiness:()=>({capabilities:{publish:true}}),executeJob:async({job,signal})=>{reads++;assert.equal(signal.aborted,false);job.step='check_catalog';if(interrupt)throw Object.assign(Error('Fixture account reader lost its original document'),{code:'STOPPED'});job.result={externalId:'fixture-original-job-completed'};}}});
 await f.engine.runOnce();const job=f.engine.db.jobs[0],id=job.id,key=job.dedupeKey,payload=JSON.stringify(job.payload);assert.equal(job.state,'needs_review');assert.equal(job.blockedReason,'OPERATION_INTERRUPTED');assert.match(job.error,/lost its original document/);assert.equal(job.retryAt,null);assert.equal(job.operation,null);assert.equal(job.mutationPending,false);assert.equal(f.counts.claim,0);assert.equal(f.counts.listing,0);
 for(let i=0;i<4;i++)await f.engine.runOnce();assert.equal(reads,1);assert.equal(f.engine.db.jobs.length,1);assert.equal(job.id,id);assert.equal(job.dedupeKey,key);assert.equal(JSON.stringify(job.payload),payload);assert.equal(JSON.parse(fs.readFileSync(f.engine.file,'utf8')).jobs[0].blockedReason,'OPERATION_INTERRUPTED');
 interrupt=false;await f.engine.resolve(id,'retry');await f.engine.runOnce();assert.equal(reads,2);assert.equal(job.state,'completed');assert.equal(job.id,id);assert.equal(job.dedupeKey,key);assert.equal(f.engine.db.jobs.length,1);
});

test('concrete account-reader failure codes survive without being mistaken for external cancellation',async t=>{
 let reads=0;const f=await fixture(t,{adapter:{readiness:()=>({capabilities:{publish:true}}),executeJob:async({job,signal})=>{reads++;assert.equal(signal.aborted,false);job.step='check_catalog';throw Object.assign(Error('Fixture unexpected own-profile navigation'),{code:'PAGE_CHANGED'});}}});
 await f.engine.runOnce();const job=f.engine.db.jobs[0];assert.equal(job.state,'needs_review');assert.equal(job.blockedReason,'PAGE_CHANGED');assert.equal(job.error,'Fixture unexpected own-profile navigation');await f.engine.runOnce();assert.equal(reads,1);assert.equal(f.counts.claim,0);
});

test('a real outer scheduler cancellation preserves the no-cost stopped state',async t=>{
 const entered=deferred(),release=deferred();const f=await fixture(t,{adapter:{readiness:()=>({capabilities:{publish:true}}),executeJob:async({signal})=>{entered.resolve(signal);await release.promise;assert.equal(signal.aborted,true);throw Object.assign(Error('Fixture outer cancellation'),{code:'STOPPED'});}}});
 const run=f.engine.runOnce();const signal=await entered.promise;f.engine.setRunning(false);assert.equal(signal.aborted,true);release.resolve();await run;const job=f.engine.db.jobs[0];assert.equal(job.state,'queued');assert.equal(job.blockedReason,'STOPPED');assert.equal(job.attempts,0);assert.equal(job.retryAt,null);assert.equal(f.counts.claim,0);
});

test('an interrupted read after mutation evidence remains uncertain and never becomes a retryable pause',async t=>{
 let calls=0;const f=await fixture(t,{adapter:{readiness:()=>({capabilities:{publish:true}}),executeJob:async({job})=>{calls++;job.step='publish_listing';job.operation={kind:'publish',idempotencyKey:'fixture-original-submit'};job.mutationPending=true;throw Object.assign(Error('Fixture reader stopped after dispatch'),{code:'STOPPED'});}}});
 await f.engine.runOnce();const job=f.engine.db.jobs[0];assert.equal(job.state,'uncertain');assert.equal(job.blockedReason,'RECONCILE_REQUIRED');assert.equal(job.operation.idempotencyKey,'fixture-original-submit');assert.equal(job.mutationPending,true);assert.equal(f.engine.canRetry(job),false);await f.engine.runOnce();assert.equal(calls,1);
});

test('closing an idle profile while background runs holds its pending plans without affecting another profile',async t=>{
 const f=await fixture(t),second=f.engine.savePlan(planInput({productId:'product-2'})),other=f.engine.savePlan(planInput({profileId:'profile-2'}));f.engine.seed();
 const held=f.engine.db.jobs.find(job=>job.planId===f.plan.id),same=f.engine.db.jobs.find(job=>job.planId===second.id),unaffected=f.engine.db.jobs.find(job=>job.planId===other.id),beforeOther=JSON.stringify(unaffected);f.engine.running=true;
 assert.equal(f.engine.stopProfile('profile-1','PROFILE_CLOSED'),true);assert.equal(held.state,'needs_review');assert.equal(held.blockedReason,'PROFILE_CLOSED');assert.equal(same.state,'queued');assert.equal(JSON.stringify(unaffected),beforeOther);assert.equal(f.engine.running,true);
 assert.equal(JSON.parse(fs.readFileSync(f.engine.file,'utf8')).jobs.find(job=>job.id===held.id).blockedReason,'PROFILE_CLOSED');
 await f.engine.runOnce();assert.equal(held.state,'needs_review');assert.equal(same.state,'queued');assert.equal(unaffected.state,'completed');assert.equal(f.counts.listing,1);assert.equal(f.calls.find(call=>call.name==='publishListing').args.plan,other.id);
 f.engine.setRunning(false);await f.engine.resolve(held.id,'retry');await f.engine.runOnce();assert.equal(held.state,'completed');assert.equal(same.state,'queued');assert.equal(f.counts.listing,2);
});

test('closing before the first tick seeds a hold only for that profile and preserves it across restart',async t=>{
 const f=await fixture(t);f.engine.savePlan(planInput({profileId:'profile-2'}));assert.equal(f.engine.db.jobs.length,0);f.engine.running=true;
 assert.equal(f.engine.stopProfile('profile-1','PROFILE_CLOSED'),true);assert.equal(f.engine.db.jobs.length,1);const held=f.engine.db.jobs[0];assert.equal(held.profileId,'profile-1');assert.equal(held.state,'needs_review');assert.equal(held.blockedReason,'PROFILE_CLOSED');assert.equal(held.operation,null);assert.equal(held.mutationPending,false);assert.equal(f.counts.listing,0);
 assert.equal(f.engine.stopProfile('profile-1','PROFILE_CLOSED'),false);assert.equal(f.engine.db.jobs.length,1);f.engine.setRunning(false);
 const restored=new CommerceEngine(f.options);try{const saved=restored.db.jobs.find(job=>job.id===held.id);assert.equal(saved.state,'needs_review');assert.equal(saved.blockedReason,'PROFILE_CLOSED');await restored.runOnce();assert.equal(saved.state,'needs_review');assert.equal(f.calls.filter(call=>call.name==='publishListing'&&call.args.plan===f.plan.id).length,0);}finally{await restored.close();}
});

test('manual close while the scheduler is stopped leaves both seeded and unseeded plans available for later automation',async t=>{
 const f=await fixture(t);assert.equal(f.engine.stopProfile('profile-1','PROFILE_CLOSED'),false);assert.equal(f.engine.db.jobs.length,0);f.engine.seed();const before=JSON.stringify(f.engine.db);
 assert.equal(f.engine.stopProfile('profile-1'),false);assert.equal(JSON.stringify(f.engine.db),before);assert.throws(()=>f.engine.stopProfile('profile-1','invented'),TypeError);assert.equal(JSON.stringify(f.engine.db),before);
});

test('profile stop aborts an active business job with the original reason and waits for its normal recovery',async t=>{
 const entered=deferred(),release=deferred();const f=await fixture(t,{adapter:{requireReady:async(_profile,{signal})=>{entered.resolve(signal);await release.promise;if(signal.aborted)throw Object.assign(Error('Adapter observed cancellation'),{code:'STOPPED'});}}});
 const run=f.engine.runOnce(),signal=await entered.promise;assert.equal(f.engine.stopProfile('profile-1'),true);assert.equal(signal.aborted,true);assert.equal(signal.reason.code,'PROFILE_STOPPED');release.resolve();await run;
 const job=f.engine.db.jobs[0];assert.equal(job.state,'needs_review');assert.equal(job.blockedReason,'PROFILE_STOPPED');assert.equal(job.operation,null);assert.equal(f.counts.listing,0);assert.equal(f.engine.active.size,0);
});

test('closing during a polling lease aborts polling and persists a hold before the same tick can start a listing',async t=>{
 const entered=deferred(),release=deferred();const f=await fixture(t,{adapter:{poll:async(_profile,{signal})=>{entered.resolve(signal);await release.promise;return [];}}});f.engine.running=true;
 const run=f.engine.runOnce(),signal=await entered.promise,owner=f.engine.active.get('profile-1');assert.equal(f.engine.stopProfile('profile-1','PROFILE_CLOSED'),true);assert.equal(signal.aborted,true);assert.equal(owner.signal.reason.code,'PROFILE_CLOSED');release.resolve();await run;
 const job=f.engine.db.jobs[0];assert.equal(job.state,'needs_review');assert.equal(job.blockedReason,'PROFILE_CLOSED');assert.equal(f.counts.listing,0);assert.equal(f.counts.claim,0);assert.equal(f.engine.active.size,0);
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
  for(const state of ['queued','running','completed','uncertain','unknown',undefined]){
    job.state=state;const before=JSON.stringify(job);await assert.rejects(f.engine.resolve(job.id,'retry'),/待核对.*已取消|运行任务/);assert.equal(JSON.stringify(job),before);
  }
  job.state='needs_review';job.type='unknown';await assert.rejects(f.engine.resolve(job.id,'retry'),/待核对.*已取消/);assert.equal(job.type,'unknown');
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

test('plan editing rejects running, uncertain or mutation-bearing unfinished jobs but preserves safe queued tasks',async t=>{
  const f=await fixture(t);f.engine.seed();const job=f.engine.db.jobs[0],originalPrice=f.plan.listingPriceCents;
  for(const change of [{state:'running'},{state:'uncertain'},{state:'unknown'},{state:'needs_review',operation:{kind:'claim',receipt:{claimId:'original'}}},{state:'needs_review',mutationPending:true},{state:'needs_review',result:{externalId:'original'}}]){
    Object.assign(job,{state:'needs_review',operation:null,mutationPending:false,result:null},change);assert.throws(()=>f.engine.savePlan({...f.plan,listingPriceCents:2900}),/执行中或已提交/);assert.equal(f.plan.listingPriceCents,originalPrice);
  }
  Object.assign(job,{state:'queued',operation:null,mutationPending:false,result:null});const another=f.engine.enqueue('message',f.plan,{},'other-unfinished'),before=[JSON.stringify(job),JSON.stringify(another)];assert.equal(another.state,'queued');assert.equal(f.engine.savePlan({...f.plan,listingPriceCents:2900}).listingPriceCents,2900);assert.deepEqual([JSON.stringify(job),JSON.stringify(another)],before);another.operation={kind:'reply'};assert.throws(()=>f.engine.savePlan({...f.plan,listingPriceCents:3000}),/执行中或已提交/);assert.equal(f.plan.listingPriceCents,2900);
});

test('only the target environment lease blocks safe plan editing while unrelated background work continues',async t=>{
  const f=await fixture(t);f.engine.seed();f.engine.db.jobs[0].state='needs_review';
  f.engine.active.set('profile-2',new AbortController());try{assert.equal(f.engine.savePlan({...f.plan,replyPolicy:'other profile is busy'}).replyPolicy,'other profile is busy');}finally{f.engine.active.clear();}
  f.engine.ticking=true;try{assert.equal(f.engine.savePlan({...f.plan,replyPolicy:'no target lease'}).replyPolicy,'no target lease');}finally{f.engine.ticking=false;}
  f.engine.active.set(f.plan.profileId,new AbortController());try{assert.throws(()=>f.engine.savePlan({...f.plan,replyPolicy:'must not change'}),/执行中或已提交/);}finally{f.engine.active.clear();}
  const lease=f.engine.leases.acquire(f.plan.profileId,'poll:fixture');try{assert.throws(()=>f.engine.savePlan({...f.plan,replyPolicy:'must not change'}),/执行中或已提交/);}finally{f.engine.leases.release(lease);}
  assert.equal(f.plan.replyPolicy,'no target lease');assert.equal(f.engine.savePlan({...f.plan,replyPolicy:'ready to retry'}).replyPolicy,'ready to retry');
});


test('sales distribution exposes only a single matching receipt URL in the original profile',async t=>{
 const {engine,plan}=await fixture(t);plan.activeListingId='12345';plan.activeListingUrl='https://evil.invalid/';
 const row={listingId:'12345',url:'https://www.vinted.fr/items/12345-fixture'};
 const claim={id:'fixture-receipt',profileId:plan.profileId,productId:plan.productId,listings:[row]};engine.db.claims.push(claim);
 const url=()=>engine.state().plans.find(p=>p.id===plan.id).activeListingUrl;
 assert.equal(url(),row.url);
 for(const bad of ['https://evil.invalid/items/12345','https://www.vinted.fr/items/98765','https://user:pass@www.vinted.fr/items/12345','https://www.vinted.fr/items/12345?redirect=other','javascript:alert(1)']){row.url=bad;assert.equal(url(),null);}
 row.url='https://www.vinted.fr/items/12345-fixture';claim.profileId='profile-2';assert.equal(url(),null);claim.profileId=plan.profileId;
 claim.listings.push({...row});assert.equal(url(),null);claim.listings.pop();plan.activeListingId=null;assert.equal(url(),null);
});


test('market account binding persists its member identity and rejects a silent account switch',async t=>{
 const {engine,plan,options}=await fixture(t),account={verified:true,memberId:'123456',username:'fixture-seller',profileURL:'https://www.vinted.fr/member/123456'};
 const bound=engine.bindMarketAccount(plan.profileId,account);assert.equal(bound.platform,'vinted-fr');assert.equal(engine.state().profiles.find(p=>p.id===plan.profileId).marketAccount.memberId,'123456');
 assert.throws(()=>engine.bindMarketAccount(plan.profileId,{...account,memberId:'98765',profileURL:'https://www.vinted.fr/member/98765'}),/不同/);
 assert.throws(()=>engine.bindMarketAccount(plan.profileId,{...account,profileURL:'https://www.vinted.fr/member/98765'}));assert.throws(()=>engine.bindMarketAccount(plan.profileId,{...account,verified:false}));assert.throws(()=>engine.bindMarketAccount('missing',account));
 await engine.close();const restored=new CommerceEngine(options);try{assert.equal(restored.state().profiles.find(p=>p.id===plan.profileId).marketAccount.memberId,'123456');restored.bindMarketAccount(plan.profileId,{...account,username:'renamed-fixture'});assert.equal(restored.db.marketAccounts.length,1);}finally{await restored.close();}
});

test('platform events need a bounded buyer identity and duplicate messages/offers cannot change facts',async t=>{
 const f=await fixture(t);await f.listed();
 for(const buyerUsername of ['',null,' buyer ','buyer\nother'])assert.throws(()=>f.engine.ingestEvent(f.plan.id,f.sale(f.plan,{buyerUsername})),{code:'EVENT_UNVERIFIED'});
 for(const type of ['message','offer']){
  const event=f.sale(f.plan,{type,id:'event-'+type,text:type==='message'?'Question one':undefined}),job=f.engine.ingestEvent(f.plan.id,event);
  assert.equal(f.engine.ingestEvent(f.plan.id,{...event}).id,job.id);
  for(const patch of [{buyerUsername:'another-buyer'},{listingId:'other-listing'},{text:'Changed question'},{priceCents:2100}])assert.throws(()=>f.engine.ingestEvent(f.plan.id,{...event,...patch}),{code:'EVENT_CONFLICT'});
  event.buyerUsername='mutated-after-ingest';assert.equal(job.payload.buyerUsername,'test-buyer');
 }
 assert.equal(f.counts.order,0);
});

test('an acceptable price never authorizes accepting a different buyer or changed offer',async t=>{
 for(const patch of [{buyerUsername:'other-buyer'},{buyerMemberId:'999'},{profileId:'profile-2'},{priceCents:1900}]){
  const f=await fixture(t,{adapter:{readOffer:async event=>({...event,status:'pending',...patch})}});await f.listed();
  const job=f.engine.ingestEvent(f.plan.id,f.sale(f.plan,{type:'offer',id:'offer-original',priceCents:1800}));await f.engine.runOnce();
  assert.equal(job.state,'needs_review');assert.equal(f.calls.filter(row=>row.name==='acceptOffer').length,0);
 }
});

test('bound account identity and cancelled or over-price sales are never inferred from a verified flag',async t=>{
 const f=await fixture(t);await f.listed();f.engine.bindMarketAccount(f.plan.profileId,{verified:true,memberId:'123',username:'seller',profileURL:'https://www.vinted.fr/member/123'});
 for(const patch of [{},{memberId:'456'},{memberId:'123',cancelled:true},{memberId:'123',cancelled:undefined},{memberId:'123',priceCents:2600}])assert.throws(()=>f.engine.ingestEvent(f.plan.id,f.sale(f.plan,patch)));
 assert.equal(f.engine.db.sales.length,0);assert.equal(f.plan.completedCount,0);
});

test('cancelled and falsely completed sales cannot silently seed a replacement listing',async t=>{
 const f=await fixture(t);await f.listed();const job=f.engine.ingestEvent(f.plan.id,f.sale());
 for(const change of [{state:'cancelled',result:null},{state:'rejected',result:null},{state:'completed',result:{externalId:'supplier-order'}},{state:'completed',result:{externalId:'supplier-order',verified:'yes'}}]){
  Object.assign(job,change);f.engine.seed();assert.equal(f.engine.db.jobs.filter(row=>row.type==='listing').length,0);
 }
 Object.assign(job,{state:'completed',result:{externalId:'supplier-order',verified:true}});f.engine.seed();assert.equal(f.engine.db.jobs.filter(row=>row.type==='listing').length,1);
});

async function publishedFixture(t,options={}, {reconcile=true,session=false}={}){
 const f=await fixture(t,options),{buildPublicationProof,FORM_URL}=require('../src/vinted-publication.cjs'),{publicationJournal}=require('../src/vinted-publish-submit.cjs');
 const at=new Date().toISOString(),profileId=f.plan.profileId,listing={title:'Local test accessory',description:'Local fixture only.',categoryPath:['Maison','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
 Object.assign(f.plan,{listing,status:'ready'});if(!session)f.engine.bindMarketAccount(profileId,{verified:true,memberId:'123',username:'seller',profileURL:'https://www.vinted.fr/member/123'});
 const account=session?require('../src/commerce-session-authority.cjs').createEnvironmentSessionAuthority(profileId):f.engine.db.marketAccounts[0],observedAccount=session?{...account}:{...account,verified:true},claim={id:'journal-claim',setId:'journal-set',profileId,productId:f.plan.productId,images:[{id:'image-1'}],listings:[]},documentKey='fixture-document';f.engine.db.claims.push(claim);if(session)f.engine.seed();f.engine.persist();
 const input={plan:f.plan,product:{id:f.plan.productId,sku:f.plan.sku,stock:1},claim,expectedAccount:account,evidence:{profileId,tabId:'fixture-tab',documentKey,url:FORM_URL,observedAt:at,challenge:false,account:observedAccount,form:{documentKey,complete:true,invalidFields:[],unknownFields:[],fields:Object.entries({...listing,priceCents:f.plan.listingPriceCents}).map(([field,value])=>({field,value,verified:true}))},photos:{documentKey,profileId,productId:f.plan.productId,claimId:claim.id,setId:claim.setId,count:1,signature:'a'.repeat(64),verified:true,busy:false,errorCount:0},publication:{documentKey,count:1,observed:true,label:'Ajouter',enabled:true}}};
 const journal=publicationJournal(f.engine),proof=buildPublicationProof(input),record=await journal.prepare(proof);await journal.dispatchOnce(record.id,proof,async()=>{});
 const origin={kind:'observed_submission_navigation',submissionId:record.id,formDocumentKey:documentKey,...(session?{profileId,tabId:'fixture-tab',listingId:'98765',url:'https://www.vinted.fr/items/98765',observedAt:new Date().toISOString(),event:'did-navigate',committed:true}:{})};
 if(session)await journal._atomic(state=>{state.submissions.find(row=>row.id===record.id).navigation=[JSON.parse(JSON.stringify(origin))];});
 if(reconcile)await journal.reconcile(record.id,{verified:true,mappingVerified:true,publicationStatus:'published',observedAt:new Date().toISOString(),profileId,account:observedAccount,...(!session?{seller:observedAccount}:{}),ownedByCurrentAccount:true,listingId:'98765',url:'https://www.vinted.fr/items/98765',origin,priceKind:'item',priceCents:f.plan.listingPriceCents,currency:'EUR',title:listing.title,photos:{verified:true,count:1,signature:'a'.repeat(64)}});
 f.plan=f.engine.plan(f.plan.id);return {...f,journal,record,publicationJournal,input};
}

test('a journal-backed sale closes its listing, counts once and creates its original task in one snapshot',async t=>{
 const f=await publishedFixture(t),event=f.sale(f.plan,{memberId:'123'}),snapshots=[],persist=f.engine.persist.bind(f.engine);
 f.engine.persist=()=>{snapshots.push(JSON.parse(JSON.stringify(f.engine.db)));persist();};
 assert.throws(()=>f.engine.ingestEvent(f.plan.id,event),{code:'PUBLICATION_SALE_TRANSACTION_REQUIRED'});
 const job=await f.engine.ingestVerifiedEvent(f.plan.id,event);assert.equal(snapshots.length,1);
 const saved=snapshots[0];assert.equal(saved.publications.submissions[0].closedSale.orderId,event.id);assert.equal(saved.plans[0].completedCount,1);assert.equal(saved.plans[0].activeListingId,null);assert.equal(saved.sales[0].jobId,job.id);assert.equal(saved.jobs[0].id,job.id);
 assert.equal((await f.engine.ingestVerifiedEvent(f.plan.id,event)).id,job.id);assert.equal(snapshots.length,1);assert.equal(f.publicationJournal(f.engine),f.journal);assert.deepEqual(f.journal.state(),f.engine.db.publications);
});

test('a failed journal-backed sale snapshot keeps the complete old disk state and faults the journal',async t=>{
 const f=await publishedFixture(t),before=fs.readFileSync(f.engine.file,'utf8'),event=f.sale(f.plan,{memberId:'123'});
 f.engine.persist=()=>{throw Error('Simulated durable write failure');};
 await assert.rejects(f.engine.ingestVerifiedEvent(f.plan.id,event),{code:'PUBLICATION_STORAGE_FAILED'});assert.equal(f.engine.faulted,true);assert.equal(f.journal.faulted,true);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(f.engine.db.sales.length,0);assert.equal(f.engine.plan(f.plan.id).completedCount,0);assert.equal(f.engine.db.publications.submissions[0].closedSale,undefined);
});

test('sales-only mode confirms a sale without procurement and unlocks only the next matching cycle',async t=>{
 const calls=[],f=await publishedFixture(t,{adapter:{readiness:()=>({salesOnly:true,capabilities:{saleConfirmation:true,publish:false}}),executeJob:async({engine,job,plan,signal})=>{calls.push(job.type);assert.equal(job.type,'sale_confirmation');assert.ok(signal instanceof AbortSignal);assert.equal(plan.id,job.planId);job.result={verified:true,externalId:job.payload.id,kind:'sale_confirmation'};}}});
 const job=await f.engine.ingestVerifiedEvent(f.plan.id,f.sale(f.plan,{memberId:'123'}));assert.equal(job.type,'sale_confirmation');f.engine.seed();assert.equal(f.engine.db.jobs.length,1);
 await f.engine.runOnce();assert.equal(job.state,'completed');assert.deepEqual(calls,['sale_confirmation']);assert.equal(f.counts.order,0);assert.equal(f.counts.claim,0);assert.equal(f.engine.plan(f.plan.id).status,'ready');
 f.engine.seed();const replacement=f.engine.db.jobs.find(row=>row.type==='listing');assert.equal(replacement.payload.cycle,1);assert.equal(replacement.state,'queued');assert.equal(f.engine.db.publications.submissions[0].closedSale.orderId,job.payload.id);
});

test('sales-only runtime cannot execute a legacy procurement task even when flags are accidentally enabled',async t=>{
 let executed=0;const f=await fixture(t,{adapter:{readiness:()=>({salesOnly:true,capabilities:{shippingLabel:true,procurement:true}}),executeJob:async()=>{executed++;}}});await f.listed();
 const job=f.engine.enqueue('fulfillment',f.plan,f.sale(),'legacy-procurement');assert.equal(await f.engine.runJob(job),false);await f.engine.runOnce();assert.equal(executed,0);assert.equal(f.counts.order,0);assert.equal(job.state,'queued');
});

const deletionRequest=f=>({submissionId:f.record.id,listingURL:'https://www.vinted.fr/items/98765-old-product',confirmed:true});
test('session publication deletion and restart preserve the original journal without requiring or inventing a member',async t=>{
 const {accountExpectation}=require('../src/commerce-account-binding.cjs');
 for(const reconcile of [true,false]){
  const f=await publishedFixture(t,{adapter:{readiness:()=>({salesOnly:true,capabilities:{publish:true,sessionListing:true,autoOpenProfile:true}})}},{session:true,reconcile}),original=f.engine.db.jobs[0],id=original.id,key=original.dedupeKey,sessionAccount={kind:'environment-session',profileId:f.plan.profileId},claims=JSON.stringify(f.engine.db.claims);
  assert.deepEqual(f.engine.db.marketAccounts,[]);assert.equal(f.engine.state().publications[0].sessionListing,true);assert.deepEqual(accountExpectation(f.engine,f.plan.profileId),{memberId:null,account:null});assert.equal(original.accountMemberId,undefined);
  if(reconcile){assert.deepEqual(original.publicationAccount,sessionAccount);assert.equal(f.engine.db.publications.submissions[0].receipt.memberId,undefined);assert.deepEqual(f.engine.db.publications.submissions[0].receipt.account,sessionAccount);}
  else{assert.equal(original.publicationAccount,undefined);assert.equal(f.engine.db.publications.submissions[0].receipt,null);}
  const state=await f.engine.confirmDeletedListing(f.plan.id,deletionRequest(f)),old=f.engine.db.jobs.find(row=>row.id===id),replacement=f.engine.db.jobs.find(row=>row.id!==id),record=f.engine.db.publications.submissions[0];
  assert.equal(state.publications[0].sessionListing,true);assert.equal(state.publications[0].closedWithdrawal,true);assert.equal(old.id,id);assert.equal(old.dedupeKey,key);assert.equal(old.state,'cancelled');assert.equal(old.accountMemberId,undefined);assert.deepEqual(old.deletion.account,sessionAccount);assert.equal(old.deletion.memberId,undefined);assert.equal(record.id,f.record.id);assert.deepEqual(record.proof.facts.account,sessionAccount);assert.deepEqual(record.closedWithdrawal.account,sessionAccount);assert.equal(record.closedWithdrawal.memberId,undefined);assert.equal(record.closedSale,undefined);assert.equal(replacement.state,'queued');assert.equal(replacement.accountMemberId,undefined);assert.equal(replacement.dedupeKey,key+':r1');assert.equal(f.engine.plan(f.plan.id).completedCount,0);assert.equal(f.engine.plan(f.plan.id).activeListingId,null);assert.deepEqual(f.engine.db.marketAccounts,[]);assert.deepEqual(f.engine.db.sales,[]);assert.equal(JSON.stringify(f.engine.db.claims),claims);assert.equal(f.counts.claim,0);assert.equal(f.counts.listing,0);assert.deepEqual(accountExpectation(f.engine,f.plan.profileId),{memberId:null,account:null});
  const restored=new CommerceEngine(f.options);try{assert.deepEqual(restored.db.marketAccounts,[]);assert.equal(restored.db.jobs.length,2);assert.equal(restored.db.jobs[0].id,id);assert.equal(restored.db.jobs[1].id,replacement.id);assert.equal(restored.db.jobs.every(row=>row.accountMemberId===undefined),true);assert.equal(restored.db.publications.submissions[0].id,f.record.id);assert.deepEqual(restored.db.publications.submissions[0].closedWithdrawal.account,sessionAccount);assert.equal(restored.state().publications[0].sessionListing,true);assert.deepEqual(accountExpectation(restored,f.plan.profileId),{memberId:null,account:null});restored.seed();assert.equal(restored.db.jobs.length,2);}finally{await restored.close();}
 }
});

test('session deletion still requires explicit confirmation and the original plan and listing',async t=>{
 for(const change of [f=>f.request.confirmed=false,f=>f.request.submissionId='other-submission',f=>f.request.listingURL='https://www.vinted.fr/items/87654',f=>f.engine.plan(f.plan.id).profileId='profile-2']){
  const f=await publishedFixture(t,{}, {session:true});f.request=deletionRequest(f);change(f);const before=JSON.stringify(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8');await assert.rejects(f.engine.confirmDeletedListing(f.plan.id,f.request));assert.equal(JSON.stringify(f.engine.db),before);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.deepEqual(f.engine.db.marketAccounts,[]);
 }
});

test('confirmed deletion of an uncertain submission archives it and queues a new revision without increasing sales or claiming photos',async t=>{
 const f=await publishedFixture(t,{}, {reconcile:false});f.engine.seed();
 const old=f.engine.enqueue('listing',f.plan,{cycle:0},'listing:'+f.plan.id+':0');old.state='needs_review';old.error='Original publication awaits review';f.engine.persist();
 const beforeClaims=JSON.stringify(f.engine.db.claims),writes=[],persist=f.engine.persist.bind(f.engine);f.engine.persist=()=>{writes.push(JSON.parse(JSON.stringify(f.engine.db)));persist();};
 const result=await f.engine.confirmDeletedListing(f.plan.id,deletionRequest(f));assert.equal(writes.length,1);assert.equal(result.publications[0].closedWithdrawal,true);assert.equal(result.publications[0].closedSale,false);
 const plan=f.engine.plan(f.plan.id),jobs=f.engine.db.jobs;assert.equal(plan.completedCount,0);assert.equal(plan.listingRevision,1);assert.equal(plan.activeListingId,null);assert.equal(plan.listingPriceCents,2500);assert.equal(JSON.stringify(f.engine.db.claims),beforeClaims);assert.deepEqual(f.engine.db.sales,[]);assert.equal(f.counts.claim,0);assert.equal(f.counts.listing,0);
 assert.equal(jobs.length,2);assert.equal(jobs[0].state,'cancelled');assert.equal(jobs[0].result.kind,'listing_deleted');assert.equal(jobs[0].deletion.reason,'deleted_not_sold');assert.equal(jobs[0].deletion.verified,undefined);assert.equal(jobs[1].state,'queued');assert.equal(jobs[1].dedupeKey,'listing:'+plan.id+':0:r1');assert.deepEqual(jobs[1].payload,{cycle:0,listingRevision:1});
 f.engine.seed();assert.equal(f.engine.db.jobs.length,2);assert.equal(f.engine.canRetry(jobs[0]),false);assert.deepEqual(f.journal.state(),f.engine.db.publications);assert.equal(f.publicationJournal(f.engine),f.journal);
 await assert.rejects(f.engine.confirmDeletedListing(plan.id,deletionRequest(f)),{code:'DELETION_SUBMISSION_CONFLICT'});assert.equal(writes.length,1);
 const restored=new CommerceEngine(f.options);try{assert.equal(restored.plan(plan.id).listingRevision,1);assert.equal(restored.db.jobs[0].state,'cancelled');assert.equal(restored.db.jobs[1].state,'queued');restored.seed();assert.equal(restored.db.jobs.length,2);}finally{await restored.close();}
});

test('confirmed deletion retains a completed publication receipt and cancels only its unsent supplier association',async t=>{
 const f=await publishedFixture(t),result={verified:true,submissionId:f.record.id,externalId:'98765'},job=f.engine.enqueue('listing',f.plan,{cycle:0},'listing:'+f.plan.id+':0');job.state='completed';job.result=result;f.engine.persist();const beforeClaims=JSON.stringify(f.engine.db.claims);
 await f.engine.confirmDeletedListing(f.plan.id,deletionRequest(f));const old=f.engine.db.jobs.find(row=>row.id===job.id),record=f.engine.db.publications.submissions[0];
 assert.equal(record.state,'published');assert.equal(record.receipt.listingId,'98765');assert.equal(record.closedWithdrawal.listingId,'98765');assert.equal(old.state,'cancelled');assert.deepEqual(old.result.previousResult,result);assert.equal(f.engine.db.publicationSupplierSync[0].state,'cancelled');assert.equal(JSON.stringify(f.engine.db.claims),beforeClaims);assert.equal(f.engine.plan(f.plan.id).completedCount,0);
 const restored=new CommerceEngine(f.options);try{assert.equal(restored.db.publications.submissions[0].closedWithdrawal.reason,'deleted_not_sold');assert.equal(restored.db.publicationSupplierSync[0].state,'cancelled');}finally{await restored.close();}
});

test('deletion requires explicit confirmation, original identity, stopped queue and an incomplete enabled sales plan',async t=>{
 for(const change of [f=>{f.request.confirmed=false;},f=>{f.request.submissionId='other-submission';},f=>{f.request.listingURL='https://www.vinted.fr/items/87654';},f=>{f.engine.plan(f.plan.id).enabled=false;},f=>{f.engine.plan(f.plan.id).completedCount=2;},f=>{f.engine.plan(f.plan.id).profileId='profile-2';},f=>{f.engine.db.marketAccounts[0].memberId='999';},f=>{f.engine.accounts={list:()=>[{profileId:f.plan.profileId,identity:{memberId:'999',profileURL:'https://www.vinted.fr/member/999'}}]};},f=>{f.engine.running=true;},f=>{f.engine.active.set(f.plan.profileId,new AbortController());},f=>{f.engine.plan(f.plan.id).listingRevision=1;}]){
  const f=await publishedFixture(t);f.request=deletionRequest(f);change(f);const before=JSON.stringify(f.engine.db);await assert.rejects(f.engine.confirmDeletedListing(f.plan.id,f.request),String(change));assert.equal(JSON.stringify(f.engine.db),before);assert.equal(f.counts.listing,0);f.engine.running=false;f.engine.active.clear();
 }
});

test('conflicting navigation, task, other-account item or unresolved write prevents deletion recovery',async t=>{
 const changes=[f=>{f.engine.db.publications.submissions[0].navigation=[{profileId:f.plan.profileId,listingId:'87654',url:'https://www.vinted.fr/items/87654'}];},f=>{const job=f.engine.enqueue('listing',f.plan,{cycle:0},'listing:'+f.plan.id+':0');job.operation={kind:'claim'};job.mutationPending=true;},f=>{const job=f.engine.enqueue('message',f.plan,{},'pending-reply');job.state='uncertain';},f=>{f.engine.db.plans.push({...f.plan,id:'other-plan',activeListingId:'98765'});},f=>{f.engine.enqueue('listing',f.plan,{cycle:0,listingRevision:1},'listing:'+f.plan.id+':0:r1');}];
 for(const change of changes){const f=await publishedFixture(t);change(f);const before=JSON.stringify(f.engine.db);await assert.rejects(f.engine.confirmDeletedListing(f.plan.id,deletionRequest(f)));assert.equal(JSON.stringify(f.engine.db),before);}
});

test('a failed deletion snapshot retains the old journal, job and sales state on disk',async t=>{
 const f=await publishedFixture(t),before=fs.readFileSync(f.engine.file,'utf8'),old=JSON.stringify(f.engine.db);f.engine.persist=()=>{throw Error('Simulated deletion write failure');};
 await assert.rejects(f.engine.confirmDeletedListing(f.plan.id,deletionRequest(f)),{code:'PUBLICATION_STORAGE_FAILED'});assert.equal(f.engine.faulted,true);assert.equal(f.journal.faulted,true);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(JSON.stringify(f.engine.db),old);assert.equal(f.engine.plan(f.plan.id).completedCount,0);
});

test('stale listing revisions cannot run, retry or replace the current revision task',async t=>{
 const f=await fixture(t);f.plan.listingRevision=1;const old=f.engine.enqueue('listing',f.plan,{cycle:0,listingRevision:0},'listing:'+f.plan.id+':0');
 await assert.rejects(f.engine.runJob(old),{code:'LISTING_REVISION_CHANGED'});await f.engine.runOnce();assert.equal(old.state,'needs_review');assert.equal(old.blockedReason,'LISTING_REVISION_CHANGED');assert.equal(f.engine.canRetry(old),false);assert.equal(f.counts.listing,0);assert.equal(f.counts.claim,0);
});

test('deleted publication can be replaced and deleted again in one sales cycle with separate durable submission identities',async t=>{
 const f=await publishedFixture(t),{buildPublicationProof}=require('../src/vinted-publication.cjs');await f.engine.confirmDeletedListing(f.plan.id,deletionRequest(f));
 const plan=f.engine.plan(f.plan.id),account=f.engine.db.marketAccounts[0],claim=f.engine.db.claims[0],documentKey='replacement-document',at=new Date().toISOString();
 const evidence={...f.input.evidence,documentKey,tabId:'replacement-tab',observedAt:at,form:{...f.input.evidence.form,documentKey},photos:{...f.input.evidence.photos,documentKey},publication:{...f.input.evidence.publication,documentKey}};
 const proof=buildPublicationProof({...f.input,plan,claim,expectedAccount:account,evidence}),record=await f.journal.prepare(proof);await f.journal.dispatchOnce(record.id,proof,async()=>{});
 await f.journal.reconcile(record.id,{verified:true,mappingVerified:true,publicationStatus:'published',observedAt:new Date().toISOString(),profileId:plan.profileId,account:{...account,verified:true},seller:{...account,verified:true},ownedByCurrentAccount:true,listingId:'98766',url:'https://www.vinted.fr/items/98766',origin:{kind:'observed_submission_navigation',submissionId:record.id,formDocumentKey:documentKey},priceKind:'item',priceCents:plan.listingPriceCents,currency:'EUR',title:plan.listing.title,photos:{verified:true,count:1,signature:'a'.repeat(64)}});
 const current=f.engine.plan(plan.id),replacement=f.engine.db.jobs.find(row=>row.payload?.listingRevision===1);assert.equal(current.activeListingId,'98766');assert.equal(current.completedCount,0);assert.equal(replacement.state,'completed');assert.equal(replacement.result.submissionId,record.id);assert.equal(f.engine.db.publications.submissions.length,2);assert.equal(f.engine.db.claims[0].listings.length,2);
 await f.engine.confirmDeletedListing(plan.id,{submissionId:record.id,listingURL:'https://www.vinted.fr/items/98766',confirmed:true});assert.equal(f.engine.plan(plan.id).listingRevision,2);assert.equal(f.engine.plan(plan.id).completedCount,0);assert.equal(f.engine.db.jobs.filter(row=>row.state==='queued').length,1);assert.equal(f.engine.db.jobs.at(-1).dedupeKey,'listing:'+plan.id+':0:r2');assert.equal(f.engine.db.publications.submissions.every(row=>row.closedWithdrawal?.reason==='deleted_not_sold'),true);
});

test('deletion rejects a dedupe-matched job with a different cycle or revision without writing a snapshot',async t=>{
 for(const payload of [{cycle:1,listingRevision:0},{cycle:0,listingRevision:1},{}]){
  const f=await publishedFixture(t),job=f.engine.enqueue('listing',f.plan,payload,'listing:'+f.plan.id+':0');job.state='needs_review';f.engine.persist();const before=fs.readFileSync(f.engine.file,'utf8'),memory=JSON.stringify(f.engine.db);let writes=0;const persist=f.engine.persist.bind(f.engine);f.engine.persist=()=>{writes++;persist();};
  await assert.rejects(f.engine.confirmDeletedListing(f.plan.id,deletionRequest(f)),{code:'DELETION_JOB_CONFLICT'});assert.equal(writes,0);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(JSON.stringify(f.engine.db),memory);
 }
});

test('deletion rejects a globally duplicated original job ID even when the other row belongs to another profile',async t=>{
 const f=await publishedFixture(t),job=f.engine.enqueue('listing',f.plan,{cycle:0},'listing:'+f.plan.id+':0');job.state='needs_review';f.engine.db.jobs.push({...job,type:'message',profileId:'profile-2',planId:'other-plan',dedupeKey:'other-business-key'});f.engine.persist();const before=fs.readFileSync(f.engine.file,'utf8'),memory=JSON.stringify(f.engine.db);let writes=0;const persist=f.engine.persist.bind(f.engine);f.engine.persist=()=>{writes++;persist();};
 await assert.rejects(f.engine.confirmDeletedListing(f.plan.id,deletionRequest(f)),{code:'DELETION_JOB_CONFLICT'});assert.equal(writes,0);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(JSON.stringify(f.engine.db),memory);
});
