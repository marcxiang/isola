'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const {createLocalProductService}=require('../src/commerce-local-products.cjs');
const {preparePhotos,jpegSize,readPreparedPhotos}=require('../src/commerce-photos.cjs');
const {preflight,prepareDraft}=require('../src/commerce-preflight.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const listing={title:'Confirmed local title',description:'Confirmed local description.',categoryPath:['Maison','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
const page={url:'https://www.vinted.fr/items/new',title:'Fixture new listing',fields:[{label:'Titre',value:''}],accountLabel:'Synthetic local account'};
function jpeg(){return Buffer.from([255,216,255,192,0,17,8,0,20,0,10,3,1,17,0,2,17,1,3,17,1,255,218,0,12,3,1,0,2,17,3,17,0,63,0,0,255,217]);}
async function fixture(t,{stock=1,details=listing,photos=false,inspect=async()=>({...page})}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-local-preflight-')),calls=[],prepared=[];
 const platform={readiness:()=>({capabilities:{}}),inspect:async(...args)=>{calls.push('page');return inspect(...args);},prepareFields:async(profileId,value,{signal})=>{prepared.push({profileId,listing:value,signal});return {filled:[{field:'title'}],missing:[],unresolved:[],draftComplete:false,published:false,saved:false};}};
 const engine=new CommerceEngine({dir,profiles:()=>[{id:'profile-1',name:'Synthetic account'}],clientFactory:()=>{calls.push('supplier');throw Error('Local preflight cannot create a supplier client');},adapter:platform,seal:value=>value,unseal:value=>value});
 engine.db.products=[{id:'untouched-supplier',sku:'SUPPLIER',name:'Supplier cache',stock:9}];engine.db.photoSets=[{id:'untouched-set',productId:'untouched-supplier'}];
 const selected=path.join(dir,'chosen.jpg');fs.writeFileSync(selected,jpeg());const service=createLocalProductService({selectFiles:async()=>[selected],normalizeImage:async bytes=>({bytes,...jpegSize(bytes)})});
 const selection=photos?await service.importPhotos(engine,{}):null;
 const saved=service.saveManualProduct(engine,{name:'Local metadata name is not a listing title',stock,listing:details,listingPriceCents:700,minOfferCents:500,...(selection?{photoToken:selection.photoToken}:{})}),plan=engine.savePlan({profileId:'profile-1',productId:saved.product.id,sku:saved.product.sku,targetCount:1,listingPriceCents:700,minOfferCents:500,listing:details});
 t.after(async()=>{await engine.close();const absolute=path.resolve(dir);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep+'isola-local-preflight-'));fs.rmSync(absolute,{recursive:true,force:true});});
 return {engine,plan,dir,calls,prepared,platform};
}

test('local preflight reads saved catalog and current page without a token, supplier client or cache rewrite',async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.engine.file,'utf8'),report=await preflight(f.engine,f.plan.id);assert.equal(report.product.source,'local');assert.equal(report.product.stock,1);assert.deepEqual(report.listing,{...listing,size:'',priceCents:700});assert.deepEqual(report.photos,{source:'local',availableCount:0,ownCount:0,totalCount:0,importedCount:0,ready:false});assert.equal(report.checks.find(row=>row.name==='本地照片').ok,false);assert.equal(report.page.accountLabel,page.accountLabel);assert.deepEqual(report.page.fields,page.fields);assert.deepEqual(report.supplierFields,[]);assert.deepEqual(report.supplierFacts,{});assert.deepEqual(f.calls,['page']);assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.equal(f.engine.db.claims.length,0);assert.equal(f.engine.db.jobs.length,0);
});

test('imported local images are not misreported as a prepared claim or supplier photo set',async t=>{
 const f=await fixture(t,{photos:true}),report=await preflight(f.engine,f.plan.id);assert.equal(report.photos.importedCount,1);assert.equal(report.photos.ready,false);assert.equal(report.photos.availableCount,0);assert.equal(report.photos.ownCount,0);assert.match(report.checks.find(row=>row.name==='本地照片').detail,/已导入 1 张.*先准备/);assert.equal(JSON.stringify(report).includes(f.dir),false);assert.deepEqual(f.engine.db.localPhotoPreparations,[]);assert.deepEqual(f.engine.db.claims,[]);assert.deepEqual(f.engine.db.photoSets,[{id:'untouched-set',productId:'untouched-supplier'}]);assert.deepEqual(f.calls,['page']);
});

