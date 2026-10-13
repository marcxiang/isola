const assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const {VintedAdapter}=require(path.join(root,'src/vinted-adapter.cjs'));
const FORM='https://www.vinted.fr/items/new';
const html=String.raw`<!doctype html><meta charset="utf-8"><title>Vinted form contract fixture</title>
<style>body{margin:0;font:16px Arial;color:#183432}header{padding:12px;background:#eee}main{max-width:620px;margin:20px 40px;padding-bottom:300px}label{display:block;margin-top:12px}input:not([type=radio]),textarea{display:block;padding:10px;width:560px;font:inherit;border:1px solid #aaa}textarea{height:70px}button{font:inherit;padding:10px 18px;margin:6px}#menu:not(:empty){padding:10px;background:#eef8f7;border:1px solid #099}#menu label{padding:12px;cursor:pointer}#menu.color-open{position:fixed;left:0;right:0;bottom:0;height:55vh;z-index:30;background:#e6f7f5}#menu input{margin-right:14px}footer{margin-top:24px}footer button{background:#cff}</style>
<header><select aria-label="Langue"><option selected value="fr">Français</option><option value="en">English</option></select><input aria-label="Rechercher des articles" value="test recherche"><nav role="tablist"><button type="button" role="tab">Femmes</button></nav></header>
<main><h1>Vends ton article</h1><form id="listing">
<label for="title">Titre</label><input id="title" placeholder="Dis aux acheteurs ce que tu vends">
<label for="description">Description</label><textarea id="description" placeholder="Ajoute des informations utiles"></textarea>
<label for="category">Catégorie</label><input id="category" readonly placeholder="Sélectionne une catégorie">
<div id="menu"></div>
<label for="condition">État</label><input id="condition" readonly placeholder="Sélectionne un état">
<label for="brand">Marque</label><input id="brand" readonly placeholder="Sélectionne une marque">
<label for="color">Couleur</label><input id="color" readonly placeholder="Sélectionne 2 couleurs maximum">
<label for="price">Prix</label><input id="price" inputmode="decimal" placeholder="0,00 €">
<div id="other-options"><label><input id="unrelated-grand" type="radio" name="other-choice">Grand</label></div>
<section id="shipping-options"><h2>Taille du colis</h2>
<div role="button" tabindex="0"><label><input id="parcel-petit" type="radio" name="parcel" value="Petit">Petit Convient pour un article qui tient dans une grande enveloppe.</label></div>
<div role="button" tabindex="0"><label><input id="parcel-moyen" type="radio" name="parcel" value="Moyen" checked>Recommandé Moyen Convient pour un article qui tient dans une boîte à chaussures. Voir les détails des dimensions et indemnisations</label></div>
<div role="button" tabindex="0"><label><input id="parcel-grand" type="radio" name="parcel" value="Grand">Grand Convient pour un article qui tient dans un carton de déménagement.</label></div>
</section>
<footer><button type="button" id="upload">Ajoute des photos</button><button type="button" id="save">Sauvegarder le brouillon</button><button type="submit" id="publish">Ajouter</button></footer>
</form></main>
<script>
window.fixture={events:[],saves:0,publishes:0,uploads:0,categorySearch:'',semanticButtons:false,escapes:0,stuckMenu:false,brandMenuDelay:0,brandResultsDelay:0,brandReadyDelay:0,brandReadyAt:0,ignoredBrandClicks:0,recommendationClicks:0,normalizePrice:false,wrongPrice:false,colorSuggestions:false};
for(const kind of ['click','input','keydown'])document.addEventListener(kind,event=>{if(event.target.closest('main'))fixture.events.push({kind,trusted:event.isTrusted,id:event.target.id,label:event.target.textContent.slice(0,100),key:event.key||''});},true);
const menu=document.querySelector('#menu'),cat=document.querySelector('#category'),condition=document.querySelector('#condition');
function category(level){
 menu.innerHTML='<input id="category-search" placeholder="Trouver une catégorie"><div id="choices"></div>';
 const search=menu.querySelector('input'),choices=menu.querySelector('#choices');search.value=fixture.categorySearch;
 function render(){choices.replaceChildren();if(fixture.categorySearch){choices.textContent='Résultats pour '+fixture.categorySearch;return;}
  if(level<2){const button=document.createElement(fixture.semanticButtons?'div':'button');if(fixture.semanticButtons){button.setAttribute('role','button');button.tabIndex=0;button.style.cssText='padding:16px;cursor:pointer';}else button.type='button';button.textContent=level===0?'Femmes':'Accessoires';button.onclick=()=>category(level+1);choices.append(button);}
  else{choices.innerHTML='<label><input type="radio" name="category-choice">Autres accessoires</label>';choices.querySelector('input').onchange=()=>{cat.value='Autres accessoires';menu.replaceChildren();fixture.brandReadyAt=Date.now()+fixture.brandReadyDelay;const material=document.querySelector('#material');if(material)material.value='Plastique';};}}
 search.oninput=()=>{fixture.categorySearch=search.value;render();};render();
}
cat.onclick=()=>category(0);
condition.onclick=()=>{menu.innerHTML='<label><input type="radio" name="condition-choice" data-label="Neuf avec étiquette">Neuf avec étiquette Article neuf et jamais porté</label><label><input type="radio" name="condition-choice" data-label="Neuf sans étiquette">Neuf sans étiquette Article neuf, sans étiquette ni emballage</label>';for(const choice of menu.querySelectorAll('input'))choice.onchange=()=>{condition.value=choice.dataset.label;menu.replaceChildren();};};
const brand=document.querySelector('#brand'),color=document.querySelector('#color');
brand.onclick=()=>{
 if(Date.now()<fixture.brandReadyAt){fixture.ignoredBrandClicks++;return;}
 function open(){menu.innerHTML='<input id="brand-search" placeholder="Rechercher une marque"><div id="brand-options"></div>';
 const search=menu.querySelector('#brand-search'),options=menu.querySelector('#brand-options');let timer;
 function render(){clearTimeout(timer);const value=search.value;const apply=()=>{if(!search.isConnected||search.value!==value)return;options.innerHTML=(value==='Sans marque'?'<label><input type="radio" name="brand-choice" data-label="Sans marque">Sans marque</label>':'')+'<label><input type="radio" name="brand-choice" data-label="The Unbranded Brand">The Unbranded Brand</label>';for(const choice of options.querySelectorAll('input'))choice.onchange=()=>{brand.value=choice.dataset.label;menu.replaceChildren();};};if(value==='Sans marque'&&fixture.brandResultsDelay)timer=setTimeout(apply,fixture.brandResultsDelay);else apply();}
 search.oninput=render;render();}
 if(fixture.brandMenuDelay)setTimeout(open,fixture.brandMenuDelay);else open();
};
color.onclick=()=>{
 const all='<label><input id="color-black" type="checkbox" data-label="Noir">Noir</label><label><input type="checkbox" data-label="Blanc">Blanc</label>';
 menu.classList.add('color-open');menu.innerHTML='<div role="group" aria-label="Couleur">'+(fixture.colorSuggestions?'<div><div>Suggestions</div><ul><li><label><input id="suggested-black" type="checkbox" data-label="Noir">Noir</label></li></ul></div><div><div>Toutes les couleurs</div><ul><li>'+all+'</li></ul></div>':all)+'</div>';
 for(const choice of menu.querySelectorAll('input')){choice.checked=color.value.split(', ').includes(choice.dataset.label);choice.onchange=()=>{const selected=new Set([...menu.querySelectorAll('input:checked')].map(e=>e.dataset.label));color.value=[...selected].join(', ');for(const same of menu.querySelectorAll('input'))same.checked=selected.has(same.dataset.label);};}
};
document.addEventListener('keydown',event=>{if(event.key==='Escape'){fixture.escapes++;if(!fixture.stuckMenu){menu.replaceChildren();menu.classList.remove('color-open');}}});
document.querySelector('#price').addEventListener('input',event=>{if(fixture.wrongPrice)event.target.value='50.00';else if(fixture.normalizePrice)event.target.value=event.target.value.replace(',','.');});
document.querySelector('#save').onclick=()=>fixture.saves++;
document.querySelector('#upload').onclick=()=>fixture.uploads++;
document.querySelector('#listing').onsubmit=event=>{event.preventDefault();fixture.publishes++;};
</script>`;

