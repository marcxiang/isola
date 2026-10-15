'use strict';
const assert=require('node:assert/strict');
const {createProductImageNormalizer}=require('../src/product-image-normalizer.cjs');
module.exports=async function imageNormalizerSmoke(_api,check){
 assert.ok(process.env.ISOLA_TEST_DATA,'Image decoder smoke requires isolated test data');
 const {BrowserWindow,nativeImage}=require('electron');
 const source=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 try{
  await source.loadURL('data:text/html,<title>Image fixture</title>');
  const encoded=await source.webContents.executeJavaScript(`(()=>{const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=512;const context=canvas.getContext('2d');context.fillStyle='#d82b40';context.fillRect(0,0,1024,512);return {webp:canvas.toDataURL('image/webp',0.8),png:canvas.toDataURL('image/png')};})()`);
  const bytes=value=>Buffer.from(value.split(',')[1],'base64'),normalize=createProductImageNormalizer({BrowserWindow,nativeImage});
  await check('valid Chromium WebP covers become bounded JPEG thumbnails in a hidden sandbox without remote requests',async()=>{
   const windows=BrowserWindow.getAllWindows().map(window=>window.id),created=[],network=[];
   const {app}=require('electron'),observe=(_event,window)=>{if(windows.includes(window.id))return;created.push(window);window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,done)=>{network.push(request.url);done({cancel:true});});};
   app.on('browser-window-created',observe);
   let result;try{assert.ok(encoded.webp.startsWith('data:image/webp;base64,'));result=await normalize(bytes(encoded.webp),{maxDimension:640});}finally{app.removeListener('browser-window-created',observe);}
   assert.deepEqual({width:result.width,height:result.height},{width:640,height:320});assert.match(result.dataURL,/^data:image\/jpeg;base64,/);const image=nativeImage.createFromDataURL(result.dataURL);assert.equal(image.isEmpty(),false);assert.deepEqual(image.getSize(),{width:640,height:320});assert.deepEqual(network,[]);assert.ok(created.every(window=>window.isDestroyed()));assert.deepEqual(BrowserWindow.getAllWindows().map(window=>window.id),windows);return {input:'webp',output:'jpeg',width:640,height:320,privateDecoderClosed:true,remoteRequests:0};
  });
  await check('PNG covers retain the native decoder path and malformed WebP cannot leave a decoder window or expose raw data',async()=>{
   const count=BrowserWindow.getAllWindows().length,png=await normalize(bytes(encoded.png),{maxDimension:320});assert.deepEqual({width:png.width,height:png.height},{width:320,height:160});assert.equal(BrowserWindow.getAllWindows().length,count);
   const corrupt=Buffer.alloc(30);corrupt.write('RIFF');corrupt.writeUInt32LE(22,4);corrupt.write('WEBP',8);corrupt.write('VP8 ',12);
   await assert.rejects(normalize(corrupt),error=>error.code==='PRODUCT_DISPLAY_DECODE_FAILED'&&!/data:|https?:|RIFF|VP8/.test(error.message));assert.equal(BrowserWindow.getAllWindows().length,count);return {pngNativePath:true,malformedRejected:true,decoderWindowsLeaked:0};
  });
  await check('cancelling a product cover destroys its hidden decoder immediately instead of waiting for the decoder timeout',async()=>{
   const {app}=require('electron'),controller=new AbortController(),before=BrowserWindow.getAllWindows().map(window=>window.id),created=[],observe=(_event,window)=>{if(before.includes(window.id))return;created.push(window);setImmediate(()=>controller.abort());};
   app.on('browser-window-created',observe);const at=Date.now();try{await assert.rejects(normalize(bytes(encoded.webp),{signal:controller.signal}),{code:'PRODUCT_DISPLAY_DECODE_FAILED'});}finally{app.removeListener('browser-window-created',observe);}
   assert.equal(created.length,1);assert.equal(created[0].isDestroyed(),true);assert.ok(Date.now()-at<2000);assert.deepEqual(BrowserWindow.getAllWindows().map(window=>window.id),before);return {aborted:true,decoderDestroyed:true,waitedForTenSecondTimeout:false};
  });
 }finally{if(!source.isDestroyed())source.destroy();}
};
