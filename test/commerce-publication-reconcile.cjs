'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildPublicationProof,PublicationJournal,FORM_URL}=require('../src/vinted-publication.cjs');
const {projectPublicationReconciliation:project}=require('../src/commerce-publication-reconcile.cjs');
const NOW=Date.parse('2026-10-14T12:00:00.000Z'),at=new Date(NOW).toISOString(),clone=value=>JSON.parse(JSON.stringify(value));
async function fixture(){
 const profileId='profile-1',listing={title:'Local test accessory',description:'Local fixture only.',categoryPath:['Maison','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
 const plan={id:'plan-1',profileId,productId:'product-1',sku:'TEST',enabled:true,completedCount:0,targetCount:2,activeListingId:null,status:'ready',currency:'EUR',listingPriceCents:500,listing,updatedAt:at};
 const account={profileId,memberId:'123',profileURL:'https://www.vinted.fr/member/123'},claim={id:'claim-1',setId:'set-1',profileId,productId:plan.productId,images:[{id:'image-1'}],listings:[]},documentKey='100.2';
 const input={plan,product:{id:plan.productId,sku:plan.sku,stock:1},claim,expectedAccount:account,evidence:{profileId,tabId:'tab-1',documentKey,url:FORM_URL,observedAt:at,challenge:false,account:{...account,verified:true},form:{documentKey,complete:true,invalidFields:[],unknownFields:[],fields:Object.entries({...listing,priceCents:500}).map(([field,value])=>({field,value,verified:true}))},photos:{documentKey,profileId,productId:plan.productId,claimId:claim.id,setId:claim.setId,count:1,signature:'a'.repeat(64),verified:true,busy:false,errorCount:0},publication:{documentKey,count:1,observed:true,label:'Ajouter',enabled:true}}};
 const journal=new PublicationJournal({persist:()=>{},now:()=>NOW,dispatchEnabled:true}),proof=buildPublicationProof(input,{now:NOW}),record=await journal.prepare(proof);await journal.dispatchOnce(record.id,proof,async()=>{});
 const job={id:'job-1',type:'listing',dedupeKey:'listing:plan-1:0',planId:plan.id,profileId,productId:plan.productId,payload:{cycle:0},state:'needs_review',step:'pending',operation:null,mutationPending:false,result:null,error:'Old blocker',retryAt:at,createdAt:at,updatedAt:at};
 const db={version:1,plans:[plan],claims:[claim],jobs:[job],marketAccounts:[account],publications:journal.state(),sales:[],encryptedToken:'PRIVATE-UNCHANGED'};
 const evidence={verified:true,mappingVerified:true,publicationStatus:'published',observedAt:at,profileId,account:{...account,verified:true},seller:{...account,verified:true},ownedByCurrentAccount:true,listingId:'98765',url:'https://www.vinted.fr/items/98765',origin:{kind:'observed_submission_navigation',submissionId:record.id,formDocumentKey:documentKey},priceKind:'item',priceCents:500,currency:'EUR',title:listing.title,photos:{verified:true,count:1,signature:'a'.repeat(64)}};
 await journal.reconcile(record.id,evidence);
 return {db,next:journal.state(),journal,record,evidence,input,run(source=db,next=journal.state()){return project(source,next,{now:NOW});}};
}

test('one staged snapshot includes publication, active listing, claim link, old job completion and an unsent supplier association',async()=>{
 const f=await fixture(),before=clone(f.db),nextBefore=clone(f.next),result=f.run(),db=result.db;
 assert.deepEqual(f.db,before);assert.deepEqual(f.next,nextBefore);assert.equal(result.changed,true);assert.equal(db.publications.submissions[0].state,'published');
 assert.equal(db.plans[0].activeListingId,'98765');assert.equal(db.plans[0].status,'listed');assert.equal(db.plans[0].completedCount,0);assert.equal(db.claims[0].listings.length,1);assert.equal(db.claims[0].listings[0].submissionId,f.record.id);
 assert.equal(db.jobs[0].state,'completed');assert.equal(db.jobs[0].step,'publication_reconciled');assert.equal(db.jobs[0].result.externalId,'98765');assert.equal(db.jobs[0].mutationPending,false);assert.equal(db.jobs[0].operation,null);
 assert.deepEqual(result.completedJobIds,['job-1']);assert.deepEqual(result.reconciledSubmissionIds,[f.record.id]);
 const sync=db.publicationSupplierSync[0];assert.equal(sync.state,'pending');assert.equal(sync.attemptCount,0);assert.equal(sync.operation,null);assert.equal(sync.receipt,null);assert.deepEqual(sync.payload,{action:'published',platform:'Vinted',listingId:'98765',listingUrl:'https://www.vinted.fr/items/98765'});
 assert.equal(db.encryptedToken,before.encryptedToken);assert.deepEqual(db.sales,[]);
});

test('reapplying an identical validated receipt is byte-for-byte idempotent',async()=>{
 const f=await fixture(),first=f.run(),again=project(first.db,first.db.publications,{now:NOW+5000});assert.equal(again.changed,false);assert.deepEqual(again.db,first.db);assert.deepEqual(again.completedJobIds,[]);assert.equal(again.db.claims[0].listings.length,1);assert.equal(again.db.publicationSupplierSync.length,1);
});

test('a paused plan stays paused in enablement and a manual publication needs no preexisting listing job',async()=>{
 const f=await fixture();f.db.plans[0].enabled=false;f.db.jobs=[];const result=f.run();assert.equal(result.db.plans[0].enabled,false);assert.equal(result.db.plans[0].status,'listed');assert.deepEqual(result.completedJobIds,[]);
});

test('an uncertain snapshot creates no active listing, claim link, job result or supplier operation',async()=>{
 const f=await fixture(),result=project(f.db,f.db.publications,{now:NOW});assert.equal(result.db.plans[0].activeListingId,null);assert.equal(result.db.claims[0].listings.length,0);assert.equal(result.db.jobs[0].result,null);assert.deepEqual(result.db.publicationSupplierSync,[]);
});

test('plan identity, cycle, price and all original fields must still agree; any conflict leaves input unchanged',async()=>{
 const changes=[db=>db.plans=[],db=>db.plans.push(clone(db.plans[0])),db=>db.plans[0].profileId='wrong',db=>db.plans[0].productId='wrong',db=>db.plans[0].sku='wrong',db=>db.plans[0].completedCount=1,db=>db.plans[0].targetCount=0,db=>db.plans[0].currency='USD',db=>db.plans[0].listingPriceCents=600,db=>db.plans[0].listing.categoryPath=['Other'],db=>db.plans[0].listing.parcel='Petit',db=>db.plans[0].activeListingId='999',db=>db.plans.push({...clone(db.plans[0]),id:'other-plan',activeListingId:'98765'})];
 for(const change of changes){const f=await fixture();change(f.db);const before=clone(f.db);assert.throws(()=>f.run(),{code:'PUBLICATION_PROJECTION_CONFLICT'},String(change));assert.deepEqual(f.db,before);}
});

test('account and claim identity, uniqueness, image count and existing link ownership fail closed',async()=>{
 const changes=[db=>db.marketAccounts=[],db=>db.marketAccounts.push(clone(db.marketAccounts[0])),db=>db.marketAccounts[0].memberId='999',db=>db.marketAccounts[0].profileURL='https://www.vinted.fr/member/999',db=>db.claims=[],db=>db.claims.push(clone(db.claims[0])),db=>db.claims[0].profileId='wrong',db=>db.claims[0].productId='wrong',db=>db.claims[0].setId='wrong',db=>db.claims[0].images=[],db=>db.claims[0].listings=null,db=>db.claims[0].listings.push({listingId:'98765',url:'https://other.test/items/98765'}),db=>db.claims[0].listings.push({listingId:'98765',url:'https://www.vinted.fr/items/98765',cycle:2}),db=>db.claims.push({...clone(db.claims[0]),id:'other-claim',listings:[{listingId:'98765',url:'https://www.vinted.fr/items/98765'}]})];
 for(const change of changes){const f=await fixture();change(f.db);assert.throws(()=>f.run(),{code:'PUBLICATION_PROJECTION_CONFLICT'},String(change));}
});

test('an existing same claim link is enriched once without duplication; conflicting metadata is never overwritten',async()=>{
 const f=await fixture();f.db.claims[0].listings.push({listingId:'98765',url:'https://www.vinted.fr/items/98765-local',createdAt:at});const result=f.run();assert.equal(result.db.claims[0].listings.length,1);assert.equal(result.db.claims[0].listings[0].submissionId,f.record.id);assert.equal(result.db.claims[0].listings[0].url,'https://www.vinted.fr/items/98765-local');
 for(const value of [{submissionId:'other'},{planId:'other'},{cycle:1}]){const g=await fixture();g.db.claims[0].listings.push({listingId:'98765',url:'https://www.vinted.fr/items/98765',...value});assert.throws(()=>g.run(),{code:'PUBLICATION_PROJECTION_CONFLICT'});}
});

test('only the original cycle unsubmitted listing job can complete; unrelated jobs remain untouched',async()=>{
 const f=await fixture(),others=[{...clone(f.db.jobs[0]),id:'older-job',dedupeKey:'listing:plan-1:9',payload:{cycle:9},operation:{kind:'unknown'},mutationPending:true,state:'uncertain'},{...clone(f.db.jobs[0]),id:'offer-job',type:'offer',dedupeKey:'offer:1'},{...clone(f.db.jobs[0]),id:'other-plan-job',planId:'other-plan',dedupeKey:'listing:other-plan:0'}];f.db.jobs.push(...others);const result=f.run();assert.deepEqual(result.db.jobs.slice(1),others);
 const changes=[job=>job.profileId='wrong',job=>job.productId='wrong',job=>job.dedupeKey='wrong',job=>job.payload.claimId='wrong',job=>job.accountMemberId='999',job=>job.operation={kind:'claim'},job=>job.mutationPending=true,job=>job.result={externalId:'other'},job=>job.state='running',job=>job.state='uncertain',job=>job.state='completed'];
 for(const change of changes){const g=await fixture();change(g.db.jobs[0]);assert.throws(()=>g.run(),{code:'PUBLICATION_PROJECTION_CONFLICT'},String(change));}
 const g=await fixture();g.db.jobs.push({...clone(g.db.jobs[0]),id:'duplicate'});assert.throws(()=>g.run(),{code:'PUBLICATION_PROJECTION_CONFLICT'});
});

test('reuse of a claim with older unmapped history is explicitly pending review, never assumed supplier-synced',async()=>{
 const f=await fixture();f.db.claims[0].listings.push({listingId:'12345',url:'https://www.vinted.fr/items/12345',createdAt:at});const result=f.run();assert.equal(result.db.claims[0].listings.length,2);const sync=result.db.publicationSupplierSync[0];assert.equal(sync.state,'needs_review');assert.equal(sync.submissionId,null);assert.equal(sync.payload.listingId,'12345');assert.equal(sync.receipt,null);assert.equal(sync.attemptCount,0);assert.equal(result.pendingSupplierSyncIds.length,1);
});

test('existing supplier association cannot silently change identity, payload or become a fabricated completed request',async()=>{
 const changes=[row=>row.id='other',row=>row.submissionId='other',row=>row.claimId='other',row=>row.profileId='other',row=>row.productId='other',row=>row.payload.listingId='999',row=>row.state='synced',row=>row.attemptCount=1,row=>row.receipt={ok:true},row=>row.operation={idempotencyKey:'old'}];
 for(const change of changes){const f=await fixture(),db=f.run().db;change(db.publicationSupplierSync[0]);assert.throws(()=>project(db,db.publications,{now:NOW}),{code:'PUBLICATION_PROJECTION_CONFLICT'},String(change));}
 const f=await fixture(),db=f.run().db;db.publicationSupplierSync.push(clone(db.publicationSupplierSync[0]));assert.throws(()=>project(db,db.publications,{now:NOW}),{code:'PUBLICATION_PROJECTION_CONFLICT'});
});

test('projection cannot create a published record without its original durable attempted submission or delete history',async()=>{
 const f=await fixture();f.db.publications.submissions=[];assert.throws(()=>f.run(),{code:'PUBLICATION_PROJECTION_CONFLICT'});
 const g=await fixture(),next=clone(g.next);next.submissions=[];assert.throws(()=>g.run(g.db,next),{code:'PUBLICATION_PROJECTION_CONFLICT'});
 const h=await fixture(),db=h.run().db,changed=clone(db.publications);changed.submissions[0].receipt.listingId='999';changed.submissions[0].receipt.url='https://www.vinted.fr/items/999';assert.throws(()=>project(db,changed,{now:NOW}),{code:'PUBLICATION_PROJECTION_CONFLICT'});
});

test('sale closure cannot be committed as a partial publication-only transaction or reactivate an already closed listing',async()=>{
 const f=await fixture(),db=f.run().db;await f.journal.releaseAfterSale(f.record.id,{verified:true,profileId:'profile-1',memberId:'123',listingId:'98765',orderId:'order-1',paid:true,cancelled:false,quantity:1,priceCents:500,currency:'EUR',observedAt:at});
 assert.throws(()=>project(db,f.journal.state(),{now:NOW}),{code:'PUBLICATION_SALE_PROJECTION_REQUIRED'});
 db.publications=f.journal.state();db.plans[0].completedCount=1;db.plans[0].activeListingId=null;db.plans[0].status='fulfilling';const result=project(db,db.publications,{now:NOW});assert.equal(result.db.plans[0].activeListingId,null);assert.equal(result.db.plans[0].status,'fulfilling');assert.equal(result.db.plans[0].completedCount,1);
});

test('only the current original profile lease permits a running listing job to receive its publication result',async()=>{
 const f=await fixture();f.db.jobs[0].state='running';
 for(const activeLeases of [[],[{profileId:'other-profile',jobId:'job-1'}],[{profileId:'profile-1',jobId:'other-job'}]])assert.throws(()=>project(f.db,f.next,{now:NOW,activeLeases}),{code:'PUBLICATION_PROJECTION_CONFLICT'});
 const result=project(f.db,f.next,{now:NOW,activeLeases:[{profileId:'profile-1',jobId:'job-1'}]});assert.equal(result.db.jobs[0].state,'completed');assert.equal(result.db.jobs[0].result.externalId,'98765');assert.equal(f.db.jobs[0].state,'running');
});

test('a verified supplier read receipt survives later publication projections without inventing another write',async()=>{
 const f=await fixture(),db=f.run().db,row=db.publicationSupplierSync[0];row.state='synced';row.receipt={claimId:row.claimId,setId:'set-1',productId:row.productId,platform:'Vinted',listingId:row.payload.listingId,listingUrl:row.payload.listingUrl,observedAt:at,source:'claim_detail'};
 const result=project(db,db.publications,{now:NOW});assert.deepEqual(result.db.publicationSupplierSync[0],row);assert.deepEqual(result.pendingSupplierSyncIds,[]);
 row.receipt.setId='wrong-set';assert.throws(()=>project(db,db.publications,{now:NOW}),{code:'PUBLICATION_PROJECTION_CONFLICT'});
});

async function reusedPhotoFixture(){
 const f=await fixture();let db=f.run().db;const first=db.publicationSupplierSync[0];first.state='synced';first.receipt={claimId:first.claimId,setId:'set-1',productId:first.productId,platform:'Vinted',listingId:first.payload.listingId,listingUrl:first.payload.listingUrl,observedAt:at,source:'claim_detail'};
 await f.journal.releaseAfterSale(f.record.id,{verified:true,profileId:'profile-1',memberId:'123',listingId:'98765',orderId:'order-1',paid:true,cancelled:false,quantity:1,priceCents:500,currency:'EUR',observedAt:at});
 db.publications=f.journal.state();Object.assign(db.plans[0],{completedCount:1,activeListingId:null,status:'ready'});
 const input=clone(f.input);input.plan=clone(db.plans[0]);input.claim=clone(db.claims[0]);input.evidence.documentKey='100.3';for(const key of ['form','photos','publication'])input.evidence[key].documentKey='100.3';
 const proof=buildPublicationProof(input,{now:NOW}),record=await f.journal.prepare(proof);await f.journal.dispatchOnce(record.id,proof,async()=>{});db.publications=f.journal.state();
 const receipt={...clone(f.evidence),listingId:'98766',url:'https://www.vinted.fr/items/98766',origin:{kind:'observed_submission_navigation',submissionId:record.id,formDocumentKey:'100.3'}};await f.journal.reconcile(record.id,receipt);db=project(db,f.journal.state(),{now:NOW}).db;
 const payload={action:'published',platform:'Vinted',listingId:'98766',listingUrl:receipt.url},id='mark-listed-'+require('node:crypto').createHash('sha256').update(JSON.stringify(['claim-1','98766'])).digest('hex');
 const later={id,kind:'mark_listed',claimId:'claim-1',profileId:'profile-1',productId:'product-1',submissionId:record.id,state:'pending',attemptCount:0,operation:null,receipt:null,payload,createdAt:at,updatedAt:at,reason:'旧版保存的后续周期关联'};
 return {db,first:clone(first),later};
}

test('photo reuse keeps the first supplier binding and preserves a later pending history row unchanged',async()=>{
 const f=await reusedPhotoFixture();assert.equal(f.db.publicationSupplierSync.length,1,'A later sales cycle must not create another supplier association');assert.deepEqual(f.db.publicationSupplierSync[0],f.first);
 f.db.publicationSupplierSync.unshift(f.later);const before=clone(f.db),result=project(f.db,f.db.publications,{now:NOW+1000});
 assert.equal(result.changed,false);assert.deepEqual(result.db,before);assert.deepEqual(result.db.publicationSupplierSync[1],f.first);assert.deepEqual(result.pendingSupplierSyncIds,[f.later.id]);assert.equal(result.db.plans[0].activeListingId,'98766');assert.equal(result.db.claims[0].listings.length,2);
});

test('additional same-claim history must retain its own original publication, request and receipt identity',async()=>{
 const changes=[row=>row.profileId='other-profile',row=>row.productId='other-product',row=>row.submissionId='other-submission',row=>row.payload.listingUrl+='-changed',row=>row.state='synced',row=>row.operation={idempotencyKey:'invented'}];
 for(const change of changes){const f=await reusedPhotoFixture();change(f.later);f.db.publicationSupplierSync.push(f.later);const before=clone(f.db);assert.throws(()=>project(f.db,f.db.publications,{now:NOW}),{code:'PUBLICATION_PROJECTION_CONFLICT'},String(change));assert.deepEqual(f.db,before);}
 const f=await reusedPhotoFixture();Object.assign(f.db.publicationSupplierSync[0],{state:'pending',receipt:null});f.db.publicationSupplierSync.push(f.later);assert.throws(()=>project(f.db,f.db.publications,{now:NOW}),{code:'PUBLICATION_PROJECTION_CONFLICT'});
});

test('missing first supplier history is restored only for review when a later association already exists',async()=>{
 const f=await reusedPhotoFixture();f.db.publicationSupplierSync=[f.later];const result=project(f.db,f.db.publications,{now:NOW});
 assert.equal(result.db.publicationSupplierSync.length,2);assert.deepEqual(result.db.publicationSupplierSync[0],f.later);const first=result.db.publicationSupplierSync.find(row=>row.id===f.first.id);assert.equal(first.state,'needs_review');assert.equal(first.attemptCount,0);assert.equal(first.operation,null);assert.equal(first.receipt,null);assert.deepEqual(first.payload,f.first.payload);
});

function deletionEvidence(f){return {kind:'operator_confirmed_deletion',confirmed:true,reason:'deleted_not_sold',reviewId:'deletion-review-1',profileId:'profile-1',memberId:'123',listingId:'98765',url:'https://www.vinted.fr/items/98765',confirmedAt:at};}
async function withdrawnFixture(){
 const f=await fixture(),db=f.run().db;await f.journal.releaseAfterDeletion(f.record.id,deletionEvidence(f));db.publications=f.journal.state();Object.assign(db.plans[0],{activeListingId:null,status:'ready',listingRevision:1});Object.assign(db.jobs[0],{state:'cancelled',step:'listing_deleted',result:{kind:'listing_deleted',externalId:'98765',submissionId:f.record.id}});db.publicationSupplierSync[0].state='cancelled';return {f,db};
}

test('a publication-only projection cannot create an operator deletion without the complete engine recovery transaction',async()=>{
 const f=await fixture(),db=f.run().db;await f.journal.releaseAfterDeletion(f.record.id,deletionEvidence(f));assert.throws(()=>project(db,f.journal.state(),{now:NOW}),{code:'PUBLICATION_DELETION_PROJECTION_REQUIRED'});
 const uncertain=clone(f.db);assert.throws(()=>project(uncertain,f.journal.state(),{now:NOW}),{code:'PUBLICATION_DELETION_PROJECTION_REQUIRED'});
});

test('withdrawn publication projection retains receipt, archived job and cancelled supplier history without reoccupying the plan',async()=>{
 const {db}=await withdrawnFixture(),before=clone(db),result=project(db,db.publications,{now:NOW+1000});assert.equal(result.changed,false);assert.deepEqual(result.db,before);assert.equal(result.db.plans[0].activeListingId,null);assert.equal(result.db.plans[0].completedCount,0);assert.equal(result.db.jobs[0].state,'cancelled');assert.equal(result.db.publications.submissions[0].state,'published');assert.equal(result.db.claims[0].listings.length,1);assert.equal(result.db.publicationSupplierSync[0].state,'cancelled');
});

test('every field of an already withdrawn submission is immutable under future projections',async()=>{
 const {db}=await withdrawnFixture();
 for(const change of [row=>delete row.closedWithdrawal,row=>row.closedWithdrawal.reviewId='changed',row=>row.reason='rewritten',row=>row.updatedAt=new Date(NOW+1000).toISOString(),row=>row.receipt.observedAt=new Date(NOW+1000).toISOString(),row=>row.navigation=[]]){const next=clone(db.publications);change(next.submissions[0]);assert.throws(()=>project(db,next,{now:NOW+1000}),{code:'PUBLICATION_PROJECTION_CONFLICT'},String(change));}
});

test('same sales cycle relisting completes only its new revision job and keeps previous published receipt and photo association history',async()=>{
 const {f,db}=await withdrawnFixture(),input=clone(f.input);input.plan=clone(db.plans[0]);input.claim=clone(db.claims[0]);input.evidence.documentKey='100.3';for(const key of ['form','photos','publication'])input.evidence[key].documentKey='100.3';
 const proof=buildPublicationProof(input,{now:NOW}),record=await f.journal.prepare(proof);await f.journal.dispatchOnce(record.id,proof,async()=>{});db.publications=f.journal.state();
 const oldJob=clone(db.jobs[0]),newJob={...clone(oldJob),id:'relist-job',dedupeKey:'listing:plan-1:0:r1',payload:{cycle:0,listingRevision:1},state:'queued',step:'pending',result:null};db.jobs.push(newJob);
 const receipt={...clone(f.evidence),listingId:'98766',url:'https://www.vinted.fr/items/98766',origin:{kind:'observed_submission_navigation',submissionId:record.id,formDocumentKey:'100.3'}};await f.journal.reconcile(record.id,receipt);
 const result=project(db,f.journal.state(),{now:NOW});assert.deepEqual(result.db.jobs[0],oldJob);assert.equal(result.db.jobs[1].state,'completed');assert.equal(result.db.jobs[1].result.externalId,'98766');assert.deepEqual(result.completedJobIds,['relist-job']);assert.equal(result.db.plans[0].activeListingId,'98766');assert.equal(result.db.plans[0].completedCount,0);assert.equal(result.db.claims[0].listings[1].listingRevision,1);assert.equal(result.db.publicationSupplierSync.length,2);assert.equal(result.db.publicationSupplierSync[0].state,'cancelled');assert.equal(result.db.publicationSupplierSync[1].state,'pending');assert.equal(result.db.publicationSupplierSync[1].payload.listingId,'98766');assert.equal(result.db.publicationSupplierSync[1].attemptCount,0);assert.equal(result.db.publicationSupplierSync[1].operation,null);assert.equal(result.db.publicationSupplierSync[1].submissionId,record.id);assert.equal(project(result.db,result.db.publications,{now:NOW+1000}).changed,false);
 const wrong=clone(db);wrong.plans[0].listingRevision=0;assert.throws(()=>project(wrong,f.journal.state(),{now:NOW}),{code:'PUBLICATION_PROJECTION_CONFLICT'});
});

async function replacementPublication(){
 const {f,db}=await withdrawnFixture(),input=clone(f.input);input.plan=clone(db.plans[0]);input.claim=clone(db.claims[0]);input.evidence.documentKey='replacement-document';for(const key of ['form','photos','publication'])input.evidence[key].documentKey='replacement-document';
 const proof=buildPublicationProof(input,{now:NOW}),record=await f.journal.prepare(proof);await f.journal.dispatchOnce(record.id,proof,async()=>{});db.publications=f.journal.state();await f.journal.reconcile(record.id,{...clone(f.evidence),listingId:'98766',url:'https://www.vinted.fr/items/98766',origin:{kind:'observed_submission_navigation',submissionId:record.id,formDocumentKey:'replacement-document'}});return {f,db,next:f.journal.state()};
}

test('replacement photo association never supersedes an already sent, uncertain or synced original request',async()=>{
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 for(const status of ['synced','uncertain','needs_review']){
  const {db,next}=await replacementPublication(),row=db.publicationSupplierSync[0];row.state=status;
  if(status==='synced')row.receipt={claimId:row.claimId,setId:'set-1',productId:row.productId,platform:'Vinted',listingId:row.payload.listingId,listingUrl:row.payload.listingUrl,observedAt:at,source:'claim_detail'};
  else {const request={baseURL:'https://supplier.test/api/v1',supplierAccountId:'supplier-1',claimId:row.claimId,payload:clone(row.payload)};row.attemptCount=1;row.operation={kind:'mark_listed',idempotencyKey:'isola-'+row.id,request,fingerprint:require('node:crypto').createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex')};}
  const saved=clone(row),result=project(db,next,{now:NOW});assert.deepEqual(result.db.publicationSupplierSync,[saved],status);assert.equal(result.db.claims[0].listings.length,2);assert.equal(result.db.plans[0].activeListingId,'98766');
 }
});

test('missing earlier association history never authorizes a replacement supplier request',async()=>{
 const {db,next}=await replacementPublication();db.publicationSupplierSync=[];const result=project(db,next,{now:NOW});assert.equal(result.db.publicationSupplierSync.length,1);const row=result.db.publicationSupplierSync[0];assert.equal(row.payload.listingId,'98765');assert.equal(row.state,'needs_review');assert.equal(row.attemptCount,0);assert.equal(row.operation,null);assert.equal(result.db.claims[0].listings.length,2);
});
