'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const clone=value=>JSON.parse(JSON.stringify(value));
const firstListing={title:'Accessoire de rangement noir',description:'Accessoire de rangement neuf, sans emballage. Dimensions et etat confirmes pour cette fixture.',categoryPath:['Maison','Rangement','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',size:'',color:'Noir',parcel:'Moyen'};
const secondListing={...firstListing,title:'Accessoire de rangement noir seconde version',description:'Description corrigee et confirmee pour les futurs plans uniquement.'};
const fields={title:'listingTitle',description:'listingDescription',categoryPath:'listingCategoryPath',condition:'listingCondition',brand:'listingBrand',size:'listingSize',color:'listingColor',parcel:'listingParcel'};

// Renderer contract fixture only. Every bridge call is recorded and handled in
// this isolated preload; no production account, supplier, browser or scheduler
// API is exposed to the page.
module.exports=async function commerceListingSetupSmoke(_api,check){
 const {BrowserWindow}=require('electron');
 assert.ok(process.env.ISOLA_TEST_DATA,'Listing setup smoke requires isolated test data');
 const catalog=[{id:'listing-setup-product',sku:'FIXTURE-SETUP-01',name:'Local listing setup fixture',stock:3,priceCents:100,photoSetsAvailable:1},{id:'listing-setup-other-product',sku:'FIXTURE-SETUP-02',name:'Other local product for pending-save isolation',stock:2,priceCents:200,photoSetsAvailable:1}];
 const initial={settings:{hasToken:true,backgroundEnabled:false,maxConcurrent:1,baseURL:'https://supplier.invalid/api/v1',perOrderLimitCents:0,dailyLimitCents:0,fulfillmentMethod:'wms'},connection:{status:'not_connected'},readiness:{vinted:'partial',salesOnly:true,capabilities:{inspect:true,publish:true,autoOpenProfile:true,messages:false,offers:false,saleConfirmation:false,shippingLabel:false,procurement:false}},running:false,faulted:false,configBusy:false,accounts:[],profiles:[{id:'listing-setup-profile',name:'Local fixed account',status:'closed',marketAccount:{platform:'vinted-fr',memberId:'987654321001',username:'fixture_setup_account',profileURL:'https://www.vinted.fr/member/987654321001',verifiedAt:'2026-10-15T09:00:00Z'}}],products:[],productListings:[],photoSets:[],photoPreparations:[],plans:[],jobs:[],events:[],publications:[]};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-listing-setup-fixture-')),preload=path.join(dir,'preload.cjs');
 fs.writeFileSync(preload,`'use strict';const {contextBridge}=require('electron');const clone=v=>JSON.parse(JSON.stringify(v));let state=${JSON.stringify(initial)},listener,calls=[],blockedMethod='',releaseSave;const catalog=${JSON.stringify(catalog)};
 const publish=()=>listener?.(clone(state));const missing=listing=>['title','description','condition','brand','color','parcel','categoryPath'].filter(key=>key==='categoryPath'?!Array.isArray(listing[key])||!listing[key].length:!listing[key]?.trim());
 const methods={};for(const name of ['openListing','openActiveListing','inspectAccount','inspectPublication','setPlanEnabled','prepareDraft','preflight','inspectPhotos','preparePhotos','photoPreview','uploadPhotos','saveSettings','setRunning','runOnce','resolve'])methods[name]=async(...args)=>{calls.push({name,args:clone(args)});return {};};
 methods.connect=async()=>{calls.push({name:'connect',args:[]});state.connection={status:'connected',account:'local fixture supplier'};publish();return clone(state);};
 methods.sync=async()=>{calls.push({name:'sync',args:[]});state.products=clone(catalog);state.photoSets=[{id:'listing-setup-set',productId:catalog[0].id,name:'Local available fixture photos',claimStatus:'available',imageCount:1}];publish();return clone(state);};
 methods.saveProductListing=async input=>{calls.push({name:'saveProductListing',args:[clone(input)]});if(blockedMethod==='saveProductListing')await new Promise(resolve=>releaseSave=resolve);const product=state.products.find(row=>row.id===input.productId);if(!product||product.sku!==input.sku)throw Error('Fixture rejects stale product identity');const listing=clone(input.listing);if(typeof listing.categoryPath==='string')listing.categoryPath=listing.categoryPath.split('/').map(value=>value.trim()).filter(Boolean);const saved={...clone(input),listing,missingFields:missing(listing)};state.productListings=state.productListings.filter(row=>row.productId!==saved.productId).concat(saved);publish();return clone(saved);};
 methods.savePlan=async input=>{calls.push({name:'savePlan',args:[clone(input)]});const listing=clone(input.listing);if(typeof listing.categoryPath==='string')listing.categoryPath=listing.categoryPath.split('/').map(value=>value.trim()).filter(Boolean);const saved={...clone(input),listing,id:input.id||'listing-setup-plan-'+(state.plans.length+1),completedCount:0,listingRevision:0,activeListingId:null,status:input.enabled?'ready':'paused'};state.plans=state.plans.filter(row=>row.id!==saved.id).concat(saved);publish();return clone(saved);};
 contextBridge.exposeInMainWorld('commerce',{...methods,state:async()=>clone(state),onState:fn=>listener=fn});contextBridge.exposeInMainWorld('listingSetupFixture',{calls:()=>clone(calls),state:()=>clone(state),changeSKU:sku=>{state.products=state.products.map(row=>row.id===catalog[0].id?{...row,sku}:row);publish();},block:name=>{blockedMethod=name;},release:()=>{blockedMethod='';releaseSave?.();releaseSave=null;}});`);
 const window=new BrowserWindow({show:false,width:1360,height:940,webPreferences:{preload,contextIsolation:true,sandbox:true,nodeIntegration:false,partition:'listing-setup-fixture-'+Date.now()}}),errors=[];
 window.webContents.on('console-message',(event,level,message)=>{const details=event.details||event,severity=typeof level==='number'?level:typeof level==='object'?level.level:details.level,text=typeof message==='string'?message:typeof level==='object'?level.message:details.message;if(severity===3||severity==='error')errors.push(String(text||'Renderer console error'));});
 const js=code=>window.webContents.executeJavaScript(code),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function until(predicate,label){const end=Date.now()+8000;while(Date.now()<end){if(await predicate())return;await pause(25);}throw Error('Listing setup fixture timed out: '+label);}
 async function frames(){window.show();window.focus();let timer;try{await Promise.race([js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'),new Promise(resolve=>{timer=setTimeout(resolve,500);})]);}finally{clearTimeout(timer);}}
 const calls=()=>js('window.listingSetupFixture.calls()');
 const state=()=>js('window.listingSetupFixture.state()');
 const count=async name=>(await calls()).filter(row=>row.name===name).length;
 async function openProduct(){await js(`document.querySelector('[data-page="inventory"]').click();document.querySelector('[data-product-listing-id="listing-setup-product"]').click()`);await until(()=>js('document.querySelector("#product-listing-dialog").open'),'product editor opens');}
 async function fillProduct(listing,price,min){await js(`(()=>{const form=document.querySelector('#product-listing-form'),values=${JSON.stringify(listing)},names=${JSON.stringify(fields)};for(const [key,name] of Object.entries(names))form.elements[name].value=key==='categoryPath'?values[key].join(' / '):values[key]||'';form.elements.listingPrice.value=${JSON.stringify(price)};form.elements.minOffer.value=${JSON.stringify(min)};form.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
 async function saveProduct(expectedCount){await js('document.querySelector("#product-listing-form").requestSubmit()');await until(async()=>await count('saveProductListing')===expectedCount&&!await js('document.querySelector("#product-listing-dialog").open'),'product save completes');await frames();}
 async function openNewPlan(){await js(`(()=>{document.querySelector('[data-page="inventory"]').click();const row=document.querySelector('[data-product-listing-id="listing-setup-product"]').closest('tr');Array.from(row.querySelectorAll('button')).find(button=>button.textContent==='建计划').click();})()`);await until(()=>js('document.querySelector("#plan-dialog").open'),'new plan editor opens');}
 const planFields=()=>js(`(()=>{const form=document.querySelector('#plan-form'),listing={};for(const [key,name] of Object.entries(${JSON.stringify(fields)}))listing[key]=form.elements[name].value;return {id:form.elements.id.value,profileId:form.elements.profileId.value,productId:form.elements.productId.value,listing,price:form.elements.listingPrice.value,min:form.elements.minOffer.value,template:document.querySelector('#plan-template-info').textContent};})()`);
 function expectedFormListing(listing){return Object.fromEntries(Object.entries(listing).map(([key,value])=>[key,key==='categoryPath'?value.join(' / '):value]));}
 async function assertNoExecution(){assert.equal(await count('setRunning'),0);assert.equal(await count('runOnce'),0);assert.equal((await state()).running,false);}
 try{
  await window.loadFile(path.resolve(__dirname,'../src/commerce.html'));await until(()=>js('document.querySelectorAll("#listing-workflow-steps li").length===4'),'setup workflow renders');await frames();
  await check('listing setup keeps a saved token pending connection and routes the next step to settings',async()=>{
   const shown=await js(`({steps:Array.from(document.querySelectorAll('#listing-workflow-steps li'),row=>({id:row.dataset.step,title:row.querySelector('h3').textContent,complete:row.dataset.complete})),next:document.querySelector('#readiness-settings').textContent,node:typeof require})`);
   assert.equal(shown.node,'undefined');assert.deepEqual(shown.steps.map(row=>row.id),['connection','products','plans','execution']);assert.equal(shown.steps[0].complete,'false');assert.match(shown.next,/检查.*连接/);
   await js('document.querySelector("#readiness-settings").click()');assert.equal(await js('document.querySelector("#page-settings").hidden'),false);assert.equal(await js('document.querySelector("#page-plans").hidden'),true);assert.deepEqual(await calls(),[]);assert.deepEqual(errors,[]);
   return {savedTokenIsNotConnection:true,steps:4,externalCalls:0};
  });
  await check('listing setup connects and syncs through explicit actions before offering editable product information',async()=>{
   await js('document.querySelector("#connect").click()');await until(async()=>(await state()).connection.status==='connected'&&!await js('document.querySelector("#sync").disabled'),'connection request releases controls');
   assert.match(await js('document.querySelector("#readiness-settings").textContent'),/同步/);await js('document.querySelector("#readiness-settings").click()');assert.equal(await js('document.querySelector("#page-inventory").hidden'),false);
   await js('document.querySelector("#sync").click()');await until(()=>js('!!document.querySelector("[data-product-listing-id=listing-setup-product]")'),'catalog product renders');
   const shown=await js('document.querySelector("#products").innerText');assert.match(shown,/FIXTURE-SETUP-01/);assert.match(shown,/尚未保存上架资料/);assert.deepEqual((await calls()).map(row=>row.name),['connect','sync']);await assertNoExecution();
   return {explicitConnect:true,explicitSync:true,editableProduct:true,schedulerCalls:0};
  });
  await check('listing product information can save a visible incomplete draft without creating a plan or starting execution',async()=>{
   await openProduct();await js(`(()=>{const form=document.querySelector('#product-listing-form');form.elements.listingTitle.value='Brouillon local';form.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   const hint=await js('document.querySelector("#product-listing-readiness").textContent');assert.match(hint,/商品描述/);assert.match(hint,/分类路径/);assert.match(hint,/颜色/);await saveProduct(1);
   assert.match(await js('document.querySelector("#products").innerText'),/资料草稿.*缺/);const saved=(await state()).productListings[0];assert.equal(saved.listing.title,'Brouillon local');assert.ok(saved.missingFields.includes('description'));assert.ok(saved.missingFields.includes('categoryPath'));assert.equal((await state()).plans.length,0);await assertNoExecution();
   return {draftSaved:true,missingFieldsVisible:true,createdPlans:0,schedulerCalls:0};
  });
  await check('listing product information sends the selected product and confirmed fields with prices to its dedicated API',async()=>{
   await openProduct();await fillProduct(firstListing,'12.50','10.00');assert.match(await js('document.querySelector("#product-listing-readiness").textContent'),/基本商品资料已填齐/);await saveProduct(2);
   const last=(await calls()).filter(row=>row.name==='saveProductListing').at(-1);assert.deepEqual(last.args,[{productId:catalog[0].id,sku:catalog[0].sku,listing:expectedFormListing(firstListing),listingPriceCents:1250,minOfferCents:1000}]);
   assert.match(await js('document.querySelector("#products").innerText'),/基本上架资料已齐/);assert.deepEqual((await state()).productListings[0].missingFields,[]);await assertNoExecution();
   return {productIdentity:true,confirmedListing:true,pricesInCents:true,schedulerCalls:0};
  });
  await check('a new listing plan copies product details and prices while saving only the plan snapshot',async()=>{
   await openNewPlan();const shown=await planFields();assert.equal(shown.id,'');assert.equal(shown.productId,catalog[0].id);assert.equal(shown.profileId,initial.profiles[0].id);assert.deepEqual(shown.listing,expectedFormListing(firstListing));assert.equal(shown.price,'12.50');assert.equal(shown.min,'10.00');assert.match(shown.template,/已带入商品资料/);
   await js(`(()=>{const form=document.querySelector('#plan-form');form.elements.enabled.checked=true;form.requestSubmit();})()`);await until(async()=>await count('savePlan')===1&&!await js('document.querySelector("#plan-dialog").open'),'plan snapshot saves');
   const input=(await calls()).find(row=>row.name==='savePlan').args[0];assert.equal(input.productId,catalog[0].id);assert.equal(input.profileId,initial.profiles[0].id);assert.deepEqual(input.listing,expectedFormListing(firstListing));assert.equal(input.listingPriceCents,1250);assert.equal(input.minOfferCents,1000);assert.equal(input.enabled,true);assert.equal(input.targetCount,1);await assertNoExecution();
   return {copiedToPlan:true,enabledPlanSaved:true,executionStillStopped:true};
  });
  await check('editing a product template affects future plans but preserves an existing plan listing and prices',async()=>{
   await openProduct();await fillProduct(secondListing,'14.99','11.00');await saveProduct(3);
   assert.deepEqual((await state()).plans[0].listing,firstListing);assert.equal((await state()).plans[0].listingPriceCents,1250);
   await js(`(()=>{document.querySelector('[data-page="plans"]').click();const card=document.querySelector('[data-listing-plan-id="listing-setup-plan-1"]');Array.from(card.querySelectorAll('button')).find(button=>button.textContent==='编辑').click();})()`);
   const old=await planFields();assert.equal(old.id,'listing-setup-plan-1');assert.deepEqual(old.listing,expectedFormListing(firstListing));assert.equal(old.price,'12.50');assert.equal(old.min,'10.00');assert.match(old.template,/不会覆盖本计划/);await js('document.querySelector("#plan-dialog").close()');
   await openNewPlan();const next=await planFields();assert.equal(next.id,'');assert.deepEqual(next.listing,expectedFormListing(secondListing));assert.equal(next.price,'14.99');assert.equal(next.min,'11.00');await js('document.querySelector("#plan-dialog").close()');assert.equal(await count('savePlan'),1);await assertNoExecution();
   return {originalSnapshotPreserved:true,newPlanUsesUpdatedTemplate:true,extraPlanWrites:0};
  });
  await check('a listing plan opened before a catalog SKU change refuses its stale snapshot without another plan write',async()=>{
   await openNewPlan();const before=await count('savePlan'),old=await planFields();assert.deepEqual(old.listing,expectedFormListing(secondListing));
   await js(`window.listingSetupFixture.changeSKU('FIXTURE-SETUP-PLAN-CHANGED');document.querySelector('#plan-form').requestSubmit()`);
   await until(()=>js('!document.querySelector("#plan-error").hidden'),'stale plan SKU error appears');assert.match(await js('document.querySelector("#plan-error").textContent'),/SKU.*改变|商品.*改变/);assert.equal(await js('document.querySelector("#plan-dialog").open'),true);assert.equal(await count('savePlan'),before);
   assert.equal((await state()).plans.length,1);assert.deepEqual((await state()).plans[0].listing,firstListing);await js(`document.querySelector('#plan-dialog').close();window.listingSetupFixture.changeSKU(${JSON.stringify(catalog[0].sku)})`);await assertNoExecution();
   return {catalogChangedWhilePlanOpen:true,extraPlanWrites:0,originalPlanPreserved:true};
  });
  await check('a deferred product save prevents a second editor from opening until the original save completes',async()=>{
   await openProduct();await fillProduct(secondListing,'15.50','12.00');const before=await count('saveProductListing');
   await js(`window.listingSetupFixture.block('saveProductListing');document.querySelector('#product-listing-form').requestSubmit()`);await until(async()=>await count('saveProductListing')===before+1&&await js('document.querySelector("#product-listing-save").disabled'),'deferred product save starts');
   await js(`document.querySelector('#product-listing-dialog [data-close="product-listing-dialog"]').click()`);assert.equal(await js('document.querySelector("#product-listing-dialog").open'),false);
   const blocked=await js(`(()=>{const buttons=Array.from(document.querySelectorAll('[data-product-listing-id]')),other=document.querySelector('[data-product-listing-id="listing-setup-other-product"]');other.click();other.dispatchEvent(new MouseEvent('click',{bubbles:true}));return {disabled:buttons.every(button=>button.disabled),otherDisabled:other.disabled};})()`);await frames();
   assert.equal(blocked.disabled,true);assert.equal(blocked.otherDisabled,true);assert.equal(await js('document.querySelector("#product-listing-dialog").open'),false);assert.equal(await js('document.querySelector("#product-listing-form").elements.productId.value'),catalog[0].id);assert.equal(await count('saveProductListing'),before+1);
   await js('window.listingSetupFixture.release()');await until(()=>js('!document.querySelector("[data-product-listing-id=listing-setup-other-product]").disabled'),'original save releases product editors');
   assert.equal((await state()).productListings.some(row=>row.productId===catalog[1].id),false);const last=(await calls()).filter(row=>row.name==='saveProductListing').at(-1);assert.equal(last.args[0].productId,catalog[0].id);
   await js(`document.querySelector('[data-product-listing-id="listing-setup-other-product"]').click()`);await frames();assert.equal(await js('document.querySelector("#product-listing-dialog").open'),true);assert.equal(await js('document.querySelector("#product-listing-form").elements.productId.value'),catalog[1].id);await js('document.querySelector("#product-listing-dialog").close()');await assertNoExecution();
   return {deferredWrites:1,queuedReentryBlocked:true,secondProductUnchanged:true,editorAvailableAfterCompletion:true};
  });
  await check('an open product editor rejects a changed SKU without saving stale details or reusing its old template',async()=>{
   await openProduct();const before=await count('saveProductListing');await js(`window.listingSetupFixture.changeSKU('FIXTURE-SETUP-CHANGED');document.querySelector('#product-listing-form').requestSubmit()`);
   await until(()=>js('!document.querySelector("#product-listing-error").hidden'),'stale SKU error appears');assert.match(await js('document.querySelector("#product-listing-error").textContent'),/SKU.*改变/);assert.equal(await js('document.querySelector("#product-listing-dialog").open'),true);assert.equal(await count('saveProductListing'),before);
   await js('document.querySelector("#product-listing-dialog").close()');await openProduct();const fresh=await js(`(()=>{const form=document.querySelector('#product-listing-form');return {title:form.elements.listingTitle.value,price:form.elements.listingPrice.value,source:document.querySelector('#product-listing-source').textContent};})()`);assert.equal(fresh.title,'');assert.equal(fresh.price,'');assert.match(fresh.source,/FIXTURE-SETUP-CHANGED/);await js('document.querySelector("#product-listing-dialog").close()');await assertNoExecution();
   return {staleSaveBlocked:true,oldTemplateNotReused:true,extraTemplateWrites:0};
  });
  await check('listing setup labels one-cycle execution honestly and keeps narrow editor save controls reachable',async()=>{
   assert.equal(await js('document.querySelector("#run-once").textContent'),'执行一轮');assert.doesNotMatch(await js('document.querySelector("#run-once").textContent'),/检查|只读/);window.setSize(1080,720,false);await frames();await openProduct();
   await js(`document.querySelector('#product-listing-save').scrollIntoView({block:'center',behavior:'instant'})`);await frames();const layout=await js(`(()=>{const button=document.querySelector('#product-listing-save'),rect=button.getBoundingClientRect(),dialog=document.querySelector('#product-listing-dialog'),d=dialog.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return {viewport:{width:innerWidth,height:innerHeight},total:document.documentElement.scrollWidth,button:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom},dialog:{x:d.x,y:d.y,right:d.right,bottom:d.bottom},hit:hit===button||button.contains(hit)};})()`);
   assert.ok(layout.total<=layout.viewport.width+1,JSON.stringify(layout));assert.ok(layout.button.y>=0&&layout.button.bottom<=layout.viewport.height,JSON.stringify(layout));assert.ok(layout.button.x>=0&&layout.button.right<=layout.viewport.width,JSON.stringify(layout));assert.equal(layout.hit,true,JSON.stringify(layout));await js('document.querySelector("#product-listing-dialog").close()');await assertNoExecution();assert.deepEqual(errors,[]);
   return {executionLabel:'执行一轮',narrowWidth:1080,saveControlVisible:true,saveControlClickable:true,schedulerCalls:0};
  });
 }finally{
  if(!window.isDestroyed())await js('window.listingSetupFixture.release()').catch(()=>{});
  if(!window.isDestroyed())window.destroy();
  const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('isola-listing-setup-fixture-'));fs.rmSync(resolved,{recursive:true,force:true});
 }
};
