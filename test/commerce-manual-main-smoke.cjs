'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const clone=value=>JSON.parse(JSON.stringify(value));
const FORM_URL='https://www.vinted.fr/items/new';
const listing={title:'Mon accessoire local',description:'Article personnel utilise uniquement dans cette fixture locale.',categoryPath:['Maison','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',size:'',color:'Noir',parcel:'Moyen'};

// This module exercises the real commerce IPC and native JPEG conversion. Its
// picker returns a generated temporary file; its HTTPS session serves only a
// static local form. It never starts a scheduler or exposes a submit control.
module.exports=async function commerceManualMainSmoke(api,check){
 const {dialog,nativeImage}=require('electron');
 assert.ok(process.env.ISOLA_TEST_DATA,'Manual product IPC smoke requires isolated test data');assert.equal(path.resolve(path.dirname(api.dataFile())),path.resolve(process.env.ISOLA_TEST_DATA));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-manual-main-fixture-')),sourceFile=path.join(dir,'my-own-generated-photo.jpg'),requests=[];
 const originalPicker=dialog.showOpenDialog;let engine,originalDB,originalConnection,originalClientFactory,profile,w,session,view,product,plan,photoSetId,pickerCalls=0,supplierCalls=0;
 const until=async predicate=>{const end=Date.now()+8000;while(!predicate()){if(Date.now()>end)throw Error('Manual product main fixture did not settle');await new Promise(resolve=>setTimeout(resolve,25));}};
 const invoke=(method,...args)=>view.webContents.executeJavaScript(`window.commerce[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
 const noExternalMutation=()=>{assert.equal(supplierCalls,0);assert.equal(engine.running,false);assert.equal(engine.ticking,false);assert.equal(engine.active.size,0);assert.deepEqual(engine.db.jobs,[]);assert.deepEqual(engine.db.publications.submissions,[]);assert.deepEqual(engine.db.publicationSupplierSync,[]);assert.equal(engine.db.encryptedToken,'');assert.equal(engine.db.supplierAccountId,null);assert.ok(requests.every(row=>row.method==='GET'&&row.url===FORM_URL));};
 try{
  engine=api.getCommerce();assert.equal(engine.running,false);assert.equal(engine.ticking,false);assert.equal(engine.active.size,0);originalDB=engine.db;originalConnection=engine.connection;originalClientFactory=engine.clientFactory;
  engine.db=clone(originalDB);for(const key of ['products','productListings','localProducts','localPhotoPreparations','photoSets','photoPreparations','plans','jobs','claims','sales','reservations','publicationSupplierSync'])engine.db[key]=[];engine.db.publications={version:1,submissions:[]};engine.db.encryptedToken='';engine.db.supplierAccountId=null;engine.connection={status:'not_connected'};engine.clientFactory=()=>{supplierCalls++;throw Error('Supplier access is forbidden for local product fixture');};engine.persist();engine.emit();
  const image=nativeImage.createFromBitmap(Buffer.alloc(16*12*4,255),{width:16,height:12});assert.equal(image.isEmpty(),false);fs.writeFileSync(sourceFile,image.toJPEG(90));
  dialog.showOpenDialog=async(owner,options)=>{pickerCalls++;assert.equal(owner,api.getManager());assert.ok(options.properties.includes('openFile'));assert.ok(options.properties.includes('multiSelections'));assert.ok(options.filters.some(filter=>filter.extensions.includes('jpg')));return {canceled:false,filePaths:[sourceFile]};};
  await api.openCommerce();view=api.getCommerceView();
  await check('manual product native import IPC rejects renderer paths and copies one generated image through the controlled picker',async()=>{
   await assert.rejects(invoke('importProductPhotos',{filePaths:[sourceFile]}),/只能由本机文件选择器/);assert.equal(pickerCalls,0);
   const imported=await invoke('importProductPhotos',{});assert.equal(pickerCalls,1);assert.equal(imported.count,1);assert.equal(typeof imported.photoToken,'string');assert.ok(imported.photoToken);assert.deepEqual(imported.photos.map(({index,width,height})=>({index,width,height})),[{index:0,width:16,height:12}]);assert.equal(JSON.stringify(imported).includes(dir),false);
   const saved=await invoke('saveManualProduct',{name:'My own generated local item',stock:1,listing,listingPriceCents:500,minOfferCents:400,photoToken:imported.photoToken});product=saved.product;assert.equal(product.source,'local');assert.equal(product.localPhotoCount,1);assert.match(product.id,/^local-/);assert.match(product.sku,/^LOCAL-/);assert.equal(/fileName|path|sha256/.test(JSON.stringify(saved)),false);photoSetId=engine.db.localProducts.find(row=>row.id===product.id).photoSetId;
   await assert.rejects(invoke('saveManualProduct',{name:'Repeated fixture import token',stock:1,listing,photoToken:imported.photoToken}),/过期|不属于/);assert.equal(engine.db.localProducts.length,1);noExternalMutation();return {realIPC:true,nativePickerCalls:1,nativeJPEGConversion:true,privateLocalCopy:true,supplierCalls:0,publicationAttempts:0};
  });
  await check('manual product plan IPC derives local ownership and saves without supplier credentials or starting work',async()=>{
   profile=api.saveProfile({name:'QA manual product native IPC',url:FORM_URL,fingerprintMode:'native'});session=api.sesFor(profile);
   session.protocol.handle('https',request=>{requests.push({method:request.method,url:request.url});if(request.method!=='GET'||request.url!==FORM_URL)return new Response('This fixture forwards no network traffic',{status:403});return new Response('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Local manual product form</title><main><h1>Local manual product fixture</h1><label>Titre<input aria-label="Titre" name="title"></label><label>Description<textarea aria-label="Description" name="description"></textarea></label><p>No upload or publication controls exist in this fixture.</p></main>',{headers:{'content-type':'text/html; charset=utf-8'}});});
   plan=await invoke('savePlan',{profileId:profile.id,productId:product.id,sku:product.sku,source:'supplier',listing,listingPriceCents:500,minOfferCents:400,targetCount:1,reuseOwnPhotos:true,enabled:true});assert.equal(plan.source,'local');assert.equal(plan.sku,product.sku);assert.deepEqual(plan.listing,listing);assert.equal(engine.db.plans.length,1);assert.equal(api.windows.has(profile.id),false);const state=await invoke('state');assert.equal(state.products.find(row=>row.id===product.id).source,'local');assert.equal(state.settings.hasToken,false);assert.deepEqual(state.runningPlanIds,[]);noExternalMutation();return {sourceFromSavedCatalog:true,localPlanSaved:true,supplierTokenRequired:false,schedulerStarted:false};
  });
  await check('manual local photos prepare and preview through real IPC while preflight reads only the intercepted local form',async()=>{
   await api.launch(profile.id);w=api.windows.get(profile.id);const prepared=await invoke('preparePhotos',plan.id);assert.equal(prepared.summary.source,'local');assert.equal(prepared.summary.ready,true);assert.equal(prepared.summary.count,1);assert.equal(prepared.summary.permanentClaim,false);
   const preview=await invoke('photoPreview',plan.id);assert.equal(preview.images.length,1);assert.equal(preview.images[0].width,16);assert.equal(preview.images[0].height,12);assert.match(preview.images[0].dataURL,/^data:image\/jpeg;base64,/);
   const report=await invoke('preflight',plan.id);assert.equal(report.product.id,product.id);assert.equal(report.product.source,'local');assert.equal(report.photos.source,'local');assert.equal(report.photos.ready,true);assert.equal(report.photos.importedCount,1);assert.equal(report.photos.availableCount,0);assert.equal(report.readyForFields,true);assert.equal(report.page.url,FORM_URL);assert.deepEqual(report.supplierFacts,{});assert.deepEqual(report.supplierFields,[]);assert.equal(engine.db.photoPreparations.length,0);assert.equal(engine.db.localPhotoPreparations.length,1);assert.equal(engine.db.claims[0].source,'local');
   const state=await invoke('state'),summary=state.photoPreparations.find(row=>row.planId===plan.id);assert.equal(summary.source,'local');assert.equal(summary.ready,true);assert.equal(/fileName|path|sha256/.test(JSON.stringify(summary)),false);noExternalMutation();return {realIPC:true,nativePreview:true,localPhotoCount:1,preflightReadsLocalSource:true,supplierCalls:0,publicationAttempts:0};
  });
 }finally{
  dialog.showOpenDialog=originalPicker;
  if(w&&!w.isDestroyed()){w.close();await until(()=>w.isDestroyed());}
  if(session)session.protocol.unhandle('https');
  if(engine&&originalDB){engine.db=originalDB;engine.connection=originalConnection;engine.clientFactory=originalClientFactory;engine.persist();engine.emit();}
  if(profile&&!api.windows.has(profile.id))await api.deleteProfile(profile.id);
  if(engine&&photoSetId){const root=path.resolve(engine.dir,'local-product-photos'),folder=path.resolve(root,photoSetId);assert.equal(path.dirname(folder),root);assert.match(path.basename(folder),/^local-set-[a-f0-9-]+$/);fs.rmSync(folder,{recursive:true,force:true});}
  const folder=path.resolve(dir);assert.equal(path.dirname(folder),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('isola-manual-main-fixture-'));fs.rmSync(folder,{recursive:true,force:true});
 }
};
