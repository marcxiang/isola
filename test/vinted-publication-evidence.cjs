'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{EventEmitter}=require('node:events'),{createHash}=require('node:crypto');
const {VintedPublicationEvidence,rememberCategoryTraversal,probePublicationForm,FIELD_SPECS}=require('../src/vinted-publication-evidence.cjs');
const FORM='https://www.vinted.fr/items/new',START=Date.parse('2026-10-14T10:00:00.000Z');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));

function fixture(options={}){
 const make=(tag,properties={})=>{
  const node={tagName:tag.toUpperCase(),children:[],attrs:{},isConnected:true,visible:true,disabled:false,value:'',type:tag==='input'?'text':'',validity:{valid:true},...properties};
  node.getAttribute=key=>Object.hasOwn(node.attrs,key)?node.attrs[key]:null;
  node.contains=other=>other===node||node.children.some(child=>child.contains(other));
  node.querySelectorAll=selector=>descendants(node).filter(candidate=>matches(candidate,selector));
  node.append=(child)=>{child.parent=node;node.children.push(child);return child;};return node;
 };
 function descendants(node){return node.children.flatMap(child=>[child,...descendants(child)]);}
 function matches(node,selectors){return selectors.split(',').some(selector=>{
  const tag=selector.match(/^[a-z]+/i)?.[0];if(tag&&node.tagName!==tag.toUpperCase())return false;
  for(const match of selector.matchAll(/\[([^=\]]+)(?:="?([^"\]]+)"?)?\]/g)){const actual=match[1]==='type'?node.type:node.getAttribute(match[1]);if(match[2]!==undefined?actual!==match[2]:actual===null)return false;}
  return true;
 });}
 const body=make('body'),header=body.append(make('header')),form=body.append(make('form'));
 const outside=node=>{for(let current=node;current;current=current.parent)if(['HEADER','NAV'].includes(current.tagName))return true;return false;};
 const parents=node=>{const result=[];for(let current=node;current;current=current.parent)result.push(current);return result;};
 const d={parents,closest:(node,selector)=>parents(node).find(parent=>selector.includes('header')?outside(parent):selector==='form'?parent.tagName==='FORM':false)||null,visible:node=>node.visible!==false,safeText:node=>node.text||'',label:node=>node.label||node.attrs?.placeholder||node.text||'',disabled:node=>node.disabled===true};
 const listing={title:'Accessoire pour aspirateur noir neuf',description:'Sans marque. Neuf sans étiquette ni emballage.',categoryPath:['Maison','Entretien de la maison','Aspirateurs et nettoyage','Accessoires pour appareils de nettoyage'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
 const profileId='profile-1',tab={id:'tab-1',view:{webContents:Object.assign(new EventEmitter(),{isDestroyed:()=>false,getURL:()=>FORM})}},documentKey='100.1';
 const nodes={};for(const spec of FIELD_SPECS){if(spec.key==='size')continue;nodes[spec.key]=form.append(make(spec.tag,{form,label:spec.label,value:spec.key==='priceCents'?'5,00':spec.key==='categoryPath'?listing.categoryPath.at(-1):listing[spec.key]}));}
 const upload=form.append(make('div')),file=upload.append(make('input',{form,type:'file',visible:false,attrs:{'data-testid':'add-photos-input'}}));
 const group=form.append(make('div')),parcel={};
 const phrases={Petit:'Petit Convient pour un article qui tient dans une grande enveloppe.',Moyen:'Moyen Convient pour un article qui tient dans une boîte à chaussures.',Grand:'Grand Convient pour un article qui tient dans un carton de déménagement.'};
 for(const name of Object.keys(phrases)){const wrapper=group.append(make('button',{text:phrases[name]}));parcel[name]=wrapper.append(make('input',{form,type:'radio',checked:name==='Moyen',visible:false,label:'radio'}));}
 const publish=form.append(make('button',{label:'Ajouter'}));form.append(make('button',{label:'Sauvegarder le brouillon'}));
 const material=form.append(make('input',{form,label:'Matériau (recommandé)',value:options.material||''}));
 const account={memberId:'123',profileURL:'https://www.vinted.fr/member/123',username:'seller',association:'aria'};
 const plan={id:'plan-1',profileId,productId:'product-1',sku:'TEST',listingPriceCents:500,currency:'EUR',enabled:true,completedCount:0,targetCount:2,activeListingId:null,listing};
 const claim={id:'claim-1',setId:'set-1',profileId,productId:plan.productId,images:[{id:'image-1'}]},manifest={claimId:claim.id,setId:claim.setId,profileId,productId:plan.productId,count:1,files:[{sha256:'a'.repeat(64),path:'/private/image.jpg'}]};
 const input={plan,claim,manifest,product:{id:plan.productId,sku:plan.sku,stock:5},expectedAccount:{...account,profileId}};
 const ownership={tab,documentKey,fields:{categoryPath:listing.categoryPath.at(-1)}};
 let currentDocument=documentKey,currentTab=tab,url=FORM,reads=0,passReads=0,actions=0;const w={vintedDraftController:null};
 const photoRecord={claimId:claim.id,phase:'verified',documentKey,manifestKey:hash({claimId:manifest.claimId,files:manifest.files.map(file=>file.sha256),count:1}),signature:'b'.repeat(64)};
 const sandbox={globalThis:{__isolaDOM:d},document:{querySelectorAll:selector=>descendants(body).filter(node=>matches(node,selector))},location:{get href(){return url;}},performance:{get timeOrigin(){return currentDocument;}}};
 const adapter={
  drafts:new Map([[profileId,ownership]]),
  current(id,context={}){assert.equal(id,profileId);if(context.signal?.aborted)throw Object.assign(Error('Stopped'),{code:'STOPPED'});if(context.tab&&context.tab!==currentTab)throw Object.assign(Error('Tab changed'),{code:'TAB_CHANGED'});if(w.vintedDraftController&&w.vintedDraftController!==context.controller)throw Object.assign(Error('Busy'),{code:'PAGE_BUSY'});if(url!==FORM)throw Object.assign(Error('Wrong page'),{code:'WRONG_PAGE'});return {w,tab:currentTab};},
  read:async()=>{reads++;options.onRead?.(api,reads);return {url:FORM,elements:[]};},
  control:{isolated:async(_tab,expression)=>{passReads++;options.onProbe?.(api,passReads);if(options.hangProbe)return new Promise(()=>{});return vm.runInNewContext(expression,sandbox);},performAction:async()=>{actions++;throw Error('Evidence reader must never act');}},
  photos:{claims:new Map([[profileId+'\0'+tab.id+'\0'+documentKey,photoRecord]]),read:async()=>({documentKey:currentDocument,challenge:options.challenge===true}),receipt:()=>options.missingPhotoReceipt?null:{count:1,signature:photoRecord.signature}}
 };
 const accountReader={state:async()=>{options.onAccount?.(api);return {documentKey:currentDocument,button:{username:account.username},account:options.closedAccountMenu?null:{...account}};}};
 const reader=new VintedPublicationEvidence(adapter,{accountReader,now:()=>START,timeoutMs:options.timeoutMs||1000});
 const api={reader,adapter,input,ownership,account,photoRecord,nodes,parcel,publish,material,form,header,body,make,file,get actions(){return actions;},get reads(){return reads;},w,setDocument(value){currentDocument=value;},setURL(value){url=value;},setTab(value){currentTab=value;},probe(){return vm.runInNewContext('('+probePublicationForm.toString()+')('+JSON.stringify(FIELD_SPECS)+')',sandbox);}};
 if(!options.noTraversal)rememberCategoryTraversal(ownership,{tab,documentKey,path:listing.categoryPath,selectedValue:listing.categoryPath.at(-1),steps:listing.categoryPath.map((label,index)=>({label,elementId:'e'+index+'-1',role:index===listing.categoryPath.length-1?'radio':'button',documentKey,unique:true}))});
 return api;
}

test('read-only production collector builds proof from native fields, parcel radios, current account and original photo upload record',async()=>{
 const f=fixture(),result=await f.reader.collect(f.input);assert.equal(result.proof.facts.fields.priceCents,500);assert.equal(result.proof.facts.fields.parcel,'Moyen');assert.deepEqual(result.proof.facts.fields.categoryPath,f.input.plan.listing.categoryPath);assert.equal(result.summary.fieldCount,8);assert.equal(result.summary.photoCount,1);assert.equal(result.summary.readyForPublication,true);assert.equal(result.summary.publicationEnabled,false);assert.equal(f.actions,0);assert.equal(f.w.vintedDraftController,null);
 assert.equal(JSON.stringify(result).includes('/private/image.jpg'),false);assert.equal(f.reads,2);
});

test('inspect exposes review checks without leaking proof authority or paths',async()=>{
 const f=fixture(),report=await f.reader.inspect(f.input);assert.equal(report.readyForPublication,true);assert.equal(Object.hasOwn(report,'proof'),false);assert.equal(Object.hasOwn(report,'evidence'),false);assert.equal(report.checks.every(check=>check.ok),true);assert.equal(JSON.stringify(report).includes('/private/image.jpg'),false);
});

test('unknown optional material may be empty, but an automatic suggestion is never adopted',async()=>{
 const empty=fixture(),report=await empty.reader.inspect(empty.input);assert.equal(report.readyForPublication,true);
 const filled=fixture({material:'Plastique'}),blocked=await filled.reader.inspect(filled.input);assert.equal(blocked.readyForPublication,false);assert.ok(blocked.blockers.some(message=>message.includes('Matériau')));assert.equal(filled.actions,0);
});

test('unknown required, invalid, checked and sensitive controls stop; their values never appear in reports',async()=>{
 for(const props of [{required:true},{attrs:{'aria-invalid':'true'}},{type:'checkbox',checked:true},{type:'password',value:'secret-value'}]){
  const f=fixture();Object.assign(f.material,props);const report=await f.reader.inspect(f.input);assert.equal(report.readyForPublication,false,JSON.stringify(props));assert.equal(JSON.stringify(report).includes('secret-value'),false);
 }
 const f=fixture();f.header.append(f.make('input',{label:'Header search',value:'not a listing field'}));assert.equal((await f.reader.inspect(f.input)).readyForPublication,true);
});

test('all seven text or choice values and the selected parcel are reread rather than copied from the plan',async()=>{
 for(const key of Object.keys(fixture().nodes)){const f=fixture();f.nodes[key].value='changed';const report=await f.reader.inspect(f.input);assert.equal(report.readyForPublication,false,key);assert.equal(f.actions,0);}
 const f=fixture();f.parcel.Moyen.checked=false;f.parcel.Grand.checked=true;assert.equal((await f.reader.inspect(f.input)).readyForPublication,false);
});

test('missing or duplicated fields, parcel options and publish buttons are rejected',async()=>{
 const changes=[
  f=>f.nodes.title.visible=false,f=>f.form.append(f.make('input',{form:f.form,label:'Titre',value:f.nodes.title.value})),
  f=>f.parcel.Petit.checked=true,f=>f.parcel.Moyen.disabled=true,
  f=>f.publish.disabled=true,f=>f.publish.visible=false,f=>f.form.append(f.make('button',{label:'Ajouter'})),
  f=>f.form.append(f.make('div',{attrs:{role:'alert'},text:'Champ obligatoire'})),f=>f.body.append(f.make('dialog',{attrs:{open:'', 'aria-modal':'true'},text:'Verification'}))
 ];
 for(const change of changes){const f=fixture();change(f);assert.equal((await f.reader.inspect(f.input)).readyForPublication,false,String(change));}
});

test('matching category leaf or forged ownership property cannot replace a real traversal receipt',async()=>{
 const f=fixture({noTraversal:true});f.ownership.categoryTraversal={path:f.input.plan.listing.categoryPath,verified:true};const report=await f.reader.inspect(f.input);assert.equal(report.readyForPublication,false);assert.equal(report.code,'PUBLICATION_CATEGORY_UNVERIFIED');
 const g=fixture();g.input.plan.listing.categoryPath=['Other parent',g.input.plan.listing.categoryPath.at(-1)];assert.equal((await g.reader.inspect(g.input)).code,'PUBLICATION_CATEGORY_UNVERIFIED');
});

test('category recorder rejects incomplete, nonunique or nonmatching traversal steps',()=>{
 const f=fixture({noTraversal:true}),path=f.input.plan.listing.categoryPath,receipt={tab:f.ownership.tab,documentKey:f.ownership.documentKey,path,selectedValue:path.at(-1),steps:path.map((label,index)=>({label,documentKey:f.ownership.documentKey,elementId:'e'+index+'-1',role:index===path.length-1?'radio':'button',unique:true}))};
 for(const change of [v=>v.steps.pop(),v=>v.steps[0].unique=false,v=>v.steps[0].label='Other',v=>v.steps[0].documentKey='other',v=>v.steps.at(-1).role='button',v=>v.selectedValue='Other']){const value={...receipt,steps:receipt.steps.map(step=>({...step}))};change(value);assert.throws(()=>rememberCategoryTraversal(f.ownership,value),{code:'PUBLICATION_CATEGORY_UNVERIFIED'});}
});

test('photo evidence requires the exact uploaded manifest and current document, not a matching image count',async()=>{
 for(const change of [f=>f.photoRecord.claimId='other',f=>f.photoRecord.phase='uncertain',f=>f.photoRecord.manifestKey='other',f=>f.input.manifest.files[0].sha256='c'.repeat(64),f=>f.adapter.photos.claims.clear(),f=>f.input.manifest.profileId='other']){
  const f=fixture();change(f);assert.equal((await f.reader.inspect(f.input)).readyForPublication,false,String(change));
 }
 const f=fixture({missingPhotoReceipt:true});assert.equal((await f.reader.inspect(f.input)).code,'PUBLICATION_PHOTO_UNVERIFIED');
});

test('current account must be visible and agree with the environment binding',async()=>{
 const closed=fixture({closedAccountMenu:true});assert.equal((await closed.reader.inspect(closed.input)).code,'PUBLICATION_ACCOUNT_UNVERIFIED');assert.equal(closed.actions,0);
 const other=fixture();other.input.expectedAccount.memberId='999';assert.equal((await other.reader.inspect(other.input)).readyForPublication,false);
 const different=fixture({onProbe:(api,count)=>{if(count===2)api.account.memberId='999';}});assert.equal((await different.reader.inspect(different.input)).code,'PUBLICATION_EVIDENCE_CHANGED');
});

test('changes between the two independent observations block publication evidence',async()=>{
 const f=fixture({onProbe:(api,count)=>{if(count===2)api.nodes.priceCents.value='6,00';}});assert.equal((await f.reader.inspect(f.input)).code,'PUBLICATION_EVIDENCE_CHANGED');
 const g=fixture({onRead:(api,count)=>{if(count===2)api.setDocument('other');}});assert.equal((await g.reader.inspect(g.input)).readyForPublication,false);
});

test('timeout, cancellation, navigation and busy-window guards clean up without any page actions',async()=>{
 const hung=fixture({hangProbe:true,timeoutMs:20});assert.equal((await hung.reader.inspect(hung.input)).code,'PUBLICATION_EVIDENCE_TIMEOUT');assert.equal(hung.w.vintedDraftController,null);
 const cancelled=fixture(),controller=new AbortController();controller.abort();assert.equal((await cancelled.reader.inspect(cancelled.input,{signal:controller.signal})).code,'STOPPED');
 const busy=fixture();busy.w.vintedDraftController=new AbortController();assert.equal((await busy.reader.inspect(busy.input)).code,'PAGE_BUSY');assert.ok(busy.w.vintedDraftController);
 const navigation=fixture({onProbe:api=>api.ownership.tab.view.webContents.emit('did-start-navigation',{},FORM,false,true)});assert.equal((await navigation.reader.inspect(navigation.input)).code,'STOPPED');assert.equal(navigation.w.vintedDraftController,null);
 assert.equal([hung,cancelled,busy,navigation].every(f=>f.actions===0),true);
});

test('page challenge and unverified supplier stock block a proof even with matching fields',async()=>{
 const f=fixture({challenge:true});assert.equal((await f.reader.inspect(f.input)).readyForPublication,false);
 const g=fixture();g.input.product.stock=0;assert.equal((await g.reader.inspect(g.input)).readyForPublication,false);
});
