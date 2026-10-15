'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildPublicationProof,PublicationJournal,FORM_URL,validatePublicationReceipt,restorePublicationState}=require('../src/vinted-publication.cjs');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const {createAssociationService}=require('../src/commerce-association-service.cjs');
const {createEnvironmentSessionAuthority}=require('../src/commerce-session-authority.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
async function fixture(t,{session=false}={}){
 let clock=Date.now();const at=new Date(clock).toISOString(),profileId='profile-1',documentKey='form-1';
 const listing={title:'Local test accessory',description:'Fixture only.',categoryPath:['Maison','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
 const plan={id:'plan-1',profileId,productId:'product-1',sku:'TEST',enabled:true,completedCount:0,targetCount:2,activeListingId:null,status:'ready',currency:'EUR',listingPriceCents:500,listing};
 const account={profileId,memberId:'123',profileURL:'https://www.vinted.fr/member/123',username:'fixture',platform:'vinted-fr',verifiedAt:at};
 const expectedAccount=session?createEnvironmentSessionAuthority(profileId):account;
 const claim={id:'claim-1',setId:'set-1',profileId,productId:plan.productId,images:[{id:'image-1'}],listings:[]};
 const proof=buildPublicationProof({plan,product:{id:plan.productId,sku:plan.sku,stock:1},claim,expectedAccount,evidence:{profileId,tabId:'form-tab',documentKey,url:FORM_URL,observedAt:at,challenge:false,account:session?clone(expectedAccount):{...account,verified:true},form:{documentKey,complete:true,invalidFields:[],unknownFields:[],fields:Object.entries({...listing,priceCents:500}).map(([field,value])=>({field,value,verified:true}))},photos:{documentKey,profileId,productId:plan.productId,claimId:claim.id,setId:claim.setId,count:1,signature:'a'.repeat(64),verified:true,busy:false,errorCount:0},publication:{documentKey,count:1,observed:true,label:'Ajouter',enabled:true}}});
 const journal=new PublicationJournal({persist:()=>{},dispatchEnabled:true,now:()=>clock}),record=await journal.prepare(proof);await journal.dispatchOnce(record.id,proof,async()=>{});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-association-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const engine=new CommerceEngine({dir,profiles:()=>[{id:profileId}],adapter:{readiness:()=>({vinted:'unverified'})},seal:x=>x,unseal:x=>x});
 Object.assign(engine.db,{plans:[plan],claims:[claim],marketAccounts:session?[]:[account],publications:journal.state()});engine.persist();
 const evidence={verified:true,mappingVerified:true,publicationStatus:'published',observedAt:at,profileId,...(session?{account:clone(expectedAccount)}:{account:{...account,verified:true},seller:{...account,verified:true}}),ownedByCurrentAccount:true,listingId:'98765',url:'https://www.vinted.fr/items/98765',priceKind:'item',priceCents:500,currency:'EUR',title:listing.title,photos:{verified:true,count:1,signature:'a'.repeat(64)}};
 const fresh={summary:{verified:true,photoSignatureMatched:true,listingId:'98765',url:evidence.url,checks:[],blockers:[]},evidence,binding:{documentKey:'detail-1',tabId:session?'form-tab':'detail-tab'}};
 let reads=0,hook=()=>{},pageGuard=()=>{};const inputs=[];
 const service=createAssociationService({now:()=>clock,readerFactory:()=>({collect:async(input,options)=>{assert.equal(options.reviewOriginalSubmission,true);inputs.push(clone(input));reads++;await hook(reads);const result=clone(fresh);result.evidence.observedAt=new Date(clock).toISOString();return options.withEvidence?options.withEvidence(result,()=>pageGuard()):result;}})});
 return {engine,service,fresh,record,evidence,inputs,reads:()=>reads,tick:ms=>clock+=ms,hook:fn=>hook=fn,pageGuard:fn=>pageGuard=fn,inspect:()=>service.inspect(engine,plan.id),associate:token=>service.associate(engine,plan.id,token)};
}
test('review association durably saves provenance, listing, photo history and unsent outbox in one write',async t=>{
 const f=await fixture(t),report=await f.inspect();assert.equal(report.readyForAssociation,true);let writes=0;const persist=f.engine.persist.bind(f.engine);f.engine.persist=()=>{writes++;persist();};
 const result=await f.associate(report.reviewToken);assert.equal(result.associated,true);assert.equal(f.reads(),2);assert.equal(writes,1);
 const db=JSON.parse(fs.readFileSync(f.engine.file));assert.equal(db.plans[0].activeListingId,'98765');assert.equal(db.claims[0].listings.length,1);assert.equal(db.publicationSupplierSync[0].attemptCount,0);assert.equal(db.publicationSupplierSync[0].state,'pending');
 const saved=db.publications.submissions[0];assert.equal(saved.attemptCount,1);assert.equal(saved.receipt.origin.kind,'operator_reviewed_listing');assert.equal(saved.receipt.origin.listingDocumentKey,'detail-1');assert.equal(restorePublicationState(db.publications).state.submissions[0].state,'published');await assert.rejects(f.associate(report.reviewToken));
});
test('forged, wrong-plan, expired and replayed capabilities cannot associate',async t=>{
 for(const mode of ['forged','expired','wrong-plan']){const f=await fixture(t),report=await f.inspect();if(mode==='expired')f.tick(120001);if(mode==='wrong-plan')await assert.rejects(f.service.associate(f.engine,'other-plan',report.reviewToken));else await assert.rejects(f.associate(mode==='forged'?'forged':report.reviewToken));await assert.rejects(f.associate(report.reviewToken));assert.equal(f.engine.db.publications.submissions[0].state,'uncertain');}
});
test('changed plan, account, submission or detail document blocks confirmation without writing',async t=>{
 for(const change of [f=>f.engine.db.plans[0].listingPriceCents=600,f=>f.engine.db.marketAccounts[0].memberId='456',f=>f.engine.db.publications.submissions[0].reason='changed',f=>f.fresh.binding.documentKey='detail-2',f=>f.fresh.binding.tabId='other-tab',f=>f.fresh.evidence.listingId='999',f=>f.fresh.evidence.photos.signature='b'.repeat(64),f=>f.fresh.summary.verified=false]){
  const f=await fixture(t),report=await f.inspect(),before=fs.readFileSync(f.engine.file,'utf8');change(f);await assert.rejects(f.associate(report.reviewToken));assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(f.engine.db.publications.submissions[0].state,'uncertain');
 }
});
test('navigation or cancellation at the journal boundary prevents all writes',async t=>{
 const f=await fixture(t),report=await f.inspect(),before=fs.readFileSync(f.engine.file,'utf8');let calls=0;f.pageGuard(()=>{if(++calls===2)throw Error('page navigated');});await assert.rejects(f.associate(report.reviewToken));assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);
});
test('failed storage faults the engine and exposes no partial in-memory association',async t=>{
 const f=await fixture(t),report=await f.inspect();f.engine.persist=()=>{throw Error('disk full');};await assert.rejects(f.associate(report.reviewToken));assert.equal(f.engine.faulted,true);assert.equal(f.engine.db.plans[0].activeListingId,null);assert.equal(f.engine.db.publications.submissions[0].state,'uncertain');assert.equal(f.engine.db.claims[0].listings.length,0);
});
test('photo mismatch issues no capability and renderer-fabricated provenance is rejected',async t=>{
 const f=await fixture(t);f.fresh.summary.photoSignatureMatched=false;assert.equal((await f.inspect()).reviewToken,undefined);
 assert.throws(()=>validatePublicationReceipt(f.engine.db.publications.submissions[0],{...f.evidence,origin:{kind:'operator_reviewed_listing',submissionId:f.record.id,formDocumentKey:'form-1'}}),{code:'PUBLICATION_RECEIPT_UNATTRIBUTED'});
});

test('session listing recovery reuses its original environment authority without any saved member identity',async t=>{
 const f=await fixture(t,{session:true});f.fresh.binding.tabId='reopened-after-restart';const report=await f.inspect();assert.equal(report.readyForAssociation,true);
 assert.equal((await f.associate(report.reviewToken)).associated,true);assert.equal(f.reads(),2);
 for(const input of f.inputs)assert.deepEqual(input.expectedAccount,{kind:'environment-session',profileId:'profile-1'});
 assert.deepEqual(f.engine.db.marketAccounts,[]);
 const saved=f.engine.db.publications.submissions[0];assert.equal(saved.state,'published');assert.equal(saved.attemptCount,1);
 assert.deepEqual(saved.receipt.account,{kind:'environment-session',profileId:'profile-1'});assert.equal(saved.receipt.memberId,undefined);
 assert.equal(saved.receipt.origin.kind,'operator_reviewed_listing');assert.equal(saved.receipt.origin.tabId,'reopened-after-restart');
 assert.equal(restorePublicationState(f.engine.db.publications).state.submissions[0].state,'published');
});

test('session recovery still invalidates changed authority, original records and item evidence',async t=>{
 for(const change of [f=>f.engine.db.publications.submissions[0].proof.facts.account.profileId='other-profile',f=>f.engine.db.publications.submissions[0].proof.facts.account.memberId='123',f=>f.engine.db.plans[0].productId='other-product',f=>f.fresh.binding.documentKey='other-document',f=>f.fresh.evidence.photos.signature='b'.repeat(64)]){
  const f=await fixture(t,{session:true}),report=await f.inspect(),before=fs.readFileSync(f.engine.file,'utf8');change(f);await assert.rejects(f.associate(report.reviewToken));assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(f.engine.db.publications.submissions[0].state,'uncertain');
 }
});
