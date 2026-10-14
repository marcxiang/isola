'use strict';
const assert=require('node:assert/strict');
const {VintedAdapter}=require('../src/vinted-adapter.cjs');
const {probeCatalogDOM,catalogSurface,OWN_EMPTY_WARDROBE}=require('../src/vinted-catalog.cjs');
const PROFILE='https://www.vinted.fr/member/123456',TITLE='Local catalog test accessory';
const html=String.raw`<!doctype html><meta charset="utf-8"><title>Own empty wardrobe local fixture</title>
<style>body{margin:0;font:16px Arial}header{padding:16px}main{padding:12px}h1{font-size:24px}section{padding:24px 8px}a,button{display:inline-block;padding:12px;color:#066}p{line-height:1.5}[role=tablist]{display:flex}[hidden]{display:none!important}iframe{width:200px;height:80px}</style>
<header>Local fixture seller</header><main><div role="tablist"><button role="tab" aria-selected="true" id="annonces">Annonces</button><button role="tab" aria-selected="false">Évaluations</button><button role="tab" aria-selected="false">À propos</button></div>
<section id="empty"><h1>Ajoute des articles pour commencer à vendre</h1><div><p id="subtitle">Fais du tri&nbsp;! Vends ce que tu n'utilises plus.</p></div><a id="create" href="https://www.vinted.fr/items/new">Ajouter un article</a></section></main>
<script>window.fixture={clicks:0,inputs:0,submits:0};document.addEventListener('click',()=>fixture.clicks++);document.addEventListener('input',()=>fixture.inputs++);document.addEventListener('submit',()=>fixture.submits++);</script>`;
module.exports=async function catalogSmoke(api,check){
 let profile,session,w;const requests=[];
 try{
  profile=api.saveProfile({name:'QA empty own wardrobe',url:PROFILE,fingerprintMode:'native',width:393,height:852});session=api.sesFor(profile);
  session.protocol.handle('https',request=>{requests.push(request.url);return new Response(request.url===PROFILE?html:'Not found',{status:request.url===PROFILE?200:404,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});});
  await api.launch(profile.id);w=api.windows.get(profile.id);const tab=w.tabs[0],contents=tab.view.webContents,adapter=new VintedAdapter({windows:api.windows});
  const expectedAccount={profileId:profile.id,memberId:'123456',profileURL:PROFILE,username:'fixture_seller'};
  const probe=async()=>{await adapter.read(profile.id,{tab});const raw=await adapter.control.isolated(tab,'('+probeCatalogDOM.toString()+')([],'+JSON.stringify(OWN_EMPTY_WARDROBE)+')');return {raw,surface:catalogSurface(raw,{expectedAccount,title:TITLE})};};
  const untouched=async()=>assert.deepEqual(await contents.executeJavaScript('({...fixture})'),{clicks:0,inputs:0,submits:0});
  await check('catalog Chromium DOM recognizes observed own mobile empty wardrobe without an article-count heading',async()=>{
   const {raw,surface}=await probe();assert.deepEqual(raw.countLabels,[]);assert.deepEqual(raw.links,[]);assert.equal(raw.emptyState.subtitle,OWN_EMPTY_WARDROBE.subtitle);assert.equal(raw.emptyState.selectedTab,'Annonces');assert.equal(surface.complete,true);assert.equal(surface.count,0);assert.equal(surface.absent,true);assert.equal(surface.duplicate,false);await untouched();return {countHeadingObserved:false,explicitEmpty:true,visibleItemLinks:0,source:'local intercepted HTML using observed French empty-state copy'};
  });
  await check('catalog Chromium DOM requires one selected Annonces tab and the unique same-region empty-state components',async()=>{
   const changes=[`document.querySelector('#annonces').setAttribute('aria-selected','false')`,`document.querySelector('#create').hidden=true`,`document.querySelector('#annonces').hidden=true`,`document.querySelector('h1').hidden=true`,`document.querySelector('#subtitle').hidden=true`,`document.querySelector('#empty').hidden=true`,`document.querySelector('#empty').append(document.querySelector('h1').cloneNode(true))`,`document.querySelector('main').append(document.querySelector('#subtitle'))`,`document.querySelector('#create').href='https://www.vinted.fr/items/new?draft=1'`];
   for(const source of changes){await contents.loadURL(PROFILE);await contents.executeJavaScript(source);if(source.endsWith('.hidden=true')){const selector=/querySelector\('([^']+)'\)/.exec(source)[1],hidden=await contents.executeJavaScript('(()=>{const e=document.querySelector('+JSON.stringify(selector)+'),r=e.getBoundingClientRect();return {hidden:e.hidden,display:getComputedStyle(e).display,width:r.width,height:r.height};})()');assert.deepEqual(hidden,{hidden:true,display:'none',width:0,height:0},source+' must actually hide the DOM element');}const {surface}=await probe();assert.equal(surface.absent,false,source);await untouched();}return {rejectedShapes:changes.length};
  });
  await check('catalog Chromium DOM rejects conflicting counts, real items, busy state and visible dialogs even with the empty-state text',async()=>{
   const changes=[`document.querySelector('main').insertAdjacentHTML('beforeend','<h2>1 article</h2>')`,`document.querySelector('main').insertAdjacentHTML('beforeend','<a href="https://www.vinted.fr/items/654321" aria-label="Other accessory, état: Neuf sans étiquette, 5,00 €">Other accessory</a>')`,`document.querySelector('#empty').setAttribute('aria-busy','true')`,`document.querySelector('main').insertAdjacentHTML('beforeend','<div role="dialog">Vérification</div>')`,`document.querySelector('main').insertAdjacentHTML('beforeend','<div role="alert">Erreur de chargement</div>')`];
   for(const source of changes){await contents.loadURL(PROFILE);await contents.executeJavaScript(source);assert.equal((await probe()).surface.absent,false,source);await untouched();}return {rejectedConflicts:changes.length};
  });
  await check('catalog Chromium DOM reads consistently and performs no native click, input or external request forwarding',async()=>{
   await contents.loadURL(PROFILE);const first=await probe(),second=await probe();assert.deepEqual(first,second);assert.equal(second.surface.absent,true);await untouched();assert.ok(requests.every(url=>new URL(url).origin==='https://www.vinted.fr'));return {consistentReads:2,clicks:0,inputs:0,submits:0,externalRequestsForwarded:0};
  });
 }finally{if(w&&!w.isDestroyed())w.close();await new Promise(resolve=>setTimeout(resolve,200));if(session)session.protocol.unhandle('https');if(profile)await api.deleteProfile(profile.id);}
};
