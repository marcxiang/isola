'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const listing={title:'Fixture draft accessory',description:'Local renderer fixture only.',categoryPath:['Maison','Accessoires'],condition:'Très bon état',brand:'Sans marque',size:'',color:'Noir',parcel:'Moyen'};
const PLAN_REASON='计划已有任务记录（包括排队、失败或已取消）；不能删除原任务与去重记录，可先取消未提交任务或停用计划';
const PRODUCT_REASON='商品仍被上架计划使用；请先删除无业务记录的草稿计划，已有业务计划应停用并保留';

// Isolated renderer contract fixture: no production IPC, real data, images,
// external requests, scheduler, profile operations or filesystem deletion API.
function bridge(initial,planReason,productReason){
 const {contextBridge}=require('electron'),clone=value=>JSON.parse(JSON.stringify(value));let state=clone(initial),listener,mode='success',release;const calls=[],record=(name,args)=>calls.push({name,args:clone(args)}),emit=()=>listener?.(clone(state)),methods={};
 for(const name of ['saveSettings','connect','sync','saveProductListing','saveManualProduct','importProductPhotos','importSupplierPhotos','savePlan','saveAndStartPlan','startPlan','setRunning','setPlanEnabled','runOnce','openListing','openActiveListing','preflight','inspectAccount','inspectPublication','prepareDraft','inspectPhotos','preparePhotos','photoPreview','uploadPhotos','resolve','saveAccount','deleteAccount','loginAccount','verifyAccount','openAccount'])methods[name]=async(...args)=>{record(name,args);return {};};
 async function remove(name,id){
  record(name,[id]);if(mode==='hold')await new Promise(resolve=>release=resolve);
  if(mode==='invalid')return {deleted:'true',id};
  if(name==='deletePlan'){
   if(state.jobs.some(job=>job.planId===id))throw Error(planReason);
   state.plans=state.plans.filter(plan=>plan.id!==id);
  }else{
   if(state.plans.some(plan=>plan.productId===id))throw Error(productReason);
   const product=state.products.find(row=>row.id===id);if(product?.source!=='local')throw Error('货盘商品不能在本机删除');
   state.products=state.products.filter(product=>product.id!==id);state.productListings=state.productListings.filter(template=>template.productId!==id);
  }
  emit();return {deleted:true,id};
 }
 methods.deletePlan=id=>remove('deletePlan',id);methods.deleteManualProduct=id=>remove('deleteManualProduct',id);
 contextBridge.exposeInMainWorld('commerce',{...methods,state:async()=>clone(state),onState:fn=>listener=fn});
 contextBridge.exposeInMainWorld('deletionFixture',{
  calls:()=>clone(calls),state:()=>clone(state),mode:value=>mode=value,release:()=>{mode='success';release?.();release=null;},
  reset:()=>{state=clone(initial);mode='success';emit();},
  addJob:planId=>{const plan=state.plans.find(row=>row.id===planId);state.jobs.push({id:'new-history-job',planId,profileId:plan.profileId,productId:plan.productId,type:'listing',state:'queued',step:'pending'});emit();},
  removePlan:id=>{state.plans=state.plans.filter(plan=>plan.id!==id);emit();},
  linkProduct:id=>{const product=state.products.find(row=>row.id===id);state.plans.push({...clone(initial.plans[0]),id:'new-linked-plan',productId:id,sku:product.sku,name:product.name});emit();},
  busy:(key,value)=>{state[key]=value;emit();}
 });
}

