'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const {createLocalProductService,readLocalPreparedPhotos,restoreLocalProducts,localClaimBinding}=require('../src/commerce-local-products.cjs');
const {preparePhotos,preparePhotosForJob,readPreparedPhotos,jpegSize}=require('../src/commerce-photos.cjs');
const {createTrustedPhotoManifest}=require('../src/vinted-photo-upload.cjs');
const {publicationInput}=require('../src/commerce-publication-service.cjs');
const {buildPublicationProof,PublicationJournal,FORM_URL}=require('../src/vinted-publication.cjs');
const {projectPublicationReconciliation}=require('../src/commerce-publication-reconcile.cjs');
const {createSupplierOutbox}=require('../src/commerce-supplier-outbox.cjs');
const clone=value=>JSON.parse(JSON.stringify(value)),hash=value=>createHash('sha256').update(value).digest('hex');
const listing={title:'Local accessory',description:'Local fixture description.',condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen',categoryPath:['Maison','Accessoires']};
// Structural JPEG only. Main's native decoder is exercised by the Electron
// integration fixture; this stub does not claim native decoding coverage.
function jpeg(tail=0){return Buffer.from([255,216,255,192,0,17,8,0,20,0,10,3,1,17,0,2,17,1,3,17,1,255,218,0,12,3,1,0,2,17,3,17,0,63,0,tail,255,217]);}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-local-product-')),instances=[],calls=[];let selected=[];
 const options={dir,profiles:()=>[{id:'profile-1',name:'Local account'},{id:'profile-2',name:'Other account'}],clientFactory:()=>{calls.push('supplier');throw Error('Local product must not contact a supplier');},adapter:{readiness:()=>({capabilities:{}})},seal:value=>value,unseal:value=>value};
 const create=()=>{const engine=new CommerceEngine(options);instances.push(engine);return engine;},engine=create();
 const service=createLocalProductService({selectFiles:async()=>{calls.push('native-picker');return selected;},normalizeImage:async bytes=>({bytes,...jpegSize(bytes)})});
 const importPhotos=async({productId,tail=0}={})=>{const file=path.join(dir,'selected-'+tail+'.jpg');fs.writeFileSync(file,jpeg(tail));selected=[file];return service.importPhotos(engine,productId?{productId}:{});};
 const save=(input={})=>service.saveManualProduct(engine,{name:'Local item',stock:1,listing,listingPriceCents:500,minOfferCents:400,...input});
 const plan=product=>engine.savePlan({profileId:'profile-1',productId:product.id,sku:product.sku,targetCount:2,listingPriceCents:500,minOfferCents:400,listing,enabled:true});
 t.after(async()=>{for(const instance of instances){instance.active.clear();await instance.close();}const absolute=path.resolve(dir);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep+'isola-local-product-'));fs.rmSync(absolute,{recursive:true,force:true});});
 return {dir,engine,service,create,calls,importPhotos,save,plan,setSelected:files=>{selected=files;}};
}

test('manual product drafts need no supplier token and expose only local catalog metadata',t=>{
 const f=fixture(t),saved=f.save({listing:{title:'Draft'},listingPriceCents:'',minOfferCents:''});assert.equal(saved.product.source,'local');assert.match(saved.product.id,/^local-/);assert.match(saved.product.sku,/^LOCAL-/);assert.equal(saved.product.localPhotoCount,0);assert.equal(saved.product.photoSetsAvailable,0);assert.equal(saved.product.priceCents,null);assert.deepEqual(saved.listing.missingFields,['description','condition','brand','color','parcel','categoryPath']);assert.equal(f.engine.db.products.length,0);assert.deepEqual(f.engine.state().products,[saved.product]);assert.deepEqual(f.calls,[]);assert.equal(/photos|fileName|path/.test(JSON.stringify(saved.product)),false);
});

