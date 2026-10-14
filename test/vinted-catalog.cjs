'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {VintedCatalog,probeCatalogDOM,catalogSurface,parseCardLabel,normalizedTitle,itemIdentity,OWN_EMPTY_WARDROBE}=require('../src/vinted-catalog.cjs');
const clone=value=>JSON.parse(JSON.stringify(value)),PROFILE='https://www.vinted.fr/member/123456',TITLE='Accessoire aspirateur QA',LABEL=TITLE+', état: Neuf sans étiquette, 5,00 €',EMPTY='Fixture seulement : aucun article dans ce dressing.';
const account={profileId:'profile-1',memberId:'123456',profileURL:PROFILE,username:'fixture_seller'};
function rawFixture(){return {url:PROFILE,documentKey:'1234',countLabels:['1 article'],links:[{href:'https://www.vinted.fr/items/654321-qa',labels:[LABEL]}],emptyLabels:[],errors:[],ready:true,busy:false,pagination:false,challenge:false,dialogs:0,alerts:[]};}
function surface(raw,options={}){return catalogSurface(raw,{expectedAccount:account,title:TITLE,emptyStateLabels:[EMPTY],...options});}

test('the observed full accessible card shape yields an exact normalized title and item price',()=>{
 assert.deepEqual(parseCardLabel(LABEL),{title:TITLE,normalizedTitle:'accessoire aspirateur qa',condition:'Neuf sans étiquette',priceCents:500,currency:'EUR'});
 assert.deepEqual(parseCardLabel(LABEL.replace('5,00 €','5 €')),parseCardLabel(LABEL));
 assert.equal(parseCardLabel(LABEL.replace('5,00 €','0 €')),null);
 assert.equal(normalizedTitle('  Accessoire   aspirateur QA '),'accessoire aspirateur qa');
 assert.equal(normalizedTitle('ÉTAT neuf'),normalizedTitle('e\u0301tat neuf'));
 for(const label of [TITLE,TITLE+', 5,00 €',TITLE+', état: inconnu, 5,00 €',TITLE+', état: Neuf sans étiquette, 5,95 €, frais Vinted inclus',TITLE+', état: Neuf sans étiquette, 1e2 €',TITLE+', état: Neuf sans étiquette, 0,00 €',TITLE+', état: Neuf sans étiquette, 5,0 €'])assert.equal(parseCardLabel(label),null,label);
});
test('a complete nonempty own catalog can report either the duplicate or a verified title absence',()=>{
 const duplicate=surface(rawFixture());assert.equal(duplicate.complete,true);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.absent,false);assert.equal(duplicate.items[0].listingId,'654321');
 const absent=surface(rawFixture(),{title:'Un autre titre QA'});assert.equal(absent.complete,true);assert.equal(absent.duplicate,false);assert.equal(absent.absent,true);
});
test('multiple visible links for one item count once, but conflicting reliable cards remain incomplete',()=>{
 const raw=rawFixture();raw.links.push({href:'https://www.vinted.fr/items/654321',labels:['Modifier']});assert.equal(surface(raw).complete,true);assert.equal(surface(raw).items.length,1);
 raw.links.push({href:'https://www.vinted.fr/items/654321',labels:[LABEL.replace('5,00','6,00')]});const out=surface(raw);assert.equal(out.complete,false);assert.equal(out.duplicate,null);assert.equal(out.absent,false);
});
test('virtualized, paginated, hidden or partially loaded item counts cannot prove absence',()=>{
 for(const change of [raw=>raw.countLabels=['2 articles'],raw=>raw.countLabels=[],raw=>raw.countLabels=['1 article','1 article'],raw=>raw.countLabels=['1 articles affichés'],raw=>raw.links=[],raw=>raw.pagination=true,raw=>raw.ready=false,raw=>raw.busy=true]){const raw=rawFixture();change(raw);const out=surface(raw,{title:'Other QA'});assert.equal(out.complete,false);assert.equal(out.duplicate,null);assert.equal(out.absent,false);}
});
test('one unknown item title blocks absence even if the total count is complete',()=>{
 const raw=rawFixture();raw.links[0].labels=['Unknown image alt'];const out=surface(raw);assert.equal(out.complete,false);assert.equal(out.duplicate,null);assert.equal(out.absent,false);
 const mixed=rawFixture();mixed.countLabels=['2 articles'];mixed.links.push({href:'https://www.vinted.fr/items/654322',labels:['Unknown']});const duplicate=surface(mixed);assert.equal(duplicate.complete,false);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.absent,false);
});
test('zero requires both the exact count and an explicitly observed visible empty-state marker',()=>{
 const raw=rawFixture();Object.assign(raw,{countLabels:['0 articles'],links:[],emptyLabels:[EMPTY]});assert.equal(surface(raw).absent,true);
 assert.equal(surface(raw,{emptyStateLabels:[]}).absent,false);
 raw.emptyLabels=[];assert.equal(surface(raw).complete,false);raw.emptyLabels=['unrecognized'];assert.equal(surface(raw).complete,false);
});
test('foreign or parameterized account and item URLs are rejected rather than canonicalized into proof',()=>{
 for(const url of ['https://www.vinted.fr/member/999999','https://evil.invalid/member/123456','https://www.vinted.fr/member/123456?tab=items','https://user@www.vinted.fr/member/123456','https://www.vinted.fr/items/654321']){const raw=rawFixture();raw.url=url;assert.throws(()=>surface(raw));}
 for(const href of ['https://www.vinted.fr/items/0','https://www.vinted.fr/items/654321?x=1','https://www.vinted.fr.evil.invalid/items/654321','https://user@www.vinted.fr/items/654321']){const raw=rawFixture();raw.links[0].href=href;assert.equal(surface(raw).absent,false);assert.equal(surface(raw).complete,false);}
 assert.deepEqual(itemIdentity('https://www.vinted.fr/items/654321-qa'),{listingId:'654321',url:'https://www.vinted.fr/items/654321'});
});
test('page challenges, dialogs, alerts and malformed structure cannot confirm absence',()=>{
 for(const change of [raw=>raw.challenge=true,raw=>raw.dialogs=1,raw=>raw.alerts=['Pending'],raw=>raw.errors=['Unknown structure'],raw=>delete raw.challenge,raw=>delete raw.alerts,raw=>delete raw.links,raw=>delete raw.documentKey,raw=>raw.countLabels=['9999999999999999999 articles']]){const raw=rawFixture();change(raw);assert.equal(surface(raw,{title:'Other QA'}).absent,false);}
});

