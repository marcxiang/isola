'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const {SKUDeskClient}=require('../src/sku-desk.cjs');
const {createLocalProductService,readLocalPreparedPhotos}=require('../src/commerce-local-products.cjs');
const {preparePhotos,jpegSize}=require('../src/commerce-photos.cjs');
const {normalizeListing}=require('../src/listing-config.cjs');
const clone=value=>JSON.parse(JSON.stringify(value)),sha=value=>createHash('sha256').update(value).digest('hex');
const BASE='https://supplier.example.test/api/v1',PRODUCT='supplier-product',SET='used-set',SKU='ORIGINAL SKU',IMAGE=BASE+'/photos/images/img-1';
const listing={title:'Saved accessory title',description:'Saved listing description.',condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen',categoryPath:['Maison','Accessoires']};
// Structural JPEG only. Native decoding/conversion is separately exercised by
// Electron import/flow fixtures; these tests make no native-code coverage claim.
const jpeg=(tail=0)=>Buffer.from([255,216,255,192,0,17,8,0,20,0,10,3,1,17,0,2,17,1,3,17,1,255,218,0,12,3,1,0,2,17,3,17,0,63,0,tail,255,217]);
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-supplier-reuse-')),calls=[],instances=[],overrides=new Map();let selected=[],normalize=bytes=>({bytes,...jpegSize(bytes)});
 const remote={product:{id:PRODUCT,sku:SKU,name:'Live supplier product snapshot',stock:3,unitPriceCents:99},set:{id:SET,productId:PRODUCT,status:'used',claimedByMe:false,claim:{id:'someone-elses-claim',platform:'Vinted',listingId:'111111',listingUrl:'https://www.vinted.fr/items/111111'},imageCount:1,images:[{id:'img-1',url:IMAGE}]},accountId:'supplier-account'};
 const options={dir,profiles:()=>[{id:'profile-1',name:'Original fixed environment'}],seal:value=>value,unseal:value=>value,adapter:{readiness:()=>({capabilities:{}})},clientFactory:config=>new SKUDeskClient({...config,fetchImpl:async(url,input)=>{
  const route=new URL(url).pathname;calls.push({route,url,method:input.method,authorization:input.headers.Authorization,signal:input.signal});assert.equal(input.method,'GET','Photo reuse must never send a supplier mutation');assert.equal(input.redirect,'error');
  if(overrides.has(route))return overrides.get(route)(input);
  if(route==='/api/v1/me')return json({user:{id:remote.accountId}});
  if(route==='/api/v1/products/'+PRODUCT)return json({product:clone(remote.product)});
  if(route==='/api/v1/photos/sets/'+SET)return json({set:clone(remote.set)});
  if(route==='/api/v1/photos/images/img-1')return new Response(jpeg(),{headers:{'content-type':'image/jpeg'}});
  throw Error('Unexpected supplier route '+route);
 }})};
 const create=()=>{const next=new CommerceEngine(options);instances.push(next);return next;},engine=create();engine.db.settings.baseURL=BASE;engine.db.supplierAccountId=remote.accountId;engine.db.encryptedToken='fixture-only-token';engine.db.products=[{id:PRODUCT,sku:SKU,name:'Older cached product',stock:8,priceCents:44,photoSetsAvailable:0,revision:1}];engine.db.photoSets=[{id:SET,productId:PRODUCT,name:'Previously used set',claimStatus:'used',claimedByMe:false,imageCount:1,claimId:'someone-elses-claim'}];
 engine.saveProductListing({productId:PRODUCT,sku:SKU,listing,listingPriceCents:500,minOfferCents:400});const originalPlan=engine.savePlan({profileId:'profile-1',productId:PRODUCT,sku:SKU,targetCount:2,listingPriceCents:500,minOfferCents:400,listing,enabled:false});
 engine.db.claims.push({id:'original-prior-claim',profileId:'profile-1',productId:PRODUCT,setId:'different-prior-set',images:[{id:'prior-image',url:BASE+'/photos/images/prior-image'}],listings:[{listingId:'222222',url:'https://www.vinted.fr/items/222222',planId:originalPlan.id}],supplierAccountId:remote.accountId});engine.persist();
 const service=createLocalProductService({selectFiles:async()=>selected,normalizeImage:bytes=>normalize(bytes)}),input={productId:PRODUCT,setId:SET};
 const save=(result,extra={})=>service.saveManualProduct(engine,{name:result.product.name,stock:result.product.stock,listing:result.product.listing,listingPriceCents:result.product.listingPriceCents,minOfferCents:result.product.minOfferCents,photoToken:result.photoToken,...extra});
 t.after(async()=>{for(const instance of instances){instance.active.clear();await instance.close();}const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('isola-supplier-reuse-'));fs.rmSync(resolved,{recursive:true,force:true});});
 return {dir,engine,service,input,remote,calls,overrides,create,save,setSelected:value=>selected=value,setNormalize:value=>normalize=value};
}
function history(engine){return Object.fromEntries(['products','photoSets','plans','jobs','claims','sales','reservations','photoPreparations','localPhotoPreparations','publications','publicationSupplierSync'].map(key=>[key,clone(engine.db[key])]));}

