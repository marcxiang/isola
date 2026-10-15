'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {CommerceEngine,normalizeProduct}=require('../src/commerce-engine.cjs');
const {normalizeListing,missingListingFields}=require('../src/listing-config.cjs');
const required=['title','description','condition','brand','color','parcel','categoryPath'];
const listing={title:'Local accessory',description:'Confirmed local fixture description.',condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen',categoryPath:['Maison','Accessoires']};
const product={id:'product-1',sku:'LOCAL-SKU-1',name:'Local accessory',stock:3};
const planInput={profileId:'profile-1',productId:product.id,targetCount:1,listingPriceCents:500,minOfferCents:400,listing,enabled:false};
const clone=value=>JSON.parse(JSON.stringify(value));

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-product-listing-')),instances=[],calls=[];
 const client={me:async()=>({user:{id:'supplier-1'}}),products:async()=>({products:[product],total:1}),photoSets:async()=>({sets:[],total:0})};
 const options={dir,profiles:()=>[{id:'profile-1',name:'Local account'}],clientFactory:()=>client,adapter:{readiness:()=>({capabilities:{}})},seal:value=>'fixture:'+value,unseal:value=>value.slice(8)};
 const create=()=>{const engine=new CommerceEngine({...options,onChange:state=>calls.push(state)});instances.push(engine);return engine;};
 const engine=create();engine.db.products=[normalizeProduct(product)];engine.db.encryptedToken=options.seal('initial');engine.db.supplierAccountId='supplier-1';engine.persist();
 t.after(async()=>{for(const instance of instances){instance.active.clear();await instance.close();}const absolute=path.resolve(dir),prefix=path.resolve(os.tmpdir())+path.sep+'isola-product-listing-';assert.ok(absolute.startsWith(prefix));fs.rmSync(absolute,{recursive:true,force:true});});
 return {dir,engine,client,options,create,calls};
}

test('shared missing fields retain exactly the existing seven runtime requirements',()=>{
 assert.deepEqual(missingListingFields(),required);assert.deepEqual(missingListingFields(null),required);assert.deepEqual(missingListingFields([]),required);assert.deepEqual(missingListingFields(listing),[]);
 for(const key of required){const incomplete={...listing,[key]:key==='categoryPath'?[]:'  '};assert.deepEqual(missingListingFields(incomplete),[key]);}
 assert.deepEqual(missingListingFields({...listing,size:''}),[]);assert.deepEqual(missingListingFields({...listing,categoryPath:'Maison'}),['categoryPath']);
});

test('legacy databases gain an empty product-listing collection without changing an original plan or task',async t=>{
 const f=fixture(t),plan=f.engine.savePlan(planInput);f.engine.enqueue('listing',plan,{cycle:0,listingRevision:1},'original-revision-1');const original=f.engine.db.jobs[0];original.state='needs_review';original.step='check_catalog';original.error='Original local review';const planBefore=clone(plan),jobBefore=clone(original);
 await f.engine.close();const data=JSON.parse(fs.readFileSync(f.engine.file,'utf8'));delete data.productListings;fs.writeFileSync(f.engine.file,JSON.stringify(data));
 const restored=f.create();assert.deepEqual(restored.db.productListings,[]);assert.deepEqual(restored.db.plans,[planBefore]);assert.deepEqual(restored.db.jobs,[jobBefore]);assert.deepEqual(JSON.parse(fs.readFileSync(restored.file,'utf8')).productListings,[]);
});

