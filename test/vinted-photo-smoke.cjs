const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
const {nativeImage}=require('electron');
const {VintedAdapter}=require('../src/vinted-adapter.cjs');
const {createTrustedPhotoManifest}=require('../src/vinted-photo-upload.cjs');
const FORM='https://www.vinted.fr/items/new';
const html=`<!doctype html><meta charset="utf-8"><title>Local photo upload transport fixture</title>
<style>body{font:16px Arial}main{margin:40px}#photos{padding:24px;border:1px solid #aaa}img{width:100px;height:100px}button{padding:16px}</style>
<main><form><label for="title">Titre</label><input id="title" placeholder="Dis aux acheteurs ce que tu vends">
<div id="photos" data-testid="media-upload" aria-label="Photos"><input id="photos-file" data-testid="add-photos-input" type="file" accept="image/jpeg" multiple hidden><button type="button">Ajoute des photos</button><div id="thumbnails"></div><div role="status" id="status"></div></div>
<button type="button" id="save">Sauvegarder le brouillon</button><button type="submit">Ajouter</button></form></main>
<script>window.fixture={events:[],sets:0,saves:0,publishes:0,pending:false};
for(const kind of ['input','change'])document.querySelector('#photos-file').addEventListener(kind,e=>fixture.events.push({kind,trusted:e.isTrusted}));
document.querySelector('#photos-file').addEventListener('change',e=>{fixture.sets++;if(fixture.pending)return;for(let i=0;i<e.target.files.length;i++){const img=document.createElement('img');img.alt='Photo '+(i+1)+" sur "+e.target.files.length+" mise en ligne Pour réorganiser les photos, appuie sur la barre d'espace";img.src='/fixture-photo/'+i+'.jpg';const edit=document.createElement('button');edit.type='button';edit.textContent='Modifier la photo '+(i+1);document.querySelector('#thumbnails').append(img,edit);}const remove=document.createElement('button');remove.type='button';remove.textContent='Supprimer la photo sélectionnée';document.querySelector('#thumbnails').append(remove);document.querySelector('#photos>button').textContent='Ajouter des photos';});
document.querySelector('#save').onclick=()=>fixture.saves++;document.querySelector('form').onsubmit=e=>{e.preventDefault();fixture.publishes++;};</script>`;

