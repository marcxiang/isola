'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {VintedAdapter}=require('../src/vinted-adapter.cjs');
const FORM='https://www.vinted.fr/items/new';
const html=String.raw`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Local mobile material picker discovery</title>
<style>body{margin:0;font:16px Arial}main{margin:35px;width:580px}label{display:block;margin:12px 0}input[type=text]{display:block;width:540px;padding:10px;font:inherit}.parcel{padding:8px}#background-controls button{padding:6px;margin:2px}#material-picker{position:fixed;top:20px;left:25px;width:620px;max-height:84vh;z-index:40;background:#fff;border:2px solid #077;box-shadow:0 0 0 2000px #0005}#material-picker>.picker-head{display:flex;align-items:center;gap:16px;padding:8px 14px;background:#eee}#material-picker h2{font-size:20px;flex:1}#material-picker button{padding:12px 18px;font:inherit}#material-picker .picker-options{max-height:56vh;overflow:auto;padding:12px}#material-picker input{margin-right:14px}#material-picker label{padding:8px;margin:4px 0}#material-picker h3{margin:8px 0}</style>
<main><h1>Vends ton article</h1><form id="listing"><label for="title">Titre</label><input type="text" id="title" placeholder="Dis aux acheteurs ce que tu vends"><label for="price">Prix</label><input type="text" id="price" inputmode="decimal" placeholder="0,00 €"><section id="shipping-options"><h2>Taille du colis</h2><div class="parcel" role="button" tabindex="0"><label><input type="radio" name="parcel" value="Petit">Petit Convient pour un article qui tient dans une grande enveloppe.</label></div><div class="parcel" role="button" tabindex="0"><label><input type="radio" name="parcel" value="Moyen" checked>Recommandé Moyen Convient pour un article qui tient dans une boîte à chaussures. Voir les détails des dimensions et indemnisations</label></div><div class="parcel" role="button" tabindex="0"><label><input type="radio" name="parcel" value="Grand">Grand Convient pour un article qui tient dans un carton de déménagement.</label></div></section><label for="material">Matériau (recommandé)</label><input type="text" readonly id="material" placeholder="Sélectionne un matériau"></form></main><div id="background-controls"></div>
<script>
window.fixture={layout:'header-only',events:[],confirmations:0,opened:0,backgroundClicks:0};
for(const kind of ['click','input','keydown'])document.addEventListener(kind,event=>fixture.events.push({kind,id:event.target.id,trusted:event.isTrusted}),true);
window.setPickerLayout=layout=>{fixture.layout=layout;document.querySelector('#background-controls').replaceChildren();if(layout!=='header-only'){for(let i=0;i<180;i++){const button=document.createElement('button');button.type='button';button.textContent='Fixture background control '+i;button.onclick=()=>fixture.backgroundClicks++;document.querySelector('#background-controls').append(button);}}};
document.querySelector('#material').onclick=()=>{
 fixture.opened++;const picker=document.createElement('section');picker.id='material-picker';picker.setAttribute('role','dialog');picker.setAttribute('aria-modal','true');picker.setAttribute('aria-label','Matériau (recommandé)');const header=document.createElement(fixture.layout==='cap-only'?'div':'header');header.className='picker-head';header.innerHTML='<h2>Matériau (recommandé)</h2><button type="button" id="picker-done" disabled>Fait</button>';picker.append(header);
 const options=document.createElement('div');options.className='picker-options';const count=fixture.layout==='header-only'?1:48;options.innerHTML='<div id="material-suggestions"><h3>Suggestions</h3><label><input type="checkbox" id="suggested-plastic" checked>Plastique</label></div><div id="material-all"><h3>Toutes</h3><label><input type="checkbox" id="canonical-plastic" checked>Plastique</label></div>';for(let i=0;i<count;i++){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.id='fixture-option-'+i;label.append(input,document.createTextNode('Matériau de fixture '+i));options.querySelector('#material-all').append(label);}picker.append(options);document.body.append(picker);
 const canonical=picker.querySelector('#canonical-plastic'),mirror=picker.querySelector('#suggested-plastic'),done=picker.querySelector('#picker-done');canonical.onchange=()=>{done.disabled=true;setTimeout(()=>{mirror.checked=canonical.checked;done.disabled=!!picker.querySelector('input:checked');},200);};done.onclick=()=>{fixture.confirmations++;if(!picker.querySelector('input:checked')){document.querySelector('#material').value='';picker.remove();}};
};
</script>`;

