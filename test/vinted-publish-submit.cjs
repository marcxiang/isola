'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createHash}=require('node:crypto');
const {VintedPublishSubmit,publicationJournal,commitPublicationDeletion}=require('../src/vinted-publish-submit.cjs');
const {createDisplayController}=require('../src/display-transform.cjs');
const {createEnvironmentSessionAuthority}=require('../src/commerce-session-authority.cjs');
const FORM='https://www.vinted.fr/items/new',clone=value=>JSON.parse(JSON.stringify(value));
const hash=value=>createHash('sha256').update(value).digest('hex'),photoSource='https://images.vinted.test/original.jpg';

function fixture(options={}){
 const profileId='profile-1',documentKey='100.1',listing={title:'Accessoire pour aspirateur noir neuf',description:'Sans marque. Neuf sans étiquette ni emballage.',categoryPath:['Maison','Entretien de la maison','Aspirateurs et nettoyage','Accessoires pour appareils de nettoyage'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
 const plan={id:'plan-1',profileId,productId:'product-1',sku:'TEST',listingPriceCents:500,currency:'EUR',enabled:true,completedCount:0,targetCount:2,activeListingId:null,listing};
 const expectedAccount={profileId,memberId:'123',profileURL:'https://www.vinted.fr/member/123'},claim={id:'claim-1',profileId,productId:plan.productId,setId:'set-1',images:[{id:'image-1'}]};
 const input={plan,product:{id:plan.productId,sku:plan.sku,stock:5},claim,expectedAccount,manifest:{claimId:claim.id,profileId,productId:claim.productId,setId:claim.setId,count:1,files:[{sha256:'a'.repeat(64),path:'/private/image.jpg'}]}};
 const pass={profileId,tabId:'tab-1',url:FORM,documentKey,challenge:false,account:{...expectedAccount,verified:true},fields:Object.entries({...listing,priceCents:500}).map(([field,value])=>({field,label:field,value,disabled:false,invalid:false})),unknownFields:[],invalidFields:[],alerts:[],dialogs:0,publication:{documentKey,count:1,label:'Ajouter',observed:true,enabled:true},photos:{profileId,productId:plan.productId,claimId:claim.id,setId:claim.setId,count:1,signature:hash(JSON.stringify([hash(photoSource)])),documentKey,verified:true,busy:false,errorCount:0}};
 let url=FORM,reads=0,targets=0,probes=0,closed=false;const events=[],writes=[],feedback=[],trace=[];
 const contents=Object.assign(new EventEmitter(),{isDestroyed:()=>closed,getURL:()=>url,focus:()=>{options.onFocus?.(api);},sendInputEvent:event=>{
  trace.push('input:'+event.type);events.push(event);options.onInput?.(api,event);
  if(event.type==='mouseDown'){assert.equal(engine.db.publications.submissions[0].state,'dispatching');assert.equal(engine.db.publications.submissions[0].attemptCount,1);}
  if(event.type==='mouseUp'&&options.navigate){url=options.navigate;contents.emit('did-start-navigation',{},url,false,true);contents.emit('did-navigate',{},url);}
 }});
 const tab={id:'tab-1',view:{webContents:contents},controlFeedback:async event=>{feedback.push(event);trace.push('feedback:'+event.stage);return options.onFeedback?.(api,event);}};
 const w={tabs:[tab],activeTab:tab.id,isDestroyed:()=>closed,aiAgent:{state:{running:false}},vintedDraftController:null};
 const nativeForm=()=>({url:FORM,documentKey,fields:pass.fields.filter(field=>field.field!=='parcel').map(field=>({...field,value:field.field==='categoryPath'?field.value.at(-1):field.field==='priceCents'?'5,00':field.value})),parcel:[{name:'Petit',checked:false},{name:'Moyen',checked:true},{name:'Grand',checked:false}],unknownFields:[],invalidFields:[],alerts:[],dialogs:0,publication:{count:1,enabled:true}});
 const target={elementId:'e1-1',documentKey,tag:'BUTTON',label:'Ajouter',disabled:false,href:'',x:90,y:120,point:{x:90,y:120},rect:{x:70,y:100,width:100,height:40}};
 const adapter={current(id,context={}){assert.equal(id,profileId);if(context.signal?.aborted)throw Object.assign(Error('Stopped'),{code:'STOPPED'});if(closed||context.tab&&context.tab!==w.tabs.find(tab=>tab.id===w.activeTab))throw Object.assign(Error('Changed tab'),{code:'TAB_CHANGED'});if(w.aiAgent.state.running||w.vintedDraftController&&w.vintedDraftController!==context.controller)throw Object.assign(Error('Busy'),{code:'PAGE_BUSY'});if(url!==FORM)throw Object.assign(Error('Page changed'),{code:'PAGE_CHANGED'});return {w,tab};},read:async()=>({url,elements:[{id:'e1-1',tag:'button',label:'Ajouter'}]}),control:{
  isolated:async(_tab,expression)=>{assert.equal(_tab,tab);targets++;trace.push('resolve:'+targets);await options.onResolve?.(api,targets);if(expression.includes('function probeFinalPublicationDOM')){probes++;trace.push('probe:'+probes);const form=nativeForm();options.onProbe?.(api,form,probes);const result={url:FORM,documentKey,account:{documentKey,buttons:[{id:'e1-2',username:'fixture'}],menus:[{valid:true,href:'https://www.vinted.fr/member/'+pass.account.memberId}]},form,photos:{images:[{alt:"Photo 1 sur 1 mise en ligne Pour réorganiser les photos, appuie sur la barre d'espace",source:api.photoSource,loaded:true}],controls:['Supprimer la photo sélectionnée','Modifier la photo 1'],busy:false},challenge:false,target:clone(target)};options.onAtomic?.(api,result);return result;}assert.match(expression,/function resolvePublishTarget/);return clone(target);},
  target:async(_tab,id,_signal,{scroll})=>{assert.equal(_tab,tab);assert.equal(id,'e1-1');trace.push('target:'+scroll);await options.onTarget?.(api,scroll);return clone(target);},
  performAction:async()=>assert.fail('Generic performAction must not be used for publishing')
 },photos:{claims:new Map([[profileId+'\0'+tab.id+'\0'+documentKey,{phase:'verified',claimId:claim.id,documentKey,manifestKey:hash(JSON.stringify({claimId:claim.id,files:input.manifest.files.map(file=>file.sha256),count:1})),signature:pass.photos.signature}]])}};
 const engine={adapter,db:{publications:{version:1,submissions:[]},marketAccounts:[expectedAccount]},plan:id=>{assert.equal(id,plan.id);return plan;},faulted:false,closing:false,emit:()=>{},persist:async()=>{trace.push('persist:'+engine.db.publications.submissions[0]?.state);writes.push(clone(engine.db.publications));try{await options.onPersist?.(api,engine.db.publications);}catch(e){engine.faulted=true;throw e;}}};
 const evidenceFactory=()=>({readPass:async()=>{reads++;trace.push('read:'+reads);await options.onRead?.(api,reads);return clone(pass);}});
 const submitter=new VintedPublishSubmit({enabled:options.enabled??true,evidenceFactory,visualDelayMs:options.visualDelayMs??0,navigationWaitMs:options.navigationWaitMs??0,timeoutMs:options.timeoutMs??1000,dispatchTimeoutMs:options.dispatchTimeoutMs??30000});
 const api={submitter,engine,input,plan,pass,tab,w,contents,target,events,writes,feedback,trace,photoSource,get reads(){return reads;},get targets(){return targets;},get probes(){return probes;},close(){closed=true;contents.emit('destroyed');},run(extra={}){return submitter.submit({engine,planId:plan.id,input,guard:()=>{},...extra});}};
 return api;
}

test('live dispatch is disabled by default and no proof or journal action starts',async()=>{
 const f=fixture();f.submitter=new VintedPublishSubmit();await assert.rejects(f.submitter.submit({engine:f.engine,planId:f.plan.id,input:f.input}),{code:'PUBLICATION_NOT_ENABLED'});assert.equal(f.events.length,0);assert.equal(f.writes.length,0);
});

test('session submit uses its original capability with no stored account or final menu while clicking only once',async()=>{
 const f=fixture({navigate:'https://www.vinted.fr/items/98765',onAtomic:(_f,state)=>{state.account=null;}}),authority=createEnvironmentSessionAuthority(f.plan.profileId);
 f.input.expectedAccount=authority;f.pass.account={...authority};f.engine.db.marketAccounts=[];
 const result=await f.run();assert.equal(result.clickIssued,true);assert.equal(result.state,'uncertain');assert.equal(result.navigationCandidate.listingId,'98765');assert.equal(f.events.filter(row=>row.type==='mouseDown').length,1);
 assert.deepEqual(f.engine.db.publications.submissions[0].proof.facts.account,{kind:'environment-session',profileId:f.plan.profileId});
 await assert.rejects(f.run());assert.equal(f.events.filter(row=>row.type==='mouseDown').length,1);
});

test('session flag copies are rejected and final field changes still stop publication',async()=>{
 const forged=fixture();forged.input.expectedAccount={kind:'environment-session',profileId:forged.plan.profileId};forged.pass.account={...forged.input.expectedAccount};forged.engine.db.marketAccounts=[];
 await assert.rejects(forged.run(),{code:'PUBLICATION_SESSION_UNTRUSTED'});assert.equal(forged.events.length,0);assert.equal(forged.writes.length,0);
 const changed=fixture({onAtomic:(_f,state)=>{state.account=null;state.form.fields.find(row=>row.field==='title').value='Different product';}});changed.input.expectedAccount=createEnvironmentSessionAuthority(changed.plan.profileId);changed.pass.account={...changed.input.expectedAccount};changed.engine.db.marketAccounts=[];
 await assert.rejects(changed.run(),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(changed.events.filter(row=>row.type==='mouseDown').length,0);
});

test('one durable submission produces exactly one native click after visual feedback and fresh full proof',async()=>{
 const f=fixture(),result=await f.run();assert.equal(result.published,false);assert.equal(result.saved,false);assert.equal(result.state,'uncertain');assert.equal(result.canRetry,false);assert.equal(result.clickIssued,true);assert.deepEqual(f.events.map(event=>event.type),['mouseMove','mouseDown','mouseUp']);assert.ok(f.reads>=6);assert.equal(f.w.vintedDraftController,null);
 const nativeIndex=f.trace.indexOf('input:mouseDown'),lastRead=f.trace.lastIndexOf('read:6'),acting=f.trace.indexOf('feedback:acting'),stored=f.trace.indexOf('persist:dispatching');assert.ok(lastRead>acting&&lastRead>stored&&nativeIndex>lastRead);assert.equal(f.writes[0].submissions[0].state,'prepared');assert.equal(f.engine.db.publications.submissions[0].attemptCount,1);
 assert.equal(JSON.stringify(result).includes('/private/image.jpg'),false);
});

test('another submit cannot replay an uncertain publication',async()=>{
 const f=fixture();await f.run();await assert.rejects(f.run(),{code:'PUBLICATION_EXISTS'});assert.equal(f.events.filter(event=>event.type==='mouseDown').length,1);
 const journal=publicationJournal(f.engine);assert.equal(journal,publicationJournal(f.engine));assert.equal(journal.state().submissions.length,1);
});

test('publication maps the proven CSS target once and refuses a resize during the final native read',async()=>{
 const setup=async f=>{const controller=createDisplayController(f.contents,{metrics:{width:400,height:800},send:async()=>{}});await controller.update({scale:.5,bounds:{x:0,y:0,width:200,height:400}});await controller.configure();return controller;};
 const good=fixture();await setup(good);await good.run();assert.deepEqual(good.events.map(event=>({type:event.type,x:event.x,y:event.y})),[{type:'mouseMove',x:45,y:60},{type:'mouseDown',x:45,y:60},{type:'mouseUp',x:45,y:60}]);assert.equal(good.engine.db.publications.submissions[0].attemptCount,1);
 let controller;const changed=fixture({onAtomic:()=>{void controller.update({scale:.75,bounds:{x:0,y:0,width:300,height:600}});}});controller=await setup(changed);await assert.rejects(changed.run());assert.equal(changed.events.filter(event=>event.type==='mouseDown').length,0);
});

test('a native press failure still releases the started gesture once at its original point',async()=>{
 const f=fixture({onInput:(_api,event)=>{if(event.type==='mouseDown')throw Error('Native press failed');}});
 await assert.rejects(f.run());assert.deepEqual(f.events.map(event=>event.type),['mouseMove','mouseDown','mouseUp']);assert.deepEqual(f.events.at(-1),{type:'mouseUp',x:90,y:120,button:'left',clickCount:1});assert.equal(f.engine.db.publications.submissions[0].attemptCount,1);assert.equal(f.engine.db.publications.submissions[0].state,'uncertain');
});

test('native click navigation is persisted as a candidate, never as a completed listing receipt',async()=>{
 const f=fixture({navigate:'https://www.vinted.fr/items/98765-accessoire?tracking=private',navigationWaitMs:20}),result=await f.run(),record=f.engine.db.publications.submissions[0];
 assert.equal(record.state,'uncertain');assert.equal(record.receipt,null);assert.equal(record.navigation.length,2);assert.equal(record.navigation[0].committed,false);assert.equal(record.navigation[1].committed,true);assert.equal(record.navigation[1].formDocumentKey,'100.1');assert.equal(result.navigationCandidate.listingId,'98765');assert.equal(result.navigationCandidate.url,'https://www.vinted.fr/items/98765');assert.equal(JSON.stringify(record.navigation).includes('tracking'),false);assert.equal(result.published,false);
});

test('unrelated or foreign redirects never produce a publication candidate',async()=>{
 for(const navigate of ['https://www.vinted.fr/member/123','https://www.vinted.fr/items/new?failed=1','https://www.vinted.fr.evil.test/items/555']){
  const f=fixture({navigate,navigationWaitMs:5}),result=await f.run();assert.equal(result.navigationCandidate,null);assert.equal(result.state,'uncertain');assert.equal(result.published,false);
 }
});

test('AI activity, existing page lock and another active tab prevent native input',async()=>{
 for(const change of [f=>f.w.aiAgent.state.running=true,f=>f.w.vintedDraftController=new AbortController(),f=>f.w.activeTab='other']){
  const f=fixture();change(f);await assert.rejects(f.run());assert.equal(f.events.length,0);assert.equal(f.engine.db.publications.submissions.length,0);
 }
});

test('a concurrent same-window submission cannot acquire the publication controller',async()=>{
 let release,entered;const pending=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const f=fixture({onRead:async(_f,count)=>{if(count===1){entered();await pending;}}}),first=f.run();await started;await assert.rejects(f.run(),{code:'PAGE_BUSY'});release();await first;assert.equal(f.events.filter(event=>event.type==='mouseDown').length,1);
});

test('a changed account, price, photo or document during visual feedback stops before dispatch',async()=>{
 const changes=[f=>f.pass.account.memberId='999',f=>f.pass.fields.find(field=>field.field==='priceCents').value=600,f=>f.pass.photos.signature='c'.repeat(64),f=>f.pass.documentKey='other'];
 for(const change of changes){const f=fixture({onFeedback:(api,event)=>{if(event.stage==='preparing')change(api);}});await assert.rejects(f.run());assert.equal(f.events.length,0);assert.equal(f.engine.db.publications.submissions[0].state,'cancelled');assert.equal(f.engine.db.publications.submissions[0].attemptCount,0);}
});

test('changes during the acting overlay or dispatch fsync are reread after durability and prevent clicking',async()=>{
 const f=fixture({onFeedback:(api,event)=>{if(event.stage==='acting')api.pass.fields.find(field=>field.field==='priceCents').value=600;}});await assert.rejects(f.run(),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(f.events.length,0);assert.equal(f.engine.db.publications.submissions[0].state,'uncertain');
 const g=fixture({onPersist:(api,state)=>{if(state.submissions[0]?.state==='dispatching')api.pass.photos.signature='c'.repeat(64);}});await assert.rejects(g.run(),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(g.events.length,0);
});

test('final native field and category leaf changes, parcel changes, or a moved/covered button block input',async()=>{
 const changes=[
  result=>result.fields.find(field=>field.field==='priceCents').value='6,00',result=>result.fields.find(field=>field.field==='categoryPath').value='Other accessories',
  result=>{result.parcel[1].checked=false;result.parcel[2].checked=true;},result=>result.unknownFields.push({label:'Matériau',populated:true})
 ];
 for(const change of changes){const f=fixture({onProbe:(_f,result)=>change(result)});await assert.rejects(f.run(),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(f.events.length,0);}
 for(const change of [f=>f.target.error='ambiguous-form',f=>f.target.point=null,f=>f.target.label='Sauvegarder le brouillon']){
  const f=fixture({onResolve:(api,count)=>{if(count===3)change(api);}});await assert.rejects(f.run(),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(f.events.length,0);
 }
});

test('plan or bound account changes are blocked again at the native input boundary',async()=>{
 for(const change of [f=>f.plan.enabled=false,f=>f.engine.db.marketAccounts[0].memberId='999',f=>f.w.aiAgent.state.running=true]){
  const f=fixture({onFocus:change});await assert.rejects(f.run(),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(f.events.length,0);
 }
});

test('page-only account and photo changes after final proof are caught in the single final read',async()=>{
 for(const change of [f=>f.pass.account.memberId='999',f=>f.photoSource='https://images.vinted.test/replaced.jpg']){
  const f=fixture({onTarget:(api,scroll)=>{if(!scroll)change(api);}});
  await assert.rejects(f.run(),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(f.events.length,0);assert.equal(f.engine.db.marketAccounts[0].memberId,'123');assert.equal(f.engine.db.publications.submissions[0].state,'uncertain');
 }
});

test('the atomic boundary rejects account, photo, field, challenge and optional control ambiguity',async()=>{
 const changes=[state=>state.account.menus=[],state=>state.account.menus[0].valid=false,state=>state.account.documentKey='other',
  state=>state.photos.images[0].loaded=false,state=>state.photos.images[0].source='blob:local',state=>state.photos.images[0].alt='Photo 1 sur 2',state=>state.photos.busy=true,state=>state.photos.controls=[],state=>state.photos.images.push(clone(state.photos.images[0])),
  state=>state.form.fields.pop(),state=>state.form.parcel[1].disabled=true,state=>state.form.unknownFields.push({label:'Boost',populated:true}),state=>state.challenge=true];
 for(const change of changes){const f=fixture({onAtomic:(_api,state)=>change(state)});await assert.rejects(f.run(),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(f.events.length,0);}
 const f=fixture({onAtomic:api=>{api.engine.adapter.photos.claims.values().next().value.signature='c'.repeat(64);}});await assert.rejects(f.run(),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(f.events.length,0);
});

test('a page-provided closed-menu claim cannot replace an unexpired main-process account receipt',async()=>{
 const f=fixture({onAtomic:(_api,state)=>{state.account=null;state.closedAccount={verified:true,valid:true,closed:true,documentKey:'100.1',memberId:'123',profileURL:'https://www.vinted.fr/member/123'};}});
 await assert.rejects(f.run(),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(f.events.length,0);assert.equal(f.engine.db.publications.submissions[0].attemptCount,1);
});

test('dispatch deadline revokes the click controller while uncertain persistence remains blocked',async()=>{
 let releaseRead,releasePersist,enteredPersist;const readPending=new Promise(resolve=>{releaseRead=resolve;}),persistPending=new Promise(resolve=>{releasePersist=resolve;}),persistEntered=new Promise(resolve=>{enteredPersist=resolve;});
 const f=fixture({timeoutMs:1000,dispatchTimeoutMs:25,onRead:(_api,count)=>count===5?readPending:undefined,onPersist:async(_api,state)=>{if(state.submissions[0]?.state==='uncertain'){enteredPersist();await persistPending;}}});
 const pending=f.run(),checked=assert.rejects(pending,{code:'PUBLICATION_SUBMIT_TIMEOUT'});await persistEntered;
 assert.equal(f.w.vintedDraftController.signal.aborted,true);assert.equal(f.events.length,0);
 releaseRead();await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.events.length,0);assert.equal(f.reads,5);
 releasePersist();await checked;assert.equal(f.events.length,0);assert.equal(f.w.vintedDraftController,null);
});

test('dispatch fsync cannot preserve a usable click context past its deadline',async()=>{
 let release,entered;const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const f=fixture({timeoutMs:1000,dispatchTimeoutMs:25,onPersist:async(_api,state)=>{if(state.submissions[0]?.state==='dispatching'){entered();await waiting;}}});
 const pending=f.run(),checked=assert.rejects(pending,{code:'PUBLICATION_SUBMIT_TIMEOUT'});await started;await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.w.vintedDraftController.signal.aborted,true);release();await checked;assert.equal(f.events.length,0);assert.equal(f.reads,4);
});

test('cancelled or timed-out overlay and proof work can never issue a late click after resolving',async()=>{
 for(const phase of ['overlay','final-proof']){
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const f=fixture({timeoutMs:25,onFeedback:(_f,event)=>phase==='overlay'&&event.stage==='preparing'?pending:undefined,onRead:(_f,count)=>phase==='final-proof'&&count===5?pending:undefined});
  await assert.rejects(f.run(),{code:'PUBLICATION_SUBMIT_TIMEOUT'});assert.equal(f.events.length,0);assert.equal(f.w.vintedDraftController,null);release();await new Promise(resolve=>setTimeout(resolve,15));assert.equal(f.events.length,0);assert.equal(f.engine.db.publications.submissions[0].state,phase==='overlay'?'cancelled':'uncertain');
 }
});

test('external cancellation and pre-click navigation stop a prepared action without publication',async()=>{
 const controller=new AbortController(),f=fixture({onFeedback:(_f,event)=>{if(event.stage==='preparing')controller.abort();}});await assert.rejects(f.run({signal:controller.signal}),{code:'STOPPED'});assert.equal(f.events.length,0);
 const g=fixture({onFeedback:(api,event)=>{if(event.stage==='preparing')api.contents.emit('did-start-navigation',{},'https://www.vinted.fr/',false,true);}});await assert.rejects(g.run(),{code:'STOPPED'});assert.equal(g.events.length,0);assert.equal(g.contents.listenerCount('did-start-navigation'),0);
});

test('storage failure before click cannot proceed, and journal ownership detects external record replacement',async()=>{
 const f=fixture({onPersist:(_api,state)=>{if(state.submissions[0]?.state==='dispatching')throw Error('fsync failed');}});await assert.rejects(f.run(),{code:'PUBLICATION_STORAGE_FAILED'});assert.equal(f.events.length,0);assert.equal(f.engine.faulted,true);
 const g=fixture();publicationJournal(g.engine);g.engine.db.publications.submissions.push({unexpected:true});await assert.rejects(g.run(),{code:'PUBLICATION_STORAGE_CHANGED'});assert.equal(g.events.length,0);
});

test('navigation persistence failure keeps the submission uncertain and reports an ambiguous result',async()=>{
 const f=fixture({navigate:'https://www.vinted.fr/items/98765',onPersist:(_f,state)=>{if(state.submissions[0]?.navigation?.length)throw Error('disk full');}});
 await assert.rejects(f.run(),caught=>caught.ambiguous===true);assert.equal(f.events.filter(event=>event.type==='mouseDown').length,1);assert.equal(f.engine.faulted,true);
});

async function deletionFixture(){
 const f=fixture();await f.run();Object.assign(f.engine.db,{plans:[clone(f.plan)],claims:[{...clone(f.input.claim),listings:[]}],jobs:[{id:'old-job',type:'listing',profileId:f.plan.profileId,productId:f.plan.productId,planId:f.plan.id,dedupeKey:'listing:plan-1:0',payload:{cycle:0},state:'needs_review',step:'pending',operation:null,mutationPending:false,result:null}],sales:[],publicationSupplierSync:[]});
 const record=f.engine.db.publications.submissions[0],evidence={kind:'operator_confirmed_deletion',confirmed:true,reason:'deleted_not_sold',reviewId:'deletion-review-1',profileId:f.plan.profileId,memberId:'123',listingId:'98765',url:'https://www.vinted.fr/items/98765',confirmedAt:new Date().toISOString()};
 const stage=(before,state)=>{const next=clone(before);next.publications=state;Object.assign(next.plans[0],{listingRevision:1,activeListingId:null,status:'ready'});Object.assign(next.jobs[0],{state:'cancelled',step:'listing_deleted',result:{kind:'listing_deleted',externalId:'98765',submissionId:record.id}});next.jobs.push({...clone(before.jobs[0]),id:'new-job',dedupeKey:'listing:plan-1:0:r1',payload:{cycle:0,listingRevision:1},state:'queued'});return next;};
 return {f,record,evidence,stage};
}

test('operator deletion bridge persists withdrawal, unchanged sales and new revision queue in one durable engine snapshot',async()=>{
 const {f,record,evidence,stage}=await deletionFixture(),writes=[],beforeEvents=f.events.length;f.engine.persist=async()=>{writes.push(clone(f.engine.db));};
 const result=await commitPublicationDeletion(f.engine,record.id,evidence,stage);assert.equal(writes.length,1);const db=writes[0];assert.deepEqual(db.publications.submissions[0].proof,record.proof);assert.equal(result.closedWithdrawal.reviewId,evidence.reviewId);assert.equal(db.plans[0].completedCount,0);assert.equal(db.plans[0].listingRevision,1);assert.equal(db.jobs[0].state,'cancelled');assert.equal(db.jobs[1].dedupeKey,'listing:plan-1:0:r1');assert.deepEqual(db.sales,[]);assert.equal(f.events.length,beforeEvents);assert.deepEqual(publicationJournal(f.engine).state(),db.publications);
 await assert.rejects(commitPublicationDeletion(f.engine,record.id,evidence,stage),{code:'PUBLICATION_DELETION_CLOSED'});assert.equal(writes.length,1);
});

test('deletion bridge rejects a partial journal-only release or a stage that changes sales counts',async()=>{
 const a=await deletionFixture(),before=clone(a.f.engine.db);await assert.rejects(publicationJournal(a.f.engine).releaseAfterDeletion(a.record.id,a.evidence),{code:'PUBLICATION_STORAGE_FAILED'});assert.deepEqual(a.f.engine.db,before);
 for(const change of [db=>db.plans[0].completedCount++,db=>db.sales.push({id:'fabricated-sale'}),db=>db.plans[0].listingRevision=0,db=>db.plans[0].listingRevision=2]){
  const {f,record,evidence,stage}=await deletionFixture(),original=clone(f.engine.db);await assert.rejects(commitPublicationDeletion(f.engine,record.id,evidence,(old,state)=>{const next=stage(old,state);change(next);return next;}),{code:'PUBLICATION_STORAGE_FAILED'});assert.deepEqual(f.engine.db,original);
 }
});

test('deletion fsync failure rolls engine and shared journal back with original job intact',async()=>{
 const {f,record,evidence,stage}=await deletionFixture(),before=clone(f.engine.db);f.engine.persist=async()=>{assert.equal(f.engine.db.plans[0].listingRevision,1);assert.ok(f.engine.db.publications.submissions[0].closedWithdrawal);throw Error('disk full');};
 await assert.rejects(commitPublicationDeletion(f.engine,record.id,evidence,stage),{code:'PUBLICATION_STORAGE_FAILED'});assert.deepEqual(f.engine.db,before);assert.equal(f.engine.faulted,true);assert.deepEqual(publicationJournal(f.engine).state(),before.publications);
});

test('a stopped deletion guard and concurrent deletion cannot mutate the old publication twice',async()=>{
 const {f,record,evidence,stage}=await deletionFixture(),before=clone(f.engine.db);await assert.rejects(commitPublicationDeletion(f.engine,record.id,evidence,stage,{guard:()=>{throw Object.assign(Error('stopped'),{code:'STOPPED'});}}),{code:'STOPPED'});assert.deepEqual(f.engine.db,before);
 let release,entered;const pending=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{entered=resolve;});f.engine.persist=async()=>{entered();await pending;};const first=commitPublicationDeletion(f.engine,record.id,evidence,stage);await began;
 await assert.rejects(commitPublicationDeletion(f.engine,record.id,evidence,stage));release();await first;assert.equal(f.engine.db.plans[0].listingRevision,1);assert.equal(f.engine.db.jobs.length,2);
});

test('a relisting revision changed at native input boundary prevents publication of a stale version',async()=>{
 const f=fixture({onFocus:api=>{api.plan.listingRevision=1;}});await assert.rejects(f.run(),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(f.events.length,0);
});
