const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {VintedAdapter}=require('../src/vinted-adapter.cjs');
const FORM='https://www.vinted.fr/items/new';
const parcelDescriptions={Petit:'Petit Convient pour un article qui tient dans une grande enveloppe.',Moyen:'Recommandé Moyen Convient pour un article qui tient dans une boîte à chaussures. Voir les détails des dimensions et indemnisations',Grand:'Grand Convient pour un article qui tient dans un carton de déménagement.'};
const listing={title:'Test garment',description:'Test listing description.',categoryPath:['Femmes','Accessoires','Autres accessoires'],priceCents:500,condition:'Neuf avec étiquette'};

function fixture(options={}){
  const values={title:'',description:'',categoryPath:'',priceCents:'',condition:'',brand:'',color:'',brandSearch:'',parcel:'Moyen',categorySearch:options.stickySearch||'',...(options.values||{})},calls=[];
  let url=options.url||FORM,version=0,documentKey=1,menu=options.openCategory?'categoryPath':null,level=0,currentIds=new Map(),pendingChoice=null;
  const isolatedState={},choosers=new Map();
  const definitions=[
    {key:'title',tag:'input',type:'text',label:'Titre'},
    {key:'description',tag:'textarea',type:'textarea',label:'Description'},
    {key:'categoryPath',tag:'input',type:'text',label:'Catégorie',readOnly:true},
    {key:'priceCents',tag:'input',type:'text',label:'Prix'},
    {key:'condition',tag:'input',type:'text',label:'État',readOnly:true},
    ...(options.includeBrandColor?[{key:'brand',tag:'input',type:'text',label:'Marque',readOnly:true},{key:'color',tag:'input',type:'text',label:'Couleur',readOnly:true}]:[]),
    ...(options.extraFields||[])
  ];
  const contents=Object.assign(new EventEmitter(),{isDestroyed:()=>false,getURL:()=>url,loadURL:async value=>{contents.emit('did-start-navigation',{},value,false,true);url=value;documentKey++;},stop:()=>{}});
  const form={tagName:'FORM',contains:e=>!e.nav};
  let parcelNodes=[];
  const parcelGroup={tagName:'DIV',contains:e=>e.parcelOption===true,querySelectorAll:selector=>selector==='input[type=radio]'?parcelNodes:[],get _text(){return parcelNodes.map(e=>e._wrapper._text).join(' ');}};
  const tab={id:'tab-1',view:{webContents:contents}};
  const w={isDestroyed:()=>false,tabs:[tab],activeTab:tab.id,aiAgent:{state:{running:false}}};
  const api={values,calls,tab,w,definitions,confirmedMenus:[],setURL(value){url=value;},reload(){documentKey++;},currentIds:null};
  async function snapshot(){
    version++;currentIds=new Map();parcelNodes=[];let rows=definitions.map(e=>({...e}));
    rows.push({tag:'button',role:'tab',label:'Femmes',nav:true});
    if(menu==='categoryPath'){
      if(options.stickySearch!==undefined||options.mobileCategory)rows.push({key:'categorySearch',tag:'input',type:'search',label:'Trouver une catégorie',placeholder:'Trouver une catégorie'});
      if(!values.categorySearch&&level===0)rows.push({tag:'button',label:'Femmes',option:true,advance:1});
      if(!values.categorySearch&&level===1)rows.push({tag:'button',label:'Accessoires',option:true,advance:2});
      if(!values.categorySearch&&level===2)rows.push({tag:'input',type:'radio',role:'radio',label:'Autres accessoires',option:true,selectedValue:'Autres accessoires'});
    }
    if(menu==='brand'){rows.push({key:'brandSearch',tag:'input',type:'text',label:'Rechercher une marque'});if(values.brandSearch==='Sans marque')rows.push({tag:'input',type:'radio',role:'radio',label:'Sans marque',option:true,selectedValue:'Sans marque'});rows.push({tag:'input',type:'radio',role:'radio',label:'The Unbranded Brand',option:true,selectedValue:'The Unbranded Brand'});}
    if(menu==='color'){if(options.colorSuggestions)rows.push({tag:'input',type:'checkbox',role:'checkbox',label:'Noir',option:true,selectedValue:'Noir',colorGroup:'suggestions',checked:values.color==='Noir'});rows.push({tag:'input',type:'checkbox',role:'checkbox',label:'Noir',option:true,selectedValue:'Noir',colorGroup:options.colorSuggestions?'all':undefined,checked:values.color==='Noir'});rows.push({tag:'input',type:'checkbox',role:'checkbox',label:'Blanc',option:true,selectedValue:'Blanc',colorGroup:options.colorSuggestions?'all':undefined,checked:options.otherColorChecked===true});}
    if(menu==='condition')rows.push({tag:'input',type:'radio',role:'radio',label:'Neuf avec étiquette Article neuf et jamais porté',option:true,selectedValue:'Neuf avec étiquette'});
    if(options.partialMobileDone&&api.confirmedMenus.includes(menu))rows=rows.filter(row=>!row.option||row.selectedValue!==values[menu]);
    if(menu==='categoryPath'&&options.mobileCategory||menu==='brand'&&options.mobileBrand||menu==='condition'&&options.mobileCondition||menu==='color'&&options.mobileColor){
      rows=rows.map(row=>row.option||['categorySearch','brandSearch'].includes(row.key)?{...row,chooser:true,checked:(row.selectedValue===pendingChoice||row.checked===true)&&!options.uncheckedMobileChoice}:row);
      const done={tag:'button',type:options.mobileDoneType||'button',label:'Fait',confirm:true,chooser:!options.outsideMobileDone};
      rows.push(done);if(options.duplicateMobileDone)rows.push({...done});
    }
    if(options.includeParcel)rows.push(...['Petit','Moyen','Grand'].map(name=>({tag:'input',type:'radio',role:'radio',label:options.rawParcelLabels?'radio':parcelDescriptions[name],parcelOption:true,selectedValue:name,checked:values.parcel===name})));
    if(options.rows)rows=options.rows(rows,api,{menu,level});
    const elements=[],colorGroups=new Map(),chooserNodes=[],chooserLabel=({categoryPath:'Catégorie',brand:'Marque',condition:'État',color:'Couleur'})[menu];
    const titleLeaf={tagName:'SPAN',_text:chooserLabel,querySelectorAll:()=>[],contains:other=>other===titleLeaf},heading={tagName:'H2',_text:chooserLabel,querySelectorAll:()=>[],contains:other=>other===heading||other===titleLeaf};
    const titleNodes=options.duplicateChooserTitle?[heading,titleLeaf,{...titleLeaf,contains:()=>false}]:[heading,titleLeaf];
    let chooser=choosers.get(menu);
    if(!chooser){const chooserMenu=menu;chooser={tagName:'DIV',get isConnected(){return menu===chooserMenu&&choosers.get(chooserMenu)===chooser;},contains:e=>chooser.nodes.includes(e),querySelectorAll:selector=>selector.startsWith('h1,')?options.nestedChooserTitle?chooser.titleNodes:[]:selector.includes('textarea,select,button')?chooser.nodes:chooser.nodes.filter(e=>['radio','checkbox'].includes(e.role)||['radio','checkbox'].includes(e.type))};choosers.set(menu,chooser);}
    Object.assign(chooser,{label:options.nestedChooserTitle?'':chooserLabel,getAttribute:name=>name==='aria-label'&&!options.nestedChooserTitle?chooserLabel:null,nodes:chooserNodes,titleNodes});
    for(const row of rows){
      const id='e'+version+'-'+elements.length,node={...row,tagName:row.tag.toUpperCase(),isConnected:true,get value(){return String(values[row.key]||'');},autocomplete:'',nav:row.nav,form:row.nav?null:form,getAttribute:name=>row[name]||null,contains(other){return this===other;},querySelectorAll:()=>[]};
      if(row.chooser){node._chooser=chooser;chooserNodes.push(node);}
      if(row.colorGroup){if(!colorGroups.has(row.colorGroup)){const title=row.colorGroup==='suggestions'?'Suggestions':'Toutes les couleurs',heading={tagName:'DIV',_text:title,querySelectorAll:()=>[]};colorGroups.set(row.colorGroup,{tagName:'DIV',label:options.plainColorHeading?'':title,children:options.plainColorHeading?[heading]:[],contains:other=>other.colorGroup===row.colorGroup,querySelectorAll:selector=>selector.startsWith('h1,')?[heading]:[]});}node._colorGroup=colorGroups.get(row.colorGroup);}
      if(row.parcelOption){
        const wrapper={tag:'button',role:'button',tagName:'BUTTON',type:'button',isConnected:true,parcelOption:true,selectedValue:row.selectedValue,_text:parcelDescriptions[row.selectedValue],contains:e=>e===wrapper||e===node,querySelectorAll:selector=>selector==='input[type=radio]'?[node]:[],getAttribute:()=>null};
        node._wrapper=wrapper;parcelNodes.push(node);
        if(options.hiddenParcel){node.hidden=true;if(row.selectedValue!==values.parcel){wrapper.label=wrapper._text+' '+wrapper._text;currentIds.set(id,wrapper);elements.push({id,tag:'button',role:'button',label:wrapper.label});}continue;}
      }
      currentIds.set(id,node);elements.push({id,...row});
    }
    api.currentIds=currentIds;
    return {url,title:'Vendre un article',elements};
  }
  const control={
    checkedSnapshot:async(_tab,{signal})=>{assert.equal(_tab,tab);if(signal?.aborted)throw Error('stopped');if(options.beforeSnapshot)await options.beforeSnapshot(api);return snapshot();},
    isolated:async(_tab,expression)=>{
      assert.equal(_tab,tab);
      Object.assign(isolatedState,{__isolaElements:currentIds,__isolaDOM:{closest:node=>node.nav?{}:null,parents:node=>node.parcelOption?[node,...(node._wrapper?[node._wrapper]:[]),parcelGroup,form]:[node,...(node._colorGroup?[node._colorGroup]:[]),...(node._chooser?[node._chooser]:[]),form],label:node=>node.label||node._text||'',safeText:node=>node.tagName==='INPUT'?'':node._text||node.label||'',visible:node=>!node.hidden,disabled:node=>!!node.disabled}});
      return vm.runInNewContext(expression,{globalThis:isolatedState,performance:{timeOrigin:documentKey},document:{querySelectorAll:()=>[...currentIds.values()]}});
    },
    performAction:async(_tab,args,opts)=>{
      assert.equal(_tab,tab);calls.push(args);
      if(options.beforeAction)await options.beforeAction(api,args);
      try{await opts.onProgress?.({stage:'acting'});}catch{}
      if(opts.signal.aborted)throw Error('stopped');
      if(args.action==='navigate'){await opts.navigate(args.url);return snapshot();}
      if(args.action==='wait')return {...await snapshot(),observation:{pending:options.unstableMenu===true}};
      if(args.action==='key'){assert.equal(args.key,'Escape');if(!options.stuckMenu)menu=null;return snapshot();}
      const node=currentIds.get(args.elementId);assert.ok(node,'Every action uses a fresh snapshot ID');
      if(args.action==='type')values[node.key]=options.coerceValue?options.coerceValue(node.key,args.text):args.text;
      else if(['categoryPath','condition','brand','color'].includes(node.key)){menu=node.key;level=0;}
      else if(node.confirm){api.confirmedMenus.push(menu);if(!options.stuckMobileDone){values[menu]=options.selectedValue||pendingChoice;if(!options.partialMobileDone)menu=null;else if(options.replaceMobileChooser)choosers.delete(menu);pendingChoice=null;}}
      else if(node.parcelOption)values.parcel=node.selectedValue;
      else if(node.option){if(node.advance)level=node.advance;else if(menu==='categoryPath'&&options.mobileCategory||menu==='brand'&&options.mobileBrand||menu==='condition'&&options.mobileCondition||menu==='color'&&options.mobileColor)pendingChoice=node.selectedValue;else{values[menu]=options.selectedValue||node.selectedValue;if(menu!=='color')menu=null;}}
      else throw Error('Unexpected click target '+node.label);
      const page=await snapshot();return {...page,observation:{inputMatched:options.inputMatched!==false}};
    }
  };
  api.adapter=new VintedAdapter({windows:new Map([['profile-1',w]]),control,isBusy:options.isBusy||(()=>false),menuWaitMs:options.menuWaitMs??40,pollIntervalMs:10});
  return api;
}

