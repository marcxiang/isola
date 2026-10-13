'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {nativeImage}=require('electron');
const {CommerceEngine}=require('../src/commerce-engine.cjs');
const {createPhotoService}=require('../src/commerce-photo-service.cjs');
module.exports=async function photoServiceSmoke(_api,check){
 assert.ok(process.env.ISOLA_TEST_DATA,'Photo service tests require isolated data');
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(process.env.ISOLA_TEST_DATA,'photo-service-')));
 const jpeg=nativeImage.createFromBitmap(Buffer.from([0x20,0x40,0x90,0xff]),{width:1,height:1}).toJPEG(85);
 const product={id:'fixture-product',sku:'FIXTURE',name:'Fixture',stock:2,priceCents:500},set={id:'fixture-set',product_id:product.id,status:'available',image_count:1};
 let claims=0,uploads=0,focused=null,lastRecheckOnly=null;
 const client={me:async()=>({user:{id:'fixture-supplier'}}),product:async()=>({product}),photoSets:async()=>({sets:[set]}),photoSet:async()=>({set}),claimPhotos:async()=>{claims++;return {claimId:'fixture-claim',set:{...set,images:[{id:'fixture-image',url:'/api/v1/photos/images/fixture-image'}]}};},download:async()=>jpeg};
 const adapter={readiness:()=>({vinted:'unverified',capabilities:{publish:false}}),inspectPhotoControls:async()=>({canUpload:false,canCheck:false}),uploadPhotos:async(profileId,manifest,{recheckOnly})=>{lastRecheckOnly=recheckOnly;assert.equal(profileId,'fixture-profile');assert.equal(manifest.claimId,'fixture-claim');assert.ok(Object.isFrozen(manifest));uploads++;return {claimId:manifest.claimId,count:1,verified:true,uncertain:false,canCheck:true,privatePath:manifest.files[0].path,receipt:{thumbnailCount:1,serverStoredCount:1,errorCount:0,busy:false,documentKey:'fixture-document',privatePath:manifest.files[0].path}};}};
 const engine=new CommerceEngine({dir,profiles:()=>[{id:'fixture-profile'}],clientFactory:()=>client,adapter,seal:s=>s,unseal:s=>s});
 engine.db.encryptedToken='fixture-token';engine.db.supplierAccountId='fixture-supplier';engine.db.products=[product];engine.persist();
 const plan=engine.savePlan({profileId:'fixture-profile',productId:product.id,targetCount:1,listingPriceCents:500,minOfferCents:200,enabled:false});
 const service=createPhotoService({nativeImage,focusProfile:id=>focused=id});
 try{
  await check('photo service rejects renderer objects and requires prepared files before preview/upload',async()=>{
   await assert.rejects(service.prepare(engine,{path:'/private/file.jpg'}));await assert.rejects(service.preview(engine,plan.id));await assert.rejects(service.upload(engine,plan.id));assert.equal(claims,0);assert.equal(uploads,0);
  });
  await check('photo service uses native JPEG decoding and sends only summaries across its preparation boundary',async()=>{
   const result=await service.prepare(engine,plan.id);assert.equal(result.summary.ready,true);assert.equal(result.summary.count,1);assert.deepEqual(Object.keys(result),['summary']);assert.equal(JSON.stringify(result).includes(dir),false);assert.equal(claims,1);
   await service.prepare(engine,plan.id);assert.equal(claims,1);return {jpegDecoded:true,claims:1};
  });
  await check('photo service previews are decoded JPEG data with no private file paths or supplier URLs',async()=>{
   const result=await service.preview(engine,plan.id);assert.equal(result.images.length,1);assert.match(result.images[0].dataURL,/^data:image\/jpeg;base64,/);assert.equal(result.images[0].width,1);assert.equal(result.images[0].height,1);assert.equal(JSON.stringify(result).includes(dir),false);assert.equal(JSON.stringify(result).includes('sku.meetist'),false);
  });
  await check('photo service locks configuration and sanitizes trusted-adapter upload receipts',async()=>{
   engine.running=true;await assert.rejects(service.upload(engine,plan.id));engine.running=false;assert.equal(uploads,0);
   engine.faulted=true;await assert.rejects(service.upload(engine,plan.id));engine.faulted=false;assert.equal(uploads,0);
   const result=await service.upload(engine,plan.id);assert.equal(result.verified,true);assert.equal(focused,'fixture-profile');assert.equal(lastRecheckOnly,false);assert.equal(JSON.stringify(result).includes('privatePath'),false);assert.equal(JSON.stringify(result).includes(dir),false);
  });
  await check('photo service forwards read-only recheck intent and rejects invalid modes',async()=>{
   await assert.rejects(service.upload(engine,plan.id,{recheckOnly:'yes'}));assert.equal(uploads,1);
   await service.upload(engine,plan.id,{recheckOnly:true});assert.equal(lastRecheckOnly,true);assert.equal(uploads,2);
  });
  await check('photo service preserves an interrupted dispatched upload as uncertain across IPC',async()=>{
   const original=adapter.uploadPhotos;adapter.uploadPhotos=async()=>{throw Object.assign(Error('fixture navigation'),{ambiguous:true,uploadMayHaveStarted:true,claimId:'fixture-claim'});};
   try{const result=await service.upload(engine,plan.id);assert.equal(result.uncertain,true);assert.equal(result.verified,false);assert.equal(result.canCheck,true);assert.equal(result.receipt,null);}finally{adapter.uploadPhotos=original;}
  });
  await check('photo service refuses modified prepared files before both preview and upload',async()=>{
   const row=engine.db.photoPreparations[0],file=path.join(dir,'prepared-photos',row.id,row.assets[0].fileName);fs.writeFileSync(file,Buffer.from('changed'));await assert.rejects(service.preview(engine,plan.id));await assert.rejects(service.upload(engine,plan.id));assert.equal(uploads,2);
  });
 }finally{await engine.close();fs.rmSync(dir,{recursive:true,force:true});}
};
