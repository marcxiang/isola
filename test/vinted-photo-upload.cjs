const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
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
