'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {buildPublicationProof,validatePublicationReceipt,restorePublicationState,PublicationJournal,listingRevision,listingJobKey,isPublicationOpen,FORM_URL,MAX_PROOF_AGE_MS}=require('../src/vinted-publication.cjs');
const START=Date.parse('2026-10-14T10:00:00.000Z');
const clone=value=>JSON.parse(JSON.stringify(value));
const iso=value=>new Date(value).toISOString();
function inputs(){
 const profileId='environment-1',listing={title:'Accessoire pour aspirateur noir neuf',description:'Sans marque. Article neuf, sans étiquette ni emballage d’origine.',categoryPath:['Maison','Entretien de la maison','Aspirateurs et nettoyage','Accessoires pour appareils de nettoyage'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
 const plan={id:'plan-1',profileId,productId:'product-1',sku:'TEST',enabled:true,completedCount:0,targetCount:2,activeListingId:null,currency:'EUR',listingPriceCents:500,listing};
 const expectedAccount={profileId,memberId:'123456',profileURL:'https://www.vinted.fr/member/123456-seller'},documentKey='12345.67';
 const evidence={profileId,tabId:'tab-1',url:FORM_URL,documentKey,observedAt:iso(START),challenge:false,account:{...expectedAccount,verified:true},
  form:{documentKey,complete:true,invalidFields:[],unknownFields:[],fields:Object.entries({...listing,priceCents:500}).map(([field,value])=>({field,value,verified:true}))},
  photos:{documentKey,profileId,productId:plan.productId,claimId:'claim-1',setId:'set-1',count:1,signature:'a'.repeat(64),verified:true,busy:false,errorCount:0},
  publication:{documentKey,count:1,observed:true,label:'Ajouter',enabled:true}};
 return {plan,product:{id:plan.productId,sku:'TEST',stock:5},claim:{id:'claim-1',profileId,productId:plan.productId,setId:'set-1',images:[{id:'image-1'}]},expectedAccount,evidence};
}
function fixture(options={}){
 let clock=START,disk=options.state,writes=0,failWrites=false;const written=[];
 const journal=new PublicationJournal({state:options.state,now:()=>clock,dispatchEnabled:options.enabled??true,persist:async state=>{writes++;if(failWrites)throw Error('disk full');await options.beforePersist?.(state);disk=clone(state);written.push(clone(state));}});
 return {journal,proof:()=>buildPublicationProof(inputs(),{now:clock}),get disk(){return clone(disk);},get writes(){return writes;},written,setNow(value){clock=value;},failWrites(){failWrites=true;}};
}
function evidenceFor(record,now=START){
 const facts=record.proof.facts,member={...facts.account,verified:true};
 return {verified:true,mappingVerified:true,publicationStatus:'published',observedAt:iso(now),profileId:facts.profileId,account:member,seller:clone(member),ownedByCurrentAccount:true,listingId:'98765',url:'https://www.vinted.fr/items/98765-vacuum-accessory',origin:{kind:'observed_submission_navigation',submissionId:record.id,formDocumentKey:facts.documentKey},priceKind:'item',priceCents:500,currency:'EUR',title:facts.fields.title,photos:{verified:true,count:1,signature:'a'.repeat(64)}};
}
function saleFor(record,overrides={}){const facts=record.proof.facts;return {verified:true,profileId:facts.profileId,memberId:facts.account.memberId,listingId:'98765',orderId:'order-1',paid:true,cancelled:false,quantity:1,priceCents:500,currency:'EUR',observedAt:iso(START),...overrides};}
async function sent(fixtureValue=fixture()){
 const proof=fixtureValue.proof(),record=await fixtureValue.journal.prepare(proof);await fixtureValue.journal.dispatchOnce(record.id,proof,async()=>{});return {f:fixtureValue,record:fixtureValue.journal.get(record.id)};
}

test('publication proof binds all eight fields, environment, account, document, stock and photo claim without leaking file paths',()=>{
 const input=inputs(),proof=buildPublicationProof(input,{now:START});
 assert.equal(Object.keys(proof.facts.fields).length,8);assert.equal(proof.facts.fields.priceCents,500);assert.equal(proof.facts.account.profileURL,'https://www.vinted.fr/member/123456');
 assert.equal(proof.facts.photos.claimId,'claim-1');assert.equal(proof.facts.cycle,0);assert.equal(proof.expiresAt,iso(START+MAX_PROOF_AGE_MS));
 assert.equal(Object.isFrozen(proof),true);assert.equal(Object.isFrozen(proof.facts.fields.categoryPath),true);
 input.evidence.form.fields[0].value='changed';input.plan.sku='changed';assert.equal(proof.facts.sku,'TEST');
 assert.equal(JSON.stringify(proof).includes('image-1'),false);
});

test('every identity mismatch and incomplete publication condition blocks proof creation',()=>{
 const changes=[
  v=>v.plan.enabled=false,v=>v.plan.activeListingId='777',v=>v.plan.completedCount=2,v=>v.plan.currency='USD',
  v=>v.product.id='another',v=>v.product.sku='other',v=>v.product.stock=0,v=>v.product.stock=null,
  v=>v.evidence.profileId='other',v=>v.evidence.url=FORM_URL+'?draft=12',v=>v.evidence.url='https://www.vinted.fr/items/1/edit',
  v=>v.evidence.account.memberId='999',v=>v.evidence.account.verified=false,v=>v.evidence.account.profileId='other',
  v=>v.evidence.account.profileURL='https://www.vinted.fr/member/777',v=>v.evidence.challenge=true,v=>delete v.evidence.challenge,
  v=>v.evidence.form.documentKey='other',v=>v.evidence.form.complete=false,v=>v.evidence.form.invalidFields=['condition'],v=>v.evidence.form.unknownFields=['material'],
  v=>v.evidence.form.fields.pop(),v=>v.evidence.form.fields.push(v.evidence.form.fields[0]),v=>v.evidence.form.fields[0].verified=false,
  v=>v.evidence.photos.documentKey='other',v=>v.evidence.photos.claimId='other',v=>v.evidence.photos.productId='other',v=>v.evidence.photos.profileId='other',v=>v.evidence.photos.setId='other',
  v=>v.evidence.photos.count=2,v=>v.evidence.photos.signature='raw-file-url',v=>v.evidence.photos.verified=false,v=>v.evidence.photos.busy=true,v=>v.evidence.photos.errorCount=1,
  v=>v.claim.profileId='other',v=>v.claim.productId='other',v=>v.claim.images=[],v=>v.evidence.publication.documentKey='other',v=>v.evidence.publication.count=2,
  v=>v.evidence.publication.enabled=false,v=>v.evidence.publication.label='Sauvegarder le brouillon',v=>v.evidence.publication.observed=false
 ];
 for(const change of changes){const value=inputs();change(value);assert.throws(()=>buildPublicationProof(value,{now:START}),undefined,String(change));}
});

test('each of the eight field values must match, including full category path rather than leaf alone',()=>{
 for(const name of ['title','description','categoryPath','priceCents','condition','brand','color','parcel']){
  const input=inputs(),field=input.evidence.form.fields.find(field=>field.field===name);field.value=name==='categoryPath'?[field.value.at(-1)]:name==='priceCents'?600:'wrong';
  assert.throws(()=>buildPublicationProof(input,{now:START}),{code:'PUBLICATION_MISMATCH'},name);
 }
 const input=inputs();input.plan.listing.size='M';input.evidence.form.fields.push({field:'size',value:'M',verified:true});assert.equal(buildPublicationProof(input,{now:START}).facts.fields.size,'M');
});

test('old, future, malformed and invalid-clock observations cannot authorize publication',()=>{
 for(const observedAt of [iso(START-MAX_PROOF_AGE_MS-1),iso(START+1),'yesterday','2026-10-14T10:00:00Z']){
  const input=inputs();input.evidence.observedAt=observedAt;assert.throws(()=>buildPublicationProof(input,{now:START}));
 }
 assert.throws(()=>buildPublicationProof(inputs(),{now:NaN}));
});

test('dispatch is disabled by default even when the data proof is valid',async()=>{
 const journal=new PublicationJournal({persist:()=>{},now:()=>START}),proof=buildPublicationProof(inputs(),{now:START}),record=await journal.prepare(proof);let calls=0;
 await assert.rejects(journal.dispatchOnce(record.id,proof,async()=>{calls++;}),{code:'PUBLICATION_NOT_ENABLED'});assert.equal(calls,0);assert.equal(journal.get(record.id).attemptCount,0);
});

test('serialized or renderer-shaped proofs never authorize preparation or dispatch',async()=>{
 const f=fixture(),proof=f.proof();await assert.rejects(f.journal.prepare(clone(proof)),{code:'PUBLICATION_UNTRUSTED'});
 const record=await f.journal.prepare(proof);await assert.rejects(f.journal.dispatchOnce(record.id,clone(proof),async()=>{assert.fail('must not dispatch');}),{code:'PUBLICATION_UNTRUSTED'});
});

test('publication intent is durable before the one permitted external action; action result alone stays uncertain',async()=>{
 const f=fixture(),proof=f.proof(),record=await f.journal.prepare(proof);let calls=0;
 const result=await f.journal.dispatchOnce(record.id,proof,async intent=>{
  calls++;assert.equal(f.disk.submissions[0].state,'dispatching');assert.equal(f.disk.submissions[0].attemptCount,1);assert.equal(intent.submissionId,record.id);assert.equal(Object.isFrozen(intent),true);
  return {verified:true,listingId:'fake'};
 });
 assert.equal(calls,1);assert.equal(result.state,'uncertain');assert.equal(result.receipt,null);assert.equal(f.disk.submissions[0].state,'uncertain');
 await assert.rejects(f.journal.dispatchOnce(record.id,proof,async()=>{calls++;}),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(calls,1);
});

test('simultaneous publication calls cannot double click even while the first callback is pending',async()=>{
 const f=fixture(),proof=f.proof(),record=await f.journal.prepare(proof);let release,started;const gate=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{started=resolve;});let calls=0;
 const first=f.journal.dispatchOnce(record.id,proof,async()=>{calls++;started();await gate;});await began;
 await assert.rejects(f.journal.dispatchOnce(record.id,proof,async()=>{calls++;}),{code:'PUBLICATION_UNKNOWN_RESULT'});release();await first;assert.equal(calls,1);
});

test('failed persistence blocks every later action and never invokes the click callback',async()=>{
 const f=fixture(),proof=f.proof(),record=await f.journal.prepare(proof);f.failWrites();let calls=0;
 await assert.rejects(f.journal.dispatchOnce(record.id,proof,async()=>{calls++;}),{code:'PUBLICATION_STORAGE_FAILED'});
 assert.equal(calls,0);assert.equal(f.journal.faulted,true);await assert.rejects(f.journal.prepare(proof),{code:'PUBLICATION_STORAGE_FAILED'});
});

test('a clock expiry during durable persistence prevents dispatch and conservatively records uncertainty',async()=>{
 let f;f=fixture({beforePersist:state=>{if(state.submissions[0]?.state==='dispatching')f.setNow(START+MAX_PROOF_AGE_MS+1);}});
 const proof=f.proof(),record=await f.journal.prepare(proof);let calls=0;
 await assert.rejects(f.journal.dispatchOnce(record.id,proof,async()=>{calls++;}),{code:'PUBLICATION_UNKNOWN_RESULT'});
 assert.equal(calls,0);assert.equal(f.journal.get(record.id).state,'uncertain');assert.equal(f.disk.submissions[0].attemptCount,1);
});

test('changed page proof and cancellation stop before dispatch',async()=>{
 const f=fixture(),proof=f.proof(),record=await f.journal.prepare(proof),input=inputs();input.evidence.tabId='tab-2';
 await assert.rejects(f.journal.dispatchOnce(record.id,buildPublicationProof(input,{now:START}),async()=>assert.fail()),{code:'PUBLICATION_MISMATCH'});
 const controller=new AbortController();controller.abort();await assert.rejects(f.journal.dispatchOnce(record.id,proof,async()=>assert.fail(),{signal:controller.signal}),{code:'STOPPED'});
 assert.equal(f.journal.get(record.id).state,'prepared');
});

test('a callback failure cannot become a retryable or cancelled publication',async()=>{
 const f=fixture(),proof=f.proof(),record=await f.journal.prepare(proof);
 await assert.rejects(f.journal.dispatchOnce(record.id,proof,async()=>{throw Error('connection closed');}),{code:'PUBLICATION_UNKNOWN_RESULT',ambiguous:true});
 assert.equal(f.journal.get(record.id).state,'uncertain');await assert.rejects(f.journal.cancelPrepared(record.id),{code:'PUBLICATION_UNKNOWN_RESULT'});
});

test('a hanging or cancelled action becomes uncertain; a late completion never unlocks replay',async()=>{
 for(const abort of [false,true]){
  const f=fixture(),proof=f.proof(),record=await f.journal.prepare(proof),controller=new AbortController();let release,calls=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const action=f.journal.dispatchOnce(record.id,proof,async()=>{calls++;if(abort)controller.abort();await gate;},{signal:controller.signal,timeoutMs:10});
  await assert.rejects(action,{code:'PUBLICATION_UNKNOWN_RESULT',ambiguous:true});assert.equal(f.journal.get(record.id).state,'uncertain');release();await Promise.resolve();
  await assert.rejects(f.journal.dispatchOnce(record.id,proof,async()=>{calls++;}),{code:'PUBLICATION_UNKNOWN_RESULT'});assert.equal(calls,1);
 }
});

test('fresh actual listing evidence reconciles to published and repeated verification cannot replace the listing',async()=>{
 const {f,record}=await sent(),evidence=evidenceFor(record),verified=await f.journal.reconcile(record.id,evidence);
 assert.equal(verified.state,'published');assert.equal(verified.receipt.url,'https://www.vinted.fr/items/98765');assert.equal(verified.receipt.memberId,'123456');
 assert.deepEqual((await f.journal.reconcile(record.id,evidence)).receipt,verified.receipt);
 evidence.listingId='98766';evidence.url='https://www.vinted.fr/items/98766';await assert.rejects(f.journal.reconcile(record.id,evidence),{code:'PUBLICATION_MISMATCH'});
 assert.equal(f.journal.get(record.id).receipt.listingId,'98765');
});

test('completion needs real account, seller, item price, title, photos and attribution; no toast or redirect shortcut',async()=>{
 const {f,record}=await sent();
 const changes=[
  v=>v.mappingVerified=false,v=>v.verified=false,v=>v.publicationStatus='under_review',v=>v.profileId='other',
  v=>v.account.verified=false,v=>v.seller.verified=false,v=>v.seller.memberId='444',v=>v.ownedByCurrentAccount=false,
  v=>v.origin.submissionId='other',v=>v.origin.formDocumentKey='other',v=>v.origin.kind='matching_title_search',
  v=>v.priceKind='total',v=>v.priceCents=501,v=>v.currency='USD',v=>v.title='Other',v=>v.photos.count=2,v=>v.photos.signature='b'.repeat(64),v=>v.photos.verified=false,
  v=>v.listingId='new',v=>v.url='https://www.vinted.fr/items/new',v=>v.url='https://www.vinted.fr/items/555',v=>v.url='https://www.vinted.fr/items/98765/edit',v=>v.url='https://www.vinted.fr.evil.test/items/98765',v=>v.url='https://www.vinted.fr/items/98765?receipt=1',
  v=>v.observedAt=iso(START-1),v=>v.observedAt=iso(START+1)
 ];
 for(const change of changes){const evidence=evidenceFor(record);change(evidence);await assert.rejects(f.journal.reconcile(record.id,evidence),undefined,String(change));assert.equal(f.journal.get(record.id).state,'uncertain');}
});

test('a never-submitted preparation cannot adopt an existing listing as its own result',async()=>{
 const f=fixture(),record=await f.journal.prepare(f.proof());await assert.rejects(f.journal.reconcile(record.id,evidenceFor(record)),{code:'PUBLICATION_NOT_SUBMITTED'});
 assert.throws(()=>validatePublicationReceipt(record,evidenceFor(record),{now:START}),{code:'PUBLICATION_NOT_SUBMITTED'});
});

test('restart converts in-flight dispatch to uncertainty and preserves the one-attempt barrier',async()=>{
 const f=fixture(),proof=f.proof(),record=await f.journal.prepare(proof);let snapshot;
 await f.journal.dispatchOnce(record.id,proof,async()=>{snapshot=f.disk;});
 const restored=restorePublicationState(snapshot,{now:START+1000});assert.equal(restored.recovered,true);assert.equal(restored.state.submissions[0].state,'uncertain');
 const after=fixture({state:snapshot});await assert.rejects(after.journal.dispatchOnce(record.id,after.proof(),async()=>assert.fail()),{code:'PUBLICATION_UNKNOWN_RESULT'});
 assert.equal((await after.journal.reconcile(record.id,evidenceFor(record))).state,'published');
});

test('restart invalidates prepared page evidence, but a never-submitted preparation may be cancelled and rebuilt',async()=>{
 const f=fixture(),record=await f.journal.prepare(f.proof()),after=fixture({state:f.disk});assert.equal(after.journal.get(record.id).state,'needs_review');
 await assert.rejects(after.journal.dispatchOnce(record.id,after.proof(),async()=>assert.fail()),{code:'PUBLICATION_UNKNOWN_RESULT'});
 await after.journal.cancelPrepared(record.id);const replacement=await after.journal.prepare(after.proof());assert.notEqual(replacement.id,record.id);assert.equal(replacement.attemptCount,0);
});

test('same cycle, page, or account and SKU cannot create another publication across isolated environments',async()=>{
 const f=fixture();await f.journal.prepare(f.proof());await assert.rejects(f.journal.prepare(f.proof()),{code:'PUBLICATION_EXISTS'});
 const other=inputs();other.plan.id='plan-2';await assert.rejects(f.journal.prepare(buildPublicationProof(other,{now:START})),{code:'PUBLICATION_EXISTS'});
 other.plan.profileId='environment-2';other.claim.profileId='environment-2';other.expectedAccount.profileId='environment-2';other.evidence.profileId='environment-2';other.evidence.account.profileId='environment-2';other.evidence.photos.profileId='environment-2';
 await assert.rejects(f.journal.prepare(buildPublicationProof(other,{now:START})),{code:'PUBLICATION_EXISTS'});
 other.expectedAccount.memberId='999';other.expectedAccount.profileURL='https://www.vinted.fr/member/999';other.evidence.account={...other.expectedAccount,verified:true};
 assert.equal((await f.journal.prepare(buildPublicationProof(other,{now:START}))).state,'prepared');assert.equal(f.journal.state().submissions.length,2);
});

test('a platform listing ID cannot be attributed to another sales cycle',async()=>{
 const {f,record}=await sent();await f.journal.reconcile(record.id,evidenceFor(record));
 const input=inputs();input.plan.completedCount=1;input.evidence.documentKey='new-document';input.evidence.form.documentKey='new-document';input.evidence.photos.documentKey='new-document';input.evidence.publication.documentKey='new-document';
 const proof=buildPublicationProof(input,{now:START});await assert.rejects(f.journal.prepare(proof),{code:'PUBLICATION_EXISTS'});
 await f.journal.releaseAfterSale(record.id,saleFor(record));const second=await f.journal.prepare(proof);await f.journal.dispatchOnce(second.id,proof,async()=>{});
 await assert.rejects(f.journal.reconcile(second.id,evidenceFor(second)),{code:'PUBLICATION_RECEIPT_CONFLICT'});
});

test('only verified paid sale evidence releases SKU occupancy and never changes the publication attempt count',async()=>{
 const {f,record}=await sent();await f.journal.reconcile(record.id,evidenceFor(record));
 for(const patch of [{paid:false},{verified:false},{cancelled:true},{quantity:2},{profileId:'other'},{memberId:'other'},{listingId:'other'},{currency:'USD'},{priceCents:0},{priceCents:700},{observedAt:iso(START-1)}]){
  await assert.rejects(f.journal.releaseAfterSale(record.id,saleFor(record,patch)));assert.equal(f.journal.get(record.id).closedSale,undefined);
 }
 const released=await f.journal.releaseAfterSale(record.id,saleFor(record));assert.equal(released.state,'published');assert.equal(released.attemptCount,1);assert.equal(released.closedSale.orderId,'order-1');
 assert.equal((await f.journal.releaseAfterSale(record.id,saleFor(record))).closedSale.orderId,'order-1');
 await assert.rejects(f.journal.releaseAfterSale(record.id,saleFor(record,{orderId:'other'})),{code:'PUBLICATION_MISMATCH'});
 await assert.rejects(f.journal.dispatchOnce(record.id,f.proof(),async()=>assert.fail()),{code:'PUBLICATION_UNKNOWN_RESULT'});
 const restored=restorePublicationState(f.disk,{now:START});assert.equal(restored.state.submissions[0].closedSale.orderId,'order-1');
});

test('corrupt durable records fail closed without silently starting a new journal',async()=>{
 const {f}=await sent();
 for(const change of [v=>v.version=2,v=>v.submissions[0].attemptCount=0,v=>v.submissions[0].proof.facts.sku='other',v=>v.submissions.push(clone(v.submissions[0])),v=>v.submissions[0].state='queued',v=>v.submissions[0].receipt={verified:true}]){
  const state=f.disk;change(state);assert.throws(()=>restorePublicationState(state,{now:START}),undefined,String(change));
 }
 const state=f.journal.state();state.submissions[0].proof.facts.sku='changed';assert.equal(f.journal.state().submissions[0].proof.facts.sku,'TEST');
});

function deletionFor(record,overrides={}){return {kind:'operator_confirmed_deletion',confirmed:true,reason:'deleted_not_sold',reviewId:'deletion-review-1',profileId:record.proof.facts.profileId,memberId:record.proof.facts.account.memberId,listingId:'98765',url:'https://www.vinted.fr/items/98765-old-item',confirmedAt:iso(START),...overrides};}
function relistingProof(revision){const input=inputs();input.plan.listingRevision=revision;input.evidence.documentKey='new-document';for(const key of ['form','photos','publication'])input.evidence[key].documentKey='new-document';return buildPublicationProof(input,{now:START});}

test('legacy revision zero preserves proof fingerprint and job keys while positive relisting revisions are distinct',()=>{
 const input=inputs(),legacy=buildPublicationProof(input,{now:START});input.plan.listingRevision=0;const explicitZero=buildPublicationProof(input,{now:START});
 assert.equal(legacy.fingerprint,explicitZero.fingerprint);assert.equal(Object.hasOwn(explicitZero.facts,'listingRevision'),false);assert.equal(listingRevision(),0);assert.equal(listingJobKey('plan-1',0),'listing:plan-1:0');assert.equal(listingJobKey('plan-1',0,1),'listing:plan-1:0:r1');
 input.plan.listingRevision=1;const newer=buildPublicationProof(input,{now:START});assert.equal(newer.facts.listingRevision,1);assert.notEqual(newer.fingerprint,legacy.fingerprint);
 for(const invalid of [null,-1,1.1,'1',NaN,Infinity])assert.throws(()=>listingRevision(invalid),{code:'PUBLICATION_INVALID'});
});

test('operator-confirmed deletion closes an uncertain attempt without creating a receipt, sale or resetting the attempt',async()=>{
 const {f,record}=await sent(),original=clone(record),closed=await f.journal.releaseAfterDeletion(record.id,deletionFor(record));
 assert.equal(closed.state,'uncertain');assert.equal(closed.attemptCount,1);assert.equal(closed.receipt,null);assert.equal(closed.closedSale,undefined);assert.deepEqual(closed.proof,original.proof);assert.equal(closed.submittedAt,original.submittedAt);
 assert.equal(closed.closedWithdrawal.url,'https://www.vinted.fr/items/98765');assert.equal(Object.hasOwn(closed.closedWithdrawal,'verified'),false);assert.equal(isPublicationOpen(closed),false);assert.equal(isPublicationOpen(original),true);
 assert.deepEqual(restorePublicationState(f.disk,{now:START}).state.submissions[0],closed);
 await assert.rejects(f.journal.releaseAfterDeletion(record.id,deletionFor(record)),{code:'PUBLICATION_DELETION_CLOSED'});
 await assert.rejects(f.journal.reconcile(record.id,evidenceFor(record)),{code:'PUBLICATION_WITHDRAWN'});
 await assert.rejects(f.journal.releaseAfterSale(record.id,saleFor(record)),{code:'PUBLICATION_WITHDRAWN'});
});

test('published item deletion retains its verified original receipt but cannot be recounted as a sale',async()=>{
 const {f,record}=await sent(),published=await f.journal.reconcile(record.id,evidenceFor(record)),closed=await f.journal.releaseAfterDeletion(record.id,deletionFor(record));
 assert.equal(closed.state,'published');assert.deepEqual(closed.receipt,published.receipt);assert.deepEqual(closed.proof,published.proof);assert.equal(closed.closedSale,undefined);
 await assert.rejects(f.journal.reconcile(record.id,evidenceFor(record)),{code:'PUBLICATION_WITHDRAWN'});
 await assert.rejects(f.journal.releaseAfterSale(record.id,saleFor(record)),{code:'PUBLICATION_WITHDRAWN'});
 const restored=fixture({state:f.disk});assert.deepEqual(restored.journal.get(record.id).closedWithdrawal,closed.closedWithdrawal);
});

test('only a new revision can relist a deleted item in the unchanged sales cycle; restore retains both immutable attempts',async()=>{
 const {f,record}=await sent();await f.journal.releaseAfterDeletion(record.id,deletionFor(record));
 await assert.rejects(f.journal.prepare(relistingProof(0)),{code:'PUBLICATION_EXISTS'});
 const proof=relistingProof(1),replacement=await f.journal.prepare(proof);await f.journal.dispatchOnce(replacement.id,proof,async()=>{});
 assert.equal(replacement.proof.facts.cycle,record.proof.facts.cycle);assert.equal(replacement.proof.facts.listingRevision,1);assert.notEqual(replacement.id,record.id);assert.equal(f.journal.state().submissions.length,2);
 const state=restorePublicationState(f.disk,{now:START}).state;assert.equal(state.submissions.length,2);assert.equal(isPublicationOpen(state.submissions[0]),false);assert.equal(isPublicationOpen(state.submissions[1]),true);
 await assert.rejects(f.journal.reconcile(replacement.id,evidenceFor(replacement)),{code:'PUBLICATION_RECEIPT_CONFLICT'});
 const receipt=evidenceFor(replacement);receipt.listingId='98766';receipt.url='https://www.vinted.fr/items/98766';assert.equal((await f.journal.reconcile(replacement.id,receipt)).receipt.listingId,'98766');
});

test('revision changes cannot bypass an open original publication occupancy',async()=>{
 const {f}=await sent();await assert.rejects(f.journal.prepare(relistingProof(1)),{code:'PUBLICATION_EXISTS'});
});

test('deletion rejects invalid confirmation, identity, time and attempts to claim website verification without writing',async()=>{
 const {f,record}=await sent(),changes=[{kind:'web_deletion'},{confirmed:false},{reason:'sold'},{reviewId:''},{profileId:'other'},{memberId:'999'},{listingId:'invalid'},{url:'https://www.vinted.fr/items/999'},{confirmedAt:iso(START-1)},{confirmedAt:iso(START+1)},{verified:true},{webVerified:true}];
 for(const patch of changes){const before=f.writes;await assert.rejects(f.journal.releaseAfterDeletion(record.id,deletionFor(record,patch)));assert.equal(f.writes,before);assert.equal(f.journal.get(record.id).closedWithdrawal,undefined);}
 await assert.rejects(f.journal.releaseAfterDeletion(record.id,deletionFor(record),{guard:()=>{throw Object.assign(Error('busy'),{code:'BUSY'});}}),{code:'BUSY'});assert.equal(f.journal.get(record.id).closedWithdrawal,undefined);
 await f.journal.reconcile(record.id,evidenceFor(record));await assert.rejects(f.journal.releaseAfterDeletion(record.id,deletionFor(record,{listingId:'999',url:'https://www.vinted.fr/items/999'})),{code:'PUBLICATION_DELETION_INVALID'});
});

test('never-submitted, dispatching and paid-sale publications cannot be released through deletion',async()=>{
 const f=fixture(),proof=f.proof(),record=await f.journal.prepare(proof);await assert.rejects(f.journal.releaseAfterDeletion(record.id,deletionFor(record)),{code:'PUBLICATION_DELETION_BLOCKED'});
 await f.journal.dispatchOnce(record.id,proof,async()=>{await assert.rejects(f.journal.releaseAfterDeletion(record.id,deletionFor(record)),{code:'PUBLICATION_DELETION_BLOCKED'});});
 await f.journal.reconcile(record.id,evidenceFor(record));await f.journal.releaseAfterSale(record.id,saleFor(record));await assert.rejects(f.journal.releaseAfterDeletion(record.id,deletionFor(record)),{code:'PUBLICATION_DELETION_BLOCKED'});
});

test('deletion persistence failure preserves the original uncertain record and disables later journal writes',async()=>{
 const {f,record}=await sent(),before=f.journal.state();f.failWrites();await assert.rejects(f.journal.releaseAfterDeletion(record.id,deletionFor(record)),{code:'PUBLICATION_STORAGE_FAILED'});assert.deepEqual(f.journal.state(),before);assert.equal(f.journal.faulted,true);
});

test('restored withdrawals reject forged sale coexistence, changed identities and duplicate review identifiers',async()=>{
 const {f,record}=await sent();await f.journal.reconcile(record.id,evidenceFor(record));await f.journal.releaseAfterDeletion(record.id,deletionFor(record));
 for(const change of [row=>row.closedSale=saleFor(record),row=>row.closedWithdrawal.memberId='999',row=>row.closedWithdrawal.confirmed=false,row=>row.closedWithdrawal.confirmedAt=iso(START-1),row=>row.closedWithdrawal.verified=true,row=>row.closedWithdrawal.url='https://www.vinted.fr/items/999']){const state=f.disk;change(state.submissions[0]);assert.throws(()=>restorePublicationState(state,{now:START}),undefined,String(change));}
 const proof=relistingProof(1),replacement=await f.journal.prepare(proof);await f.journal.dispatchOnce(replacement.id,proof,async()=>{});
 await assert.rejects(f.journal.releaseAfterDeletion(replacement.id,deletionFor(replacement,{listingId:'98766',url:'https://www.vinted.fr/items/98766'})),{code:'PUBLICATION_DELETION_CONFLICT'});
 await f.journal.releaseAfterDeletion(replacement.id,deletionFor(replacement,{reviewId:'deletion-review-2',listingId:'98766',url:'https://www.vinted.fr/items/98766'}));const state=f.disk;state.submissions[1].closedWithdrawal.reviewId='deletion-review-1';assert.throws(()=>restorePublicationState(state,{now:START}),{code:'PUBLICATION_CORRUPT'});
});

test('deletion identity must match an observed committed submission navigation when available',async()=>{
 const {f,record}=await sent(),state=f.disk;state.submissions[0].navigation=[{committed:true,listingId:'55555'}];const restored=fixture({state});
 await assert.rejects(restored.journal.releaseAfterDeletion(record.id,deletionFor(record)),{code:'PUBLICATION_DELETION_INVALID'});
 const closed=await restored.journal.releaseAfterDeletion(record.id,deletionFor(record,{listingId:'55555',url:'https://www.vinted.fr/items/55555'}));assert.equal(closed.closedWithdrawal.listingId,'55555');
});
