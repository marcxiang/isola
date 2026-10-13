const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {EventEmitter}=require('node:events');
const {VintedAdapter}=require('../src/vinted-adapter.cjs');
const {createTrustedPhotoManifest}=require('../src/vinted-photo-upload.cjs');
const FORM='https://www.vinted.fr/items/new';

async function manifestFixture(t){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'isola-photo-test-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const bytes=Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,4,0xff,0xd9]),file=path.join(dir,'photo.jpg');await fs.writeFile(file,bytes);
  return {dir,bytes,file,input:{claimId:'claim-test',profileId:'p1',productId:'test',setId:'set1',count:1,files:[{path:file,sha256:createHash('sha256').update(bytes).digest('hex'),width:1,height:1}]}};
}
function fixture({url=FORM,state}={}){
  const tab={id:'t1',view:{webContents:{isDestroyed:()=>false,getURL:()=>url}}},w={isDestroyed:()=>false,tabs:[tab],activeTab:'t1',aiAgent:{state:{running:false}}};let reads=0;
  const control={isolated:async()=>state||{url,documentKey:'1',fileInputCount:1,candidates:[{index:0,accept:'image/*',multiple:true,disabled:false,visible:false,selectedFileCount:0,scopeLevel:null,ancestors:[],scope:null}],challenge:false}};
  const adapter=new VintedAdapter({windows:new Map([['p1',w]]),control});adapter.read=async(_profile,context)=>{adapter.current('p1',context);reads++;return {url,elements:[]};};
  return {adapter,w,tab,get reads(){return reads;}};
}
function uploadFixture(options={}){
  const state={url:FORM,documentKey:'document-1',fileInputCount:1,candidates:[{index:0,accept:'image/jpeg',multiple:true,disabled:false,visible:false,selectedFileCount:0,scope:{contract:'vinted-fr-photos-v1',selectionVerified:true,receiptVerified:true,images:[],thumbnails:[],errors:[],busy:false}}],challenge:false};
  let currentURL=FORM;const commands=[];
  const contents=Object.assign(new EventEmitter(),{isDestroyed:()=>false,getURL:()=>currentURL});
  contents.debugger={isAttached:()=>true,sendCommand:async(method,args)=>{
    commands.push({method,args});await options.onCommand?.(method,args,api);
    if(method==='Runtime.evaluate')return {result:{subtype:'node',objectId:'file-input-1'}};
    if(method==='Runtime.callFunctionOn')return {result:{value:options.staleInput!==true}};
    if(method==='DOM.setFileInputFiles'){
      if(options.setterError)throw Error('setter connection lost');
      state.candidates[0].selectedFileCount=args.files.length;
      if(!options.pending)state.candidates[0].scope.thumbnails=args.files.map((_,i)=>({key:'stored-photo-'+i,loaded:true,serverStored:true}));
      if(options.uploadError)state.candidates[0].scope.errors=['Le téléchargement a échoué'];
    }
    return {};
  }};
  const tab={id:'t1',aiContext:11,view:{webContents:contents}},w={isDestroyed:()=>false,tabs:[tab],activeTab:'t1',aiAgent:{state:{running:false}}};
  const control={isolated:async()=>{await options.onRead?.(api);return structuredClone(state);}};
  const adapter=new VintedAdapter({windows:new Map([['p1',w]]),control});adapter.read=async(_profile,context)=>{adapter.current('p1',context);return {url:currentURL,elements:[]};};adapter.photos.uploadWaitMs=options.waitMs??35;adapter.photos.pollIntervalMs=10;
  const api={adapter,w,tab,contents,state,commands,setURL(value){currentURL=value;},countWrites(){return commands.filter(command=>command.method==='DOM.setFileInputFiles').length;}};return api;
}

