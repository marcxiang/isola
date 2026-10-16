const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateSettings}=require('../src/ai.cjs');const {sensitiveAction}=require('../src/page-control.cjs');
const {compactHistory,describeAction}=require('../src/ai.cjs');
test('vision requires explicit boolean opt in',()=>{const base={baseURL:'http://localhost/v1',protocol:'chat',model:'qa'};assert.equal(validateSettings(base).visionEnabled,false);assert.equal(validateSettings({...base,visionEnabled:true}).visionEnabled,true);assert.throws(()=>validateSettings({...base,visionEnabled:'true'}));});
test('history compaction preserves tool pairs and latest evidence while discarding old image bytes',()=>{const history=[{role:'user',content:'goal'},...Array.from({length:4},(_,i)=>({type:'function_call_output',call_id:'call'+i,output:JSON.stringify({elements:[{id:'e'+i+'-0'}],url:'https://example.com',observation:{summary:'step'+i}})})),{role:'user',content:[{type:'input_text',text:'old shot'},{type:'input_image',image_url:'data:OLD'}]},{role:'user',content:[{type:'input_image',image_url:'data:NEW'}]}];const out=compactHistory(history);assert.equal(out[0].content,'goal');assert.equal(out[1].call_id,'call0');assert.equal(JSON.parse(out[1].output).elements,undefined);assert.ok(JSON.parse(out[3].output).elements);assert.ok(!JSON.stringify(out).includes('data:OLD'));assert.ok(JSON.stringify(out).includes('data:NEW'));});
test('action feedback identifies target without logging typed values',()=>{const r=describeAction({action:'type',elementId:'e1-0',text:'private input'}, {elements:[{id:'e1-0',label:'Search'}]});assert.equal(r.label,'Search');assert.match(r.description,/填写/);assert.ok(!r.description.includes('private input'));});
test('model endpoints require HTTPS except loopback, without embedded secrets',()=>{for(const baseURL of ['http://example.com/v1','https://u:p@example.com/v1','https://example.com/v1?key=secret'])assert.throws(()=>validateSettings({baseURL,model:'qa',protocol:'responses',apiKey:'key'}));assert.equal(validateSettings({baseURL:'http://localhost:11434/v1',model:'local',protocol:'chat'}).apiKey,'');});
test('model settings validate protocol, model and operation budget',()=>{const base={baseURL:'https://api.openai.com/v1',model:'qa',protocol:'responses',apiKey:'key'};for(const p of [{protocol:'invalid'},{model:''},{maxSteps:51},{apiKey:'x\r\nHeader: value'}])assert.throws(()=>validateSettings({...base,...p}));});
test('mutating action labels trigger approval, normal search does not',()=>{for(const label of ['删除','发布文章','发送消息','Pay now','Checkout','Agree to terms','Acheter maintenant','Supprimer','Envoyer','Mettre en ligne'])assert.equal(sensitiveAction(label),true);for(const label of ['搜索','Search','Next page','Read more'])assert.equal(sensitiveAction(label),false);});

function settingsFixture(t,options={}){
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{createRequire}=require('node:module');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-lazy-model-key-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=require.resolve('../src/ai.cjs'),source=fs.readFileSync(file,'utf8'),fromSource=createRequire(file),calls={decrypt:0,encrypt:0,available:0,requests:[],snapshots:0};
  const seal=secret=>Buffer.from('local-fixture-sealed:'+secret).toString('base64');
  const safeStorage={isEncryptionAvailable(){calls.available++;return options.encryptionAvailable!==false;},encryptString(secret){calls.encrypt++;if(options.encryptError)throw Error(options.encryptError);return Buffer.from(seal(secret),'base64');},decryptString(buffer){calls.decrypt++;if(options.decryptError)throw Error(options.decryptError);const value=buffer.toString();if(!value.startsWith('local-fixture-sealed:'))throw Error('invalid fixture ciphertext');return value.slice('local-fixture-sealed:'.length);}};
  const module={exports:{}};
  vm.runInNewContext(source,{module,Buffer,URL,AbortController,setTimeout,clearTimeout,require:id=>id==='electron'?{app:{getPath:name=>{assert.equal(name,'userData');return dir;}},safeStorage}:id==='./page-control.cjs'?{checkedSnapshot:async()=>{calls.snapshots++;return {url:'https://fixture.invalid/',title:'Local model fixture',elements:[]};},performAction:async()=>{throw Error('No browser action was authorized in this fixture');}}:fromSource(id),fetch:async(url,request)=>{calls.requests.push({url,authorization:request.headers.Authorization,body:JSON.parse(request.body)});return {ok:true,status:200,text:async()=>JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'Local fixture complete.'}]}]})};}},{filename:file});
  const store=fromSource('./ai-settings-store.cjs'),config={baseURL:'https://model.invalid/v1',protocol:'responses',model:'fixture-model',maxSteps:4,visionEnabled:false};
  const put=(profileId,encryptedKey=seal('fixture-key'))=>store.writeSettingsRecord({dir,profileId,defaults:config,value:{...config,encryptedKey}});
  const record=profileId=>store.readSettingsRecord({dir,profileId,defaults:config});
  const agent=profileId=>new module.exports.BrowserAgent({profile:{id:profileId},activeTab:'fixture-tab',tabs:[{id:'fixture-tab',view:{webContents:{getURL:()=> 'https://fixture.invalid/',isDestroyed:()=>false}}}],isDestroyed:()=>false,webContents:{send:()=>{}}},async()=>{throw Error('No navigation was authorized in this fixture');});
  return {ai:module.exports,calls,config,put,record,agent,seal};
}