test('product drafts normalize known fields, retain nullable prices and survive restart without aliasing',async t=>{
 const f=fixture(t),input={productId:product.id,listing:{title:'  Local draft  ',description:'First\r\nSecond',categoryPath:' Maison / Accessoires ',token:'not-persisted'}};
 const saved=f.engine.saveProductListing(input);assert.equal(saved.productId,product.id);assert.equal(saved.sku,product.sku);assert.equal(saved.listing.title,'Local draft');assert.equal(saved.listing.description,'First\nSecond');assert.deepEqual(saved.listing.categoryPath,['Maison','Accessoires']);assert.equal(saved.listingPriceCents,null);assert.equal(saved.minOfferCents,null);assert.deepEqual(saved.missingFields,['condition','brand','color','parcel']);
 input.listing.title='Changed caller';saved.listing.categoryPath.push('Changed result');saved.missingFields.length=0;assert.equal(f.engine.db.productListings[0].listing.title,'Local draft');assert.deepEqual(f.engine.db.productListings[0].listing.categoryPath,['Maison','Accessoires']);assert.equal(JSON.stringify(f.engine.db.productListings).includes('not-persisted'),false);
 await f.engine.close();const restored=f.create();assert.deepEqual(restored.db.productListings,f.engine.db.productListings);
});

test('saving a complete template replaces only its own product row and preserves creation time',t=>{
 const {engine}=fixture(t),first=engine.saveProductListing({productId:product.id,listing:{title:'Draft'}});engine.db.products.push(normalizeProduct({...product,id:'product-2',sku:'LOCAL-SKU-2'}));engine.saveProductListing({productId:'product-2',listing:{title:'Second draft'}});
 const saved=engine.saveProductListing({productId:product.id,listing,listingPriceCents:500,minOfferCents:400});assert.equal(engine.db.productListings.length,2);assert.equal(saved.createdAt,first.createdAt);assert.deepEqual(saved.missingFields,[]);assert.equal(engine.db.productListings[1].listing.title,'Second draft');
});

test('template saves require one current product and preserve a previously bound SKU',t=>{
 const {engine}=fixture(t);engine.saveProductListing({productId:product.id,listing});const before=clone(engine.db.productListings);
 for(const input of [null,[],{}, {productId:'missing',listing}, {productId:1,listing}])assert.throws(()=>engine.saveProductListing(input));
 assert.throws(()=>engine.saveProductListing({productId:product.id,sku:'STALE-EDITOR-SKU',listing}),{code:'PRODUCT_MISMATCH'});
 engine.db.products.push({...engine.db.products[0]});assert.throws(()=>engine.saveProductListing({productId:product.id,listing}));engine.db.products.pop();
 engine.db.products[0].sku='REPLACED-SKU';assert.throws(()=>engine.saveProductListing({productId:product.id,listing}),{code:'PRODUCT_MISMATCH'});assert.deepEqual(engine.db.productListings,before);
});

test('a plan rejects a stale copied SKU while legacy callers may omit the optional SKU',t=>{
 const {engine}=fixture(t),plan=engine.savePlan({...planInput,sku:product.sku}),before=clone(plan),file=fs.readFileSync(engine.file,'utf8');
 for(const sku of ['STALE-SKU','',null,42]){assert.throws(()=>engine.savePlan({...planInput,id:plan.id,sku}),{code:'PRODUCT_MISMATCH'});assert.deepEqual(engine.db.plans,[before]);assert.equal(fs.readFileSync(engine.file,'utf8'),file);}
 engine.db.products[0].sku='NEW-CATALOG-SKU';assert.throws(()=>engine.savePlan({...planInput,profileId:'missing',sku:product.sku}));assert.throws(()=>engine.savePlan({...planInput,id:plan.id,sku:product.sku}),{code:'PRODUCT_MISMATCH'});assert.deepEqual(engine.db.plans,[before]);assert.deepEqual(engine.db.jobs,[]);
 engine.db.products[0].sku=product.sku;assert.equal(engine.savePlan({...planInput,id:plan.id}).sku,product.sku);
});