test('readiness distinguishes reversible form preparation from all live business capabilities',async()=>{
  const {adapter}=fixture();const readiness=adapter.readiness();assert.equal(readiness.capabilities.inspect,true);assert.equal(readiness.capabilities.prepareCategory,true);
  for(const capability of ['publish','messages','offers','shippingLabel','procurement'])assert.equal(readiness.capabilities[capability],false);
  await assert.rejects(adapter.requireReady(),{code:'VINTED_UNVERIFIED'});assert.deepEqual(await adapter.poll(),[]);
});

test('inspection returns observed form fields without claiming an account or listing is verified',async()=>{
  const f=fixture({values:{title:'Existing item'}});const result=await f.adapter.inspect('profile-1');assert.equal(result.verified,false);assert.equal(result.account.verified,false);assert.equal(result.fields.find(f=>f.field==='title').value,'Existing item');assert.equal(f.calls.length,0);
});

test('only the exact France origin and the new empty form can be prepared',async()=>{
  for(const url of ['https://vinted.fr/items/new','https://www.vinted.fr.evil.test/items/new','https://www.vinted.fr/items/123/edit','https://www.vinted.fr/items/new?draft=123','https://www.vinted.fr/items/new#draft','https://www.vinted.fr/']){
    const f=fixture({url});await assert.rejects(f.adapter.prepareFields('profile-1',listing));assert.equal(f.calls.length,0);assert.equal(f.w.vintedDraftController,null);
  }
});

