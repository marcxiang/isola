'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');

module.exports=async function withdrawalUISmoke(_api,check){
  const {BrowserWindow}=require('electron'),url='https://www.vinted.fr/items/10001-qa-fixture';
  const fixture={settings:{backgroundEnabled:false},connection:{status:'connected'},readiness:{vinted:'partial',salesOnly:true,capabilities:{publish:true}},running:false,configBusy:false,faulted:false,queue:{profiles:[]},accounts:[],jobs:[],events:[],photoSets:[],photoPreparations:[{planId:'recover',claimId:'qa-claim',ready:true,state:'ready',count:1,downloadedCount:1}],
    profiles:[{id:'qa-profile',name:'QA 环境',status:'closed',marketAccount:{platform:'vinted-fr',memberId:'101',username:'qa_seller',verifiedAt:'2026-10-14T00:00:00Z'}}],products:[{id:'qa-product',name:'QA 商品',sku:'QA-ONLY'}],
    plans:[{id:'recover',profileId:'qa-profile',productId:'qa-product',name:'QA 商品',sku:'QA-ONLY',enabled:true,listingPriceCents:500,minOfferCents:300,targetCount:2,completedCount:0,listingRevision:0}],
    publications:[{id:'qa-submission',planId:'recover',profileId:'qa-profile',productId:'qa-product',state:'uncertain',attemptCount:1,closedSale:false,closedWithdrawal:false,listingUrl:url}]};
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-withdrawal-ui-')),preload=path.join(dir,'preload.cjs');
  fs.writeFileSync(preload,`const {contextBridge}=require('electron');let state=${JSON.stringify(fixture)},listener,calls=[],hold=false,reject=false,wrong=false,release;const noOp=async()=>({});contextBridge.exposeInMainWorld('commerce',{state:async()=>state,onState:fn=>listener=fn,confirmDeletedListing:async(id,confirmation)=>{calls.push({method:'withdraw',id,confirmation});if(hold)await new Promise(resolve=>release=resolve);if(reject)throw Error('QA storage failure');if(!wrong){const record=state.publications.find(row=>row.id===confirmation.submissionId),plan=state.plans.find(row=>row.id===id);record.closedWithdrawal=true;plan.activeListingId=null;plan.activeListingUrl=null;plan.listingRevision=(plan.listingRevision||0)+1;state.jobs.push({id:'qa-relist-'+plan.listingRevision,planId:id,profileId:plan.profileId,productId:plan.productId,type:'listing',state:'queued',step:'pending'});}listener?.(state);return state;},setRunning:async enabled=>{calls.push({method:'running',enabled});state.running=enabled;listener?.(state);return state;},submitPublication:async()=>{calls.push({method:'publish'});},openListing:async()=>{calls.push({method:'open'});},openActiveListing:noOp,inspectAccount:noOp,preflight:noOp,prepareDraft:noOp,inspectPhotos:noOp,preparePhotos:noOp,photoPreview:noOp,uploadPhotos:noOp,saveSettings:noOp,savePlan:noOp,setPlanEnabled:noOp,runOnce:noOp,sync:noOp,connect:noOp,resolve:noOp});contextBridge.exposeInMainWorld('withdrawalFixture',{update:value=>{state=value;listener?.(state);},hold:value=>hold=value,reject:value=>reject=value,wrong:value=>wrong=value,release:()=>{hold=false;release?.();},calls:()=>calls,reset:()=>{calls=[];hold=false;reject=false;wrong=false;}});`);
  const window=new BrowserWindow({show:false,width:1360,height:940,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'withdrawal-ui-'+Date.now()}}),js=code=>window.webContents.executeJavaScript(code);
  const frames=async()=>{window.show();window.focus();await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');};
  const update=async value=>{await js(`window.withdrawalFixture.update(${JSON.stringify(value)})`);await frames();};
  const reset=async()=>{await js(`document.querySelector('#publication-withdrawal-dialog').close();window.withdrawalFixture.reset()`);await update(fixture);};
  const open=async()=>{await js(`(()=>{document.querySelector('[data-page="plans"]').click();Array.from(document.querySelectorAll('.plan-card[data-listing-plan-id="recover"] button')).find(button=>button.textContent==='已删除，重新上架').click();})()`);await frames();};
  const confirm=async()=>{await js(`document.querySelector('#publication-withdrawal-confirmed').checked=true;document.querySelector('#publication-withdrawal-confirmed').dispatchEvent(new Event('input',{bubbles:true}))`);};
  const disabled=()=>js(`document.querySelector('#publication-withdrawal-submit').disabled`);
  try{
    await window.loadFile(path.resolve(__dirname,'../src/commerce.html'));await frames();
    await check('disabled background offers configuration with no implicit setting or scheduler change',async()=>{
      assert.deepEqual(await js(`({label:document.querySelector('#runner-toggle').textContent,disabled:document.querySelector('#runner-toggle').disabled})`),{label:'配置启动',disabled:false});
      await js(`document.querySelector('#runner-toggle').click()`);await frames();
      const state=await js(`({pageHidden:document.querySelector('#page-settings').hidden,guidance:document.querySelector('#background-setup-guidance').hidden,focused:document.activeElement.name,checked:document.querySelector('[name="backgroundEnabled"]').checked})`);
      assert.deepEqual(state,{pageHidden:false,guidance:false,focused:'backgroundEnabled',checked:false});assert.deepEqual(await js('window.withdrawalFixture.calls()'),[]);return {configurationReachable:true,noImplicitAuthorization:true};
    });
    await check('deletion recovery requires an exact original URL and explicit unsold confirmation',async()=>{
      await open();assert.equal(await disabled(),true);assert.equal(await js(`document.querySelector('#publication-withdrawal-url').value`),url);
      assert.match(await js(`document.querySelector('#publication-withdrawal-dialog').innerText`),/累计销量不会增加/);await confirm();assert.equal(await disabled(),false);
      for(const value of ['','http://www.vinted.fr/items/10001','https://example.com/items/10001','https://www.vinted.fr/items/10002','https://www.vinted.fr/items/10001?x=1','https://www.vinted.fr/items/10001#x']){await js(`document.querySelector('#publication-withdrawal-url').value=${JSON.stringify(value)};document.querySelector('#publication-withdrawal-url').dispatchEvent(new Event('input'))`);assert.equal(await disabled(),true,value);}
      assert.deepEqual(await js('window.withdrawalFixture.calls()'),[]);return {checkboxRequired:true,originalItemRequired:true};
    });
    await check('missing original URL remains empty and closed history never offers another relist',async()=>{
      await reset();const unknown=structuredClone(fixture);unknown.publications[0].listingUrl=null;await update(unknown);await open();await confirm();assert.equal(await js(`document.querySelector('#publication-withdrawal-url').value`),'');assert.equal(await disabled(),true);
      await js(`document.querySelector('#publication-withdrawal-url').value=${JSON.stringify(url)};document.querySelector('#publication-withdrawal-url').dispatchEvent(new Event('input'))`);assert.equal(await disabled(),false);
      for(const patch of [{closedWithdrawal:true},{closedSale:true},{state:'cancelled'},{state:'prepared'},{attemptCount:0},{attemptCount:2}]){await reset();const changed=structuredClone(fixture);Object.assign(changed.publications[0],patch);await update(changed);assert.equal(await js(`Array.from(document.querySelectorAll('.plan-card button')).some(button=>button.textContent==='已删除，重新上架')`),false,JSON.stringify(patch));}
      const duplicate=structuredClone(fixture);duplicate.publications.push({...duplicate.publications[0],id:'another'});await update(duplicate);assert.equal(await js(`Array.from(document.querySelectorAll('.plan-card button')).some(button=>button.textContent==='已删除，重新上架')`),false);return {noInventedURL:true,ambiguousRecordsBlocked:true,closedHistoryExcluded:true};
    });
    await check('plan, account, submission, scheduler and active work changes invalidate an open confirmation',async()=>{
      const mutations=[s=>s.plans[0].listingPriceCents=600,s=>s.profiles[0].marketAccount.memberId='102',s=>s.publications[0].id='replacement',s=>s.running=true,s=>s.configBusy=true,s=>s.faulted=true,s=>s.jobs.push({id:'active',planId:'recover',profileId:'qa-profile',type:'listing',state:'running'}),s=>s.queue={profiles:[{profileId:'qa-profile',state:'running'}]}];
      for(const mutate of mutations){await reset();await open();await confirm();assert.equal(await disabled(),false);const changed=structuredClone(fixture);mutate(changed);await update(changed);assert.equal(await disabled(),true);assert.match(await js(`document.querySelector('#publication-withdrawal-error').textContent`),/状态已改变/);await update(fixture);await confirm();assert.equal(await disabled(),true,'Restoring prior state must not restore consent');assert.deepEqual(await js('window.withdrawalFixture.calls()'),[]);}
      return {staleConsentNeverReused:true,activeWorkBlocked:true};
    });
    await check('deletion confirmation expires before dispatch',async()=>{
      await reset();await open();await confirm();await js(`window.qaOriginalNow=Date.now;Date.now=()=>window.qaOriginalNow()+180001;document.querySelector('#publication-withdrawal-confirmed').dispatchEvent(new Event('input'))`);
      assert.equal(await disabled(),true);assert.match(await js(`document.querySelector('#publication-withdrawal-error').textContent`),/确认已过期/);await js(`void(Date.now=window.qaOriginalNow)`);assert.deepEqual(await js('window.withdrawalFixture.calls()'),[]);return {expiryCheckedAtDispatch:true};
    });
    await check('single confirmed deletion preserves history and sales count while only queuing the relist',async()=>{
      await reset();await open();await confirm();await js(`window.withdrawalFixture.hold(true);document.querySelector('#publication-withdrawal-submit').click();document.querySelector('#publication-withdrawal-submit').click()`);await frames();
      assert.equal(await disabled(),true);assert.deepEqual(await js('window.withdrawalFixture.calls()'),[{method:'withdraw',id:'recover',confirmation:{submissionId:'qa-submission',listingURL:url,confirmed:true}}]);
      await js('window.withdrawalFixture.release()');await frames();assert.match(await js(`document.querySelector('#publication-withdrawal-result').textContent`),/已记录原商品删除并重新排队/);
      const state=await js('window.commerce.state()');assert.equal(state.publications.length,1);assert.equal(state.publications[0].closedWithdrawal,true);assert.equal(state.publications[0].state,'uncertain');assert.equal(state.plans[0].completedCount,0);assert.equal(state.plans[0].listingRevision,1);assert.equal(state.jobs[0].state,'queued');assert.deepEqual(state.photoPreparations,fixture.photoPreparations);
      assert.equal(await js(`document.querySelector('[data-plan-id="recover"]').dataset.operation`),'pending');assert.equal(await js(`document.querySelector('#readiness-next').hidden`),true);assert.equal((await js('window.withdrawalFixture.calls()')).length,1);return {oneRequest:true,historyPreserved:true,salesUnchanged:true,noPublishOrWindowOpen:true};
    });
    await check('rejected or unconfirmed recovery cannot be resent from the same dialog',async()=>{
      for(const mode of ['reject','wrong']){await reset();await open();await confirm();await js(`window.withdrawalFixture.${mode}(true);document.querySelector('#publication-withdrawal-submit').click()`);await frames();assert.equal(await disabled(),true);assert.match(await js(`document.querySelector('#publication-withdrawal-error').textContent`),mode==='reject'?/QA storage failure/:/返回记录需要重新核对/);await js(`document.querySelector('#publication-withdrawal-form').dispatchEvent(new Event('submit',{cancelable:true}));document.querySelector('#publication-withdrawal-submit').click()`);await frames();assert.equal((await js('window.withdrawalFixture.calls()')).length,1);}
      return {failedConfirmationConsumed:true,noAutomaticRetry:true};
    });
  }finally{window.destroy();fs.rmSync(dir,{recursive:true,force:true});}
};
