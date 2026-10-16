'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAsyncCipher}=require('../src/safe-storage-async.cjs');
const fixtureSecret='fixture-only-credential',ciphertext=Buffer.from('v10-fixture-only-ciphertext').toString('base64');
function fixture(overrides={},options={}){
 const calls=[];
 const storage={
  isEncryptionAvailable(){throw Error('synchronous encryption must not run');},
  decryptString(){throw Error('synchronous decryption must not run');},
  encryptString(){throw Error('synchronous encryption must not run');},
  async isAsyncEncryptionAvailable(){calls.push('available');return true;},
  async decryptStringAsync(value){calls.push(['decrypt',value.toString('base64')]);return {result:fixtureSecret,shouldReEncrypt:false};},
  async encryptStringAsync(value){calls.push(['encrypt',value]);return Buffer.from(ciphertext,'base64');},
  ...overrides
 };
 return {...createAsyncCipher(storage,{platform:'darwin',...options}),calls};
}
test('async cipher uses native asynchronous methods and preserves the legacy ciphertext bytes',async()=>{
 const f=fixture();assert.equal(await f.unsealAsync(ciphertext),fixtureSecret);assert.equal(await f.sealAsync(fixtureSecret),ciphertext);
 assert.deepEqual(f.calls,['available',['decrypt',ciphertext],'available',['encrypt',fixtureSecret]]);
});
test('a rotation hint returns the secret without silently encrypting or overwriting credentials',async()=>{
 const f=fixture({decryptStringAsync:async()=>({result:fixtureSecret,shouldReEncrypt:true})});assert.equal(await f.unsealAsync(ciphertext),fixtureSecret);assert.deepEqual(f.calls,['available']);
});
test('provider errors and temporary unavailability return a static message without secret details',async()=>{
 for(const overrides of [{isAsyncEncryptionAvailable:async()=>false},{isAsyncEncryptionAvailable:async()=>{throw Error(fixtureSecret);}},{decryptStringAsync:async()=>{throw Error(fixtureSecret);}},{decryptStringAsync:undefined}]){
  const f=fixture(overrides);await assert.rejects(f.unsealAsync(ciphertext),e=>e.code==='SECRET_STORAGE_UNAVAILABLE'&&!e.message.includes(fixtureSecret));
 }
});
test('invalid ciphertext and malformed native decrypt results do not expose plaintext or fall back to sync calls',async()=>{
 for(const value of ['',null,'not base64','Zg','Zg===',ciphertext+'\n']){const f=fixture();await assert.rejects(f.unsealAsync(value),{code:'SECRET_STORAGE_UNAVAILABLE'});assert.deepEqual(f.calls,[]);}
 for(const result of [null,fixtureSecret,{result:fixtureSecret},{result:fixtureSecret,shouldReEncrypt:'false'},{result:'',shouldReEncrypt:false}]){const f=fixture({decryptStringAsync:async()=>result});await assert.rejects(f.unsealAsync(ciphertext),{code:'SECRET_STORAGE_UNAVAILABLE'});}
});
test('encryption errors preserve the caller value and never emit unencrypted or malformed ciphertext',async()=>{
 for(const result of [fixtureSecret,Buffer.from(fixtureSecret),Buffer.alloc(0),null]){const f=fixture({encryptStringAsync:async()=>result});await assert.rejects(f.sealAsync(fixtureSecret),{code:'SECRET_STORAGE_UNAVAILABLE'});}
 const f=fixture({encryptStringAsync:async()=>{throw Error(fixtureSecret);}});await assert.rejects(f.sealAsync(fixtureSecret),e=>e.code==='SECRET_STORAGE_UNAVAILABLE'&&!e.message.includes(fixtureSecret));
});
test('Linux plaintext fallback or unknown backend is refused without initiating key access',async()=>{
 for(const backend of ['basic_text','unknown']){const f=fixture({getSelectedStorageBackend:()=>backend},{platform:'linux'});await assert.rejects(f.unsealAsync(ciphertext),{code:'SECRET_STORAGE_UNAVAILABLE'});await assert.rejects(f.sealAsync(fixtureSecret),{code:'SECRET_STORAGE_UNAVAILABLE'});assert.deepEqual(f.calls,[]);}
});