test('an explicitly prepared empty tab may navigate only to the fixed France new-item URL',async()=>{
  const f=fixture({url:'about:blank'});const result=await f.adapter.prepareFields('profile-1',listing);assert.deepEqual(f.calls[0],{action:'navigate',url:FORM});assert.equal(result.published,false);assert.equal(result.filled.length,5);
});

test('fresh semantic IDs fill text, exact category path, exact condition and French euro price',async()=>{
  const f=fixture();const result=await f.adapter.prepareFields('profile-1',listing);
  assert.deepEqual(result.filled.map(f=>f.field),['title','description','categoryPath','condition','priceCents']);
  assert.equal(f.values.priceCents,'5,00');assert.equal(f.values.categoryPath,'Autres accessoires');assert.equal(f.values.condition,'Neuf avec étiquette');assert.equal(result.draftComplete,false);assert.equal(result.published,false);assert.equal(result.saved,false);
  assert.ok(result.unresolved.some(f=>f.field==='photos'));assert.equal(f.calls.some(call=>/Ajouter|Sauvegarder|photo/.test(call.text||'')),false);assert.equal(f.w.vintedDraftController,null);
});

test('matching explicit prefilled values are retained while conflicting draft values stop before writing',async()=>{
  const f=fixture({values:{title:listing.title}});const result=await f.adapter.prepareFields('profile-1',listing);assert.equal(result.filled[0].unchanged,true);
  const other=fixture({values:{title:'Another seller draft'}});await assert.rejects(other.adapter.prepareFields('profile-1',listing),{code:'EXISTING_DRAFT'});assert.equal(other.calls.length,0);
});

test('an unknown populated form field prevents replacing an existing draft',async()=>{
  const f=fixture({values:{unknown:'Original material'},extraFields:[{key:'unknown',tag:'input',type:'text',label:'Unverified field'}]});await assert.rejects(f.adapter.prepareFields('profile-1',listing),{code:'EXISTING_DRAFT'});assert.equal(f.calls.length,0);
});

test('the same owned page can be checked repeatedly without duplicate clicks or typing',async()=>{
  const f=fixture();await f.adapter.prepareFields('profile-1',listing);const count=f.calls.length;const repeated=await f.adapter.prepareFields('profile-1',listing);assert.equal(f.calls.length,count);assert.equal(repeated.filled.every(f=>f.unchanged),true);
});

test('a changed owned text field stops rather than replacing a manual edit',async()=>{
  const f=fixture();await f.adapter.prepareFields('profile-1',listing);f.values.description='Manual correction';const count=f.calls.length;await assert.rejects(f.adapter.prepareFields('profile-1',listing),{code:'EXISTING_DRAFT'});assert.equal(f.calls.length,count);
});

test('invalid content and invalid cents fail before touching a window',async()=>{
  for(const input of [{title:'A\nB'},{priceCents:5.5},{priceCents:0},{categoryPath:'Femmes'},{description:'\0'}]){
    const f=fixture();await assert.rejects(f.adapter.prepareFields('profile-1',input),{code:'INVALID_LISTING'});assert.equal(f.calls.length,0);
  }
});

