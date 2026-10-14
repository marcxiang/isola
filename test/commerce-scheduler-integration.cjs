const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t,{requireReady,sendReply}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-scheduler-integration-')),calls={ready:0,sends:0},instances=[];
  const profiles=[{id:'profile-1',name:'Fixture account one',status:'running'},{id:'profile-2',name:'Fixture account two',status:'running'}];
  const adapter={readiness:()=>({capabilities:{publish:false,messages:true,offers:false,shippingLabel:false,procurement:false}}),requireReady:async(...args)=>{calls.ready++;if(requireReady)return requireReady(...args);},poll:async()=>[],readMessage:async payload=>({...payload}),draftReply:async()=>({text:'Fixture confirmed description.',factual:true}),sendReply:async(...args)=>{calls.sends++;if(sendReply)return sendReply(...args);return {verified:true,messageId:'fixture-reply-'+calls.sends};}};
  const options={dir,profiles:()=>profiles,clientFactory:()=>{throw Error('Supplier access is forbidden in scheduler integration fixtures');},adapter,seal:value=>value,unseal:value=>value};
  const engine=new CommerceEngine(options);instances.push(engine);
  engine.db.products=[{id:'product-1',sku:'FIXTURE',name:'Fixture product',stock:10,priceCents:1000,photoSetsAvailable:1}];
  const plan=engine.savePlan({profileId:'profile-1',productId:'product-1',listingPriceCents:2500,minOfferCents:2000,targetCount:2,enabled:true,autoReply:true});plan.activeListingId='123456';engine.persist();
  const addPlan=(profileId='profile-2')=>{const saved=engine.savePlan({...plan,id:undefined,profileId});saved.activeListingId='654321';engine.persist();return saved;};
  const enqueue=(id='fixture-message-1',p=plan)=>engine.enqueue('message',p,{id,listingId:p.activeListingId,buyerUsername:'fixture-buyer'},'message:'+id);
  const restart=()=>{const next=new CommerceEngine(options);instances.push(next);return next;};
  t.after(async()=>{for(const instance of instances){instance.active.clear();await instance.close();}fs.rmSync(dir,{recursive:true,force:true});});
  return {engine,plan,calls,adapter,profiles,enqueue,addPlan,restart};
}