module.exports=async function vintedFormSmoke(api,check){
  let profile,w,session;
  const requests=[];
  try{
    profile=api.saveProfile({name:'QA Vinted local contract',url:FORM,fingerprintMode:'native',width:1180,height:900});
    session=api.sesFor(profile);
    // This session is created only for this fixture. No network request is forwarded.
    session.protocol.handle('https',request=>{requests.push(request.url);return new Response(new URL(request.url).pathname==='/items/new'?html:'Not found',{status:new URL(request.url).pathname==='/items/new'?200:404,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});});
    await api.launch(profile.id);w=api.windows.get(profile.id);w.show();w.focus();
    const tab=w.tabs[0],c=tab.view.webContents,adapter=new VintedAdapter({windows:api.windows});
    const input={title:'Test de préparation locale',description:'Description de test. Aucun article réel.',categoryPath:['Femmes','Accessoires','Autres accessoires'],condition:'Neuf avec étiquette',priceCents:500};
    await check('Vinted local runtime inspection resolves labels and keeps business capabilities disabled',async()=>{
      const state=await adapter.inspect(profile.id);assert.equal(state.verified,false);assert.equal(state.account.verified,false);assert.deepEqual(state.fields.map(f=>f.field),['title','description','categoryPath','priceCents','condition','brand','color']);assert.equal(state.capabilities.publish,false);return {fields:state.fields.map(f=>({field:f.field,label:f.label,readOnly:f.readOnly})),source:'local intercepted HTML; no live Vinted account'};
    });
    await check('Vinted local runtime uses trusted inputs and radio selections without touching publication',async()=>{
      const result=await adapter.prepareFields(profile.id,input);assert.deepEqual(result.filled.map(f=>f.field),['title','description','categoryPath','condition','priceCents']);
      const actual=await c.executeJavaScript(`({title:document.querySelector('#title').value,description:document.querySelector('#description').value,category:document.querySelector('#category').value,condition:document.querySelector('#condition').value,price:document.querySelector('#price').value,headerSearch:document.querySelector('header input').value,...fixture})`);
      assert.equal(actual.title,input.title);assert.equal(actual.description,input.description);assert.equal(actual.category,'Autres accessoires');assert.equal(actual.condition,input.condition);assert.equal(actual.price,'5,00');assert.equal(actual.headerSearch,'test recherche');assert.ok(actual.events.some(e=>e.kind==='input'));assert.ok(actual.events.every(e=>e.trusted));assert.equal(actual.saves,0);assert.equal(actual.publishes,0);assert.equal(actual.uploads,0);assert.equal(result.saved,false);assert.equal(result.published,false);assert.equal(result.draftComplete,false);return {filled:result.filled.map(f=>f.field),trustedEvents:actual.events.length,price:actual.price,publicationCount:actual.publishes};
    });
    await check('Vinted local runtime repeat preparation is idempotent for unchanged fields',async()=>{
      const count=await c.executeJavaScript('fixture.events.length'),result=await adapter.prepareFields(profile.id,input);assert.equal(await c.executeJavaScript('fixture.events.length'),count);assert.equal(result.filled.every(f=>f.unchanged),true);
    });
    await check('Vinted local runtime clears retained category search and supports semantic div buttons',async()=>{
      await c.loadURL(FORM);await c.executeJavaScript(`fixture.categorySearch='aspirateur';fixture.semanticButtons=true;category(0);`);
      const result=await adapter.prepareFields(profile.id,input);assert.deepEqual(result.filled.map(f=>f.field),['title','description','categoryPath','condition','priceCents']);
      const state=await c.executeJavaScript(`({search:fixture.categorySearch,category:document.querySelector('#category').value,events:fixture.events,saves:fixture.saves,publishes:fixture.publishes})`);
      assert.equal(state.search,'');assert.equal(state.category,'Autres accessoires');assert.ok(state.events.some(e=>e.kind==='input'&&e.id==='category-search'&&e.trusted));assert.ok(state.events.every(e=>e.trusted));assert.equal(state.saves,0);assert.equal(state.publishes,0);return {searchCleared:true,semanticButtonTags:'div',category:state.category};
    });
    await check('Vinted local runtime selects the explicit brand and closes a color overlay with trusted Escape',async()=>{
      await c.loadURL(FORM);const result=await adapter.prepareFields(profile.id,{...input,brand:'Sans marque',color:'Noir',condition:'Neuf sans étiquette'});assert.deepEqual(result.filled.map(f=>f.field),['title','description','categoryPath','brand','condition','color','priceCents']);
      const actual=await c.executeJavaScript(`({condition:document.querySelector('#condition').value,brand:document.querySelector('#brand').value,color:document.querySelector('#color').value,price:document.querySelector('#price').value,menuChildren:document.querySelector('#menu').children.length,...fixture})`);
      assert.equal(actual.condition,'Neuf sans étiquette');assert.equal(actual.brand,'Sans marque');assert.equal(actual.color,'Noir');assert.equal(actual.price,'5,00');assert.equal(actual.menuChildren,0);assert.equal(actual.escapes,1);assert.ok(actual.events.every(e=>e.trusted));const escape=actual.events.findIndex(e=>e.kind==='keydown'&&e.key==='Escape'),price=actual.events.findIndex(e=>e.kind==='input'&&e.id==='price');assert.ok(escape>=0&&price>escape);assert.equal(actual.saves,0);assert.equal(actual.publishes,0);assert.equal(actual.uploads,0);return {brand:actual.brand,color:actual.color,trustedEscape:true,priceAfterMenuClosed:true};
    });
    await check('Vinted local runtime waits for delayed brand controls and resolves an expanded price label',async()=>{
      await c.loadURL(FORM);await c.executeJavaScript(`fixture.brandReadyDelay=600;fixture.brandMenuDelay=800;fixture.brandResultsDelay=800;document.querySelector('label[for="price"]').textContent='Prix Recommandation de prix En savoir plus sur les recommandations de prix et la façon dont elles sont calculées. Recommandation de prix Voir le prix de vente d’articles similaires';const suggestion=document.createElement('button');suggestion.type='button';suggestion.textContent='Recommandation de prix';suggestion.onclick=()=>fixture.recommendationClicks++;document.querySelector('#listing').append(suggestion);`);
      const result=await adapter.prepareFields(profile.id,{...input,brand:'Sans marque',color:'Noir',condition:'Neuf sans étiquette'});assert.deepEqual(result.filled.map(f=>f.field),['title','description','categoryPath','brand','condition','color','priceCents']);
      const actual=await c.executeJavaScript(`({brand:document.querySelector('#brand').value,price:document.querySelector('#price').value,ignored:fixture.ignoredBrandClicks,recommendations:fixture.recommendationClicks,brandClicks:fixture.events.filter(e=>e.kind==='click'&&e.id==='brand').length})`);assert.equal(actual.brand,'Sans marque');assert.equal(actual.price,'5,00');assert.equal(actual.ignored,0);assert.equal(actual.recommendations,0);assert.equal(actual.brandClicks,1);return {brandMenuDelayMs:800,brandResultDelayMs:800,brandClicks:actual.brandClicks,price:actual.price};
    });
    await check('Vinted local runtime targets Toutes les couleurs when photos add duplicate Suggestions and preserves recommended material',async()=>{
      await c.loadURL(FORM);await c.executeJavaScript(`fixture.colorSuggestions=true;const label=document.createElement('label');label.htmlFor='material';label.textContent='Matériau (recommandé)';const field=document.createElement('input');field.id='material';field.readOnly=true;document.querySelector('#listing').append(label,field);`);
      const result=await adapter.prepareFields(profile.id,{...input,color:'Noir'});assert.ok(result.filled.some(field=>field.field==='color'));assert.ok(result.filled.some(field=>field.field==='priceCents'));assert.equal(result.filled.some(field=>field.field==='material'),false);
      const actual=await c.executeJavaScript(`({color:document.querySelector('#color').value,material:document.querySelector('#material').value,price:document.querySelector('#price').value,...fixture})`);assert.equal(actual.color,'Noir');assert.equal(actual.material,'Plastique');assert.equal(actual.price,'5,00');assert.equal(actual.events.filter(e=>e.kind==='click'&&e.id==='color-black').length,1);assert.equal(actual.events.some(e=>e.id==='suggested-black'||e.id==='material'),false);assert.equal(actual.escapes,1);assert.ok(actual.events.every(e=>e.trusted));await assert.rejects(adapter.prepareFields(profile.id,{...input,color:'Noir'}),{code:'EXISTING_DRAFT'});return {canonicalColorSelected:true,suggestionUntouched:true,materialPreserved:'Plastique',materialVerified:false};
    });
    await check('Vinted local runtime stops when the color overlay refuses to close',async()=>{
      await c.loadURL(FORM);await c.executeJavaScript('fixture.stuckMenu=true');const result=await adapter.prepareFields(profile.id,{color:'Noir',priceCents:500});assert.equal(result.filled.length,0);assert.match(result.unresolved.find(f=>f.field==='color').reason,/菜单尚未关闭/);assert.equal(await c.executeJavaScript(`document.querySelector('#price').value`),'');await c.executeJavaScript('fixture.stuckMenu=false;document.querySelector("#menu").replaceChildren();document.querySelector("#menu").classList.remove("color-open")');
    });
    await check('Vinted local runtime protects manually edited drafts before any new input',async()=>{
      await c.loadURL(FORM);await c.executeJavaScript(`document.querySelector('#description').value='Manual edit retained'`);const count=await c.executeJavaScript('fixture.events.length');await assert.rejects(adapter.prepareFields(profile.id,input),{code:'EXISTING_DRAFT'});assert.equal(await c.executeJavaScript('fixture.events.length'),count);assert.equal(await c.executeJavaScript(`document.querySelector('#description').value`),'Manual edit retained');
    });
    await check('Vinted local runtime refuses unknown populated listing controls while ignoring header defaults',async()=>{
      await c.loadURL(FORM);await c.executeJavaScript(`(()=>{const e=document.createElement('input');e.setAttribute('aria-label','Unknown listing property');e.value='Existing data';document.querySelector('#listing').prepend(e);})()`);await assert.rejects(adapter.prepareFields(profile.id,input),{code:'EXISTING_DRAFT'});assert.equal(await c.executeJavaScript('fixture.events.length'),0);
    });
    await check('Vinted local runtime aborts at action feedback before dispatching trusted input',async()=>{
      await c.loadURL(FORM);const prior=tab.controlFeedback;tab.controlFeedback=async event=>{if(event.stage==='acting')w.vintedDraftController.abort();};try{await assert.rejects(adapter.prepareFields(profile.id,{title:'Must stay empty'}));assert.equal(await c.executeJavaScript(`document.querySelector('#title').value`),'');assert.equal(await c.executeJavaScript('fixture.events.length'),0);assert.equal(w.vintedDraftController,null);}finally{tab.controlFeedback=prior;}
    });
    await check('Vinted local runtime main-frame navigation cancels an in-flight field preparation',async()=>{
      await c.loadURL(FORM);const prior=tab.controlFeedback;let triggered=false;tab.controlFeedback=async event=>{if(event.stage==='acting'&&!triggered){triggered=true;await c.loadURL(FORM);}};try{await assert.rejects(adapter.prepareFields(profile.id,{title:'Must not reach replacement document'}));assert.equal(await c.executeJavaScript(`document.querySelector('#title').value`),'');assert.equal(await c.executeJavaScript('fixture.events.length'),0);assert.equal(w.vintedDraftController,null);}finally{tab.controlFeedback=prior;}
    });
    await check('Vinted local runtime verifies recommended parcel without clicking and scopes changes to shipping radios',async()=>{
      await c.loadURL(FORM);const current=await adapter.prepareFields(profile.id,{parcel:'Moyen'});assert.equal(current.filled[0].field,'parcel');assert.equal(current.filled[0].selected,'Moyen');assert.equal(current.filled[0].unchanged,true);assert.equal(await c.executeJavaScript('fixture.events.length'),0);
      const changed=await adapter.prepareFields(profile.id,{parcel:'Grand'});assert.equal(changed.filled[0].selected,'Grand');assert.equal(changed.filled[0].unchanged,false);
      const actual=await c.executeJavaScript(`({parcel:document.querySelector('#shipping-options input:checked').value,unrelated:document.querySelector('#unrelated-grand').checked,events:fixture.events,saves:fixture.saves,publishes:fixture.publishes})`);assert.equal(actual.parcel,'Grand');assert.equal(actual.unrelated,false);assert.ok(actual.events.every(e=>e.trusted));assert.equal(actual.saves,0);assert.equal(actual.publishes,0);return {unchangedDefault:'Moyen',explicitSelection:actual.parcel,unrelatedRadioUntouched:true};
    });
    await check('Vinted local runtime reads hidden parcel radios through exact shipping descriptions and clicks only the visible wrapper',async()=>{
      await c.loadURL(FORM);await c.executeJavaScript(`(()=>{
        const radios=[...document.querySelectorAll('#shipping-options input')];
        function update(){for(const radio of radios){const wrapper=radio.closest('[data-parcel-wrapper]');if(radio.checked){wrapper.removeAttribute('role');wrapper.removeAttribute('tabindex');}else{wrapper.setAttribute('role','button');wrapper.tabIndex=0;}}}
        for(const radio of radios){
          radio.style.cssText='opacity:0;position:absolute';radio.setAttribute('aria-label','parcel_size');
          const wrapper=radio.parentElement.parentElement;wrapper.dataset.parcelWrapper=radio.value;wrapper.id='visible-parcel-'+radio.value;wrapper.style.cssText='padding:14px;cursor:pointer';
          const repeat=document.createElement('span');repeat.textContent=wrapper.textContent;wrapper.append(repeat);
          wrapper.onclick=event=>{event.preventDefault();radio.checked=true;update();};
        }
        update();
      })()`);
      const snapshot=await require(path.join(root,'src/page-control.cjs')).checkedSnapshot(tab,{allowedOrigins:new Set(['https://www.vinted.fr'])});
      assert.equal(snapshot.elements.filter(e=>e.tag==='input'&&e.type==='radio'&&e.label==='parcel_size').length,0);assert.ok(snapshot.elements.some(e=>e.role==='button'&&e.label.includes('Grand Convient pour un article qui tient dans un carton de déménagement.')));
      const current=await adapter.prepareFields(profile.id,{parcel:'Moyen'});assert.equal(current.filled[0]?.selected,'Moyen');assert.equal(current.filled[0]?.unchanged,true);assert.equal(await c.executeJavaScript('fixture.events.length'),0);
      const changed=await adapter.prepareFields(profile.id,{parcel:'Grand'});assert.equal(changed.filled[0]?.selected,'Grand');assert.equal(changed.filled[0]?.unchanged,false);
      const actual=await c.executeJavaScript(`({parcel:document.querySelector('#shipping-options input:checked').value,unrelated:document.querySelector('#unrelated-grand').checked,events:fixture.events,saves:fixture.saves,publishes:fixture.publishes})`);
      assert.equal(actual.parcel,'Grand');assert.equal(actual.unrelated,false);assert.ok(actual.events.some(e=>e.kind==='click'));assert.ok(actual.events.every(e=>e.trusted));assert.equal(actual.events.some(e=>e.kind==='click'&&e.id.startsWith('parcel-')),false);assert.equal(actual.saves,0);assert.equal(actual.publishes,0);return {hiddenNativeControlsAbsentFromSnapshot:true,unchangedDefault:'Moyen',explicitSelection:actual.parcel,visibleWrapperClick:true};
    });
    await check('Vinted local runtime accepts a normalized dot price and then confirms the parcel',async()=>{
      await c.loadURL(FORM);await c.executeJavaScript('fixture.normalizePrice=true');const result=await adapter.prepareFields(profile.id,{priceCents:500,parcel:'Moyen'});assert.deepEqual(result.filled.map(f=>f.field),['priceCents','parcel']);assert.equal(await c.executeJavaScript(`document.querySelector('#price').value`),'5.00');return {renderedPrice:'5.00',verifiedCents:500,parcel:'Moyen'};
    });
    await check('Vinted local runtime rejects a changed amount and stops before parcel interaction',async()=>{
      await c.loadURL(FORM);await c.executeJavaScript('fixture.wrongPrice=true');const result=await adapter.prepareFields(profile.id,{priceCents:500,parcel:'Grand'});assert.equal(result.filled.length,0);assert.match(result.unresolved.find(f=>f.field==='priceCents').reason,/价格.*不一致/);assert.equal(await c.executeJavaScript(`document.querySelector('#shipping-options input:checked').value`),'Moyen');assert.equal(await c.executeJavaScript(`fixture.events.some(e=>e.id==='parcel-grand')`),false);
    });
    await check('Vinted local fixture remains inside a fresh isolated profile with no real requests',async()=>{assert.ok(requests.length>0);assert.ok(requests.every(url=>url.startsWith('https://www.vinted.fr/')));return {interceptedRequests:requests.length,networkForwarding:false};});
  }finally{
    if(w&&!w.isDestroyed())w.close();await new Promise(resolve=>setTimeout(resolve,200));if(session)session.protocol.unhandle('https');if(profile)await api.deleteProfile(profile.id);
  }
};
