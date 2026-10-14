'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {createSupplierOutbox,validateSupplierSyncRecord,restoreSupplierSync,inspectSupplierClaim}=require('../src/commerce-supplier-outbox.cjs');
const NOW=Date.parse('2026-10-14T12:00:00.000Z'),at=new Date(NOW).toISOString(),clone=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(){
 const payload={action:'published',platform:'Vinted',listingId:'98765',listingUrl:'https://www.vinted.fr/items/98765'},id='mark-listed-'+createHash('sha256').update(JSON.stringify(['claim-1','98765'])).digest('hex');
 const row={id,kind:'mark_listed',claimId:'claim-1',profileId:'profile-1',productId:'product-1',submissionId:'submission-1',state:'pending',attemptCount:0,operation:null,receipt:null,payload,createdAt:at,updatedAt:at,reason:'平台已核对'};
 const account={profileId:'profile-1',memberId:'123',profileURL:'https://www.vinted.fr/member/123'};
 const db={settings:{baseURL:'https://supplier.test/api/v1'},supplierAccountId:'supplier-1',publicationSupplierSync:[row],claims:[{id:'claim-1',setId:'set-1',profileId:'profile-1',productId:'product-1',supplierAccountId:'supplier-1',listings:[{listingId:'98765',url:payload.listingUrl}]}],plans:[{id:'plan-1',profileId:'profile-1',productId:'product-1',sku:'TEST',enabled:true,completedCount:0}],marketAccounts:[account],publications:{version:1,submissions:[{id:'submission-1',state:'published',attemptCount:1,receipt:{listingId:'98765',url:payload.listingUrl},proof:{facts:{planId:'plan-1',profileId:'profile-1',productId:'product-1',sku:'TEST',photos:{claimId:'claim-1',setId:'set-1'},account}}}]},jobs:[],sales:[],privateValue:'unchanged'};
 const calls=[],snapshots=[];let remote={claimId:'claim-1',set:{id:'set-1',product_id:'product-1',claim:{id:'claim-1',platform:null,listing_id:null,listing_url:null}}};
 const client={async me(){calls.push('me');return {user:{id:'supplier-1'}};},async claim(id){calls.push(['claim',id]);return clone(remote);},async markListed(claimId,payload,options){calls.push(['mark',claimId,clone(payload),options.idempotencyKey]);assert.equal(snapshots.at(-1).publicationSupplierSync[0].state,'dispatching');assert.equal(snapshots.at(-1).publicationSupplierSync[0].attemptCount,1);remote.set.claim={id:claimId,platform:payload.platform,listing_id:payload.listingId,listing_url:payload.listingUrl};return {ok:true};}};
 const engine={db,faulted:false,running:true,closing:false,profiles:()=>[{id:'profile-1'}],client:()=>client,persist(){snapshots.push(clone(this.db));},emit(){},accountIdentity(data){return data.user?.id;},storageFaulted(){return this.faulted;}};
 const worker=createSupplierOutbox({now:()=>NOW});
 return {engine,client,worker,calls,snapshots,id,row,get remote(){return remote;},set remote(value){remote=value;},run(options={}){return worker.run(engine,id,options);},get saved(){return snapshots.at(-1);},marks(){return calls.filter(call=>Array.isArray(call)&&call[0]==='mark');}};
}

test('persists a fixed request before one mark and confirms only by an exact GET claim receipt',async()=>{
 const f=fixture(),originalPublications=f.engine.db.publications,originalPlans=clone(f.engine.db.plans),result=await f.run({allowDispatch:true});
 assert.equal(result.state,'synced');assert.equal(result.attemptCount,1);assert.equal(f.marks().length,1);assert.equal(f.marks()[0][3],'isola-'+f.id);
 assert.equal(f.saved.publicationSupplierSync[0].receipt.source,'claim_detail');assert.equal(f.engine.db.publications,originalPublications);assert.deepEqual(f.engine.db.plans,originalPlans);assert.deepEqual(f.engine.db.jobs,[]);assert.deepEqual(f.engine.db.sales,[]);assert.equal(f.engine.db.privateValue,'unchanged');
});