test('missing content is reported without inventing titles, category choices or required fields',async()=>{
  const f=fixture();const result=await f.adapter.prepareFields('profile-1',{});assert.equal(f.calls.length,0);assert.equal(result.filled.length,0);assert.deepEqual(result.missing.slice(0,5).map(f=>f.field),['title','description','categoryPath','condition','priceCents']);assert.equal(result.draftComplete,false);
});

test('ambiguous title inputs are reported and never receive text',async()=>{
  const f=fixture({rows:rows=>[...rows,{key:'title',tag:'input',type:'text',label:'Titre'}]});const result=await f.adapter.prepareFields('profile-1',{title:'Test'});assert.equal(result.filled.length,0);assert.match(result.unresolved[0].reason,/多个/);assert.equal(f.calls.length,0);
});

test('input mismatch prevents all subsequent form operations',async()=>{
  const f=fixture({inputMatched:false});const result=await f.adapter.prepareFields('profile-1',listing);assert.equal(f.calls.length,1);assert.equal(result.filled.length,0);assert.ok(result.unresolved.some(f=>f.field==='description'));assert.ok(result.unresolved.some(f=>f.field==='categoryPath'));
});

test('category choices must be unique and must never use a top navigation control',async()=>{
  const duplicates=fixture({rows:(rows,_api,state)=>state.menu==='categoryPath'&&state.level===0?[...rows,{tag:'button',label:'Femmes',option:true,advance:1}]:rows});const a=await duplicates.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath});assert.match(a.unresolved.find(f=>f.field==='categoryPath').reason,/多个/);assert.equal(duplicates.calls.length,1);
  const nav=fixture({rows:rows=>rows.map(row=>row.option?{...row,nav:true}:row)});const b=await nav.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath});assert.match(b.unresolved.find(f=>f.field==='categoryPath').reason,/导航/);assert.equal(nav.calls.length,1);
});

test('a category without a confirmed leaf radio is not guessed from a similarly labelled button',async()=>{
  const f=fixture({rows:rows=>rows.map(row=>row.role==='radio'?{...row,role:'button',tag:'button',type:''}:row)});const result=await f.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath});assert.equal(result.filled.length,0);assert.match(result.unresolved[0].reason,/明确选项/);assert.equal(f.values.categoryPath,'');
});

test('a mismatching category receipt halts before price input',async()=>{
  const f=fixture({selectedValue:'Sacs'});const result=await f.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath,priceCents:500});assert.equal(result.filled.length,0);assert.match(result.unresolved[0].reason,/不一致/);assert.equal(f.values.priceCents,'');
});

test('mobile category, brand, condition and color commit through each chooser own Fait before later fields',async()=>{
  const f=fixture({mobileCategory:true,mobileBrand:true,mobileCondition:true,mobileColor:true,includeBrandColor:true});
  const result=await f.adapter.prepareFields('profile-1',{...listing,brand:'Sans marque',color:'Noir'});
  assert.deepEqual(result.filled.map(field=>field.field),['title','description','categoryPath','brand','condition','color','priceCents']);
  assert.deepEqual(f.confirmedMenus,['categoryPath','brand','condition','color']);
  assert.equal(f.values.categoryPath,'Autres accessoires');assert.equal(f.values.brand,'Sans marque');assert.equal(f.values.condition,listing.condition);assert.equal(f.values.color,'Noir');assert.equal(f.values.priceCents,'5,00');
});

test('condition and color Fait accept one nested independent title while duplicate titles halt',async()=>{
  const f=fixture({mobileCondition:true,mobileColor:true,nestedChooserTitle:true,includeBrandColor:true});
  const result=await f.adapter.prepareFields('profile-1',{condition:listing.condition,color:'Noir',priceCents:500});
  assert.deepEqual(result.filled.map(field=>field.field),['condition','color','priceCents']);assert.deepEqual(f.confirmedMenus,['condition','color']);
  for(const [key,options] of [['condition',{mobileCondition:true}],['color',{mobileColor:true,includeBrandColor:true}]]){
    const duplicate=fixture({...options,nestedChooserTitle:true,duplicateChooserTitle:true});
    const stopped=await duplicate.adapter.prepareFields('profile-1',{[key]:key==='color'?'Noir':listing.condition,priceCents:500});
    assert.equal(stopped.filled.length,0);assert.deepEqual(duplicate.confirmedMenus,[]);assert.equal(duplicate.values.priceCents,'');
  }
});

test('mobile color Fait confirms only the all-colors target while accepting its one known Suggestions mirror',async()=>{
  const f=fixture({includeBrandColor:true,mobileColor:true,colorSuggestions:true,nestedChooserTitle:true,plainColorHeading:true});
  const result=await f.adapter.prepareFields('profile-1',{color:'Noir',priceCents:500});
  assert.deepEqual(result.filled.map(field=>field.field),['color','priceCents']);assert.deepEqual(f.confirmedMenus,['color']);assert.equal(f.values.color,'Noir');assert.equal(f.values.priceCents,'5,00');
});

test('mobile color Fait rejects another selected color and duplicate or unknown same-label controls',async()=>{
  const scenarios=[
    {otherColorChecked:true},
    {rows:rows=>{const all=rows.find(row=>row.colorGroup==='all'&&row.label==='Noir');return all?[...rows,{...all}]:rows;}},
    {rows:rows=>{const suggested=rows.find(row=>row.colorGroup==='suggestions');return suggested?[...rows,{...suggested}]:rows;}},
    {rows:rows=>{const all=rows.find(row=>row.colorGroup==='all'&&row.label==='Noir');return all?[...rows,{...all,colorGroup:undefined}]:rows;}}
  ];
  for(const scenario of scenarios){
    const f=fixture({includeBrandColor:true,mobileColor:true,colorSuggestions:true,...scenario});
    const result=await f.adapter.prepareFields('profile-1',{color:'Noir',priceCents:500});
    assert.deepEqual(result.filled,[]);assert.equal(result.unresolved.find(field=>field.field==='color').halted,true);assert.deepEqual(f.confirmedMenus,[]);assert.equal(f.values.color,'');assert.equal(f.values.priceCents,'');
  }
});

