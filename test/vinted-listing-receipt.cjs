'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{createHash}=require('node:crypto');
const {VintedListingReceipt,priceCents,listingURL}=require('../src/vinted-listing-receipt.cjs');
const {buildPublicationProof,FORM_URL}=require('../src/vinted-publication.cjs');
const {createEnvironmentSessionAuthority}=require('../src/commerce-session-authority.cjs');
const clone=value=>JSON.parse(JSON.stringify(value)),hash=value=>createHash('sha256').update(value).digest('hex'),SOURCE='https://images.vinted.test/fixture.jpg';
function inputFixture(session=false){
 const now=Date.now(),profileId='profile-1',listing={title:'Fixture accessory',description:'Fixture description.',categoryPath:['Maison','Accessoires'],condition:'Neuf sans étiquette',brand:'Sans marque',color:'Noir',parcel:'Moyen'};
 const plan={id:'plan-1',profileId,productId:'product-1',sku:'FIXTURE',listing,listingPriceCents:500,currency:'EUR',enabled:true,completedCount:0,targetCount:1};
 const expectedAccount=session?createEnvironmentSessionAuthority(profileId):{profileId,memberId:'123456',profileURL:'https://www.vinted.fr/member/123456',username:'fixture_seller'},documentKey='original-form-document';
 const evidence={profileId,tabId:'tab-1',url:FORM_URL,documentKey,observedAt:new Date(now).toISOString(),challenge:false,account:session?clone(expectedAccount):{...expectedAccount,verified:true},form:{documentKey,complete:true,invalidFields:[],unknownFields:[],fields:Object.entries({...listing,priceCents:500}).map(([field,value])=>({field,value,verified:true}))},photos:{profileId,productId:plan.productId,claimId:'claim-1',setId:'set-1',count:1,signature:hash(JSON.stringify([hash(SOURCE)])),documentKey,verified:true,busy:false,errorCount:0},publication:{documentKey,count:1,label:'Ajouter',enabled:true,observed:true}};
 const proof=buildPublicationProof({plan,product:{id:plan.productId,sku:plan.sku,stock:1},claim:{id:'claim-1',setId:'set-1',profileId,productId:plan.productId,images:[{id:'image-1'}]},expectedAccount,evidence},{now});
 return {expectedAccount,record:{id:'submission-1',state:'uncertain',attemptCount:1,proof,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),submittedAt:new Date(now).toISOString(),receipt:null,reason:''}};
}
function fixture(options={}){
 const input=inputFixture(options.session),profileId=input.expectedAccount.profileId,documentKey='detail-document',url=options.url||'https://www.vinted.fr/items/987654-fixture';
 const raw={url,documentKey,errors:[],title:'Fixture accessory',priceTexts:['5,00€'],ownControls:["Modifier l'annonce",'Masquer','Supprimer','Indiquer comme vendu','Marquer comme réservé'].map((label,index)=>({label,count:1,enabled:true,kind:index<3?'button':'link'})),sellers:[{label:'fixture_seller',href:input.expectedAccount.profileURL}],images:[{alt:'Fixture accessory',inNamedButton:true,loaded:true,source:SOURCE}],challenge:false,dialogs:0,alerts:[]};
 let probes=0,accounts=0,currentURL=url;const contents=Object.assign(new EventEmitter(),{isDestroyed:()=>false,getURL:()=>currentURL});
 const tab={id:'tab-1',view:{webContents:contents}},w={activeTab:tab.id,tabs:[tab],isDestroyed:()=>false,aiAgent:{state:{running:false}}};
 if(options.session)raw.sellers=[];
 const calls={inspect:0,state:0,actions:0};
 const adapter={current(id,context){assert.equal(id,profileId);if(context.signal?.aborted)throw Object.assign(Error('Stopped'),{code:'STOPPED'});if(context.tab&&context.tab!==w.tabs.find(t=>t.id===w.activeTab))throw Object.assign(Error('Changed tab'),{code:'TAB_CHANGED'});if(w.aiAgent.state.running||w.vintedDraftController&&w.vintedDraftController!==context.controller)throw Object.assign(Error('Busy'),{code:'PAGE_BUSY'});return {w,tab};},read:async()=>({url:currentURL,elements:[]}),control:{isolated:async()=>{probes++;if(options.hang)return new Promise(()=>{});const value=clone(raw);options.onProbe?.(api,value,probes);return value;},performAction:()=>{calls.actions++;throw Error('No listing controls may be clicked');}}};
 const accountReader={inspectAccount:async(_profile,settings)=>{calls.inspect++;assert.equal(options.session,undefined,'Session receipt must not inspect the account');assert.equal(settings.closeMenu,true);assert.equal(settings.expectedAccount,input.expectedAccount);options.onInspect?.(api);return {verified:true,memberId:input.expectedAccount.memberId,profileURL:input.expectedAccount.profileURL,username:'fixture_seller',documentKey,menuOpened:true,menuClosed:!options.menuRemainsOpen,usernameSource:options.usernameSource||'avatar'};},state:async(_id,_context,expected)=>{calls.state++;assert.equal(options.session,undefined,'Session receipt must not read account state');accounts++;assert.equal(expected.documentKey,documentKey);options.onAccount?.(api,accounts);return {documentKey,account:{memberId:input.expectedAccount.memberId,profileURL:input.expectedAccount.profileURL,username:'fixture_seller'}};}};
 const reader=new VintedListingReceipt(adapter,{accountReader,timeoutMs:options.timeoutMs??500}),api={input,raw,w,tab,contents,calls,reader,setURL:value=>currentURL=value,run:opts=>reader.collect(input,opts)};return api;
}
test('two consistent detail reads return private evidence without adopting an origin or reconciling records',async()=>{const f=fixture(),before=JSON.stringify(f.input),result=await f.run();assert.equal(result.summary.verified,true);assert.equal(result.summary.photoSignatureMatched,true);assert.equal(result.summary.listingId,'987654');assert.equal(result.summary.url,'https://www.vinted.fr/items/987654');assert.equal(result.summary.needsOriginAssociation,true);assert.equal(result.summary.reconciled,false);assert.equal(result.evidence.ownedByCurrentAccount,true);assert.equal(result.evidence.priceCents,500);assert.equal(result.evidence.origin,undefined);assert.equal(JSON.stringify(result).includes(SOURCE),false);assert.equal(JSON.stringify(f.input),before);assert.equal(f.calls.inspect,1);assert.equal(f.calls.actions,0);assert.equal(f.w.vintedDraftController,null);});
test('standalone price parser does not accept the fee-inclusive buyer total',()=>{assert.equal(priceCents('5,00€'),500);assert.equal(priceCents('1 234,56 €'),123456);for(const value of ['5,95 €, frais Vinted inclus','5','5 €','5,9€','0,00€','-5,00€','5,00 USD'])assert.equal(priceCents(value),null);});
test('wrong title, fee total and duplicate standalone prices prevent a verified receipt',async()=>{for(const change of [raw=>raw.title='Other accessory',raw=>raw.priceTexts=['5,95 €, frais Vinted inclus'],raw=>raw.priceTexts=['5,00€','5,00€'],raw=>raw.priceTexts=['6,00€']]){const f=fixture();change(f.raw);const out=await f.run();assert.equal(out.summary.verified,false);assert.equal(out.evidence,null);assert.ok(out.summary.blockers.length);assert.equal(f.calls.actions,0);}});
test('all five unique enabled owner controls must be present',async()=>{for(const change of [raw=>raw.ownControls.pop(),raw=>raw.ownControls[0].count=2,raw=>raw.ownControls[1].enabled=false,raw=>raw.ownControls[2].label='Other button']){const f=fixture();change(f.raw);const out=await f.run();assert.equal(out.summary.verified,false);assert.ok(out.summary.checks.some(c=>c.name==='本人管理控件'&&!c.ok));}});
test('seller identity cannot come from a similarly named member or unrelated origin',async()=>{for(const href of ['https://www.vinted.fr/member/999999','https://www.vinted.fr.evil.test/member/123456','https://www.vinted.fr/member/123456?x=1']){const f=fixture();f.raw.sellers[0].href=href;const out=await f.run();assert.equal(out.evidence,null);assert.ok(out.summary.checks.some(c=>c.name==='实际卖家'&&!c.ok));}const f=fixture();f.raw.sellers.push(clone(f.raw.sellers[0]));assert.equal((await f.run()).summary.verified,false);});
test('changed photo URLs do not masquerade as the uploaded image',async()=>{const f=fixture();f.raw.images[0].source='https://images.vinted.test/resized-fixture.jpg';const out=await f.run();assert.equal(out.summary.photoSignatureMatched,false);assert.equal(out.evidence,null);assert.ok(out.summary.blockers.some(text=>text.includes('摘要')));});
test('incomplete, unrelated, duplicate or unloaded images fail closed',async()=>{for(const change of [raw=>raw.images=[],raw=>raw.images[0].loaded=false,raw=>raw.images[0].inNamedButton=false,raw=>raw.images[0].alt='Related item',raw=>raw.images.push(clone(raw.images[0])),raw=>raw.images[0].source='data:image/jpeg;base64,fixture']){const f=fixture();change(f.raw);assert.equal((await f.run()).evidence,null);}});
test('two different detail observations cannot be marked stable',async()=>{const f=fixture({onProbe:(_api,raw,count)=>{if(count===2)raw.priceTexts=['6,00€'];}}),out=await f.run();assert.equal(out.summary.verified,false);assert.ok(out.summary.checks.some(c=>c.name==='连续两次详情核对'&&!c.ok));});
test('challenge, modal dialog and page errors block a receipt',async()=>{for(const change of [raw=>raw.challenge=true,raw=>raw.dialogs=1,raw=>raw.alerts=['Pending review'],raw=>raw.errors=['Ambiguous detail container']]){const f=fixture();change(f.raw);const out=await f.run();assert.equal(out.evidence,null);assert.equal(f.calls.actions,0);}});
test('wrong URLs and unsubmitted records fail before account interaction',async()=>{for(const url of [FORM_URL,'https://www.vinted.fr/member/123456','https://evil.invalid/items/987654','https://www.vinted.fr/items/987654?from=profile','https://www.vinted.fr/items/987654#photo']){const f=fixture({url});const out=await f.run();assert.equal(out.evidence,null);assert.equal(f.calls.inspect,0);}const f=fixture();f.input.record.state='prepared';f.input.record.attemptCount=0;f.input.record.submittedAt=null;const out=await f.run();assert.equal(out.evidence,null);assert.equal(f.calls.inspect,0);});
test('bound-account mismatch and tampered stored proof cannot be read as a valid receipt',async()=>{const f=fixture();f.input.expectedAccount.memberId='999999';assert.equal((await f.run()).summary.code,'LISTING_ACCOUNT_CHANGED');assert.equal(f.calls.inspect,0);const g=fixture();g.input.record.proof=clone(g.input.record.proof);g.input.record.proof.facts.fields.priceCents=999;const out=await g.run();assert.equal(out.summary.code,'PUBLICATION_CORRUPT');assert.equal(g.calls.inspect,0);});
test('document or listing change during the double read is rejected',async()=>{for(const change of [raw=>raw.documentKey='other-document',raw=>raw.url='https://www.vinted.fr/items/111111-other']){const f=fixture({onProbe:(_api,raw,count)=>{if(count===2)change(raw);}});const out=await f.run();assert.equal(out.evidence,null);assert.equal(out.summary.verified,false);}});
test('AI, another controller and tab switching cannot run concurrent detail work',async()=>{for(const change of [f=>f.w.aiAgent.state.running=true,f=>f.w.vintedDraftController=new AbortController(),f=>f.w.activeTab='other']){const f=fixture();change(f);assert.equal((await f.run()).evidence,null);assert.equal(f.calls.actions,0);}});
test('cancellation, navigation and timeout clear only the owned controller',async()=>{const controller=new AbortController();controller.abort();const f=fixture();assert.equal((await f.run({signal:controller.signal})).summary.code,'STOPPED');assert.equal(f.calls.inspect,0);const g=fixture({onProbe:api=>api.contents.emit('did-start-navigation',{},'https://www.vinted.fr/',false,true)});assert.equal((await g.run()).evidence,null);assert.equal(g.w.vintedDraftController,null);assert.equal(g.contents.listenerCount('did-start-navigation'),0);const h=fixture({hang:true,timeoutMs:25});assert.equal((await h.run()).summary.code,'LISTING_RECEIPT_TIMEOUT');assert.equal(h.w.vintedDraftController,null);});
test('listing canonicalization retains the exact numeric item identity',()=>{assert.deepEqual(listingURL('https://www.vinted.fr/items/987654-fixture'),{listingId:'987654',url:'https://www.vinted.fr/items/987654'});});

