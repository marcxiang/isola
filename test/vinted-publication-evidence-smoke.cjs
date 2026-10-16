'use strict';

const assert=require('node:assert/strict');
const {VintedAdapter}=require('../src/vinted-adapter.cjs');
const {probePublicationForm,publicationBlockerDetails,FIELD_SPECS}=require('../src/vinted-publication-evidence.cjs');
const FORM='https://www.vinted.fr/items/new';
const html=String.raw`<!doctype html><meta charset="utf-8"><title>Publication evidence local fixture</title>
<style>body{margin:0;font:16px Arial}header{padding:12px;background:#eee}main{max-width:720px;margin:16px 28px}label{display:block;margin:10px 0}input:not([type=file]):not([type=radio]),textarea{display:block;width:580px;padding:8px;font:inherit}button{padding:12px;margin:6px}#parcel input{display:none}#parcel button{display:block;width:620px;text-align:left}#photo-input{display:none}</style>
<header><select aria-label="Langue"><option selected>Français</option></select><input aria-label="Rechercher des articles" value="outside listing"><nav><button type="button">Ajouter</button></nav></header>
<main><form id="listing">
<div data-testid="media-upload"><input id="photo-input" type="file" data-testid="add-photos-input" accept="image/jpeg" multiple><button type="button">Ajouter des photos</button></div>
<label for="title">Titre</label><input id="title" placeholder="Dis aux acheteurs ce que tu vends" value="Accessoire pour aspirateur noir neuf">
<label for="description">Description</label><textarea id="description" placeholder="Ajoute des informations utiles">Sans marque. Neuf sans étiquette ni emballage.</textarea>
<label for="category">Catégorie</label><input id="category" readonly placeholder="Sélectionne une catégorie" value="Accessoires pour appareils de nettoyage">
<label for="condition">État</label><input id="condition" readonly placeholder="Sélectionne un état" value="Neuf sans étiquette">
<label for="brand">Marque</label><input id="brand" readonly placeholder="Sélectionne une marque" value="Sans marque">
<label for="color">Couleur</label><input id="color" readonly placeholder="Sélectionne 2 couleurs maximum" value="Noir">
<label for="material">Matériau (recommandé)</label><input id="material" readonly placeholder="Sélectionne un matériau">
<label for="price">Prix Recommandation de prix En savoir plus sur les recommandations de prix et la façon dont elles sont calculées.</label><input id="price" inputmode="decimal" placeholder="0,00&nbsp;€" value="5.00">
<section id="parcel"><h2>Taille du colis</h2>
<button type="button"><label><input type="radio" name="parcel" id="small">Petit Convient pour un article qui tient dans une grande enveloppe.</label></button>
<button type="button"><label><input type="radio" name="parcel" id="medium" checked>Recommandé Moyen Convient pour un article qui tient dans une boîte à chaussures. Voir les détails des dimensions et indemnisations</label></button>
<button type="button"><label><input type="radio" name="parcel" id="large">Grand Convient pour un article qui tient dans un carton de déménagement.</label></button>
</section><footer><button type="button">Sauvegarder le brouillon</button><button id="publish" type="submit">Ajouter</button></footer>
</form></main><script>
window.fixture={clicks:0,mouseDowns:0,inputs:0,submits:0};document.addEventListener('click',()=>fixture.clicks++);document.addEventListener('mousedown',()=>fixture.mouseDowns++);document.addEventListener('input',()=>fixture.inputs++);document.querySelector('#listing').addEventListener('submit',event=>{event.preventDefault();fixture.submits++;});
</script>`;