test('default mode is read-only and a preexisting exact association sends no POST',async()=>{
 const f=fixture();assert.equal((await f.run()).state,'pending');assert.equal(f.marks().length,0);assert.equal(f.snapshots.length,0);
 f.remote.set.claim={id:'claim-1',platform:'Vinted',listingId:'98765',listingUrl:f.row.payload.listingUrl};
 const result=await f.run();assert.equal(result.state,'synced');assert.equal(result.attemptCount,0);assert.equal(f.marks().length,0);validateSupplierSyncRecord(f.engine.db.publicationSupplierSync[0]);
});

test('a POST ok=true without the original listing in GET never marks supplier sync complete',async()=>{
 const f=fixture();f.client.markListed=async()=>{f.calls.push(['mark']);return {ok:true,verified:true,listingId:'98765'};};
 assert.equal((await f.run({allowDispatch:true})).state,'needs_review');assert.equal(f.marks().length,1);assert.equal(f.saved.publicationSupplierSync[0].receipt,null);
 await f.run({allowDispatch:true});assert.equal(f.marks().length,1);
});

test('lost POST reply reconciles the committed remote association without resending',async()=>{
 const f=fixture(),send=f.client.markListed;f.client.markListed=async(...args)=>{await send(...args);throw Object.assign(Error('network timeout'),{ambiguous:true});};
 assert.equal((await f.run({allowDispatch:true})).state,'synced');assert.equal(f.marks().length,1);
 f.engine.db=clone(f.saved);await createSupplierOutbox({now:()=>NOW+1000}).run(f.engine,f.id,{allowDispatch:true});assert.equal(f.marks().length,1);
});

test('restart with dispatching state reads the original claim and never repeats a mark',async()=>{
 const f=fixture();let attempted;f.client.markListed=async()=>{attempted=clone(f.saved);throw Error('connection closed');};await f.run({allowDispatch:true});
 assert.equal(attempted.publicationSupplierSync[0].state,'dispatching');f.engine.db=attempted;f.calls.length=0;
 const recovered=restoreSupplierSync(f.engine.db.publicationSupplierSync,{now:NOW+1000});assert.equal(recovered[0].state,'uncertain');assert.equal(f.engine.db.publicationSupplierSync[0].state,'dispatching');
 assert.equal((await createSupplierOutbox({now:()=>NOW+1000}).run(f.engine,f.id,{allowDispatch:true})).state,'needs_review');assert.equal(f.marks().length,0);
});

test('persistence failure before dispatch stops every later external operation',async()=>{
 const f=fixture();f.engine.persist=()=>{throw Error('disk full');};await assert.rejects(f.run({allowDispatch:true}),/disk full/);
 assert.equal(f.marks().length,0);assert.equal(f.engine.faulted,true);assert.equal(f.engine.running,false);await assert.rejects(f.run({allowDispatch:true}),{code:'SUPPLIER_OUTBOX_STOPPED'});
});

test('receipt persistence failure keeps the durable dispatch intent so recovery cannot resend',async()=>{
 const f=fixture(),persist=f.engine.persist;let count=0;f.engine.persist=function(){if(++count===3)throw Error('disk full');persist.call(this);};
 await assert.rejects(f.run({allowDispatch:true}),/disk full/);assert.equal(f.marks().length,1);assert.equal(f.saved.publicationSupplierSync[0].state,'uncertain');
 f.engine.db=clone(f.saved);f.engine.faulted=false;f.engine.persist=persist;assert.equal((await f.run({allowDispatch:true})).state,'synced');assert.equal(f.marks().length,1);
});

test('each response is checked against the live database, preserving unrelated concurrent updates',async()=>{
 const f=fixture(),claim=f.client.claim;f.client.claim=async id=>{const data=await claim(id);f.engine.db={...f.engine.db,jobs:[{id:'other-job',state:'completed'}],sales:[{id:'other-sale'}]};return data;};
 const publication=f.engine.db.publications;await f.run({allowDispatch:true});assert.equal(f.engine.db.publications,publication);assert.deepEqual(f.saved.jobs,[{id:'other-job',state:'completed'}]);assert.deepEqual(f.saved.sales,[{id:'other-sale'}]);
});

