'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const {accountExpectation}=require('../src/commerce-account-binding.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const identity=(memberId='123')=>({verified:true,memberId,username:'fixture_owner',profileURL:'https://www.vinted.fr/member/'+memberId,documentKey:'fixture-account-document'});
const listing={title:'Fixture own product',description:'Fixture description',categoryPath:['Maison','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-native-account-binding-')),profiles=[{id:'fixture-profile',status:'running',windowType:'automation'}],adapter={readiness:()=>({capabilities:{publish:true,autoBindAccount:true,autoOpenProfile:true}})};
 const engine=new CommerceEngine({dir,profiles:()=>profiles,adapter,seal:value=>value,unseal:value=>value});engine.kickRun=()=>{};engine.ensureRunnerTimer=()=>{};
 engine.db.settings.backgroundEnabled=true;engine.db.encryptedToken='fixture-not-a-real-token';engine.db.supplierAccountId='fixture-supplier';engine.db.products=[{id:'fixture-product',sku:'FIXTURE',name:'Own product',stock:1,priceCents:100,photoSetsAvailable:1}];
 const plan=engine.savePlan({profileId:'fixture-profile',productId:'fixture-product',targetCount:1,listingPriceCents:500,minOfferCents:400,listing,enabled:false});
 const extra=[];t.after(async()=>{for(const current of [...extra,engine]){for(const controller of current.active.values())controller.abort();current.active.clear();await current.close();}fs.rmSync(dir,{recursive:true,force:true});});
 const activate=()=>{engine.setPlanEnabled(plan.id,true);engine.seed();const job=engine.db.jobs[0],controller=new AbortController();job.state='running';const lease=engine.leases.acquire(plan.profileId,job.id);engine.active.set(plan.profileId,controller);return {job,controller,lease};};
 return {engine,adapter,plan,activate,dir,extra};
}

test('first plan starts without manual verification only with explicit native automatic-binding support',t=>{
 const f=fixture(t),started=f.engine.startPlan(f.plan.id);assert.equal(started.started,true);assert.equal(f.engine.db.marketAccounts.length,0);f.engine.seed();assert.equal(f.engine.queueHealth().jobs[0].reasonCode,'ACCOUNT_AUTO_BIND');assert.deepEqual(f.engine.queueHealth().runnableJobIds,[f.engine.db.jobs[0].id]);
 const other=fixture(t);other.adapter.readiness=()=>({capabilities:{publish:true,autoOpenProfile:true}});const before=clone(other.engine.db);assert.throws(()=>other.engine.startPlan(other.plan.id),{code:'ACCOUNT_NOT_BOUND'});assert.deepEqual(other.engine.db,before);assert.equal(other.engine.running,false);
});

test('confirmed first owner and original job are committed together before further work',t=>{
 const f=fixture(t),{job,controller}=f.activate(),id=job.id,key=job.dedupeKey,payload=clone(job.payload),account=f.engine.bindJobAccount(id,identity(),{signal:controller.signal});
 const disk=JSON.parse(fs.readFileSync(f.engine.file,'utf8'));assert.equal(account.memberId,'123');assert.equal(disk.marketAccounts[0].memberId,'123');assert.equal(disk.jobs[0].accountMemberId,'123');assert.equal(job.id,id);assert.equal(job.dedupeKey,key);assert.deepEqual(job.payload,payload);assert.equal(job.operation,null);assert.equal(job.mutationPending,false);
});

test('restart keeps the original confirmed job identity and cannot bind a different logged-in owner',t=>{
 const f=fixture(t),{job,controller}=f.activate();f.engine.bindJobAccount(job.id,identity(),{signal:controller.signal});controller.abort();f.engine.active.clear();f.engine.leases.release(f.engine.leases.snapshot()[0]);
 const restarted=new CommerceEngine({dir:f.dir,profiles:()=>[{id:'fixture-profile',status:'running',windowType:'automation'}],adapter:f.adapter,seal:value=>value,unseal:value=>value});f.extra.push(restarted);
 const original=restarted.db.jobs[0],next=new AbortController();assert.equal(original.accountMemberId,'123');assert.equal(original.state,'queued');original.state='running';restarted.active.set(original.profileId,next);const lease=restarted.leases.acquire(original.profileId,original.id),before=clone(restarted.db);
 assert.throws(()=>restarted.bindJobAccount(original.id,identity('456'),{signal:next.signal}),{code:'ACCOUNT_CHANGED'});assert.deepEqual(restarted.db,before);restarted.leases.release(lease);restarted.active.clear();
});

test('disk failure cannot leave an in-memory new binding or job identity ready for publication',t=>{
 const f=fixture(t),{job,controller}=f.activate(),before=clone(f.engine.db),persist=f.engine.persist;
 f.engine.persist=()=>{f.engine.faulted=true;throw Error('fixture durable write failed');};assert.throws(()=>f.engine.bindJobAccount(job.id,identity(),{signal:controller.signal}),/durable write failed/);assert.deepEqual(f.engine.db,before);assert.equal(f.engine.accountObservations.size,0);f.engine.persist=persist;
});

