const test=require('node:test'),assert=require('node:assert/strict');
const {startupDecision,retryDecision,inspectQueue,ProfileOperationLeases}=require('../src/commerce-scheduler.cjs');
const NOW=Date.parse('2026-10-13T12:00:00Z');
const makeJob=(extra={})=>({id:'job-1',dedupeKey:'listing:plan-1:0',type:'listing',planId:'plan-1',profileId:'profile-1',productId:'product-1',state:'queued',step:'pending',payload:{cycle:0},operation:null,mutationPending:false,result:null,createdAt:'2026-10-13T11:00:00Z',...extra});
function fixture(){return {jobs:[makeJob()],plans:[{id:'plan-1',profileId:'profile-1',productId:'product-1',enabled:true,targetCount:2,completedCount:0,activeListingId:null}],profiles:[{id:'profile-1',status:'running'}],readiness:{capabilities:{publish:true,messages:true,offers:true,shippingLabel:true,procurement:true}},activeProfileIds:[],maxConcurrent:2};}
const inspect=(input,opts={})=>inspectQueue(input,{now:NOW,...opts});
const first=input=>inspect(input).jobs[0];

test('restart recovery requeues only work with explicitly absent mutation evidence',()=>{assert.equal(startupDecision(makeJob({state:'running'})).state,'queued');for(const extra of [{operation:{kind:'publish'}},{mutationPending:true},{mutationPending:undefined},{result:{externalId:'123'}}])assert.equal(startupDecision(makeJob({state:'running',...extra})).state,'uncertain');});
test('restart also quarantines inconsistent queued or completed pending operations',()=>{assert.equal(startupDecision(makeJob({operation:{receipt:{id:'123'}}})).state,'uncertain');assert.equal(startupDecision(makeJob({state:'completed',mutationPending:true})).state,'uncertain');assert.equal(startupDecision(makeJob({state:'completed',result:{externalId:'123'}})).state,'completed');});
test('startup never automatically revives terminal or review tasks',()=>{for(const state of ['completed','cancelled','rejected','needs_review','uncertain'])assert.equal(startupDecision(makeJob({state})).state,state);assert.equal(startupDecision(makeJob({state:'invented'})).state,'needs_review');});
test('retry backoff is deterministic, capped, and stops at the configured limit',()=>{let job=makeJob();const delays=[];for(let index=0;index<4;index++){const result=retryDecision(job,{code:'READ_TIMEOUT'},{now:NOW,maxDelayMs:30000});delays.push(result.delayMs);assert.equal(result.state,'queued');assert.equal(result.retryAt,new Date(NOW+result.delayMs).toISOString());job={...job,...result};}assert.deepEqual(delays,[15000,30000,30000,30000]);const end=retryDecision(job,{code:'READ_TIMEOUT'},{now:NOW,maxDelayMs:30000});assert.equal(end.state,'needs_review');assert.equal(end.reasonCode,'RETRY_EXHAUSTED');assert.equal(end.attempts,5);assert.equal(end.retryAt,null);});
test('known or ambiguous external operations never receive an automatic retry date',()=>{for(const extra of [{operation:{kind:'reply',receipt:{id:'123'}}},{mutationPending:true},{mutationPending:undefined},{result:{externalId:'123'}}]){const result=retryDecision(makeJob(extra),{code:'RETRY_LATER'},{now:NOW});assert.equal(result.state,'uncertain');assert.equal(result.retryAt,null);}assert.equal(retryDecision(makeJob(),{code:'READ_TIMEOUT',ambiguous:true},{now:NOW}).state,'uncertain');});
test('stopping does not consume retry attempts and generic failures need review',()=>{const job=makeJob({attempts:2});const stop=retryDecision(job,{code:'STOPPED'},{now:NOW});assert.equal(stop.state,'queued');assert.equal(stop.attempts,2);assert.equal(stop.retryAt,null);assert.equal(retryDecision(job,{code:'WRONG_SITE',message:'Wrong site'},{now:NOW}).state,'needs_review');assert.equal(retryDecision(makeJob({attempts:-1}),{code:'READ_TIMEOUT'},{now:NOW}).reasonCode,'INVALID_RETRY_RECORD');});
test('a lease allows at most one operation per profile and stale releases cannot unlock a successor',()=>{const leases=new ProfileOperationLeases({clock:()=>NOW}),first=leases.acquire('p1','j1');assert.equal(first.startedAt,'2026-10-13T12:00:00.000Z');assert.equal(leases.acquire('p1','j2'),null);assert.equal(leases.release({...first}),false);assert.equal(leases.release(first),true);const second=leases.acquire('p1','j2');assert.equal(leases.release(first),false);assert.deepEqual(leases.activeProfileIds(),['p1']);assert.equal(leases.release(second),true);assert.equal(leases.release(second),false);});
test('lease snapshots cannot mutate or release the actual operation lease',()=>{const leases=new ProfileOperationLeases({clock:()=>NOW}),lease=leases.acquire('p1','j1');const snapshot=leases.snapshot();snapshot[0].jobId='tampered';assert.equal(leases.snapshot()[0].jobId,'j1');assert.equal(leases.release(snapshot[0]),false);assert.equal(Object.isFrozen(lease),true);leases.acquire('p2','j2');assert.deepEqual(leases.activeProfileIds(),['p1','p2']);});
test('ready queues produce stable IDs without mutating their source data',()=>{const f=fixture(),before=JSON.stringify(f),result=inspect(f);assert.deepEqual(result.runnableJobIds,['job-1']);assert.equal(result.jobs[0].state,'ready');assert.equal(result.profiles[0].state,'ready');assert.equal(JSON.stringify(f),before);assert.deepEqual(inspect(f),result);});
test('readiness gates only the capabilities actually needed by the job type',()=>{for(const [type,missing] of [['listing','publish'],['message','messages'],['offer','offers'],['fulfillment','shippingLabel']]){const f=fixture();f.jobs[0].type=type;f.readiness.capabilities[missing]=false;const row=first(f);assert.equal(row.reasonCode,'CAPABILITY_UNVERIFIED');assert.deepEqual(row.missingCapabilities,[missing]);assert.equal(inspect(f).runnableJobIds.length,0);}const f=fixture();f.readiness.capabilities.procurement=false;assert.equal(first(f).state,'ready');f.jobs[0].type='fulfillment';assert.equal(first(f).reasonCode,'CAPABILITY_UNVERIFIED');});
test('missing readiness defaults to blocked instead of interpreting an absent flag as success',()=>{const f=fixture();delete f.readiness;assert.equal(first(f).reasonCode,'CAPABILITY_UNVERIFIED');});
test('duplicate job IDs and business dedupe keys are reported without selecting either',()=>{for(const field of ['id','dedupeKey']){const f=fixture(),second=makeJob({id:'job-2',dedupeKey:'other-key'});second[field]=f.jobs[0][field];f.jobs.push(second);const report=inspect(f);assert.equal(report.runnableJobIds.length,0);assert.ok(report.jobs.every(row=>row.reasonCode==='DUPLICATE_JOB'));}});
test('orphan plans and mismatched product/profile bindings are isolated as blocked jobs',()=>{for(const extra of [{planId:'missing-plan'},{productId:'other-product'},{profileId:'other-profile'}]){const f=fixture();Object.assign(f.jobs[0],extra);assert.equal(first(f).reasonCode,'PLAN_MISMATCH');}const f=fixture();f.profiles=[];assert.equal(first(f).reasonCode,'PROFILE_MISSING');});
test('storage faults, shutdown, configuration work and disabled plans are visible with next actions',()=>{for(const [property,value,code] of [['faulted',true,'STORAGE_UNAVAILABLE'],['closing',true,'APP_CLOSING'],['configBusy',true,'CONFIG_BUSY']]){const f=fixture();f[property]=value;const row=first(f);assert.equal(row.reasonCode,code);assert.ok(row.nextAction);}const f=fixture();f.plans[0].enabled=false;assert.equal(first(f).reasonCode,'PLAN_PAUSED');});
test('closed profiles and active operations cannot be selected',()=>{const closed=fixture();closed.profiles[0].status='closed';assert.equal(first(closed).reasonCode,'PROFILE_NOT_OPEN');const busy=fixture();busy.activeProfileIds=['profile-1'];assert.equal(first(busy).reasonCode,'PROFILE_BUSY');assert.equal(inspect(busy).capacity,1);});
function autoOpenFixture(){const f=fixture();f.profiles[0].status='closed';f.readiness.capabilities.autoOpenProfile=true;f.requireVerifiedAccount=true;f.accounts=[{platform:'vinted-fr',profileId:'profile-1',memberId:'123'}];return f;}
test('closed listing environments are scheduled for automatic opening with a durable account binding',()=>{const f=autoOpenFixture(),before=JSON.stringify(f),result=inspect(f);assert.deepEqual(result.runnableJobIds,['job-1']);assert.equal(result.jobs[0].state,'ready');assert.equal(result.jobs[0].reasonCode,'PROFILE_AUTO_OPEN');assert.match(result.jobs[0].nextAction,/无需手动打开/);assert.match(result.jobs[0].nextAction,/重新核对登录身份/);assert.equal(JSON.stringify(f),before);});
test('automatic opening defers only fresh observation checks and does not accept missing or conflicting identity',()=>{
 for(const change of [{accounts:[]},{accounts:[{profileId:'profile-1',memberId:123}]},{accounts:[{platform:'vinted-fr',profileId:'profile-1',memberId:'123'},{platform:'vinted-fr',profileId:'profile-2',memberId:'123'}]},{observedAccounts:[{profileId:'profile-1',memberId:'456',verified:true}]}]){const f=Object.assign(autoOpenFixture(),change);for(const status of ['closed','running']){f.profiles[0].status=status;assert.equal(first(f).state,'blocked');assert.deepEqual(inspect(f).runnableJobIds,[]);}}
 const f=autoOpenFixture();f.jobs[0].accountMemberId='456';assert.equal(first(f).reasonCode,'ACCOUNT_CHANGED');
 for(const observation of [[],[{profileId:'profile-1',memberId:'123',verified:true,checkedAt:new Date(NOW-600000).toISOString(),documentKey:'old-doc'}]]){const fresh=autoOpenFixture();fresh.observedAccounts=observation;assert.equal(first(fresh).reasonCode,'PROFILE_AUTO_OPEN');fresh.profiles[0].status='running';assert.equal(first(fresh).reasonCode,'READY');assert.match(first(fresh).nextAction,/重新核对当前页面的登录身份/);fresh.readiness.capabilities.autoOpenProfile=false;assert.equal(first(fresh).reasonCode,'ACCOUNT_RECHECK_REQUIRED');}
});
test('native auto-binding explicitly admits a first listing without treating conflicting account evidence as fresh',()=>{
 const f=autoOpenFixture();f.accounts=[];f.readiness.capabilities.autoBindAccount=true;
 for(const status of ['closed','running']){f.profiles[0].status=status;const result=inspect(f);assert.deepEqual(result.runnableJobIds,['job-1']);assert.equal(result.jobs[0].reasonCode,'ACCOUNT_AUTO_BIND');assert.match(result.jobs[0].nextAction,/无需手动核对/);}
 f.profiles[0].status='running';f.readiness.capabilities.autoOpenProfile=false;assert.equal(first(f).reasonCode,'ACCOUNT_AUTO_BIND');
 f.readiness.capabilities.autoBindAccount=false;assert.equal(first(f).reasonCode,'ACCOUNT_NOT_BOUND');
 f.readiness.capabilities.autoBindAccount=true;f.accounts=[{platform:'vinted-fr',profileId:'profile-1',memberId:'123'}];f.jobs[0].accountMemberId='456';assert.equal(first(f).reasonCode,'ACCOUNT_CHANGED');assert.deepEqual(inspect(f).runnableJobIds,[]);
 f.jobs[0].accountMemberId='123';f.accounts.push({platform:'vinted-fr',profileId:'other-profile',memberId:'123'});assert.equal(first(f).reasonCode,'ACCOUNT_RECORD_CONFLICT');
});
function sessionListingFixture(){const f=fixture();f.requireVerifiedAccount=true;f.readiness.capabilities.sessionListing=true;f.readiness.capabilities.autoOpenProfile=true;return f;}
test('session listing uses the selected environment without bound or observed account evidence',()=>{
 for(const status of ['running','closed']){
  const f=sessionListingFixture();f.profiles[0].status=status;const before=JSON.stringify(f),result=inspect(f);
  assert.deepEqual(result.runnableJobIds,['job-1']);assert.equal(result.jobs[0].reasonCode,'SESSION_LISTING_READY');assert.match(result.jobs[0].reason,/指定环境.*当前登录会话/);assert.doesNotMatch(result.jobs[0].nextAction,/核对|绑定|用户名|Profil/);assert.equal(JSON.stringify(f),before);
 }
 const f=sessionListingFixture();f.readiness.capabilities.autoOpenProfile=false;assert.equal(first(f).reasonCode,'SESSION_LISTING_READY');f.profiles[0].status='closed';assert.equal(first(f).reasonCode,'PROFILE_NOT_OPEN');
});
test('session listing ignores old identity conflicts without changing or fabricating any identity',()=>{
 for(const evidence of [
  {accounts:[],observedAccounts:[]},
  {accounts:[{profileId:'profile-1',memberId:'123'}],observedAccounts:[{profileId:'profile-1',memberId:'456',verified:true}]},
  {accounts:[{platform:'vinted-fr',profileId:'profile-1',memberId:'123'},{platform:'vinted-fr',profileId:'other-profile',memberId:'123'}]},
  {accounts:[{profileId:'profile-1',memberId:'123'},{profileId:'profile-1',memberId:'456'}]},
  {accounts:{invalid:true},observedAccounts:{invalid:true}}
 ]){
  const f=Object.assign(sessionListingFixture(),evidence);f.jobs[0].accountMemberId='789';const before=JSON.stringify(f);assert.equal(first(f).reasonCode,'SESSION_LISTING_READY');assert.deepEqual(inspect(f).runnableJobIds,['job-1']);assert.equal(JSON.stringify(f),before);
 }
});
test('session listing capability is scoped to listing and the selected ready profile',()=>{
 for(const type of ['message','offer','sale_confirmation','fulfillment']){const f=sessionListingFixture();f.jobs[0].type=type;if(type==='sale_confirmation')f.readiness.capabilities.saleConfirmation=true;assert.equal(first(f).reasonCode,'ACCOUNT_NOT_BOUND');}
 for(const status of ['starting','closing','unavailable',undefined]){const f=sessionListingFixture();f.profiles[0].status=status;assert.equal(first(f).reasonCode,'PROFILE_NOT_OPEN');assert.deepEqual(inspect(f).runnableJobIds,[]);}
 for(const sessionListing of [false,undefined]){const f=sessionListingFixture();f.readiness.capabilities.sessionListing=sessionListing;assert.equal(first(f).reasonCode,'ACCOUNT_NOT_BOUND');}
 const unavailable=sessionListingFixture();unavailable.readiness.capabilities.publish=false;assert.equal(first(unavailable).reasonCode,'CAPABILITY_UNVERIFIED');
 const perProfile=sessionListingFixture();perProfile.readinessByProfile={'profile-1':{capabilities:{publish:true}},'other-profile':{capabilities:{publish:true,sessionListing:true}}};assert.equal(first(perProfile).reasonCode,'ACCOUNT_NOT_BOUND');
});
test('session listing preserves publication evidence, duplicate cycles, pauses and profile stops',()=>{
 for(const change of [
  f=>{f.jobs[0].operation={kind:'publish'};},
  f=>{f.jobs[0].mutationPending=true;},
  f=>{f.jobs[0].result={externalId:'123'};}
 ]){const f=sessionListingFixture();change(f);assert.equal(first(f).reasonCode,'RECONCILE_REQUIRED');assert.deepEqual(inspect(f).runnableJobIds,[]);}
 const occupied=sessionListingFixture();occupied.plans[0].activeListingId='123';assert.equal(first(occupied).reasonCode,'LISTING_CYCLE_CHANGED');
 const paused=sessionListingFixture();paused.plans[0].enabled=false;assert.equal(first(paused).reasonCode,'PLAN_PAUSED');
 const duplicate=sessionListingFixture();duplicate.jobs.push(makeJob({id:'duplicate-job'}));assert.ok(inspect(duplicate).jobs.every(row=>row.reasonCode==='DUPLICATE_JOB'));
 const stopped=sessionListingFixture();stopped.jobs.push(makeJob({id:'stopped-job',dedupeKey:'stopped-job',state:'needs_review',blockedReason:'PROFILE_STOPPED'}));assert.equal(first(stopped).reasonCode,'PROFILE_MANUALLY_PAUSED');
 const faulted=sessionListingFixture();faulted.faulted=true;assert.equal(first(faulted).reasonCode,'STORAGE_UNAVAILABLE');
 const busy=sessionListingFixture();busy.activeProfileIds=['profile-1'];assert.equal(first(busy).reasonCode,'PROFILE_BUSY');
 const unknown=sessionListingFixture();unknown.jobs.push(makeJob({id:'uncertain-job',dedupeKey:'uncertain-job',state:'uncertain'}));assert.equal(first(unknown).reasonCode,'PROFILE_RECONCILE_REQUIRED');
});
test('automatic opening applies only to exact closed listing profiles with explicit per-profile support',()=>{
 for(const type of ['message','offer','sale_confirmation','fulfillment']){const f=autoOpenFixture();f.jobs[0].type=type;assert.equal(first(f).reasonCode,'PROFILE_NOT_OPEN');}
 for(const status of ['starting','closing','unavailable',undefined]){const f=autoOpenFixture();f.profiles[0].status=status;assert.equal(first(f).reasonCode,'PROFILE_NOT_OPEN');assert.deepEqual(inspect(f).runnableJobIds,[]);}
 for(const capabilities of [{publish:true},{publish:true,autoOpenProfile:false},{publish:false,autoOpenProfile:true}]){const f=autoOpenFixture();f.readiness.capabilities=capabilities;assert.equal(first(f).reasonCode,'PROFILE_NOT_OPEN');}
 const f=autoOpenFixture();f.readinessByProfile={'profile-1':{capabilities:{publish:true,autoOpenProfile:false}},'other-profile':{capabilities:{publish:true,autoOpenProfile:true}}};assert.equal(first(f).reasonCode,'PROFILE_NOT_OPEN');
});
test('automatic opening preserves pauses, uncertain results, listing cycles and concurrency limits',()=>{
 const paused=autoOpenFixture();paused.plans[0].enabled=false;assert.equal(first(paused).reasonCode,'PLAN_PAUSED');
 const unknown=autoOpenFixture();unknown.jobs.push(makeJob({id:'uncertain',dedupeKey:'unknown',state:'uncertain',operation:{kind:'publish'}}));assert.equal(first(unknown).reasonCode,'PROFILE_RECONCILE_REQUIRED');
 const listed=autoOpenFixture();listed.plans[0].activeListingId='987';assert.equal(first(listed).reasonCode,'LISTING_CYCLE_CHANGED');
 const busy=autoOpenFixture();busy.activeProfileIds=['profile-1'];assert.equal(first(busy).reasonCode,'PROFILE_BUSY');
 const full=autoOpenFixture();full.maxConcurrent=1;full.activeProfileIds=['another-profile'];assert.equal(first(full).reasonCode,'CONCURRENCY_LIMIT');assert.deepEqual(inspect(full).runnableJobIds,[]);
});
test('manual close and stop hold all plans for the same account until the interrupted task is resolved',()=>{
 for(const code of ['PROFILE_CLOSED','PROFILE_STOPPED']){
  const f=autoOpenFixture();f.plans.push({...f.plans[0],id:'plan-2',productId:'product-2'});f.jobs.push(makeJob({id:'stopped-job',dedupeKey:'listing:plan-2:0',planId:'plan-2',productId:'product-2',state:'needs_review',blockedReason:code,error:'The original window was stopped'}));
  const before=JSON.stringify(f),held=inspect(f);assert.deepEqual(held.runnableJobIds,[]);assert.equal(held.jobs[0].reasonCode,'PROFILE_MANUALLY_PAUSED');assert.match(held.jobs[0].nextAction,/原任务.*重试或取消/);assert.equal(held.jobs[1].reasonCode,'MANUAL_REVIEW');assert.equal(JSON.stringify(f),before);
  f.profiles.push({id:'profile-2',status:'closed'});f.plans.push({...f.plans[0],id:'plan-3',profileId:'profile-2'});f.accounts.push({platform:'vinted-fr',profileId:'profile-2',memberId:'456'});f.jobs.push(makeJob({id:'other-account',dedupeKey:'listing:plan-3:0',planId:'plan-3',profileId:'profile-2'}));assert.deepEqual(inspect(f).runnableJobIds,['other-account']);
  f.profiles[0].status='running';f.observedAccounts=[{profileId:'profile-1',memberId:'123',verified:true,documentKey:'fresh-doc',checkedAt:new Date(NOW).toISOString()}];assert.equal(first(f).reasonCode,'PROFILE_MANUALLY_PAUSED');
  f.jobs[1].state='cancelled';assert.equal(first(f).state,'ready');assert.deepEqual(inspect(f).runnableJobIds,['job-1','other-account']);
 }
});
test('unrelated review reasons and resolved manual stops do not create a profile-wide manual pause',()=>{
 for(const stopped of [{state:'needs_review',blockedReason:'LISTING_INCOMPLETE'},{state:'cancelled',blockedReason:'PROFILE_CLOSED'},{state:'completed',blockedReason:'PROFILE_STOPPED'}]){const f=autoOpenFixture();f.jobs.push(makeJob({id:'old-task',dedupeKey:'old-task',...stopped}));assert.equal(first(f).reasonCode,'PROFILE_AUTO_OPEN');assert.deepEqual(inspect(f).runnableJobIds,['job-1']);}
});
test('unknown results quarantine all other queued operations for that profile',()=>{const f=fixture();f.jobs.push(makeJob({id:'uncertain',dedupeKey:'unknown',state:'uncertain',operation:{kind:'reply'}}));const report=inspect(f);assert.equal(report.jobs[0].reasonCode,'PROFILE_RECONCILE_REQUIRED');assert.equal(report.jobs[1].reasonCode,'RECONCILE_REQUIRED');assert.deepEqual(report.runnableJobIds,[]);assert.equal(report.profiles[0].state,'attention');});
test('running jobs without live leases require recovery rather than redispatch',()=>{const f=fixture();f.jobs[0].state='running';assert.equal(first(f).reasonCode,'ORPHAN_RUNNING');f.activeProfileIds=['profile-1'];assert.equal(first(f).state,'running');assert.deepEqual(inspect(f).runnableJobIds,[]);});
test('listing tasks cannot reuse a consumed cycle or publish alongside an active listing',()=>{for(const change of [{activeListingId:'123'},{completedCount:1},{completedCount:2},{targetCount:null}]){const f=fixture();Object.assign(f.plans[0],change);assert.equal(first(f).reasonCode,'LISTING_CYCLE_CHANGED');}});
test('future retries wait until the exact injected time and malformed retry records block',()=>{const f=fixture();f.jobs[0].retryAt=new Date(NOW+15000).toISOString();assert.equal(first(f).reasonCode,'RETRY_DELAY');assert.deepEqual(inspect(f,{now:NOW+15000}).runnableJobIds,['job-1']);f.jobs[0].retryAt='not-a-time';assert.equal(first(f).reasonCode,'INVALID_RETRY_RECORD');});
test('same-profile jobs are serialized and transaction work precedes replenishment',()=>{const f=fixture();f.jobs.push(makeJob({id:'order',dedupeKey:'order-key',type:'fulfillment'}));const out=inspect(f);assert.deepEqual(out.runnableJobIds,['order']);assert.equal(out.jobs.find(row=>row.jobId==='job-1').reasonCode,'PROFILE_QUEUED');});
test('capacity counts already-running profiles and selection is independent of input order',()=>{const f=fixture();for(let i=2;i<=3;i++){f.profiles.push({id:'profile-'+i,status:'running'});f.plans.push({...f.plans[0],id:'plan-'+i,profileId:'profile-'+i});f.jobs.push(makeJob({id:'job-'+i,dedupeKey:'key-'+i,planId:'plan-'+i,profileId:'profile-'+i}));}f.activeProfileIds=['external-profile'];const result=inspect(f);assert.deepEqual(result.runnableJobIds,['job-1']);f.jobs.reverse();assert.deepEqual(inspect(f).runnableJobIds,result.runnableJobIds);assert.equal(result.jobs.filter(row=>row.reasonCode==='CONCURRENCY_LIMIT').length,2);});
test('account checks are opt-in for mock adapters but production mode requires fresh proof',()=>{const f=fixture();assert.equal(first(f).state,'ready');f.requireVerifiedAccount=true;assert.equal(first(f).reasonCode,'ACCOUNT_NOT_BOUND');f.accounts=[{profileId:'profile-1',memberId:'123'}];assert.equal(first(f).reasonCode,'ACCOUNT_RECHECK_REQUIRED');f.observedAccounts=[{profileId:'profile-1',memberId:'123',verified:true,documentKey:'fixture-document',checkedAt:new Date(NOW).toISOString()}];assert.equal(first(f).state,'ready');});
test('different bound, observed or job account IDs always block even when freshness checks are optional',()=>{const f=fixture();f.accounts=[{profileId:'profile-1',memberId:'123'}];f.observedAccounts=[{profileId:'profile-1',memberId:'456',verified:true}];assert.equal(first(f).reasonCode,'ACCOUNT_CHANGED');delete f.observedAccounts;f.jobs[0].accountMemberId='456';assert.equal(first(f).reasonCode,'ACCOUNT_CHANGED');});
test('stale, future, unverified and document-less account observations are not sufficient',()=>{for(const changed of [{checkedAt:new Date(NOW-300001).toISOString()},{checkedAt:new Date(NOW+1).toISOString()},{verified:false},{documentKey:''}]){const f=fixture();f.requireVerifiedAccount=true;f.accounts=[{profileId:'profile-1',memberId:'123'}];f.observedAccounts=[{profileId:'profile-1',memberId:'123',verified:true,documentKey:'doc',checkedAt:new Date(NOW).toISOString(),...changed}];assert.equal(first(f).reasonCode,'ACCOUNT_RECHECK_REQUIRED');}});
test('duplicate or malformed account proofs do not select a convenient identity',()=>{for(const accounts of [[{profileId:'profile-1',memberId:'123'},{profileId:'profile-1',memberId:'456'}],[{profileId:'profile-1',memberId:123}],{}]){const f=fixture();f.accounts=accounts;assert.equal(first(f).reasonCode,'ACCOUNT_RECORD_CONFLICT');}});
test('legacy records with the same marketplace member in two environments remain blocked',()=>{const f=fixture();f.accounts=[{platform:'vinted-fr',profileId:'profile-1',memberId:'123'},{platform:'vinted-fr',profileId:'profile-2',memberId:'123'}];assert.equal(first(f).reasonCode,'ACCOUNT_RECORD_CONFLICT');assert.deepEqual(inspect(f).runnableJobIds,[]);});
test('per-profile readiness cannot be inherited from a different profile',()=>{const f=fixture();f.readinessByProfile={'profile-1':{capabilities:{publish:false}},'other-profile':{capabilities:{publish:true}}};assert.equal(first(f).reasonCode,'CAPABILITY_UNVERIFIED');});
test('finished jobs are not rerun merely because there are no enabled profiles',()=>{const f=fixture();f.jobs[0].state='completed';f.jobs[0].result={externalId:'123'};f.plans=[];f.profiles=[];assert.equal(first(f).state,'finished');assert.deepEqual(inspect(f).runnableJobIds,[]);});