test('changed account, claim or original publication binding prevents the POST',async()=>{
 const changes=[db=>db.marketAccounts[0].memberId='999',db=>db.claims[0].setId='wrong',db=>db.plans[0].profileId='wrong',db=>db.publications.submissions[0].state='uncertain',db=>db.supplierAccountId='other',db=>db.settings.baseURL='https://elsewhere.test/api/v1'];
 for(const change of changes){const f=fixture(),claim=f.client.claim;f.client.claim=async id=>{const data=await claim(id);change(f.engine.db);return data;};await assert.rejects(f.run({allowDispatch:true}),String(change));assert.equal(f.marks().length,0);}
});

test('a different authenticated supplier account never reads or mutates the claim',async()=>{
 const f=fixture();f.client.me=async()=>({user:{id:'other'}});await assert.rejects(f.run({allowDispatch:true}),{code:'SUPPLIER_OUTBOX_ACCOUNT'});assert.equal(f.calls.length,0);
});

test('same profile is serialized across worker instances and released after completion',async()=>{
 const f=fixture(),gate=deferred(),entered=deferred(),claim=f.client.claim;f.client.claim=async id=>{entered.resolve();await gate.promise;return claim(id);};
 const running=f.run();await entered.promise;await assert.rejects(createSupplierOutbox().run(f.engine,f.id),{code:'SUPPLIER_OUTBOX_BUSY'});gate.resolve();await running;await f.run();
});

test('pause or abort while reading prevents dispatch and drops stale results',async()=>{
 for(const mode of ['pause','abort']){const f=fixture(),gate=deferred(),entered=deferred(),controller=new AbortController(),claim=f.client.claim;f.client.claim=async id=>{entered.resolve();await gate.promise;return claim(id);};
  const running=f.run({allowDispatch:true,signal:controller.signal});await entered.promise;if(mode==='pause')f.engine.db.plans[0].enabled=false;else controller.abort();gate.resolve();await assert.rejects(running,{code:'SUPPLIER_OUTBOX_STOPPED'});assert.equal(f.marks().length,0);assert.equal(f.row.attemptCount,0);
 }
});

test('cancellation before sending is durable; cancellation after intent preserves uncertainty',async()=>{
 const f=fixture();assert.equal((await f.worker.cancel(f.engine,f.id)).state,'cancelled');await f.run({allowDispatch:true});assert.equal(f.calls.length,0);
 const g=fixture(),gate=deferred(),entered=deferred();g.client.markListed=async()=>{g.calls.push(['mark']);entered.resolve();return gate.promise;};
 const running=g.run({allowDispatch:true});await entered.promise;assert.equal((await g.worker.cancel(g.engine,g.id)).state,'uncertain');gate.resolve({ok:true});await assert.rejects(running,{code:'SUPPLIER_OUTBOX_STOPPED'});
 await g.run({allowDispatch:true});assert.equal(g.marks().length,1);assert.equal(g.engine.db.publicationSupplierSync[0].attemptCount,1);
});

test('bounded reads time out without turning an unread response into permission to write',async()=>{
 const f=fixture();f.client.claim=async()=>new Promise(()=>{});const worker=createSupplierOutbox({now:()=>NOW,timeoutMs:5});
 assert.equal((await worker.run(f.engine,f.id,{allowDispatch:true})).state,'needs_review');assert.equal(f.marks().length,0);
});

test('strict claim receipts reject missing fields, type coercion, URL differences and conflicting aliases',()=>{
 const f=fixture(),expected={claimId:'claim-1',setId:'set-1',productId:'product-1',payload:f.row.payload};
 const matching={claimId:'claim-1',set:{id:'set-1',product_id:'product-1',claim:{id:'claim-1',platform:'Vinted',listing_id:'98765',listing_url:f.row.payload.listingUrl}}};
 assert.equal(inspectSupplierClaim(matching,expected,{now:NOW}).status,'matched');
 const changes=[data=>delete data.set.claim.platform,data=>delete data.set.claim.listing_id,data=>delete data.set.claim.listing_url,data=>data.set.claim.id='wrong',data=>data.claimId='wrong',data=>data.set.id='wrong',data=>data.set.product_id='wrong',data=>data.set.claim.platform='vinted',data=>data.set.claim.listing_id=98765,data=>data.set.claim.listing_url+='?x=1',data=>data.set.claim.listing_url+='/other',data=>data.set.claim.listingId='999',data=>data.set.productId='other',data=>data.claim={...data.set.claim,listing_id:'999'},data=>data.set.claim={id:'claim-1',status:'published',ok:true}];
 for(const change of changes){const data=clone(matching);change(data);assert.throws(()=>inspectSupplierClaim(data,expected,{now:NOW}),{code:'SUPPLIER_RECEIPT_UNVERIFIED'},String(change));}
 assert.throws(()=>inspectSupplierClaim({ok:true},expected),{code:'SUPPLIER_RECEIPT_UNVERIFIED'});
});