test('model metadata, legacy migration and BrowserAgent construction never unlock a saved key',t=>{
  const f=settingsFixture(t,{decryptError:'Keychain access denied'});f.put(undefined);
  const result=f.ai.publicSettings('scope-a');assert.equal(result.hasKey,true);assert.equal(result.model,f.config.model);assert.equal(result.scope,'environment');assert.equal(result.apiKey,undefined);assert.equal(result.encryptedKey,undefined);
  assert.equal(f.record('scope-a').encryptedKey,f.record(undefined).encryptedKey);assert.equal(f.agent('scope-a').state.running,false);
  assert.equal(f.calls.decrypt,0);assert.equal(f.calls.encrypt,0);assert.equal(f.calls.available,0);assert.equal(f.calls.requests.length,0);
});

test('settings-only edits preserve ciphertext bytes and account scope without decrypting or re-encrypting',t=>{
  const f=settingsFixture(t,{decryptError:'Keychain access denied'});f.put('scope-a');f.put('scope-b',f.seal('other-fixture-key'));const before=f.record('scope-a').encryptedKey,other=f.record('scope-b').encryptedKey;
  const result=f.ai.saveSettings({...f.config,baseURL:f.config.baseURL+'/',model:'changed-model',apiKey:'',visionEnabled:true},'scope-a');
  assert.equal(f.record('scope-a').encryptedKey,before);assert.equal(result.hasKey,true);assert.equal(result.visionEnabled,true);assert.equal(result.model,'changed-model');assert.equal(result.apiKey,undefined);assert.equal(result.encryptedKey,undefined);assert.equal(f.record('scope-b').encryptedKey,other);
  assert.equal(f.calls.decrypt,0);assert.equal(f.calls.encrypt,0);assert.equal(f.calls.available,0);
});

test('new, cleared and changed-endpoint keys follow explicit sealed-key rules without decrypting the old key',t=>{
  const f=settingsFixture(t,{decryptError:'Keychain access denied'});f.put('scope-a');
  const replacement=f.ai.saveSettings({...f.config,apiKey:'replacement-fixture-key'},'scope-a');assert.equal(replacement.hasKey,true);assert.equal(f.record('scope-a').encryptedKey,f.seal('replacement-fixture-key'));assert.equal(f.calls.encrypt,1);assert.equal(f.calls.available,1);
  assert.equal(f.ai.saveSettings({...f.config,clearKey:true,apiKey:'must-be-ignored'},'scope-a').hasKey,false);assert.equal(f.record('scope-a').encryptedKey,'');assert.equal(f.calls.encrypt,1);
  f.put('scope-a');assert.equal(f.ai.saveSettings({...f.config,baseURL:'https://another-model.invalid/v1',apiKey:''},'scope-a').hasKey,false);assert.equal(f.record('scope-a').encryptedKey,'');
  assert.equal(f.calls.decrypt,0);assert.equal(f.calls.encrypt,1);assert.equal(f.calls.requests.length,0);
});

test('invalid input or unavailable system encryption preserves the original sealed model key',t=>{
  const f=settingsFixture(t,{encryptionAvailable:false});f.put('scope-a');const before=f.record('scope-a');
  assert.throws(()=>f.ai.saveSettings({...f.config,apiKey:'invalid\nkey'},'scope-a'),/API Key/);assert.equal(f.calls.available,0);
  assert.throws(()=>f.ai.saveSettings({...f.config,apiKey:'new-fixture-key'},'scope-a'),/系统密钥加密不可用/);assert.deepEqual(f.record('scope-a'),before);assert.equal(f.calls.decrypt,0);assert.equal(f.calls.encrypt,0);
});

test('explicit AI start unlocks only its own key once and uses it only for the stubbed model request',async t=>{
  const f=settingsFixture(t);f.put('scope-a');f.put('scope-b',f.seal('other-fixture-key'));f.ai.publicSettings('scope-a');const agent=f.agent('scope-a');assert.equal(f.calls.decrypt,0);
  const result=await agent.start('Read the local fixture page');assert.equal(result.status,'complete');assert.equal(f.calls.decrypt,1);assert.equal(f.calls.requests.length,2);assert.ok(f.calls.requests.every(request=>request.authorization==='Bearer fixture-key'&&request.url==='https://model.invalid/v1/responses'));assert.ok(f.calls.snapshots>=2);assert.equal(f.record('scope-b').encryptedKey,f.seal('other-fixture-key'));
});

test('denied or corrupt model keys stay unopened during metadata reads and fail before any model request',async t=>{
  for(const options of [{decryptError:'Keychain access denied'},{corrupt:true}]){
    const f=settingsFixture(t,options);f.put('scope-a',options.corrupt?'not-a-valid-sealed-fixture':f.seal('fixture-key'));
    assert.equal(f.ai.publicSettings('scope-a').hasKey,true);assert.equal(f.calls.decrypt,0);
    await assert.rejects(f.agent('scope-a').start('Read the local fixture page'),/模型密钥无法解密/);assert.equal(f.calls.decrypt,1);assert.equal(f.calls.requests.length,0);assert.equal(f.calls.snapshots,0);
  }
});