test('engine restart quarantines queued mutation evidence and completed pending writes',t=>{
  const f=fixture(t),a=f.enqueue('queued-result'),b=f.enqueue('completed-pending');a.result={externalId:'fixture-old-reply'};b.state='completed';b.mutationPending=true;b.operation={kind:'reply',idempotencyKey:'fixture-key'};f.engine.persist();
  const recovered=f.restart();assert.equal(recovered.db.jobs.find(j=>j.id===a.id).state,'uncertain');assert.equal(recovered.db.jobs.find(j=>j.id===b.id).state,'uncertain');assert.equal(recovered.canRetry(recovered.db.jobs[0]),false);assert.equal(f.calls.sends,0);
});
test('engine restart keeps safe interrupted reads queued and preserves delayed retry metadata',t=>{
  const f=fixture(t),job=f.enqueue();Object.assign(job,{state:'running',attempts:2,retryAt:new Date(Date.now()+60000).toISOString()});f.engine.persist();const next=f.restart(),restored=next.db.jobs.find(j=>j.id===job.id);assert.equal(restored.state,'queued');assert.equal(restored.attempts,2);assert.equal(restored.retryAt,job.retryAt);
});
test('engine direct concurrent jobs cannot replace the active controller or dispatch twice',async t=>{
  const entered=deferred(),release=deferred(),f=fixture(t,{sendReply:async()=>{entered.resolve();await release.promise;return {verified:true,messageId:'fixture-reply'};}}),a=f.enqueue('first'),b=f.enqueue('second');
  const running=f.engine.runJob(a);await entered.promise;const original=f.engine.active.get(f.plan.profileId);assert.equal(await f.engine.runJob(b),false);assert.equal(f.engine.active.get(f.plan.profileId),original);assert.equal(b.state,'queued');assert.equal(f.calls.sends,1);release.resolve();await running;assert.equal(f.engine.active.size,0);assert.deepEqual(f.engine.leases.activeProfileIds(),[]);assert.equal(a.state,'completed');
});
test('engine cleanup never deletes a newer controller installed for the same profile',async t=>{
  const entered=deferred(),release=deferred(),f=fixture(t,{requireReady:async()=>{entered.resolve();await release.promise;throw Error('Fixture stop before any mutation');}}),job=f.enqueue(),running=f.engine.runJob(job);await entered.promise;
  const replacement=new AbortController();f.engine.active.set(f.plan.profileId,replacement);release.resolve();await running;assert.equal(f.engine.active.get(f.plan.profileId),replacement);assert.equal(f.engine.leases.activeProfileIds().length,0);f.engine.active.delete(f.plan.profileId);
});
test('engine read failures honor persisted backoff, exhaust retries, and reset only on manual retry',async t=>{
  const f=fixture(t,{requireReady:async()=>{throw Object.assign(Error('Fixture read timeout'),{code:'READ_TIMEOUT'});}}),job=f.enqueue();
  await f.engine.runOnce();assert.equal(job.state,'queued');assert.equal(job.attempts,1);assert.ok(Date.parse(job.retryAt)>Date.now());assert.equal(f.calls.ready,1);
  await f.engine.runOnce();assert.equal(f.calls.ready,1);assert.equal(f.calls.sends,0);
  for(let i=2;i<=5;i++){job.retryAt=new Date(0).toISOString();await f.engine.runOnce();assert.equal(job.attempts,i);}
  assert.equal(job.state,'needs_review');assert.equal(job.retryAt,null);assert.equal(f.calls.ready,5);await f.engine.resolve(job.id,'retry');assert.equal(job.state,'queued');assert.equal(job.attempts,0);assert.equal(job.retryAt,null);
});
test('engine stopping an unsubmitted read queues it without consuming a retry attempt',async t=>{
  const entered=deferred(),release=deferred(),f=fixture(t,{requireReady:async()=>{entered.resolve();await release.promise;}}),job=f.enqueue(),running=f.engine.runOnce();await entered.promise;f.engine.setRunning(false);release.resolve();await running;assert.equal(job.state,'queued');assert.equal(job.attempts,0);assert.equal(job.retryAt,null);assert.equal(f.calls.sends,0);assert.equal(f.engine.active.size,0);
});
test('engine isolates an orphan job and continues unrelated valid work in the batch',async t=>{
  const f=fixture(t),orphan=f.enqueue('orphan'),valid=f.enqueue('valid');orphan.planId='missing-plan';await f.engine.runOnce();assert.equal(orphan.state,'needs_review');assert.match(orphan.error,/不匹配/);assert.equal(valid.state,'completed');assert.equal(f.calls.sends,1);
});
test('engine quarantines an uncertain account while another account can continue',async t=>{
  const f=fixture(t),secondPlan=f.addPlan(),unknown=f.enqueue('unknown'),blocked=f.enqueue('blocked'),other=f.enqueue('other',secondPlan);unknown.state='uncertain';unknown.operation={kind:'reply'};await f.engine.runOnce();assert.equal(blocked.state,'queued');assert.equal(unknown.state,'uncertain');assert.equal(other.state,'completed');assert.equal(f.calls.sends,1);assert.equal(f.engine.state().jobs.find(j=>j.id===blocked.id).scheduling.reasonCode,'PROFILE_RECONCILE_REQUIRED');
});
test('engine invalidates cached account proof immediately when another account is observed',t=>{
  const f=fixture(t),job=f.enqueue();f.engine.bindMarketAccount(f.plan.profileId,{verified:true,memberId:'123',username:'fixture_seller',profileURL:'https://www.vinted.fr/member/123',documentKey:'fixture-doc'});assert.equal(f.engine.state().jobs.find(j=>j.id===job.id).scheduling.state,'ready');
  assert.throws(()=>f.engine.bindMarketAccount(f.plan.profileId,{verified:true,memberId:'456',username:'other_fixture',profileURL:'https://www.vinted.fr/member/456',documentKey:'fixture-doc'}),{code:'ACCOUNT_CHANGED'});assert.equal(f.engine.accountObservations.has(f.plan.profileId),false);assert.equal(f.engine.db.marketAccounts[0].memberId,'123');assert.equal(f.engine.state().jobs.find(j=>j.id===job.id).scheduling.reasonCode,'ACCOUNT_RECHECK_REQUIRED');
});
test('engine restarting invalidates in-memory proof but preserves the durable account binding',t=>{
  const f=fixture(t),job=f.enqueue();f.engine.bindMarketAccount(f.plan.profileId,{verified:true,memberId:'123',username:'fixture_seller',profileURL:'https://www.vinted.fr/member/123',documentKey:'fixture-doc'});const next=f.restart();assert.equal(next.db.marketAccounts[0].memberId,'123');assert.equal(next.accountObservations.size,0);assert.equal(next.state().jobs.find(j=>j.id===job.id).scheduling.reasonCode,'ACCOUNT_RECHECK_REQUIRED');
});
test('a publication occupancy blocks listing retries but preserves safe message retry',async t=>{
  const f=fixture(t),message=f.enqueue();message.state='needs_review';f.engine.db.publications.submissions.push({proof:{facts:{planId:f.plan.id}},state:'published',closedSale:null});assert.equal(f.engine.canRetry(message),true);await f.engine.resolve(message.id,'retry');assert.equal(message.state,'queued');const listing=f.engine.enqueue('listing',f.plan,{cycle:0},'listing:fixture');listing.state='needs_review';assert.equal(f.engine.canRetry(listing),false);
});
test('engine rejects continuous background startup when the saved switch is disabled',t=>{
  const f=fixture(t);assert.equal(f.engine.db.settings.backgroundEnabled,false);assert.throws(()=>f.engine.setRunning(true));assert.equal(f.engine.running,false);assert.equal(f.engine.timer,null);assert.equal(f.calls.ready,0);
});
test('queue health omits message payloads and preserves task causes for the operations UI',t=>{
  const f=fixture(t),job=f.enqueue();job.payload.text='PRIVATE FIXTURE MESSAGE';job.state='needs_review';job.error='Fixture requires review';const state=f.engine.state(),row=state.jobs.find(j=>j.id===job.id);assert.equal(row.scheduling.reasonCode,'MANUAL_REVIEW');assert.equal(row.scheduling.reason,'Fixture requires review');assert.ok(row.scheduling.nextAction);assert.equal(JSON.stringify(state).includes('PRIVATE FIXTURE MESSAGE'),false);
});
test('engine direct and batch execution both reject duplicate task IDs or dedupe keys',async t=>{
  for(const duplicateField of ['id','dedupeKey']){
    const f=fixture(t),a=f.enqueue('duplicate-first'),b=f.enqueue('duplicate-second');b[duplicateField]=a[duplicateField];
    await assert.rejects(f.engine.runJob(a),{code:'DUPLICATE_JOB'});assert.equal(f.engine.active.size,0);assert.equal(f.calls.ready,0);
    await f.engine.runOnce();assert.equal(a.state,'needs_review');assert.equal(b.state,'needs_review');await f.engine.runOnce();assert.equal(f.calls.sends,0);assert.equal(f.calls.ready,0);
  }
});
test('engine direct execution checks original plan, product and profile binding before leasing',async t=>{
  for(const change of [{planId:'missing-plan'},{productId:'wrong-product'},{profileId:'profile-2'}]){
    const f=fixture(t),job=f.enqueue();Object.assign(job,change);await assert.rejects(f.engine.runJob(job),{code:'PLAN_MISMATCH'});assert.equal(f.engine.active.size,0);assert.deepEqual(f.engine.leases.activeProfileIds(),[]);assert.equal(f.calls.ready,0);assert.equal(f.calls.sends,0);
  }
  const f=fixture(t),job=f.enqueue();f.profiles.splice(0,1);await assert.rejects(f.engine.runJob(job),{code:'PLAN_MISMATCH'});assert.equal(f.calls.ready,0);
});
test('a publication created after queueing blocks both direct and batch listing execution',async t=>{
  const f=fixture(t);f.plan.activeListingId=null;const job=f.engine.enqueue('listing',f.plan,{cycle:0},'listing:existing-before-publication');
  f.engine.db.publications.submissions.push({proof:{facts:{planId:f.plan.id}},state:'prepared',closedSale:null});
  await assert.rejects(f.engine.runJob(job),{code:'PUBLICATION_EXISTS'});assert.equal(f.calls.ready,0);await f.engine.runOnce();assert.equal(job.state,'needs_review');assert.match(job.error,/原刊登/);assert.equal(f.engine.db.jobs.length,1);assert.equal(f.calls.ready,0);
});
test('pausing one product leaves another product operation in the same account running',async t=>{
  const entered=deferred(),release=deferred(),f=fixture(t,{requireReady:async()=>{entered.resolve();await release.promise;}});
  f.engine.db.products.push({id:'product-2',sku:'FIXTURE-2',name:'Other fixture product',stock:10,priceCents:1000,photoSetsAvailable:1});
  const other=f.engine.savePlan({...f.plan,id:undefined,productId:'product-2'});other.activeListingId='987654';const job=f.enqueue('other-product',other),running=f.engine.runJob(job);await entered.promise;
  const controller=f.engine.active.get(f.plan.profileId);f.engine.setPlanEnabled(f.plan.id,false);assert.equal(controller.signal.aborted,false);assert.equal(other.enabled,true);release.resolve();await running;assert.equal(job.state,'completed');assert.equal(f.calls.sends,1);
});
test('pausing the plan that owns the lease stops its unsubmitted operation',async t=>{
  const entered=deferred(),release=deferred(),f=fixture(t,{requireReady:async()=>{entered.resolve();await release.promise;}}),job=f.enqueue(),running=f.engine.runJob(job);await entered.promise;
  const controller=f.engine.active.get(f.plan.profileId);f.engine.setPlanEnabled(f.plan.id,false);assert.equal(controller.signal.aborted,true);release.resolve();await running;assert.equal(job.state,'queued');assert.equal(f.calls.sends,0);assert.equal(f.plan.enabled,false);assert.equal(f.engine.active.size,0);
});