test('prepared local photographs count only the original profile claim after hash validation',async t=>{
 const f=await fixture(t,{photos:true});await preparePhotos(f.engine,f.plan.id,{validateImage:jpegSize});const before=clone(f.engine.db),report=await preflight(f.engine,f.plan.id);assert.equal(report.photos.ready,true);assert.equal(report.photos.ownCount,1);assert.equal(report.checks.find(row=>row.name==='本地照片').ok,true);assert.match(report.checks.find(row=>row.name==='本地照片').detail,/已核对 1 张本地照片/);assert.deepEqual(f.engine.db,before);assert.deepEqual(f.calls,['page']);
 f.plan.reuseOwnPhotos=false;f.engine.db.claims[0].listings.push({listingId:'123'});const blocked=await preflight(f.engine,f.plan.id);assert.equal(blocked.photos.ready,false);assert.equal(blocked.photos.ownCount,0);assert.match(blocked.checks.find(row=>row.name==='本地照片').detail,/禁止复用/);
});

test('missing or altered prepared local files remain an explicit failed photo check',async t=>{
 const f=await fixture(t,{photos:true});await preparePhotos(f.engine,f.plan.id,{validateImage:jpegSize});const file=readPreparedPhotos(f.engine,f.plan.id).manifest.files[0].path;fs.writeFileSync(file,Buffer.from('changed private fixture'));const report=await preflight(f.engine,f.plan.id);assert.equal(report.photos.ready,false);assert.match(report.checks.find(row=>row.name==='本地照片').detail,/文件缺失或校验失败/);assert.equal(f.engine.db.claims.length,1);assert.equal(f.engine.db.localPhotoPreparations.length,1);assert.deepEqual(f.calls,['page']);
});

test('local field preparation uses only the original plan values and never submits or acquires photos',async t=>{
 const f=await fixture(t),result=await prepareDraft(f.engine,f.plan.id);assert.equal(f.prepared.length,1);assert.deepEqual(f.prepared[0].listing,{...listing,size:'',priceCents:700});assert.ok(f.prepared[0].signal instanceof AbortSignal);assert.equal(result.published,false);assert.equal(result.saved,false);assert.equal(result.draftComplete,false);assert.deepEqual(f.engine.db.claims,[]);assert.deepEqual(f.engine.db.localPhotoPreparations,[]);assert.deepEqual(f.engine.db.jobs,[]);assert.deepEqual(f.calls,['page']);
});

test('zero stock, missing explicit description and the wrong page block local field input',async t=>{
 for(const options of [{stock:0},{details:{...listing,description:''}},{details:{...listing,title:''}},{inspect:async()=>({...page,url:'https://www.vinted.fr/inbox'})}]){const f=await fixture(t,options),result=await prepareDraft(f.engine,f.plan.id);assert.equal(result.preflight.readyForFields,false);assert.deepEqual(f.prepared,[]);assert.equal(result.published,false);assert.equal(result.saved,false);assert.deepEqual(f.calls,['page']);if(options.details&&!options.details.title)assert.equal(result.preflight.listing.title,'');}
});

test('a changed local SKU or prepared-profile binding stops before page inspection',async t=>{
 const f=await fixture(t,{photos:true});f.plan.sku='CHANGED';await assert.rejects(preflight(f.engine,f.plan.id),{code:'LOCAL_PRODUCT_MISMATCH'});assert.deepEqual(f.calls,[]);f.plan.sku=f.engine.db.localProducts[0].sku;await preparePhotos(f.engine,f.plan.id,{validateImage:jpegSize});f.engine.db.localPhotoPreparations[0].profileId='different-profile';await assert.rejects(preflight(f.engine,f.plan.id));assert.deepEqual(f.calls,[]);
});

test('cancellation during a local page read discards the late result and performs no field input',async t=>{
 let entered,release;const started=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;}),f=await fixture(t,{inspect:async()=>{entered();await blocked;return page;}}),before=fs.readFileSync(f.engine.file,'utf8');const pending=prepareDraft(f.engine,f.plan.id);await started;f.engine.configController.abort();release();await assert.rejects(pending,{code:'STOPPED'});assert.equal(fs.readFileSync(f.engine.file,'utf8'),before);assert.deepEqual(f.prepared,[]);assert.deepEqual(f.engine.db.claims,[]);assert.deepEqual(f.calls,['page']);
});
