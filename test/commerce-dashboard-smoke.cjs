'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {inspectQueue}=require('../src/commerce-scheduler.cjs');

module.exports=async function commerceDashboardSmoke(_api,check){
  const {BrowserWindow}=require('electron');
  const fixture={settings:{backgroundEnabled:true,maxConcurrent:2},connection:{status:'connected'},readiness:{vinted:'unverified'},running:false,faulted:false,configBusy:false,
    profiles:[{id:'paris',name:'Paris A',windowType:'automation'},{id:'lyon',name:'Lyon B',windowType:'automation'}],
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
  const selectEnvironment=async(id,page='overview')=>{await js(`(()=>{document.querySelector('[data-page="plans"]').click();if(!document.querySelector('#automation-environment-detail').hidden)document.querySelector('#environment-back').click();document.querySelector('[data-open-environment="${id}"]').click();})()`);await frames();assert.equal(await js(`!document.querySelector('#automation-environment-detail').hidden&&document.querySelector('#environment-title').textContent===${JSON.stringify(fixture.profiles.find(profile=>profile.id===id).name)}`),true);if(page!=='plans'){await js(`document.querySelector('[data-page="${page}"]').click()`);await frames();}};
  try{
    await window.loadFile(path.resolve(__dirname,'../src/commerce.html'));await frames();
    await check('operations dashboard maps products to distinct environments and never treats enabled plans as published',async()=>{
      const result=await js(`({products:document.querySelectorAll('.distribution-product').length,rows:Array.from(document.querySelectorAll('.distribution-row'),row=>({id:row.dataset.planId,state:row.dataset.operation,text:row.innerText})),runner:document.querySelector('.operations-runner').innerText,readiness:document.querySelector('#readiness-title').textContent,capabilities:document.querySelector('#readiness-capabilities').textContent,node:typeof require})`);
      assert.equal(result.node,'undefined');assert.equal(result.products,3);assert.equal(result.rows.length,3);
      assert.equal(result.readiness,'资料准备可用 · 后台业务待验证');
      for(const label of ['资料','照片','手动发布','原刊登','自动刊登','消息','报价','运单','采购'])assert.ok(result.capabilities.includes(label),'Missing readiness capability: '+label);
      const capabilityRows=await js(`Array.from(document.querySelectorAll('#readiness-capabilities li'),item=>item.textContent)`);
      assert.equal(capabilityRows.length,7);assert.match(capabilityRows[1],/手动发布.*未接通/);assert.match(capabilityRows[2],/原刊登关联.*未接通/);for(const row of capabilityRows.slice(3))assert.match(row,/待验证/);
      const pending=result.rows.find(row=>row.id==='unpublished'),listed=result.rows.find(row=>row.id==='listed'),review=result.rows.find(row=>row.id==='review');
      assert.equal(pending.state,'pending');assert.match(pending.text,/待发布 · 暂无回执/);assert.doesNotMatch(pending.text,/已有在售记录/);
      assert.match(pending.text,/Paris A/);assert.match(pending.text,/5,00/);assert.match(pending.text,/3,00/);assert.match(pending.text,/0 \/ 2/);
      assert.equal(listed.state,'listed');assert.match(listed.text,/Lyon B/);assert.match(listed.text,/12345/);assert.match(listed.text,/6,50/);assert.match(listed.text,/1 \/ 4/);
      assert.equal(review.state,'attention');assert.match(review.text,/采购请求结果未知/);assert.match(result.runner,/最多并行 2 个环境/);assert.match(result.runner,/自动业务尚未启用/);
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
      assert.equal(await js('document.querySelector("#plan-dialog").open'),false);await selectEnvironment('paris','plans');assert.equal(await js('document.querySelector("#plan-dialog").open'),true);
      assert.equal(await js(`document.querySelector('#plan-form').elements.productId.value`),'bag');await js(`document.querySelector('#plan-dialog').close()`);
      await js(`document.querySelector('[data-page="overview"]').click()`);
      return {environmentPricesPreserved:true,unassignedProductSelected:true};
    });
    await check('operations removes manual account verification while keeping publication receipts separate',async()=>{
      assert.match(await js(`document.querySelector('[data-plan-id="listed"] .distribution-account').innerText`),/执行时自动识别登录账号/);
      assert.equal(await js(`Array.from(document.querySelectorAll('[data-plan-id="listed"] button')).some(button=>button.textContent==='核对账号')`),false);
      assert.equal(await js(`window.dashboardFixture.calls().filter(row=>row.name==='inspectAccount').length`),0);
      const changed=structuredClone(fixture);changed.profiles[1].marketAccount={platform:'vinted-fr',username:'fixture_seller',verifiedAt:'2026-10-13T19:00:00Z'};await update(changed);
      assert.equal(await js(`document.querySelector('[data-plan-id="listed"] .distribution-account').innerText`),'保存身份：fixture_seller');
      await js(`Array.from(document.querySelectorAll('[data-plan-id="listed"] button')).find(button=>button.textContent==='核对发布条件').click()`);await frames();
      const report=await js(`({open:document.querySelector('#preflight-dialog').open,title:document.querySelector('#preflight-title').innerText,body:document.querySelector('#preflight-detail').innerText,fillHidden:document.querySelector('#preflight-fill').hidden,buttons:Array.from(document.querySelectorAll('#preflight-dialog button'),button=>button.innerText)})`);
      assert.equal(report.open,true);assert.equal(report.title,'核对发布条件');assert.match(report.body,/当前页面缺少照片回执/);assert.match(report.body,/请先上传并核对照片/);assert.equal(report.fillHidden,true);assert.equal(report.buttons.includes('发布'),false);
      await js(`document.querySelector('#preflight-dialog').close()`);await update(fixture);
      return {automaticIdentityHint:true,manualAccountCheckRemoved:true,publishButtonAbsent:true};
    });
    await check('operations recovers after state refresh and shows unresolved work before completed targets',async()=>{
      await selectEnvironment('paris');
      const changed=structuredClone(fixture);changed.plans[2].completedCount=3;changed.jobs[0].state='queued';changed.jobs[0].error='';await update(changed);
      assert.equal(await js(`document.querySelector('[data-plan-id="review"]').dataset.operation`),'pending');
      changed.jobs[0].state='completed';await update(changed);assert.equal(await js(`document.querySelector('[data-plan-id="review"]').dataset.operation`),'target_reached');
      changed.faulted=true;await update(changed);assert.equal(await js(`document.querySelector('[data-plan-id="listed"]').dataset.operation`),'attention');
      await update(fixture);
      assert.equal(await js(`document.querySelector('[data-plan-id="listed"]').dataset.operation`),'listed');
      assert.equal(await js(`Array.from(document.querySelectorAll('.plan-card[data-listing-plan-id="unpublished"] button')).find(button=>button.textContent==='核对发布条件').disabled`),false);
      window.setSize(1050,760);await frames();
      const width=await js('({viewport:innerWidth,total:document.documentElement.scrollWidth,overflow:Array.from(document.querySelectorAll("body *")).filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>({tag:e.tagName,id:e.id,classes:e.className,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width}))})');assert.equal(width.total<=width.viewport,true,JSON.stringify(width));assert.deepEqual(errors,[]);
      return {fulfillmentBeforeTarget:true,faultedStopsExecution:true,minimumWidthFits:true};
    });
    await check('listing plans route publication checks by stored plan ID without submitting or associating',async()=>{
      const before=(await js(`window.dashboardFixture.calls()`)).length;
      await selectEnvironment('paris','plans');await js(`(()=>{const card=document.querySelector('.plan-card[data-listing-plan-id="unpublished"]');Array.from(card.querySelectorAll('button')).find(button=>button.textContent==='核对发布条件').click();})()`);await frames();
      const result=await js(`({calls:window.dashboardFixture.calls(),open:document.querySelector('#preflight-dialog').open,title:document.querySelector('#preflight-title').textContent,text:document.querySelector('#preflight-detail').textContent})`);
      assert.deepEqual(result.calls.slice(before),[{name:'inspectPublication',args:['unpublished']}]);assert.equal(result.open,true);assert.equal(result.title,'核对发布条件');assert.match(result.text,/请先上传并核对照片/);
      assert.equal(result.calls.some(call=>['submitPublication','associatePublishedListing'].includes(call.name)),false);
      await js(`document.querySelector('#preflight-dialog').close()`);return {planOnlyInspection:true,publicationWrites:0,associationWrites:0};
    });
    await check('sales-only dashboard exposes each automatic capability independently of the global readiness label',async()=>{
      const changed=structuredClone(fixture);changed.readiness={vinted:'unverified',salesOnly:true,capabilities:{listingPublish:true,messages:false,offers:false,saleConfirmation:false,shippingLabel:true,procurement:true}};await update(changed);
      const before=(await js('window.dashboardFixture.calls()')).length;
      const result=await js(`({title:document.querySelector('#readiness-title').textContent,rows:Array.from(document.querySelectorAll('#readiness-capabilities li'),item=>item.textContent),runner:document.querySelector('#operations-runner-detail').textContent,plan:document.querySelector('[data-plan-id="unpublished"]').innerText,listed:document.querySelector('[data-plan-id="listed"]').innerText})`);
      assert.equal(result.title,'后台部分流程可用');assert.equal(result.rows.length,8);assert.ok(result.rows.some(row=>/自动刊登.*可用/.test(row)));
      for(const label of ['消息回复','报价接受','成交确认','卖出后补上'])assert.ok(result.rows.some(row=>row.includes(label)&&row.includes('待验证')),label);
      assert.doesNotMatch(result.rows.join(' '),/采购|运单/);assert.match(result.runner,/自动刊登：可用/);assert.match(result.runner,/成交确认：待验证/);
      assert.match(result.plan,/启动调度后检查库存、图片与刊登资料/);assert.doesNotMatch(result.plan,/后台自动刊登尚未启用/);assert.match(result.listed,/成交确认.*仍待验证/);
      assert.equal((await js('window.dashboardFixture.calls()')).length,before);return {globalUnverifiedAllowsReadyStage:true,unreadyStagesExplicit:4,externalActions:0};
    });
    await check('sales-only settings remove purchase controls and cannot restore old procurement actions',async()=>{
      const changed=structuredClone(fixture);changed.readiness={vinted:'unverified',salesOnly:true,capabilities:{listingPublish:true,messages:false,offers:false,saleConfirmation:false}};changed.settings={...changed.settings,perOrderLimitCents:2500,dailyLimitCents:10000,fulfillmentMethod:'self'};changed.jobs[0].canRetry=true;changed.jobs[0].result={externalId:'original-order'};await update(changed);
      await js(`document.querySelector('[data-page="settings"]').click()`);
      const settings=await js(`({title:document.querySelector('#execution-rules-title').textContent,hidden:Array.from(document.querySelectorAll('[data-purchase-control]')).every(item=>item.hidden),disabled:['perOrderLimit','dailyLimit','fulfillmentMethod'].every(name=>document.querySelector('#settings-form').elements[name].disabled),text:document.querySelector('#page-settings').innerText})`);
      assert.equal(settings.title,'后台售卖规则');assert.equal(settings.hidden,true);assert.equal(settings.disabled,true);assert.doesNotMatch(settings.text,/采购上限|货盘履约方式/);
      const before=(await js('window.dashboardFixture.calls()')).length;
      await js(`(()=>{const form=document.querySelector('#settings-form');form.elements.perOrderLimit.value='bad';form.elements.dailyLimit.value='999999';form.requestSubmit();})()`);await frames();
      const saved=(await js('window.dashboardFixture.calls()')).slice(before).find(call=>call.name==='saveSettings');assert.ok(saved);assert.equal(saved.args[0].perOrderLimitCents,0);assert.equal(saved.args[0].dailyLimitCents,0);assert.equal(saved.args[0].fulfillmentMethod,'self');
      await js(`document.querySelector('[data-page="jobs"]').click();Array.from(document.querySelectorAll('#jobs tr')).find(row=>row.innerText.includes('丝巾')).querySelector('button').click()`);await frames();
      const detail=await js(`({reconcileHidden:document.querySelector('#reconcile-form').hidden,retryHidden:document.querySelector('#retry-form').hidden,text:document.querySelector('#job-detail').textContent})`);
      assert.equal(detail.reconcileHidden,true);assert.equal(detail.retryHidden,true);assert.match(detail.text,/旧版的历史任务/);
      const beforeResolve=(await js('window.dashboardFixture.calls()')).length;
      await js(`document.querySelector('#reconcile-form').dispatchEvent(new Event('submit',{cancelable:true}));document.querySelector('#retry-form').dispatchEvent(new Event('submit',{cancelable:true}))`);await frames();assert.equal((await js('window.dashboardFixture.calls()')).length,beforeResolve);
      await js(`document.querySelector('#job-dialog').close()`);return {purchaseControlsHidden:true,purchaseCapsSavedAsZero:true,historicalActionsBlocked:true};
    });
    await check('readiness refresh revokes missing or false capabilities and restores legacy settings without stale flags',async()=>{
      const changed=structuredClone(fixture);changed.readiness={vinted:'verified',salesOnly:true,capabilities:{listingPublish:false,publish:true,messages:true,offers:false,saleConfirmation:true}};await update(changed);
      let rows=await js(`Array.from(document.querySelectorAll('#readiness-capabilities li'),item=>item.textContent)`);
      for(const label of ['自动刊登','报价接受','卖出后补上'])assert.ok(rows.some(row=>row.includes(label)&&row.includes('待验证')),label);
      for(const label of ['消息回复','成交确认'])assert.ok(rows.some(row=>row.includes(label)&&row.includes('可用')),label);
      changed.readiness={vinted:'verified',salesOnly:true};await update(changed);rows=await js(`Array.from(document.querySelectorAll('#readiness-capabilities li'),item=>item.textContent)`);for(const row of rows.slice(3))assert.match(row,/待验证/);
      await update(fixture);await js(`document.querySelector('[data-page="settings"]').click()`);
      const legacy=await js(`({hidden:Array.from(document.querySelectorAll('[data-purchase-control]')).some(item=>item.hidden),disabled:document.querySelector('#settings-form').elements.perOrderLimit.disabled,title:document.querySelector('#execution-rules-title').textContent,capabilities:document.querySelector('#readiness-capabilities').textContent})`);
      assert.equal(legacy.hidden,false);assert.equal(legacy.disabled,false);assert.equal(legacy.title,'执行与采购规则');assert.match(legacy.capabilities,/运单与采购/);assert.deepEqual(errors,[]);
      return {explicitFalseWins:true,staleCapabilitiesRevoked:true,legacyCompatible:true};
    });
    await check('queued jobs project real scheduler wait conditions into plan cards and task detail without changing job state',async()=>{
      await selectEnvironment('paris');
      const changed=structuredClone(fixture),at='2026-10-14T12:00:00.000Z';changed.readiness={vinted:'unverified',salesOnly:true,capabilities:{publish:true,listingPublish:true,messages:false,offers:false,saleConfirmation:false}};
      changed.profiles=changed.profiles.map(profile=>({...profile,status:profile.id==='paris'?'closed':'running'}));
      changed.jobs=[{id:'queued-wait',dedupeKey:'listing:unpublished:0',planId:'unpublished',productId:'vacuum',profileId:'paris',type:'listing',state:'queued',step:'pending',payload:{cycle:0},operation:null,mutationPending:false,result:null,updatedAt:at}];
      const project=()=>{const report=inspectQueue({...changed,requireVerifiedAccount:true,accounts:[],observedAccounts:[],maxConcurrent:2},{now:Date.parse(at)});changed.jobs[0].scheduling=report.jobs[0];assert.deepEqual(report.runnableJobIds,[]);assert.equal(changed.jobs[0].state,'queued');return report.jobs[0];};
      const before=(await js('window.dashboardFixture.calls()')).length;
      let scheduling=project();assert.equal(scheduling.reasonCode,'PROFILE_NOT_OPEN');await update(changed);await js(`document.querySelector('[data-page="overview"]').click()`);
      const planText=()=>js(`({state:document.querySelector('[data-plan-id="unpublished"]').dataset.operation,overview:document.querySelector('[data-plan-id="unpublished"]').textContent,plan:document.querySelector('.plan-card[data-listing-plan-id="unpublished"]').textContent})`);
      let shown=await planText();assert.equal(shown.state,'pending');for(const text of [shown.overview,shown.plan]){assert.ok(text.includes(scheduling.reason));assert.ok(text.includes(scheduling.nextAction));assert.match(text,/等待条件/);}
      await js(`Array.from(document.querySelectorAll('[data-plan-id="unpublished"] button')).find(button=>button.textContent==='任务记录').click();document.querySelector('#jobs button').click()`);await frames();
      let detail=await js(`document.querySelector('#job-detail').textContent`);assert.match(detail,/当前等待条件/);assert.ok(detail.includes(scheduling.reason));assert.ok(detail.includes(scheduling.nextAction));assert.match(detail,/待执行/);
      changed.profiles[0].status='running';scheduling=project();assert.equal(scheduling.reasonCode,'ACCOUNT_NOT_BOUND');await update(changed);
      shown=await planText();detail=await js(`document.querySelector('#job-detail').textContent`);for(const text of [shown.overview,shown.plan,detail]){assert.ok(text.includes(scheduling.reason));assert.ok(text.includes(scheduling.nextAction));assert.doesNotMatch(text,/该环境尚未就绪/);}assert.match(shown.overview,/等待核对/);
      changed.plans[0].enabled=false;scheduling=project();assert.equal(scheduling.reasonCode,'PLAN_PAUSED');await update(changed);shown=await planText();detail=await js(`document.querySelector('#job-detail').textContent`);for(const text of [shown.overview,shown.plan,detail]){assert.ok(text.includes(scheduling.reason));assert.ok(text.includes(scheduling.nextAction));}assert.match(shown.plan,/已暂停/);
      changed.plans[0].enabled=true;delete changed.jobs[0].scheduling;await update(changed);shown=await planText();detail=await js(`document.querySelector('#job-detail').textContent`);assert.equal(shown.state,'pending');assert.match(shown.plan,/启动调度后检查库存、图片与刊登资料/);assert.doesNotMatch(detail,/当前等待条件/);assert.doesNotMatch(shown.plan,/该销售计划已暂停|该环境尚未绑定/);
      assert.equal((await js('window.dashboardFixture.calls()')).length,before);await js(`document.querySelector('#job-dialog').close();document.querySelector('#clear-job-plan').click()`);await update(fixture);assert.deepEqual(errors,[]);
      return {schedulerReasons:['PROFILE_NOT_OPEN','ACCOUNT_NOT_BOUND','PLAN_PAUSED'],queuedStatePreserved:true,legacyWithoutScheduling:true,externalActions:0};
    });
    await check('automatic listing shows the closed-profile opening stage without asking for a manual launch',async()=>{
      await selectEnvironment('paris');
      const changed=structuredClone(fixture),at='2026-10-14T12:00:00.000Z';changed.readiness={vinted:'partial',salesOnly:true,capabilities:{publish:true,autoOpenProfile:true,messages:false,offers:false,saleConfirmation:false}};
      changed.profiles=changed.profiles.map(profile=>({...profile,status:'closed'}));
      changed.jobs=[{id:'auto-open-job',dedupeKey:'listing:unpublished:0',planId:'unpublished',productId:'vacuum',profileId:'paris',type:'listing',state:'queued',step:'pending',payload:{cycle:0},operation:null,mutationPending:false,result:null,updatedAt:at}];
      const report=inspectQueue({...changed,requireVerifiedAccount:true,accounts:[{platform:'vinted-fr',profileId:'paris',memberId:'123'}],observedAccounts:[],maxConcurrent:2},{now:Date.parse(at)});changed.jobs[0].scheduling=report.jobs[0];assert.deepEqual(report.runnableJobIds,['auto-open-job']);assert.equal(report.jobs[0].reasonCode,'PROFILE_AUTO_OPEN');
      const before=(await js('window.dashboardFixture.calls()')).length;await update(changed);await js(`document.querySelector('[data-page="overview"]').click()`);
      let shown=await js(`({message:document.querySelector('#readiness-message').textContent,overview:document.querySelector('[data-plan-id="unpublished"]').textContent,plan:document.querySelector('.plan-card[data-listing-plan-id="unpublished"]').textContent})`);
      assert.match(shown.message,/自动打开计划.*固定环境/);assert.doesNotMatch(shown.message,/读取实际登录账号|先核对.*账号|绑定用户名/);for(const text of [shown.overview,shown.plan]){assert.match(text,/等待自动打开/);assert.match(text,/启动调度后执行/);assert.match(text,/无需手动打开/);}
      await js(`Array.from(document.querySelectorAll('[data-plan-id="unpublished"] button')).find(button=>button.textContent==='任务记录').click();document.querySelector('#jobs button').click()`);await frames();assert.match(await js(`document.querySelector('#job-detail').textContent`),/下一步：自动打开环境/);
      changed.running=true;changed.jobs[0].state='running';changed.jobs[0].step='open_environment';changed.jobs[0].scheduling={state:'running',reasonCode:'OPERATION_ACTIVE'};await update(changed);
      for(const text of await js(`Array.from(document.querySelectorAll('[data-plan-id="unpublished"],.plan-card[data-listing-plan-id="unpublished"],#job-detail'),element=>element.textContent)`)){assert.match(text,/自动打开账号环境/);assert.doesNotMatch(text,/下一步：自动打开环境|等待自动打开/);}
      assert.equal((await js('window.dashboardFixture.calls()')).length,before);await js(`document.querySelector('#job-dialog').close();document.querySelector('#clear-job-plan').click()`);await update(fixture);assert.deepEqual(errors,[]);
      return {closedListingStage:true,runningStageLabel:true,externalActions:0};
    });
  }finally{window.destroy();fs.rmSync(dir,{recursive:true,force:true});}
};