function domFixture({zero=false,observedEmpty=false}={}){
 const all=[];
 const ancestors=e=>{const result=[];for(let node=e;node;node=node.parent)result.push(node);return result;};
 const matches=(node,selector)=>selector.split(',').some(value=>{const part=value.trim(),tag=/^[a-zA-Z0-9]+/.exec(part)?.[0];if(tag&&node.tagName!==tag.toUpperCase())return false;const attrs=[...part.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)];return attrs.every(([,key,val])=>val===undefined?Object.prototype.hasOwnProperty.call(node.attrs,key):node.attrs[key]===val);});
 const node=(tag,attrs={},parent=null,text='')=>{const e={tagName:tag.toUpperCase(),attrs,parent,text,isConnected:true,hidden:false,children:[],href:attrs.href||'',getAttribute:key=>attrs[key]??null,contains:other=>ancestors(other).includes(e),querySelectorAll(selector){return all.filter(other=>other!==e&&e.contains(other)&&matches(other,selector));}};parent?.children.push(e);all.push(e);return e;};
 const body=node('body'),main=node('main',{},body),scope=node('section',{},main),heading=node(observedEmpty?'h1':'h2',{},scope,observedEmpty?OWN_EMPTY_WARDROBE.heading:zero?'0 articles':'1 article');
 const anchor=zero||observedEmpty?null:node('a',{href:'https://www.vinted.fr/items/654321-qa','aria-label':LABEL},scope);if(anchor)node('img',{alt:LABEL},anchor);
 const empty=zero||observedEmpty?node('p',{},scope,observedEmpty?OWN_EMPTY_WARDROBE.subtitle:EMPTY):null;
 const selectedTab=observedEmpty?node('button',{role:'tab','aria-selected':'true'},main,'Annonces'):null,createLink=observedEmpty?node('a',{href:OWN_EMPTY_WARDROBE.createURL},scope,OWN_EMPTY_WARDROBE.createLabel):null;
 const visible=e=>!ancestors(e).some(p=>p.hidden),safeText=(e,max)=>[e,...all.filter(other=>other!==e&&e.contains(other))].filter(visible).map(item=>item.text).filter(Boolean).join(' ').slice(0,max);
 const context={globalThis:{__isolaDOM:{visible,closest:(e,selector)=>ancestors(e).find(parent=>matches(parent,selector)),parents:ancestors,safeText,label:e=>e.attrs['aria-label']||safeText(e,180),disabled:()=>false}},location:{href:PROFILE},performance:{timeOrigin:1234},document:{readyState:'complete',querySelectorAll:selector=>all.filter(e=>matches(e,selector))},URL};
 return {all,node,body,main,scope,heading,anchor,empty,selectedTab,createLink,context,run(labels=[EMPTY]){return clone(vm.runInNewContext('('+probeCatalogDOM.toString()+')('+JSON.stringify(labels)+','+JSON.stringify(OWN_EMPTY_WARDROBE)+')',context));}};
}
test('the DOM probe reads observed accessible card text and count in one bounded region',()=>{
 const f=domFixture(),raw=f.run();assert.deepEqual(raw.countLabels,['1 article']);assert.equal(raw.links.length,1);assert.deepEqual(raw.links[0].labels,[LABEL]);assert.equal(surface(raw).complete,true);
 const zero=domFixture({zero:true});assert.equal(surface(zero.run()).absent,true);zero.empty.hidden=true;assert.equal(surface(zero.run()).absent,false);
});
test('the DOM probe excludes navigation links but will not ignore extra content item links',()=>{
 const f=domFixture(),header=f.node('header',{},f.body);f.node('a',{href:'https://www.vinted.fr/items/222222-qa','aria-label':LABEL},header);assert.equal(surface(f.run()).complete,true);
 f.node('a',{href:'https://www.vinted.fr/items/333333-qa','aria-label':LABEL.replace(TITLE,'Other item')},f.main);assert.equal(surface(f.run()).complete,false);
});
test('the DOM probe marks pagination, busy content, ambiguous counts, hidden cards and challenges incomplete',()=>{
 const changes=[f=>f.node('button',{},f.scope,'Charger plus'),f=>f.node('div',{'aria-busy':'true'},f.scope),f=>f.node('h2',{},f.scope,'1 article'),f=>f.anchor.hidden=true,f=>f.node('iframe',{src:'https://challenges.cloudflare.com/'},f.scope),f=>f.node('dialog',{open:''},f.scope)];
 for(const mutate of changes){const f=domFixture();mutate(f);const raw=f.run();assert.equal(surface(raw,{title:'Other QA'}).absent,false);}
});