test('photo diagnostics inspect only the exact new France form and do not unlock upload',async()=>{
  const f=fixture(),state=await f.adapter.inspectPhotoControls('p1');assert.equal(state.fileInputCount,1);assert.equal(state.canUpload,false);assert.equal(state.candidates[0].selectedFileCount,0);assert.equal(f.reads,1);assert.equal(f.w.vintedDraftController,undefined);
  for(const url of ['https://www.vinted.fr/','https://www.vinted.fr/items/new?draft=1','https://www.vinted.fr/items/1/edit','https://vinted.fr/items/new'])await assert.rejects(fixture({url}).adapter.inspectPhotoControls('p1'));
});
test('photo diagnostics respect existing controller, AI and cancellation guards',async()=>{
  const f=fixture();f.w.vintedDraftController=new AbortController();await assert.rejects(f.adapter.inspectPhotoControls('p1'),{code:'PAGE_BUSY'});f.w.vintedDraftController=null;f.w.aiAgent.state.running=true;await assert.rejects(f.adapter.inspectPhotoControls('p1'),{code:'PAGE_BUSY'});f.w.aiAgent.state.running=false;const controller=new AbortController();controller.abort();await assert.rejects(f.adapter.inspectPhotoControls('p1',{signal:controller.signal}),{code:'STOPPED'});assert.equal(f.reads,0);
});
test('photo diagnostics reject changed or malformed page receipts',async()=>{
  for(const state of [null,{url:FORM,documentKey:'1'},{url:'https://www.vinted.fr/',documentKey:'1',candidates:[]}]){const f=fixture({state:state||{url:FORM,candidates:[]}});await assert.rejects(f.adapter.inspectPhotoControls('p1'),{code:'PHOTO_INSPECTION_FAILED'});}
});
test('main-process manifest verifies JPEG hashes, counts and profile identity and freezes its contents',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input);assert.equal(manifest.claimId,'claim-test');assert.equal(manifest.profileId,'p1');assert.equal(manifest.files[0].bytes,10);assert.equal(manifest.files[0].width,1);assert.ok(Object.isFrozen(manifest));assert.ok(Object.isFrozen(manifest.files));assert.ok(Object.isFrozen(manifest.files[0]));
  await assert.rejects(fixture().adapter.uploadPhotos('p1',JSON.parse(JSON.stringify(manifest))),{code:'PHOTO_MANIFEST_UNTRUSTED'});await assert.rejects(fixture().adapter.uploadPhotos('p2',manifest),{code:'PHOTO_MANIFEST_UNTRUSTED'});await assert.rejects(fixture().adapter.uploadPhotos('p1',manifest),{code:'PHOTO_UPLOAD_UNVERIFIED'});
});
test('main-process manifest rejects duplicates, invalid counts, relative paths and non-JPEG files',async t=>{
  const {input}=await manifestFixture(t);
  for(const next of [{...input,count:2},{...input,count:0,files:[]},{...input,profileId:''},{...input,claimId:''},{...input,count:2,files:[...input.files,...input.files]},{...input,files:[{...input.files[0],path:'relative.jpg'}]},{...input,files:[{...input.files[0],path:input.files[0].path+'.png'}]}])await assert.rejects(createTrustedPhotoManifest(next),{code:'PHOTO_MANIFEST_INVALID'});
});
test('main-process manifest rejects modified file bytes or mismatching JPEG hash',async t=>{
  const {input,file}=await manifestFixture(t);await assert.rejects(createTrustedPhotoManifest({...input,files:[{...input.files[0],sha256:'0'.repeat(64)}]}),{code:'PHOTO_HASH_MISMATCH'});await fs.writeFile(file,'not an image');await assert.rejects(createTrustedPhotoManifest(input),{code:'PHOTO_HASH_MISMATCH'});
});
test('main-process manifest rejects symbolic links and directories',async t=>{
  const {input,file,dir}=await manifestFixture(t),link=path.join(dir,'linked.jpg'),folder=path.join(dir,'folder.jpg');await fs.symlink(file,link);await fs.mkdir(folder);
  for(const candidate of [link,folder])await assert.rejects(createTrustedPhotoManifest({...input,files:[{...input.files[0],path:candidate}]}),{code:'PHOTO_MANIFEST_INVALID'});
});
test('trusted upload uses the exact CDP input and verifies stable stored thumbnails, then retries read-only',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input),f=uploadFixture();
  const result=await f.adapter.uploadPhotos('p1',manifest);assert.equal(result.verified,true);assert.equal(result.uncertain,false);assert.equal(result.receipt.thumbnailCount,1);assert.equal(result.receipt.serverStoredCount,1);assert.equal(result.published,false);assert.equal(result.saved,false);assert.equal(result.canUpload,false);assert.equal(result.canCheck,true);assert.equal(f.countWrites(),1);assert.deepEqual(f.commands.find(command=>command.method==='DOM.setFileInputFiles').args,{files:[input.files[0].path],objectId:'file-input-1'});assert.equal(f.w.vintedDraftController,null);assert.equal(f.contents.listenerCount('did-start-navigation'),0);
  const same=await f.adapter.uploadPhotos('p1',await createTrustedPhotoManifest(input));assert.equal(same.verified,true);assert.equal(same.unchanged,true);assert.equal(f.countWrites(),1);assert.equal(f.commands.at(-1).method,'Runtime.releaseObject');
  const inspection=await f.adapter.inspectPhotoControls('p1');assert.equal(inspection.canUpload,false);assert.equal(inspection.canCheck,true);assert.equal(inspection.previousClaimState.phase,'verified');
});
test('selected FileList alone remains uncertain and repeat checks never resend it',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input),f=uploadFixture({pending:true});
  const result=await f.adapter.uploadPhotos('p1',manifest);assert.equal(f.state.candidates[0].selectedFileCount,1);assert.equal(result.verified,false);assert.equal(result.uncertain,true);assert.equal(result.receipt.thumbnailCount,0);assert.equal(f.countWrites(),1);
  const again=await f.adapter.uploadPhotos('p1',manifest);assert.equal(again.uncertain,true);assert.equal(again.unchanged,true);assert.equal(f.countWrites(),1);
  f.state.candidates[0].scope.thumbnails=[{key:'server-photo',loaded:true,serverStored:true}];const recovered=await f.adapter.uploadPhotos('p1',manifest);assert.equal(recovered.verified,true);assert.equal(f.countWrites(),1);
});
test('local preview images and pending upload status cannot become successful receipts',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input);
  for(const patch of [{loaded:true,serverStored:false},{loaded:false,serverStored:true}]){const f=uploadFixture({pending:true,onCommand(method,_args,api){if(method==='DOM.setFileInputFiles')api.state.candidates[0].scope.thumbnails=[{key:'preview',...patch}];}});assert.equal((await f.adapter.uploadPhotos('p1',manifest)).uncertain,true);}
  const busy=uploadFixture({onCommand(method,_args,api){if(method==='DOM.setFileInputFiles')api.state.candidates[0].scope.busy=true;}});assert.equal((await busy.adapter.uploadPhotos('p1',manifest)).uncertain,true);
});
test('unknown existing photos, missing structure, multiple inputs and challenges stop before any file selection',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input);
  const cases=[state=>state.candidates[0].scope.images.push({loaded:true}),state=>state.candidates[0].selectedFileCount=1,state=>state.candidates[0].scope.thumbnails.push({key:'unknown'}),state=>delete state.candidates[0].scope.contract,state=>state.fileInputCount=2,state=>state.challenge=true,state=>state.candidates[0].disabled=true,state=>state.candidates[0].accept='application/pdf'];
  for(const mutate of cases){const f=uploadFixture();mutate(f.state);await assert.rejects(f.adapter.uploadPhotos('p1',manifest));assert.equal(f.countWrites(),0);assert.equal(f.w.vintedDraftController,null);}
});
test('file content is rechecked immediately before upload and stale inputs never receive a setter',async t=>{
  const {input,file}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input),f=uploadFixture();await fs.writeFile(file,Buffer.from([0xff,0xd8,0xff,9,0xff,0xd9]));await assert.rejects(f.adapter.uploadPhotos('p1',manifest),{code:'PHOTO_HASH_MISMATCH'});assert.equal(f.countWrites(),0);
  const second=await manifestFixture(t),valid=await createTrustedPhotoManifest(second.input),stale=uploadFixture({staleInput:true});await assert.rejects(stale.adapter.uploadPhotos('p1',valid),{code:'PHOTO_INPUT_CHANGED'});assert.equal(stale.countWrites(),0);assert.equal(stale.commands.at(-1).method,'Runtime.releaseObject');
});
test('navigation, tab switch and cancellation at feedback stop before dispatching files',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input);
  for(const action of [f=>f.contents.emit('did-start-navigation',{},FORM,false,true),f=>f.w.activeTab='another-tab',f=>f.w.vintedDraftController.abort()]){const f=uploadFixture();f.tab.controlFeedback=async()=>action(f);await assert.rejects(f.adapter.uploadPhotos('p1',manifest));assert.equal(f.countWrites(),0);assert.equal(f.w.vintedDraftController,null);}
});
test('aborted or rejected setter is recorded as uncertain and cannot be dispatched again',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input);
  const f=uploadFixture({setterError:true});await assert.rejects(f.adapter.uploadPhotos('p1',manifest),error=>error.ambiguous===true&&error.uploadMayHaveStarted===true);assert.equal(f.countWrites(),1);assert.equal((await f.adapter.uploadPhotos('p1',manifest)).uncertain,true);assert.equal(f.countWrites(),1);
  const abort=uploadFixture({pending:true,onCommand(method,_args,api){if(method==='DOM.setFileInputFiles')api.w.vintedDraftController.abort();}});await assert.rejects(abort.adapter.uploadPhotos('p1',manifest),error=>error.ambiguous===true);assert.equal(abort.countWrites(),1);assert.equal((await abort.adapter.uploadPhotos('p1',manifest)).uncertain,true);assert.equal(abort.countWrites(),1);
});
test('different claims and changed receipts on one document cannot overwrite the uploaded images',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input),f=uploadFixture();await f.adapter.uploadPhotos('p1',manifest);
  await assert.rejects(f.adapter.uploadPhotos('p1',await createTrustedPhotoManifest({...input,claimId:'another-claim'})),{code:'PHOTO_CLAIM_CONFLICT'});assert.equal(f.countWrites(),1);
  f.state.candidates[0].scope.thumbnails=[{key:'manual-replacement',loaded:true,serverStored:true}];await assert.rejects(f.adapter.uploadPhotos('p1',manifest),{code:'PHOTO_RECEIPT_CONFLICT'});assert.equal(f.countWrites(),1);
});
test('rendered upload errors are not reported as success even when thumbnails exist',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input),f=uploadFixture({uploadError:true});await assert.rejects(f.adapter.uploadPhotos('p1',manifest),{code:'PHOTO_UPLOAD_ERROR'});assert.equal(f.countWrites(),1);assert.equal(f.w.vintedDraftController,null);
});
test('a file input disabled by an in-progress upload is read-only until its completion receipt settles',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input);let uploadingReads=0;
  const f=uploadFixture({waitMs:100,onCommand(method,_args,api){if(method==='DOM.setFileInputFiles'){api.state.candidates[0].disabled=true;api.state.candidates[0].scope.busy=true;}},onRead(api){if(api.countWrites()&&++uploadingReads>=3){api.state.candidates[0].disabled=false;api.state.candidates[0].scope.busy=false;}}});
  assert.equal((await f.adapter.uploadPhotos('p1',manifest)).verified,true);assert.equal(f.countWrites(),1);assert.ok(uploadingReads>=3);
});
test('a verified file-selection contract never substitutes for an unverified live completion receipt',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input),f=uploadFixture();f.state.candidates[0].scope.receiptVerified=false;
  assert.equal((await f.adapter.inspectPhotoControls('p1')).canUpload,true);const result=await f.adapter.uploadPhotos('p1',manifest);assert.equal(result.uncertain,true);assert.equal(result.verified,false);assert.equal(f.countWrites(),1);assert.equal((await f.adapter.uploadPhotos('p1',manifest)).uncertain,true);assert.equal(f.countWrites(),1);
});
test('a stalled snapshot or isolated read times out and releases the photo controller',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input);
  for(const stage of ['snapshot','isolated']){const f=uploadFixture(stage==='isolated'?{onRead:()=>new Promise(()=>{})}:{});f.adapter.photos.ioTimeoutMs=12;if(stage==='snapshot')f.adapter.read=()=>new Promise(()=>{});await assert.rejects(f.adapter.uploadPhotos('p1',manifest),{code:'PHOTO_CONTROL_TIMEOUT'});assert.equal(f.countWrites(),0);assert.equal(f.w.vintedDraftController,null);assert.equal(f.contents.listenerCount('did-start-navigation'),0);}
});
test('a stalled input lookup or identity check times out before any file selection',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input);
  for(const stalled of ['Runtime.evaluate','Runtime.callFunctionOn']){const f=uploadFixture({onCommand:method=>method===stalled?new Promise(()=>{}):undefined});f.adapter.photos.ioTimeoutMs=12;await assert.rejects(f.adapter.uploadPhotos('p1',manifest),{code:'PHOTO_CONTROL_TIMEOUT'});assert.equal(f.countWrites(),0);assert.equal(f.w.vintedDraftController,null);}
});
test('a setter timeout keeps its uncertainty record and late completion is reconciled without resending',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input);let complete;
  const f=uploadFixture({onCommand:method=>method==='DOM.setFileInputFiles'?new Promise(resolve=>{complete=resolve;}):undefined});f.adapter.photos.ioTimeoutMs=12;
  await assert.rejects(f.adapter.uploadPhotos('p1',manifest),error=>error.code==='PHOTO_CONTROL_TIMEOUT'&&error.ambiguous===true&&error.uploadMayHaveStarted===true);assert.equal(f.w.vintedDraftController,null);assert.equal(f.countWrites(),1);
  assert.equal((await f.adapter.uploadPhotos('p1',manifest)).uncertain,true);assert.equal(f.countWrites(),1);complete();await new Promise(resolve=>setImmediate(resolve));assert.equal((await f.adapter.uploadPhotos('p1',manifest)).verified,true);assert.equal(f.countWrites(),1);
});
test('a stalled release cannot replace a verified result or retain the operation lock',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input),f=uploadFixture({onCommand:method=>method==='Runtime.releaseObject'?new Promise(()=>{}):undefined});f.adapter.photos.releaseTimeoutMs=12;
  assert.equal((await f.adapter.uploadPhotos('p1',manifest)).verified,true);assert.equal(f.w.vintedDraftController,null);assert.equal(f.countWrites(),1);
});
test('stalled feedback and cancelled in-flight reads cannot dispatch files later',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input),f=uploadFixture();f.adapter.photos.ioTimeoutMs=12;f.tab.controlFeedback=()=>new Promise(()=>{});await assert.rejects(f.adapter.uploadPhotos('p1',manifest),{code:'PHOTO_CONTROL_TIMEOUT'});assert.equal(f.countWrites(),0);assert.equal(f.w.vintedDraftController,null);
  let release;const controller=new AbortController(),read=uploadFixture({onRead:()=>new Promise(resolve=>{release=resolve;})});const operation=read.adapter.uploadPhotos('p1',manifest,{signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(operation,{code:'STOPPED'});release();await new Promise(resolve=>setImmediate(resolve));assert.equal(read.countWrites(),0);assert.equal(read.w.vintedDraftController,null);
});
test('recheckOnly without this document and claim record never falls through to a new upload',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input),f=uploadFixture();
  await assert.rejects(f.adapter.uploadPhotos('p1',manifest,{recheckOnly:true}),{code:'NO_UPLOAD_TO_CHECK'});assert.equal(f.countWrites(),0);
  await f.adapter.uploadPhotos('p1',manifest);assert.equal(f.countWrites(),1);assert.equal((await f.adapter.uploadPhotos('p1',manifest,{recheckOnly:true})).verified,true);assert.equal(f.countWrites(),1);
  await assert.rejects(f.adapter.uploadPhotos('p1',await createTrustedPhotoManifest({...input,claimId:'other'}),{recheckOnly:true}),{code:'NO_UPLOAD_TO_CHECK'});assert.equal(f.countWrites(),1);
  f.state.documentKey='new-empty-document';f.state.candidates[0].selectedFileCount=0;f.state.candidates[0].scope.thumbnails=[];
  await assert.rejects(f.adapter.uploadPhotos('p1',manifest,{recheckOnly:true}),{code:'NO_UPLOAD_TO_CHECK'});assert.equal(f.countWrites(),1);assert.equal(f.w.vintedDraftController,null);
});
test('recheckOnly after an adapter record is lost is read-only even with an empty form',async t=>{
  const {input}=await manifestFixture(t),manifest=await createTrustedPhotoManifest(input),f=uploadFixture({pending:true});await f.adapter.uploadPhotos('p1',manifest);f.adapter.photos.claims.clear();f.state.candidates[0].selectedFileCount=0;
  await assert.rejects(f.adapter.uploadPhotos('p1',manifest,{recheckOnly:true}),{code:'NO_UPLOAD_TO_CHECK'});assert.equal(f.countWrites(),1);await assert.rejects(f.adapter.uploadPhotos('p1',manifest,{recheckOnly:'true'}),{code:'PHOTO_OPTIONS_INVALID'});assert.equal(f.countWrites(),1);
});