module.exports=async function deletionUISmoke(_api,check){
 assert.ok(process.env.ISOLA_TEST_DATA,'Deletion UI fixture requires isolated application data');const {BrowserWindow}=require('electron');
 const products=[{id:'local-id',source:'local',sku:'LOCAL-UNUSED',name:'待删除的复用照片草稿',stock:2,priceCents:500,photoSetsAvailable:1,localPhotoCount:2,revision:1,origin:{kind:'supplier-reuse',setId:'original-used-set',productId:'supplier-id',sku:'SUPPLIER-001',status:'used',importedAt:'2026-10-15T12:00:00.000Z'}},{id:'local-linked-id',source:'local',sku:'LOCAL-LINKED',name:'已有关联计划的商品',stock:1,priceCents:500,photoSetsAvailable:0,localPhotoCount:0,revision:1},{id:'supplier-id',source:'supplier',sku:'SUPPLIER-001',name:'不可本机删除的货盘商品',stock:6,priceCents:100,photoSetsAvailable:0,revision:1}];
 const plan={id:'plan-id',profileId:'auto-id',productId:'local-linked-id',source:'local',sku:'LOCAL-LINKED',name:'待删除的上架草稿',enabled:false,status:'paused',targetCount:2,completedCount:0,listingRevision:0,activeListingId:null,listingPriceCents:500,minOfferCents:400,reuseOwnPhotos:true,listing,missingFields:[]};
 const initial={settings:{hasToken:false,backgroundEnabled:false,maxConcurrent:1,baseURL:'',perOrderLimitCents:0,dailyLimitCents:0,fulfillmentMethod:'self'},connection:{status:'not_configured'},readiness:{vinted:'partial',salesOnly:true,capabilities:{listingPublish:true,publish:true,autoOpenProfile:true,inspect:true}},running:false,runningPlanIds:[],faulted:false,configBusy:false,profiles:[{id:'auto-id',name:'固定自动化环境',windowType:'automation',status:'closed',operatingSystem:'android',deviceModel:'Pixel 7',marketAccount:null},{id:'normal-id',name:'普通环境',windowType:'normal',status:'closed'}],accounts:[],products,productListings:products.map(product=>({productId:product.id,sku:product.sku,listing,listingPriceCents:500,minOfferCents:400,missingFields:[]})),photoSets:[{id:'original-used-set',productId:'supplier-id',name:'原货盘已用套组',claimStatus:'used',claimedByMe:false,imageCount:2}],photoPreparations:[],plans:[plan,{...plan,id:'history-plan',productId:'supplier-id',source:'supplier',sku:'SUPPLIER-001',name:'保留任务历史的计划'}],jobs:[{id:'history-job',planId:'history-plan',profileId:'auto-id',productId:'supplier-id',type:'listing',state:'needs_review',step:'check_catalog',error:'原任务需要核对',canRetry:true}],events:[],publications:[]};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-deletion-ui-')),preload=path.join(dir,'preload.cjs');fs.writeFileSync(preload,'('+bridge.toString()+')('+JSON.stringify(initial)+','+JSON.stringify(PLAN_REASON)+','+JSON.stringify(PRODUCT_REASON)+');');
 const w=new BrowserWindow({show:false,width:1360,height:940,webPreferences:{preload,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false,partition:'deletion-ui-'+Date.now()}}),errors=[];
 w.webContents.on('console-message',(event,level,message)=>{const details=event.details||event,severity=typeof level==='number'?level:typeof level==='object'?level.level:details.level,value=typeof message==='string'?message:typeof level==='object'?level.message:details.message;if(severity===3||severity==='error')errors.push(String(value||'Renderer console error'));});
 const js=code=>w.webContents.executeJavaScript(code),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),calls=()=>js('window.deletionFixture.calls()'),state=()=>js('window.deletionFixture.state()'),count=async name=>(await calls()).filter(row=>row.name===name).length;
 async function until(read,label){const end=Date.now()+8000;while(Date.now()<end){if(await read())return;await pause(25);}throw Error('Deletion UI fixture timed out: '+label);}
 async function frames(){w.show();w.focus();let timer;try{await Promise.race([js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'),new Promise(resolve=>{timer=setTimeout(resolve,500);})]);}finally{clearTimeout(timer);}}
 const close=async()=>{await js('document.querySelector("#record-delete-dialog").close()');await frames();};
 async function reset(){await close();await js('window.deletionFixture.reset()');await frames();}
 async function openPlan(id='plan-id'){
  await js('document.querySelector("[data-page=plans]").click()');await until(()=>js('!!document.querySelector("[data-open-environment=auto-id]")'),'automation environment entry');await js('document.querySelector("[data-open-environment=auto-id]").click()');
  const selector='#plans [data-delete-plan-id="'+id+'"]';await until(()=>js('!!document.querySelector('+JSON.stringify(selector)+')'),'plan delete entry');await js('document.querySelector('+JSON.stringify(selector)+').click()');await until(()=>js('document.querySelector("#record-delete-dialog").open'),'plan confirmation');
 }
 async function openProduct(id='local-id'){
  await js('document.querySelector("[data-page=inventory]").click()');const selector='#products [data-delete-product-id="'+id+'"]';await until(()=>js('!!document.querySelector('+JSON.stringify(selector)+')'),'local product delete entry');await js('document.querySelector('+JSON.stringify(selector)+').click()');await until(()=>js('document.querySelector("#record-delete-dialog").open'),'product confirmation');
 }
 async function assertNoExecution(){assert.deepEqual((await calls()).filter(row=>!['deletePlan','deleteManualProduct'].includes(row.name)),[]);}
 const confirm=()=>js('document.querySelector("#record-delete-confirm").click()');
 try{
  await w.loadFile(path.resolve(__dirname,'../src/commerce.html'));await until(()=>js('!!document.querySelector("[data-open-environment=auto-id]")'),'initial automation environment');await frames();
  await check('plan deletion requires an explicit confirmation and cancelling sends no API request',async()=>{
   await openPlan();assert.equal(await js('typeof require'),'undefined');assert.match(await js('document.querySelector("#record-delete-title").textContent'),/删除.*计划/);assert.match(await js('document.querySelector("#record-delete-summary").textContent'),/待删除的上架草稿.*LOCAL-LINKED.*固定自动化环境/);assert.match(await js('document.querySelector("#record-delete-note").textContent'),/任务.*照片.*原提交/);assert.deepEqual(await calls(),[]);
   await js('Array.from(document.querySelectorAll("#record-delete-dialog [data-close]")).find(button=>button.textContent==="取消").click()');await until(()=>js('!document.querySelector("#record-delete-dialog").open'),'cancel closes dialog');assert.deepEqual(await calls(),[]);assert.equal((await state()).plans.length,2);return {confirmationRequired:true,cancelRequests:0,originalPlans:2};
  });
  await check('one deferred plan confirmation suppresses repeated clicks and refreshes the removed draft only after success',async()=>{
   await reset();await openPlan();const before=await count('deletePlan');await js('(()=>{window.deletionFixture.mode("hold");const b=document.querySelector("#record-delete-confirm");b.click();b.click();b.dispatchEvent(new MouseEvent("click",{bubbles:true}));})()');await until(async()=>await count('deletePlan')===before+1&&await js('document.querySelector("#record-delete-confirm").disabled'),'deletion pending');
   assert.equal(await js('document.querySelector("#record-delete-dialog").open'),true);assert.equal((await state()).plans.length,2);assert.equal(await js('Array.from(document.querySelectorAll("[data-delete-plan-id],[data-delete-product-id]")).every(button=>button.disabled)'),true);assert.equal(await js('document.querySelector("#new-plan").disabled'),true);
   await js('window.deletionFixture.release()');await until(()=>js('!document.querySelector("#record-delete-dialog").open&&!document.querySelector("#plans [data-delete-plan-id=plan-id]")'),'deleted plan removed');assert.equal(await count('deletePlan'),before+1);assert.deepEqual((await calls()).filter(row=>row.name==='deletePlan').at(-1).args,['plan-id']);assert.equal((await state()).plans[0].id,'history-plan');await assertNoExecution();return {deleteCalls:1,idOnly:true,pendingLocked:true,refreshedAfterSuccess:true};
  });
  await check('a plan with task history keeps the original backend rejection visible in its open confirmation dialog',async()=>{
   await reset();await openPlan('history-plan');const before=await count('deletePlan'),snapshot=await state();await confirm();await until(()=>js('!document.querySelector("#record-delete-error").hidden&&!document.querySelector("#record-delete-confirm").disabled'),'history rejection visible');assert.equal(await count('deletePlan'),before+1);assert.equal(await js('document.querySelector("#record-delete-dialog").open'),true);assert.equal(await js('document.querySelector("#record-delete-error").textContent'),PLAN_REASON);assert.deepEqual(await state(),snapshot);await assertNoExecution();return {reasonPreserved:true,dialogRetained:true,historyRemoved:false};
  });
  await check('a transport response without boolean deleted true cannot close confirmation or remove a record',async()=>{
   await reset();await openPlan();await js('window.deletionFixture.mode("invalid")');await confirm();await until(()=>js('!document.querySelector("#record-delete-error").hidden'),'invalid receipt error');assert.equal(await js('document.querySelector("#record-delete-dialog").open'),true);assert.match(await js('document.querySelector("#record-delete-error").textContent'),/未收到.*删除成功回执/);assert.equal((await state()).plans.length,2);await assertNoExecution();return {strictBooleanReceipt:true,dialogRetained:true};
  });
  await check('a new associated job invalidates the plan review before confirmation and sends no stale delete request',async()=>{
   await reset();await openPlan();const before=await count('deletePlan');await js('window.deletionFixture.addJob("plan-id")');assert.equal(await js('document.querySelector("#record-delete-confirm").disabled'),true);assert.match(await js('document.querySelector("#record-delete-error").textContent'),/关联状态已改变/);await js('document.querySelector("#record-delete-confirm").dispatchEvent(new MouseEvent("click",{bubbles:true}))');assert.equal(await count('deletePlan'),before);assert.equal((await state()).plans.length,2);assert.equal((await state()).jobs.length,2);return {changedAssociationInvalidates:true,staleRequests:0};
  });
  await check('a plan removed by a state refresh invalidates the original deletion target',async()=>{
   await reset();await openPlan();const before=await count('deletePlan');await js('window.deletionFixture.removePlan("plan-id")');assert.equal(await js('document.querySelector("#record-delete-confirm").disabled'),true);assert.match(await js('document.querySelector("#record-delete-error").textContent'),/记录或关联状态已改变/);await confirm();assert.equal(await count('deletePlan'),before);assert.equal((await state()).plans[0].id,'history-plan');return {missingTargetInvalidates:true,otherPlanDeleted:false};
  });
  await check('only local product cards offer deletion and cancelling their confirmation creates no product write',async()=>{
   await reset();await openProduct();const before=await count('deleteManualProduct');assert.equal(await js('document.querySelectorAll("[data-delete-product-id=supplier-id]").length'),0);assert.match(await js('document.querySelector("#record-delete-title").textContent'),/删除手动商品/);assert.match(await js('document.querySelector("#record-delete-summary").textContent'),/待删除的复用照片草稿.*LOCAL-UNUSED/);assert.match(await js('document.querySelector("#record-delete-note").textContent'),/货盘原商品.*使用记录保留/);await close();assert.equal(await count('deleteManualProduct'),before);assert.equal((await state()).products.length,3);return {supplierDeleteEntry:false,localCancellationCalls:0};
  });
  await check('a local product still linked to a plan cannot be removed and retains the actionable backend reason',async()=>{
   await reset();await openProduct('local-linked-id');const before=await count('deleteManualProduct'),snapshot=await state();await confirm();await until(()=>js('!document.querySelector("#record-delete-error").hidden&&!document.querySelector("#record-delete-confirm").disabled'),'linked product rejection');assert.equal(await count('deleteManualProduct'),before+1);assert.equal(await js('document.querySelector("#record-delete-dialog").open'),true);assert.equal(await js('document.querySelector("#record-delete-error").textContent'),PRODUCT_REASON);assert.deepEqual(await state(),snapshot);await assertNoExecution();return {linkedPlanPreserved:true,productRemoved:false,exactReasonVisible:true};
  });
  await check('one local product delete confirmation removes only its local card and template after the deferred acknowledgement',async()=>{
   await reset();await openProduct();const before=await count('deleteManualProduct'),snapshot=await state();await js('(()=>{window.deletionFixture.mode("hold");const b=document.querySelector("#record-delete-confirm");b.click();b.click();})()');await until(async()=>await count('deleteManualProduct')===before+1&&await js('document.querySelector("#record-delete-confirm").disabled'),'local delete pending');assert.equal((await state()).products.length,3);await js('window.deletionFixture.release()');await until(()=>js('!document.querySelector("#record-delete-dialog").open&&!document.querySelector("#products [data-delete-product-id=local-id]")'),'local card disappears');
   const current=await state();assert.equal(await count('deleteManualProduct'),before+1);assert.deepEqual((await calls()).filter(row=>row.name==='deleteManualProduct').at(-1).args,['local-id']);assert.deepEqual(current.products.find(row=>row.id==='supplier-id'),snapshot.products.find(row=>row.id==='supplier-id'));assert.deepEqual(current.photoSets,snapshot.photoSets);assert.deepEqual(current.plans,snapshot.plans);assert.equal(current.productListings.some(row=>row.productId==='local-id'),false);assert.equal(current.products.length,2);await assertNoExecution();return {localOnly:true,supplierOccupancyPreserved:true,templateRemoved:true,deleteCalls:1};
  });
  await check('a plan linked after product confirmation invalidates its review and blocks deletion before the API call',async()=>{
   await reset();await openProduct();const before=await count('deleteManualProduct');await js('window.deletionFixture.linkProduct("local-id")');assert.equal(await js('document.querySelector("#record-delete-confirm").disabled'),true);assert.match(await js('document.querySelector("#record-delete-error").textContent'),/关联状态已改变/);await confirm();assert.equal(await count('deleteManualProduct'),before);assert.equal((await state()).products.length,3);assert.equal((await state()).plans.length,3);return {newProductPlanInvalidates:true,staleRequests:0};
  });
  await check('running, busy configuration or storage fault disables deletion without clearing the current review',async()=>{
   await reset();await openPlan();const before=await count('deletePlan');for(const key of ['running','configBusy','faulted']){await js('window.deletionFixture.busy('+JSON.stringify(key)+',true)');assert.equal(await js('document.querySelector("#record-delete-confirm").disabled'),true);assert.equal(await js('document.querySelector("#record-delete-dialog").open'),true);await js('document.querySelector("#record-delete-confirm").dispatchEvent(new MouseEvent("click",{bubbles:true}))');assert.equal(await count('deletePlan'),before);await js('window.deletionFixture.busy('+JSON.stringify(key)+',false)');assert.equal(await js('document.querySelector("#record-delete-confirm").disabled'),false);}assert.equal((await state()).plans.length,2);await assertNoExecution();assert.deepEqual(errors,[]);return {busyStates:3,deleteRequests:0,reviewPreserved:true,rendererErrors:0};
  });
 }finally{
  if(!w.isDestroyed())await js('window.deletionFixture.release()').catch(()=>{});if(!w.isDestroyed())w.destroy();const absolute=path.resolve(dir);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.ok(path.basename(absolute).startsWith('isola-deletion-ui-'));fs.rmSync(absolute,{recursive:true,force:true});
 }
};