function readerFixture(options={}){
 const raw=rawFixture(),calls={inspect:0,state:0,actions:0,probes:0};let currentURL=options.url||PROFILE;
 const contents=Object.assign(new EventEmitter(),{getURL:()=>currentURL}),tab={id:'tab-1',view:{webContents:contents}},w={tabs:[tab],activeTab:tab.id,vintedDraftController:null,ai:false};
 const adapter={current(id,context){if(context.signal?.aborted)throw Object.assign(Error('stopped'),{code:'STOPPED'});if(id!=='profile-1'||context.tab&&context.tab!==tab||w.activeTab!==tab.id)throw Object.assign(Error('tab changed'),{code:'TAB_CHANGED'});if(w.ai||w.vintedDraftController&&w.vintedDraftController!==context.controller)throw Object.assign(Error('busy'),{code:'PAGE_BUSY'});return {w,tab};},read:async()=>({url:currentURL,elements:[]}),control:{isolated:async()=>{calls.probes++;if(options.hang)return new Promise(()=>{});const result=clone(raw);options.onProbe?.(api,result,calls.probes);return result;},performAction:async()=>{calls.actions++;throw Error('Catalog cannot perform actions');}}};
 const accountReader={inspectAccount:async(_profileId,request)=>{calls.inspect++;assert.equal(request.closeMenu,true);assert.deepEqual(request.expectedAccount,account);options.onInspect?.(api);calls.state++;const value={documentKey:'1234',account:{memberId:account.memberId,username:account.username,profileURL:account.profileURL}};options.onState?.(api,value,calls.state);const result={verified:true,profileId:account.profileId,...value.account,documentKey:value.documentKey,usernameSource:'saved-binding',menuClosed:true,evidence:{association:'observed-account-menu'}};options.onReceipt?.(api,result,calls.inspect);return result;},state:async()=>assert.fail('Catalog must freshly inspect and close the account drawer')};

 const reader=new VintedCatalog(adapter,{accountReader,timeoutMs:options.timeoutMs||200,emptyStateLabels:[EMPTY]}),api={reader,raw,calls,w,tab,contents,setURL:value=>currentURL=value,inspect:opts=>reader.inspect('profile-1',{expectedAccount:account,title:TITLE,...opts}),collect:opts=>reader.collect('profile-1',{expectedAccount:account,title:TITLE,...opts})};return api;
}
test('inspect verifies the account then double reads the complete same-document wardrobe',async()=>{
 const f=readerFixture(),out=await f.inspect();assert.equal(out.complete,true);assert.equal(out.duplicate,true);assert.equal(out.consistentReads,2);assert.equal(f.calls.inspect,6);assert.equal(f.calls.probes,2);assert.equal(f.calls.actions,0);assert.equal(f.w.vintedDraftController,null);assert.equal(f.contents.listenerCount('did-start-navigation'),0);
});
test('collect freshly verifies and closes the account menu before reading the bound seller wardrobe',async()=>{
 const f=readerFixture(),out=await f.collect({title:'Other QA'});assert.equal(out.absent,true);assert.equal(f.calls.inspect,5);assert.equal(f.calls.actions,0);
 const absent=readerFixture({onState:(_api,value)=>{delete value.account;}});const denied=await absent.collect();assert.equal(denied.complete,false);assert.equal(denied.absent,false);assert.equal(absent.calls.inspect,1);
});
test('wrong profile and invalid bound identity stop before opening or reading any account menu',async()=>{
 for(const url of ['https://www.vinted.fr/member/999999','https://www.vinted.fr/items/654321','https://www.vinted.fr/member/123456?x=1','https://evil.invalid/member/123456']){const f=readerFixture({url}),out=await f.inspect();assert.equal(out.complete,false);assert.equal(out.absent,false);assert.equal(f.calls.inspect,0);assert.equal(f.calls.probes,0);}
 const f=readerFixture();assert.equal((await f.inspect({expectedAccount:{...account,profileId:'other'}})).complete,false);assert.equal(f.calls.inspect,0);
});
test('unstable item counts, document changes and account changes cannot confirm absence',async()=>{
 const mutations=[{onProbe:(_api,raw,count)=>{if(count===2)raw.countLabels=['2 articles'];}},
  {onProbe:(_api,raw,count)=>{if(count===2)raw.documentKey='changed';}},
  {onState:(_api,state,count)=>{if(count===3)state.account.memberId='999999';}},
  {onState:(_api,state,count)=>{if(count===3)state.account.username='renamed_seller';}},
  {onProbe:api=>api.setURL('https://www.vinted.fr/member/999999')}];
 for(const options of mutations){const f=readerFixture(options),out=await f.inspect({title:'Other QA'});assert.equal(out.complete,false);assert.equal(out.duplicate,null);assert.equal(out.absent,false);assert.equal(f.w.vintedDraftController,null);}
});
test('cancellation, navigation, AI takeover and stalled page reads leave no negative proof',async()=>{
 const controller=new AbortController();controller.abort();const cancelled=readerFixture();assert.equal((await cancelled.inspect({signal:controller.signal})).code,'STOPPED');assert.equal(cancelled.calls.inspect,0);
 const nav=readerFixture({onProbe:api=>api.contents.emit('did-start-navigation',{},PROFILE,true,true)});assert.equal((await nav.inspect()).absent,false);assert.equal(nav.w.vintedDraftController,null);assert.equal(nav.contents.listenerCount('destroyed'),0);
 const ai=readerFixture();ai.w.ai=true;assert.equal((await ai.inspect()).code,'PAGE_BUSY');assert.equal(ai.calls.inspect,0);
 const timeout=readerFixture({hang:true,timeoutMs:20});assert.equal((await timeout.inspect()).code,'CATALOG_TIMEOUT');assert.equal(timeout.w.vintedDraftController,null);
});
test('caller-owned locks are preserved and unrelated locks cannot be overwritten',async()=>{
 const shared=readerFixture(),controller=new AbortController();shared.w.vintedDraftController=controller;assert.equal((await shared.collect({controller,tab:shared.tab})).complete,true);assert.equal(shared.w.vintedDraftController,controller);assert.equal(controller.signal.aborted,false);
 const busy=readerFixture(),other=new AbortController();busy.w.vintedDraftController=other;assert.equal((await busy.inspect()).code,'PAGE_BUSY');assert.equal(busy.w.vintedDraftController,other);
});

