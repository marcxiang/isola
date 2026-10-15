'use strict';
const {randomUUID}=require('node:crypto');
const failed=()=>Object.assign(Error('商品展示图无法解码，请重试。'),{code:'PRODUCT_DISPLAY_DECODE_FAILED'});
const DECODER_PAGE='data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'none\'; script-src \'none\'"><title>Image preview</title>');
function createProductImageNormalizer({BrowserWindow,nativeImage,timeoutMs=10000}){
 if(typeof BrowserWindow!=='function'||!nativeImage||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw failed();
 return async function normalizeProductImage(bytes,{maxDimension=640,signal}={}){
  if(signal?.aborted||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>2*1024*1024||!Number.isSafeInteger(maxDimension)||maxDimension<1||maxDimension>640)throw failed();
  let image=nativeImage.createFromBuffer(bytes);
  if(!image.isEmpty()){
   const size=image.getSize();if(!size.width||!size.height||size.width>8192||size.height>8192||size.width*size.height>32*1024*1024)throw failed();
   const scale=Math.min(1,maxDimension/size.width,maxDimension/size.height);
   if(scale<1)image=image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale)),quality:'good'});
   return {dataURL:'data:image/jpeg;base64,'+image.toJPEG(80).toString('base64'),...image.getSize()};
  }
  // nativeImage on Windows cannot decode all valid WebP images. Chromium's
  // image decoder can; its private, hidden document receives only image bytes.
  if(bytes.length<12||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP')throw failed();
  const decoder=new BrowserWindow({show:false,focusable:false,width:64,height:64,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,devTools:false,backgroundThrottling:false,partition:'product-image-'+randomUUID()}});
  const contents=decoder.webContents;
  let timer,onAbort;
  try{
   contents.session.setPermissionCheckHandler(()=>false);
   contents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
   contents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','file://*/*']},(_request,callback)=>callback({cancel:true}));
   contents.setWindowOpenHandler(()=>({action:'deny'}));contents.on('will-attach-webview',event=>event.preventDefault());
   const aborted=new Promise((_,reject)=>{onAbort=()=>{if(!decoder.isDestroyed())decoder.destroy();reject(failed());};signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();});
   const task=(async()=>{await decoder.loadURL(DECODER_PAGE);return contents.executeJavaScript(`(async()=>{const image=new Image();image.src=${JSON.stringify('data:image/webp;base64,'+bytes.toString('base64'))};await image.decode();const w=image.naturalWidth,h=image.naturalHeight;if(!w||!h||w>8192||h>8192||w*h>33554432)throw Error('IMAGE_SIZE');const scale=Math.min(1,${maxDimension}/w,${maxDimension}/h),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));const context=canvas.getContext('2d');if(!context)throw Error('IMAGE_CONTEXT');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);return {dataURL:canvas.toDataURL('image/jpeg',0.8),width:canvas.width,height:canvas.height};})()`,true);})();
   const result=await Promise.race([task,aborted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failed()),timeoutMs);})]);
   if(!result||typeof result.dataURL!=='string'||!result.dataURL.startsWith('data:image/jpeg;base64,')||result.dataURL.length>3*1024*1024||![result.width,result.height].every(value=>Number.isSafeInteger(value)&&value>0&&value<=maxDimension))throw failed();
   return result;
  }catch{throw failed();}finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(!decoder.isDestroyed())decoder.destroy();}
 };
}
module.exports={createProductImageNormalizer};