test('runtime receives the task scope and completes against the current database snapshot',async t=>{
 const f=fixture(t),job=f.enqueue();let readyScope,executeScope;
 f.adapter.requireReady=async(profileId,context)=>{readyScope=context;assert.equal(profileId,f.plan.profileId);assert.equal(context.engine,f.engine);assert.equal(context.job,job);assert.equal(context.plan,f.plan);assert.ok(context.signal instanceof AbortSignal);};
 f.adapter.executeJob=async context=>{executeScope=context;f.engine.db=JSON.parse(JSON.stringify(f.engine.db));f.engine.db.jobs.find(row=>row.id===job.id).result={verified:true,externalId:'runtime-reply'};};
 await f.engine.runOnce();assert.equal(executeScope.signal,readyScope.signal);assert.equal(f.engine.db.jobs.find(row=>row.id===job.id).state,'completed');assert.equal(f.engine.db.jobs.find(row=>row.id===job.id).result.externalId,'runtime-reply');assert.equal(f.calls.sends,0);assert.equal(f.engine.active.size,0);
});

test('an unimplemented capability remains queued without burning retries or invoking the runtime',async t=>{
 const f=fixture(t),job=f.enqueue();f.adapter.readiness=()=>({capabilities:{messages:false}});let calls=0;f.adapter.executeJob=async()=>{calls++;};
 assert.equal(await f.engine.runJob(job),false);await f.engine.runOnce();await f.engine.runOnce();assert.equal(job.state,'queued');assert.equal(job.attempts,undefined);assert.equal(f.calls.ready,0);assert.equal(calls,0);assert.equal(f.engine.state().jobs[0].scheduling.reasonCode,'CAPABILITY_UNVERIFIED');
});