module.exports=async function publicationEvidenceSmoke(api,check){
 let profile,session,w;const requests=[];
 try{
  profile=api.saveProfile({name:'QA local publication evidence',url:FORM,fingerprintMode:'native',width:1180,height:900});session=api.sesFor(profile);
  session.protocol.handle('https',request=>{requests.push(request.url);return new Response(request.url===FORM?html:'Not found',{status:request.url===FORM?200:404,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});});
  await api.launch(profile.id);w=api.windows.get(profile.id);const tab=w.tabs[0],contents=tab.view.webContents,adapter=new VintedAdapter({windows:api.windows});
  const probe=async()=>{await adapter.read(profile.id,{tab,form:true});return adapter.control.isolated(tab,'('+probePublicationForm.toString()+')('+JSON.stringify(FIELD_SPECS)+')');};
  const untouched=async()=>assert.deepEqual(await contents.executeJavaScript('({...fixture})'),{clicks:0,mouseDowns:0,inputs:0,submits:0});
  await check('publication evidence real DOM resolves expanded price label and NBSP placeholder, hidden parcel radios and header exclusion',async()=>{
   const result=await probe();assert.equal(result.error,undefined);assert.equal(result.fields.length,7);assert.equal(result.fields.find(field=>field.field==='priceCents').value,'5.00');assert.equal(result.parcel.length,3);assert.deepEqual(result.parcel.filter(option=>option.checked).map(option=>option.name),['Moyen']);assert.deepEqual(result.unknownFields,[]);assert.deepEqual(result.invalidFields,[]);assert.equal(result.publication.count,1);assert.equal(result.publication.enabled,true);await untouched();return {fields:7,parcel:'Moyen',unknownOptionalMaterial:'empty',headerPublishButtonExcluded:true,source:'local intercepted HTML, not a live Vinted page'};
  });
  await check('publication evidence real DOM rejects populated optional material without adopting or clearing the value',async()=>{
   await contents.executeJavaScript(`document.querySelector('#material').value='Plastique'`);const result=await probe();assert.deepEqual(result.unknownFields.map(field=>({label:field.label,populated:field.populated,required:field.required})),[{label:'Matériau (recommandé)',populated:true,required:false}]);assert.deepEqual(publicationBlockerDetails(result),['可选材质已填入但未在计划确认；请先清空该可选字段，或核实材质并在计划中确认后重试']);assert.ok(!publicationBlockerDetails(result).join('；').includes('Plastique'));assert.equal(await contents.executeJavaScript(`document.querySelector('#material').value`),'Plastique');await untouched();
  });
  await check('publication evidence real DOM blocks empty required or invalid material',async()=>{
   await contents.executeJavaScript(`document.querySelector('#material').value='';document.querySelector('#material').required=true`);let result=await probe();assert.equal(result.unknownFields[0].required,true);
   await contents.executeJavaScript(`document.querySelector('#material').required=false;document.querySelector('#material').setAttribute('aria-invalid','true')`);result=await probe();assert.ok(result.invalidFields.includes('Matériau (recommandé)'));assert.equal(result.unknownFields[0].invalid,true);await untouched();
   await contents.executeJavaScript(`document.querySelector('#material').removeAttribute('aria-invalid');const form=document.querySelector('#listing');form.insertAdjacentHTML('beforeend','<label for="private-field">fixture-private-label</label><input id="private-field" value="fixture-private-value" required aria-invalid="true"><div role="status">fixture-private-status</div><div aria-modal="true">fixture-private-dialog</div>')`);result=await probe();assert.deepEqual(publicationBlockerDetails(result),['其他未知字段 1 项（必填 1 项、错误 1 项、已填入 1 项）','字段错误 1 项（其他字段 1 项）','页面状态提示 1 条（错误或未知状态，需在网页核对）','页面弹窗 1 个']);assert.ok(!publicationBlockerDetails(result).join('；').includes('fixture-private-'));await untouched();
  });
  await check('publication evidence real DOM requires a unique enabled form publication control',async()=>{
   await contents.loadURL(FORM);await contents.executeJavaScript(`document.querySelector('#publish').disabled=true`);assert.equal((await probe()).publication.enabled,false);
   await contents.executeJavaScript(`document.querySelector('#publish').disabled=false;document.querySelector('footer').append(document.querySelector('#publish').cloneNode(true))`);const result=await probe();assert.equal(result.publication.count,2);assert.equal(result.publication.enabled,false);await untouched();
  });
  await check('publication evidence real DOM common-container fallback requires the observed upload widget',async()=>{
   await contents.loadURL(FORM);await contents.executeJavaScript(`(()=>{const form=document.querySelector('#listing'),replacement=document.createElement('div');replacement.id='listing';replacement.append(...form.childNodes);form.replaceWith(replacement);})()`);let result=await probe();assert.equal(result.error,undefined);assert.equal(result.publication.count,1);
   await contents.executeJavaScript(`document.querySelector('[data-testid="media-upload"]').remove()`);result=await probe();assert.match(result.error,/照片|表单/);await untouched();
  });
  await check('publication evidence local fixture sends no click, input or submission events',async()=>{await untouched();assert.ok(requests.every(url=>new URL(url).origin==='https://www.vinted.fr'));return {clicks:0,mouseDowns:0,inputs:0,submits:0,externalRequestsForwarded:0};});
 }finally{
  if(w&&!w.isDestroyed())w.close();await new Promise(resolve=>setTimeout(resolve,200));if(session)session.protocol.unhandle('https');if(profile)await api.deleteProfile(profile.id);
 }
};
