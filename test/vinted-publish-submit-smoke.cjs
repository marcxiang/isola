'use strict';

const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {VintedAdapter}=require('../src/vinted-adapter.cjs');
const {VintedPublishSubmit}=require('../src/vinted-publish-submit.cjs');
const {probePublicationForm,FIELD_SPECS}=require('../src/vinted-publication-evidence.cjs');
const FORM='https://www.vinted.fr/items/new';
const PHOTO='https://fixture.test/photo.png',AVATAR='https://fixture.test/avatar.png';
const hash=value=>createHash('sha256').update(value).digest('hex'),photoSignature=hash(JSON.stringify([hash(PHOTO)]));
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n0AAAAASUVORK5CYII=','base64');
const html=String.raw`<!doctype html><meta charset="utf-8"><title>Local single-publication fixture</title>
<style>body{margin:0;font:16px Arial}header{padding:15px}main{max-width:660px;margin:18px 30px}label{display:block;margin-top:14px}input:not([type=radio]):not([type=file]),textarea{padding:8px;width:560px;font:inherit}textarea{height:55px}button{padding:14px;margin:8px}#photos input,#parcels input{display:none}#parcels button{display:block;text-align:left;width:590px}footer{padding-top:120px;padding-bottom:30px}</style>
<header><button type="button">Ajouter</button><input aria-label="Rechercher des articles" value="header search"><div style="position:fixed;top:10px;right:10px;z-index:10;background:white"><button id="avatar" type="button" aria-expanded="true" aria-controls="account-menu"><img src="https://fixture.test/avatar.png" alt="fixture" width="20" height="20"></button><div id="account-menu" aria-labelledby="avatar"><a id="profile-link" href="/member/123">Mon profil</a><button type="button">Paramètres</button><button type="button">Mes commandes</button><button type="button">Se déconnecter</button></div></div></header>
<main><form id="listing"><div id="photos" data-testid="media-upload"><input type="file" data-testid="add-photos-input" accept="image/jpeg"><button type="button">Ajoute des photos</button><img id="photo" src="https://fixture.test/photo.png" width="80" height="80" alt="Photo 1 sur 1 mise en ligne Pour réorganiser les photos, appuie sur la barre d'espace"><button type="button">Supprimer la photo sélectionnée</button><button type="button">Modifier la photo 1</button></div>
<label for="title">Titre</label><input id="title" value="Article local de test">
<label for="description">Description</label><textarea id="description">Fixture locale uniquement.</textarea>
<label for="category">Catégorie</label><input id="category" readonly value="Accessoires pour appareils de nettoyage">
<label for="condition">État</label><input id="condition" readonly value="Neuf sans étiquette">
<label for="brand">Marque</label><input id="brand" readonly value="Sans marque">
<label for="color">Couleur</label><input id="color" readonly value="Noir">
<label for="material">Matériau (recommandé)</label><input id="material" readonly value="">
<label><input type="checkbox" id="boost">Boost</label>
<label for="price">Prix</label><input id="price" placeholder="0,00&nbsp;€" value="5,00">
<div id="parcels"><button type="button"><label><input type="radio" name="parcel">Petit Convient pour un article qui tient dans une grande enveloppe.</label></button><button type="button"><label><input type="radio" name="parcel" checked>Recommandé Moyen Convient pour un article qui tient dans une boîte à chaussures.</label></button><button type="button"><label><input type="radio" name="parcel">Grand Convient pour un article qui tient dans un carton de déménagement.</label></button></div>
<footer><button type="button">Sauvegarder le brouillon</button><button id="publish" type="submit">Ajouter</button></footer></form></main>
<script>window.fixture={publishes:0,clicks:[]};document.addEventListener('click',event=>fixture.clicks.push({id:event.target.id,label:event.target.textContent.trim(),trusted:event.isTrusted}));document.querySelector('#listing').onsubmit=event=>{event.preventDefault();fixture.publishes++;history.pushState(null,'','/items/77777-local-test');};</script>`;

