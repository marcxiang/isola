'use strict';

// Standalone, test-only Electron entrypoint. Never load the Isola main process
// or its data. Both native backends must use Chromium's in-memory fake Keychain.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {app,safeStorage}=require('electron');
const {createAsyncCipher}=require('../src/safe-storage-async.cjs');

if(process.platform!=='darwin'||!app.commandLine.hasSwitch('use-mock-keychain')){
 console.error('This isolated macOS fixture requires --use-mock-keychain from process launch.');
 app.exit(2);
}else{
 const userData=fs.mkdtempSync(path.join(os.tmpdir(),'isola-cipher-fixture-'));
 app.setName('Isolated Cipher Native Fixture');
 app.setPath('userData',userData);
 app.setPath('sessionData',path.join(userData,'session'));
 const disabled=app.commandLine.getSwitchValue('disable-features').split(',').includes('UseKeychainKeyProvider');
 const mode=disabled?'provider-disabled':'provider-default';
 const reportPath=process.env.ISOLA_CIPHER_REPORT||path.join(userData,'report.json');
 const report={mode,electron:process.versions.electron,chromium:process.versions.chrome,mockKeychain:true,isolatedUserData:true,realCredentialsRead:false,checks:[]};
 const check=async(name,work)=>{const at=Date.now();await work();report.checks.push({name,passed:true,durationMs:Date.now()-at});};
 const immediate=()=>new Promise(resolve=>setImmediate(resolve));
 // The public mock password is Chromium's FakeKeychainV2 test value. This
 // produces a deterministic legacy v10 fixture without calling either backend.
 const legacyFixture=value=>{
  const key=crypto.pbkdf2Sync('mock_password','saltysalt',1003,16,'sha1');
  const cipher=crypto.createCipheriv('aes-128-cbc',key,Buffer.alloc(16,32));
  return Buffer.concat([Buffer.from('v10'),cipher.update(value,'utf8'),cipher.final()]);
 };
 app.whenReady().then(async()=>{
  const cipher=createAsyncCipher(safeStorage),values=['fixture-only value','fixture € 中文','fixture line one\nline two'];
  let timer;let beats=0,last=Date.now(),maxGapMs=0;
  try{
   await check('isolated test-only entrypoint uses the mock Keychain',()=>{
    assert.equal(app.commandLine.hasSwitch('use-mock-keychain'),true);
    assert.ok(app.getPath('userData').startsWith(path.join(os.tmpdir(),'isola-cipher-fixture-')));
    assert.equal(app.getName(),'Isolated Cipher Native Fixture');
   });
   timer=setInterval(()=>{const now=Date.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;beats++;},5);
   await check('native async availability returns a Promise after ready',async()=>{
    const pending=safeStorage.isAsyncEncryptionAvailable();assert.equal(typeof pending?.then,'function');assert.equal(await pending,true);
   });
   if(disabled){
    await check('disabled provider rejects async encryption without a sync fallback',async()=>{
     await assert.rejects(safeStorage.encryptStringAsync(values[0]));
    });
    await check('disabled provider rejects a valid mock legacy v10 without a sync fallback',async()=>{
     await assert.rejects(safeStorage.decryptStringAsync(legacyFixture(values[0])));
    });
    await check('production helper preserves unavailable credentials and reports a static error',async()=>{
     await assert.rejects(cipher.unsealAsync(legacyFixture(values[0]).toString('base64')),{code:'SECRET_STORAGE_UNAVAILABLE'});
     await assert.rejects(cipher.sealAsync(values[0]),{code:'SECRET_STORAGE_UNAVAILABLE'});
    });
   }else{
    await check('native async decrypt reads legacy synchronous ciphertext',async()=>{
     for(const value of values){const old=safeStorage.encryptString(value),result=await safeStorage.decryptStringAsync(old);assert.equal(result.result,value);assert.equal(typeof result.shouldReEncrypt,'boolean');}
     assert.equal((await safeStorage.decryptStringAsync(legacyFixture(values[0]))).result,values[0]);
    });
    await check('legacy synchronous consumer reads native async ciphertext',async()=>{
     for(const value of values)assert.equal(safeStorage.decryptString(await safeStorage.encryptStringAsync(value)),value);
    });
    await check('production helper interoperates with legacy and native async consumers',async()=>{
     for(const value of values){assert.equal(await cipher.unsealAsync(safeStorage.encryptString(value).toString('base64')),value);const saved=await cipher.sealAsync(value);assert.equal(safeStorage.decryptString(Buffer.from(saved,'base64')),value);assert.equal(await cipher.unsealAsync(saved),value);}
    });
    await check('malformed native ciphertext rejects without a successful plaintext result',async()=>{
     await assert.rejects(safeStorage.decryptStringAsync(Buffer.from('not-encrypted-fixture')));
     await assert.rejects(cipher.unsealAsync(Buffer.from('not-encrypted-fixture').toString('base64')),{code:'SECRET_STORAGE_UNAVAILABLE'});
    });
    await check('concurrent async roundtrips yield to the Electron event loop',async()=>{
     for(let batch=0;batch<30;batch++){
      await Promise.all(values.map(async value=>assert.equal(await cipher.unsealAsync(await cipher.sealAsync(value)),value)));
      await immediate();
     }
    });
   }
   await check('event loop heartbeat runs alongside the async fixture',async()=>{
    const at=Date.now();while(Date.now()-at<35)await immediate();assert.ok(beats>0);assert.ok(maxGapMs<2000);report.heartbeat={beats,maxGapMs};
   });
   report.passed=report.checks.length;report.failed=0;
   fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
   console.log(JSON.stringify({mode,passed:report.passed,failed:0,mockKeychain:true,realCredentialsRead:false,reportPath}));
   clearInterval(timer);app.exit(0);
  }catch(error){
   if(timer)clearInterval(timer);report.passed=report.checks.length;report.failed=1;report.error={name:error.name,code:error.code||'FIXTURE_FAILED'};
   fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
   console.error(JSON.stringify({mode,passed:report.passed,failed:1,reportPath}));app.exit(1);
  }
 });
}
