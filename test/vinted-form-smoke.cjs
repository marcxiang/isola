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
window.fixture={events:[],saves:0,publishes:0,uploads:0,categorySearch:'',semanticButtons:false,escapes:0,stuckMenu:false,brandMenuDelay:0,brandResultsDelay:0,brandReadyDelay:0,brandReadyAt:0,ignoredBrandClicks:0,recommendationClicks:0,normalizePrice:false,wrongPrice:false,colorSuggestions:false,mobilePickers:false,partialMobileDone:false,replaceMobileChooser:false,confirmedMenus:[]};
for(const kind of ['click','input','keydown'])document.addEventListener(kind,event=>{if(event.target.closest('main'))fixture.events.push({kind,trusted:event.isTrusted,id:event.target.id,label:event.target.textContent.slice(0,100),key:event.key||''});},true);
let menu=document.querySelector('#menu');const cat=document.querySelector('#category'),condition=document.querySelector('#condition');
function modalHeader(label){return '<div class="modal-header"><div><h2><span>'+label+'</span></h2></div><button type="button" aria-label="Fermer">×</button></div>';}
function commitChoice(name,apply){if(!fixture.mobilePickers){apply();return;}let done=menu.querySelector('[data-done]');if(!done){done=document.createElement('button');done.type='button';done.dataset.done=name;done.id=name+'-done';done.textContent='Fait';menu.append(done);}done.onclick=()=>{fixture.confirmedMenus.push(name);apply();if(fixture.partialMobileDone&&name==='color'){if(fixture.replaceMobileChooser){const old=menu;menu=old.cloneNode(false);old.replaceWith(menu);}menu.innerHTML=modalHeader('Couleur')+'<label><input type="checkbox" data-label="Blanc">Blanc</label><button type="button">Fait</button>';menu.classList.add('color-open');}};}
function category(level){
 menu.setAttribute('aria-label','Catégorie');
 menu.innerHTML='<input id="category-search" placeholder="Trouver une catégorie"><div id="choices"></div>';
 const search=menu.querySelector('input'),choices=menu.querySelector('#choices');search.value=fixture.categorySearch;
 function render(){choices.replaceChildren();if(fixture.categorySearch){choices.textContent='Résultats pour '+fixture.categorySearch;return;}
  if(level<2){const button=document.createElement(fixture.semanticButtons?'div':'button');if(fixture.semanticButtons){button.setAttribute('role','button');button.tabIndex=0;button.style.cssText='padding:16px;cursor:pointer';}else button.type='button';button.textContent=level===0?'Femmes':'Accessoires';button.onclick=()=>category(level+1);choices.append(button);}
  else{choices.innerHTML='<label><input type="radio" name="category-choice">Autres accessoires</label>';choices.querySelector('input').onchange=()=>commitChoice('category',()=>{cat.value='Autres accessoires';menu.replaceChildren();fixture.brandReadyAt=Date.now()+fixture.brandReadyDelay;const material=document.querySelector('#material');if(material)material.value='Plastique';});}}
 search.oninput=()=>{fixture.categorySearch=search.value;render();};render();
}
cat.onclick=()=>category(0);
condition.onclick=()=>{menu.removeAttribute('aria-label');menu.innerHTML=modalHeader('État')+'<label><input type="radio" name="condition-choice" data-label="Neuf avec étiquette">Neuf avec étiquette Article neuf et jamais porté</label><label><input type="radio" name="condition-choice" data-label="Neuf sans étiquette">Neuf sans étiquette Article neuf, sans étiquette ni emballage</label>';for(const choice of menu.querySelectorAll('input'))choice.onchange=()=>commitChoice('condition',()=>{condition.value=choice.dataset.label;menu.replaceChildren();});};
const brand=document.querySelector('#brand'),color=document.querySelector('#color');
brand.onclick=()=>{
 menu.setAttribute('aria-label','Marque');
 if(Date.now()<fixture.brandReadyAt){fixture.ignoredBrandClicks++;return;}
 function open(){menu.innerHTML='<input id="brand-search" placeholder="Rechercher une marque"><div id="brand-options"></div>';
 const search=menu.querySelector('#brand-search'),options=menu.querySelector('#brand-options');let timer;
 function render(){clearTimeout(timer);const value=search.value;const apply=()=>{if(!search.isConnected||search.value!==value)return;options.innerHTML=(value==='Sans marque'?'<label><input type="radio" name="brand-choice" data-label="Sans marque">Sans marque</label>':'')+'<label><input type="radio" name="brand-choice" data-label="The Unbranded Brand">The Unbranded Brand</label>';for(const choice of options.querySelectorAll('input'))choice.onchange=()=>commitChoice('brand',()=>{brand.value=choice.dataset.label;menu.replaceChildren();});};if(value==='Sans marque'&&fixture.brandResultsDelay)timer=setTimeout(apply,fixture.brandResultsDelay);else apply();}
 search.oninput=render;render();}
 if(fixture.brandMenuDelay)setTimeout(open,fixture.brandMenuDelay);else open();
};
color.onclick=()=>{
 menu.removeAttribute('aria-label');
 const all='<label><input id="color-black" type="checkbox" data-label="Noir">Noir</label><label><input type="checkbox" data-label="Blanc">Blanc</label>';
 menu.classList.add('color-open');menu.innerHTML=modalHeader('Couleur')+'<div role="group" aria-label="Couleur">'+(fixture.colorSuggestions?'<div><div>Suggestions</div><ul><li><label><input id="suggested-black" type="checkbox" data-label="Noir">Noir</label></li></ul></div><div><div>Toutes les couleurs</div><ul><li>'+all+'</li></ul></div>':all)+'</div>';
 for(const choice of menu.querySelectorAll('input')){choice.checked=color.value.split(', ').includes(choice.dataset.label);choice.onchange=()=>{const selected=new Set([...menu.querySelectorAll('input:checked')].map(e=>e.dataset.label));for(const same of menu.querySelectorAll('input'))same.checked=selected.has(same.dataset.label);commitChoice('color',()=>{color.value=[...selected].join(', ');if(fixture.mobilePickers){menu.replaceChildren();menu.classList.remove('color-open');}});};}
};
document.addEventListener('keydown',event=>{if(event.key==='Escape'){fixture.escapes++;if(!fixture.stuckMenu){menu.replaceChildren();menu.classList.remove('color-open');}}});
document.querySelector('#price').addEventListener('input',event=>{if(fixture.wrongPrice)event.target.value='50.00';else if(fixture.normalizePrice)event.target.value=event.target.value.replace(',','.');});
document.querySelector('#save').onclick=()=>fixture.saves++;
document.querySelector('#upload').onclick=()=>fixture.uploads++;
document.querySelector('#listing').onsubmit=event=>{event.preventDefault();fixture.publishes++;};
function installMaterialPicker(mode='normal'){
 fixture.materialMode=mode;fixture.materialConfirmations=0;fixture.materialReadyAt=0;fixture.materialConfirmedAt=0;fixture.materialDoneEmpty=false;
 const label=document.createElement('label');label.htmlFor='material';label.textContent='Matériau (recommandé)';const field=document.createElement('input');field.id='material';field.readOnly=true;field.placeholder='Sélectionne un matériau';document.querySelector('#listing').append(label,field);
 const style=document.createElement('style');style.textContent='#menu.material-open{position:fixed;left:35px;top:25px;width:600px;max-height:85vh;overflow:auto;z-index:40;background:white;padding:12px}#menu.material-open input{display:inline-block;width:auto}#menu.material-open label{margin:0;padding:10px}#menu.material-open h3{margin:8px}';document.head.append(style);
 field.onclick=()=>{
  menu.classList.add('material-open');menu.innerHTML=modalHeader('Matériau (recommandé)')+'<div id="material-suggestions"><h3>Suggestions</h3><label><input id="material-suggested-plastic" type="checkbox" checked>Plastique</label></div><div id="material-all"><h3>Toutes</h3><label><input id="material-all-plastic" type="checkbox" checked>Plastique</label><label><input id="material-all-cotton" type="checkbox">Coton</label></div><button id="material-done" type="button" disabled>Fait</button>';
  const canonical=menu.querySelector('#material-all-plastic'),suggested=menu.querySelector('#material-suggested-plastic'),done=menu.querySelector('#material-done');fixture.materialInitialDoneDisabled=done.disabled;
  if(mode==='duplicate-canonical')canonical.parentElement.after(canonical.parentElement.cloneNode(true));
  if(mode==='unknown-duplicate')menu.append(canonical.parentElement.cloneNode(true));
  if(mode==='extra-selected')menu.querySelector('#material-all-cotton').checked=true;
  if(mode==='initial-desync')suggested.checked=false;
  canonical.onchange=()=>{done.disabled=true;setTimeout(()=>{if(mode==='stuck-mirror')return;suggested.checked=canonical.checked;fixture.materialReadyAt=Date.now();done.disabled=!!menu.querySelector('input:checked');},900);};
  done.onclick=()=>{fixture.materialConfirmations++;fixture.materialConfirmedAt=Date.now();fixture.materialDoneEmpty=menu.querySelectorAll('input:checked').length===0;if(fixture.materialDoneEmpty){field.value='';menu.replaceChildren();menu.classList.remove('material-open');}};
 };
}
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
    await check('Vinted mobile pickers use trusted scoped Fait confirmations before reading committed fields',async()=>{
      await c.loadURL(FORM);await c.executeJavaScript(`fixture.mobilePickers=true;const other=document.createElement('button');other.type='button';other.textContent='Fait';other.id='unrelated-done';other.onclick=()=>fixture.saves++;document.querySelector('footer').append(other);`);
      const result=await adapter.prepareFields(profile.id,{...input,brand:'Sans marque',color:'Noir',condition:'Neuf sans étiquette'});
      assert.deepEqual(result.filled.map(field=>field.field),['title','description','categoryPath','brand','condition','color','priceCents']);
      const state=await c.executeJavaScript(`({category:cat.value,brand:brand.value,condition:condition.value,color:color.value,price:document.querySelector('#price').value,menuChildren:menu.children.length,...fixture})`);
      assert.deepEqual(state.confirmedMenus,['category','brand','condition','color']);assert.equal(state.category,'Autres accessoires');assert.equal(state.brand,'Sans marque');assert.equal(state.condition,'Neuf sans étiquette');assert.equal(state.color,'Noir');assert.equal(state.price,'5,00');assert.equal(state.menuChildren,0);assert.equal(state.escapes,0);assert.equal(state.saves,0);assert.equal(state.publishes,0);assert.equal(state.uploads,0);assert.ok(state.events.every(event=>event.trusted));
      for(const name of state.confirmedMenus)assert.ok(state.events.some(event=>event.kind==='click'&&event.id===name+'-done'&&event.trusted));
      assert.equal(state.events.some(event=>event.id==='unrelated-done'),false);return {confirmedMenus:state.confirmedMenus,trustedConfirmations:true,unrelatedFaitClicked:false,publicationCount:state.publishes};
    });
    await check('Vinted mobile color commits the all-colors option with one synchronized Suggestions mirror',async()=>{
      await c.loadURL(FORM);await c.executeJavaScript('fixture.mobilePickers=true;fixture.colorSuggestions=true');
      const result=await adapter.prepareFields(profile.id,{color:'Noir',priceCents:500});assert.deepEqual(result.filled.map(field=>field.field),['color','priceCents']);
      const state=await c.executeJavaScript(`({color:color.value,price:document.querySelector('#price').value,menuChildren:menu.children.length,...fixture})`);
      assert.deepEqual(state.confirmedMenus,['color']);assert.equal(state.color,'Noir');assert.equal(state.price,'5,00');assert.equal(state.menuChildren,0);assert.ok(state.events.some(event=>event.kind==='click'&&event.id==='color-black'&&event.trusted));assert.ok(state.events.some(event=>event.kind==='click'&&event.id==='color-done'&&event.trusted));assert.equal(state.events.some(event=>event.kind==='click'&&event.id==='suggested-black'),false);assert.equal(state.saves,0);assert.equal(state.publishes,0);assert.equal(state.uploads,0);return {canonicalColorClicked:true,suggestedColorClicked:false,trustedFait:true,menuClosed:true,priceAfterClose:state.price};
    });
    await check('Vinted mobile color leaves other checked colors and duplicate or unknown target controls untouched',async()=>{
      for(const change of [
        `menu.querySelector('input[data-label="Blanc"]').checked=true`,
        `document.querySelector('#color-black').parentElement.after(document.querySelector('#color-black').parentElement.cloneNode(true))`,
        `document.querySelector('#suggested-black').parentElement.after(document.querySelector('#suggested-black').parentElement.cloneNode(true))`,
        `menu.append(document.querySelector('#color-black').parentElement.cloneNode(true))`
      ]){
        await c.loadURL(FORM);await c.executeJavaScript(`fixture.mobilePickers=true;fixture.colorSuggestions=true;color.addEventListener('click',()=>{${change}})`);
        const result=await adapter.prepareFields(profile.id,{color:'Noir',priceCents:500});assert.deepEqual(result.filled,[]);assert.equal(result.unresolved.find(field=>field.field==='color').halted,true);
        const state=await c.executeJavaScript(`({color:color.value,price:document.querySelector('#price').value,...fixture})`);assert.equal(state.color,'');assert.equal(state.price,'');assert.deepEqual(state.confirmedMenus,[]);assert.equal(state.events.some(event=>event.kind==='click'&&['color-black','suggested-black','color-done'].includes(event.id)),false);assert.equal(state.saves,0);assert.equal(state.publishes,0);
      }
      return {blockedScenarios:4,leafOrFaitClicks:0,laterFieldInput:false};
    });
    await check('Vinted mobile Fait cannot continue into price while its chooser still shows other controls',async()=>{
      for(const replaced of [false,true]){
        await c.loadURL(FORM);await c.executeJavaScript(`fixture.mobilePickers=true;fixture.partialMobileDone=true;fixture.replaceMobileChooser=${replaced}`);
        const result=await adapter.prepareFields(profile.id,{color:'Noir',priceCents:500});assert.deepEqual(result.filled,[]);assert.match(result.unresolved.find(field=>field.field==='color').reason,/仍未关闭/);
        const state=await c.executeJavaScript(`({color:color.value,price:document.querySelector('#price').value,remainingColors:[...menu.querySelectorAll('input')].map(input=>input.dataset.label),...fixture})`);assert.equal(state.color,'Noir');assert.equal(state.price,'');assert.deepEqual(state.remainingColors,['Blanc']);assert.deepEqual(state.confirmedMenus,['color']);assert.equal(state.events.some(event=>event.id==='price'),false);assert.equal(state.saves,0);assert.equal(state.publishes,0);
      }
      return {chosenOptionGone:true,otherOptionVisible:true,alsoRejectsReplacementPicker:true,priceUntouched:true};
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
    await check('Vinted explicit optional-material cleanup clears the canonical choice, waits for its Suggestions mirror and commits zero selections once',async()=>{
      await c.loadURL(FORM);await c.executeJavaScript('installMaterialPicker()');
      const prepared=await adapter.prepareFields(profile.id,{...input,brand:'Sans marque',color:'Noir',parcel:'Moyen'});assert.ok(prepared.filled.some(field=>field.field==='categoryPath'));assert.equal(await c.executeJavaScript(`document.querySelector('#material').value`),'Plastique');
      await c.executeJavaScript(`const photo=document.createElement('img');photo.id='material-test-photo';photo.alt='Photo 1 sur 1 mise en ligne';photo.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';document.querySelector('#listing').append(photo)`);
      const unchanged=()=>c.executeJavaScript(`({fields:Object.fromEntries(['title','description','category','condition','brand','color','price'].map(id=>[id,document.getElementById(id).value])),parcel:document.querySelector('#shipping-options input:checked').value,photo:document.querySelector('#material-test-photo').outerHTML,headerSearch:document.querySelector('header input').value})`),before=await unchanged(),start=await c.executeJavaScript('fixture.events.length');
      const result=await adapter.clearOptionalMaterial(profile.id);assert.deepEqual(result,{verified:true,cleared:true,unchanged:false,published:false,saved:false});assert.deepEqual(await unchanged(),before);
      const state=await c.executeJavaScript(`({material:document.querySelector('#material').value,remaining:menu.children.length,...fixture})`),actions=state.events.slice(start);assert.equal(state.material,'');assert.equal(state.remaining,0);assert.equal(state.materialInitialDoneDisabled,true);assert.equal(state.materialDoneEmpty,true);assert.equal(state.materialConfirmations,1);assert.ok(state.materialReadyAt>0&&state.materialConfirmedAt>=state.materialReadyAt);assert.ok(actions.every(event=>event.trusted));assert.equal(actions.filter(event=>event.kind==='click'&&event.id==='material-all-plastic').length,1);assert.equal(actions.filter(event=>event.kind==='click'&&event.id==='material-done').length,1);assert.equal(actions.some(event=>event.id==='material-suggested-plastic'),false);assert.equal(state.saves,0);assert.equal(state.publishes,0);assert.equal(state.uploads,0);
      const count=state.events.length;assert.deepEqual(await adapter.clearOptionalMaterial(profile.id),{verified:true,cleared:false,unchanged:true,published:false,saved:false});assert.equal(await c.executeJavaScript('fixture.events.length'),count);return {trustedCanonicalUncheck:true,suggestionsMirrorDelayMs:900,emptySelectionConfirmed:true,otherFieldsAndPhotoPreserved:true,emptyCleanupWasNoop:true,publishes:0};
    });
    await check('Vinted optional-material cleanup rejects required, duplicate, extra or unsynchronized selections without confirming them',async()=>{
      const cases=['required','duplicate-field','duplicate-canonical','unknown-duplicate','extra-selected','initial-desync','stuck-mirror'];
      for(const mode of cases){
        await c.loadURL(FORM);await c.executeJavaScript(`installMaterialPicker(${JSON.stringify(mode)})`);await adapter.prepareFields(profile.id,{title:'Owned local item',priceCents:500,parcel:'Moyen'});
        await c.executeJavaScript(`document.querySelector('#material').value='Plastique';${mode==='required'?'document.querySelector("#material").required=true':mode==='duplicate-field'?'document.querySelector("#material").after(document.querySelector("#material").cloneNode(true))':''}`);const start=await c.executeJavaScript('fixture.events.length');
        await assert.rejects(adapter.clearOptionalMaterial(profile.id),{code:'OPTIONAL_MATERIAL_UNVERIFIED'});
        const state=await c.executeJavaScript(`({material:document.querySelector('#material').value,title:document.querySelector('#title').value,price:document.querySelector('#price').value,parcel:document.querySelector('#shipping-options input:checked').value,...fixture})`),actions=state.events.slice(start);assert.equal(state.material,'Plastique');assert.equal(state.title,'Owned local item');assert.equal(state.price,'5,00');assert.equal(state.parcel,'Moyen');assert.equal(state.materialConfirmations,0);assert.equal(actions.some(event=>event.id==='material-done'||event.id==='material-suggested-plastic'),false);assert.equal(actions.filter(event=>event.kind==='click'&&event.id==='material-all-plastic').length,mode==='stuck-mirror'?1:0);assert.equal(state.saves,0);assert.equal(state.publishes,0);assert.equal(w.vintedDraftController,null);
      }
      return {blockedScenarios:cases.length,ambiguousChoicesUntouched:true,unsynchronizedMirrorNotCommitted:true,publishes:0};
    });
    await check('Vinted optional-material cleanup stops on cancellation or original-field changes before any choice or Fait click',async()=>{
      for(const mode of ['cancel','changed-title','changed-material']){
        await c.loadURL(FORM);await c.executeJavaScript('installMaterialPicker()');await adapter.prepareFields(profile.id,{title:'Owned local item',priceCents:500,parcel:'Moyen'});await c.executeJavaScript(`document.querySelector('#material').value='Plastique'`);
        const controller=new AbortController(),prior=tab.controlFeedback,start=await c.executeJavaScript('fixture.events.length');let triggered=false;
        tab.controlFeedback=async event=>{await prior?.(event);if(event.stage==='acting'&&!triggered){triggered=true;if(mode==='cancel')controller.abort();else await c.executeJavaScript(mode==='changed-title'?`document.querySelector('#title').value='Manual edit retained'`:`document.querySelector('#material').value='Coton'`);}};
        try{await assert.rejects(adapter.clearOptionalMaterial(profile.id,{signal:controller.signal}));}finally{tab.controlFeedback=prior;}
        const state=await c.executeJavaScript(`({material:document.querySelector('#material').value,title:document.querySelector('#title').value,...fixture})`),actions=state.events.slice(start);assert.equal(triggered,true);assert.equal(state.material,mode==='changed-material'?'Coton':'Plastique');assert.equal(state.title,mode==='changed-title'?'Manual edit retained':'Owned local item');assert.equal(state.materialConfirmations,0);assert.equal(actions.some(event=>['material-all-plastic','material-suggested-plastic','material-done'].includes(event.id)),false);if(mode==='cancel')assert.equal(actions.length,0);assert.equal(state.saves,0);assert.equal(state.publishes,0);assert.equal(w.vintedDraftController,null);
      }
      return {blockedScenarios:3,manualChangesPreserved:true,choiceOrFaitClicks:0,publishes:0};
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