module.exports=async function publishSubmitSmoke(api,check){
 let profile,session,w;
 try{
  profile=api.saveProfile({name:'QA local guarded publication',url:FORM,fingerprintMode:'native',width:1180,height:900});session=api.sesFor(profile);
  session.protocol.handle('https',request=>[PHOTO,AVATAR,'https://fixture.test/replaced.png'].includes(request.url)?new Response(image,{headers:{'content-type':'image/png','cache-control':'no-store'}}):new Response(request.url===FORM?html:'Not found',{status:request.url===FORM?200:404,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}}));
  await api.launch(profile.id);w=api.windows.get(profile.id);const tab=w.tabs[0],contents=tab.view.webContents,adapter=new VintedAdapter({windows:api.windows});
  const listing={title:'Article local de test',description:'Fixture locale uniquement.',categoryPath:['Maison','Entretien de la maison','Aspirateurs et nettoyage','Accessoires pour appareils de nettoyage'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
  function setup(){
   const plan={id:'local-plan',profileId:profile.id,productId:'local-product',sku:'LOCAL-ONLY',listing,listingPriceCents:500,currency:'EUR',enabled:true,completedCount:0,targetCount:1,activeListingId:null};
   const expectedAccount={profileId:profile.id,memberId:'123',profileURL:'https://www.vinted.fr/member/123'},claim={id:'local-claim',profileId:profile.id,productId:plan.productId,setId:'local-set',images:[{id:'local-image'}]};
   const input={plan,expectedAccount,claim,product:{id:plan.productId,sku:plan.sku,stock:1},manifest:{claimId:claim.id,profileId:profile.id,productId:plan.productId,setId:claim.setId,count:1,files:[{sha256:'a'.repeat(64)}]}};
   const engine={adapter,db:{publications:{version:1,submissions:[]},marketAccounts:[expectedAccount]},plan:()=>plan,persist:()=>{},emit:()=>{}};
   // This fixture isolates the dispatch boundary: field evidence comes from
   // actual DOM while account/photo receipts are explicit local fixture data.
   // Production construction uses VintedPublicationEvidence without overrides.
   const evidenceFactory=()=>({readPass:async(_input,context)=>{
    await adapter.read(profile.id,context);const form=await adapter.control.isolated(tab,'('+probePublicationForm.toString()+')('+JSON.stringify(FIELD_SPECS)+')');assert.equal(form.error,undefined);
    const documentKey=form.documentKey,fields=form.fields.map(field=>({...field,value:field.field==='categoryPath'?listing.categoryPath:field.field==='priceCents'?Math.round(Number(field.value.replace(',','.'))*100):field.value}));fields.push({field:'parcel',value:form.parcel.find(option=>option.checked)?.name,disabled:false,invalid:false});
    const key=profile.id+'\0'+tab.id+'\0'+documentKey;if(!adapter.photos.claims.has(key))adapter.photos.claims.set(key,{phase:'verified',claimId:claim.id,documentKey,manifestKey:hash(JSON.stringify({claimId:claim.id,files:input.manifest.files.map(file=>file.sha256),count:1})),signature:photoSignature});
    return {profileId:profile.id,tabId:tab.id,url:form.url,documentKey,fields,account:{...expectedAccount,verified:true},challenge:false,unknownFields:form.unknownFields,invalidFields:form.invalidFields,alerts:form.alerts,dialogs:form.dialogs,publication:form.publication,photos:{profileId:profile.id,productId:plan.productId,claimId:claim.id,setId:claim.setId,count:1,signature:photoSignature,documentKey,verified:true,busy:false,errorCount:0}};
   }});
   return {engine,input,service:new VintedPublishSubmit({enabled:true,evidenceFactory,navigationWaitMs:1000})};
  }
  await check('guarded publication local runtime emits one trusted native click and persists only an uncertain navigation candidate',async()=>{
   const {engine,input,service}=setup(),result=await service.submit({engine,planId:input.plan.id,input,guard:()=>{}}),actual=await contents.executeJavaScript('({...fixture})');
   assert.equal(actual.publishes,1);assert.deepEqual(actual.clicks,[{id:'publish',label:'Ajouter',trusted:true}]);assert.equal(result.published,false);assert.equal(result.state,'uncertain');assert.equal(engine.db.publications.submissions[0].attemptCount,1);assert.equal(engine.db.publications.submissions[0].receipt,null);assert.equal(result.navigationCandidate.listingId,'77777');assert.ok(engine.db.publications.submissions[0].navigation.some(item=>item.committed));
   await assert.rejects(service.submit({engine,planId:input.plan.id,input,guard:()=>{}}));assert.equal(await contents.executeJavaScript('fixture.publishes'),1);return {trustedNativeClicks:1,publicationReceipt:false,navigationCandidate:'77777',externalRequestsForwarded:0};
  });
  await check('guarded publication local runtime rereads values after the visual prompt and blocks a changed price',async()=>{
   await contents.loadURL(FORM);const {engine,input,service}=setup(),feedback=tab.controlFeedback;
   tab.controlFeedback=async event=>{await feedback?.(event);if(event.stage==='preparing')await contents.executeJavaScript(`document.querySelector('#price').value='6,00'`);};
   try{await assert.rejects(service.submit({engine,planId:input.plan.id,input,guard:()=>{}}));const actual=await contents.executeJavaScript('({...fixture})');assert.equal(actual.publishes,0);assert.deepEqual(actual.clicks,[]);assert.equal(engine.db.publications.submissions[0].state,'cancelled');assert.equal(engine.db.publications.submissions[0].attemptCount,0);}
   finally{tab.controlFeedback=feedback;}
  });
  await check('guarded publication atomic final DOM read blocks account, photo and Boost changes after the last full proof',async()=>{
   for(const script of ["document.querySelector('#profile-link').href='/member/999'","document.querySelector('#photo').src='https://fixture.test/replaced.png'","document.querySelector('#boost').checked=true"]){
    await contents.loadURL(FORM);const {engine,input,service}=setup(),target=adapter.control.target;
    adapter.control.target=async(...args)=>{const found=await target.apply(adapter.control,args);if(args[3]?.scroll===false)await contents.executeJavaScript(script);return found;};
    try{await assert.rejects(service.submit({engine,planId:input.plan.id,input,guard:()=>{}}));assert.equal(await contents.executeJavaScript('fixture.publishes'),0);assert.deepEqual(await contents.executeJavaScript('fixture.clicks'),[]);assert.equal(engine.db.publications.submissions[0].state,'uncertain');}
    finally{adapter.control.target=target;}
   }
   return {blockedFinalChanges:3,nativeClicks:0,externalRequestsForwarded:0};
  });
 }finally{if(w&&!w.isDestroyed())w.close();await new Promise(resolve=>setTimeout(resolve,200));if(session)session.protocol.unhandle('https');if(profile)await api.deleteProfile(profile.id);}
};