test('a used set claimed by someone else can be read into an opaque local copy without changing any supplier ownership or history',async t=>{
 const f=fixture(t),before=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8'),providerBefore=clone(f.remote),result=await f.service.importSupplierPhotos(f.engine,f.input);
 assert.equal(result.count,1);assert.deepEqual(result.photos,[{index:0,width:10,height:20,size:jpeg().length}]);assert.deepEqual(result.source,{setId:SET,status:'used',productId:PRODUCT,sku:SKU});assert.deepEqual(result.product,{name:f.remote.product.name,stock:3,sku:SKU,listing:normalizeListing(listing),listingPriceCents:500,minOfferCents:400});
 assert.deepEqual(f.engine.db,before);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.deepEqual(f.remote,providerBefore);assert.deepEqual(f.calls.map(row=>row.route),['/api/v1/me','/api/v1/products/'+PRODUCT,'/api/v1/photos/sets/'+SET,'/api/v1/photos/images/img-1']);assert.ok(f.calls.every(row=>row.method==='GET'&&row.authorization==='Bearer fixture-only-token'));
 const encoded=JSON.stringify(result);for(const forbidden of [f.dir,BASE,'supplier-account','someone-elses-claim',IMAGE,'fixture-only-token'])assert.equal(encoded.includes(forbidden),false);
 const beforeHistory=history(f.engine),saved=f.save(result);assert.equal(saved.product.source,'local');assert.notEqual(saved.product.id,PRODUCT);assert.notEqual(saved.product.sku,SKU);assert.match(saved.product.sku,/^LOCAL-/);assert.equal(saved.product.localPhotoCount,1);assert.deepEqual(history(f.engine),beforeHistory);
 const row=f.engine.db.localProducts[0];assert.equal(row.photos[0].sha256,sha(jpeg()));assert.equal(row.origin.kind,'supplier-reuse');assert.equal(row.origin.baseURL,BASE);assert.equal(row.origin.supplierAccountId,'supplier-account');assert.equal(row.origin.setId,SET);assert.equal(row.origin.status,'used');assert.equal(Object.hasOwn(row.origin,'claimId'),false);assert.deepEqual(saved.product.origin,{kind:'supplier-reuse',productId:PRODUCT,setId:SET,sku:SKU,status:'used',importedAt:row.origin.importedAt});
 assert.throws(()=>f.save(result),/照片选择已过期/);const plan=f.engine.savePlan({profileId:'profile-1',productId:saved.product.id,sku:saved.product.sku,targetCount:2,listingPriceCents:500,minOfferCents:400,listing,enabled:false}),requestCount=f.calls.length;const prepared=await preparePhotos(f.engine,plan.id,{validateImage:jpegSize});assert.equal(prepared.summary.source,'local');assert.equal(prepared.manifest.files[0].sha256,sha(jpeg()));assert.equal(f.calls.length,requestCount);assert.equal(f.engine.db.claims.filter(claim=>claim.source==='local').length,1);assert.equal(f.engine.db.claims.find(claim=>claim.source==='local').supplierAccountId,undefined);assert.deepEqual(f.engine.db.claims.find(claim=>claim.id==='original-prior-claim'),beforeHistory.claims[0]);assert.deepEqual(f.engine.db.publicationSupplierSync,[]);
 await f.engine.close();const restored=f.create();assert.equal(restored.catalog().find(product=>product.id===saved.product.id).origin.setId,SET);assert.equal(readLocalPreparedPhotos(restored,plan.id).summary.ready,true);assert.equal(restored.db.localProducts[0].origin.baseURL,BASE);
});