test('draft prices accept empty values but reject coercion, zero, fractions and an invalid minimum',t=>{
 const {engine}=fixture(t);for(const blank of [undefined,null,'']){const saved=engine.saveProductListing({productId:product.id,listing,listingPriceCents:blank,minOfferCents:blank});assert.equal(saved.listingPriceCents,null);assert.equal(saved.minOfferCents,null);}
 const before=clone(engine.db.productListings);
 for(const invalid of [0,-1,1.5,'500',false,{},Infinity,NaN,100000001]){assert.throws(()=>engine.saveProductListing({productId:product.id,listing,listingPriceCents:invalid}));assert.throws(()=>engine.saveProductListing({productId:product.id,listing,listingPriceCents:500,minOfferCents:invalid}));}
 for(const change of [{minOfferCents:400},{listingPriceCents:500,minOfferCents:501}])assert.throws(()=>engine.saveProductListing({productId:product.id,listing,...change}));
 assert.deepEqual(engine.db.productListings,before);assert.equal(engine.saveProductListing({productId:product.id,listing,listingPriceCents:500}).minOfferCents,null);
});

test('invalid listing edits do not replace the saved template or its file',t=>{
 const {engine}=fixture(t);engine.saveProductListing({productId:product.id,listing});const before=fs.readFileSync(engine.file,'utf8'),rows=clone(engine.db.productListings);
 for(const invalid of [[],{title:'A\nB'},{categoryPath:['Maison',' ']},{description:42}])assert.throws(()=>engine.saveProductListing({productId:product.id,listing:invalid}));
 assert.deepEqual(engine.db.productListings,rows);assert.equal(fs.readFileSync(engine.file,'utf8'),before);
});

test('corrupt or duplicate stored templates fail closed without rewriting the original database',async t=>{
 const f=fixture(t);f.engine.saveProductListing({productId:product.id,listing,listingPriceCents:500,minOfferCents:400});await f.engine.close();const data=JSON.parse(fs.readFileSync(f.engine.file,'utf8')),row=data.productListings[0];
 const variants=[null,{},[null],[row,row],[{...row,productId:''}],[{...row,sku:' WRONG '}],[{...row,unexpected:true}],[{...row,listing:undefined}],[{...row,listing:{...row.listing,extra:'unknown'}}],[{...row,listing:{...row.listing,title:' padded '}}],[{...row,listing:{...row.listing,categoryPath:'Maison'}}],[{...row,listingPriceCents:'500'}],[{...row,listingPriceCents:0}],[{...row,minOfferCents:501}],[{...row,createdAt:'invalid'}],[{...row,updatedAt:'2000-01-01T00:00:00.000Z'}]];
 for(const productListings of variants){const source=JSON.stringify({...data,productListings});fs.writeFileSync(f.engine.file,source);assert.throws(()=>f.create());assert.equal(fs.readFileSync(f.engine.file,'utf8'),source);}
});

test('templates and missing-field DTOs cannot mutate live plans or schedule work',t=>{
 const {engine}=fixture(t),plan=engine.savePlan(planInput),before=clone(plan);engine.running=true;engine.ticking=true;engine.active.set('unrelated',new AbortController());
 engine.saveProductListing({productId:product.id,listing:{title:'Future template'},listingPriceCents:700,minOfferCents:600});assert.deepEqual(engine.db.plans,[before]);assert.deepEqual(engine.db.jobs,[]);assert.deepEqual(engine.db.sales,[]);assert.deepEqual(engine.db.claims,[]);
 const state=engine.state();assert.deepEqual(state.plans[0].missingFields,[]);assert.deepEqual(state.productListings[0].missingFields,['description','condition','brand','color','parcel','categoryPath']);state.productListings[0].listing.title='Edited DTO';state.plans[0].listing.categoryPath.push('Edited DTO');state.plans[0].missingFields.push('title');
 assert.equal(engine.db.productListings[0].listing.title,'Future template');assert.deepEqual(engine.db.plans[0],before);assert.equal(Object.hasOwn(plan,'missingFields'),false);engine.running=false;engine.ticking=false;engine.active.clear();
});