test('native imports return one-use opaque tokens and save private copied JPEGs without original paths',async t=>{
 const f=fixture(t),selected=await f.importPhotos();assert.equal(selected.count,1);assert.deepEqual(selected.photos,[{index:0,width:10,height:20,size:jpeg().length}]);assert.equal(JSON.stringify(selected).includes(f.dir),false);
 const saved=f.save({photoToken:selected.photoToken});assert.equal(saved.product.localPhotoCount,1);assert.equal(saved.product.source,'local');assert.throws(()=>f.save({photoToken:selected.photoToken}));assert.deepEqual(f.calls,['native-picker']);const raw=f.engine.db.localProducts[0];assert.equal(raw.photos[0].sha256,hash(jpeg()));assert.equal(raw.photos[0].fileName.endsWith('.jpg'),true);assert.equal(Object.hasOwn(raw,'supplierAccountId'),false);
 const plan=f.plan(saved.product),prepared=await preparePhotos(f.engine,plan.id,{validateImage:jpegSize});assert.equal(prepared.summary.source,'local');assert.equal(prepared.summary.permanentClaim,false);assert.notEqual(prepared.manifest.files[0].path,path.join(f.dir,'selected-0.jpg'));assert.equal(fs.readFileSync(prepared.manifest.files[0].path).equals(jpeg()),true);assert.equal(f.engine.db.claims[0].source,'local');assert.equal(f.engine.db.claims[0].supplierAccountId,undefined);assert.equal(f.engine.db.photoPreparations.length,0);assert.equal(f.engine.db.localPhotoPreparations.length,1);
 assert.equal((await createTrustedPhotoManifest(prepared.manifest)).claimId,prepared.manifest.claimId);
});

test('renderer paths, unknown tokens, token transfer and duplicate images cannot create local products',async t=>{
 const f=fixture(t);await assert.rejects(f.service.importPhotos(f.engine,{filePaths:['C:/not-authorized.jpg']}));assert.deepEqual(f.calls,[]);assert.throws(()=>f.save({photoToken:'unknown'}));
 const existing=f.save(),selection=await f.importPhotos({productId:existing.product.id});assert.throws(()=>f.save({photoToken:selection.photoToken}));assert.equal(f.save({id:existing.product.id,photoToken:selection.photoToken}).product.localPhotoCount,1);
 const a=path.join(f.dir,'duplicate-a.jpg'),b=path.join(f.dir,'duplicate-b.jpg');fs.writeFileSync(a,jpeg());fs.writeFileSync(b,jpeg());f.setSelected([a,b]);await assert.rejects(f.service.importPhotos(f.engine,{}),/重复图片/);assert.equal(f.engine.db.localProducts.length,1);
});

test('native picker cancellation leaves no product, claim or preparation record',async t=>{
 const f=fixture(t);f.setSelected([]);assert.deepEqual(await f.service.importPhotos(f.engine,{}),{cancelled:true,photoToken:'',count:0,photos:[]});assert.deepEqual(f.engine.db.localProducts,[]);assert.deepEqual(f.engine.db.localPhotoPreparations,[]);assert.deepEqual(f.engine.db.claims,[]);
});

test('invalid images and amounts never replace a saved local product',async t=>{
 const f=fixture(t),saved=f.save(),before=clone(f.engine.db.localProducts);for(const input of [{stock:-1},{stock:1.5},{listingPriceCents:'500'},{minOfferCents:501},{name:''},{sku:'forged'},{listing:{title:'bad\nline'}}])assert.throws(()=>f.save({id:saved.product.id,...input}));assert.deepEqual(f.engine.db.localProducts,before);
 const file=path.join(f.dir,'invalid.jpg');fs.writeFileSync(file,'not an image');f.setSelected([file]);await assert.rejects(f.service.importPhotos(f.engine,{}));assert.deepEqual(f.engine.db.localProducts,before);
});

test('existing plans retain original product photos and templates remain independent',async t=>{
 const f=fixture(t),selection=await f.importPhotos(),saved=f.save({photoToken:selection.photoToken}),plan=f.plan(saved.product),before=clone(plan),replacement=await f.importPhotos({productId:saved.product.id,tail:1});assert.throws(()=>f.save({id:saved.product.id,photoToken:replacement.photoToken}),/已有上架计划/);
 f.save({id:saved.product.id,listing:{title:'Future template'},listingPriceCents:700,minOfferCents:600});assert.deepEqual(f.engine.db.plans,[before]);assert.equal(f.engine.db.localProducts[0].photos[0].sha256,hash(jpeg()));
});