test('native confirmation needs the exact active original job lease and absent mutation evidence',t=>{
 for(const change of [f=>f.controller.abort(),f=>f.engine.active.clear(),f=>f.engine.leases.release(f.lease),f=>f.job.operation={kind:'publish'},f=>f.job.result={externalId:'unknown'},f=>f.job.mutationPending=true,f=>f.job.state='queued',f=>f.engine.faulted=true,f=>f.engine.configPending=1]){
  const f=fixture(t),live={...f,...f.activate()};change(live);const before=clone(f.engine.db);assert.throws(()=>f.engine.bindJobAccount(live.job.id,identity(),{signal:live.controller.signal}),{code:'STOPPED'});assert.deepEqual(f.engine.db,before);
 }
});

function expectationFixture(){return {db:{marketAccounts:[],jobs:[],sales:[],publications:{submissions:[]}},accounts:{list:()=>[]}};}
test('credential labels and email never supply a first owner identity',()=>{
 const f=expectationFixture();f.accounts.list=()=>[{profileId:'profile',login:'fixture@example.invalid',label:'123',identity:null}];assert.deepEqual(accountExpectation(f,'profile'),{memberId:null,account:null});
});
test('original vault, job, sale and publication IDs constrain discovery even if market binding is missing',()=>{
 for(const source of ['vault','job','sale','publication']){const f=expectationFixture();if(source==='vault')f.accounts.list=()=>[{profileId:'profile',identity:identity()}];if(source==='job')f.db.jobs=[{profileId:'profile',accountMemberId:'123',mutationPending:false}];if(source==='sale')f.db.sales=[{profileId:'profile',memberId:'123'}];if(source==='publication')f.db.publications.submissions=[{proof:{facts:{profileId:'profile',account:identity()}}}];assert.equal(accountExpectation(f,'profile').memberId,'123',source);}
});
test('unidentified business history cannot be silently adopted as a new account',()=>{
 for(const history of [{jobs:[{profileId:'profile',operation:{kind:'publish'},mutationPending:false}]},{jobs:[{profileId:'profile',result:{externalId:'old'},mutationPending:false}]},{jobs:[{profileId:'profile',mutationPending:true}]},{sales:[{profileId:'profile'}]}]){const f=expectationFixture();Object.assign(f.db,history);assert.throws(()=>accountExpectation(f,'profile'),{code:'ACCOUNT_HISTORY_UNBOUND'});}
 const safe=expectationFixture();safe.db.jobs=[{profileId:'profile',state:'cancelled',operation:null,result:null,mutationPending:false}];assert.equal(accountExpectation(safe,'profile').memberId,null);
 const indirect=expectationFixture();indirect.db.plans=[{id:'plan',profileId:'profile'}];indirect.db.sales=[{planId:'plan',jobId:'sale-job'}];assert.throws(()=>accountExpectation(indirect,'profile'),{code:'ACCOUNT_HISTORY_UNBOUND'});indirect.db.jobs=[{id:'sale-job',profileId:'profile',type:'sale_confirmation',payload:{verified:true,memberId:'123'},mutationPending:false}];assert.equal(accountExpectation(indirect,'profile').memberId,'123');
});
test('conflicting historic IDs and another environment binding are never resolved by guessing',()=>{
 const f=expectationFixture();f.db.marketAccounts=[{profileId:'profile',...identity()}];f.db.jobs=[{profileId:'profile',accountMemberId:'456'}];assert.throws(()=>accountExpectation(f,'profile'),{code:'ACCOUNT_CHANGED'});
 f.db.jobs=[];f.accounts.list=()=>[{profileId:'other',identity:identity()}];assert.throws(()=>accountExpectation(f,'profile'),{code:'ACCOUNT_CONFLICT'});
});
test('legacy active, sold or associated listings cannot silently adopt another first owner on a new plan',t=>{
 for(const kind of ['active','sold','claim']){
  const f=fixture(t);if(kind==='claim')f.engine.db.claims.push({id:'old-claim',profileId:f.plan.profileId,productId:'old-product',listings:[{listingId:'98765'}]});
  else f.engine.db.plans.push({...clone(f.plan),id:'old-plan',productId:'old-product',activeListingId:kind==='active'?'98765':null,completedCount:kind==='sold'?1:0});
  const before=clone(f.engine.db);assert.throws(()=>f.engine.startPlan(f.plan.id),{code:'ACCOUNT_HISTORY_UNBOUND'});assert.deepEqual(f.engine.db,before);assert.equal(f.plan.enabled,false);assert.equal(f.engine.running,false);
 }
 const safe=fixture(t);safe.engine.db.claims.push({id:'unused-claim',profileId:safe.plan.profileId,productId:safe.plan.productId,listings:[]});assert.equal(safe.engine.startPlan(safe.plan.id).started,true);
});
