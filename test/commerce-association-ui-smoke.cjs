'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

module.exports=async function associationUISmoke(_api,check){
  const {BrowserWindow}=require('electron');
  const fixture={settings:{backgroundEnabled:false},connection:{status:'connected'},readiness:{vinted:'unverified'},running:false,publications:[],jobs:[],events:[],photoSets:[],photoPreparations:[],
    profiles:[{id:'qa-environment',name:'QA 环境',marketAccount:{platform:'vinted-fr',memberId:'101',username:'qa_fixture_seller',verifiedAt:'2026-10-14T00:00:00Z'}}],products:[{id:'qa-product',name:'QA 商品',sku:'QA-ONLY'}],plans:[]};
  for(const [id,attemptCount,state] of [['success',1,'uncertain'],['failed',1,'uncertain'],['unattempted',0,'uncertain'],['prepared',1,'prepared']]){
    fixture.plans.push({id,profileId:'qa-environment',productId:'qa-product',name:'QA 商品',sku:'QA-ONLY',enabled:true,listingPriceCents:500,minOfferCents:300,targetCount:1,completedCount:0});
    fixture.publications.push({id:'submission-'+id,planId:id,profileId:'qa-environment',productId:'qa-product',state,attemptCount,closedSale:false});
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-association-ui-')),preload=path.join(dir,'preload.cjs');
  fs.writeFileSync(preload,`const {contextBridge}=require('electron');let state=${JSON.stringify(fixture)},listener,mode='ready',hold=false,reject=false,release,serial=0,calls=[];const noOp=async()=>({});contextBridge.exposeInMainWorld('commerce',{state:async()=>state,onState:fn=>listener=fn,inspectPublishedListing:async id=>{calls.push({method:'inspect',args:[id]});return {planId:id,submissionId:mode==='wrong'?'other-submission':'submission-'+id,reviewToken:mode==='no-token'?undefined:'qa-review-'+(++serial),listingId:'10001',url:'https://www.vinted.fr/items/10001-qa-fixture',checks:[{name:'商品归属',ok:mode!=='blocked',detail:mode==='blocked'?'账号仍需核对':'商品归属已核对'}],blockers:mode==='blocked'?['请核对商品归属']:[],readyForAssociation:mode!=='blocked',photoSignatureMatched:mode!=='blocked'&&mode!=='photo-mismatch',message:'请确认当前商品对应原提交。'};},associatePublishedListing:async(id,token)=>{calls.push({method:'associate',args:[id,token]});if(hold)await new Promise(r=>release=r);if(reject)throw Error('QA review token expired');state.publications.find(row=>row.planId===id).state='published';state.plans.find(row=>row.id===id).activeListingId='10001';listener?.(state);return {associated:true,listingId:'10001',url:'https://www.vinted.fr/items/10001-qa-fixture'};},submitPublication:async(...args)=>{calls.push({method:'publish',args});return {};},inspectPublication:noOp,openListing:noOp,openActiveListing:noOp,inspectAccount:noOp,preflight:noOp,prepareDraft:noOp,inspectPhotos:noOp,preparePhotos:noOp,photoPreview:noOp,uploadPhotos:noOp,saveSettings:noOp,savePlan:noOp,setRunning:noOp,setPlanEnabled:noOp,runOnce:noOp,sync:noOp,connect:noOp,resolve:noOp});contextBridge.exposeInMainWorld('associationFixture',{mode:value=>{mode=value;},hold:value=>{hold=value;},reject:value=>{reject=value;},release:()=>{hold=false;release?.();},calls:()=>calls});`);
  const window=new BrowserWindow({show:false,width:1360,height:940,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'association-ui-'+Date.now()}});
  const js=code=>window.webContents.executeJavaScript(code),frames=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const inspect=async id=>{await js(`(()=>{document.querySelector('#publication-association-dialog').close();Array.from(document.querySelectorAll('[data-plan-id="${id}"] button')).find(button=>button.textContent==='核对原刊登').click();})()`);await frames();};
  try{
    await window.loadFile(path.resolve(__dirname,'../src/commerce.html'));await frames();
    await check('original-listing review is offered only for uncertain single-attempt submissions',async()=>{
      const plans=await js(`Array.from(document.querySelectorAll('.distribution-row')).filter(row=>Array.from(row.querySelectorAll('button')).some(button=>button.textContent==='核对原刊登')).map(row=>row.dataset.planId)`);
      assert.deepEqual(plans,['success','failed']);assert.deepEqual(await js(`window.associationFixture.calls()`),[]);return {eligiblePlans:plans.length};
    });
    await check('read-only review shows checks and photo uncertainty while blockers prevent association',async()=>{
      await js(`window.associationFixture.mode('blocked')`);await inspect('success');
      const result=await js(`({text:document.querySelector('#publication-association-detail').innerText,disabled:document.querySelector('#publication-association-confirm').disabled})`);
      assert.match(result.text,/请核对商品归属/);assert.match(result.text,/尚未自动确认/);assert.equal(result.disabled,true);assert.doesNotMatch(result.text,/qa-review-/);
      assert.deepEqual(await js(`window.associationFixture.calls()`),[{method:'inspect',args:['success']}]);return {readOnly:true,photoUncertaintyVisible:true};
    });
    await check('association requires the matching submission and an opaque review token',async()=>{
      for(const mode of ['wrong','no-token','photo-mismatch']){await js(`window.associationFixture.mode(${JSON.stringify(mode)});document.querySelector('#publication-association-inspect').click()`);await frames();assert.equal(await js(`document.querySelector('#publication-association-confirm').disabled`),true);}
      assert.equal((await js(`window.associationFixture.calls()`)).some(call=>call.method==='associate'),false);return {wrongSubmissionRejected:true,missingTokenRejected:true,unmatchedPhotosRejected:true};
    });
    await check('explicit association sends only plan and token once and saves local association without publishing',async()=>{
      await js(`window.associationFixture.mode('ready');document.querySelector('#publication-association-inspect').click()`);await frames();
      const ready=await js(`({disabled:document.querySelector('#publication-association-confirm').disabled,confirmation:document.querySelector('#publication-association-confirmation').innerText,hidden:document.querySelector('#publication-association-confirmation').hidden})`);
      assert.equal(ready.disabled,false);assert.equal(ready.hidden,false);assert.match(ready.confirmation,/操作员确认/);assert.match(ready.confirmation,/当前商品对应这条原发布提交/);
      await js(`window.associationFixture.hold(true);document.querySelector('#publication-association-confirm').click();document.querySelector('#publication-association-confirm').click()`);await frames();
      let calls=await js(`window.associationFixture.calls()`),associations=calls.filter(call=>call.method==='associate');assert.equal(associations.length,1);assert.equal(associations[0].args.length,2);assert.equal(associations[0].args[0],'success');assert.match(associations[0].args[1],/^qa-review-\d+$/);assert.equal(await js(`document.querySelector('#publication-association-confirm').disabled`),true);
      await js(`window.associationFixture.release()`);await frames();assert.match(await js(`document.querySelector('#publication-association-detail').innerText`),/已保存本机关联/);assert.equal(await js(`document.querySelector('[data-plan-id="success"]').dataset.operation`),'listed');
      calls=await js(`window.associationFixture.calls()`);assert.equal(calls.some(call=>call.method==='publish'),false);return {oneAssociation:true,onlyPlanAndToken:true,publishCalls:0};
    });
    await check('expired association review cannot be resubmitted and a new read is required',async()=>{
      await inspect('failed');await js(`window.associationFixture.reject(true);document.querySelector('#publication-association-confirm').click()`);await frames();
      assert.match(await js(`document.querySelector('#publication-association-detail').innerText`),/QA review token expired/);assert.equal(await js(`document.querySelector('#publication-association-confirm').disabled`),true);
      const before=(await js(`window.associationFixture.calls()`)).filter(call=>call.method==='associate').length;await js(`document.querySelector('#publication-association-confirm').click()`);assert.equal((await js(`window.associationFixture.calls()`)).filter(call=>call.method==='associate').length,before);
      await js(`document.querySelector('#publication-association-inspect').click()`);await frames();assert.equal(await js(`document.querySelector('#publication-association-confirm').disabled`),false);
      await js(`document.querySelector('#publication-association-dialog').close()`);assert.equal((await js(`window.associationFixture.calls()`)).some(call=>call.method==='publish'),false);return {tokenConsumedOnFailure:true,readAgainRequired:true,noPublishOnFailure:true};
    });
  }finally{window.destroy();fs.rmSync(dir,{recursive:true,force:true});}
};
