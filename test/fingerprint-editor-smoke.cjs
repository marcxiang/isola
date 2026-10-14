'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async function(api,check){
 const manager=api.getManager();manager.show();manager.focus();const contents=manager.webContents,js=code=>contents.executeJavaScript(code);
 async function waitFor(expression){for(let i=0;i<80;i++){if(await js(expression))return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Editor condition timed out: '+expression);}
 let profile;const correctionProfiles=[];
 try{
  await check('environment editor exposes desktop and mobile systems with live validated previews',async()=>{
   await waitFor(`!!document.querySelector('#device-preset option[value=pixel7]')`);
   await js(`document.querySelector('#new').click();document.querySelector('#form [name=name]').value='QA Android editor';document.querySelector('#device-preset').value='pixel7';document.querySelector('#device-preset').dispatchEvent(new Event('change'));`);
   await waitFor(`document.querySelector('#fingerprint-preview-status').textContent.includes('配置已校验')`);
   const state=await js(`(()=>{const f=document.querySelector('#form').elements;return {systems:Array.from(f.operatingSystem.options).map(o=>o.value),os:f.operatingSystem.value,version:f.osVersion.value,architecture:f.architecture.value,width:f.width.value,height:f.height.value,dpr:f.deviceScaleFactor.value,touch:f.maxTouchPoints.value,mode:f.fingerprintMode.value,preview:document.querySelector('#fingerprint-preview').textContent,warnings:document.querySelector('#fingerprint-warnings').textContent,valid:document.querySelector('#form').checkValidity()};})()`);
   for(const os of ['native','windows','macos','linux','android','ios'])assert.ok(state.systems.includes(os));
   assert.equal(state.os,'android');assert.equal(state.architecture,'arm');assert.equal(state.width,'412');assert.equal(state.height,'915');assert.equal(state.dpr,'2.625');assert.equal(state.touch,'5');assert.equal(state.mode,'custom');assert.equal(state.valid,true);assert.match(state.preview,/Android/);assert.match(state.warnings,/GPU/);
   await Promise.race([js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'),new Promise(resolve=>setTimeout(resolve,500))]);await new Promise(resolve=>setTimeout(resolve,250));try{await contents.capturePage().then(image=>fs.writeFileSync(path.join(__dirname,'../test-artifacts/mobile-editor.png'),image.toPNG()));}catch(error){console.log('Optional editor screenshot unavailable: '+error.message);}return {systems:state.systems,validatedPreview:true};
  });
  await check('mobile configuration persists through the real manager save and edit bridge',async()=>{
   await js(`document.querySelector('#form [name=name]').value='QA Android editor';document.querySelector('#form').requestSubmit();`);
   await waitFor(`!document.querySelector('#editor').open`);profile=api.list().find(row=>row.name==='QA Android editor');assert.ok(profile);assert.equal(profile.operatingSystem,'android');assert.equal(profile.deviceScaleFactor,2.625);assert.equal(profile.screenWidth,412);assert.equal(profile.deviceModel,'Pixel 7');assert.equal(profile.maxTouchPoints,5);assert.equal(profile.hardwareConcurrency,8);
   await js(`Array.from(document.querySelectorAll('.row')).find(row=>row.textContent.includes('QA Android editor')).querySelectorAll('.actions>button')[1].click()`);
   assert.equal(await js(`document.querySelector('#form [name=operatingSystem]').value`),'android');assert.equal(await js(`document.querySelector('#form [name=deviceScaleFactor]').value`),'2.625');await js(`document.querySelector('#cancel').click()`);
  });
  await check('OS changes refresh dependent defaults and invalid preview cannot claim readiness',async()=>{
   await js(`document.querySelector('#new').click();const os=document.querySelector('#form [name=operatingSystem]');os.value='ios';os.dispatchEvent(new Event('change'));`);
   await waitFor(`document.querySelector('#fingerprint-preview-status').textContent.includes('配置已校验')`);assert.match(await js(`document.querySelector('#fingerprint-warnings').textContent`),/WebKit/);
   await js(`const v=document.querySelector('#form [name=osVersion]');v.value='invalid';v.dispatchEvent(new Event('input'));`);await waitFor(`document.querySelector('#fingerprint-preview-status').textContent.includes('需要调整')`);await js(`document.querySelector('#cancel').click()`);
  });
  await check('custom device identity survives switching to native and back before saving',async()=>{
   await js(`document.querySelector('#new').click();const p=document.querySelector('#device-preset');p.value='pixel7';p.dispatchEvent(new Event('change'));const f=document.querySelector('#form').elements;f.fingerprintMode.value='native';f.fingerprintMode.dispatchEvent(new Event('change'));f.fingerprintMode.value='custom';f.fingerprintMode.dispatchEvent(new Event('change'));`);
   assert.equal(await js(`document.querySelector('#form [name=operatingSystem]').value`),'android');assert.equal(await js(`document.querySelector('#form [name=deviceModel]').value`),'Pixel 7');await js(`document.querySelector('#cancel').click()`);
  });
  await check('native preset restores host mode and keeps independent network policy editable',async()=>{
   await js(`document.querySelector('#new').click();document.querySelector('#device-preset').value='native';document.querySelector('#device-preset').dispatchEvent(new Event('change'));`);
   const state=await js(`(()=>{const f=document.querySelector('#form').elements;return {mode:f.fingerprintMode.value,os:f.operatingSystem.value,uaDisabled:f.ua.disabled,touchDisabled:f.maxTouchPoints.disabled,rtcDisabled:f.webRTCPolicy.disabled};})()`);assert.equal(await js(`document.querySelector('#form [name=id]').value`),'');assert.equal(state.mode,'native');assert.equal(state.os,'native');assert.equal(state.uaDisabled,true);assert.equal(state.touchDisabled,true);assert.equal(state.rtcDisabled,false);await js(`document.querySelector('#cancel').click()`);
  });
  await check('native mode allows dormant invalid OS versions and mobile architectures to be corrected',async()=>{
   for(const scenario of [{preset:'windows',field:'osVersion',invalid:'12',corrected:'11'},{preset:'android',field:'architecture',invalid:'x86',corrected:'arm'}]){
    const name='QA native correction '+scenario.preset;
    await js(`(()=>{document.querySelector('#new').click();const preset=document.querySelector('#device-preset');preset.value=${JSON.stringify(scenario.preset)};preset.dispatchEvent(new Event('change'));const f=document.querySelector('#form').elements;f.name.value=${JSON.stringify(name)};f[${JSON.stringify(scenario.field)}].value=${JSON.stringify(scenario.invalid)};f.fingerprintMode.value='native';f.fingerprintMode.dispatchEvent(new Event('change'));})()`);
    await waitFor(`document.querySelector('#fingerprint-preview-status').textContent.includes('需要调整')`);
    assert.equal(await js(`document.querySelector('#form [name=${scenario.field}]').disabled`),false,scenario.field+' must be editable after main-process validation rejects dormant data');
    assert.equal(await js(`document.querySelector('#form [name=fingerprintMode]').value`),'native');
    await js(`(()=>{const field=document.querySelector('#form [name=${scenario.field}]');field.value=${JSON.stringify(scenario.corrected)};field.dispatchEvent(new Event('input'));document.querySelector('#form').requestSubmit();})()`);
    await waitFor(`!document.querySelector('#editor').open`);
    const saved=api.list().find(row=>row.name===name);assert.ok(saved);correctionProfiles.push(saved);assert.equal(saved.fingerprintMode,'native');assert.equal(saved.operatingSystem,scenario.preset);assert.equal(saved[scenario.field],scenario.corrected);
   }
   return {nativeModePreserved:true,dormantSettingsCorrectable:['Windows 12 → 11','Android x86 → ARM']};
  });
 }finally{await js(`document.querySelector('#editor').close()`);for(const saved of correctionProfiles)await api.deleteProfile(saved.id);if(profile)await api.deleteProfile(profile.id);}
};
