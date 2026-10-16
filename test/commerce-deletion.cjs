'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const {createLocalProductService}=require('../src/commerce-local-products.cjs');
const {jpegSize,preparePhotos}=require('../src/commerce-photos.cjs');
const {deletePlan,deleteLocalProduct}=require('../src/commerce-deletion.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const listing={title:'Unused draft title',description:'Unused local draft.',condition:'Très bon état',brand:'Sans marque',color:'Noir',parcel:'Moyen',categoryPath:['Maison','Accessoires']};
const jpeg=Buffer.from([255,216,255,192,0,17,8,0,20,0,10,3,1,17,0,2,17,1,3,17,1,255,218,0,12,3,1,0,2,17,3,17,0,63,0,0,255,217]);
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-deletion-')),instances=[],network=[];let selected=[];
 const options={dir,profiles:()=>[{id:'profile-1',name:'Fixed environment'},{id:'profile-2',name:'Other environment'}],clientFactory:()=>{network.push('supplier');throw Error('Deletion must not contact supplier');},adapter:{readiness:()=>({capabilities:{}})},seal:value=>value,unseal:value=>value};
 const create=()=>{const engine=new CommerceEngine(options);instances.push(engine);return engine;},engine=create(),service=createLocalProductService({selectFiles:async()=>selected,normalizeImage:bytes=>({bytes,...jpegSize(bytes)})});
 engine.db.products=[{id:'supplier-product',sku:'SUPPLIER-SKU',name:'Original supplier product',stock:3,priceCents:100,photoSetsAvailable:1,revision:1}];engine.persist();
 const product=service.saveManualProduct(engine,{name:'Unused manual product',stock:1,listing,listingPriceCents:500,minOfferCents:400}).product;
 const plan=(extra={})=>engine.savePlan({profileId:'profile-1',productId:product.id,sku:product.sku,targetCount:2,listingPriceCents:500,minOfferCents:400,listing,enabled:false,...extra});
 const photos=async()=>{const file=path.join(dir,'selected.jpg');fs.writeFileSync(file,jpeg);selected=[file];const result=await service.importPhotos(engine,{productId:product.id});return service.saveManualProduct(engine,{id:product.id,name:product.name,stock:1,listing,listingPriceCents:500,minOfferCents:400,photoToken:result.photoToken});};
 t.after(async()=>{for(const engine of instances){engine.active.clear();engine.running=false;engine.ticking=false;await engine.close();}const absolute=path.resolve(dir);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.ok(path.basename(absolute).startsWith('isola-deletion-'));fs.rmSync(absolute,{recursive:true,force:true});});
 return {dir,engine,service,product,plan,photos,create,network};
}
function job(plan,extra={}){const at=new Date().toISOString();return {id:'original-job',type:'listing',planId:plan.id,profileId:plan.profileId,productId:plan.productId,dedupeKey:'listing:'+plan.id+':0',state:'queued',step:'pending',payload:{cycle:0,listingRevision:0},operation:null,mutationPending:false,result:null,error:'',createdAt:at,updatedAt:at,...extra};}
function publication(plan,state='uncertain'){return {id:'original-submission',state,attemptCount:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),proof:{facts:{planId:plan.id,profileId:plan.profileId,productId:plan.productId}},receipt:null};}
async function rejectsUnchanged(f,action,code){const db=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8');await assert.rejects(action,{code});assert.deepEqual(f.engine.db,db);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.deepEqual(f.network,[]);}

test('deleting an unused plan persists only its removal and leaves product templates, other plans, settings and accounts intact',async t=>{
 const f=fixture(t),first=f.plan(),other=f.plan({profileId:'profile-2'}),before=clone(f.engine.db);const result=await deletePlan(f.engine,first.id);assert.deepEqual(result,{deleted:true,id:first.id});assert.deepEqual(f.engine.db.plans,[other]);for(const key of Object.keys(before).filter(key=>!['plans','events'].includes(key)))assert.deepEqual(f.engine.db[key],before[key]);assert.match(f.engine.db.events.at(-1).text,/删除.*无业务记录/);assert.deepEqual(f.network,[]);
 await f.engine.close();const restored=f.create();assert.deepEqual(restored.db.plans,[other]);assert.equal(restored.db.localProducts[0].id,f.product.id);assert.equal(restored.db.productListings[0].productId,f.product.id);await assert.rejects(deletePlan(restored,first.id),{code:'DELETION_MISSING'});
});

test('an enabled but never scheduled empty plan may be removed while the global runner is stopped',async t=>{
 const f=fixture(t),plan=f.plan({enabled:true});assert.equal(f.engine.running,false);assert.equal(f.engine.db.jobs.length,0);await deletePlan(f.engine,plan.id);assert.equal(f.engine.db.plans.length,0);assert.equal(f.engine.running,false);assert.equal(f.engine.db.jobs.length,0);
});

test('another environment may retain the same product photos and job history while an unrelated unused plan is deleted',async t=>{
 const f=fixture(t);await f.photos();const unused=f.plan(),used=f.plan({profileId:'profile-2'}),prepared=await preparePhotos(f.engine,used.id,{validateImage:jpegSize});f.engine.db.jobs.push(job(used,{state:'cancelled'}));f.engine.persist();const before={claims:clone(f.engine.db.claims),preparations:clone(f.engine.db.localPhotoPreparations),jobs:clone(f.engine.db.jobs)};
 await deletePlan(f.engine,unused.id);assert.deepEqual(f.engine.db.claims,before.claims);assert.deepEqual(f.engine.db.localPhotoPreparations,before.preparations);assert.deepEqual(f.engine.db.jobs,before.jobs);assert.equal(fs.readFileSync(prepared.manifest.files[0].path).equals(jpeg),true);
 await f.engine.close();const restored=f.create();assert.equal(restored.db.plans.length,1);assert.equal(restored.db.plans[0].id,used.id);assert.equal(restored.db.localPhotoPreparations[0].planId,used.id);assert.equal(restored.db.claims[0].id,prepared.manifest.claimId);
});

test('active or unaccounted sold plans preserve occupancy, while a relisting revision can be archived without erasure',async t=>{
 for(const [name,change,code] of [['in sale',plan=>plan.activeListingId='123456','DELETION_ACTIVE_LISTING'],['sold without original sale',plan=>plan.completedCount=1,'DELETION_SALE_HISTORY']])await t.test(name,async sub=>{const f=fixture(sub),plan=f.plan();change(plan);f.engine.persist();await rejectsUnchanged(f,()=>deletePlan(f.engine,plan.id),code);});
 const f=fixture(t),plan=f.plan();plan.listingRevision=1;f.engine.persist();assert.deepEqual(await deletePlan(f.engine,plan.id),{deleted:true,id:plan.id,archived:true});assert.equal(f.engine.db.plans[0].listingRevision,1);assert.equal(f.engine.db.planArchives[0].planId,plan.id);
});

test('every original publication remains protected, including uncertain, published, closed and cancelled submissions',async t=>{
 for(const state of ['uncertain','published','cancelled','closed'])await t.test(state,async sub=>{const f=fixture(sub),plan=f.plan(),record=publication(plan,state==='closed'?'published':state);if(state==='closed')record.closedWithdrawal={reason:'deleted_not_sold'};f.engine.db.publications.submissions.push(record);f.engine.persist();if(['uncertain','published'].includes(state))await rejectsUnchanged(f,()=>deletePlan(f.engine,plan.id),'DELETION_PUBLICATION_HISTORY');else{const before=clone(record);assert.equal((await deletePlan(f.engine,plan.id)).archived,true);assert.deepEqual(f.engine.db.publications.submissions,[before]);assert.equal(f.engine.db.plans[0].id,plan.id);}});
});

test('queued, failed, cancelled and completed jobs cannot be erased with the plan or bypassed by recreating it',async t=>{
 for(const state of ['queued','needs_review','cancelled','completed','uncertain'])await t.test(state,async sub=>{const f=fixture(sub),plan=f.plan();f.engine.db.jobs.push(job(plan,{state}));f.engine.persist();if(state==='uncertain')await rejectsUnchanged(f,()=>deletePlan(f.engine,plan.id),'DELETION_JOB_HISTORY');else{const before=clone(f.engine.db.jobs[0]);assert.equal((await deletePlan(f.engine,plan.id)).archived,true);const retained=f.engine.db.jobs[0];assert.equal(retained.state,state==='queued'?'cancelled':state);for(const key of Object.keys(before).filter(key=>state!=='queued'||!['state','retryAt','blockedReason','error','updatedAt'].includes(key)))assert.deepEqual(retained[key],before[key]);assert.equal(f.engine.db.plans[0].id,plan.id);}assert.equal(f.engine.db.jobs[0].dedupeKey,'listing:'+plan.id+':0');});
});

test('local preparations and original claims require their original plan even when the claim has never been listed',async t=>{
 const f=fixture(t);await f.photos();const plan=f.plan();await preparePhotos(f.engine,plan.id,{validateImage:jpegSize});const before=clone({preparations:f.engine.db.localPhotoPreparations,claims:f.engine.db.claims});assert.equal((await deletePlan(f.engine,plan.id)).archived,true);assert.deepEqual({preparations:f.engine.db.localPhotoPreparations,claims:f.engine.db.claims},before);assert.equal(f.engine.db.plans[0].id,plan.id);await rejectsUnchanged(f,()=>deleteLocalProduct(f.engine,f.product.id),'DELETION_PRODUCT_PLANS');await f.engine.close();const reopened=f.create();assert.equal(reopened.state().plans[0].archived,true);assert.deepEqual({preparations:reopened.db.localPhotoPreparations,claims:reopened.db.claims},before);
});

test('supplier preparations, legacy claims, link-only plan references, sales and outbox records give specific protected-history errors',async t=>{
 const scenarios=[
  ['unresolved supplier preparation',(db,plan)=>db.photoPreparations.push({id:'prepared',planId:plan.id,profileId:plan.profileId,productId:plan.productId,state:'uncertain',firstAttemptAt:new Date().toISOString(),assets:[],images:[]}), 'DELETION_PHOTO_HISTORY'],
  ['claim link',(db,plan)=>db.claims.push({id:'old-claim',profileId:'other-profile',productId:'other-product',images:[],listings:[{planId:plan.id,listingId:'123456'}]}), 'DELETION_PHOTO_HISTORY'],
  ['sale',(db,plan)=>db.sales.push({planId:plan.id,jobId:'missing-old-job'}), 'DELETION_SALE_HISTORY'],
  ['supplier outbox',(db,plan)=>db.publicationSupplierSync.push({id:'original-outbox',profileId:plan.profileId,productId:plan.productId,state:'uncertain'}), 'DELETION_SUPPLIER_HISTORY'],
  ['explicit reservation',(db,plan)=>db.reservations.push({planId:plan.id,cents:500}), 'DELETION_RESERVATION_HISTORY']
 ];
 for(const [name,add,code] of scenarios)await t.test(name,async sub=>{const f=fixture(sub),plan=f.plan();add(f.engine.db,plan);f.engine.persist();await rejectsUnchanged(f,()=>deletePlan(f.engine,plan.id),code);});
});

test('an unused manual product and its template can be removed without deleting private photos or the supplier catalog',async t=>{
 const f=fixture(t);await f.photos();const before=clone(f.engine.db),row=f.engine.db.localProducts[0],photo=path.join(f.dir,'local-product-photos',row.photoSetId,row.photos[0].fileName),bytes=fs.readFileSync(photo);const result=await deleteLocalProduct(f.engine,f.product.id);assert.deepEqual(result,{deleted:true,id:f.product.id});assert.deepEqual(f.engine.db.localProducts,[]);assert.deepEqual(f.engine.db.productListings,[]);assert.deepEqual(f.engine.db.products,before.products);assert.equal(fs.readFileSync(photo).equals(bytes),true);assert.equal(f.engine.db.plans.length,0);assert.equal(f.engine.db.claims.length,0);assert.deepEqual(f.network,[]);
 await f.engine.close();const restored=f.create();assert.deepEqual(restored.db.localProducts,[]);assert.deepEqual(restored.db.productListings,[]);assert.equal(restored.db.products[0].id,'supplier-product');
});

test('a product used even by a disabled unused plan must keep that plan until it is explicitly deleted first',async t=>{
 const f=fixture(t),plan=f.plan();await rejectsUnchanged(f,()=>deleteLocalProduct(f.engine,f.product.id),'DELETION_PRODUCT_PLANS');await deletePlan(f.engine,plan.id);await deleteLocalProduct(f.engine,f.product.id);assert.equal(f.engine.db.plans.length,0);assert.equal(f.engine.db.localProducts.length,0);
});

test('supplier catalog rows cannot be deleted through the local product endpoint',async t=>{
 const f=fixture(t);await rejectsUnchanged(f,()=>deleteLocalProduct(f.engine,'supplier-product'),'DELETION_SUPPLIER_PRODUCT');await assert.rejects(deleteLocalProduct(f.engine,'missing'),{code:'DELETION_MISSING'});
});

test('an unused local copy with supplier provenance is deletable while the original provider records remain unchanged',async t=>{
 const f=fixture(t);await f.photos();const row=f.engine.db.localProducts[0];row.origin={kind:'supplier-reuse',baseURL:'https://supplier.example.test/api/v1',supplierAccountId:'fixture-supplier',productId:'supplier-product',setId:'used-supplier-set',sku:'SUPPLIER-SKU',status:'used',importedAt:row.createdAt};f.engine.db.photoSets.push({id:'used-supplier-set',productId:'supplier-product',claimStatus:'used',claimedByMe:false,imageCount:1});f.engine.persist();const before=clone({products:f.engine.db.products,photoSets:f.engine.db.photoSets});
 await deleteLocalProduct(f.engine,row.id);assert.deepEqual({products:f.engine.db.products,photoSets:f.engine.db.photoSets},before);assert.equal(f.engine.db.localProducts.length,0);assert.equal(f.engine.db.productListings.length,0);assert.deepEqual(f.network,[]);
});

test('orphaned direct product references still protect jobs, publications, claims, preparations, sales and supplier requests',async t=>{
 const scenarios=[
  ['job',(db,product)=>db.jobs.push(job({id:'old-plan',profileId:'profile-1',productId:product.id})), 'DELETION_JOB_HISTORY'],
  ['publication',(db,product)=>db.publications.submissions.push(publication({id:'old-plan',profileId:'profile-1',productId:product.id})), 'DELETION_PUBLICATION_HISTORY'],
  ['claim',(db,product)=>db.claims.push({id:'old-claim',localProductId:product.id,images:[],listings:[]}), 'DELETION_PHOTO_HISTORY'],
  ['local preparation',(db,product)=>db.localPhotoPreparations.push({productId:product.id,assets:[]}), 'DELETION_PHOTO_HISTORY'],
  ['supplier preparation',(db,product)=>db.photoPreparations.push({productId:product.id,assets:[]}), 'DELETION_PHOTO_HISTORY'],
  ['sale',(db,product)=>db.sales.push({productId:product.id,jobId:'old-job'}), 'DELETION_SALE_HISTORY'],
  ['outbox',(db,product)=>db.publicationSupplierSync.push({productId:product.id,state:'uncertain'}), 'DELETION_SUPPLIER_HISTORY']
 ];
 for(const [name,add,code] of scenarios)await t.test(name,async sub=>{const f=fixture(sub);add(f.engine.db,f.product);f.engine.persist();await rejectsUnchanged(f,()=>deleteLocalProduct(f.engine,f.product.id),code);});
});

test('running, ticking, active controller, lease and pending configuration all reject before changing any row',async t=>{
 const scenarios=[['running',f=>f.engine.running=true],['tick',f=>f.engine.ticking=true],['controller',f=>f.engine.active.set('profile-1',new AbortController())],['lease',f=>f.engine.leases.acquire('profile-1','read-only-job')],['configuration',f=>f.engine.configPending=1]];
 for(const [name,makeBusy] of scenarios)await t.test(name,async sub=>{const f=fixture(sub),plan=f.plan();makeBusy(f);await rejectsUnchanged(f,()=>deletePlan(f.engine,plan.id),'DELETION_BUSY');await rejectsUnchanged(f,()=>deleteLocalProduct(f.engine,f.product.id),'DELETION_BUSY');f.engine.configPending=0;});
});

test('closing and storage faults preserve the draft and reject both deletion methods',async t=>{
 for(const kind of ['closing','faulted','account storage'])await t.test(kind,async sub=>{const f=fixture(sub),plan=f.plan();if(kind==='closing')f.engine.closing=true;else if(kind==='account storage')f.engine.accounts={faulted:true,list:()=>[]};else f.engine.faulted=true;const code=kind==='closing'?'DELETION_CLOSED':'DELETION_STORAGE';await rejectsUnchanged(f,()=>deletePlan(f.engine,plan.id),code);await rejectsUnchanged(f,()=>deleteLocalProduct(f.engine,f.product.id),code);});
});

test('deletion rechecks the live graph when its configuration turn begins',async t=>{
 const f=fixture(t),plan=f.plan(),pending=deletePlan(f.engine,plan.id);f.engine.db.jobs.push(job(plan,{state:'uncertain'}));f.engine.persist();await assert.rejects(pending,{code:'DELETION_JOB_HISTORY'});assert.equal(f.engine.db.plans[0].id,plan.id);assert.equal(f.engine.db.jobs.length,1);
});

test('a failed durable plan deletion rolls back its original arrays and leaves the original file recoverable',async t=>{
 const f=fixture(t),plan=f.plan(),plans=f.engine.db.plans,events=f.engine.db.events,before=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8');f.engine.persist=()=>{f.engine.faulted=true;throw Error('Fixture storage failure before commit');};await assert.rejects(deletePlan(f.engine,plan.id),/storage failure/);assert.equal(f.engine.db.plans,plans);assert.equal(f.engine.db.events,events);assert.deepEqual(f.engine.db,before);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.equal(f.engine.faulted,true);
});

test('a failed durable product deletion rolls back both product and template without touching photo files',async t=>{
 const f=fixture(t);await f.photos();const products=f.engine.db.localProducts,templates=f.engine.db.productListings,events=f.engine.db.events,before=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8'),row=products[0],photo=path.join(f.dir,'local-product-photos',row.photoSetId,row.photos[0].fileName);f.engine.persist=()=>{f.engine.faulted=true;throw Error('Fixture product storage failure');};await assert.rejects(deleteLocalProduct(f.engine,f.product.id),/storage failure/);assert.equal(f.engine.db.localProducts,products);assert.equal(f.engine.db.productListings,templates);assert.equal(f.engine.db.events,events);assert.deepEqual(f.engine.db,before);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.equal(fs.readFileSync(photo).equals(jpeg),true);
});

test('duplicate clicks, invalid IDs and malformed references cannot silently remove a different record',async t=>{
 const f=fixture(t),plan=f.plan();for(const id of ['',null,{id:plan.id,force:true},' '+plan.id])await assert.rejects(deletePlan(f.engine,id),{code:'DELETION_INVALID'});
 const first=deletePlan(f.engine,plan.id);await assert.rejects(deletePlan(f.engine,plan.id),{code:'DELETION_BUSY'});assert.deepEqual(await first,{deleted:true,id:plan.id});await assert.rejects(deletePlan(f.engine,plan.id),{code:'DELETION_MISSING'});
 f.engine.db.productListings[0].sku='stale SKU';await assert.rejects(deleteLocalProduct(f.engine,f.product.id),{code:'DELETION_PRODUCT_MISMATCH'});assert.equal(f.engine.db.localProducts.length,1);
});
