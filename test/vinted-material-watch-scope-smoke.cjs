'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {app}=require('electron');
const control=require('../src/page-control.cjs');
const {getDisplayState}=require('../src/display-transform.cjs');
const {VintedAdapter}=require('../src/vinted-adapter.cjs');
const FORM='https://www.vinted.fr/items/new';
const html=String.raw`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Local material watched-field scope fixture</title>
<style>body{margin:0;font:16px Arial}header{padding:12px;background:#eee}main{margin:25px;width:580px}label{display:block;margin:10px 0}input[type=text]{display:block;width:540px;padding:10px;font:inherit}.parcel{padding:6px}#material-picker{position:fixed;top:20px;left:25px;width:620px;z-index:40;background:white;border:2px solid #077;box-shadow:0 0 0 2000px #0005}#material-picker header{display:flex;align-items:center;gap:16px}#material-picker h2{flex:1}#material-picker button{padding:12px 18px;font:inherit}.picker-options{padding:12px}#material-picker label{padding:8px}</style>
<header id="site-header"><label for="site-search">Rechercher des articles</label><input type="text" id="site-search" value=""></header>
<main><h1>Vends ton article</h1><form id="listing"><div id="unknown-host"></div><label for="title">Titre</label><input type="text" id="title" placeholder="Dis aux acheteurs ce que tu vends"><label for="price">Prix</label><input type="text" id="price" inputmode="decimal" placeholder="0,00 €"><section id="shipping-options"><h2>Taille du colis</h2><div class="parcel" role="button" tabindex="0"><label><input type="radio" name="parcel" value="Petit">Petit Convient pour un article qui tient dans une grande enveloppe.</label></div><div class="parcel" role="button" tabindex="0"><label><input type="radio" name="parcel" value="Moyen" checked>Recommandé Moyen Convient pour un article qui tient dans une boîte à chaussures. Voir les détails des dimensions et indemnisations</label></div><div class="parcel" role="button" tabindex="0"><label><input type="radio" name="parcel" value="Grand">Grand Convient pour un article qui tient dans un carton de déménagement.</label></div></section><label for="material">Matériau (recommandé)</label><input type="text" readonly id="material" placeholder="Sélectionne un matériau"></form></main>
<script>
window.fixture={mode:'header-node',events:[],opened:0,confirmations:0,replaced:0};
for(const kind of ['click','input','keydown'])document.addEventListener(kind,event=>fixture.events.push({kind,id:event.target.id,trusted:event.isTrusted}),true);
window.configureFixture=mode=>{fixture.mode=mode;if(mode==='unknown-empty-node'){const host=document.querySelector('#unknown-host');host.className='site-header';host.innerHTML='<label for="unknown-empty">Recherche de fixture</label><input type="text" id="unknown-empty" value="">';}};
window.captureOriginalNodes=()=>{window.originalNodes={search:document.querySelector('#site-search'),unknown:document.querySelector('#unknown-empty'),title:document.querySelector('#title'),price:document.querySelector('#price'),material:document.querySelector('#material'),parcels:[...document.querySelectorAll('#shipping-options input')]};};
document.querySelector('#material').onclick=()=>{
 fixture.opened++;
 const replace=id=>{const original=document.getElementById(id);original.replaceWith(original.cloneNode(true));fixture.replaced++;};
 if(fixture.mode==='header-node')replace('site-search');
 if(fixture.mode==='unknown-empty-node')replace('unknown-empty');
 if(fixture.mode==='title-node')replace('title');
 if(fixture.mode==='price-value')document.querySelector('#price').value='9,00';
 const picker=document.createElement('section');picker.id='material-picker';picker.setAttribute('role','dialog');picker.setAttribute('aria-modal','true');picker.setAttribute('aria-label','Matériau (recommandé)');picker.innerHTML='<header><h2>Matériau (recommandé)</h2><button type="button" id="picker-done" disabled>Fait</button></header><div class="picker-options"><div id="material-suggestions"><h3>Suggestions</h3><label><input type="checkbox" id="suggested-plastic" checked>Plastique</label></div><div id="material-all"><h3>Toutes</h3><label><input type="checkbox" id="canonical-plastic" checked>Plastique</label><label><input type="checkbox" id="other-material">Autre</label></div></div>';document.body.append(picker);
 const canonical=picker.querySelector('#canonical-plastic'),mirror=picker.querySelector('#suggested-plastic'),done=picker.querySelector('#picker-done');canonical.onchange=()=>{done.disabled=true;setTimeout(()=>{mirror.checked=canonical.checked;done.disabled=!!picker.querySelector('input:checked');},200);};done.onclick=()=>{fixture.confirmations++;if(!picker.querySelector('input:checked')){document.querySelector('#material').value='';picker.remove();}};
};
</script>`;