test('polling owns the same profile lease as jobs and passes detached plan and account snapshots',async t=>{
 const f=fixture(t),job=f.enqueue(),entered=deferred(),release=deferred();f.engine.bindMarketAccount(f.plan.profileId,{verified:true,memberId:'123',username:'seller',profileURL:'https://www.vinted.fr/member/123'});
 let observed;f.adapter.poll=async(profileId,context)=>{observed=context;assert.equal(profileId,f.plan.profileId);assert.ok(f.engine.active.has(profileId));assert.match(f.engine.leases.snapshot()[0].jobId,/^poll:/);context.plans[0].activeListingId='mutated-snapshot';context.expectedAccount.username='mutated-snapshot';entered.resolve();await release.promise;return [];};
 f.engine.running=true;const polling=f.engine.poll();await entered.promise;assert.equal(await f.engine.runJob(job),false);await assert.rejects(f.engine.configure(async()=>{}),/停止后台/);assert.equal(f.plan.activeListingId,'123456');assert.equal(f.engine.db.marketAccounts[0].username,'seller');assert.ok(observed.signal instanceof AbortSignal);release.resolve();await polling;f.engine.running=false;assert.equal(f.engine.active.size,0);assert.equal(f.engine.leases.activeProfileIds().length,0);assert.equal(job.state,'queued');
});

