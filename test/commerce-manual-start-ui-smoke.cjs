'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const listing={title:'Boite de rangement noire',description:'Boite de rangement propre, sans marque. Les deux photos locales montrent cet article.',categoryPath:['Maison','Rangement','Boites'],condition:'Très bon état',brand:'Sans marque',size:'',color:'Noir',parcel:'Moyen'};
const fields={title:'listingTitle',description:'listingDescription',categoryPath:'listingCategoryPath',condition:'listingCondition',brand:'listingBrand',size:'listingSize',color:'listingColor',parcel:'listingParcel'};
const photoToken='9ee5d582-eafa-4f60-b1d4-d4def06fb410';
const accountFailure='本地核验 fixture：手机本人主页用户名尚未取得，请在固定环境完成核验。';

// This preload is an isolated renderer contract fixture. It never imports the
// production commerce API, reads real photos or invokes an external scheduler.
function fixtureBridge(initial,token,verificationFailure){
 const {contextBridge}=require('electron'),clone=value=>JSON.parse(JSON.stringify(value));
 let state=clone(initial),listener,startMode='reject',releaseStart,verifyMode='unverified';const calls=[];
 const record=(name,args=[])=>calls.push({name,args:clone(args)}),emit=()=>listener?.(clone(state));
 const normalized=listing=>({...clone(listing),categoryPath:typeof listing.categoryPath==='string'?listing.categoryPath.split('/').map(value=>value.trim()).filter(Boolean):clone(listing.categoryPath)});
 const methods={};
 for(const name of ['saveSettings','connect','sync','saveProductListing','savePlan','setRunning','setPlanEnabled','runOnce','openListing','openActiveListing','preflight','inspectAccount','inspectPublication','prepareDraft','inspectPhotos','preparePhotos','photoPreview','uploadPhotos','resolve','saveAccount','deleteAccount','loginAccount','openAccount'])methods[name]=async(...args)=>{record(name,args);return {};};
 methods.importProductPhotos=async input=>{record('importProductPhotos',[input]);return {photoToken:token,count:2,cancelled:false};};
 methods.saveManualProduct=async input=>{
  record('saveManualProduct',[input]);
  const product={id:'manual-ui-product',sku:'LOCAL-MANUAL-UI-01',source:'local',name:input.name,stock:input.stock,priceCents:0,localPhotoCount:2,photoSetsAvailable:1};
  const template={productId:product.id,sku:product.sku,listing:normalized(input.listing),listingPriceCents:input.listingPriceCents,minOfferCents:input.minOfferCents,missingFields:[]};
  state.products=[product];state.productListings=[template];emit();return {product:clone(product),listing:clone(template)};
 };
 methods.saveAndStartPlan=async input=>{
  record('saveAndStartPlan',[input]);
  if(startMode==='reject')throw Error('当前账号尚未完成核对，请先核验后重试。');
  if(startMode==='hold')await new Promise(resolve=>releaseStart=resolve);
  const plan={...clone(input),id:'manual-ui-plan',listing:normalized(input.listing),completedCount:0,listingRevision:0,activeListingId:null,status:'ready'};
  state.plans=[plan];state.running=true;state.runningPlanIds=[plan.id];state.settings.backgroundEnabled=true;emit();return {plan:clone(plan),started:true};
 };
 methods.startPlan=async id=>{record('startPlan',[id]);const plan=state.plans.find(row=>row.id===id);plan.enabled=true;state.running=true;state.runningPlanIds=[id];emit();return {plan:clone(plan),started:true};};
 methods.verifyAccount=async(id,options)=>{
  record('verifyAccount',[id,options]);const account=state.accounts.find(row=>row.id===id);
  if(verifyMode!=='verified')return {account:clone(account),result:{verified:verifyMode==='string'?'true':false,status:'awaiting_user',code:'ACCOUNT_UNVERIFIED'},message:verificationFailure};
  account.status='logged_in';account.identity={memberId:'987654321013',username:'manual_ui_seller',profileURL:'https://www.vinted.fr/member/987654321013',verifiedAt:'2026-10-15T12:00:00Z'};
  state.profiles[0].marketAccount={...clone(account.identity),platform:'vinted-fr'};emit();return {account:clone(account),result:{verified:true,status:'logged_in'},message:'已核对本地 fixture 的账号身份。'};
 };
 contextBridge.exposeInMainWorld('commerce',{...methods,state:async()=>clone(state),onState:fn=>listener=fn});
 contextBridge.exposeInMainWorld('manualStartUIFixture',{
  calls:()=>clone(calls),state:()=>clone(state),startMode:value=>startMode=value,
  releaseStart:()=>{startMode='success';releaseStart?.();releaseStart=null;},
  pause:()=>{state.running=false;state.runningPlanIds=[];emit();},
  disablePlan:()=>{state.plans[0].enabled=false;state.running=false;state.runningPlanIds=[];emit();},
  verifyMode:value=>verifyMode=value,emit
 });
}

