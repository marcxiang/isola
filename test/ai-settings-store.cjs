const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {settingsPath,readSettingsRecord,writeSettingsRecord,removeSettingsRecord}=require('../src/ai-settings-store.cjs');
const defaults={baseURL:'https://example.invalid/v1',protocol:'responses',model:'',maxSteps:20,visionEnabled:false};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-ai-scope-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,defaults};}
test('per-environment AI settings fork the encrypted legacy template and remain independent',t=>{
 const f=fixture(t),legacy={...defaults,model:'legacy-model',encryptedKey:'fixture-ciphertext'};writeSettingsRecord({...f,value:legacy});
 const a=readSettingsRecord({...f,profileId:'profile-a'}),b=readSettingsRecord({...f,profileId:'profile-b'});assert.deepEqual(a,b);writeSettingsRecord({...f,profileId:'profile-a',value:{...a,model:'model-a',visionEnabled:true,encryptedKey:'new-ciphertext-a'}});
 assert.equal(readSettingsRecord({...f,profileId:'profile-a'}).model,'model-a');assert.equal(readSettingsRecord({...f,profileId:'profile-b'}).model,'legacy-model');assert.equal(readSettingsRecord({...f,profileId:'profile-b'}).visionEnabled,false);assert.equal(readSettingsRecord(f).encryptedKey,'fixture-ciphertext');assert.notEqual(settingsPath(f.dir,'profile-a'),settingsPath(f.dir,'profile-b'));
});
test('new environment settings do not inherit edits from another environment',t=>{
 const f=fixture(t);writeSettingsRecord({...f,profileId:'profile-a',value:{...defaults,model:'private-a',encryptedKey:'cipher-a'}});assert.equal(readSettingsRecord({...f,profileId:'profile-b'}).model,'');assert.equal(readSettingsRecord({...f,profileId:'profile-b'}).encryptedKey,'');
});
test('only known settings and encrypted key are persisted; plaintext and foreign metadata are omitted',t=>{
 const f=fixture(t);writeSettingsRecord({...f,profileId:'a',value:{...defaults,model:'a',encryptedKey:'cipher-only',apiKey:'plaintext-must-not-persist',accountPassword:'another-secret'}});const raw=fs.readFileSync(settingsPath(f.dir,'a'),'utf8');assert.doesNotMatch(raw,/plaintext-must-not-persist|another-secret|apiKey|accountPassword/);
});
test('unsafe identifiers and corrupt records fail closed without erasing originals',t=>{
 const f=fixture(t);for(const profileId of [null,123,'../a','a/b','',{},'a\\b'])assert.throws(()=>settingsPath(f.dir,profileId));writeSettingsRecord({...f,profileId:'a',value:defaults});const file=settingsPath(f.dir,'a');fs.writeFileSync(file,'{invalid');assert.throws(()=>readSettingsRecord({...f,profileId:'a'}),/原文件已保留/);assert.equal(fs.readFileSync(file,'utf8'),'{invalid');
});
test('failed writes retain the previous complete settings file',t=>{
 const f=fixture(t);writeSettingsRecord({...f,profileId:'a',value:{...defaults,model:'kept'}});const file=settingsPath(f.dir,'a'),before=fs.readFileSync(file,'utf8');assert.throws(()=>writeSettingsRecord({...f,profileId:'a',value:{...defaults,model:12}}),/原配置已保留/);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.readdirSync(path.dirname(file)).length,1);
});
test('deleting one environment model configuration leaves other profiles and the legacy template intact',t=>{
 const f=fixture(t);for(const profileId of [undefined,'a','b'])writeSettingsRecord({...f,profileId,value:{...defaults,model:profileId||'legacy'}});removeSettingsRecord({...f,profileId:'a'});assert.equal(fs.existsSync(settingsPath(f.dir,'a')),false);assert.equal(readSettingsRecord({...f,profileId:'b'}).model,'b');assert.equal(readSettingsRecord(f).model,'legacy');assert.throws(()=>removeSettingsRecord(f));
});