// This fixture distinguishes a genuinely unrelated header from an unknown
// empty control inside the listing form. The latter is intentionally watched;
// its failure only demonstrates the guard mechanism, not the live-site cause.
module.exports=async function materialWatchScopeSmoke(api,check){
 assert.ok(app.commandLine.hasSwitch('use-mock-keychain'),'The isolated fixture requires process-level --use-mock-keychain');
 assert.ok(process.env.ISOLA_TEST_DATA);assert.equal(path.resolve(path.dirname(api.dataFile())),path.resolve(process.env.ISOLA_TEST_DATA));
 const displayMode=process.env.ISOLA_MATERIAL_WATCH_DISPLAY_MODE||'focused';assert.ok(['focused','background-ready'].includes(displayMode),'Unknown isolated material display mode');
 const requests=[];let profile,session,w;
 try{
  profile=api.saveProfile({name:'QA material original-field scope fixture',url:FORM,fingerprintMode:'native',width:1180,height:900});session=api.sesFor(profile);
  session.protocol.handle('https',request=>{requests.push({method:request.method,url:request.url});return request.method==='GET'&&request.url===FORM?new Response(html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}}):new Response('No network forwarding',{status:403});});
  await api.launch(profile.id);w=api.windows.get(profile.id);const tab=w.tabs[0],contents=tab.view.webContents;
  async function ready(){
   if(displayMode==='focused'&&process.platform==='darwin')app.focus({steal:true});
   if(w.isMinimized())w.restore();
   if(displayMode==='focused'){w.show();w.focus();}else w.showInactive();
   contents.focus();const end=Date.now()+10000;let stableAt=0,version;
   while(Date.now()<end){
    assert.equal(w.activeTab,tab.id);const state=getDisplayState(contents),visible=state.ready===true&&state.active===true&&tab.isInputVisible()===true&&w.isVisible()&&!w.isMinimized()&&(displayMode!=='focused'||w.isFocused())&&!contents.isLoadingMainFrame();
    if(visible){if(version!==state.version){version=state.version;stableAt=Date.now();}if(Date.now()-stableAt>=200)return {ready:true,active:true,inputVisible:true,windowVisible:true,windowMinimized:false,windowFocused:w.isFocused(),loadingMainFrame:false};}else{stableAt=0;version=undefined;}
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   // Read these fixture-owned native booleans before finally closes the
   // window. No screen, URL, accessibility text or system state is captured.
   const display=getDisplayState(contents),fixtureDisplayState={ready:display.ready===true,active:display.active===true,inputVisible:tab.isInputVisible()===true,windowVisible:w.isVisible(),windowMinimized:w.isMinimized(),windowFocused:w.isFocused(),loadingMainFrame:contents.isLoadingMainFrame()};
   throw Object.assign(Error('Isolated material fixture display did not become genuinely ready'),{code:'FIXTURE_DISPLAY_NOT_READY',fixtureDisplayState});
  }
  async function run(mode){
   await contents.loadURL(FORM);const displayReady=await ready();await contents.executeJavaScript(`configureFixture(${JSON.stringify(mode)});void 0;`);
   let capture=false,diagnostic=null;const actionFocus=[];
   const nativeControl={...control,performAction:async function(target,args,options){
    if(capture&&!diagnostic&&args.action==='click')diagnostic=await control.isolated(target,`(()=>{const g=globalThis.__isolaOptionalMaterial;if(!g)return null;const search=document.querySelector('#site-search'),unknown=document.querySelector('#unknown-empty'),title=document.querySelector('#title'),price=document.querySelector('#price');return {watchedCount:g.watched.length,headerSearchWatched:g.watched.some(item=>item.node===search),unknownEmptyWatched:!!unknown&&g.watched.some(item=>item.node===unknown),ownedTitleWatched:g.watched.some(item=>item.node===title),ownedPriceWatched:g.watched.some(item=>item.node===price),originalChoiceCount:g.originalChoices.length};})()`);
    if(['click','type','key','scroll'].includes(args.action))actionFocus.push({phase:capture?'material':'prepare',action:args.action,windowFocused:w.isFocused()});
    return control.performAction(target,args,options);
   }};
   const adapter=new VintedAdapter({windows:api.windows,control:nativeControl}),prepared=await adapter.prepareFields(profile.id,{title:'Owned material scope fixture',priceCents:500,parcel:'Moyen'});
   assert.deepEqual(prepared.filled.map(field=>field.field),['title','priceCents','parcel']);const owner=adapter.drafts.get(profile.id);assert.equal(owner.tab,tab);assert.equal(owner.fields.priceCents,'5,00');
   await contents.executeJavaScript(`document.querySelector('#material').value='Plastique';captureOriginalNodes();void 0;`);const before=await contents.executeJavaScript('fixture.events.length');capture=true;
   let blocked=false,materialReason=null;
   if(mode==='header-node')assert.deepEqual(await adapter.clearOptionalMaterial(profile.id),{verified:true,cleared:true,unchanged:false,published:false,saved:false});
   else await assert.rejects(adapter.clearOptionalMaterial(profile.id),error=>{assert.equal(error.code,'OPTIONAL_MATERIAL_UNVERIFIED');assert.equal(error.materialReason,mode==='price-value'?'watched_value':'watched_disconnected');blocked=true;materialReason=error.materialReason;return true;});
   assert.ok(diagnostic);assert.equal(diagnostic.headerSearchWatched,false);assert.equal(diagnostic.ownedTitleWatched,true);assert.equal(diagnostic.ownedPriceWatched,true);assert.equal(diagnostic.unknownEmptyWatched,mode==='unknown-empty-node');assert.equal(diagnostic.originalChoiceCount,3);
   const state=await contents.executeJavaScript(`({title:document.querySelector('#title').value,price:document.querySelector('#price').value,material:document.querySelector('#material').value,parcel:document.querySelector('#shipping-options input:checked').value,titleNodePreserved:originalNodes.title===document.querySelector('#title'),priceNodePreserved:originalNodes.price===document.querySelector('#price'),materialNodePreserved:originalNodes.material===document.querySelector('#material'),headerSearchNodeRebuilt:originalNodes.search!==document.querySelector('#site-search'),unknownEmptyNodeRebuilt:!!originalNodes.unknown&&originalNodes.unknown!==document.querySelector('#unknown-empty'),parcelNodesPreserved:originalNodes.parcels.every(node=>node.isConnected&&node===document.querySelector('#shipping-options input[value="'+node.value+'"]')),selected:document.querySelectorAll('#material-picker input:checked').length,...fixture})`),actions=state.events.slice(before),canonicalClicks=actions.filter(event=>event.kind==='click'&&event.id==='canonical-plastic').length,doneClicks=actions.filter(event=>event.kind==='click'&&event.id==='picker-done').length;
   assert.equal(state.title,'Owned material scope fixture');assert.equal(state.price,mode==='price-value'?'9,00':'5,00');assert.equal(state.parcel,'Moyen');assert.equal(state.titleNodePreserved,mode!=='title-node');assert.equal(state.priceNodePreserved,true);assert.equal(state.materialNodePreserved,true);assert.equal(state.parcelNodesPreserved,true);assert.equal(state.headerSearchNodeRebuilt,mode==='header-node');assert.equal(state.unknownEmptyNodeRebuilt,mode==='unknown-empty-node');assert.equal(state.opened,1);assert.ok(actions.every(event=>event.trusted));assert.equal(actions.some(event=>event.id==='suggested-plastic'),false);assert.equal(w.vintedDraftController,null);
   if(blocked){assert.equal(state.material,'Plastique');assert.equal(state.selected,2);assert.equal(canonicalClicks,0);assert.equal(doneClicks,0);assert.equal(state.confirmations,0);}
   else{assert.equal(state.material,'');assert.equal(canonicalClicks,1);assert.equal(doneClicks,1);assert.equal(state.confirmations,1);}
   assert.ok(requests.every(request=>request.method==='GET'&&request.url===FORM));
   return {mode,displayMode,displayReady,actionFocus,unfocusedActionObserved:actionFocus.some(entry=>entry.windowFocused===false),diagnostic,blocked,materialReason,headerSearchNodeRebuilt:state.headerSearchNodeRebuilt,unknownEmptyNodeRebuilt:state.unknownEmptyNodeRebuilt,titleNodePreserved:state.titleNodePreserved,priceNodePreserved:state.priceNodePreserved,materialNodePreserved:state.materialNodePreserved,parcelNodesPreserved:state.parcelNodesPreserved,canonicalClicks,doneClicks,publishes:0,publicationControls:0,networkForwarding:false,liveCauseEstablished:false};
  }
  await check('rebuilding an unrelated empty semantic-header search leaves native material cleanup and all business fields intact',()=>run('header-node'));
  await check('rebuilding an unknown empty listing-form control conservatively stops material cleanup without changing any selection',()=>run('unknown-empty-node'));
  await check('rebuilding an owned title node with the same value still stops native material cleanup before unchecking',()=>run('title-node'));
  await check('changing the owned price value still stops native material cleanup and preserves the original parcel',()=>run('price-value'));
 }finally{
  if(w&&!w.isDestroyed())w.close();await new Promise(resolve=>setTimeout(resolve,200));if(session)session.protocol.unhandle('https');if(profile&&!api.windows.has(profile.id))await api.deleteProfile(profile.id);
 }
};
