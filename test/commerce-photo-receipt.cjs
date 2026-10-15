'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module');
const file=require.resolve('../src/commerce-photo-service.cjs'),fromSource=createRequire(file),source=fs.readFileSync(file,'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const uiSource=fs.readFileSync(require.resolve('../src/commerce-ui.cjs'),'utf8'),statusSource=uiSource.match(/  function optionalMaterialPhotoStatus\(material\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(statusSource,'Photo material status formatter must be present in the renderer');
const materialStatus=vm.runInNewContext('('+statusSource+')');
function fixture(receipt){
 const module={exports:{}},calls=[],events=[],manifest={claimId:'fixture-claim',count:1,files:[{path:'/private/fixture-sensitive/photo.jpg'}]};
 const photos={readPreparedPhotos:async()=>({manifest,summary:{ready:true}})};
 vm.runInNewContext(source,{module,require:id=>id==='./commerce-photos.cjs'?photos:id==='./vinted-photo-upload.cjs'?{createTrustedPhotoManifest:async value=>Object.freeze(value)}:fromSource(id)},{filename:file});
 const engine={faulted:false,plan:id=>{assert.equal(id,'fixture-plan');return {profileId:'fixture-profile',sku:'FIXTURE'};},configure:work=>work(new AbortController().signal,()=>{}),adapter:{uploadPhotos:async(...args)=>{calls.push(args);return {claimId:'fixture-claim',count:1,verified:true,uncertain:false,canCheck:true,...receipt};}},event:(...args)=>events.push(args),persist:()=>{},emit:()=>{}};
 return {service:module.exports.createPhotoService({}),engine,calls,events};
}
test('photo IPC retains only explicit boolean material observations and strips raw error values and paths',async()=>{
 const f=fixture({optionalMaterial:{verified:true,cleared:true,unchanged:false,message:'/private/fixture-sensitive/error',path:'/private/fixture-sensitive/photo.jpg',code:'private-error',published:false,other:{secret:'private-value'}}});
 const result=clone(await f.service.upload(f.engine,'fixture-plan'));
 assert.deepEqual(result.optionalMaterial,{verified:true,cleared:true,unchanged:false});assert.equal(result.verified,true);
 assert.doesNotMatch(JSON.stringify(result),/fixture-sensitive|private-error|private-value|"published"|"path"/);
});
test('photo IPC preserves a failed material check independently of a verified photo receipt',async()=>{
 const f=fixture({message:'照片已上传；错误 /private/fixture-sensitive/error private-value',optionalMaterial:{verified:false,message:'private-value',code:'private-error',path:'/private/fixture-sensitive/photo.jpg'}});
 const result=clone(await f.service.upload(f.engine,'fixture-plan'));
 assert.deepEqual(result.optionalMaterial,{verified:false});assert.equal(result.verified,true);assert.equal(result.uncertain,false);assert.match(result.message,/可选材质尚未确认清空/);
 assert.doesNotMatch(JSON.stringify(result),/fixture-sensitive|private-error|private-value/);
});
test('photo IPC preserves an unchanged observation without turning nonboolean values into success',async()=>{
 const unchanged=fixture({optionalMaterial:{verified:true,cleared:false,unchanged:true}}),result=clone(await unchanged.service.upload(unchanged.engine,'fixture-plan'));
 assert.deepEqual(result.optionalMaterial,{verified:true,cleared:false,unchanged:true});
 const malformed=fixture({optionalMaterial:{verified:true,cleared:'true',unchanged:1,message:'private-value'}}),filtered=clone(await malformed.service.upload(malformed.engine,'fixture-plan'));
 assert.deepEqual(filtered.optionalMaterial,{verified:true});assert.doesNotMatch(JSON.stringify(filtered),/private-value/);
});
test('photo IPC does not invent a material observation when it is absent or malformed',async()=>{
 for(const optionalMaterial of [undefined,null,[],false,{verified:'true'},{cleared:true},Object.create({verified:true})]){
  const f=fixture(optionalMaterial===undefined?{}:{optionalMaterial}),result=await f.service.upload(f.engine,'fixture-plan');
  assert.equal(Object.hasOwn(result,'optionalMaterial'),false);assert.equal(result.verified,true);
 }
});
test('read-only photo rechecks retain their mode and do not claim a fresh material cleanup',async()=>{
 const f=fixture({unchanged:true,optionalMaterial:{verified:true,cleared:true,unchanged:false}}),result=await f.service.upload(f.engine,'fixture-plan',{recheckOnly:true});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][2].recheckOnly,true);assert.equal(result.unchanged,true);assert.equal(Object.hasOwn(result,'optionalMaterial'),false);
});
test('photo panel distinguishes a cleared material field from an unchanged bounded observation',()=>{
 const cleared=materialStatus({verified:true,cleared:true,unchanged:false}),unchanged=materialStatus({verified:true,cleared:false,unchanged:true});
 assert.match(cleared.message,/已清空可选材质/);assert.match(unchanged.message,/本次观察暂未发现已填材质/);
 for(const result of [cleared,unchanged]){assert.equal(result.className,'field-hint');assert.match(result.message,/发布前仍会核对/);}
});
test('photo panel warns on failed, ambiguous or contradictory material states without inventing missing states',()=>{
 assert.equal(materialStatus(undefined),null);assert.equal(materialStatus(null),null);
 for(const material of [{verified:false},{verified:false,cleared:true},{verified:true},{verified:true,cleared:false,unchanged:false},{verified:true,cleared:true,unchanged:true}]){
  const status=materialStatus(material);assert.equal(status.className,'photo-result-warning');assert.match(status.message,/未确认清空|待核对/);assert.doesNotMatch(status.message,/已清空可选材质|本次观察暂未发现已填材质/);
 }
 const failed=materialStatus({verified:false});assert.match(failed.message,/照片回执已核对不代表材质核对完成/);
});