test('Fait must close the observed chooser even if its selected option disappears before the remaining controls',async()=>{
  for(const replaceMobileChooser of [false,true]){
    const f=fixture({includeBrandColor:true,mobileColor:true,partialMobileDone:true,replaceMobileChooser,menuWaitMs:0});
    const result=await f.adapter.prepareFields('profile-1',{color:'Noir',priceCents:500});
    assert.deepEqual(result.filled,[]);assert.match(result.unresolved.find(field=>field.field==='color').reason,/仍未关闭/);assert.deepEqual(f.confirmedMenus,['color']);assert.equal(f.values.color,'Noir');assert.equal(f.values.priceCents,'');
  }
});

test('mobile chooser confirmation rejects an unrelated, duplicate, submit or unchecked Fait target',async()=>{
  for(const scenario of [{outsideMobileDone:true},{duplicateMobileDone:true},{mobileDoneType:'submit'},{uncheckedMobileChoice:true}]){
    const f=fixture({mobileCategory:true,...scenario});
    const result=await f.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath,priceCents:500});
    assert.equal(result.filled.length,0);assert.equal(result.unresolved[0].halted,true);assert.deepEqual(f.confirmedMenus,[]);assert.equal(f.values.categoryPath,'');assert.equal(f.values.priceCents,'');
  }
});

test('mobile Fait must close its picker and the committed original field must match exactly',async()=>{
  const stuck=fixture({mobileCategory:true,stuckMobileDone:true,menuWaitMs:0});
  const waiting=await stuck.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath,priceCents:500});
  assert.match(waiting.unresolved[0].reason,/仍未关闭/);assert.deepEqual(stuck.confirmedMenus,['categoryPath']);assert.equal(stuck.values.priceCents,'');
  const wrong=fixture({mobileCategory:true,selectedValue:'Sacs'});
  const mismatch=await wrong.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath,priceCents:500});
  assert.match(mismatch.unresolved[0].reason,/不一致/);assert.deepEqual(wrong.confirmedMenus,['categoryPath']);assert.equal(wrong.values.priceCents,'');
});

test('mobile chooser confirmation detects a document change during Fait and blocks later fields',async()=>{
  const f=fixture({mobileCategory:true,beforeAction(api,args){if(api.currentIds.get(args.elementId)?.confirm)api.reload();}});
  await assert.rejects(f.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath,priceCents:500}),{code:'PAGE_CHANGED'});
  assert.equal(f.values.priceCents,'');
});

test('rendered price must still equal the requested cents after input confirmation',async()=>{
  const f=fixture({coerceValue:(key,value)=>key==='priceCents'?'50,00':value});const result=await f.adapter.prepareFields('profile-1',{priceCents:500});assert.equal(result.filled.length,0);assert.match(result.unresolved[0].reason,/价格.*不一致/);
});

test('active AI and commerce controllers exclude draft preparation',async()=>{
  const f=fixture();f.w.aiAgent.state.running=true;await assert.rejects(f.adapter.prepareFields('profile-1',listing),{code:'PAGE_BUSY'});assert.equal(f.calls.length,0);
  const busy=fixture({isBusy:()=>true});await assert.rejects(busy.adapter.prepareFields('profile-1',listing),{code:'PAGE_BUSY'});assert.equal(busy.calls.length,0);
});

test('tab switching during an action aborts the shared controller before input',async()=>{
  const f=fixture({beforeAction:api=>{api.w.activeTab='other-tab';}});await assert.rejects(f.adapter.prepareFields('profile-1',listing));assert.equal(f.values.title,'');assert.equal(f.w.vintedDraftController,null);
});

test('abort and document replacement prevent continuing a stale form preparation',async()=>{
  const controller=new AbortController();controller.abort();const f=fixture();await assert.rejects(f.adapter.prepareFields('profile-1',listing,{signal:controller.signal}),{code:'STOPPED'});assert.equal(f.calls.length,0);
  let actionCount=0;const changed=fixture({beforeAction:api=>{if(++actionCount===1)api.reload();}});await assert.rejects(changed.adapter.prepareFields('profile-1',listing),{code:'PAGE_CHANGED'});assert.equal(changed.values.description,'');assert.equal(changed.w.vintedDraftController,null);
});

test('header defaults and search values do not turn a blank listing into an existing draft',async()=>{
  const f=fixture({values:{language:'fr',search:'coat'},extraFields:[{key:'language',tag:'select',type:'select-one',label:'Langue',nav:true},{key:'search',tag:'input',type:'text',label:'Rechercher des articles',nav:true}]});const result=await f.adapter.prepareFields('profile-1',{title:listing.title});assert.equal(result.filled[0].field,'title');assert.equal(f.values.language,'fr');assert.equal(f.values.search,'coat');
});

test('same-tab main frame navigation aborts before an input and removes listeners afterward',async()=>{
  const f=fixture({beforeAction:api=>{api.tab.view.webContents.emit('did-start-navigation',{},FORM,false,true);}});await assert.rejects(f.adapter.prepareFields('profile-1',listing));assert.equal(f.values.title,'');assert.equal(f.tab.view.webContents.listenerCount('did-start-navigation'),0);assert.equal(f.tab.view.webContents.listenerCount('destroyed'),0);
});

