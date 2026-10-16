'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const {deletePlan,restorePlan}=require('../src/commerce-deletion.cjs');
const {listingJobKey}=require('../src/vinted-publication.cjs');
const {VintedSalesRuntime}=require('../src/vinted-sales-runtime.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const listing={title:'Original recovery fixture',description:'A confirmed item in an isolated fixture.',categoryPath:['Maison','Accessoires'],condition:'Très bon état',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
function fixture(t,{sessionListing=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-plan-recovery-')),executed=[],reads=[],profiles=[1,2].map(n=>({id:'recovery-profile-'+n,name:'Recovery fixture '+n,status:'closed',windowType:'automation'}));
 const adapter={readiness:()=>({salesOnly:true,capabilities:{publish:true,autoOpenProfile:true,sessionListing}}),requireReady:async()=>{},poll:async()=>[],executeJob:async({job,plan})=>{executed.push({id:job.id,dedupeKey:job.dedupeKey,planId:plan.id,listing:clone(plan.listing),price:plan.listingPriceCents});plan.activeListingId='123456';job.result={externalId:'123456'};}};
 const engine=new CommerceEngine({dir,profiles:()=>profiles,adapter,clientFactory:()=>{reads.push('supplier');throw Error('No external requests allowed');},seal:value=>value,unseal:value=>value});
 engine.db.settings.backgroundEnabled=true;engine.db.settings.maxConcurrent=2;engine.db.encryptedToken='fixture-only';engine.db.supplierAccountId='fixture-only-provider';engine.db.products=[1,2].map(n=>({id:'recovery-product-'+n,sku:'RECOVERY-'+n,name:'Recovery product '+n,stock:3,priceCents:100,photoSetsAvailable:1}));
 for(const n of [1,2])engine.bindMarketAccount('recovery-profile-'+n,{verified:true,memberId:String(100+n),username:'recovery_fixture_'+n,profileURL:'https://www.vinted.fr/member/'+(100+n)});
 const add=(extra={})=>engine.savePlan({profileId:profiles[0].id,productId:'recovery-product-1',sku:'RECOVERY-1',listing,listingPriceCents:500,minOfferCents:400,targetCount:2,enabled:false,...extra});
 const plan=add(),job=(extra={},owner=plan)=>{const row=engine.enqueue('listing',owner,{cycle:owner.completedCount,listingRevision:owner.listingRevision},listingJobKey(owner.id,owner.completedCount,owner.listingRevision));Object.assign(row,extra);engine.persist();return row;};
 const settled=async count=>{const end=Date.now()+2000;while(engine.ticking||executed.length<count){if(Date.now()>end)throw Error('Recovery fixture scheduler did not settle');await new Promise(resolve=>setTimeout(resolve,5));}};
 t.after(async()=>{engine.ticking=false;engine.tickPromise=null;engine.active.clear();for(const lease of engine.leases.snapshot())engine.leases.release(lease);await engine.close();const absolute=path.resolve(dir);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.ok(path.basename(absolute).startsWith('isola-plan-recovery-'));fs.rmSync(absolute,{recursive:true,force:true});});
 return {engine,profiles,plan,add,job,executed,reads,settled};
}

test('explicit start continues the exact queued task without creating or resetting a second task',async t=>{
 const f=fixture(t),job=f.job(),before=clone(job),other=f.add({profileId:f.profiles[1].id,enabled:true}),result=f.engine.startPlan(f.plan.id);assert.deepEqual(result.resumedJobIds,[]);assert.equal(f.engine.db.jobs[0],job);assert.equal(job.id,before.id);assert.equal(job.dedupeKey,before.dedupeKey);assert.deepEqual(job.payload,before.payload);await f.settled(1);assert.deepEqual(f.executed.map(row=>row.id),[job.id]);assert.equal(f.engine.db.jobs.length,1);assert.equal(f.engine.db.jobs.some(row=>row.planId===other.id),false);assert.deepEqual(f.engine.state().runningPlanIds,[f.plan.id]);assert.deepEqual(f.reads,[]);
});

test('start restores the archived then recovered cancelled pending job in the same durable start snapshot',async t=>{
 const f=fixture(t),job=f.job(),before=clone(job);await deletePlan(f.engine,f.plan.id);assert.equal(f.engine.db.jobs[0].state,'cancelled');await restorePlan(f.engine,f.plan.id);assert.equal(f.engine.plan(f.plan.id).enabled,false);assert.equal(f.engine.running,false);assert.deepEqual(f.executed,[]);
 const result=f.engine.startPlan(f.plan.id);assert.deepEqual(result.resumedJobIds,[job.id]);const disk=JSON.parse(fs.readFileSync(f.engine.file,'utf8'));assert.equal(disk.plans[0].enabled,true);assert.equal(disk.jobs.length,1);assert.equal(disk.jobs[0].state,'queued');assert.equal(disk.jobs[0].id,before.id);assert.equal(disk.jobs[0].dedupeKey,before.dedupeKey);assert.deepEqual(disk.jobs[0].payload,before.payload);await f.settled(1);assert.deepEqual(f.executed.map(row=>row.id),[job.id]);assert.equal(f.engine.db.jobs.length,1);
});

test('an explicit start recovers only the original safe needs-review, cancelled or rejected task',async t=>{
 for(const state of ['needs_review','cancelled','rejected'])await t.test(state,async sub=>{const f=fixture(sub),job=f.job({state,step:'check_catalog',attempts:3,retryAt:new Date(Date.now()+60000).toISOString(),error:'Earlier read failed',blockedReason:'ACCOUNT_UNVERIFIED'}),before=clone(job),result=f.engine.startPlan(f.plan.id);assert.deepEqual(result.resumedJobIds,[job.id]);assert.equal(job.state,'queued');assert.equal(job.attempts,0);assert.equal(job.retryAt,null);assert.equal(job.blockedReason,null);assert.equal(job.id,before.id);assert.equal(job.dedupeKey,before.dedupeKey);assert.deepEqual(job.payload,before.payload);await f.settled(1);assert.equal(f.engine.db.jobs.length,1);assert.deepEqual(f.executed.map(row=>row.id),[before.id]);});
});

test('save and start can edit safe pending fields and recover the same task using the new plan snapshot',async t=>{
 const f=fixture(t),job=f.job({state:'needs_review',step:'prepare_listing'}),before=clone(job),result=f.engine.saveAndStartPlan({...f.plan,listingPriceCents:700,minOfferCents:600,listing:{...listing,title:'Updated unsubmitted title'}});assert.deepEqual(result.resumedJobIds,[job.id]);await f.settled(1);assert.equal(f.engine.db.jobs.length,1);assert.equal(f.executed[0].id,before.id);assert.equal(f.executed[0].dedupeKey,before.dedupeKey);assert.equal(f.executed[0].price,700);assert.equal(f.executed[0].listing.title,'Updated unsubmitted title');assert.deepEqual(job.payload,before.payload);
});

test('the current plan may explicitly resume its safe manual stop without clearing another plan stop',async t=>{
 const f=fixture(t),job=f.job({state:'needs_review',blockedReason:'PROFILE_CLOSED'}),other=f.add({productId:'recovery-product-2',sku:'RECOVERY-2'}),held=f.job({state:'needs_review',blockedReason:'PROFILE_STOPPED'},other),before=clone(f.engine.db);assert.throws(()=>f.engine.startPlan(f.plan.id),{code:'PROFILE_MANUALLY_PAUSED'});assert.deepEqual(f.engine.db,before);assert.equal(held.state,'needs_review');assert.deepEqual(f.executed,[]);await f.engine.resolve(held.id,'cancel');const result=f.engine.startPlan(f.plan.id);assert.deepEqual(result.resumedJobIds,[job.id]);await f.settled(1);assert.equal(held.state,'cancelled');assert.deepEqual(f.executed.map(row=>row.id),[job.id]);
});

test('unsafe evidence, submission steps, identity conflicts and stale cycles never recover or change the original snapshot',async t=>{
 const scenarios=[
  ['unknown state',job=>job.state='uncertain'],['operation',job=>job.operation={kind:'publish'}],['mutation pending',job=>job.mutationPending=true],['result',job=>job.result={externalId:'original-item'}],
  ...['publish_listing','verify_listing','send_reply','create_supplier_order','claim_photos'].map(step=>[step,job=>job.step=step]),
  ['old cycle',job=>job.payload.cycle=1],['old revision',job=>job.payload.listingRevision=1],['wrong profile',job=>job.profileId='recovery-profile-2'],['wrong product',job=>job.productId='recovery-product-2'],['wrong sku',job=>job.sku='CHANGED'],['wrong dedupe',job=>job.dedupeKey='new-key'],['wrong member',job=>job.accountMemberId='999'],['unknown photo claim',job=>job.payload.claimId='other-claim'],['duplicate ID',(job,f)=>f.engine.db.jobs.push({...clone(job),dedupeKey:'other-key'})],['duplicate dedupe',(job,f)=>f.engine.db.jobs.push({...clone(job),id:'other-job'})]
 ];
 for(const [label,change] of scenarios)await t.test(label,async sub=>{const f=fixture(sub),job=f.job({state:'needs_review'});change(job,f);f.engine.persist();const before=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8');assert.equal(f.engine.canRetry(job),false);assert.throws(()=>f.engine.startPlan(f.plan.id));await assert.rejects(f.engine.resolve(job.id,'retry'));assert.deepEqual(f.engine.db,before);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.equal(f.engine.running,false);assert.equal(f.engine.timer,null);assert.deepEqual(f.executed,[]);assert.deepEqual(f.reads,[]);});
});

test('idle plan edits and retry remain available while another environment is running or stopping',async t=>{
 const f=fixture(t),job=f.job({state:'rejected'}),other=f.add({profileId:f.profiles[1].id,enabled:true}),foreign=f.job({state:'uncertain',operation:{kind:'publish'},mutationPending:true},other),foreignBefore=clone(foreign);f.engine.running=true;f.engine.runningPlanIds=new Set([other.id]);f.engine.ticking=true;f.engine.active.set(other.profileId,new AbortController());let kicks=0;f.engine.kickRun=()=>{kicks++;};
 assert.equal(f.engine.savePlan({...f.plan,listingPriceCents:800,minOfferCents:700}).listingPriceCents,800);await f.engine.resolve(job.id,'retry');assert.equal(job.state,'queued');assert.equal(job.id,f.engine.db.jobs[0].id);assert.equal(f.engine.plan(f.plan.id).enabled,false);assert.deepEqual(f.engine.state().runningPlanIds,[other.id]);assert.deepEqual(foreign,foreignBefore);assert.equal(kicks,1);assert.deepEqual(f.executed,[]);assert.deepEqual(f.reads,[]);
});

test('starting a different environment is not blocked by an unrelated unknown task or stopping controller',async t=>{
 const f=fixture(t),job=f.job({state:'cancelled'}),other=f.add({profileId:f.profiles[1].id}),foreign=f.job({state:'uncertain',mutationPending:true,operation:{kind:'publish'}},other),before=clone(foreign);f.engine.active.set(other.profileId,new AbortController());let kicks=0;f.engine.kickRun=()=>{kicks++;};const result=f.engine.startPlan(f.plan.id);assert.deepEqual(result.resumedJobIds,[job.id]);assert.deepEqual(result.state.runningPlanIds,[f.plan.id]);assert.equal(job.state,'queued');assert.deepEqual(foreign,before);assert.equal(kicks,1);assert.deepEqual(f.executed,[]);assert.deepEqual(f.reads,[]);
});

test('a lease in the target environment still blocks edit or task changes until its original action stops',async t=>{
 const f=fixture(t),job=f.job({state:'needs_review'}),lease=f.engine.leases.acquire(f.plan.profileId,'poll:owned'),before=clone(f.engine.db);assert.throws(()=>f.engine.savePlan({...f.plan,listingPriceCents:800}),/执行中或已提交/);assert.throws(()=>f.engine.startPlan(f.plan.id),{code:'PAGE_BUSY'});await assert.rejects(f.engine.resolve(job.id,'retry'),/运行任务/);assert.deepEqual(f.engine.db,before);f.engine.leases.release(lease);assert.deepEqual(f.executed,[]);
});

test('a failed durable start restores the cancelled task, plan, scope and events without starting work',async t=>{
 const f=fixture(t),job=f.job({state:'cancelled',blockedReason:'PLAN_ARCHIVED',error:'Previously archived'}),before=clone(f.engine.db),scope=f.engine.runningPlanIds,persist=f.engine.persist;f.engine.persist=()=>{f.engine.faulted=true;throw Error('fixture start disk failure');};assert.throws(()=>f.engine.startPlan(f.plan.id),/disk failure/);assert.deepEqual(f.engine.db,before);assert.equal(f.engine.db.jobs[0],job);assert.equal(f.engine.runningPlanIds,scope);assert.equal(f.engine.running,false);assert.equal(f.engine.timer,null);assert.deepEqual(f.executed,[]);f.engine.persist=persist;f.engine.faulted=false;
});

const evidenceBlocked={state:'needs_review',step:'publish_listing',blockedReason:'PUBLICATION_EVIDENCE_BLOCKED'};
function publicationMetadata(f,changes={}){return {id:'fixture-publication-record',state:'cancelled',attemptCount:0,proof:{facts:{planId:f.plan.id,profileId:f.plan.profileId,productId:f.plan.productId,cycle:f.plan.completedCount,listingRevision:f.plan.listingRevision}},...changes};}

test('explicit session start resumes the exact evidence-blocked job only when its current journal has no records',async t=>{
 const f=fixture(t,{sessionListing:true});f.plan.listingRevision=1;const claim={id:'original-photo-claim',profileId:f.plan.profileId,productId:f.plan.productId,setId:'original-photo-set',images:[{id:'original-image'}],listings:[]};f.engine.db.claims.push(claim);const job=f.job(evidenceBlocked);job.payload.claimId=claim.id;f.engine.persist();
 const original=clone(job),claims=JSON.stringify(f.engine.db.claims),photos=JSON.stringify(f.engine.db.photoPreparations);assert.equal(f.engine.canRetry(job),true);const result=f.engine.startPlan(f.plan.id);assert.deepEqual(result.resumedJobIds,[original.id]);assert.equal(job.state,'queued');assert.equal(job.step,'pending');assert.equal(job.id,original.id);assert.equal(job.dedupeKey,original.dedupeKey);assert.deepEqual(job.payload,original.payload);assert.equal(f.plan.listingRevision,1);assert.equal(JSON.stringify(f.engine.db.claims),claims);assert.equal(JSON.stringify(f.engine.db.photoPreparations),photos);assert.equal(f.engine.db.jobs.length,1);
 const disk=JSON.parse(fs.readFileSync(f.engine.file,'utf8'));assert.equal(disk.jobs.length,1);assert.equal(disk.jobs[0].id,original.id);assert.equal(disk.jobs[0].step,'pending');assert.equal(disk.publications.submissions.length,0);await f.settled(1);assert.deepEqual(f.executed.map(row=>row.id),[original.id]);assert.deepEqual(f.reads,[]);
});

test('the optional-field step is recoverable only for a listing with no current publication record',async t=>{
 for(const state of ['needs_review','cancelled','rejected']){const f=fixture(t),job=f.job({state,step:'check_optional_fields',blockedReason:'OPTIONAL_MATERIAL_UNVERIFIED'});assert.equal(f.engine.canRetry(job),true);const result=f.engine.startPlan(f.plan.id);assert.deepEqual(result.resumedJobIds,[job.id]);await f.settled(1);assert.deepEqual(f.executed.map(row=>row.id),[job.id]);}
 for(const type of ['message','offer','fulfillment','sale_confirmation']){const f=fixture(t),job=f.job({state:'needs_review',step:'check_optional_fields',type});assert.equal(f.engine.canRetry(job),false);assert.throws(()=>f.engine.startPlan(f.plan.id));assert.deepEqual(f.executed,[]);}
});

test('a publish-step exception never applies to non-session drivers, other states, steps or failure reasons',async t=>{
 const scenarios=[['not session',{},false],...['queued','cancelled','rejected','uncertain','completed'].map(state=>[state,{state},true]),...['verify_listing','send_reply','create_supplier_order','claim_photos'].map(step=>[step,{step},true]),...[undefined,'OPTIONAL_MATERIAL_UNVERIFIED','PUBLICATION_UNKNOWN_RESULT','PUBLICATION_EVIDENCE_CHANGED','STOPPED'].map(blockedReason=>[String(blockedReason),{blockedReason},true]),['wrong type',{type:'message'},true]];
 for(const [label,changes,sessionListing] of scenarios)await t.test(label,async sub=>{const f=fixture(sub,{sessionListing}),job=f.job({...evidenceBlocked,...changes});if(Object.hasOwn(changes,'blockedReason')&&changes.blockedReason===undefined)delete job.blockedReason;const before=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8');assert.equal(f.engine.canRetry(job),false);assert.throws(()=>f.engine.startPlan(f.plan.id));await assert.rejects(f.engine.resolve(job.id,'retry'));assert.deepEqual(f.engine.db,before);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.equal(f.engine.timer,null);assert.deepEqual(f.executed,[]);});
});

test('late pre-submit recovery retains all original operation, identity, cycle, revision and claim guards',async t=>{
 const scenarios=[['operation',job=>job.operation={kind:'publish'}],['result',job=>job.result={externalId:'original'}],['mutation',job=>job.mutationPending=true],['cycle',job=>job.payload.cycle=1],['revision',job=>job.payload.listingRevision=1],['dedupe',job=>job.dedupeKey='wrong'],['profile',job=>job.profileId='other'],['product',job=>job.productId='other'],['sku',job=>job.sku='wrong'],['claim',job=>job.payload.claimId='missing-claim'],['foreign claim',(job,f)=>{job.payload.claimId='foreign-claim';f.engine.db.claims.push({id:'foreign-claim',profileId:'other-profile',productId:f.plan.productId});}],['duplicate ID',(job,f)=>f.engine.db.jobs.push({...clone(job),dedupeKey:'different'})],['duplicate key',(job,f)=>f.engine.db.jobs.push({...clone(job),id:'different'})]];
 for(const [label,change] of scenarios)await t.test(label,async sub=>{const f=fixture(sub,{sessionListing:true}),job=f.job(evidenceBlocked);change(job,f);f.engine.persist();const before=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8');assert.equal(f.engine.canRetry(job),false);assert.throws(()=>f.engine.startPlan(f.plan.id));await assert.rejects(f.engine.resolve(job.id,'retry'));assert.deepEqual(f.engine.db,before);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.deepEqual(f.executed,[]);});
});

test('any current-cycle publication record forbids both late steps even when cancelled, closed or zero-attempt',async t=>{
 const records=[{state:'prepared',attemptCount:0},{state:'needs_review',attemptCount:0},{state:'cancelled',attemptCount:0},{state:'cancelled',attemptCount:1},{state:'dispatching',attemptCount:1},{state:'uncertain',attemptCount:1},{state:'published',attemptCount:1},{state:'published',attemptCount:1,closedSale:{}},{state:'published',attemptCount:1,closedWithdrawal:{}}];
 for(const step of ['check_optional_fields','publish_listing'])for(const changes of records){const f=fixture(t,{sessionListing:true});f.plan.listingRevision=1;const job=f.job({...evidenceBlocked,step});f.engine.db.publications.submissions.push(publicationMetadata(f,changes));f.engine.persist();const before=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8');assert.equal(f.engine.canRetry(job),false);assert.throws(()=>f.engine.startPlan(f.plan.id));assert.deepEqual(f.engine.db,before);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.deepEqual(f.executed,[]);}
});

test('indeterminate or duplicated journal metadata cannot be treated as absence of a submission',async t=>{
 const changes=[f=>{delete f.engine.db.publications;},f=>{f.engine.db.publications.submissions=null;},f=>{delete f.engine.db.publications.submissions[0].proof.facts.cycle;},f=>{f.engine.db.publications.submissions[0].proof.facts.cycle='0';},f=>{f.engine.db.publications.submissions[0].proof.facts.listingRevision=null;},f=>{f.engine.db.publications.submissions[0].proof.facts.listingRevision='0';},f=>{f.engine.db.publications.submissions[0].proof.facts.listingRevision=2;},f=>{f.engine.db.publications.submissions[0].proof.facts.cycle=1;},f=>{delete f.engine.db.publications.submissions[0].proof.facts.planId;},f=>{f.engine.db.publications.submissions.push(clone(f.engine.db.publications.submissions[0]));}];
 for(const change of changes){const f=fixture(t,{sessionListing:true});f.plan.listingRevision=1;const job=f.job(evidenceBlocked);f.engine.db.publications.submissions.push(publicationMetadata(f,{closedWithdrawal:{}}));f.engine.db.publications.submissions[0].proof.facts.listingRevision=0;change(f);assert.equal(f.engine.canRetry(job),false);assert.deepEqual(f.executed,[]);}
});

test('a withdrawn older revision remains immutable and does not prevent a new revision with no records',async t=>{
 const f=fixture(t,{sessionListing:true});f.plan.listingRevision=1;const job=f.job(evidenceBlocked),old=publicationMetadata(f,{state:'published',attemptCount:1,closedWithdrawal:{}});delete old.proof.facts.listingRevision;f.engine.db.publications.submissions.push(old);const history=clone(old);assert.equal(f.engine.canRetry(job),true);const result=f.engine.startPlan(f.plan.id);assert.deepEqual(result.resumedJobIds,[job.id]);await f.settled(1);assert.deepEqual(f.engine.db.publications.submissions,[history]);assert.equal(f.plan.listingRevision,1);assert.equal(f.engine.db.jobs.length,1);
 const held=fixture(t,{sessionListing:true});held.plan.listingRevision=1;const pending=held.job(evidenceBlocked),open=publicationMetadata(held,{state:'prepared'});open.proof.facts.listingRevision=0;held.engine.db.publications.submissions.push(open);assert.equal(held.engine.canRetry(pending),false);assert.throws(()=>held.engine.startPlan(held.plan.id));
});

test('a failed durable start preserves an evidence-blocked task and its photos without starting a runner',async t=>{
 const f=fixture(t,{sessionListing:true}),job=f.job(evidenceBlocked),before=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8'),persist=f.engine.persist;f.engine.persist=()=>{f.engine.faulted=true;throw Error('fixture evidence-retry storage failure');};assert.throws(()=>f.engine.startPlan(f.plan.id),/storage failure/);assert.deepEqual(f.engine.db,before);assert.equal(f.engine.db.jobs[0],job);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.equal(f.engine.timer,null);assert.equal(f.engine.running,false);assert.deepEqual(f.executed,[]);f.engine.persist=persist;f.engine.faulted=false;
});

test('explicit recovery enters the real sales driver preparation using the same original job and revision',async t=>{
 const f=fixture(t,{sessionListing:true});f.plan.listingRevision=1;const job=f.job(evidenceBlocked),original=clone(job),stages=[];let url='https://www.vinted.fr/',photos=0;
 const tab={id:'isolated-recovery-tab',view:{webContents:{isDestroyed:()=>false,getURL:()=>url}}},window={isDestroyed:()=>false,tabs:[tab],activeTab:tab.id,aiAgent:{state:{running:false}}};
 const driver=new VintedSalesRuntime({windows:new Map([[f.plan.profileId,window]]),control:{},isBusy:()=>false,ensureProfile:async(_id,{guard})=>{guard();stages.push('environment');},openPage:async(_id,next,{guard})=>{guard();url=next;stages.push('open-listing');return {tab};},validateImage:()=>({width:1,height:1})});
 driver.prepareFields=async(_id,fields,{signal})=>{assert.equal(signal.aborted,false);assert.equal(f.engine.db.jobs.length,1);assert.equal(f.engine.db.jobs[0].id,original.id);assert.equal(f.engine.db.jobs[0].dedupeKey,original.dedupeKey);assert.deepEqual(f.engine.db.jobs[0].payload,original.payload);assert.equal(fields.priceCents,500);stages.push('prepare-fields');throw Object.assign(Error('Controlled isolated stop before photos or publication'),{code:'LISTING_INCOMPLETE'});};
 driver.prepareJobPhotos=async()=>{photos++;throw Error('No photos or live API may be touched in this fixture');};f.engine.adapter=driver;const result=f.engine.startPlan(f.plan.id);assert.deepEqual(result.resumedJobIds,[original.id]);
 const end=Date.now()+2000;while(f.engine.ticking||!stages.includes('prepare-fields')){if(Date.now()>end)throw Error('Real isolated recovery driver did not reach preparation');await new Promise(resolve=>setTimeout(resolve,5));}
 assert.deepEqual(stages,['environment','open-listing','prepare-fields']);assert.equal(photos,0);assert.equal(f.engine.db.jobs.length,1);assert.equal(job.state,'needs_review');assert.equal(job.step,'prepare_listing');assert.equal(job.blockedReason,'LISTING_INCOMPLETE');assert.equal(job.id,original.id);assert.deepEqual(job.payload,original.payload);assert.equal(f.plan.listingRevision,1);assert.equal(f.engine.db.publications.submissions.length,0);assert.deepEqual(f.reads,[]);
});