test('a photo-free product can receive its first photos after disabled draft plans were saved',async t=>{
 const f=fixture(t),saved=f.save(),first=f.plan(saved.product);f.engine.setPlanEnabled(first.id,false);
 const second=f.engine.savePlan({...first,id:undefined,profileId:'profile-2',enabled:false}),plans=clone(f.engine.db.plans),selection=await f.importPhotos({productId:saved.product.id});
 // Another product's history does not turn this unused draft into a used item.
 f.engine.db.jobs.push({id:'unrelated-history',productId:'another-product',planId:'another-plan',type:'listing',state:'cancelled',payload:{cycle:0,listingRevision:0},mutationPending:false});
 const updated=f.save({id:saved.product.id,photoToken:selection.photoToken,listing:{...listing,title:'Future template title'},listingPriceCents:700,minOfferCents:600});
 assert.equal(updated.product.id,saved.product.id);assert.equal(updated.product.sku,saved.product.sku);assert.equal(updated.product.localPhotoCount,1);assert.equal(updated.product.revision,saved.product.revision+1);assert.deepEqual(f.engine.db.plans,plans);assert.equal(f.engine.db.localProducts.length,1);assert.equal(f.engine.db.claims.length,0);assert.equal(f.engine.running,false);
 assert.equal((await preparePhotos(f.engine,first.id,{validateImage:jpegSize})).summary.ready,true);assert.equal((await preparePhotos(f.engine,second.id,{validateImage:jpegSize})).summary.ready,true);
 await f.engine.close();const restored=f.create();assert.equal(restored.catalog()[0].localPhotoCount,1);assert.deepEqual(restored.db.plans,plans);assert.equal(readPreparedPhotos(restored,first.id).summary.ready,true);
});

test('first-photo adoption rechecks disabled plans and every original operational record',async t=>{
 const scenarios=[
  ['enabled plan',({engine},plan)=>{plan.enabled=true;}],
  ['previous listing revision',({engine},plan)=>{plan.listingRevision=1;}],
  ['previous sale count',({engine},plan)=>{plan.completedCount=1;}],
  ['active listing',({engine},plan)=>{plan.activeListingId='98765';}],
  ['cancelled job',({engine},plan)=>{engine.db.jobs.push({id:'old-job',planId:plan.id,productId:plan.productId,state:'cancelled'});}],
  ['sale history',({engine},plan)=>{engine.db.sales.push({planId:plan.id,jobId:'old-sale-job'});}],
  ['photo claim',({engine},plan)=>{engine.db.claims.push({id:'old-claim',localProductId:plan.productId});}],
  ['local preparation',({engine},plan)=>{engine.db.localPhotoPreparations.push({planId:plan.id});}],
  ['supplier preparation',({engine},plan)=>{engine.db.photoPreparations.push({productId:plan.productId});}],
  ['closed publication',({engine},plan)=>{engine.db.publications.submissions.push({state:'cancelled',proof:{facts:{planId:plan.id}}});}],
  ['supplier association history',({engine},plan)=>{engine.db.publicationSupplierSync.push({productId:plan.productId});}]
 ];
 for(const [name,change] of scenarios)await t.test(name,async sub=>{
  const f=fixture(sub),saved=f.save(),plan=f.plan(saved.product);f.engine.setPlanEnabled(plan.id,false);const selection=await f.importPhotos({productId:saved.product.id}),clean=clone(f.engine.db);
  // State can change after the picker returns; saving must check it again.
  change(f,plan);const blocked=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8');assert.throws(()=>f.save({id:saved.product.id,photoToken:selection.photoToken}),/已有上架计划/);assert.deepEqual(f.engine.db,blocked);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);
  f.engine.db=clean;assert.equal(f.save({id:saved.product.id,photoToken:selection.photoToken}).product.localPhotoCount,1);assert.deepEqual(f.engine.db.plans,clean.plans);
 });
});