test('temporary capability and workspace blockers preserve retry budgets without becoming permanent failures',()=>{
 for(const code of ['CAPABILITY_UNVERIFIED','VINTED_UNVERIFIED','PAGE_BUSY','PROFILE_NOT_OPEN']){const out=retryDecision(makeJob({attempts:2}),{code,message:'Waiting for verified page'},{now:NOW});assert.equal(out.state,'queued');assert.equal(out.attempts,2);assert.equal(out.reasonCode,code);assert.ok(Date.parse(out.retryAt)>NOW);}
});

test('sales confirmation uses a separate capability and completed matching receipts unlock replacement listings',()=>{
 const f=fixture();f.readiness.capabilities.saleConfirmation=true;const confirmation=makeJob({id:'confirmation',dedupeKey:'vinted-order:order-1',type:'sale_confirmation',state:'queued',payload:{id:'order-1'}});f.jobs.push(confirmation);f.sales=[{planId:'plan-1',platformOrderId:'order-1',jobId:confirmation.id}];
 assert.equal(first(f).reasonCode,'SALE_CYCLE_PENDING');assert.deepEqual(inspect(f).runnableJobIds,['confirmation']);
 Object.assign(confirmation,{state:'completed',result:{verified:true,externalId:'order-1',kind:'sale_confirmation'}});assert.equal(first(f).state,'ready');confirmation.result.externalId='another-order';assert.equal(first(f).reasonCode,'SALE_CYCLE_PENDING');
});