test('an unknown or cross-profile event prevents the complete poll batch from being ingested',async t=>{
 const f=fixture(t);f.adapter.poll=async()=>[{verified:true,type:'message',id:'valid-message',profileId:f.plan.profileId,listingId:f.plan.activeListingId,buyerUsername:'buyer'}, {verified:true,type:'unknown',id:'unrecognized',profileId:f.plan.profileId}];
 f.engine.running=true;await f.engine.poll();f.engine.running=false;assert.equal(f.engine.db.jobs.length,0);assert.match(f.engine.db.events.at(-1).text,/无法识别/);assert.equal(f.engine.active.size,0);
});

test('conflicting duplicate events quarantine the original queue before any new batch event is accepted',async t=>{
 const f=fixture(t),original=f.enqueue(),event={verified:true,type:'message',id:'incoming',profileId:f.plan.profileId,listingId:f.plan.activeListingId,buyerUsername:'buyer',text:'First question'};
 f.adapter.poll=async()=>[event,{...event,buyerUsername:'other-buyer'}];f.engine.running=true;await f.engine.poll();f.engine.running=false;
 assert.equal(f.engine.db.jobs.length,1);assert.equal(original.state,'needs_review');assert.equal(original.blockedReason,'EVENT_CONFLICT');assert.equal(original.payload.id,'fixture-message-1');await f.engine.runOnce();assert.equal(f.calls.sends,0);
});

test('maintenance receives the tick abort scope before polling and a read failure does not stop unrelated jobs',async t=>{
 const f=fixture(t),job=f.enqueue(),steps=[];f.adapter.maintenance=async({engine,signal})=>{assert.equal(engine,f.engine);assert.ok(signal instanceof AbortSignal);steps.push('maintenance');throw Error('Supplier association awaits review');};f.adapter.poll=async()=>{steps.push('poll');return [];};f.engine.running=true;await f.engine.runOnce();f.engine.running=false;
 assert.deepEqual(steps,['maintenance','poll']);assert.equal(job.state,'completed');assert.equal(f.calls.sends,1);assert.ok(f.engine.db.events.some(row=>row.text==='Supplier association awaits review'));
});

test('stopping during maintenance prevents the same tick from polling or starting any task',async t=>{
 const f=fixture(t),job=f.enqueue(),entered=deferred(),release=deferred();let signal,polls=0;f.adapter.maintenance=async context=>{signal=context.signal;entered.resolve();await release.promise;};f.adapter.poll=async()=>{polls++;return [];};f.engine.running=true;const cycle=f.engine.runOnce();await entered.promise;f.engine.setRunning(false);assert.equal(signal.aborted,true);release.resolve();await cycle;assert.equal(polls,0);assert.equal(job.state,'queued');assert.equal(f.calls.sends,0);
});