test('subframe navigation does not cancel a stable main-frame form',async()=>{
  const f=fixture({beforeAction:api=>{api.tab.view.webContents.emit('did-start-navigation',{},'https://frame.invalid/',false,false);}});const result=await f.adapter.prepareFields('profile-1',{title:listing.title});assert.equal(result.filled[0].field,'title');
});

test('tab switching from about:blank aborts the navigation even if progress exceptions are swallowed',async()=>{
  const f=fixture({url:'about:blank',beforeAction:api=>{api.w.activeTab='other-tab';}});await assert.rejects(f.adapter.prepareFields('profile-1',listing));assert.equal(f.tab.view.webContents.getURL(),'about:blank');assert.equal(f.w.vintedDraftController,null);
});

test('a redirected empty-tab navigation cannot read an unexpected destination',async()=>{
  const f=fixture({url:'about:blank'});f.tab.view.webContents.loadURL=async()=>{f.setURL('https://external.invalid/login');f.tab.view.webContents.emit('did-start-navigation',{},'https://external.invalid/login',false,true);};await assert.rejects(f.adapter.prepareFields('profile-1',listing));assert.equal(f.calls.length,1);assert.equal(f.values.title,'');
});


test('a same-label navigation button is excluded before checking menu-choice uniqueness',async()=>{
  const f=fixture({rows:rows=>[...rows,{tag:'button',label:'Femmes',nav:true}]});const result=await f.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath});assert.equal(result.filled[0].field,'categoryPath');assert.equal(f.values.categoryPath,'Autres accessoires');
});


test('classification traversal supports semantic button roles on non-button DOM elements',async()=>{
  const f=fixture({rows:rows=>rows.map(row=>row.option&&row.tag==='button'?{...row,tag:'div',role:'button'}:row)});const result=await f.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath});assert.equal(result.filled[0].field,'categoryPath');assert.equal(f.values.categoryPath,'Autres accessoires');
});

test('a retained category search is cleared and verified before path traversal',async()=>{
  const f=fixture({stickySearch:'aspirateur',rows:rows=>rows.map(row=>row.option&&row.tag==='button'?{...row,tag:'div',role:'button'}:row)});const result=await f.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath});assert.equal(result.filled[0].field,'categoryPath');assert.equal(f.values.categorySearch,'');assert.equal(f.calls[1].action,'type');assert.equal(f.calls[1].text,'');
});

test('a failed category search reset stops without selecting a guessed category',async()=>{
  const f=fixture({stickySearch:'aspirateur',inputMatched:false});const result=await f.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath});assert.equal(result.filled.length,0);assert.match(result.unresolved[0].reason,/搜索已清空/);assert.equal(f.calls.length,2);assert.equal(f.values.categoryPath,'');
});

test('duplicate category search controls are not cleared arbitrarily',async()=>{
  const f=fixture({stickySearch:'aspirateur',rows:rows=>{const search=rows.find(r=>r.key==='categorySearch');return search?[...rows,{...search}]:rows;}});const result=await f.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath});assert.equal(result.filled.length,0);assert.match(result.unresolved[0].reason,/搜索出现多个/);assert.equal(f.values.categorySearch,'aspirateur');assert.equal(f.calls.length,1);
});


test('category-specific absent fields are not presented as missing required choices',async()=>{
  const f=fixture();const result=await f.adapter.prepareFields('profile-1',{});assert.equal(result.missing.some(f=>f.field==='size'),false);assert.equal(result.missing.some(f=>f.field==='brand'),false);assert.equal(result.missing.some(f=>f.field==='color'),false);assert.equal(result.missing.some(f=>f.field==='parcel'),true);
  const visible=fixture({extraFields:[{key:'size',tag:'input',type:'text',label:'Taille',readOnly:true}]});const shown=await visible.adapter.prepareFields('profile-1',{});assert.equal(shown.missing.some(f=>f.field==='size'),true);
  const supplied=await f.adapter.prepareFields('profile-1',{size:'M'});assert.equal(supplied.unresolved.some(f=>f.field==='size'),true);
});


test('an already open category search is reset without toggling the category selector',async()=>{
  const f=fixture({stickySearch:'aspirateur',openCategory:true});const result=await f.adapter.prepareFields('profile-1',{categoryPath:listing.categoryPath});assert.equal(result.filled[0].field,'categoryPath');assert.equal(f.calls[0].action,'type');assert.equal(f.calls[0].text,'');assert.equal(f.values.categoryPath,'Autres accessoires');
});


test('explicit Sans marque uses an exact brand search and never substitutes a similarly named brand',async()=>{
  const f=fixture({includeBrandColor:true});const result=await f.adapter.prepareFields('profile-1',{brand:'Sans marque'});assert.equal(result.filled[0].field,'brand');assert.equal(f.values.brand,'Sans marque');assert.equal(f.calls.find(c=>c.action==='type').text,'Sans marque');assert.equal(result.unresolved.some(f=>f.field==='brand'),false);
});

test('single color requires a checked exact option and closes its menu with Escape before price input',async()=>{
  const f=fixture({includeBrandColor:true});const result=await f.adapter.prepareFields('profile-1',{color:'Noir',priceCents:500});assert.deepEqual(result.filled.map(f=>f.field),['color','priceCents']);assert.equal(f.values.color,'Noir');const escape=f.calls.findIndex(c=>c.action==='key'&&c.key==='Escape'),price=f.calls.findIndex(c=>c.action==='type'&&c.text==='5,00');assert.ok(escape>=0&&escape<price);
});