test('foreign or partial supplier association blocks dispatch instead of overwriting it',async()=>{
 for(const fields of [{platform:'Vinted',listing_id:'999',listing_url:'https://www.vinted.fr/items/999'},{platform:'Vinted',listing_id:'98765',listing_url:null},{platform:null,listing_id:null}]){
  const f=fixture();f.remote.set.claim={id:'claim-1',...fields};assert.equal((await f.run({allowDispatch:true})).state,'needs_review');assert.equal(f.marks().length,0);
 }
});

test('old unmapped claim history is read-only and can only finish with an exact remote receipt',async()=>{
 const f=fixture();f.row.submissionId=null;f.row.state='needs_review';assert.equal((await f.run({allowDispatch:true})).state,'needs_review');assert.equal(f.marks().length,0);
 f.remote.set.claim={id:'claim-1',platform:'Vinted',listing_id:'98765',listing_url:f.row.payload.listingUrl};assert.equal((await f.run({allowDispatch:true})).state,'synced');assert.equal(f.marks().length,0);
});

test('tampered durable request and duplicate queue ownership fail validation',async()=>{
 const f=fixture();await f.run({allowDispatch:true});
 const changes=[row=>row.operation.idempotencyKey='new-key',row=>row.operation.request.payload.listingId='999',row=>row.operation.fingerprint='wrong',row=>row.receipt.listingId='999',row=>row.attemptCount=2,row=>row.state='pending',row=>row.id='other'];
 for(const change of changes){const row=clone(f.engine.db.publicationSupplierSync[0]);change(row);assert.throws(()=>validateSupplierSyncRecord(row),{code:'SUPPLIER_OUTBOX_INVALID'},String(change));}
 const rows=clone(f.engine.db.publicationSupplierSync);rows.push(clone(rows[0]));assert.throws(()=>restoreSupplierSync(rows),{code:'SUPPLIER_OUTBOX_INVALID'});
});

test('photo reuse preserves a synced first reference and restores a later pending row without overwriting the supplier',async()=>{
 const f=fixture();await f.run({allowDispatch:true});const original=clone(f.engine.db.publicationSupplierSync[0]),nextPayload={...original.payload,listingId:'98766',listingUrl:'https://www.vinted.fr/items/98766'};
 const nextId='mark-listed-'+createHash('sha256').update(JSON.stringify(['claim-1','98766'])).digest('hex');
 const next={...clone(f.row),id:nextId,payload:nextPayload,submissionId:'submission-2',state:'pending',attemptCount:0,operation:null,receipt:null};
 f.engine.db.publications.submissions[0].closedSale={verified:true,paid:true,cancelled:false,quantity:1,listingId:'98765',orderId:'order-1'};
 f.engine.db.publications.submissions.push({...clone(f.engine.db.publications.submissions[0]),id:'submission-2',closedSale:null,receipt:{listingId:'98766',url:nextPayload.listingUrl}});
 f.engine.db.claims[0].listings.push({listingId:'98766',url:nextPayload.listingUrl});f.engine.db.publicationSupplierSync.push(next);
 assert.equal(restoreSupplierSync(f.engine.db.publicationSupplierSync).length,2);
 const beforeCalls=f.calls.length,result=await f.worker.run(f.engine,nextId,{allowDispatch:true});assert.equal(result.state,'needs_review');assert.match(result.reason,/API 1.8 不支持更换首次关联/);assert.equal(result.attemptCount,0);assert.equal(f.calls.length,beforeCalls);assert.deepEqual(f.engine.db.publicationSupplierSync[0],original);
 const repeated=clone(f.engine.db.publicationSupplierSync);repeated[0]={...clone(f.row),state:'pending',attemptCount:0,operation:null,receipt:null};repeated[1].state='pending';assert.throws(()=>restoreSupplierSync(repeated),{code:'SUPPLIER_OUTBOX_INVALID'});
});