// Set ISOLA_MATERIAL_DISCOVERY_EXPECT_FAILURE=1 only for the pre-fix baseline.
// It records the same native DOM/snapshot facts and expects the conservative old
// helper to stop after opening the picker, before unchecking or confirming.
module.exports=async function materialPickerDiscoverySmoke(api,check){
 assert.ok(process.env.ISOLA_TEST_DATA,'Material discovery smoke requires isolated test data');
 assert.equal(path.resolve(path.dirname(api.dataFile())),path.resolve(process.env.ISOLA_TEST_DATA));
 const baseline=process.env.ISOLA_MATERIAL_DISCOVERY_EXPECT_FAILURE==='1',requests=[];
 let profile,session,w;
 try{
  profile=api.saveProfile({name:'QA mobile material discovery fixture',url:FORM,fingerprintMode:'native',width:1180,height:900});session=api.sesFor(profile);
  session.protocol.handle('https',request=>{requests.push({method:request.method,url:request.url});return request.method==='GET'&&request.url===FORM?new Response(html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}}):new Response('No network forwarding',{status:403});});
  await api.launch(profile.id);w=api.windows.get(profile.id);w.show();w.focus();const tab=w.tabs[0],contents=tab.view.webContents,adapter=new VintedAdapter({windows:api.windows});
  async function run(layout,{dropEnabledRegistration=false}={}){
   await contents.loadURL(FORM);await contents.executeJavaScript(`setPickerLayout(${JSON.stringify(layout)});void 0;`);
   const prepared=await adapter.prepareFields(profile.id,{title:'Owned material discovery fixture',priceCents:500,parcel:'Moyen'});assert.deepEqual(prepared.filled.map(field=>field.field),['title','priceCents','parcel']);
   const owner=adapter.drafts.get(profile.id);assert.equal(owner.tab,tab);assert.equal(owner.fields.priceCents,'5,00');await contents.executeJavaScript(`document.querySelector('#material').value='Plastique'`);
   const before=await contents.executeJavaScript(`({title:document.querySelector('#title').value,price:document.querySelector('#price').value,parcel:document.querySelector('#shipping-options input:checked').value})`),start=await contents.executeJavaScript('fixture.events.length'),originalRead=adapter.read;
   let diagnostic=null,unregisteredEnabledFait=0;
   adapter.read=async function(...args){
    const page=await originalRead.apply(this,args);
    if(!diagnostic){
     const measured=await adapter.control.isolated(tab,`(()=>{const picker=document.querySelector('#material-picker');if(!picker)return null;const d=globalThis.__isolaDOM,done=picker.querySelector('#picker-done');return {nativeCandidateCount:d.collect().length,domCheckboxCount:picker.querySelectorAll('input[type=checkbox]').length,domFaitCount:[...picker.querySelectorAll('button')].filter(button=>button.textContent.trim()==='Fait').length,domFaitDisabled:done.disabled,faitInsideHeader:!!done.closest('header'),uniquePickerTitle:picker.querySelectorAll('h2').length===1,scopeContainsOriginalField:picker.contains(document.querySelector('#material'))||picker.contains(document.querySelector('#title'))||picker.contains(document.querySelector('#price')),allInputsInCanonicalOrSuggestions:[...picker.querySelectorAll('input')].every(input=>!!input.closest('#material-all,#material-suggestions'))};})()`);
     if(measured)diagnostic={...measured,snapshotElementCount:page.elements.length,snapshotFaitCount:page.elements.filter(element=>element.tag==='button'&&element.label==='Fait').length,snapshotCheckboxCount:page.elements.filter(element=>element.tag==='input'&&element.type==='checkbox').length};
    }
    if(dropEnabledRegistration){
     const ids=page.elements.filter(element=>element.tag==='button'&&element.label==='Fait'&&element.disabled===false).map(element=>element.id);
     if(ids.length){unregisteredEnabledFait+=ids.length;await adapter.control.isolated(tab,`(()=>{for(const id of ${JSON.stringify(ids)})globalThis.__isolaElements?.delete(id);return true;})()`);return {...page,elements:page.elements.filter(element=>!ids.includes(element.id))};}
    }
    return page;
   };
   try{
    if(baseline||dropEnabledRegistration)await assert.rejects(adapter.clearOptionalMaterial(profile.id),{code:'OPTIONAL_MATERIAL_UNVERIFIED'});
    else assert.deepEqual(await adapter.clearOptionalMaterial(profile.id),{verified:true,cleared:true,unchanged:false,published:false,saved:false});
   }finally{adapter.read=originalRead;}
   assert.ok(diagnostic);assert.equal(diagnostic.domFaitCount,1);assert.equal(diagnostic.domFaitDisabled,true);assert.equal(diagnostic.uniquePickerTitle,true);assert.equal(diagnostic.scopeContainsOriginalField,false);assert.equal(diagnostic.allInputsInCanonicalOrSuggestions,true);
   if(layout==='header-only'){assert.equal(diagnostic.faitInsideHeader,true);assert.equal(diagnostic.domCheckboxCount,3);assert.ok(diagnostic.snapshotElementCount<160);assert.equal(diagnostic.snapshotFaitCount,1);}
   else{assert.equal(diagnostic.domCheckboxCount,50);assert.ok(diagnostic.nativeCandidateCount>160);assert.equal(diagnostic.snapshotElementCount,160);assert.equal(diagnostic.snapshotFaitCount,0);assert.equal(diagnostic.snapshotCheckboxCount,50);assert.equal(diagnostic.faitInsideHeader,layout==='combined');}
   const state=await contents.executeJavaScript(`({title:document.querySelector('#title').value,price:document.querySelector('#price').value,parcel:document.querySelector('#shipping-options input:checked').value,material:document.querySelector('#material').value,selected:[...document.querySelectorAll('#material-picker input:checked')].length,...fixture})`),actions=state.events.slice(start);
   assert.deepEqual({title:state.title,price:state.price,parcel:state.parcel},before);assert.equal(state.backgroundClicks,0);assert.equal(state.opened,1);assert.ok(actions.every(event=>event.trusted));assert.equal(w.vintedDraftController,null);
   const canonicalClicks=actions.filter(event=>event.kind==='click'&&event.id==='canonical-plastic').length,doneClicks=actions.filter(event=>event.kind==='click'&&event.id==='picker-done').length;assert.equal(actions.some(event=>event.id==='suggested-plastic'),false);
   if(baseline){assert.equal(state.material,'Plastique');assert.equal(state.selected,2);assert.equal(state.confirmations,0);assert.equal(canonicalClicks,0);assert.equal(doneClicks,0);}
   else if(dropEnabledRegistration){assert.ok(unregisteredEnabledFait>0);assert.equal(state.material,'Plastique');assert.equal(state.selected,0);assert.equal(state.confirmations,0);assert.equal(canonicalClicks,1);assert.equal(doneClicks,0);}
   else{assert.equal(state.material,'');assert.equal(state.confirmations,1);assert.equal(canonicalClicks,1);assert.equal(doneClicks,1);}
   assert.ok(requests.every(request=>request.method==='GET'&&request.url===FORM));
   return {layout,baselineExpectedFailure:baseline,diagnostic,cleared:!baseline&&!dropEnabledRegistration,canonicalClicks,doneClicks,unregisteredEnabledFait,originalFieldsAndParcelPreserved:true,suggestedMirrorClicked:false,publicationControls:0,publishes:0,networkForwarding:false};
  }
  await check('mobile material picker header keeps native Fait visible in the snapshot while isolating the old header exclusion',()=>run('header-only'));
  await check('long mobile material list retains all 50 checkbox controls but drops disabled Fait at the real 160-element snapshot cap',()=>run('cap-only'));
  await check('mobile material header and long list combine both discovery boundaries without widening the native commit guard',()=>run('combined'));
  if(!baseline)await check('mobile material cleanup cannot commit an enabled Fait without a fresh registered snapshot element',()=>run('combined',{dropEnabledRegistration:true}));
 }finally{
  if(w&&!w.isDestroyed())w.close();await new Promise(resolve=>setTimeout(resolve,200));if(session)session.protocol.unhandle('https');if(profile&&!api.windows.has(profile.id))await api.deleteProfile(profile.id);
 }
};