test('a color menu that does not close halts before filling a different field',async()=>{
  const f=fixture({includeBrandColor:true,stuckMenu:true});const result=await f.adapter.prepareFields('profile-1',{color:'Noir',priceCents:500});assert.equal(result.filled.length,0);assert.match(result.unresolved.find(f=>f.field==='color').reason,/菜单尚未关闭/);assert.equal(f.values.priceCents,'');
});

test('another checked color is preserved without adding or removing colors',async()=>{
  const f=fixture({includeBrandColor:true,otherColorChecked:true});const result=await f.adapter.prepareFields('profile-1',{color:'Noir'});assert.equal(result.filled.length,0);assert.match(result.unresolved[0].reason,/其他颜色/);assert.equal(f.values.color,'');assert.equal(f.calls.filter(c=>c.action==='click').length,1);
});

test('conflicting existing brand or color stops before touching the draft',async()=>{
  for(const [key,value]of [['brand','The Unbranded Brand'],['color','Blanc']]){const f=fixture({includeBrandColor:true,values:{[key]:value}});await assert.rejects(f.adapter.prepareFields('profile-1',{brand:'Sans marque',color:'Noir'}),{code:'EXISTING_DRAFT'});assert.equal(f.calls.length,0);}
});

test('brand search mismatches stop without selecting any radio option',async()=>{
  const f=fixture({includeBrandColor:true,inputMatched:false});const result=await f.adapter.prepareFields('profile-1',{brand:'Sans marque',priceCents:500});assert.equal(result.filled.length,0);assert.equal(f.values.brand,'');assert.equal(f.values.priceCents,'');assert.match(result.unresolved[0].reason,/品牌搜索输入/);
});


test('explicit Neuf sans étiquette is selected instead of Neuf avec étiquette',async()=>{
  const f=fixture({rows:(rows,api,state)=>state.menu==='condition'?[...rows,{tag:'input',type:'radio',role:'radio',label:'Neuf sans étiquette Article neuf, sans étiquette ni emballage',option:true,selectedValue:'Neuf sans étiquette'}]:rows});const result=await f.adapter.prepareFields('profile-1',{condition:'Neuf sans étiquette'});assert.equal(result.filled[0].field,'condition');assert.equal(f.values.condition,'Neuf sans étiquette');
});


test('a complex price label still resolves only the unique editable input with exact euro placeholder',async()=>{
  const f=fixture({rows:rows=>[...rows.map(e=>e.key==='priceCents'?{...e,label:'Prix Recommandation de prix Voir le prix de vente des articles similaires',placeholder:'0,00 €'}:e),{tag:'button',role:'button',label:'Prix Recommandation de prix'}]});const result=await f.adapter.prepareFields('profile-1',{priceCents:500});assert.equal(result.filled[0].field,'priceCents');assert.equal(f.values.priceCents,'5,00');
});

test('brand waits for delayed exact results without clicking the brand selector again',async()=>{
  let resultReads=0;const f=fixture({includeBrandColor:true,menuWaitMs:100,rows:rows=>rows.filter(e=>e.label!=='Sans marque'||++resultReads>2)});const result=await f.adapter.prepareFields('profile-1',{brand:'Sans marque'});assert.equal(result.filled[0].field,'brand');assert.equal(f.values.brand,'Sans marque');assert.equal(f.calls.filter(c=>c.action==='click').length,2);
});

test('a still-updating menu area is not clicked',async()=>{
  const f=fixture({includeBrandColor:true,unstableMenu:true});const result=await f.adapter.prepareFields('profile-1',{brand:'Sans marque'});assert.equal(result.filled.length,0);assert.match(result.unresolved[0].reason,/仍在更新/);assert.equal(f.calls.some(c=>c.action==='click'),false);
});


test('the already selected recommended Moyen parcel is verified without clicking',async()=>{
  const f=fixture({includeParcel:true});const result=await f.adapter.prepareFields('profile-1',{parcel:'Moyen'});assert.equal(result.filled[0].field,'parcel');assert.equal(result.filled[0].selected,'Moyen');assert.equal(result.filled[0].unchanged,true);assert.equal(f.calls.length,0);assert.equal(result.missing.some(f=>f.field==='parcel'),false);
});

test('an explicit parcel changes only the radio in the confirmed shipping group',async()=>{
  const f=fixture({includeParcel:true,rows:rows=>[...rows,{tag:'input',type:'radio',role:'radio',label:'Grand',checked:false}]});const result=await f.adapter.prepareFields('profile-1',{parcel:'Grand'});assert.equal(result.filled[0].selected,'Grand');assert.equal(f.values.parcel,'Grand');assert.equal(f.calls.length,1);
});

test('ambiguous or incomplete shipping groups stop without selecting a parcel',async()=>{
  for(const rows of [rows=>rows.filter(e=>!e.parcelOption||e.selectedValue!=='Petit'),rows=>[...rows,...rows.filter(e=>e.parcelOption&&e.selectedValue==='Grand')]]){const f=fixture({includeParcel:true,rows});const result=await f.adapter.prepareFields('profile-1',{parcel:'Grand'});assert.equal(result.filled.length,0);assert.equal(f.calls.length,0);assert.match(result.unresolved[0].reason,/不完整|多个|未能唯一|重复/);}
});

test('parcel input must be one explicit supported size before any field is modified',async()=>{
  const f=fixture({includeParcel:true});await assert.rejects(f.adapter.prepareFields('profile-1',{title:'Must not be typed',parcel:'whatever'}),{code:'INVALID_LISTING'});assert.equal(f.calls.length,0);
});

test('multiple checked parcel radios stop without silently normalizing the selection',async()=>{
  const f=fixture({includeParcel:true,rows:rows=>rows.map(e=>e.parcelOption?{...e,checked:true}:e)});const result=await f.adapter.prepareFields('profile-1',{parcel:'Moyen'});assert.equal(result.filled.length,0);assert.match(result.unresolved[0].reason,/多个已选/);assert.equal(f.calls.length,0);
});