test('queue projection distinguishes deliberate sales-only procurement disablement from missing capability',()=>{
 const f=fixture();f.jobs[0].type='fulfillment';f.readiness.salesOnly=true;const row=first(f);assert.equal(row.reasonCode,'PROCUREMENT_DISABLED');assert.deepEqual(inspect(f).runnableJobIds,[]);
});

test('an unsubmitted temporary blocker preserves its actionable cause during the polling delay',()=>{
 const f=fixture();Object.assign(f.jobs[0],{retryAt:new Date(NOW+10000).toISOString(),blockedReason:'PAGE_BUSY',error:'Wait for the existing page action'});const row=first(f);assert.equal(row.reasonCode,'PAGE_BUSY');assert.equal(row.reason,'Wait for the existing page action');assert.equal(row.state,'waiting');
});

test('a relisting revision blocks old queued jobs while preserving the original sales cycle',()=>{
 const f=autoOpenFixture();f.plans[0].listingRevision=1;assert.equal(first(f).reasonCode,'LISTING_CYCLE_CHANGED');assert.deepEqual(inspect(f).runnableJobIds,[]);
 f.jobs[0].payload.listingRevision=1;f.jobs[0].dedupeKey='listing:plan-1:0:r1';assert.equal(first(f).reasonCode,'PROFILE_AUTO_OPEN');assert.deepEqual(inspect(f).runnableJobIds,['job-1']);
 for(const value of [-1,1.5,'1',null]){f.jobs[0].payload.listingRevision=value;assert.equal(first(f).reasonCode,'LISTING_CYCLE_CHANGED');}
});