test('mobile receipt inspection uses the bound username as display only while reading seller and photos independently',async()=>{
 const f=fixture({usernameSource:'saved-binding'}),result=await f.run();assert.equal(result.summary.menuClosed,true);assert.equal(result.summary.verified,true);assert.equal(result.evidence.seller.memberId,'123456');assert.equal(result.evidence.photos.verified,true);
 const changed=fixture({usernameSource:'saved-binding'});changed.raw.sellers=[{href:'https://www.vinted.fr/member/999',label:'fixture_seller'}];assert.equal((await changed.run()).summary.verified,false);
});
test('receipt detail reads stop if the account drawer cannot be closed',async()=>{
 const f=fixture({menuRemainsOpen:true}),result=await f.run();assert.equal(result.summary.verified,false);assert.equal(result.evidence,null);assert.equal(result.summary.menuClosed,false);
});

test('environment-session receipts collect the original item without account menus, usernames or a saved member binding',async()=>{
 const f=fixture({session:true}),result=await f.run();
 assert.equal(result.summary.verified,true);assert.equal(result.summary.accountVerification,'not-requested');
 assert.equal(result.summary.menuOpened,false);assert.equal(result.summary.menuClosed,false);
 assert.deepEqual(result.evidence.account,{kind:'environment-session',profileId:'profile-1'});
 assert.equal(result.evidence.seller,undefined);assert.equal(result.evidence.account.memberId,undefined);assert.equal(result.evidence.account.verified,undefined);
 assert.equal(result.evidence.ownedByCurrentAccount,true);assert.equal(result.evidence.photos.verified,true);
 assert.deepEqual(f.calls,{inspect:0,state:0,actions:0});
});