test('supplier import snapshots live stock and saved listing prices rather than treating catalog cost or later sync as listing data',async t=>{
 const f=fixture(t);f.engine.db.productListings=[];f.remote.product.stock='unknown';const result=await f.service.importSupplierPhotos(f.engine,f.input);assert.equal(result.product.stock,null);assert.deepEqual(result.product.listing,normalizeListing());assert.equal(result.product.listingPriceCents,null);assert.equal(result.product.minOfferCents,null);
 const saved=f.save(result,{stock:2,listing,listingPriceCents:700,minOfferCents:500});f.engine.db.products[0].stock=99;f.engine.db.products[0].name='Later supplier sync';f.engine.db.products[0].priceCents=1;f.engine.persist();const local=f.engine.catalog().find(row=>row.id===saved.product.id);assert.equal(local.stock,2);assert.equal(local.name,result.product.name);assert.equal(local.priceCents,700);assert.equal(local.source,'local');assert.equal(local.origin.sku,SKU);
});

test('status and claimedByMe are not ownership shortcuts or exclusion rules for explicitly requested readable originals',async t=>{
 for(const status of ['claimed','used','available','occupied'])await t.test(status,async sub=>{const f=fixture(sub);f.remote.set.status=status;f.remote.set.claimedByMe=false;const result=await f.service.importSupplierPhotos(f.engine,f.input);assert.equal(result.source.status,status);assert.equal(result.count,1);assert.equal(f.engine.db.claims.length,1);assert.ok(f.calls.every(row=>row.method==='GET'));});
});

test('missing or forbidden original access fails explicitly without claiming, adopting a token or changing old records',async t=>{
 for(const status of [401,403])for(const phase of ['me','set','image'])await t.test(status+' '+phase,async sub=>{
  const f=fixture(sub),route=phase==='me'?'/api/v1/me':phase==='set'?'/api/v1/photos/sets/'+SET:'/api/v1/photos/images/img-1',before=clone(f.engine.db),disk=fs.readFileSync(f.engine.file,'utf8');f.overrides.set(route,()=>json({error:'fixture access denied'},status));
  await assert.rejects(f.service.importSupplierPhotos(f.engine,f.input),{code:'SUPPLIER_PHOTO_FORBIDDEN'});assert.deepEqual(f.engine.db,before);assert.equal(fs.readFileSync(f.engine.file,'utf8'),disk);assert.ok(f.calls.every(row=>row.method==='GET'));
 });
 const f=fixture(t),before=clone(f.engine.db);delete f.remote.set.images;f.remote.set.thumbnailUrl=IMAGE;await assert.rejects(f.service.importSupplierPhotos(f.engine,f.input),{code:'SUPPLIER_PHOTO_SOURCE'});assert.deepEqual(f.engine.db,before);assert.equal(f.calls.some(row=>row.route.includes('/photos/images/')),false);
});