test('local photos survive restart, ignore later source-file changes and reject copied-file tampering',async t=>{
 const f=fixture(t),selection=await f.importPhotos(),saved=f.save({photoToken:selection.photoToken}),plan=f.plan(saved.product),prepared=await preparePhotos(f.engine,plan.id,{validateImage:jpegSize});fs.writeFileSync(path.join(f.dir,'selected-0.jpg'),jpeg(4));assert.equal(readPreparedPhotos(f.engine,plan.id).summary.ready,true);
 await f.engine.close();const restored=f.create();assert.equal(readPreparedPhotos(restored,plan.id).summary.ready,true);assert.equal(restored.db.localProducts.length,1);assert.equal(restored.db.localPhotoPreparations.length,1);
 fs.writeFileSync(prepared.manifest.files[0].path,jpeg(9));assert.equal(readLocalPreparedPhotos(restored,plan.id).summary.ready,false);await assert.rejects(preparePhotos(restored,plan.id,{validateImage:jpegSize}),{code:'LOCAL_PHOTO_STORAGE'});assert.equal(restored.db.localPhotoPreparations.length,1);assert.equal(restored.db.claims.length,1);assert.deepEqual(f.calls,['native-picker']);
});

test('local preparation jobs still require the exact active lease and cancellation guards',async t=>{
 const f=fixture(t),selection=await f.importPhotos(),saved=f.save({photoToken:selection.photoToken}),plan=f.plan(saved.product);f.engine.seed();const job=f.engine.db.jobs[0],controller=new AbortController();job.state='running';await assert.rejects(preparePhotosForJob(f.engine,job,{signal:controller.signal,validateImage:jpegSize}),{code:'STOPPED'});assert.equal(f.engine.db.claims.length,0);
 f.engine.active.set(plan.profileId,controller);const lease=f.engine.leases.acquire(plan.profileId,job.id);try{const prepared=await preparePhotosForJob(f.engine,job,{signal:controller.signal,validateImage:jpegSize});assert.equal(prepared.summary.source,'local');controller.abort();await assert.rejects(preparePhotosForJob(f.engine,job,{signal:controller.signal,validateImage:jpegSize}),{code:'STOPPED'});}finally{f.engine.active.delete(plan.profileId);f.engine.leases.release(lease);}
});

test('local publication inputs use persisted local catalog and photos without calling a supplier',async t=>{
 const f=fixture(t),selection=await f.importPhotos(),saved=f.save({photoToken:selection.photoToken}),plan=f.plan(saved.product);await preparePhotos(f.engine,plan.id,{validateImage:jpegSize});f.engine.bindMarketAccount(plan.profileId,{verified:true,memberId:'123',username:'fixture_seller',profileURL:'https://www.vinted.fr/member/123',documentKey:'fixture-document'});
 const input=await publicationInput(f.engine,plan.id,new AbortController().signal,()=>{});assert.equal(input.product.source,'local');assert.equal(input.claim.source,'local');assert.equal(input.manifest.files[0].sha256,hash(jpeg()));assert.deepEqual(f.calls,['native-picker']);
 input.claim.source='supplier';await assert.rejects(publicationInput(f.engine,plan.id,new AbortController().signal,()=>{}));
});

