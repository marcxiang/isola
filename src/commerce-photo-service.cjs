'use strict';
const fs=require('node:fs'),{createHash}=require('node:crypto');
const photos=require('./commerce-photos.cjs');
const {createTrustedPhotoManifest}=require('./vinted-photo-upload.cjs');

// Renderer callers provide a plan ID only. File paths and the upload capability
// remain in the main process, bound to the persisted supplier claim.
function createPhotoService({nativeImage,focusProfile=()=>{}}){
 function decode(bytes){const image=nativeImage.createFromBuffer(bytes);if(image.isEmpty())throw Error('照片无法解码，未发送到网页');return image;}
 function planId(value){if(typeof value!=='string'||!value||value.length>256)throw Error('照片计划编号无效');return value;}
 function materialReceipt(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'verified')||typeof value.verified!=='boolean')return undefined;
  return Object.fromEntries(['verified','cleared','unchanged'].filter(key=>Object.hasOwn(value,key)&&typeof value[key]==='boolean').map(key=>[key,value[key]]));
 }
 async function prepared(engine,id){const result=await photos.readPreparedPhotos(engine,planId(id));if(!result.manifest||!result.summary?.ready)throw Error(result.summary?.error||'请先领取并下载本计划照片');return result;}
 return {
  inspect:(engine,id)=>engine.configure(async(signal,guard)=>{
   const plan=engine.plan(planId(id)),{summary}=await photos.readPreparedPhotos(engine,id);guard();
   const page=await engine.adapter.inspectPhotoControls(plan.profileId,{signal});guard();return {summary,page};
  }),
  prepare:async(engine,id)=>{
   const {summary}=await photos.preparePhotos(engine,planId(id),{validateImage:bytes=>decode(bytes).getSize()});return {summary};
  },
  preview:(engine,id)=>engine.configure(async(_signal,guard)=>{
   const {manifest}=await prepared(engine,id);guard();const images=[];let total=0;
   for(const file of manifest.files){
    const fd=fs.openSync(file.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
    try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size!==file.size||stat.size>5*1024*1024)throw Error('照片文件已改变，请重新检查');bytes=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
    if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('照片校验失败，请重新检查');
    const original=decode(bytes),size=original.getSize();if(size.width!==file.width||size.height!==file.height)throw Error('照片尺寸已改变，请重新检查');
    const image=original.resize(size.width>=size.height?{width:Math.min(640,size.width)}:{height:Math.min(640,size.height)}),jpeg=image.toJPEG(78);total+=jpeg.length;
    if(total>5*1024*1024)throw Error('照片预览过大，请减少图片数量');
    images.push({dataURL:'data:image/jpeg;base64,'+jpeg.toString('base64'),...image.getSize()});guard();
   }
   return {images};
  }),
  upload:(engine,id,{recheckOnly=false}={})=>engine.configure(async(signal,guard)=>{
   if(typeof recheckOnly!=='boolean')throw Error('照片核对模式无效');
   if(engine.faulted)throw Error('运营存储不可用，照片上传已停止');
   const plan=engine.plan(planId(id)),{manifest}=await prepared(engine,id);guard();
   const trusted=await createTrustedPhotoManifest(manifest);guard();await focusProfile(plan.profileId);guard();
   let result;
   try{result=await engine.adapter.uploadPhotos(plan.profileId,trusted,{signal,recheckOnly});guard();}
   catch(error){
    if(error?.ambiguous!==true||error?.uploadMayHaveStarted!==true||error?.claimId!==manifest.claimId)throw error;
    if(!engine.faulted){engine.event('warning',plan.sku+'：照片选择可能已发送，结果待核对；未自动重传');engine.persist();engine.emit();}
    return {claimId:manifest.claimId,count:manifest.count,verified:false,uncertain:true,unchanged:false,canUpload:false,canCheck:true,message:'照片选择可能已发送，但操作中断或页面发生变化。请重新读取原页面核对结果，不要重复上传。',receipt:null};
   }
   if(!result||result.claimId!==manifest.claimId||result.count!==manifest.count||typeof result.verified!=='boolean'||typeof result.uncertain!=='boolean')throw Error('照片上传回执格式无法核对，请检查页面');
   engine.event(result.verified?'info':'warning',plan.sku+'：'+(result.verified?'已核对网页照片上传回执':'照片上传结果待核对，禁止盲目重传'));engine.persist();engine.emit();
   // Only plain receipt fields may cross IPC; no original paths or raw supplier data.
   const optionalMaterial=recheckOnly?undefined:materialReceipt(result.optionalMaterial);
   return {claimId:result.claimId,count:result.count,verified:result.verified,uncertain:result.uncertain,unchanged:result.unchanged===true,canUpload:false,canCheck:result.canCheck===true,message:optionalMaterial?.verified===false?'照片回执与可选材质分别核对；可选材质尚未确认清空，请检查当前页面。':String(result.message||'').slice(0,1000),...(optionalMaterial?{optionalMaterial}:{}),receipt:result.receipt?{thumbnailCount:result.receipt.thumbnailCount,serverStoredCount:result.receipt.serverStoredCount,errorCount:result.receipt.errorCount,busy:result.receipt.busy===true,documentKey:result.receipt.documentKey}:null};
  })
 };
}
module.exports={createPhotoService};