function observedEmptyRaw(){const raw=rawFixture();Object.assign(raw,{countLabels:[],links:[],emptyState:{kind:'observed_own_wardrobe_empty',...OWN_EMPTY_WARDROBE,headingCount:1,subtitleCount:1,createLinkCount:1,selectedTabCount:1,sameRegion:true}});return raw;}

test('observed own mobile wardrobe empty screen proves zero without inventing an article-count heading',()=>{
 const f=domFixture({observedEmpty:true}),raw=f.run([]),result=surface(raw,{emptyStateLabels:[]});assert.deepEqual(raw.countLabels,[]);assert.deepEqual(raw.links,[]);assert.equal(raw.emptyState.heading,OWN_EMPTY_WARDROBE.heading);assert.equal(raw.emptyState.selectedTab,'Annonces');assert.equal(result.count,0);assert.equal(result.complete,true);assert.equal(result.absent,true);assert.equal(result.duplicate,false);assert.deepEqual(result.emptyState,raw.emptyState);
 f.empty.text=OWN_EMPTY_WARDROBE.subtitle.replaceAll(' ','\u00a0');assert.equal(surface(f.run([]),{emptyStateLabels:[]}).absent,true);
});

test('empty mobile wardrobe requires the exact unique visible heading, subtitle, create link and selected Annonces tab',()=>{
 const changes=[f=>f.heading.hidden=true,f=>f.empty.hidden=true,f=>f.createLink.hidden=true,f=>f.selectedTab.hidden=true,f=>f.heading.tagName='H2',f=>f.heading.text='Commence à vendre',f=>f.empty.text='Aucun article',f=>f.createLink.text='Vends maintenant',f=>{f.createLink.href='https://www.vinted.fr/items/new?draft=1';},f=>f.selectedTab.attrs['aria-selected']='false',f=>f.selectedTab.text='Évaluations',f=>f.node('h1',{},f.scope,OWN_EMPTY_WARDROBE.heading),f=>f.node('p',{},f.main,OWN_EMPTY_WARDROBE.subtitle),f=>f.node('a',{href:OWN_EMPTY_WARDROBE.createURL},f.scope,OWN_EMPTY_WARDROBE.createLabel),f=>f.node('button',{role:'tab','aria-selected':'true'},f.main,'À propos')];
 for(const change of changes){const f=domFixture({observedEmpty:true});change(f);const raw=f.run([]);assert.equal(surface(raw,{emptyStateLabels:[]}).absent,false,String(change));}
});

