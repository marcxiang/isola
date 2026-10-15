'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {VintedSalesRuntime}=require('../src/vinted-sales-runtime.cjs');
const {ProfileOperationLeases}=require('../src/commerce-scheduler.cjs');
const {buildPublicationProof,FORM_URL}=require('../src/vinted-publication.cjs');
const {projectPublicationReconciliation}=require('../src/commerce-publication-reconcile.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const failure=(code,message=code)=>Object.assign(Error(message),{code});
function associationRecord(f,{id='association',plan=f.context.plan,state='pending',publicationState='published'}={}){
 const submissionId='submission-'+id,row={id,profileId:plan.profileId,productId:plan.productId,submissionId,state};
 f.engine.db.publicationSupplierSync.push(row);f.engine.db.publications.submissions.push({id:submissionId,state:publicationState,proof:{facts:{planId:plan.id,profileId:plan.profileId,productId:plan.productId}}});return row;
}

// The test adapter substitutes browser reads at the existing main-process
// boundaries, but uses the real publication proof, journal and DB projection.
// Thus a fake "published" flag cannot complete the queue or change its receipt.
class FixtureRuntime extends VintedSalesRuntime {
 async stage(name,extra={}){this.f.calls.push({name,...extra});await this.f.hooks[name]?.(this.f,extra);}
 async inspectCatalog(profileId,options){this.current(profileId,{signal:options.signal});await this.stage('catalog',{profileId});return this.f.catalog;}
 async prepareJobPhotos(engine,job,signal){await this.stage('photos',{profileId:job.profileId});return {summary:{ready:true},manifest:this.f.manifest(job.profileId)};}
 async prepareFields(profileId,listing,{signal}){this.current(profileId,{signal});await this.stage('fields',{profileId,listing});return this.f.draft;}
 async trustedManifest(manifest){await this.stage('manifest');return manifest;}
 async uploadPhotos(profileId,manifest,{signal}){this.current(profileId,{signal});await this.stage('upload',{profileId});return {...this.f.upload,claimId:manifest.claimId,count:manifest.count};}
 async inspectCurrentAccount(profileId,{signal}){this.current(profileId,{signal});await this.stage('account',{profileId});return {...this.f.engine.db.marketAccounts.find(row=>row.profileId===profileId),verified:true,documentKey:'form-document',...this.f.accountPatch};}
 async readPublicationInput(engine,id,signal,guard){guard();await this.stage('publication-input');return {plan:engine.plan(id),product:{id:engine.plan(id).productId,sku:engine.plan(id).sku,stock:2},claim:engine.db.claims.find(row=>row.profileId===engine.plan(id).profileId),expectedAccount:engine.db.marketAccounts.find(row=>row.profileId===engine.plan(id).profileId),manifest:this.f.manifest(engine.plan(id).profileId)};}
 async submit({engine,input,signal,guard}){
  guard();await this.stage('submit',{profileId:input.plan.profileId});const at=new Date().toISOString(),{plan,claim,expectedAccount}=input,profileId=plan.profileId,documentKey='form-document',tab=this.f.tabs.get(profileId);
  const evidence={profileId,tabId:tab.id,documentKey,url:FORM_URL,observedAt:at,challenge:false,account:{...expectedAccount,verified:true},form:{documentKey,complete:true,invalidFields:[],unknownFields:[],fields:Object.entries({...plan.listing,priceCents:plan.listingPriceCents}).map(([field,value])=>({field,value,verified:true}))},photos:{documentKey,profileId,productId:plan.productId,claimId:claim.id,setId:claim.setId,count:1,signature:'a'.repeat(64),verified:true,busy:false,errorCount:0},publication:{documentKey,count:1,observed:true,label:'Ajouter',enabled:true}};
  const proof=buildPublicationProof({...input,evidence}),journal=this.journal(engine),record=await journal.prepare(proof);
  await journal.dispatchOnce(record.id,proof,async()=>{this.f.clicks++;},{signal});
  const candidate={kind:'observed_submission_navigation',submissionId:record.id,formDocumentKey:documentKey,profileId,tabId:tab.id,listingId:profileId==='profile-1'?'98765':'98766',url:'https://www.vinted.fr/items/'+(profileId==='profile-1'?'98765':'98766'),observedAt:new Date().toISOString(),event:'did-navigate',committed:true};
  await journal._atomic(state=>{state.submissions.find(row=>row.id===record.id).navigation=[clone(candidate)];});
  this.f.urls.set(profileId,candidate.url);await this.stage('after-submit',{profileId,candidate,record});
  return {submissionId:record.id,navigationCandidate:this.f.navigation===null?null:{...candidate,...this.f.navigation}};
 }
 async collectReceipt({record,expectedAccount},{signal,withEvidence}){
  await this.stage('receipt',{record});if(this.f.receiptResult)return this.f.receiptResult;
  const facts=record.proof.facts,listingId=record.navigation[0].listingId,evidence={verified:true,mappingVerified:true,publicationStatus:'published',observedAt:new Date().toISOString(),profileId:facts.profileId,account:{...expectedAccount,verified:true},seller:{...expectedAccount,verified:true},ownedByCurrentAccount:true,listingId,url:'https://www.vinted.fr/items/'+listingId,priceKind:'item',priceCents:facts.fields.priceCents,currency:'EUR',title:facts.fields.title,photos:{verified:true,count:1,signature:'a'.repeat(64)},...this.f.receiptPatch};
  const guard=()=>{if(signal.aborted)throw failure('STOPPED');};return withEvidence({evidence,binding:{tabId:this.f.tabs.get(facts.profileId).id}},guard);
 }
}

function fixture(options={}){
 const f={calls:[],hooks:options.hooks||{},clicks:0,urls:new Map(),tabs:new Map(),windows:new Map(),catalog:{complete:true,duplicate:false,...options.catalog},draft:options.draft||{missing:[],unresolved:[]},upload:{verified:true,uncertain:false,...options.upload},navigation:options.navigation===undefined?{}:options.navigation,accountPatch:options.accountPatch||{},receiptPatch:options.receiptPatch||{},receiptResult:options.receiptResult,writes:[],events:[]};
 const engine={db:{version:1,plans:[],jobs:[],claims:[],sales:[],marketAccounts:[],publications:{version:1,submissions:[]},publicationSupplierSync:[]},active:new Map(),leases:new ProfileOperationLeases(),accountObservations:new Map(),configPending:0,faulted:false,closing:false,persist(){f.writes.push(clone(this.db));},emit(){},event(kind,text){f.events.push({kind,text});},plan(id){const row=this.db.plans.find(row=>row.id===id);if(!row)throw Error('No fixture plan');return row;},client(){throw Error('Procurement and supplier access are forbidden in browser fixtures');}};f.engine=engine;
 f.add=(index=1)=>{
  const profileId='profile-'+index,planId='plan-'+index,jobId='job-'+index,memberId=String(100+index),at=new Date().toISOString(),plan={id:planId,profileId,productId:'product-'+index,sku:'FIXTURE-'+index,enabled:true,completedCount:0,targetCount:2,activeListingId:null,status:'ready',currency:'EUR',listingPriceCents:500,minOfferCents:400,reuseOwnPhotos:true,listing:{title:'Fixture accessory '+index,description:'Fixture description.',categoryPath:['Maison','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'}};
  const job={id:jobId,type:'listing',planId,profileId,productId:plan.productId,dedupeKey:'listing:'+planId+':0',payload:{cycle:0},state:'running',step:'pending',operation:null,mutationPending:false,result:null,createdAt:at,updatedAt:at},controller=new AbortController();
  engine.db.plans.push(plan);engine.db.jobs.push(job);engine.db.marketAccounts.push({profileId,memberId,profileURL:'https://www.vinted.fr/member/'+memberId,username:'fixture_'+index});engine.db.claims.push({id:'claim-'+index,setId:'set-'+index,profileId,productId:plan.productId,images:[{id:'image-'+index}],listings:[]});
  const lease=engine.leases.acquire(profileId,jobId);engine.active.set(profileId,controller);f.urls.set(profileId,'https://www.vinted.fr');const tab={id:'tab-'+index,view:{webContents:{isDestroyed:()=>false,getURL:()=>f.urls.get(profileId)}}},window={tabs:[tab],activeTab:tab.id,isDestroyed:()=>false,aiAgent:{state:{running:false}},vintedDraftController:null};f.tabs.set(profileId,tab);f.windows.set(profileId,window);
  return {engine,job,plan,signal:controller.signal,controller,lease};
 };
 f.manifest=profileId=>{const claim=engine.db.claims.find(row=>row.profileId===profileId);return {claimId:claim.id,profileId,productId:claim.productId,setId:claim.setId,count:1,files:[{sha256:'a'.repeat(64),path:'/fixture-only/photo.jpg'}]};};
 f.runtime=new FixtureRuntime({windows:f.windows,control:{},isBusy:()=>true,validateImage:async()=>{},openPage:async(profileId,url,options)=>{options.guard();f.calls.push({name:'open',role:options.role,profileId,url});f.urls.set(profileId,url);await f.hooks.open?.(f,{profileId,url,options});options.guard();return {tab:f.tabs.get(profileId)};}});f.runtime.f=f;f.context=f.add();f.run=()=>f.runtime.executeJob(f.context);return f;
}

test('sales runtime only enables implemented listing and emits no synthetic sales or procurement events',async()=>{
 const f=fixture(),state=f.runtime.readiness();assert.equal(state.salesOnly,true);assert.equal(state.capabilities.publish,true);for(const key of ['messages','offers','saleConfirmation','shippingLabel','procurement'])assert.equal(state.capabilities[key],false);assert.deepEqual(await f.runtime.poll(),[]);f.runtime.validateImage=null;assert.equal(f.runtime.readiness().capabilities.publish,false);
});

test('listing execution needs its exact live controller, unique task and matching profile lease',async()=>{
 const changes=[f=>f.engine.active.delete('profile-1'),f=>f.engine.active.set('profile-1',new AbortController()),f=>f.engine.leases.release(f.context.lease),f=>f.context.controller.abort(),f=>f.context.job.state='queued',f=>f.context.plan.enabled=false,f=>f.context.job.payload.cycle=1,f=>f.context.plan.listingRevision=1,f=>f.context.job.payload.listingRevision=1,f=>f.engine.db.jobs.push(clone(f.context.job)),f=>f.engine.configPending=1,f=>f.engine.faulted=true];
 for(const change of changes){const f=fixture();change(f);await assert.rejects(f.run(),{code:'STOPPED'},String(change));assert.equal(f.calls.length,0);assert.equal(f.clicks,0);assert.equal(f.runtime.uiOwner,null);}
});

test('unbound and conflicting account identity releases the global UI owner before any page opens',async()=>{
 for(const change of [f=>f.engine.db.marketAccounts=[],f=>f.engine.db.marketAccounts.push({...f.engine.db.marketAccounts[0],profileId:'other-profile'})]){const f=fixture();change(f);await assert.rejects(f.run(),{code:'ACCOUNT_RECHECK_REQUIRED'});assert.equal(f.runtime.uiOwner,null);assert.equal(f.calls.length,0);}
});

test('simultaneous different profiles cannot both acquire visible browser control',async()=>{
 const entered=deferred(),release=deferred(),f=fixture({hooks:{catalog:async(_f,{profileId})=>{if(profileId==='profile-1'){entered.resolve();await release.promise;}}}}),second=f.add(2);
 const first=f.run(),other=f.runtime.executeJob(second).then(()=>null,error=>error);await entered.promise;const blocked=await other;assert.equal(blocked?.code,'WORKSPACE_BUSY');assert.equal(f.calls.some(row=>row.profileId==='profile-2'),false);release.resolve();await first;assert.equal(f.clicks,1);assert.equal(f.runtime.uiOwner,null);
});

test('verified listing completion preserves the canonical journal projection and can be replayed read-only',async()=>{
 const f=fixture();await f.run();const job=f.engine.db.jobs[0],publication=f.engine.db.publications.submissions[0];assert.equal(f.clicks,1);assert.equal(job.state,'completed');assert.equal(job.step,'publication_reconciled');assert.equal(job.result.verified,true);assert.equal(job.result.submissionId,publication.id);assert.equal(job.result.externalId,'98765');assert.equal(f.engine.db.plans[0].activeListingId,'98765');assert.equal(publication.state,'published');
 assert.equal(projectPublicationReconciliation(f.engine.db,f.engine.db.publications).changed,false);assert.equal(f.engine.db.publicationSupplierSync[0].state,'pending');assert.equal(f.runtime.uiOwner,null);assert.throws(()=>f.runtime.current('profile-1'),{code:'PAGE_BUSY'});
 await assert.rejects(f.run(),{code:'PUBLICATION_EXISTS'});assert.equal(f.clicks,1);
});

test('incomplete or duplicate catalog evidence stops before photos and form actions',async()=>{
 for(const catalog of [{complete:false,duplicate:false},{complete:true,duplicate:true},{complete:true}]){const f=fixture({catalog});if(!Object.hasOwn(catalog,'duplicate'))delete f.catalog.duplicate;await assert.rejects(f.run());assert.equal(f.calls.some(row=>row.name==='photos'),false);assert.equal(f.clicks,0);assert.equal(f.runtime.uiOwner,null);}
});

test('stopping, plan changes and changed account or tab after photo preparation cannot reach publication',async()=>{
 const changes=[f=>f.context.controller.abort(),f=>f.engine.db.plans[0].listing.title='Changed product',f=>{Object.assign(f.engine.db.marketAccounts[0],{memberId:'999',profileURL:'https://www.vinted.fr/member/999'});},f=>f.windows.get('profile-1').activeTab='another-tab'];
 for(const change of changes){const f=fixture({hooks:{photos:async f=>change(f)}});await assert.rejects(f.run());assert.equal(f.calls.some(row=>row.name==='submit'),false);assert.equal(f.clicks,0);assert.equal(f.runtime.uiOwner,null);}
});

test('field ambiguity, uncertain photos and a different observed account never authorize a publish click',async()=>{
 const cases=[{draft:{missing:[{field:'size',label:'Taille'}],unresolved:[]}},{upload:{verified:false}},{upload:{uncertain:true}},{accountPatch:{memberId:'999',profileURL:'https://www.vinted.fr/member/999'}}];
 for(const options of cases){const f=fixture(options);await assert.rejects(f.run());assert.equal(f.clicks,0);assert.equal(f.calls.some(row=>row.name==='submit'),false);assert.equal(f.runtime.uiOwner,null);}
});

test('only a committed navigation recorded by the exact original submission may enter receipt reconciliation',async()=>{
 for(const navigation of [null,{committed:false},{submissionId:'other-submission'},{formDocumentKey:'other-document'},{tabId:'other-tab'},{profileId:'other-profile'},{listingId:'555'}]){const f=fixture({navigation});await assert.rejects(f.run(),error=>error.code==='PUBLICATION_UNKNOWN_RESULT'&&error.ambiguous===true);assert.equal(f.clicks,1);assert.equal(f.engine.db.publications.submissions[0].state,'uncertain');assert.equal(f.engine.db.jobs[0].result,null);assert.equal(f.calls.some(row=>row.name==='receipt'),false);assert.equal(f.runtime.uiOwner,null);}
});

test('receipt mismatches or a published-looking return without a journal commit cannot complete a listing',async()=>{
 for(const options of [{receiptPatch:{priceCents:600}},{receiptPatch:{photos:{verified:true,count:1,signature:'b'.repeat(64)}}},{receiptResult:{state:'published',receipt:{listingId:'98765'}}}]){const f=fixture(options);await assert.rejects(f.run(),error=>error.ambiguous===true);assert.equal(f.clicks,1);assert.equal(f.engine.db.jobs[0].result,null);assert.equal(f.engine.db.publications.submissions[0].state,'uncertain');assert.equal(f.runtime.uiOwner,null);}
});

test('a tab change after the single publish attempt is retained as uncertain without another click',async()=>{
 const f=fixture({hooks:{'after-submit':async f=>{f.windows.get('profile-1').activeTab='user-tab';}}});await assert.rejects(f.run(),error=>error.code==='TAB_CHANGED'&&error.ambiguous===true);assert.equal(f.clicks,1);assert.equal(f.engine.db.publications.submissions[0].state,'uncertain');assert.equal(f.runtime.uiOwner,null);
});

test('maintenance owns and releases a profile lease and only calls the photo-association outbox',async()=>{
 const f=fixture(),controller=new AbortController();f.engine.active.clear();f.engine.leases.release(f.context.lease);associationRecord(f);const observed=[];
 f.runtime.outbox={run:async(engine,id,options)=>{observed.push(id);assert.equal(engine,f.engine);assert.equal(options.allowDispatch,true);assert.match(engine.leases.snapshot()[0].jobId,/^supplier:/);assert.equal(engine.active.get('profile-1').signal,options.signal);options.guard();}};
 await f.runtime.maintenance({engine:f.engine,signal:controller.signal});assert.deepEqual(observed,['association']);assert.equal(f.engine.active.size,0);assert.deepEqual(f.engine.leases.activeProfileIds(),[]);assert.equal(f.calls.length,0);assert.equal(f.clicks,0);await f.runtime.maintenance({engine:f.engine,signal:controller.signal});assert.equal(observed.length,1);
});

test('maintenance failure or cancellation releases only its own controller without touching browser tasks',async()=>{
 for(const stop of [false,true]){const f=fixture(),parent=new AbortController();f.engine.active.clear();f.engine.leases.release(f.context.lease);associationRecord(f);let signal;
  f.runtime.outbox={run:async(_engine,_id,options)=>{signal=options.signal;if(stop)parent.abort();options.guard();throw Error('Association failed');}};
  await f.runtime.maintenance({engine:f.engine,signal:parent.signal});assert.equal(signal.aborted,stop);assert.equal(f.engine.active.size,0);assert.equal(f.engine.leases.activeProfileIds().length,0);assert.equal(f.clicks,0);if(!stop)assert.match(f.events.at(-1).text,/Association failed/);
 }
});

test('maintenance does not compete with an existing browser lease or replay reviewed and finished associations',async()=>{
 const f=fixture(),controller=new AbortController(),seen=[];associationRecord(f,{id:'pending'});associationRecord(f,{id:'done',state:'synced'});associationRecord(f,{id:'review',state:'needs_review'});f.runtime.outbox={run:async(_engine,id)=>seen.push(id)};await f.runtime.maintenance({engine:f.engine,signal:controller.signal});assert.deepEqual(seen,[]);assert.equal(f.engine.active.get('profile-1'),f.context.controller);assert.equal(f.engine.leases.snapshot()[0].jobId,f.context.job.id);
});

test('an ambiguous plan identity cannot pass the owned listing guard',async()=>{
 const f=fixture();f.engine.db.plans.push(clone(f.context.plan));await assert.rejects(f.run(),{code:'STOPPED'});assert.equal(f.calls.length,0);assert.equal(f.runtime.uiOwner,null);
});

test('legacy engines without an association outbox do not produce a maintenance error',async()=>{
 const f=fixture(),controller=new AbortController();delete f.engine.db.publicationSupplierSync;let calls=0;f.runtime.outbox={run:async()=>{calls++;}};await f.runtime.maintenance({engine:f.engine,signal:controller.signal});assert.equal(calls,0);assert.equal(f.clicks,0);
});

test('maintenance guard refuses an outbox mutation after its exact supplier lease is revoked',async()=>{
 const f=fixture(),controller=new AbortController();f.engine.active.clear();f.engine.leases.release(f.context.lease);associationRecord(f);let lease,mutation=false;const acquire=f.engine.leases.acquire.bind(f.engine.leases);f.engine.leases.acquire=(...args)=>(lease=acquire(...args));
 f.runtime.outbox={run:async(_engine,_id,options)=>{f.engine.leases.release(lease);options.guard();mutation=true;}};
 await f.runtime.maintenance({engine:f.engine,signal:controller.signal});assert.equal(mutation,false);assert.equal(f.engine.active.size,0);assert.equal(f.engine.leases.activeProfileIds().length,0);
});

test('closed listing profiles open once under the current UI owner before catalog and photo work',async()=>{
 const f=fixture(),w=f.windows.get('profile-1');f.windows.delete('profile-1');let opens=0;
 f.runtime.ensureProfile=async(profileId,{guard,signal,jobId})=>{guard();assert.equal(f.runtime.uiOwner.jobId,jobId);assert.equal(signal,f.context.signal);assert.equal(f.context.job.step,'open_environment');assert.equal(f.calls.length,0);opens++;f.windows.set(profileId,w);};
 assert.equal(f.runtime.readiness().capabilities.autoOpenProfile,true);
 await f.runtime.requireReady('profile-1',f.context);assert.equal(opens,0);
 await f.run();assert.equal(opens,1);assert.equal(f.clicks,1);assert.equal(f.engine.db.jobs[0].state,'completed');
});

test('closed profiles without the native opener remain waiting and never attempt a business action',async()=>{
 const f=fixture();f.windows.clear();assert.equal(f.runtime.readiness().capabilities.autoOpenProfile,false);await assert.rejects(f.run(),{code:'PROFILE_NOT_OPEN'});assert.equal(f.calls.length,0);assert.equal(f.clicks,0);
});

test('invalid plan fields or an unbound account cannot trigger automatic profile launch',async()=>{
 for(const change of [f=>f.engine.db.marketAccounts=[],f=>f.context.plan.listing.title='',f=>f.context.plan.listing.categoryPath=[],f=>f.context.plan.activeListingId='123']){
  const f=fixture();f.windows.clear();change(f);let opens=0;f.runtime.ensureProfile=async()=>opens++;
  await assert.rejects(f.run());assert.equal(opens,0);assert.equal(f.clicks,0);assert.equal(f.runtime.uiOwner,null);
 }
});

test('cancelled startup and changed plan or account cannot proceed to catalog or permanent photo claim',async()=>{
 for(const change of [f=>f.context.controller.abort(),f=>f.context.plan.listing.title='Changed during startup',f=>{f.engine.db.marketAccounts[0].memberId='999';f.engine.db.marketAccounts[0].profileURL='https://www.vinted.fr/member/999';}]){
  const f=fixture(),w=f.windows.get('profile-1');f.windows.clear();f.runtime.ensureProfile=async(id,options)=>{options.guard();change(f);f.windows.set(id,w);options.guard();};
  await assert.rejects(f.run());assert.equal(f.calls.length,0);assert.equal(f.clicks,0);assert.equal(f.runtime.uiOwner,null);
 }
});

test('automatic launch holds the global UI owner across asynchronous startup',async()=>{
 const entered=deferred(),release=deferred(),f=fixture(),w=f.windows.get('profile-1'),second=f.add(2);f.windows.delete('profile-1');
 f.runtime.ensureProfile=async(id,{guard})=>{guard();assert.equal(id,'profile-1');entered.resolve();await release.promise;guard();f.windows.set(id,w);};
 const first=f.run();await entered.promise;await assert.rejects(f.runtime.executeJob(second),{code:'WORKSPACE_BUSY'});assert.equal(f.calls.length,0);release.resolve();await first;assert.equal(f.clicks,1);assert.equal(f.runtime.uiOwner,null);
});

test('a closed profile that fails to open never starts catalog or photo work',async()=>{
 const f=fixture();f.windows.clear();f.runtime.ensureProfile=async()=>{};
 await assert.rejects(f.run(),{code:'PAGE_BUSY'});assert.equal(f.calls.length,0);assert.equal(f.clicks,0);assert.equal(f.runtime.uiOwner,null);
});

test('an archived withdrawal cannot make a later revision failure look like another uncertain publication',async()=>{
 const f=fixture({hooks:{catalog:async()=>{throw failure('READ_TIMEOUT','Catalog read timed out');}}}),plan=f.context.plan,job=f.context.job;
 plan.listingRevision=1;job.payload.listingRevision=1;job.dedupeKey='listing:'+plan.id+':0:r1';
 f.engine.db.publications.submissions.push({id:'old-submission',state:'uncertain',attemptCount:1,proof:{facts:{planId:plan.id,cycle:0,listingRevision:0}},closedWithdrawal:{kind:'operator_confirmed_deletion'}});
 await assert.rejects(f.run(),error=>error.code==='READ_TIMEOUT'&&error.ambiguous!==true);assert.equal(f.calls.some(row=>row.name==='catalog'),true);assert.equal(f.calls.some(row=>row.name==='photos'),false);assert.equal(f.clicks,0);
});

test('listing guards bind the saved product source while preserving legacy supplier defaults',async()=>{
 const changed=fixture({hooks:{catalog:async f=>{f.context.plan.source='local';}}});await assert.rejects(changed.run(),{code:'PLAN_CHANGED'});assert.equal(changed.calls.some(row=>row.name==='photos'),false);assert.equal(changed.clicks,0);assert.equal(changed.runtime.uiOwner,null);
 const legacy=fixture({hooks:{catalog:async f=>{f.context.plan.source='supplier';}}});await legacy.run();assert.equal(legacy.clicks,1);assert.equal(legacy.engine.db.jobs[0].state,'completed');
});

test('scoped maintenance executes only the matching original publication and leaves other plan outboxes untouched',async()=>{
 const f=fixture(),second=f.add(2),parent=new AbortController(),seen=[];f.engine.active.clear();f.engine.leases.release(f.context.lease);f.engine.leases.release(second.lease);associationRecord(f,{id:'selected'});associationRecord(f,{id:'other',plan:second.plan});
 f.runtime.outbox={run:async(_engine,id,options)=>{options.guard();seen.push(id);}};
 await f.runtime.maintenance({engine:f.engine,signal:parent.signal,planIds:new Set([f.context.plan.id])});assert.deepEqual(seen,['selected']);assert.equal(f.runtime.maintenanceAfter.has('other'),false);assert.equal(f.engine.db.publicationSupplierSync.find(row=>row.id==='other').state,'pending');assert.equal(f.engine.active.size,0);assert.deepEqual(f.engine.leases.snapshot(),[]);
 await f.runtime.maintenance({engine:f.engine,signal:parent.signal,planIds:null});assert.deepEqual(seen,['selected','other']);
});

test('missing, ambiguous, uncertain or mismatched publication ownership cannot authorize maintenance',async()=>{
 const changes=[
  f=>f.engine.db.publications.submissions=[],
  f=>f.engine.db.publications.submissions.push(clone(f.engine.db.publications.submissions[0])),
  f=>f.engine.db.publications.submissions[0].state='uncertain',
  f=>f.engine.db.publications.submissions[0].proof.facts.profileId='another-profile',
  f=>f.engine.db.publications.submissions[0].proof.facts.productId='another-product',
  f=>f.engine.db.publicationSupplierSync.push(clone(f.engine.db.publicationSupplierSync[0])),
  f=>f.context.plan.source='local'
 ];
 for(const change of changes){const f=fixture(),parent=new AbortController(),seen=[];f.engine.active.clear();f.engine.leases.release(f.context.lease);associationRecord(f);change(f);f.runtime.outbox={run:async(_engine,id)=>seen.push(id)};await f.runtime.maintenance({engine:f.engine,signal:parent.signal,planIds:null});assert.deepEqual(seen,[]);assert.equal(f.engine.active.size,0);assert.deepEqual(f.engine.leases.snapshot(),[]);assert.equal(f.runtime.maintenanceAfter.size,0);}
 const malformed=fixture(),parent=new AbortController();malformed.engine.active.clear();malformed.engine.leases.release(malformed.context.lease);associationRecord(malformed);let called=false;malformed.runtime.outbox={run:async()=>{called=true;}};await malformed.runtime.maintenance({engine:malformed.engine,signal:parent.signal,planIds:[]});assert.equal(called,false);
});

test('a changed publication plan cannot cross the maintenance scope after the outbox read has started',async()=>{
 const f=fixture(),parent=new AbortController();f.engine.active.clear();f.engine.leases.release(f.context.lease);associationRecord(f);let mutation=false;
 f.runtime.outbox={run:async(_engine,_id,options)=>{f.engine.db.publications.submissions[0].proof.facts.planId='outside-started-scope';options.guard();mutation=true;}};
 await f.runtime.maintenance({engine:f.engine,signal:parent.signal,planIds:new Set([f.context.plan.id])});assert.equal(mutation,false);assert.equal(f.engine.active.size,0);assert.deepEqual(f.engine.leases.snapshot(),[]);
});
