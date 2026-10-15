'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const clone=value=>JSON.parse(JSON.stringify(value));
const FORM='https://www.vinted.fr/items/new';
const listing={title:'Accessoire personnel en cache',description:'Description confirmee dans le plan de cette fixture locale.',categoryPath:['Maison','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',size:'',color:'Noir',parcel:'Moyen'};
const html=`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Saved supplier draft IPC fixture</title>
<style>body{font:16px Arial}main{margin:40px}label{display:block;margin:16px 0}input,textarea{display:block;width:560px;padding:12px;font:inherit}textarea{height:110px}</style>
<main><h1>Vends ton article</h1><form id="listing"><label for="title">Titre</label><input id="title" placeholder="Dis aux acheteurs ce que tu vends"><label for="description">Description</label><textarea id="description" placeholder="Ajoute des informations utiles"></textarea></form><p>Cette fixture ne contient aucune commande de publication.</p></main>
<script>window.fixture={events:[],submits:0};for(const kind of ['click','input','keydown'])document.addEventListener(kind,event=>{if(event.target.closest('main'))fixture.events.push({kind,id:event.target.id,trusted:event.isTrusted});},true);document.querySelector('form').onsubmit=event=>{event.preventDefault();fixture.submits++;};</script>`;

// The real main IPC supplies beforeFields and the real adapter types into an
// intercepted static French form. No supplier transport, credential backend,
// scheduler, photo acquisition or publication control is available here.
module.exports=async function savedSupplierDraftMainSmoke(api,check){
 assert.ok(process.env.ISOLA_TEST_DATA,'Saved draft main IPC smoke requires isolated test data');
 assert.equal(path.resolve(path.dirname(api.dataFile())),path.resolve(process.env.ISOLA_TEST_DATA));
 const engine=api.getCommerce();assert.equal(engine.running,false);assert.equal(engine.ticking,false);assert.equal(engine.active.size,0);
 const original={db:engine.db,connection:engine.connection,clientFactory:engine.clientFactory,unseal:engine.unseal,unsealAsync:engine.unsealAsync,prepareFields:engine.adapter.prepareFields,hadOwnPrepare:Object.hasOwn(engine.adapter,'prepareFields')};
 const encryptedFixture=Buffer.from('v10-fixture-only-saved-supplier-ciphertext').toString('base64'),requests=[];
 let profile,session,w,view,plan,originalFocus,focusCalls=0,fieldPreparations=0,secretReads=0,supplierCalls=0;
 const until=async predicate=>{const end=Date.now()+8000;while(!predicate()){if(Date.now()>end)throw Error('Saved draft native fixture did not settle');await new Promise(resolve=>setTimeout(resolve,25));}};
 const invoke=(method,...args)=>view.webContents.executeJavaScript(`window.commerce[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
 const idleAndUnsubmitted=()=>{
  assert.equal(engine.running,false);assert.equal(engine.ticking,false);assert.equal(engine.active.size,0);assert.equal(engine.timer,null);assert.equal(engine.configPending,0);
  for(const key of ['jobs','claims','photoPreparations','localPhotoPreparations','sales','reservations','publicationSupplierSync'])assert.deepEqual(engine.db[key],[]);
  assert.deepEqual(engine.db.publications.submissions,[]);assert.equal(engine.db.encryptedToken,encryptedFixture);assert.equal(supplierCalls,0);
  assert.ok(requests.every(request=>request.method==='GET'&&request.url===FORM));
 };
 try{
  engine.db=clone(original.db);for(const key of ['products','productListings','localProducts','localPhotoPreparations','photoSets','photoPreparations','plans','planArchives','jobs','claims','sales','reservations','publicationSupplierSync','marketAccounts'])engine.db[key]=[];
  engine.db.publications={version:1,submissions:[]};engine.db.encryptedToken=encryptedFixture;engine.db.supplierAccountId='fixture-supplier-account';engine.db.settings={...engine.db.settings,baseURL:'https://supplier-fixture.invalid/api/v1',backgroundEnabled:false};engine.connection={status:'not_connected'};
  const product={id:'fixture-saved-supplier-product',sku:'FIXTURE-SAVED-SUPPLIER',name:'Saved supplier fixture item',stock:2,priceCents:100,photoSetsAvailable:0,revision:1};engine.db.products=[product];
  const forbiddenSecret=()=>{secretReads++;throw Error('Fixture supplier secret is unavailable');};engine.unseal=forbiddenSecret;engine.unsealAsync=forbiddenSecret;
  engine.clientFactory=()=>{supplierCalls++;throw Error('Supplier transport is forbidden for the saved draft fixture');};engine.persist();engine.emit();
  profile=api.saveProfile({name:'QA saved supplier draft native IPC',windowType:'automation',url:FORM,fingerprintMode:'native',width:1180,height:900});session=api.sesFor(profile);
  session.protocol.handle('https',request=>{requests.push({method:request.method,url:request.url});return request.method==='GET'&&request.url===FORM?new Response(html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}}):new Response('This fixture forwards no network traffic',{status:403});});
  await api.openCommerce('plans');view=api.getCommerceView();
  plan=await invoke('savePlan',{profileId:profile.id,productId:product.id,sku:product.sku,listing,listingPriceCents:500,minOfferCents:400,targetCount:1,reuseOwnPhotos:true,enabled:false});
  assert.equal(plan.source,'supplier');assert.deepEqual(plan.listing,listing);assert.equal(secretReads,0);assert.equal(supplierCalls,0);
  await api.launch(profile.id);w=api.windows.get(profile.id);const tab=w.tabs[0],contents=tab.view.webContents;
  await api.openCommerce('plans');view=api.getCommerceView();
  originalFocus=w.focus;w.focus=function(...args){focusCalls++;return originalFocus.apply(this,args);};
  engine.adapter.prepareFields=async function(profileId,input,options){fieldPreparations++;assert.equal(profileId,profile.id);assert.equal(input.title,listing.title);assert.equal(input.description,listing.description);assert.equal(input.priceCents,500);assert.ok(focusCalls>0);await until(()=>w.isVisible()&&w.isFocused());return original.prepareFields.call(this,profileId,input,options);};
  await check('saved supplier draft real IPC focuses its window and types confirmed fields without reading credentials or supplier data',async()=>{
   w.minimize();await until(()=>w.isMinimized());focusCalls=0;
   const cachedBefore=clone(engine.db.products),planBefore=clone(engine.plan(plan.id)),result=await invoke('prepareDraft',plan.id);
   assert.equal(fieldPreparations,1);assert.ok(focusCalls>0);assert.equal(w.isMinimized(),false);
   assert.equal(result.preflight.mode,'saved-plan');assert.equal(result.preflight.supplierVerified,false);assert.equal(result.preflight.stockVerified,false);assert.equal(result.preflight.readyForPublication,false);assert.equal(result.preflight.publicationEnabled,false);assert.equal(result.preflight.readyForFields,true);assert.equal(result.preflight.photos.source,'not-checked');assert.equal(result.preflight.photos.ready,false);assert.deepEqual(result.preflight.supplierFacts,{});assert.deepEqual(result.preflight.supplierFields,[]);
   assert.match(result.message,/离线/);assert.match(result.message,/未读取货盘 API 密钥/);assert.match(result.message,/未实时核对/);assert.match(result.message,/发布前仍须/);assert.equal(result.saved,false);assert.equal(result.published,false);assert.equal(result.draftComplete,false);
   const filled=result.filled.map(field=>field.field);assert.ok(filled.includes('title'));assert.ok(filled.includes('description'));
   const actual=await contents.executeJavaScript(`({title:document.querySelector('#title').value,description:document.querySelector('#description').value,publicationControls:document.querySelectorAll('button,input[type=submit]').length,...fixture})`);
   assert.equal(actual.title,listing.title);assert.equal(actual.description,listing.description);assert.equal(actual.publicationControls,0);assert.equal(actual.submits,0);assert.ok(actual.events.some(event=>event.kind==='input'&&event.id==='title'));assert.ok(actual.events.some(event=>event.kind==='input'&&event.id==='description'));assert.ok(actual.events.every(event=>event.trusted));
   assert.equal(secretReads,0);assert.deepEqual(engine.db.products,cachedBefore);assert.deepEqual(engine.plan(plan.id),planBefore);assert.equal(JSON.stringify(result).includes(encryptedFixture),false);idleAndUnsubmitted();
   return {realMainIPC:true,beforeFieldsRestoredAndFocused:true,realNativeFieldPreparation:true,filled:filled.filter(field=>['title','description'].includes(field)),offline:true,liveStockVerified:false,secretReads:0,supplierCalls:0,claims:0,jobs:0,submissions:0,publicationControls:0};
  });
  await check('live supplier preflight IPC still stops at credentials after offline field preparation and cannot authorize publication',async()=>{
   const before=JSON.stringify(engine.db),diskBefore=fs.readFileSync(engine.file,'utf8'),requestsBefore=requests.length;
   await assert.rejects(invoke('preflight',plan.id),error=>/货盘 API 密钥.*系统存储/.test(error.message));
   assert.equal(secretReads,1);assert.equal(supplierCalls,0);assert.equal(fieldPreparations,1);assert.equal(requests.length,requestsBefore);assert.equal(JSON.stringify(engine.db),before);assert.equal(fs.readFileSync(engine.file,'utf8'),diskBefore);idleAndUnsubmitted();
   return {realMainIPC:true,livePreflightCredentialGatePreserved:true,secretReads:1,supplierCalls:0,extraFieldPreparations:0,claims:0,jobs:0,submissions:0};
  });
 }finally{
  if(w&&originalFocus)w.focus=originalFocus;
  if(original.hadOwnPrepare)engine.adapter.prepareFields=original.prepareFields;else delete engine.adapter.prepareFields;
  if(w&&!w.isDestroyed()){w.close();await until(()=>w.isDestroyed());}
  if(session)session.protocol.unhandle('https');if(profile)engine.adapter.drafts.delete(profile.id);
  engine.db=original.db;engine.connection=original.connection;engine.clientFactory=original.clientFactory;engine.unseal=original.unseal;engine.unsealAsync=original.unsealAsync;engine.persist();engine.emit();
  if(profile&&!api.windows.has(profile.id))await api.deleteProfile(profile.id);
 }
};