test('a normalized decimal point price is accepted from a fresh exact-cent readback despite literal mismatch',async()=>{
  const f=fixture({includeParcel:true,inputMatched:false,coerceValue:(key,value)=>key==='priceCents'?value.replace(',','.'):value});const result=await f.adapter.prepareFields('profile-1',{priceCents:500,parcel:'Moyen'});assert.deepEqual(result.filled.map(f=>f.field),['priceCents','parcel']);assert.equal(f.values.priceCents,'5.00');
});

test('a mismatching literal price receipt cannot authorize a different or malformed displayed amount',async()=>{
  for(const displayed of ['50.00','5.001','5,00 USD','5','500']){const cents=displayed==='5'?600:500;const f=fixture({includeParcel:true,inputMatched:false,coerceValue:(key,value)=>key==='priceCents'?displayed:value});const result=await f.adapter.prepareFields('profile-1',{priceCents:cents,parcel:'Moyen'});assert.equal(result.filled.length,0);assert.match(result.unresolved.find(f=>f.field==='priceCents').reason,/价格.*不一致/);assert.match(result.unresolved.find(f=>f.field==='parcel').reason,/前一步/);}
});


test('parcel descriptions can come from a single-radio parent rather than a raw radio label',async()=>{
  const f=fixture({includeParcel:true,rawParcelLabels:true});const result=await f.adapter.prepareFields('profile-1',{parcel:'Moyen'});assert.equal(result.filled[0].selected,'Moyen');assert.equal(f.calls.length,0);
});

test('hidden parcel radios are read through exact visible shipping anchors, and only visible wrappers are clicked',async()=>{
  const f=fixture({includeParcel:true,hiddenParcel:true,rawParcelLabels:true});const current=await f.adapter.prepareFields('profile-1',{parcel:'Moyen'});assert.equal(current.filled[0].unchanged,true);assert.equal(f.calls.length,0);const changed=await f.adapter.prepareFields('profile-1',{parcel:'Grand'});assert.equal(changed.filled[0].selected,'Grand');assert.equal(f.calls.length,1);assert.equal(f.values.parcel,'Grand');
});
test('duplicate suggested colors use only the unique Toutes les couleurs group and verify its checked receipt',async()=>{
  for(const plainColorHeading of [false,true]){const clicked=[];const f=fixture({includeBrandColor:true,colorSuggestions:true,plainColorHeading,beforeAction(api,args){const node=api.currentIds.get(args.elementId);if(args.action==='click'&&node?.type==='checkbox')clicked.push(node.colorGroup);}});const result=await f.adapter.prepareFields('profile-1',{color:'Noir',priceCents:500});assert.deepEqual(result.filled.map(field=>field.field),['color','priceCents']);assert.deepEqual(clicked,['all']);assert.equal(f.values.color,'Noir');assert.equal(f.calls.filter(call=>call.action==='key'&&call.key==='Escape').length,1);}
});
test('ambiguous all-colors groups or suggestions without an all-colors group are never guessed',async()=>{
  const variants=[rows=>rows.filter(row=>row.colorGroup!=='all'),rows=>[...rows,...rows.filter(row=>row.colorGroup==='all'&&row.label==='Noir').map(row=>({...row,colorGroup:'all-copy'}))]];
  for(const rows of variants){const clicked=[];const f=fixture({includeBrandColor:true,colorSuggestions:true,rows,beforeAction(api,args){if(args.action==='click'&&api.currentIds.get(args.elementId)?.type==='checkbox')clicked.push(args.elementId);}});const result=await f.adapter.prepareFields('profile-1',{color:'Noir',priceCents:500});assert.equal(result.filled.length,0);assert.match(result.unresolved.find(field=>field.field==='color').reason,/Toutes les couleurs/);assert.deepEqual(clicked,[]);assert.equal(f.values.priceCents,'');}
});
test('a checked different color outside the canonical group is preserved and blocks a new choice',async()=>{
  const f=fixture({includeBrandColor:true,colorSuggestions:true,rows:rows=>[...rows,...(rows.some(row=>row.colorGroup)?[{tag:'input',type:'checkbox',role:'checkbox',label:'Blanc',colorGroup:'suggestions',checked:true,disabled:true}]:[])]});const result=await f.adapter.prepareFields('profile-1',{color:'Noir',priceCents:500});assert.equal(result.filled.length,0);assert.match(result.unresolved.find(field=>field.field==='color').reason,/其他颜色/);assert.equal(f.values.color,'');assert.equal(f.values.priceCents,'');
});
test('a website-recommended material is never selected or claimed verified and stops later draft replacement',async()=>{
  const touched=[];const f=fixture({includeBrandColor:true,colorSuggestions:true,extraFields:[{key:'material',tag:'input',type:'text',label:'Matériau (recommandé)',readOnly:true}],beforeAction(api,args){const node=api.currentIds.get(args.elementId);if(node?.selectedValue==='Autres accessoires')api.values.material='Plastique';if(node?.key==='material')touched.push(args);}});const result=await f.adapter.prepareFields('profile-1',{...listing,color:'Noir'});assert.ok(result.filled.some(field=>field.field==='color'));assert.equal(result.filled.some(field=>field.field==='material'),false);assert.equal(f.values.material,'Plastique');assert.deepEqual(touched,[]);assert.match(result.unresolved.find(field=>field.field==='photos').reason,/独立上传流程/);await assert.rejects(f.adapter.prepareFields('profile-1',{...listing,color:'Noir'}),{code:'EXISTING_DRAFT'});assert.equal(f.values.material,'Plastique');
});