function replacementAfterWithdrawal(){
 const f=fixture(),old=f.engine.db.publicationSupplierSync[0],original=f.engine.db.publications.submissions[0];old.state='cancelled';old.reason='Original item deleted before supplier association';original.closedWithdrawal={kind:'operator_confirmed_deletion',reason:'deleted_not_sold',confirmed:true,profileId:'profile-1',memberId:'123',listingId:'98765',url:old.payload.listingUrl};
 const listingId='98766',payload={...old.payload,listingId,listingUrl:'https://www.vinted.fr/items/'+listingId},id='mark-listed-'+createHash('sha256').update(JSON.stringify(['claim-1',listingId])).digest('hex');
 const next={...clone(old),id,payload,submissionId:'submission-2',state:'pending',reason:'Replacement publication verified'};
 f.engine.db.publicationSupplierSync.push(next);f.engine.db.claims[0].listings.push({listingId,url:payload.listingUrl});
 f.engine.db.publications.submissions.push({...clone(original),id:'submission-2',closedWithdrawal:undefined,receipt:{listingId,url:payload.listingUrl}});
 f.client.markListed=async(claimId,payload,options)=>{f.calls.push(['mark',claimId,clone(payload),options.idempotencyKey]);const saved=f.saved.publicationSupplierSync.find(row=>row.id===id);assert.equal(saved.state,'dispatching');assert.equal(saved.attemptCount,1);f.remote.set.claim={id:claimId,platform:payload.platform,listing_id:payload.listingId,listing_url:payload.listingUrl};return {ok:true};};
 return {...f,next,id,run:options=>f.worker.run(f.engine,id,options)};
}

test('a replacement can send the first supplier association when every earlier listing was withdrawn before dispatch',async()=>{
 const f=replacementAfterWithdrawal(),old=clone(f.engine.db.publicationSupplierSync[0]),result=await f.run({allowDispatch:true});assert.equal(result.state,'synced');assert.equal(result.attemptCount,1);assert.equal(f.marks().length,1);assert.equal(f.marks()[0][2].listingId,'98766');assert.deepEqual(f.engine.db.publicationSupplierSync[0],old);
 await f.run({allowDispatch:true});assert.equal(f.marks().length,1);assert.equal(restoreSupplierSync(f.engine.db.publicationSupplierSync).length,2);
});

test('missing withdrawal or cancelled association evidence keeps reused photos read-only',async()=>{
 for(const change of [db=>{db.publicationSupplierSync.shift();},db=>{delete db.publications.submissions[0].closedWithdrawal;},db=>{db.publicationSupplierSync[0].state='needs_review';},db=>{db.publicationSupplierSync[0].submissionId=null;},db=>{db.claims[0].listings.unshift({listingId:'98764',url:'https://www.vinted.fr/items/98764'});}]){
  const f=replacementAfterWithdrawal();change(f.engine.db);assert.equal((await f.run({allowDispatch:true})).state,'needs_review');assert.equal(f.calls.length,0);assert.equal(f.marks().length,0);
 }
});

test('a previously attempted supplier association cannot be replaced by a new listing after deletion',async()=>{
 for(const mode of ['synced','uncertain']){
  const f=fixture();await f.run({allowDispatch:true});const attempted=clone(f.engine.db.publicationSupplierSync[0]),g=replacementAfterWithdrawal();g.engine.db.publicationSupplierSync[0]=attempted;if(mode==='uncertain')Object.assign(g.engine.db.publicationSupplierSync[0],{state:'uncertain',receipt:null});
  if(mode==='uncertain'){await assert.rejects(g.run({allowDispatch:true}),{code:'SUPPLIER_OUTBOX_INVALID'});}else assert.equal((await g.run({allowDispatch:true})).state,'needs_review');assert.equal(g.calls.length,0);assert.equal(g.marks().length,0);
 }
});

test('changed withdrawn-association history during a supplier read prevents the replacement POST',async()=>{
 const f=replacementAfterWithdrawal(),claim=f.client.claim;f.client.claim=async id=>{const receipt=await claim(id);f.engine.db.publicationSupplierSync[0].state='needs_review';return receipt;};
 await assert.rejects(f.run({allowDispatch:true}),{code:'SUPPLIER_OUTBOX_CHANGED'});assert.equal(f.marks().length,0);
});
