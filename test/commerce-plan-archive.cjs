'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const {deletePlan,restorePlan}=require('../src/commerce-deletion.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const listing={title:'Archive fixture accessory',description:'A confirmed fixture description.',condition:'Très bon état',brand:'Sans marque',color:'Noir',parcel:'Moyen',categoryPath:['Maison','Accessoires']};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-plan-archive-')),instances=[],calls=[];
 const adapter={readiness:()=>({salesOnly:true,capabilities:{publish:true,saleConfirmation:true}}),requireReady:async()=>{calls.push('ready');},executeJob:async()=>{calls.push('execute');},poll:async()=>{calls.push('poll');return [];}};
 const options={dir,profiles:()=>[{id:'archive-profile',name:'Fixture environment',status:'running',windowType:'automation'}],clientFactory:()=>{calls.push('supplier');throw Error('Archive must never contact a supplier');},adapter,seal:value=>value,unseal:value=>value};
 const create=()=>{const engine=new CommerceEngine(options);instances.push(engine);return engine;},engine=create();
 engine.db.products=[{id:'archive-product',sku:'ARCHIVE-SKU',name:'Fixture accessory',stock:3,priceCents:100,photoSetsAvailable:1}];engine.db.settings.backgroundEnabled=true;engine.db.encryptedToken='fixture-only';engine.db.supplierAccountId='fixture-provider';
 engine.bindMarketAccount('archive-profile',{verified:true,memberId:'123',username:'fixture_seller',profileURL:'https://www.vinted.fr/member/123'});
 const input={profileId:'archive-profile',productId:'archive-product',sku:'ARCHIVE-SKU',listingPriceCents:500,minOfferCents:400,targetCount:3,enabled:false,listing},plan=engine.savePlan(input);
 const addJob=(changes={})=>{const job=engine.enqueue('listing',engine.db.plans[0],{cycle:0,listingRevision:0},'listing:'+plan.id+':0');Object.assign(job,changes);engine.persist();return job;};
 t.after(async()=>{for(const item of instances){item.active.clear();item.running=false;item.ticking=false;await item.close();}const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('isola-plan-archive-'));fs.rmSync(resolved,{recursive:true,force:true});});
 return {dir,engine,plan,input,addJob,create,calls,options};
}
async function unchanged(f,action,code){const memory=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8');await assert.rejects(action,{code});assert.deepEqual(f.engine.db,memory);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.deepEqual(f.calls,[]);}
async function published(f){
 const {buildPublicationProof,FORM_URL}=require('../src/vinted-publication.cjs'),{publicationJournal}=require('../src/vinted-publish-submit.cjs'),engine=f.engine,plan=engine.db.plans[0],at=new Date().toISOString();plan.enabled=true;
 const account=engine.db.marketAccounts[0],claim={id:'original-claim',setId:'original-set',profileId:plan.profileId,productId:plan.productId,images:[{id:'original-image'}],listings:[]},documentKey='archive-fixture-document';engine.db.claims.push(claim);engine.persist();
 const evidence={profileId:plan.profileId,tabId:'archive-tab',documentKey,url:FORM_URL,observedAt:at,challenge:false,account:{...account,verified:true},form:{documentKey,complete:true,invalidFields:[],unknownFields:[],fields:Object.entries({...listing,priceCents:plan.listingPriceCents}).map(([field,value])=>({field,value,verified:true}))},photos:{documentKey,profileId:plan.profileId,productId:plan.productId,claimId:claim.id,setId:claim.setId,count:1,signature:'a'.repeat(64),verified:true,busy:false,errorCount:0},publication:{documentKey,count:1,observed:true,label:'Ajouter',enabled:true}};
 const journal=publicationJournal(engine),proof=buildPublicationProof({plan,product:engine.db.products[0],claim,expectedAccount:account,evidence}),record=await journal.prepare(proof);await journal.dispatchOnce(record.id,proof,async()=>{});
 await journal.reconcile(record.id,{verified:true,mappingVerified:true,publicationStatus:'published',observedAt:new Date().toISOString(),profileId:plan.profileId,account:{...account,verified:true},seller:{...account,verified:true},ownedByCurrentAccount:true,listingId:'98765',url:'https://www.vinted.fr/items/98765',origin:{kind:'observed_submission_navigation',submissionId:record.id,formDocumentKey:documentKey},priceKind:'item',priceCents:plan.listingPriceCents,currency:'EUR',title:listing.title,photos:{verified:true,count:1,signature:'a'.repeat(64)}});
 return {record,journal};
}

test('legacy databases acquire an empty archive collection without changing plan identities',async t=>{
 const f=fixture(t);await f.engine.close();const stored=JSON.parse(fs.readFileSync(f.engine.file,'utf8'));delete stored.planArchives;fs.writeFileSync(f.engine.file,JSON.stringify(stored));const reopened=f.create();assert.deepEqual(reopened.db.planArchives,[]);assert.equal(reopened.db.plans[0].id,f.plan.id);assert.equal(reopened.state().plans[0].archived,false);assert.equal(reopened.state().plans[0].archivedAt,null);
});

test('a failed catalog check is archived durably without deleting its original task or dedupe history',async t=>{
 const f=fixture(t),job=f.addJob({state:'needs_review',step:'check_catalog',error:'Original account check failed',attempts:2,blockedReason:'ACCOUNT_UNVERIFIED'}),before=clone(job);f.engine.db.plans[0].enabled=true;f.engine.persist();
 assert.deepEqual(await deletePlan(f.engine,f.plan.id),{deleted:true,id:f.plan.id,archived:true});assert.deepEqual(f.engine.db.jobs,[before]);assert.equal(f.engine.db.plans[0].enabled,false);assert.equal(f.engine.db.plans[0].status,'paused');const marker=clone(f.engine.db.planArchives[0]);assert.equal(marker.planId,f.plan.id);assert.equal(new Date(marker.archivedAt).toISOString(),marker.archivedAt);
 assert.equal((await deletePlan(f.engine,f.plan.id)).archived,true);assert.deepEqual(f.engine.db.planArchives,[marker]);await f.engine.close();const reopened=f.create();assert.deepEqual(reopened.db.jobs,[before]);assert.deepEqual(reopened.db.planArchives,[marker]);assert.equal(reopened.running,false);assert.equal(reopened.timer,null);assert.equal(reopened.db.plans[0].enabled,false);assert.equal(reopened.state().jobs[0].canRetry,false);assert.deepEqual(f.calls,[]);
 const dto=reopened.state().plans[0];dto.listing.title='Renderer mutation';dto.archivedAt='changed';assert.deepEqual(reopened.db.planArchives,[marker]);assert.equal(reopened.db.plans[0].listing.title,listing.title);
});

test('archiving cancels only the exact unsent queued task and keeps every business identifier',async t=>{
 const f=fixture(t),job=f.addJob({retryAt:new Date(Date.now()+30000).toISOString()}),before=clone(job);const unrelated={...clone(job),id:'unrelated-job',planId:'unrelated-plan',profileId:'other-profile',productId:'other-product',dedupeKey:'unrelated-key'};f.engine.db.jobs.push(unrelated);f.engine.persist();await deletePlan(f.engine,f.plan.id);
 const kept=f.engine.db.jobs[0];assert.equal(kept.state,'cancelled');assert.equal(kept.blockedReason,'PLAN_ARCHIVED');assert.equal(kept.retryAt,null);assert.equal(kept.id,before.id);assert.equal(kept.dedupeKey,before.dedupeKey);assert.deepEqual(kept.payload,before.payload);assert.equal(kept.operation,null);assert.equal(kept.result,null);assert.deepEqual(f.engine.db.jobs[1],unrelated);assert.deepEqual(f.calls,[]);
});

test('restoring keeps a cancelled task disabled until explicit start requeues its original identity',async t=>{
 const f=fixture(t),job=f.addJob();await deletePlan(f.engine,f.plan.id);const archivedJob=clone(f.engine.db.jobs[0]);assert.deepEqual(await restorePlan(f.engine,f.plan.id),{restored:true,id:f.plan.id});assert.deepEqual(f.engine.db.jobs,[archivedJob]);assert.deepEqual(f.engine.db.planArchives,[]);assert.equal(f.engine.plan(f.plan.id).enabled,false);assert.equal(f.engine.state().plans[0].archived,false);assert.equal(f.engine.timer,null);assert.equal(f.engine.running,false);
 const started=f.engine.startPlan(f.plan.id);assert.deepEqual(started.resumedJobIds,[job.id]);assert.equal(f.engine.db.jobs.length,1);assert.equal(f.engine.db.jobs[0].id,job.id);assert.equal(f.engine.db.jobs[0].dedupeKey,job.dedupeKey);assert.deepEqual(f.engine.db.jobs[0].payload,job.payload);assert.equal(f.engine.db.jobs[0].state,'queued');assert.equal(f.engine.plan(f.plan.id).enabled,true);f.engine.setRunning(false);assert.deepEqual(f.calls,[]);
 await f.engine.close();const reopened=f.create();assert.equal(reopened.db.plans[0].enabled,true);assert.equal(reopened.db.jobs[0].id,job.id);assert.equal(reopened.db.jobs[0].state,'queued');assert.equal(reopened.running,false);
});

test('archived plans reject every explicit edit, start, event and task action before any external call',async t=>{
 const f=fixture(t),job=f.addJob({state:'needs_review',step:'check_catalog'});await deletePlan(f.engine,f.plan.id);const plan=f.engine.db.plans[0],memory=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8');
 for(const action of [()=>f.engine.plan(plan.id),()=>f.engine.preparePlan({...f.input,id:plan.id}),()=>f.engine.savePlan({...f.input,id:plan.id}),()=>f.engine.saveAndStartPlan({...f.input,id:plan.id}),()=>f.engine.startPlan(plan.id),()=>f.engine.assertPlanStart(plan),()=>f.engine.setPlanEnabled(plan.id,true),()=>f.engine.enqueue('listing',plan,{},'new-key'),()=>f.engine.eventInput(plan.id,{}),()=>f.engine.ingestEvent(plan.id,{})])assert.throws(action,{code:'PLAN_ARCHIVED'});
 for(const action of ['retry','cancel','reconcile'])await assert.rejects(f.engine.resolve(job.id,action),{code:'PLAN_ARCHIVED'});await assert.rejects(f.engine.runJob(f.engine.db.jobs[0]),{code:'PLAN_ARCHIVED'});await assert.rejects(f.engine.confirmDeletedListing(plan.id,{}),{code:'PLAN_ARCHIVED'});assert.equal(f.engine.canRetry(f.engine.db.jobs[0]),false);assert.equal(f.engine.planInScope(plan.id,null),false);assert.equal(f.engine.plan(plan.id,{includeArchived:true}),plan);
 assert.deepEqual(f.engine.db,memory);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.deepEqual(f.calls,[]);
});

test('archived identities still prohibit recreating the same product and environment with a fresh plan ID',async t=>{
 const f=fixture(t);f.addJob({state:'needs_review'});await deletePlan(f.engine,f.plan.id);for(const action of [()=>f.engine.savePlan(f.input),()=>f.engine.saveAndStartPlan(f.input)])assert.throws(action,{code:'PLAN_ARCHIVED',message:/恢复/});assert.equal(f.engine.db.plans.length,1);assert.equal(f.engine.db.plans[0].id,f.plan.id);assert.equal(f.engine.db.jobs.length,1);
});

test('seed, poll and scheduler selection exclude archive markers even if an in-memory enabled flag is corrupted',async t=>{
 const f=fixture(t);f.addJob();await deletePlan(f.engine,f.plan.id);f.engine.db.plans[0].enabled=true;f.engine.db.jobs[0].state='queued';const before=clone(f.engine.db.jobs);f.engine.seed();f.engine.running=true;await f.engine.runOnce();f.engine.running=false;assert.deepEqual(f.engine.db.jobs,before);assert.deepEqual(f.calls,[]);assert.equal(f.engine.active.size,0);f.engine.db.plans[0].enabled=false;f.engine.db.jobs[0].state='cancelled';f.engine.persist();
});

test('open or unknown side effects and unfinished sales cannot be hidden behind archive markers',async t=>{
 const scenarios=[
  ['running',f=>f.addJob({state:'running'}),'DELETION_JOB_HISTORY'],
  ['uncertain',f=>f.addJob({state:'uncertain'}),'DELETION_JOB_HISTORY'],
  ['mutation pending',f=>f.addJob({state:'needs_review',mutationPending:true}),'DELETION_JOB_HISTORY'],
  ['unresolved operation',f=>f.addJob({state:'needs_review',operation:{kind:'publish'}}),'DELETION_JOB_HISTORY'],
  ['contradictory completed operation',f=>f.addJob({state:'completed',operation:{kind:'publish'},result:{externalId:'98765'}}),'DELETION_JOB_HISTORY'],
  ['unresolved result',f=>f.addJob({state:'needs_review',result:{externalId:'98765'}}),'DELETION_JOB_HISTORY'],
  ['publish step without receipt',f=>f.addJob({state:'needs_review',step:'publish_listing'}),'DELETION_JOB_HISTORY'],
  ['verify step without receipt',f=>f.addJob({state:'cancelled',step:'verify_listing'}),'DELETION_JOB_HISTORY'],
  ['unknown step',f=>f.addJob({state:'needs_review',step:'unrecognized'}),'DELETION_JOB_HISTORY'],
  ['unfinished sale',f=>{const job=f.addJob({type:'sale_confirmation',state:'needs_review'});f.engine.db.plans[0].completedCount=1;f.engine.db.sales.push({planId:f.plan.id,jobId:job.id,platformOrderId:'fixture-order'});},'DELETION_SALE_HISTORY'],
  ['pending association',f=>f.engine.db.publicationSupplierSync.push({id:'sync',planId:f.plan.id,state:'pending'}),'DELETION_SUPPLIER_HISTORY'],
  ['unknown photo claim',f=>f.engine.db.photoPreparations.push({planId:f.plan.id,profileId:f.plan.profileId,productId:f.plan.productId,state:'uncertain'}),'DELETION_PHOTO_HISTORY'],
  ['reservation',f=>f.engine.db.reservations.push({planId:f.plan.id,jobId:'missing',cents:500}),'DELETION_RESERVATION_HISTORY']
 ];
 for(const [label,change,code] of scenarios)await t.test(label,async sub=>{const f=fixture(sub);change(f);f.engine.persist();await unchanged(f,()=>deletePlan(f.engine,f.plan.id),code);assert.deepEqual(f.engine.db.planArchives,[]);});
});

test('mismatched plan relationships or duplicate global job IDs and keys never cancel another task',async t=>{
 for(const kind of ['different plan','different profile','duplicate id','duplicate key'])await t.test(kind,async sub=>{const f=fixture(sub),job=f.addJob();if(kind==='different plan')job.planId='other-plan';if(kind==='different profile')job.profileId='other-profile';if(kind==='duplicate id'||kind==='duplicate key')f.engine.db.jobs.push({...clone(job),id:kind==='duplicate id'?job.id:'other-job',dedupeKey:kind==='duplicate key'?job.dedupeKey:'other-key',planId:'other-plan',profileId:'other-profile',productId:'other-product'});f.engine.persist();await unchanged(f,()=>deletePlan(f.engine,f.plan.id),'DELETION_JOB_HISTORY');assert.equal(f.engine.db.jobs[0].state,'queued');});
});

test('a genuinely closed publication and cancelled listing-deletion receipt can be archived and restored across restart',async t=>{
 const f=fixture(t),{record}=await published(f);await unchanged(f,()=>deletePlan(f.engine,f.plan.id),'DELETION_ACTIVE_LISTING');await f.engine.confirmDeletedListing(f.plan.id,{submissionId:record.id,listingURL:'https://www.vinted.fr/items/98765',confirmed:true});
 const original=clone({publications:f.engine.db.publications,claims:f.engine.db.claims,oldJob:f.engine.db.jobs[0],outbox:f.engine.db.publicationSupplierSync}),next=f.engine.db.jobs[1];assert.equal(original.oldJob.result.kind,'listing_deleted');assert.equal(next.state,'queued');assert.equal((await deletePlan(f.engine,f.plan.id)).archived,true);assert.deepEqual(f.engine.db.jobs[0],original.oldJob);assert.equal(f.engine.db.jobs[1].state,'cancelled');assert.deepEqual(f.engine.db.publications,original.publications);assert.deepEqual(f.engine.db.claims,original.claims);assert.deepEqual(f.engine.db.publicationSupplierSync,original.outbox);assert.equal(f.engine.db.plans[0].listingRevision,1);assert.equal(f.engine.db.plans[0].completedCount,0);
 await f.engine.close();const reopened=f.create();assert.deepEqual(reopened.db.publications,original.publications);assert.deepEqual(reopened.db.claims,original.claims);assert.deepEqual(reopened.db.jobs[0],original.oldJob);assert.equal(reopened.state().plans[0].archived,true);await restorePlan(reopened,f.plan.id);assert.equal(reopened.db.plans[0].enabled,false);assert.equal(reopened.db.jobs[1].id,next.id);assert.equal(reopened.db.jobs[1].state,'cancelled');assert.equal(reopened.canRetry(reopened.db.jobs[0]),false);assert.deepEqual(f.calls,[]);
});

test('a forged or mismatching closed-listing task receipt cannot authorize archiving',async t=>{
 for(const kind of ['review id','submission id','listing id','cycle','extra verification'])await t.test(kind,async sub=>{const f=fixture(sub),{record}=await published(f);await f.engine.confirmDeletedListing(f.plan.id,{submissionId:record.id,listingURL:'https://www.vinted.fr/items/98765',confirmed:true});const old=f.engine.db.jobs[0];if(kind==='review id')old.deletion.reviewId='wrong';if(kind==='submission id')old.result.submissionId='wrong';if(kind==='listing id')old.result.externalId='87654';if(kind==='cycle')old.payload.cycle=1;if(kind==='extra verification')old.deletion.verified=true;f.engine.persist();await unchanged(f,()=>deletePlan(f.engine,f.plan.id),'DELETION_JOB_HISTORY');});
});

test('a fully verified original sale may be archived without erasing fulfillment or increasing completed counts',async t=>{
 const f=fixture(t),job=f.addJob({type:'sale_confirmation',state:'completed',step:'verified',payload:{id:'original-order'},result:{verified:true,externalId:'original-order',kind:'sale_confirmation'}});f.engine.db.plans[0].completedCount=1;f.engine.db.sales.push({planId:f.plan.id,jobId:job.id,platformOrderId:'original-order',listingId:'98765'});f.engine.persist();const sales=clone(f.engine.db.sales),jobs=clone(f.engine.db.jobs);await deletePlan(f.engine,f.plan.id);assert.deepEqual(f.engine.db.sales,sales);assert.deepEqual(f.engine.db.jobs,jobs);assert.equal(f.engine.db.plans[0].completedCount,1);await f.engine.close();const reopened=f.create();assert.deepEqual(reopened.db.sales,sales);assert.deepEqual(reopened.db.jobs,jobs);assert.equal(reopened.state().plans[0].archived,true);
});

test('invalid archive records fail before startup recovery and preserve the original file exactly',async t=>{
 const scenarios=[['not array',db=>db.planArchives={}],['duplicate',db=>db.planArchives.push(clone(db.planArchives[0]))],['extra field',db=>db.planArchives[0].enabled=true],['missing original',db=>db.planArchives[0].planId='missing'],['invalid time',db=>db.planArchives[0].archivedAt='yesterday'],['noncanonical time',db=>db.planArchives[0].archivedAt='2026-10-15'],['enabled plan',db=>db.plans[0].enabled=true],['queued task',db=>db.jobs[0].state='queued'],['running task',db=>db.jobs[0].state='running'],['uncertain task',db=>db.jobs[0].state='uncertain'],['mutation pending',db=>db.jobs[0].mutationPending=true],['active listing',db=>db.plans[0].activeListingId='98765'],['pending sale',db=>db.plans[0].completedCount=1]];
 for(const [label,change] of scenarios)await t.test(label,async sub=>{const f=fixture(sub);f.addJob({state:'needs_review',step:'check_catalog'});await deletePlan(f.engine,f.plan.id);await f.engine.close();const db=JSON.parse(fs.readFileSync(f.engine.file,'utf8'));change(db);const source=JSON.stringify(db,null,2);fs.writeFileSync(f.engine.file,source);assert.throws(()=>f.create(),{code:'PLAN_ARCHIVE_INVALID'});assert.equal(fs.readFileSync(f.engine.file,'utf8'),source);assert.deepEqual(f.calls,[]);});
});

test('archive and restore durable failures roll back arrays, markers and events without discarding fault status',async t=>{
 for(const kind of ['archive','restore'])await t.test(kind,async sub=>{const f=fixture(sub);f.addJob();if(kind==='restore')await deletePlan(f.engine,f.plan.id);const original={plans:f.engine.db.plans,jobs:f.engine.db.jobs,planArchives:f.engine.db.planArchives,events:f.engine.db.events},memory=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8');f.engine.persist=()=>{f.engine.faulted=true;throw Error('Fixture durable failure');};await assert.rejects(kind==='archive'?deletePlan(f.engine,f.plan.id):restorePlan(f.engine,f.plan.id),/durable failure/);for(const key of Object.keys(original))assert.equal(f.engine.db[key],original[key]);assert.deepEqual(f.engine.db,memory);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.equal(f.engine.faulted,true);});
});

test('restore is explicit, serialized and refuses busy or changed business records',async t=>{
 const f=fixture(t);await unchanged(f,()=>restorePlan(f.engine,f.plan.id),'PLAN_NOT_ARCHIVED');f.addJob();await deletePlan(f.engine,f.plan.id);f.engine.running=true;await unchanged(f,()=>restorePlan(f.engine,f.plan.id),'DELETION_BUSY');f.engine.running=false;f.engine.db.plans[0].activeListingId='98765';f.engine.persist();await unchanged(f,()=>restorePlan(f.engine,f.plan.id),'DELETION_ACTIVE_LISTING');f.engine.db.plans[0].activeListingId=null;f.engine.persist();const first=restorePlan(f.engine,f.plan.id);await assert.rejects(restorePlan(f.engine,f.plan.id),{code:'DELETION_BUSY'});await first;await unchanged(f,()=>restorePlan(f.engine,f.plan.id),'PLAN_NOT_ARCHIVED');
});