test('only exact returned same-origin originals are read; thumbnails, forged paths, aliases and duplicate image identities are rejected before download',async t=>{
 const scenarios=[
  ['external',set=>{set.images[0].url='https://elsewhere.example/api/v1/photos/images/img-1';}],
  ['protocol relative',set=>{set.images[0].url='//supplier.example.test/api/v1/photos/images/img-1';}],
  ['thumbnail',set=>{set.images[0].url=BASE+'/photos/thumbnails/img-1';}],
  ['only thumbnail field',set=>{set.images=[{id:'img-1',thumbnailUrl:IMAGE}];}],
  ['preview suffix',set=>{set.images[0].url=IMAGE+'/preview';}],
  ['query variant',set=>{set.images[0].url=IMAGE+'?width=200';}],
  ['fragment',set=>{set.images[0].url=IMAGE+'#preview';}],
  ['encoded separator',set=>{set.images[0].url=BASE+'/photos/images/img%2f1';}],
  ['traversal',set=>{set.images[0].url=BASE+'/photos/images/../img-1';}],
  ['different id',set=>{set.images[0].id='not-img-1';}],
  ['duplicate',set=>{set.images.push(clone(set.images[0]));set.imageCount=2;}],
  ['inconsistent count',set=>{set.image_count=2;}],
  ['empty',set=>{set.images=[];set.imageCount=0;}],
  ['over twenty',set=>{set.images=Array.from({length:21},(_,index)=>({id:'img-'+index,url:BASE+'/photos/images/img-'+index}));set.imageCount=21;}]
 ];
 for(const [name,mutate] of scenarios)await t.test(name,async sub=>{const f=fixture(sub),before=clone(f.engine.db);mutate(f.remote.set);await assert.rejects(f.service.importSupplierPhotos(f.engine,f.input));assert.deepEqual(f.engine.db,before);assert.equal(f.calls.some(row=>row.route.includes('/photos/images/')),false);});
});

test('account, product SKU, set and cached source bindings must remain exact throughout the read',async t=>{
 const scenarios=[
  ['other account',f=>{f.remote.accountId='other-account';}],
  ['remote SKU changed',f=>{f.remote.product.sku='other SKU';}],
  ['remote product changed',f=>{f.remote.product.id='other-product';}],
  ['set changed',f=>{f.remote.set.id='other-set';}],
  ['set product changed',f=>{f.remote.set.productId='other-product';}],
  ['conflicting product aliases',f=>{f.remote.set.product_id='other-product';}],
  ['saved template mismatch',f=>{f.engine.db.productListings[0].sku='old SKU';}],
  ['SKU changed during download',f=>{f.overrides.set('/api/v1/photos/images/img-1',()=>{f.engine.db.products[0].sku='changed SKU';return new Response(jpeg());});}]
 ];
 for(const [name,mutate] of scenarios)await t.test(name,async sub=>{const f=fixture(sub);mutate(f);const originalLocal=clone(f.engine.db.localProducts);await assert.rejects(f.service.importSupplierPhotos(f.engine,f.input));assert.deepEqual(f.engine.db.localProducts,originalLocal);assert.equal(f.engine.db.claims.length,1);assert.equal(f.engine.db.photoPreparations.length,0);});
});

test('renderer URL/path/source injection and fake provenance cannot create supplier import tokens or local ownership',async t=>{
 const f=fixture(t),before=clone(f.engine.db);for(const input of [{...f.input,url:IMAGE},{...f.input,paths:['C:/fake.jpg']},{...f.input,origin:{}},{...f.input,claimedByMe:true},{productId:PRODUCT},{...f.input,setId:'../me'}])await assert.rejects(f.service.importSupplierPhotos(f.engine,input));assert.deepEqual(f.calls,[]);assert.deepEqual(f.engine.db,before);
 const result=await f.service.importSupplierPhotos(f.engine,f.input);assert.throws(()=>f.save(result,{origin:{kind:'supplier-reuse'}}));const existing=f.service.saveManualProduct(f.engine,{name:'Existing local product',stock:1,listing,listingPriceCents:500,minOfferCents:400});assert.throws(()=>f.save(result,{id:existing.product.id}),/照片选择已过期/);assert.equal(f.save(result).product.origin.setId,SET);
});