module.exports=async function photoTransportSmoke(api,check){
  let profile,w,session,dir;
  try{
    dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'isola-photo-electron-')));
    const jpeg=nativeImage.createFromBitmap(Buffer.from([0x20,0x40,0x90,0xff,0x20,0x40,0x90,0xff,0x20,0x40,0x90,0xff,0x20,0x40,0x90,0xff]),{width:2,height:2}).toJPEG(85),file=path.join(dir,'fixture.jpg');await fs.writeFile(file,jpeg);
    profile=api.saveProfile({name:'QA local photo transport',url:FORM,fingerprintMode:'native',width:1180,height:900});session=api.sesFor(profile);
    session.protocol.handle('https',request=>{const route=new URL(request.url).pathname;return route==='/items/new'?new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}):/^\/fixture-photo\/\d+\.jpg$/.test(route)?new Response(jpeg,{headers:{'content-type':'image/jpeg'}}):new Response('Not found',{status:404});});
    await api.launch(profile.id);w=api.windows.get(profile.id);const tab=w.tabs[0],contents=tab.view.webContents,adapter=new VintedAdapter({windows:api.windows});adapter.photos.uploadWaitMs=1500;adapter.photos.pollIntervalMs=60;
    const manifest=await createTrustedPhotoManifest({claimId:'fixture-only',profileId:profile.id,count:1,files:[{path:file,sha256:createHash('sha256').update(jpeg).digest('hex')}]});
    await check('photo local runtime diagnostic sees the hidden native image input without exposing filenames',async()=>{
      const state=await adapter.inspectPhotoControls(profile.id);assert.equal(state.fileInputCount,1);assert.equal(state.candidates[0].accept,'image/jpeg');assert.equal(state.candidates[0].multiple,true);assert.equal(state.candidates[0].visible,false);assert.equal(state.candidates[0].selectedFileCount,0);assert.ok(state.candidates[0].scope);assert.equal(state.canUpload,true);assert.equal(state.candidates[0].scope.selectionVerified,true);assert.equal(state.candidates[0].scope.receiptVerified,false);assert.equal(JSON.stringify(state).includes(file),false);return {fileInputCount:1,hiddenNativeInput:true,selectionContract:'observed media-upload / add-photos-input',completionContractVerified:false,source:'local intercepted fixture; not live Vinted'};
    });
    await check('photo local runtime CDP file selection yields trusted events and stable thumbnails without publication',async()=>{
      const result=await adapter.uploadPhotos(profile.id,manifest),actual=await contents.executeJavaScript('({...fixture})');assert.equal(result.verified,true);assert.equal(result.receipt.thumbnailCount,1);assert.equal(actual.sets,1);assert.ok(actual.events.some(event=>event.kind==='change'));assert.ok(actual.events.every(event=>event.trusted));assert.equal(actual.saves,0);assert.equal(actual.publishes,0);return {trustedEvents:actual.events,thumbnailCount:1,source:'local fixture of observed French upload markup; production receipt mapping without injection'};
    });
    await check('photo local runtime repeat reconciliation does not choose or upload files again',async()=>{
      const state=await adapter.inspectPhotoControls(profile.id);assert.equal(state.candidates[0].scope.selectionVerified,false);assert.equal(state.candidates[0].scope.receiptVerified,true);assert.match(state.candidates[0].scope.images[0].sourceFingerprint,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(state).includes('/fixture-photo/'),false);const result=await adapter.uploadPhotos(profile.id,manifest);assert.equal(result.verified,true);assert.equal(result.unchanged,true);assert.equal(await contents.executeJavaScript('fixture.sets'),1);
    });
    await check('photo local runtime detects a changed image source without selecting files again',async()=>{
      await contents.executeJavaScript(`document.querySelector('#thumbnails img').src='/fixture-photo/2.jpg'`);await assert.rejects(adapter.uploadPhotos(profile.id,manifest),{code:'PHOTO_RECEIPT_CONFLICT'});assert.equal(await contents.executeJavaScript('fixture.sets'),1);
    });
    await check('photo local runtime selected FileList without thumbnails remains uncertain and is never resent',async()=>{
      await contents.loadURL(FORM);await assert.rejects(adapter.uploadPhotos(profile.id,manifest,{recheckOnly:true}),{code:'NO_UPLOAD_TO_CHECK'});assert.equal(await contents.executeJavaScript('fixture.sets'),0);await contents.executeJavaScript('fixture.pending=true');adapter.photos.uploadWaitMs=250;const result=await adapter.uploadPhotos(profile.id,manifest);assert.equal(result.uncertain,true);assert.equal(result.verified,false);assert.equal(result.receipt.thumbnailCount,0);const again=await adapter.uploadPhotos(profile.id,manifest,{recheckOnly:true});assert.equal(again.uncertain,true);assert.equal(await contents.executeJavaScript('fixture.sets'),1);
    });
    await check('photo local runtime cancellation at feedback prevents native file selection',async()=>{
      await contents.loadURL(FORM);const prior=tab.controlFeedback;tab.controlFeedback=async()=>w.vintedDraftController.abort();try{await assert.rejects(adapter.uploadPhotos(profile.id,manifest));assert.equal(await contents.executeJavaScript('fixture.sets'),0);assert.equal(await contents.executeJavaScript('document.querySelector("#photos-file").files.length'),0);}finally{tab.controlFeedback=prior;}
    });
  }finally{
    if(w&&!w.isDestroyed())w.close();await new Promise(resolve=>setTimeout(resolve,200));if(session)session.protocol.unhandle('https');if(profile)await api.deleteProfile(profile.id);if(dir)await fs.rm(dir,{recursive:true,force:true});
  }
};