test('ordinary synchronization keeps templates, including temporarily absent catalog products',async t=>{
 const f=fixture(t);f.engine.saveProductListing({productId:product.id,listing});const before=clone(f.engine.db.productListings);await f.engine.sync();assert.deepEqual(f.engine.db.productListings,before);
 f.client.products=async()=>({products:[],total:0});await f.engine.sync();assert.deepEqual(f.engine.db.productListings,before);assert.throws(()=>f.engine.saveProductListing({productId:product.id,listing}));
});

test('endpoint and no-history token resets clear templates with their old catalog',async t=>{
 for(const change of [{baseURL:'https://new-supplier.invalid/api/v1'}, {token:'new-fixture-token'}, {clearToken:true}]){const f=fixture(t);f.engine.saveProductListing({productId:product.id,listing});assert.equal(f.engine.hasHistory(),false);await f.engine.saveSettings(change);assert.deepEqual(f.engine.db.productListings,[]);assert.deepEqual(f.engine.db.products,[]);assert.equal(f.engine.db.supplierAccountId,null);}
});

test('same-token settings, same-account history rotation and rejected account changes preserve templates',async t=>{
 const f=fixture(t);f.engine.saveProductListing({productId:product.id,listing});const before=clone(f.engine.db.productListings);await f.engine.saveSettings({token:'initial'});assert.deepEqual(f.engine.db.productListings,before);
 f.engine.savePlan(planInput);await f.engine.saveSettings({token:'same-account-rotation'});assert.deepEqual(f.engine.db.productListings,before);await assert.rejects(f.engine.saveSettings({baseURL:'https://new-supplier.invalid/api/v1'}));assert.deepEqual(f.engine.db.productListings,before);
 f.client.me=async()=>({user:{id:'supplier-other'}});await assert.rejects(f.engine.connect(),/账号.*不匹配/);assert.deepEqual(f.engine.db.productListings,before);
});

test('a verified supplier account reset without history discards old templates',async t=>{
 const f=fixture(t);f.engine.saveProductListing({productId:product.id,listing});f.client.me=async()=>({user:{id:'supplier-other'}});await f.engine.connect();assert.equal(f.engine.db.supplierAccountId,'supplier-other');assert.deepEqual(f.engine.db.productListings,[]);assert.deepEqual(f.engine.db.products,[]);
});

test('closing, configuration work and faulted storage block template saves without changing rows',t=>{
 const {engine}=fixture(t);engine.saveProductListing({productId:product.id,listing});const before=clone(engine.db.productListings);
 for(const flag of ['closing','configPending','faulted']){engine[flag]=flag==='configPending'?1:true;assert.throws(()=>engine.saveProductListing({productId:product.id,listing:{title:'Blocked'}}));engine[flag]=flag==='configPending'?0:false;assert.deepEqual(engine.db.productListings,before);}
});

test('a failed template snapshot retains the complete original rows and file for recovery',t=>{
 const {engine}=fixture(t);engine.saveProductListing({productId:product.id,listing});const rows=clone(engine.db.productListings),file=fs.readFileSync(engine.file,'utf8'),persist=engine.persist;
 engine.persist=()=>{engine.faulted=true;throw Error('Local fixture disk failure');};
 try{assert.throws(()=>engine.saveProductListing({productId:product.id,listing:{title:'Unsaved replacement'}}),/disk failure/);assert.deepEqual(engine.db.productListings,rows);assert.equal(fs.readFileSync(engine.file,'utf8'),file);assert.equal(engine.faulted,true);}finally{engine.persist=persist;}
});

test('the desktop preload invokes the dedicated product-template channel without broadening its API',async()=>{
 let exposed;const calls=[];vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/commerce-preload.cjs'),'utf8'),{require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'commerce');exposed=value;}},ipcRenderer:{invoke:async(...args)=>{calls.push(args);return {saved:true};}}};}});
 const input={productId:product.id,listing};assert.deepEqual(await exposed.saveProductListing(input),{saved:true});assert.deepEqual(calls,[['commerce-product-listing-save',input]]);
});