test('environment-session receipt rejects another tab, another environment or changing detail documents without reading account data',async()=>{
 for(const change of [f=>{f.tab.id='other-tab';f.w.activeTab=f.tab.id;},f=>f.input.expectedAccount={kind:'environment-session',profileId:'other-profile'}]){
  const f=fixture({session:true});change(f);const result=await f.run();assert.equal(result.evidence,null);assert.equal(f.calls.inspect,0);assert.equal(f.calls.state,0);
 }
 const changed=fixture({session:true,onProbe:(_api,raw,count)=>{if(count===2)raw.documentKey='different-detail-document';}});
 assert.equal((await changed.run()).summary.code,'LISTING_PAGE_CHANGED');assert.equal(changed.calls.inspect,0);assert.equal(changed.calls.state,0);
});

test('environment-session receipts still reject missing owner controls, mismatched photos and changed item values',async()=>{
 for(const change of [raw=>raw.ownControls.pop(),raw=>raw.title='Another item',raw=>raw.priceTexts=['7,00€'],raw=>raw.images[0].source='https://images.vinted.test/another.jpg',raw=>raw.challenge=true]){
  const f=fixture({session:true});change(f.raw);const result=await f.run();assert.equal(result.evidence,null);assert.equal(result.summary.verified,false);assert.equal(f.calls.inspect,0);assert.equal(f.calls.state,0);assert.equal(f.calls.actions,0);
 }
});

test('main-process original-submission review may read a reopened session detail tab without any account reads',async()=>{
 const f=fixture({session:true});f.tab.id='reopened-after-restart';f.w.activeTab=f.tab.id;
 const automatic=await f.run();assert.equal(automatic.summary.code,'LISTING_PAGE_CHANGED');assert.equal(automatic.evidence,null);
 const reviewed=await f.run({reviewOriginalSubmission:true});assert.equal(reviewed.summary.verified,true);
 assert.deepEqual(reviewed.binding,{documentKey:'detail-document',tabId:'reopened-after-restart'});
 assert.deepEqual(reviewed.evidence.account,{kind:'environment-session',profileId:'profile-1'});
 assert.deepEqual(f.calls,{inspect:0,state:0,actions:0});
 const otherScope=fixture({session:true});otherScope.input.expectedAccount={kind:'environment-session',profileId:'different-profile'};
 assert.equal((await otherScope.run({reviewOriginalSubmission:true})).summary.code,'LISTING_ACCOUNT_CHANGED');
 assert.deepEqual(otherScope.calls,{inspect:0,state:0,actions:0});
});
