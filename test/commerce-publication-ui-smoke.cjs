'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

module.exports=async function publicationUISmoke(_api,check){
  const {BrowserWindow}=require('electron');
  const fixture={settings:{backgroundEnabled:false},connection:{status:'connected'},readiness:{vinted:'unverified'},running:false,publications:[],jobs:[],events:[],photoSets:[],
    profiles:[{id:'qa-profile',name:'QA 法国环境',marketAccount:{platform:'vinted-fr',memberId:'111',username:'qa_seller',verifiedAt:'2026-10-14T00:00:00Z'}}],
    products:[{id:'qa-product',name:'QA 吸尘器配件',sku:'QA-ONLY'}],
    photoPreparations:[],plans:[]};
  for(const id of ['success','reject','occupied','changed']){
    fixture.plans.push({id,profileId:'qa-profile',productId:'qa-product',sku:'QA-ONLY',name:'QA 吸尘器配件',enabled:true,currency:'EUR',listingPriceCents:500,minOfferCents:300,targetCount:2,completedCount:0,listing:{title:'QA Accessoire',description:'Fixture only',condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen',categoryPath:['Maison']}});
    fixture.photoPreparations.push({planId:id,claimId:'claim-'+id,state:'ready',ready:true,downloadedCount:1,count:1});
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-publication-ui-')),preload=path.join(dir,'preload.cjs');
  fs.writeFileSync(preload,`const {contextBridge}=require('electron');let state=${JSON.stringify(fixture)},listener,calls=[],ready=true,manual=true,hold=false,reject=false,release;const noOp=async()=>({});contextBridge.exposeInMainWorld('commerce',{state:async()=>state,onState:fn=>listener=fn,inspectPublication:async id=>({readyForPublication:ready,publicationEnabled:false,manualPublicationEnabled:manual,published:false,checks:[{name:'页面证据',ok:ready,detail:ready?'资料和照片已核对':'照片仍需核对'}],blockers:ready?[]:['照片仍需核对']}),submitPublication:async id=>{calls.push(id);if(hold)await new Promise(r=>release=r);if(reject)throw Error('Fixture IPC interrupted');return {submissionId:'submission-'+id,state:'uncertain',clickIssued:true,published:false,canRetry:false,navigationCandidate:{listingId:'999',url:'https://www.vinted.fr/items/999'},message:'已发送一次点击，需核对实际刊登页面。'};},openListing:noOp,openActiveListing:noOp,inspectAccount:noOp,preflight:noOp,prepareDraft:noOp,inspectPhotos:noOp,preparePhotos:noOp,photoPreview:noOp,uploadPhotos:noOp,saveSettings:noOp,savePlan:noOp,setRunning:noOp,setPlanEnabled:noOp,runOnce:noOp,sync:noOp,connect:noOp,resolve:noOp});contextBridge.exposeInMainWorld('publicationFixture',{update:value=>{state=value;listener?.(state);},ready:value=>{ready=value;},manual:value=>{manual=value;},hold:value=>{hold=value;},reject:value=>{reject=value;},release:()=>{hold=false;release?.();},calls:()=>calls});`);
  const window=new BrowserWindow({show:false,width:1360,height:940,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'publication-ui-'+Date.now()}});
  const js=code=>window.webContents.executeJavaScript(code),frames=async()=>{window.show();window.focus();let timer;try{await Promise.race([js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'),new Promise(resolve=>{timer=setTimeout(resolve,500);})]);}finally{clearTimeout(timer);}};
  const update=async value=>{await js(`window.publicationFixture.update(${JSON.stringify(value)})`);await frames();};
  const inspect=async id=>{await js(`(()=>{document.querySelector('#preflight-dialog').close();Array.from(document.querySelectorAll('[data-plan-id="${id}"] button')).find(button=>button.textContent==='核对发布条件').click();})()`);await frames();};
  try{
    await window.loadFile(path.resolve(__dirname,'../src/commerce.html'));await frames();
    await check('manual publication requires a successful review plus ready photos and a bound account',async()=>{
      assert.equal(await js(`document.querySelector('#publication-submit').hidden`),true);
      await js(`window.publicationFixture.ready(false)`);await inspect('changed');assert.equal(await js(`document.querySelector('#publication-submit').disabled`),true);
      await js(`window.publicationFixture.ready(true)`);await inspect('changed');assert.equal(await js(`document.querySelector('#publication-submit').disabled`),false);
      const changed=structuredClone(fixture);changed.photoPreparations.find(row=>row.planId==='changed').ready=false;await update(changed);assert.equal(await js(`document.querySelector('#publication-submit').disabled`),true);
      await update(fixture);changed.photoPreparations=structuredClone(fixture.photoPreparations);changed.profiles[0].marketAccount=null;await update(changed);assert.equal(await js(`document.querySelector('#publication-submit').disabled`),true);
      await update(fixture);await inspect('changed');assert.equal(await js(`document.querySelector('#publication-submit').disabled`),false);
      return {reviewRequired:true,photoReadinessRequired:true,accountRequired:true};
    });
    await check('an explicit disabled manual-publication capability blocks the action despite ready evidence',async()=>{
      await js(`window.publicationFixture.manual(false)`);await inspect('changed');
      assert.equal(await js(`document.querySelector('#publication-submit').disabled`),true);assert.match(await js(`document.querySelector('#publication-submission-result').innerText`),/尚未启用手动发布/);
      await js(`document.querySelector('#publication-submit').click()`);assert.deepEqual(await js(`window.publicationFixture.calls()`),[]);
      await js(`window.publicationFixture.manual(true)`);await inspect('changed');assert.equal(await js(`document.querySelector('#publication-submit').disabled`),false);
      return {explicitCapabilityGate:true};
    });
    await check('changing the plan invalidates the review until the current values are checked again',async()=>{
      const changed=structuredClone(fixture);changed.plans.find(row=>row.id==='changed').listingPriceCents=600;await update(changed);assert.equal(await js(`document.querySelector('#publication-submit').disabled`),true);
      await inspect('changed');assert.equal(await js(`document.querySelector('#publication-submit').disabled`),false);
      await update(fixture);return {staleReviewBlocked:true};
    });
    await check('manual publication sends only a plan ID once and preserves the unknown result on repeated inspection',async()=>{
      await inspect('success');await js(`window.publicationFixture.hold(true);document.querySelector('#publication-submit').click();document.querySelector('#publication-submit').click()`);await frames();
      assert.equal(await js(`document.querySelector('#publication-submit').disabled`),true);assert.deepEqual(await js(`window.publicationFixture.calls()`),['success']);
      await js(`window.publicationFixture.release()`);await frames();
      const result=await js(`document.querySelector('#publication-submission-result').innerText`);assert.match(result,/发布结果待核对/);assert.match(result,/submission-success/);assert.match(result,/没有已验证的发布成功回执/);assert.doesNotMatch(result,/已发布|发布成功。/);
      await inspect('success');assert.equal(await js(`document.querySelector('#publication-submit').disabled`),true);await js(`document.querySelector('#publication-submit').click()`);assert.deepEqual(await js(`window.publicationFixture.calls()`),['success']);
      assert.equal(await js(`document.querySelector('[data-plan-id="success"]').dataset.operation`),'attention');return {singleCall:true,publishedFalse:true,reinspectionDoesNotRetry:true};
    });
    await check('only the matching published receipt resolves an uncertain UI attempt and transitions the plan to listed',async()=>{
      const changed=structuredClone(fixture),plan=changed.plans.find(row=>row.id==='success');plan.activeListingId='999';plan.activeListingUrl='https://www.vinted.fr/items/999';
      changed.publications=[{id:'different-submission',planId:'success',profileId:'qa-profile',productId:'qa-product',state:'published',attemptCount:1,closedSale:false,listingUrl:'https://www.vinted.fr/items/999'}];await update(changed);
      assert.equal(await js(`document.querySelector('[data-plan-id="success"]').dataset.operation`),'attention');assert.match(await js(`document.querySelector('#publication-submission-result').innerText`),/发布结果待核对/);
      changed.publications[0].id='submission-success';await update(changed);
      assert.equal(await js(`document.querySelector('[data-plan-id="success"]').dataset.operation`),'listed');
      const result=await js(`document.querySelector('#publication-submission-result').innerText`);assert.match(result,/已核对发布成功/);assert.match(result,/在售商品编号：999/);assert.doesNotMatch(result,/结果待核对|没有已验证/);
      assert.doesNotMatch(await js(`document.querySelector('#preflight-detail').innerText`),/当前发布结果仍需核对/);assert.equal(await js(`document.querySelector('#publication-submit').disabled`),true);
      await inspect('success');assert.equal(await js(`document.querySelector('#publication-submit').disabled`),true);assert.match(await js(`document.querySelector('#publication-submission-result').innerText`),/已核对发布成功/);assert.deepEqual(await js(`window.publicationFixture.calls()`),['success']);
      await update(fixture);return {matchingReceiptRequired:true,publishedStateRecognized:true,existingListingStillBlocksRetry:true};
    });
    await check('publication IPC rejection remains visible and cannot be retried automatically',async()=>{
      await inspect('reject');await js(`window.publicationFixture.reject(true);document.querySelector('#publication-submit').click()`);await frames();
      assert.match(await js(`document.querySelector('#publication-submission-result').innerText`),/Fixture IPC interrupted/);assert.equal(await js(`document.querySelector('#publication-submit').disabled`),true);
      await inspect('reject');assert.equal(await js(`document.querySelector('#publication-submit').disabled`),true);assert.deepEqual(await js(`window.publicationFixture.calls()`),['success','reject']);await js(`window.publicationFixture.reject(false)`);
      return {errorVisible:true,noAutomaticRetry:true};
    });
    await check('saved noncancelled publication records block another submission',async()=>{
      const changed=structuredClone(fixture);changed.publications=[{id:'old-submission',planId:'occupied',profileId:'qa-profile',productId:'qa-product',state:'uncertain',attemptCount:1,closedSale:false,reason:'原提交等待核对'}];await update(changed);await inspect('occupied');
      assert.equal(await js(`document.querySelector('#publication-submit').disabled`),true);assert.match(await js(`document.querySelector('#publication-submission-result').innerText`),/old-submission/);
      assert.equal(await js(`document.querySelector('[data-plan-id="occupied"]').dataset.operation`),'attention');assert.deepEqual(await js(`window.publicationFixture.calls()`),['success','reject']);
      return {durableRecordBlocksRetry:true};
    });
  }finally{window.destroy();fs.rmSync(dir,{recursive:true,force:true});}
};