module.exports=async function commerceManualStartUISmoke(_api,check){
 const {BrowserWindow}=require('electron');assert.ok(process.env.ISOLA_TEST_DATA,'Manual product UI smoke requires isolated test data');
 const initial={settings:{hasToken:false,baseURL:'',backgroundEnabled:false,maxConcurrent:1,perOrderLimitCents:0,dailyLimitCents:0,fulfillmentMethod:'wms'},connection:{status:'not_configured'},readiness:{vinted:'partial',salesOnly:true,capabilities:{inspect:true,publish:true,autoOpenProfile:true,messages:false,offers:false,saleConfirmation:false,shippingLabel:false,procurement:false}},running:false,runningPlanIds:[],faulted:false,configBusy:false,profiles:[{id:'manual-ui-profile',name:'Pixel 7 本地固定环境',status:'closed',operatingSystem:'android',deviceModel:'Pixel 7',marketAccount:null}],accounts:[{id:'manual-ui-account',profileId:'manual-ui-profile',platform:'vinted',label:'本地手动商品账号',login:'manual-ui@example.invalid',status:'saved',hasPassword:false,identity:null,lastResult:null}],products:[],productListings:[],photoSets:[],photoPreparations:[],plans:[],jobs:[],events:[],publications:[]};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-manual-start-ui-')),preload=path.join(dir,'preload.cjs');
 fs.writeFileSync(preload,'('+fixtureBridge.toString()+')('+JSON.stringify(initial)+','+JSON.stringify(photoToken)+','+JSON.stringify(accountFailure)+');');
 const window=new BrowserWindow({show:false,width:1360,height:940,webPreferences:{preload,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false,partition:'manual-start-ui-'+Date.now()}}),errors=[];
 window.webContents.on('console-message',(event,level,message)=>{const details=event.details||event,severity=typeof level==='number'?level:typeof level==='object'?level.level:details.level,value=typeof message==='string'?message:typeof level==='object'?level.message:details.message;if(severity===3||severity==='error')errors.push(String(value||'Renderer console error'));});
 const js=code=>window.webContents.executeJavaScript(code),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function until(predicate,label){const end=Date.now()+8000;while(Date.now()<end){if(await predicate())return;await pause(25);}throw Error('Manual product/start UI fixture timed out: '+label);}
 async function frames(){window.show();window.focus();let timer;try{await Promise.race([js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'),new Promise(resolve=>{timer=setTimeout(resolve,500);})]);}finally{clearTimeout(timer);}}
 const calls=()=>js('window.manualStartUIFixture.calls()'),state=()=>js('window.manualStartUIFixture.state()'),count=async name=>(await calls()).filter(row=>row.name===name).length;
 const expectedFormListing=Object.fromEntries(Object.entries(listing).map(([key,value])=>[key,key==='categoryPath'?value.join(' / '):value]));
 const planButton=label=>`Array.from(document.querySelector('[data-listing-plan-id="manual-ui-plan"]').querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(label)})`;
 const clickPlan=label=>js(planButton(label)+'.click()');
 const planFields=()=>js(`(()=>{const f=document.querySelector('#plan-form'),listing={};for(const [key,name] of Object.entries(${JSON.stringify(fields)}))listing[key]=f.elements[name].value;return {profileId:f.elements.profileId.value,productId:f.elements.productId.value,listing,price:f.elements.listingPrice.value,min:f.elements.minOffer.value,enabled:f.elements.enabled.checked};})()`);
 const assertNoFallback=async()=>{for(const name of ['connect','sync','saveProductListing','savePlan','setRunning','runOnce'])assert.equal(await count(name),0,'Unexpected '+name+' call');};
 try{
  await window.loadFile(path.resolve(__dirname,'../src/commerce.html'));await until(()=>js('document.querySelectorAll("#listing-workflow-steps li").length===4'),'workflow renders');await frames();
  await check('manual product creation is available without a supplier URL, token or connection',async()=>{
   const data=await state();assert.equal(data.settings.hasToken,false);assert.equal(data.settings.baseURL,'');assert.equal(data.connection.status,'not_configured');
   await js(`document.querySelector('[data-page="inventory"]').click();document.querySelector('#new-manual-product').click()`);
   assert.equal(await js('document.querySelector("#product-listing-dialog").open'),true);assert.equal(await js('document.querySelector("[data-manual-product-only]").hidden'),false);assert.equal(await js('document.querySelector("#manual-photo-import").disabled'),false);assert.match(await js('document.querySelector("#product-listing-source").textContent'),/无需货盘/);assert.equal(await js('typeof require'),'undefined');assert.deepEqual(await calls(),[]);assert.deepEqual(errors,[]);
   return {supplierConfigured:false,manualEditorAvailable:true,productionBridgeExposed:false};
  });
  await check('manual photo selection passes an opaque token with confirmed listing details into one local product save',async()=>{
   await js('document.querySelector("#manual-photo-import").click()');await until(()=>js('document.querySelector("#manual-photo-count").textContent.includes("已选择 2 张")'),'two selected photos appear');
   const selected=(await calls()).find(row=>row.name==='importProductPhotos');assert.deepEqual(selected.args,[{}]);
   await js(`(()=>{const f=document.querySelector('#product-listing-form');f.elements.manualName.value='本地黑色收纳盒';f.elements.manualStock.value='2';for(const [key,name] of Object.entries(${JSON.stringify(fields)}))f.elements[name].value=${JSON.stringify(expectedFormListing)}[key];f.elements.listingPrice.value='12.50';f.elements.minOffer.value='10.00';f.dispatchEvent(new Event('input',{bubbles:true}));f.requestSubmit();})()`);
   await until(async()=>await count('saveManualProduct')===1&&!await js('document.querySelector("#product-listing-dialog").open'),'manual product saves');
   const input=(await calls()).find(row=>row.name==='saveManualProduct').args[0];assert.deepEqual(input,{name:'本地黑色收纳盒',stock:2,listing:expectedFormListing,listingPriceCents:1250,minOfferCents:1000,photoToken});assert.equal(Object.hasOwn(input,'sku'),false);assert.equal(Object.hasOwn(input,'productId'),false);assert.equal(Object.hasOwn(input,'paths'),false);
   const data=await state();assert.equal(data.products[0].source,'local');assert.equal(data.products[0].localPhotoCount,2);assert.deepEqual(data.productListings[0].listing,listing);assert.match(await js('document.querySelector("#products").innerText'),/本地照片 2 张/);assert.match(await js('document.querySelector("#products").innerText'),/基本上架资料已齐/);assert.equal(data.plans.length,0);assert.equal(data.running,false);await assertNoFallback();
   return {importProductIdOmitted:true,photoCount:2,opaqueToken:true,productWrites:1,supplierCalls:0};
  });
  await check('a plan created from a manual product copies its confirmed template, prices and fixed environment',async()=>{
   await js(`(()=>{const row=document.querySelector('[data-product-listing-id="manual-ui-product"]').closest('tr');Array.from(row.querySelectorAll('button')).find(button=>button.textContent==='建计划').click();})()`);
   await until(()=>js('document.querySelector("#plan-dialog").open'),'manual product plan opens');
   assert.deepEqual(await planFields(),{profileId:'manual-ui-profile',productId:'manual-ui-product',listing:expectedFormListing,price:'12.50',min:'10.00',enabled:false});assert.match(await js('document.querySelector("#plan-template-info").textContent'),/已带入商品资料/);assert.match(await js('document.querySelector("#plan-product-info").textContent'),/手动商品.*本地照片 2 张/);assert.equal(await count('saveAndStartPlan'),0);await assertNoFallback();
   return {manualTemplateCopied:true,pricesInCentsOnSave:true,automaticStartRequiresSelection:true};
  });
  await check('a rejected save-and-start keeps the plan editor, entered details and actionable failure visible',async()=>{
   await js(`const f=document.querySelector('#plan-form');f.elements.enabled.checked=true;f.requestSubmit()`);
   await until(()=>js('!document.querySelector("#plan-error").hidden&&!document.querySelector("#plan-form [type=submit]").disabled'),'start rejection remains visible');
   assert.equal(await count('saveAndStartPlan'),1);assert.equal(await js('document.querySelector("#plan-dialog").open'),true);assert.match(await js('document.querySelector("#plan-error").textContent'),/账号.*核对.*核验/);assert.deepEqual((await planFields()).listing,expectedFormListing);assert.equal((await planFields()).enabled,true);assert.equal((await state()).plans.length,0);assert.equal((await state()).running,false);await assertNoFallback();
   return {failedStartKeepsDialog:true,detailsPreserved:true,partialPlanWrites:0,fallbackCalls:0};
  });
  await check('saving an enabled plan uses one atomic save-and-start despite duplicate submit events',async()=>{
   const before=await count('saveAndStartPlan');await js(`window.manualStartUIFixture.startMode('hold');document.querySelector('#plan-form').requestSubmit();document.querySelector('#plan-form').requestSubmit()`);
   await until(()=>js('document.querySelector("#plan-form [type=submit]").disabled'),'start request pending');assert.equal(await count('saveAndStartPlan'),before+1);assert.equal(await js('document.querySelector("#plan-dialog").open'),true);assert.equal((await state()).plans.length,0);
   const input=(await calls()).filter(row=>row.name==='saveAndStartPlan').at(-1).args[0];assert.equal(input.enabled,true);assert.equal(input.productId,'manual-ui-product');assert.equal(input.profileId,'manual-ui-profile');assert.equal(input.sku,'LOCAL-MANUAL-UI-01');assert.deepEqual(input.listing,expectedFormListing);assert.equal(input.listingPriceCents,1250);assert.equal(input.minOfferCents,1000);assert.equal(Object.hasOwn(input,'photoToken'),false);
   await js('window.manualStartUIFixture.releaseStart()');await until(()=>js('!document.querySelector("#plan-dialog").open&&!!document.querySelector("[data-listing-plan-id=manual-ui-plan]")'),'started plan rendered');
   const data=await state();assert.equal(data.plans.length,1);assert.equal(data.running,true);assert.deepEqual(data.runningPlanIds,['manual-ui-plan']);assert.equal(await count('saveAndStartPlan'),before+1);await assertNoFallback();
   return {atomicStartCalls:1,duplicateSubmitSuppressed:true,startedPlanOnly:'manual-ui-plan',fallbackCalls:0};
  });
  await check('the enable-and-start action invokes startPlan for the selected plan without a global scheduler call',async()=>{
   await js(`window.manualStartUIFixture.disablePlan();document.querySelector('[data-page="plans"]').click()`);assert.equal(await js(planButton('启用并开始')+'.disabled'),false);await clickPlan('启用并开始');
   await until(()=>js('window.manualStartUIFixture.calls().filter(row=>row.name==="startPlan").length===1&&window.manualStartUIFixture.state().running'),'selected plan starts');
   assert.deepEqual((await calls()).find(row=>row.name==='startPlan').args,['manual-ui-plan']);assert.equal(await count('setPlanEnabled'),0);assert.deepEqual((await state()).runningPlanIds,['manual-ui-plan']);await assertNoFallback();await js('window.manualStartUIFixture.pause()');
   return {selectedPlanStartCalls:1,globalSchedulerCalls:0,enableThenStartSplitCalls:0};
  });
  await check('an unverified account response keeps confirmation open and preserves its exact failure on the plan card',async()=>{
   await until(()=>js('!'+planButton('核对账号')+'.disabled'),'account check available');await clickPlan('核对账号');assert.equal(await js('document.querySelector("#account-verify-dialog").open'),true);assert.equal(await count('verifyAccount'),0);assert.equal(await count('inspectAccount'),0);assert.match(await js('document.querySelector("#account-verify-summary").textContent'),/manual-ui@example\.invalid/);
   await js('document.querySelector("#account-verify-confirm").click()');await until(()=>js('!document.querySelector("#account-verify-confirm").disabled&&document.querySelector("[data-account-check=failed]")!==null'),'unverified result stays visible');
   assert.equal(await js('document.querySelector("#account-verify-dialog").open'),true);assert.equal(await js('document.querySelector("#account-verify-feedback").hidden'),false);assert.equal(await js('document.querySelector("#account-verify-feedback").textContent'),accountFailure);assert.deepEqual((await calls()).find(row=>row.name==='verifyAccount').args,['manual-ui-account',{confirmCurrent:true}]);
   await js(`document.querySelector('#account-verify-dialog [data-close="account-verify-dialog"]').click();document.querySelector('[data-page="inventory"]').click();window.manualStartUIFixture.emit();document.querySelector('[data-page="plans"]').click()`);
   assert.equal(await js('document.querySelector("#account-verify-dialog").open'),false);assert.equal(await js('document.querySelector("[data-listing-plan-id=manual-ui-plan] [data-account-check=failed] p").textContent'),accountFailure);assert.match(await js('document.querySelector("[data-listing-plan-id=manual-ui-plan] [data-account-check=failed]").textContent'),/账号核对未完成/);assert.equal((await state()).accounts[0].identity,null);assert.equal((await state()).profiles[0].marketAccount,null);await assertNoFallback();
   return {operatorConfirmationRequired:true,transportSuccessIsNotVerification:true,modalRetained:true,persistentPlanFailure:true};
  });
  await check('only boolean verified true closes account confirmation and replaces the persistent failed status',async()=>{
   await js(`window.manualStartUIFixture.verifyMode('string')`);await clickPlan('核对账号');assert.equal(await count('verifyAccount'),1);await js('document.querySelector("#account-verify-confirm").click()');await until(async()=>await count('verifyAccount')===2&&!await js('document.querySelector("#account-verify-confirm").disabled'),'non-boolean verification returned');
   assert.equal(await js('document.querySelector("#account-verify-dialog").open'),true);assert.equal(await js('document.querySelector("#account-verify-feedback").textContent'),accountFailure);assert.equal(await js('document.querySelectorAll("[data-listing-plan-id=manual-ui-plan] [data-account-check=failed]").length'),1);
   await js(`window.manualStartUIFixture.verifyMode('verified');document.querySelector('#account-verify-confirm').click()`);await until(()=>js('!document.querySelector("#account-verify-dialog").open&&!!document.querySelector("[data-listing-plan-id=manual-ui-plan] [data-account-check=verified]")'),'strict verified result closes confirmation');
   assert.equal(await count('verifyAccount'),3);assert.equal(await js('document.querySelectorAll("[data-listing-plan-id=manual-ui-plan] [data-account-check=failed]").length'),0);assert.match(await js('document.querySelector("[data-listing-plan-id=manual-ui-plan] [data-account-check=verified]").textContent'),/最近账号核对成功/);assert.equal((await state()).accounts[0].identity.username,'manual_ui_seller');assert.equal(await count('inspectAccount'),0);await assertNoFallback();assert.deepEqual(errors,[]);
   return {nonBooleanTrueRejected:true,strictBooleanTrueAccepted:true,modalClosesAfterVerification:true,oldFailureReplaced:true,externalCalls:0};
  });
 }finally{
  if(!window.isDestroyed())await js('window.manualStartUIFixture.releaseStart()').catch(()=>{});
  if(!window.isDestroyed())window.destroy();const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('isola-manual-start-ui-'));fs.rmSync(resolved,{recursive:true,force:true});
 }
};