test('empty heading, subtitle and creation link must belong to one bounded region rather than distant page sections',()=>{
 for(const key of ['empty','createLink']){const f=domFixture({observedEmpty:true}),other=f.node('section',{},f.main);f[key].parent=other;assert.equal(surface(f.run([]),{emptyStateLabels:[]}).absent,false,key);}
 const f=domFixture({observedEmpty:true}),wrapped=f.node('div',{},f.scope);f.empty.parent=wrapped;assert.equal(surface(f.run([]),{emptyStateLabels:[]}).absent,true,'Nested text wrappers do not create fake duplicate subtitles');
});

test('visible real item links, conflicting article counts, loading, pagination, alerts, dialogs or challenges invalidate explicit emptiness',()=>{
 const changes=[f=>f.node('a',{href:'https://www.vinted.fr/items/654321','aria-label':LABEL},f.main),f=>f.node('h2',{},f.main,'1 article'),f=>f.node('h2',{},f.main,'0 articles'),f=>f.node('div',{'aria-busy':'true'},f.scope),f=>f.node('div',{role:'progressbar'},f.scope),f=>f.node('button',{},f.scope,'Charger plus'),f=>f.node('div',{role:'alert'},f.main,'Erreur de chargement'),f=>f.node('div',{role:'dialog'},f.main,'Vérification'),f=>f.node('iframe',{src:'https://challenges.cloudflare.com/'},f.main),f=>f.context.document.readyState='loading'];
 for(const change of changes){const f=domFixture({observedEmpty:true});change(f);assert.equal(surface(f.run([]),{emptyStateLabels:[]}).absent,false,String(change));}
});

