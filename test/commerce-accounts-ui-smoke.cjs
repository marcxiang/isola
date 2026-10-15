'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
function fixtureBridge(state,secret){
 const {contextBridge}=require('electron');let listener,serial=0,saveMode='success',releaseSave,holdLogin=false,releaseLogin;const calls=[],emit=()=>listener?.(state),account=id=>(state.accounts||[]).find(row=>row.id===id),noOp=async()=>({});
 contextBridge.exposeInMainWorld('commerce',{
  state:async()=>state,onState:fn=>listener=fn,
  saveAccount:async input=>{
   calls.push({method:'saveAccount',keys:Object.keys(input).sort(),id:input.id||null,profileId:input.profileId,passwordPresent:Object.hasOwn(input,'password'),passwordMatches:input.password===secret});
   if(saveMode==='hold')await new Promise(resolve=>releaseSave=resolve);
   if(saveMode==='reject')throw Error('Private fixture failure '+input.password);
   const existing=account(input.id),row={id:existing?.id||'account-'+(++serial),platform:'vinted',label:input.label,login:input.login,profileId:input.profileId,hasPassword:Object.hasOwn(input,'password')||existing?.hasPassword||false,identity:existing?.identity||null,status:existing?.status||'saved',lastResult:existing?.lastResult||null,lastLoginAt:existing?.lastLoginAt||null,createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
   if(!Array.isArray(state.accounts))state.accounts=[];if(existing)Object.assign(existing,row);else state.accounts.push(row);emit();return {account:row,message:'账号已保存。'};
  },
  loginAccount:async id=>{
   calls.push({method:'loginAccount',args:[id]});const row=account(id);row.status='logging_in';emit();if(holdLogin)await new Promise(resolve=>releaseLogin=resolve);
   row.status='awaiting_user';row.lastLoginAt=new Date().toISOString();row.lastResult={status:'awaiting_user',code:'LOGIN_SUBMITTED',message:'Do not show '+secret,at:row.lastLoginAt};emit();return {account:row,message:'请在窗口中手动完成验证，再核对登录。'};
  },
  openAccount:async id=>{calls.push({method:'openAccount',args:[id]});return {account:account(id),message:'已打开固定环境。'};},
  verifyAccount:async(id,options)=>{
   calls.push({method:'verifyAccount',args:[id,options]});const row=account(id);row.status='logged_in';row.identity={memberId:'12345',username:'fixture_vinted_user',profileURL:'https://www.vinted.fr/member/12345',verifiedAt:new Date().toISOString()};row.lastResult={status:'logged_in',code:'VERIFIED',message:'Private '+secret,at:row.identity.verifiedAt};emit();return {account:row,result:{verified:true,status:'logged_in'},message:'当前账号已核验。'};
  },
  deleteAccount:async id=>{calls.push({method:'deleteAccount',args:[id]});state.accounts=state.accounts.filter(row=>row.id!==id);emit();return {message:'本机账号记录已删除。'};},
  saveSettings:noOp,savePlan:noOp,openListing:noOp,openActiveListing:noOp,preflight:noOp,inspectAccount:noOp,inspectPublication:noOp,submitPublication:noOp,inspectPublishedListing:noOp,associatePublishedListing:noOp,prepareDraft:noOp,inspectPhotos:noOp,preparePhotos:noOp,photoPreview:noOp,uploadPhotos:noOp,setPlanEnabled:noOp,runOnce:noOp,setRunning:noOp,resolve:noOp,connect:noOp,sync:noOp
 });
 contextBridge.exposeInMainWorld('accountUIFixture',{calls:()=>calls,state:()=>state,saveMode:value=>saveMode=value,releaseSave:()=>{saveMode='success';releaseSave?.();},holdLogin:value=>holdLogin=value,releaseLogin:()=>{holdLogin=false;releaseLogin?.();}});
}
module.exports=async function accountsUISmoke(_api,check){
 const {BrowserWindow}=require('electron'),secret='Isola-UI-fixture-only-secret-73';
 const fixture={settings:{backgroundEnabled:false,maxConcurrent:1},connection:{status:'not_configured'},readiness:{vinted:'unverified'},running:false,profiles:[{id:'pixel-env',name:'Pixel 7 固定环境',status:'closed',operatingSystem:'android',deviceModel:'Pixel 7'},{id:'desktop-env',name:'Windows 固定环境',status:'closed',operatingSystem:'windows'}],products:[],photoSets:[],photoPreparations:[],plans:[],jobs:[],events:[],publications:[]};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-accounts-ui-')),preload=path.join(dir,'preload.cjs');
 fs.writeFileSync(preload,'('+fixtureBridge.toString()+')('+JSON.stringify(fixture)+','+JSON.stringify(secret)+');');
 const window=new BrowserWindow({show:false,width:1360,height:940,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:'accounts-ui-'+Date.now()}}),errors=[];
 window.webContents.on('console-message',event=>{if(event.level==='error'||event.details?.level==='error')errors.push(event.message||event.details?.message);});
 const js=code=>window.webContents.executeJavaScript(code),frames=async()=>{window.show();window.focus();let timer;try{await Promise.race([js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'),new Promise(resolve=>{timer=setTimeout(resolve,500);})]);}finally{clearTimeout(timer);}};
 const waitFor=async expression=>{for(let i=0;i<100;i++){if(await js(expression))return;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Accounts UI condition timed out: '+expression);};
 const calls=()=>js('window.accountUIFixture.calls()'),dto=()=>js('window.accountUIFixture.state()');
 const buttonCode=label=>'Array.from(document.querySelector(\'[data-account-id="account-1"]\').querySelectorAll("button")).find(button=>button.textContent==='+JSON.stringify(label)+')';
 const click=label=>js(buttonCode(label)+'.click()');
 const noSecret=async()=>{const observed=await js('({html:document.documentElement.outerHTML,text:document.body.innerText,values:Array.from(document.querySelectorAll("input")).map(input=>input.value)})');assert.ok(!JSON.stringify(observed).includes(secret),'Password must not appear in DOM, input values, errors or toasts after submission');};
 const formClosed='!document.querySelector("#account-dialog").open';
 try{
  await window.loadFile(path.resolve(__dirname,'../src/commerce.html'));await frames();await waitFor('document.querySelector("#sidebar-connection").textContent.includes("未配置")');
  await check('accounts page tolerates older state without accounts and works without supplier connection',async()=>{
   await js('document.querySelector("[data-page=accounts]").click()');assert.equal(await js('document.querySelector("#page-accounts").hidden'),false);assert.equal(await js('document.querySelector("#readiness").hidden'),true);assert.match(await js('document.querySelector("#accounts-list").textContent'),/添加 Vinted 账号/);assert.equal(await js('document.querySelector("#new-account").disabled'),false);assert.deepEqual(errors,[]);
  });
  await check('account creation sends a password only to save and immediately clears the input',async()=>{
   await js('document.querySelector("#new-account").click();const f=document.querySelector("#account-form").elements;f.label.value="QA 法国账号";f.login.value="fixture@example.test";f.profileId.value="pixel-env";f.password.value='+JSON.stringify(secret)+';document.querySelector("#account-form").requestSubmit();');
   await waitFor(formClosed);await noSecret();const data=await dto();assert.equal(data.accounts.length,1);assert.equal(data.accounts[0].hasPassword,true);assert.equal(Object.hasOwn(data.accounts[0],'password'),false);const sent=await calls();assert.equal(sent.length,1);assert.equal(sent[0].method,'saveAccount');assert.equal(sent[0].passwordPresent,true);assert.equal(sent[0].passwordMatches,true);assert.match(await js('document.querySelector("#accounts-list").textContent'),/Pixel 7/);
  });
  await check('editing with an empty password omits its property and preserves saved credentials',async()=>{
   await click('编辑');assert.equal(await js('document.querySelector("#account-form [name=password]").value'),'');assert.equal(await js('document.querySelector("#account-form [name=password]").autocomplete'),'new-password');await js('document.querySelector("#account-form [name=label]").value="QA 编辑账号";document.querySelector("#account-form").requestSubmit()');await waitFor(formClosed);
   const sent=await calls();assert.equal(sent.at(-1).passwordPresent,false);assert.ok(!sent.at(-1).keys.includes('password'));assert.equal((await dto()).accounts[0].hasPassword,true);await noSecret();
  });
  await check('a rejected save clears the password and never displays the raw failure',async()=>{
   await js('window.accountUIFixture.saveMode("reject")');await click('编辑');await js('document.querySelector("#account-form [name=password]").value='+JSON.stringify(secret)+';document.querySelector("#account-form").requestSubmit()');await waitFor('!document.querySelector("#account-error").hidden');assert.equal(await js('document.querySelector("#account-dialog").open'),true);assert.equal(await js('document.querySelector("#account-form [name=password]").value'),'');assert.match(await js('document.querySelector("#account-error").textContent'),/未保存/);await noSecret();await js('document.querySelector("#account-dialog").close();window.accountUIFixture.saveMode("success")');
  });
  await check('pending save prevents duplicate submissions while keeping the password input empty',async()=>{
   const before=(await calls()).filter(row=>row.method==='saveAccount').length;await js('window.accountUIFixture.saveMode("hold")');await click('编辑');await js('document.querySelector("#account-form [name=password]").value='+JSON.stringify(secret)+';document.querySelector("#account-form").requestSubmit();document.querySelector("#account-form").requestSubmit();');
   await waitFor('document.querySelector("#account-save").disabled');assert.equal((await calls()).filter(row=>row.method==='saveAccount').length,before+1);assert.equal(await js('document.querySelector("#account-form [name=password]").value'),'');await noSecret();await js('window.accountUIFixture.releaseSave()');await waitFor(formClosed);await noSecret();
  });
  await check('login is submitted once while manual takeover stays available and uncertain results need review',async()=>{
   await js('window.accountUIFixture.holdLogin(true)');await js('(()=>{const button='+buttonCode('打开并登录')+';button.click();button.click();})()');await waitFor('window.accountUIFixture.calls().filter(row=>row.method==="loginAccount").length===1');
   assert.equal(await js(buttonCode('手动接管')+'.disabled'),false);await click('手动接管');await waitFor('window.accountUIFixture.calls().some(row=>row.method==="openAccount")');await js('window.accountUIFixture.releaseLogin()');await waitFor('document.querySelector("#accounts-list").textContent.includes("需要手动接管")');assert.match(await js('document.querySelector("#accounts-list").textContent'),/不要重复提交/);await noSecret();
  });
  await check('current account verification requires visible confirmation and sends only id plus confirmCurrent',async()=>{
   await click('核对登录');assert.equal(await js('document.querySelector("#account-verify-dialog").open'),true);const summary=await js('document.querySelector("#account-verify-summary").textContent');assert.match(summary,/QA 编辑账号/);assert.match(summary,/fixture@example.test/);assert.match(summary,/Pixel 7/);assert.equal((await calls()).filter(row=>row.method==='verifyAccount').length,0);
   await js('document.querySelector("#account-verify-confirm").click()');await waitFor('!document.querySelector("#account-verify-dialog").open');const verified=(await calls()).find(row=>row.method==='verifyAccount');assert.deepEqual(verified.args,['account-1',{confirmCurrent:true}]);const text=await js('document.body.innerText');assert.match(text,/最近登录已核验/);assert.match(text,/fixture_vinted_user/);assert.match(text,/不代表账号持续在线/);await noSecret();
  });
  await check('account deletion is explicit and preserves other operations pages',async()=>{
   await click('删除');assert.equal((await calls()).filter(row=>row.method==='deleteAccount').length,0);await js('document.querySelector("#account-delete-confirm").click()');await waitFor('!document.querySelector("#account-delete-dialog").open');assert.equal((await dto()).accounts.length,0);await js('document.querySelector("[data-page=overview]").click()');assert.equal(await js('document.querySelector("#page-overview").hidden'),false);assert.equal(await js('document.querySelector("#readiness").hidden'),false);assert.deepEqual(errors,[]);
  });
 }finally{if(!window.isDestroyed())window.destroy();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});}
};
