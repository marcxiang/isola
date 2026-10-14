'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

module.exports=async function commerceDashboardSmoke(_api,check){
  const {BrowserWindow}=require('electron');
  const fixture={settings:{backgroundEnabled:true,maxConcurrent:2},connection:{status:'connected'},readiness:{vinted:'unverified'},running:false,
    profiles:[{id:'paris',name:'Paris A'},{id:'lyon',name:'Lyon B'}],
    products:[{id:'vacuum',name:'吸尘器配件',sku:'VAC-01'},{id:'scarf',name:'丝巾',sku:'SCARF-02'},{id:'bag',name:'手提袋',sku:'BAG-03'}],
    plans:[{id:'unpublished',productId:'vacuum',profileId:'paris',name:'吸尘器配件',sku:'VAC-01',enabled:true,status:'listed',listingPriceCents:500,minOfferCents:300,targetCount:2,completedCount:0},
      {id:'listed',productId:'vacuum',profileId:'lyon',name:'吸尘器配件',sku:'VAC-01',enabled:true,listingPriceCents:650,minOfferCents:450,targetCount:4,completedCount:1,activeListingId:'12345',activeListingUrl:'https://www.vinted.fr/items/12345-fixture'},
      {id:'review',productId:'scarf',profileId:'paris',name:'丝巾',sku:'SCARF-02',enabled:true,listingPriceCents:1800,minOfferCents:1400,targetCount:3,completedCount:1}],
    jobs:[{id:'task-review',planId:'review',productId:'scarf',profileId:'paris',type:'fulfillment',state:'uncertain',step:'create_supplier_order',error:'采购请求结果未知，请核对原订单。',updatedAt:'2026-10-13T18:02:00Z'},
      {id:'task-old',planId:'unpublished',productId:'vacuum',profileId:'paris',type:'listing',state:'completed',step:'record_listing',updatedAt:'2026-10-13T17:02:00Z'}],
    photoSets:[],photoPreparations:[],events:[]};
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-dashboard-fixture-'));
  const preload=path.join(dir,'preload.cjs');
  fs.writeFileSync(preload,`const {contextBridge}=require('electron');let state=${JSON.stringify(fixture)},listener,calls=[],block='',release;const methods={};for(const name of ['openListing','openActiveListing','inspectAccount','inspectPublication','setPlanEnabled','prepareDraft','preflight','inspectPhotos','preparePhotos','photoPreview','uploadPhotos','savePlan','saveSettings','setRunning','runOnce','sync','connect','resolve'])methods[name]=async(...args)=>{calls.push({name,args});if(name===block)await new Promise(r=>release=r);if(name==='inspectAccount')return {account:{username:'fixture_seller'}};if(name==='inspectPublication')return {checks:[{name:'上传照片',ok:false,detail:'当前页面缺少照片回执'}],blockers:['请先上传并核对照片'],readyForPublication:false,publicationEnabled:false,published:false,saved:false};return {};};contextBridge.exposeInMainWorld('commerce',{...methods,state:async()=>state,onState:fn=>listener=fn});contextBridge.exposeInMainWorld('dashboardFixture',{update:value=>{state=value;listener?.(state);},calls:()=>calls,block:name=>{block=name;},release:()=>{block='';release?.();}});`);
  const window=new BrowserWindow({show:false,width:1360,height:940,webPreferences:{preload,contextIsolation:true,sandbox:true,nodeIntegration:false,partition:`dashboard-fixture-${Date.now()}`}}),errors=[];
  window.webContents.on('console-message',event=>{if(event.level==='error'||event.details?.level==='error')errors.push(event.message||event.details?.message);});
  const js=code=>window.webContents.executeJavaScript(code), frames=async()=>{window.show();window.focus();let timer;try{await Promise.race([js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'),new Promise(resolve=>{timer=setTimeout(resolve,500);})]);}finally{clearTimeout(timer);}};
  const update=async value=>{await js(`window.dashboardFixture.update(${JSON.stringify(value)})`);await frames();};
  const filter=async(id,value)=>{await js(`(()=>{const element=document.querySelector(${JSON.stringify('#'+id)});element.value=${JSON.stringify(value)};element.dispatchEvent(new Event(${JSON.stringify(id==='distribution-search'?'input':'change')},{bubbles:true}));})()`);await frames();};
  const visiblePlans=()=>js(`Array.from(document.querySelectorAll('#distribution-list [data-plan-id]'),row=>row.dataset.planId)`);
  try{
    await window.loadFile(path.resolve(__dirname,'../src/commerce.html'));await frames();
    await check('operations dashboard maps products to distinct environments and never treats enabled plans as published',async()=>{
      const result=await js(`({products:document.querySelectorAll('.distribution-product').length,rows:Array.from(document.querySelectorAll('.distribution-row'),row=>({id:row.dataset.planId,state:row.dataset.operation,text:row.innerText})),runner:document.querySelector('.operations-runner').innerText,node:typeof require})`);
      assert.equal(result.node,'undefined');assert.equal(result.products,3);assert.equal(result.rows.length,3);
      const pending=result.rows.find(row=>row.id==='unpublished'),listed=result.rows.find(row=>row.id==='listed'),review=result.rows.find(row=>row.id==='review');
      assert.equal(pending.state,'pending');assert.match(pending.text,/待发布 · 暂无回执/);assert.doesNotMatch(pending.text,/已有在售记录/);
      assert.match(pending.text,/Paris A/);assert.match(pending.text,/5,00/);assert.match(pending.text,/3,00/);assert.match(pending.text,/0 \/ 2/);
      assert.equal(listed.state,'listed');assert.match(listed.text,/Lyon B/);assert.match(listed.text,/12345/);assert.match(listed.text,/6,50/);assert.match(listed.text,/1 \/ 4/);
      assert.equal(review.state,'attention');assert.match(review.text,/采购请求结果未知/);assert.match(result.runner,/最多并行 2 个环境/);assert.match(result.runner,/尚未全部验证/);
      assert.deepEqual(errors,[]);return {products:result.products,environments:2,enabledWithoutReceipt:'pending',unknownResult:'attention'};
    });
    await check('operations filters combine SKU, environment and execution state and include unassigned products',async()=>{
      await filter('distribution-search','vac-01');assert.deepEqual(await visiblePlans(),['unpublished','listed']);
      await filter('distribution-profile','lyon');assert.deepEqual(await visiblePlans(),['listed']);
      await filter('distribution-status','pending');assert.deepEqual(await visiblePlans(),[]);
      await js(`document.querySelector('#distribution-reset').click()`);await filter('distribution-status','unassigned');assert.deepEqual(await visiblePlans(),[]);
      assert.match(await js(`document.querySelector('#distribution-list').innerText`),/手提袋/);assert.doesNotMatch(await js(`document.querySelector('#distribution-list').innerText`),/吸尘器配件/);
      await js(`document.querySelector('#distribution-reset').click()`);await filter('distribution-status','attention');assert.deepEqual(await visiblePlans(),['review']);
      await js(`document.querySelector('#distribution-reset').click()`);return {combinedFilters:true,unassignedIncluded:true};
    });
    await check('operations actual listing action only sends plan ID and blocks duplicate clicks while pending',async()=>{
      await js(`window.dashboardFixture.block('openActiveListing');Array.from(document.querySelectorAll('[data-plan-id="listed"] button')).find(button=>button.textContent==='查看在售商品').click()`);await frames();
      const pending=await js(`({calls:window.dashboardFixture.calls(),disabled:Array.from(document.querySelectorAll('[data-plan-id="listed"] button')).filter(button=>button.textContent==='查看在售商品'||button.textContent==='打开刊登页'||button.textContent==='编辑计划').every(button=>button.disabled)})`);
      assert.equal(pending.disabled,true);assert.deepEqual(pending.calls,[{name:'openActiveListing',args:['listed']}]);
      await js(`Array.from(document.querySelectorAll('[data-plan-id="listed"] button')).find(button=>button.textContent==='查看在售商品').click();window.dashboardFixture.release()`);await frames();
      assert.equal((await js(`window.dashboardFixture.calls()`)).length,1);return {onlyPlanId:true,pendingProtected:true};
    });
    await check('operations rejects mismatched, credential-bearing and off-origin listing receipt URLs',async()=>{
      const invalid=['javascript:alert(1)','https://www.vinted.fr.evil.invalid/items/12345','https://user:pass@www.vinted.fr/items/12345','https://www.vinted.fr/items/99999','https://www.vinted.fr/items/12345?token=x','http://www.vinted.fr/items/12345','https://www.vinted.fr/items/12345#other','https://www.vinted.fr:8443/items/12345'];
      for(const url of invalid){const changed=structuredClone(fixture);changed.plans[1].activeListingUrl=url;await update(changed);const rendered=await js(`({receipt:document.querySelector('[data-plan-id="listed"] .distribution-receipt')?.innerText,actions:Array.from(document.querySelectorAll('[data-plan-id="listed"] button'),button=>button.textContent)})`);assert.equal(rendered.receipt,undefined);assert.equal(rendered.actions.includes('查看在售商品'),false);}
      await update(fixture);return {invalidURLsRejected:invalid.length};
    });
    await check('operations task records remain scoped to selected plan until filter is cleared',async()=>{
      await js(`Array.from(document.querySelectorAll('[data-plan-id="review"] button')).find(button=>button.textContent==='任务记录').click()`);await frames();
      let result=await js(`({hidden:document.querySelector('#page-jobs').hidden,rows:document.querySelectorAll('#jobs tr').length,text:document.querySelector('#jobs').innerText,context:document.querySelector('#job-plan-context').innerText})`);
      assert.equal(result.hidden,false);assert.equal(result.rows,1);assert.match(result.text,/丝巾/);assert.match(result.context,/Paris A/);
      await js(`document.querySelector('#clear-job-plan').click()`);assert.equal(await js(`document.querySelectorAll('#jobs tr').length`),2);
      await js(`document.querySelector('[data-page="overview"]').click()`);return {scopedTasks:1,allTasks:2};
    });
    await check('operations editor preselects the chosen product and preserves its environment-specific prices',async()=>{
      await js(`Array.from(document.querySelectorAll('[data-plan-id="listed"] button')).find(button=>button.textContent==='编辑计划').click()`);
      const result=await js(`(()=>{const form=document.querySelector('#plan-form');return {open:document.querySelector('#plan-dialog').open,id:form.elements.id.value,product:form.elements.productId.value,profile:form.elements.profileId.value,price:form.elements.listingPrice.value,min:form.elements.minOffer.value,target:form.elements.targetCount.value};})()`);
      assert.deepEqual(result,{open:true,id:'listed',product:'vacuum',profile:'lyon',price:'6.50',min:'4.50',target:'4'});
      await js(`document.querySelector('#plan-dialog').close();Array.from(document.querySelectorAll('[data-product-id="bag"] button')).find(button=>button.textContent==='分配销售环境').click()`);
      assert.equal(await js(`document.querySelector('#plan-form').elements.productId.value`),'bag');await js(`document.querySelector('#plan-dialog').close()`);
      return {environmentPricesPreserved:true,unassignedProductSelected:true};
    });
    await check('operations account and publication checks keep unverified accounts explicit and never expose a publish action',async()=>{
      assert.match(await js(`document.querySelector('[data-plan-id="listed"] .distribution-account').innerText`),/账号未核对/);
      await js(`Array.from(document.querySelectorAll('[data-plan-id="listed"] button')).find(button=>button.textContent==='核对账号').click()`);await frames();
      const calls=await js(`window.dashboardFixture.calls()`);assert.deepEqual(calls[calls.length-1],{name:'inspectAccount',args:['listed']});
      assert.match(await js(`document.querySelector('[data-plan-id="listed"] .distribution-account').innerText`),/账号未核对/);
      const changed=structuredClone(fixture);changed.profiles[1].marketAccount={platform:'vinted-fr',username:'fixture_seller',verifiedAt:'2026-10-13T19:00:00Z'};await update(changed);
      assert.match(await js(`document.querySelector('[data-plan-id="listed"] .distribution-account').innerText`),/已核对账号：fixture_seller/);
      await js(`Array.from(document.querySelectorAll('[data-plan-id="listed"] button')).find(button=>button.textContent==='核对发布条件').click()`);await frames();
      const report=await js(`({open:document.querySelector('#preflight-dialog').open,title:document.querySelector('#preflight-title').innerText,body:document.querySelector('#preflight-detail').innerText,fillHidden:document.querySelector('#preflight-fill').hidden,buttons:Array.from(document.querySelectorAll('#preflight-dialog button'),button=>button.innerText)})`);
      assert.equal(report.open,true);assert.equal(report.title,'核对发布条件');assert.match(report.body,/当前页面缺少照片回执/);assert.match(report.body,/请先上传并核对照片/);assert.equal(report.fillHidden,true);assert.equal(report.buttons.includes('发布'),false);
      await js(`document.querySelector('#preflight-dialog').close()`);await update(fixture);
      return {unverifiedAccountExplicit:true,onlyReadOnlyChecks:true,publishButtonAbsent:true};
    });
    await check('operations recovers after state refresh and shows unresolved work before completed targets',async()=>{
      const changed=structuredClone(fixture);changed.plans[2].completedCount=3;changed.jobs[0].state='queued';changed.jobs[0].error='';await update(changed);
      assert.equal(await js(`document.querySelector('[data-plan-id="review"]').dataset.operation`),'pending');
      changed.jobs[0].state='completed';await update(changed);assert.equal(await js(`document.querySelector('[data-plan-id="review"]').dataset.operation`),'target_reached');
      changed.faulted=true;await update(changed);assert.equal(await js(`document.querySelector('[data-plan-id="listed"]').dataset.operation`),'attention');
      await update(fixture);window.setSize(1050,760);await frames();
      assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);assert.deepEqual(errors,[]);
      return {fulfillmentBeforeTarget:true,faultedStopsExecution:true,minimumWidthFits:true};
    });
  }finally{window.destroy();fs.rmSync(dir,{recursive:true,force:true});}
};