test('local publication reconciliation retains the same journal protections and creates no supplier outbox',async t=>{
 const f=fixture(t),selection=await f.importPhotos(),saved=f.save({photoToken:selection.photoToken}),plan=f.plan(saved.product);await preparePhotos(f.engine,plan.id,{validateImage:jpegSize});f.engine.bindMarketAccount(plan.profileId,{verified:true,memberId:'123',username:'fixture_seller',profileURL:'https://www.vinted.fr/member/123',documentKey:'fixture-document'});f.engine.seed();
 const input=await publicationInput(f.engine,plan.id,new AbortController().signal,()=>{}),at=new Date().toISOString(),clock=Date.parse(at),documentKey='fixture-document',signature='a'.repeat(64),account=input.expectedAccount;
 const evidence={profileId:plan.profileId,tabId:'fixture-tab',documentKey,url:FORM_URL,observedAt:at,challenge:false,account:{...account,verified:true},form:{documentKey,complete:true,invalidFields:[],unknownFields:[],fields:Object.entries({...listing,priceCents:500}).map(([field,value])=>({field,value,verified:true}))},photos:{documentKey,profileId:plan.profileId,productId:plan.productId,claimId:input.claim.id,setId:input.claim.setId,count:1,signature,verified:true,busy:false,errorCount:0},publication:{documentKey,count:1,observed:true,label:'Ajouter',enabled:true}};
 const proof=buildPublicationProof({...input,evidence},{now:clock}),journal=new PublicationJournal({persist:()=>{},now:()=>clock,dispatchEnabled:true}),record=await journal.prepare(proof);await journal.dispatchOnce(record.id,proof,async()=>{});f.engine.db.publications=journal.state();
 await journal.reconcile(record.id,{verified:true,mappingVerified:true,publicationStatus:'published',observedAt:at,profileId:plan.profileId,account:{...account,verified:true},seller:{...account,verified:true},ownedByCurrentAccount:true,listingId:'98765',url:'https://www.vinted.fr/items/98765',origin:{kind:'observed_submission_navigation',submissionId:record.id,formDocumentKey:documentKey},priceKind:'item',priceCents:500,currency:'EUR',title:listing.title,photos:{verified:true,count:1,signature}});
 const projected=projectPublicationReconciliation(f.engine.db,journal.state(),{now:clock});assert.equal(projected.db.plans[0].activeListingId,'98765');assert.equal(projected.db.jobs[0].state,'completed');assert.equal(projected.db.claims[0].listings.length,1);assert.deepEqual(projected.db.publicationSupplierSync,[]);assert.equal(projectPublicationReconciliation(projected.db,projected.db.publications,{now:clock}).changed,false);assert.deepEqual(f.calls,['native-picker']);
 const forged=clone(f.engine.db);forged.claims[0].source='supplier';assert.throws(()=>projectPublicationReconciliation(forged,journal.state(),{now:clock}));
});

test('a forged supplier outbox cannot send a local claim to the supplier',async t=>{
 const f=fixture(t),selection=await f.importPhotos(),saved=f.save({photoToken:selection.photoToken}),plan=f.plan(saved.product);await preparePhotos(f.engine,plan.id,{validateImage:jpegSize});const claim=f.engine.db.claims[0],at=new Date().toISOString(),payload={action:'published',platform:'Vinted',listingId:'98765',listingUrl:'https://www.vinted.fr/items/98765'},id='mark-listed-'+hash(JSON.stringify([claim.id,payload.listingId]));f.engine.db.publicationSupplierSync=[{id,kind:'mark_listed',claimId:claim.id,profileId:plan.profileId,productId:plan.productId,submissionId:null,state:'pending',attemptCount:0,operation:null,receipt:null,payload,createdAt:at,updatedAt:at,reason:'forged local fixture'}];
 await assert.rejects(createSupplierOutbox().run(f.engine,id,{allowDispatch:true,signal:new AbortController().signal}),{code:'SUPPLIER_LOCAL_PRODUCT'});assert.deepEqual(f.calls,['native-picker']);assert.throws(()=>restoreLocalProducts(f.engine.db));
});

test('stored local product or preparation identity conflicts are rejected without rewriting original files',async t=>{
 const f=fixture(t),selection=await f.importPhotos(),saved=f.save({photoToken:selection.photoToken}),plan=f.plan(saved.product);await preparePhotos(f.engine,plan.id,{validateImage:jpegSize});await f.engine.close();const db=JSON.parse(fs.readFileSync(f.engine.file,'utf8'));
 const changes=[value=>value.localProducts.push(clone(value.localProducts[0])),value=>value.localProducts[0].source='supplier',value=>value.localPhotoPreparations[0].profileId='profile-2',value=>value.claims[0].supplierAccountId='forged',value=>value.localPhotoPreparations=[],value=>value.localProducts[0].photos[0].fileName='../escape.jpg'];
 for(const change of changes){const value=clone(db);change(value);const text=JSON.stringify(value);fs.writeFileSync(f.engine.file,text);assert.throws(()=>f.create());assert.equal(fs.readFileSync(f.engine.file,'utf8'),text);}
});