test('cancellation during an authorized download rejects late data and never creates a product or a claim',async t=>{
 const f=fixture(t),before=clone(f.engine.db);let release,started;const arrived=new Promise(resolve=>started=resolve);f.overrides.set('/api/v1/photos/images/img-1',()=>{started();return new Promise(resolve=>release=resolve);});
 const pending=f.service.importSupplierPhotos(f.engine,f.input);await arrived;f.engine.configController.abort();await assert.rejects(pending,{code:'STOPPED'});release(new Response(jpeg()));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.engine.db,before);assert.equal(f.engine.configPending,0);assert.equal(f.engine.db.localProducts.length,0);assert.equal(f.engine.db.claims.length,1);
});

test('invalid downloaded or normalized content never yields an adoptable import token',async t=>{
 for(const kind of ['invalid image','empty','too large','decoder dimensions'])await t.test(kind,async sub=>{const f=fixture(sub),before=clone(f.engine.db);if(kind==='invalid image')f.overrides.set('/api/v1/photos/images/img-1',()=>new Response('not image'));if(kind==='empty')f.overrides.set('/api/v1/photos/images/img-1',()=>new Response(Buffer.alloc(0)));if(kind==='too large')f.overrides.set('/api/v1/photos/images/img-1',()=>new Response(Buffer.alloc(20*1024*1024+1)));if(kind==='decoder dimensions')f.setNormalize(bytes=>({bytes,width:999,height:999}));await assert.rejects(f.service.importSupplierPhotos(f.engine,f.input));assert.deepEqual(f.engine.db,before);});
});

test('provenance persists independently from supplier sync and cannot be altered by metadata saves or malformed restored rows',async t=>{
 const f=fixture(t),result=await f.service.importSupplierPhotos(f.engine,f.input),saved=f.save(result),origin=clone(f.engine.db.localProducts[0].origin);f.service.saveManualProduct(f.engine,{id:saved.product.id,name:'Changed local title',stock:1,listing,listingPriceCents:600,minOfferCents:400});assert.deepEqual(f.engine.db.localProducts[0].origin,origin);await f.engine.close();const original=JSON.parse(fs.readFileSync(f.engine.file,'utf8'));
 for(const mutate of [row=>{row.origin.kind='supplier';},row=>{row.origin.baseURL='https://user:secret@supplier.example.test/api/v1';},row=>{row.origin.claimId='someone-elses-claim';},row=>{delete row.origin.setId;},row=>{row.origin.importedAt='bad';},row=>{row.origin.status='used\nsecret';},row=>{row.photos=[];row.photoSetId=null;}]){const changed=clone(original);mutate(changed.localProducts[0]);const text=JSON.stringify(changed);fs.writeFileSync(f.engine.file,text);assert.throws(()=>f.create());assert.equal(fs.readFileSync(f.engine.file,'utf8'),text);}
 fs.writeFileSync(f.engine.file,JSON.stringify(original));const restored=f.create();assert.deepEqual(restored.db.localProducts[0].origin,origin);
});

test('replacing an unused imported copy through the native picker removes stale supplier provenance',async t=>{
 const f=fixture(t),result=await f.service.importSupplierPhotos(f.engine,f.input),saved=f.save(result),file=path.join(f.dir,'new-native.jpg');fs.writeFileSync(file,jpeg(1));f.setSelected([file]);const imported=await f.service.importPhotos(f.engine,{productId:saved.product.id});const replaced=f.service.saveManualProduct(f.engine,{id:saved.product.id,name:'Native replacement',stock:1,listing,listingPriceCents:500,minOfferCents:400,photoToken:imported.photoToken});assert.equal(Object.hasOwn(replaced.product,'origin'),false);assert.equal(Object.hasOwn(f.engine.db.localProducts[0],'origin'),false);assert.equal(f.engine.db.localProducts[0].photos[0].sha256,sha(jpeg(1)));
});