test('catalog surface rejects incomplete or contradictory empty-state evidence even when its other flags are clean',()=>{
 const changes=[raw=>delete raw.emptyState.heading,raw=>raw.emptyState.subtitle+='!',raw=>raw.emptyState.createURL+='?draft=1',raw=>raw.emptyState.selectedTab='À propos',raw=>raw.emptyState.sameRegion=false,raw=>raw.emptyState.headingCount=2,raw=>raw.emptyState.subtitleCount=0,raw=>raw.emptyState.createLinkCount=2,raw=>raw.emptyState.selectedTabCount=0,raw=>raw.countLabels=['0 articles'],raw=>delete raw.countLabels,raw=>raw.links=[{href:'https://www.vinted.fr/items/654321',labels:[LABEL]}],raw=>raw.busy=true];
 for(const change of changes){const raw=observedEmptyRaw();change(raw);assert.equal(surface(raw,{emptyStateLabels:[]}).absent,false,String(change));}
 assert.equal(surface(observedEmptyRaw(),{emptyStateLabels:[]}).absent,true);
});

test('explicit empty wardrobe still requires two stable same-document reads under the verified own account',async()=>{
 const f=readerFixture();Object.assign(f.raw,observedEmptyRaw());let result=await f.inspect();assert.equal(result.absent,true);assert.equal(result.count,0);assert.equal(result.consistentReads,2);assert.equal(f.calls.inspect,6);assert.equal(f.calls.probes,2);assert.equal(f.calls.actions,0);assert.equal(f.w.vintedDraftController,null);
 const changed=readerFixture({onProbe:(_api,raw,count)=>{if(count===2)raw.emptyState.subtitle='Changed';}});Object.assign(changed.raw,observedEmptyRaw());result=await changed.inspect();assert.equal(result.absent,false);assert.equal(result.code,'CATALOG_PAGE_CHANGED');
 const wrong=readerFixture({onState:(_api,value)=>{value.account.memberId='999999';}});Object.assign(wrong.raw,observedEmptyRaw());result=await wrong.inspect();assert.equal(result.absent,false);assert.equal(wrong.calls.probes,0);
});

test('a menu left open before or after a wardrobe read cannot authorize an empty catalog',async()=>{
 for(const at of [1,4]){const f=readerFixture({onReceipt:(_api,receipt,count)=>{if(count===at)receipt.menuClosed=false;}});Object.assign(f.raw,observedEmptyRaw());const result=await f.inspect();assert.equal(result.complete,false);assert.equal(result.absent,false);assert.equal(result.code,'CATALOG_ACCOUNT_CHANGED');assert.equal(f.calls.probes,at===1?0:1);assert.equal(f.w.vintedDraftController,null);}
 const missing=readerFixture({onReceipt:(_api,receipt)=>{delete receipt.menuClosed;}});Object.assign(missing.raw,observedEmptyRaw());assert.equal((await missing.collect()).absent,false);assert.equal(missing.calls.probes,0);
});
