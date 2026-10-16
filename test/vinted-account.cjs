const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {VintedAdapter}=require('../src/vinted-adapter.cjs');
const {VintedAccount,memberURL,getClosedAccountEvidence,CLOSED_RECEIPT_MS}=require('../src/vinted-account.cjs');
const FORM='https://www.vinted.fr/items/new',PROFILE='https://www.vinted.fr/member/123456';

function fixture(options={}){
  let url=options.url||FORM,documentKey=1,version=0,menu=!!options.open,ids=new Map(),stateReads=0;
  const stableNodes=new Map(),isolatedGlobal={},observers=[];
  class FixtureObserver{constructor(callback){this.callback=callback;this.records=[];observers.push(this);}observe(){}disconnect(){this.records=[];}takeRecords(){return this.records.splice(0);}}
  const calls=[],contents=Object.assign(new EventEmitter(),{isDestroyed:()=>false,getURL:()=>url});
  const tab={id:'fixture-tab',view:{webContents:contents}},w={isDestroyed:()=>false,tabs:[tab],activeTab:tab.id,aiAgent:{state:{running:false}}};
  const api={calls,w,tab,setURL(v){url=v;},reload(){documentKey++;},setMenu(v){menu=v;},setUsername(v){options.username=v;},queueDiagnosticMutation(attribute){for(const observer of observers)observer.records.push({type:'attributes',target:currentButtons[0],attributeName:attribute},{type:'childList',target:currentButtons[0],addedNodes:[{nodeType:1,tagName:'PRIVATE-TAG-DO-NOT-LOG',children:[]}],removedNodes:[]});},replaceToggle(){const old=currentButtons[0];old.isConnected=false;stableNodes.delete(old.key);for(const observer of observers)observer.records.push({type:'childList',target:old.parent,addedNodes:[],removedNodes:[old]});},changeProfile(href,restore=false){const profile=[...stableNodes.values()].find(e=>['Mon profil','Profil'].includes(e.text)),original=profile.href;profile.href=profile.attrs.href=href;for(const observer of observers)observer.records.push({type:'attributes',target:profile,attributeName:'href'});if(restore)profile.href=profile.attrs.href=original;},invalidateMenu(){for(const observer of observers)observer.records.push({target:currentButtons[0]});},queueIconMutation(mode){
    const button=currentButtons[0],old=node('svg',{},button);node('path',{d:'M0 0L1 1'},old);const replacement=node(mode==='link'?'a':'svg',{},button);const path=node('path',{d:'M0 1L1 0'},replacement);const records=[{type:'childList',target:button,addedNodes:[replacement],removedNodes:[old]},{type:'attributes',target:path,attributeName:mode==='href'?'href':'d'},{type:'attributes',target:path,attributeName:'fill'}];
    if(mode==='nested-link')node('a',{href:'https://www.vinted.fr/member/999'},replacement);
    for(const observer of observers)observer.records.push(...records);
  }};
  const parents=e=>{const out=[];for(let p=e;p;p=p.parent)out.push(p);return out;};
  const matches=(e,selector)=>selector.split(',').some(part=>{if(part==='[role]')return !!e.attrs.role;const role=/^\[role=(\w+)\]$/.exec(part);if(role)return e.attrs.role===role[1];if(part==='a[href]')return e.tagName==='A'&&!!e.href;return e.tagName===part.toUpperCase();});
  const node=(tag,attrs={},parent=null,text='')=>{
    const key=attrs.id?'id:'+attrs.id:parent?parent.key+'/'+tag+':'+parent.children.length:'root:'+tag;let e=stableNodes.get(key);
    if(!e){e={key,nodeType:1,tagName:tag.toUpperCase(),getAttribute(key){return this.attrs[key]??null;},getBoundingClientRect:()=>({top:10,bottom:50,left:100,right:140,width:40,height:40}),contains(other){return parents(other).includes(this);},querySelectorAll(selector){const out=[];const visit=p=>{for(const child of p.children){if(selector==='*'||matches(child,selector))out.push(child);visit(child);}};visit(this);return out;},querySelector(selector){return this.querySelectorAll(selector)[0]||null;}};stableNodes.set(key,e);}
    if(!e.listeners){e.listeners=new Map();e.addEventListener=(type,fn)=>e.listeners.set(type,(e.listeners.get(type)||[]).concat(fn));e.removeEventListener=(type,fn)=>e.listeners.set(type,(e.listeners.get(type)||[]).filter(value=>value!==fn));}
    Object.assign(e,{attrs,parent,children:[],isConnected:true,text,hidden:false,id:attrs.id||'',href:attrs.href||''});parent?.children.push(e);return e;
  };
  let currentButtons=[],rootBody;
  const snapshot=()=>{
    version++;ids=new Map();const body=node('body'),header=node('header',{},body),wrapper=node('div',{},header),elements=[];currentButtons=[];rootBody=body;
    const register=(e,extra={})=>{const id='e'+version+'-'+elements.length;ids.set(id,e);elements.push({id,tag:e.tagName.toLowerCase(),role:e.attrs.role||'',label:e.text||'button',clickable:true,...extra});};
    const addAvatar=(parent,username)=>{const b=node('button',{id:'avatar'+currentButtons.length,...(options.mobile?{'aria-label':menu?'Menu fermé':'Menu ouvert'}:{}),...(options.expanded?{'aria-expanded':menu?'true':'false'}:{})},parent);if(!options.mobile)node('img',{alt:username},b);currentButtons.push(b);register(b,{clickable:options.clickable!==false});return b;};
    const b=addAvatar(wrapper,options.username||'fixture_seller');
    if(options.duplicateButton)addAvatar(wrapper,'second_fixture_seller');
    if(options.bodyAvatar)addAvatar(body,'not_header_avatar');
    if(options.mobile&&options.profileHeading!==false){const main=node('main',{},body),info=node('button',{},main,options.username||'fixture_seller');node('h1',{},info,options.username||'fixture_seller');node('h1',{},main,'Ajoute des articles pour commencer à vendre');if(options.duplicateHeading){const other=node('button',{},main,'other_seller');node('h1',{},other,'other_seller');}}
    if(menu||!options.absentDrawer){
      const root=node('div',{id:'fixture-account-menu',...(options.testId?{'data-testid':options.testId}:{})},options.unrelated?body:wrapper,options.mobile&&!options.missingAccountHeading?'Mon Compte':'');root.hidden=!menu;
      if(options.ariaOwned){root.parent.children=root.parent.children.filter(e=>e!==root);root.parent=body;body.children.push(root);b.attrs['aria-controls']=root.id;}
      const labels=options.partial?[options.profileLabel||'Mon profil']:[options.profileLabel||'Mon profil','Paramètres','Mes commandes','Se déconnecter'];
      if(options.duplicateLogout)labels.push('Se déconnecter');
      for(const label of labels){const logout=label==='Se déconnecter',profile=['Mon profil','Profil'].includes(label),e=node(logout?(options.logoutTag||'button'):'a',{...(logout&&options.logoutRole?{role:options.logoutRole}:{}),...(profile?{href:options.profileURL||PROFILE,...(options.profileTarget?{target:options.profileTarget}:{}),...(options.profileDownload?{download:''}:{})}:logout?{}:{href:options.mobile?(label==='Paramètres'?'https://www.vinted.fr/settings/profile':label==='Mes commandes'?'https://www.vinted.fr/my_orders':'https://www.vinted.fr/settings'):'https://www.vinted.fr/settings'})},root,label);if(menu&&!options.omitMenuSnapshot)register(e,{label,...(e.tagName==='A'?{href:e.href}:{})});}
      if(options.duplicateProfile){const e=node('a',{href:'https://www.vinted.fr/member/654321'},root,'Mon profil');register(e,{label:'Mon profil',href:e.href});}
      if(options.foreignOutside){const e=node('a',{href:'https://www.vinted.fr/member/987654'},body,'Mon profil');register(e,{label:'Mon profil',href:e.href});}
      if(menu&&options.duplicateDrawer){const other=node('div',{},body,'Mon Compte');for(const label of ['Mon profil','Paramètres','Mes commandes','Se déconnecter']){const logout=label==='Se déconnecter',e=node(logout?'div':'a',{...(logout?{role:'button'}:{href:label==='Mon profil'?PROFILE:label==='Paramètres'?'https://www.vinted.fr/settings/profile':'https://www.vinted.fr/my_orders'})},other,label);register(e,{label,...(!logout?{href:e.href}:{})});}}
    }
    return {url,title:'Fixture listing form',elements};
  };
  const control={
    checkedSnapshot:async()=>{options.beforeSnapshot?.(api);return snapshot();},
    isolated:async(_tab,expression)=>{
      if(!rootBody)snapshot();
      if(expression.includes('probeAccountDOM')){stateReads++;options.beforeProbe?.(api,stateReads);if(options.hangRead)return new Promise(()=>{});}
      Object.assign(isolatedGlobal,{__isolaElements:ids,__isolaDOM:{parents,closest:(e,selector)=>parents(e).find(p=>matches(p,selector))||null,visible:e=>parents(e).every(p=>!p.hidden),disabled:e=>!!e.attrs.disabled,safeText:e=>e.text||'',label:e=>e.attrs['aria-label']||e.text||'button'}});
      return vm.runInNewContext(expression,{globalThis:isolatedGlobal,URL,MutationObserver:FixtureObserver,performance:{timeOrigin:documentKey},location:{href:url},document:{readyState:'complete',documentElement:rootBody,querySelectorAll:selector=>rootBody.querySelectorAll(selector)},innerHeight:900,innerWidth:1200});
    },
    performAction:async(_tab,args,opts)=>{
      calls.push(args);options.beforeAction?.(api);await opts.onProgress?.();if(opts.signal.aborted)throw Object.assign(Error('stopped'),{code:'STOPPED'});
      const target=ids.get(args.elementId);assert.equal(args.action,'click');
      if(options.nativeProfileClicks&&target?.tagName==='A'&&['Mon profil','Profil'].includes(target.text)){
        const event={isTrusted:options.untrustedClick!==true,prevented:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){}};for(const fn of target.listeners.get('click')||[])fn(event);
        const start=(destination,sameDocument)=>options.navigationDetailsOnly?contents.emit('did-start-navigation',{url:destination,isSameDocument:sameDocument,isMainFrame:true}):contents.emit('did-start-navigation',{},destination,sameDocument,true);
        if(!event.prevented){const destination=options.clickURL||target.href;if(options.inPageOnly){url=destination;contents.emit('did-navigate-in-page',{},url,true);}else{start(destination,!!options.initialSameDocument);url=destination;if(!options.initialSameDocument)documentKey++;}if(options.canonicalRedirect){start(PROFILE,false);url=PROFILE;}for(const route of options.extraNavigations||[]){start(route.url,route.sameDocument);url=route.url;if(route.sameDocument)contents.emit('did-navigate-in-page',{},url,true);}}
        if(opts.signal.aborted)throw Object.assign(Error('stopped'),{code:'STOPPED'});return snapshot();
      }
      assert.ok(currentButtons.includes(target),'only the observed avatar button can receive a click');
      if(!options.noMenu&&(!options.noClose||!menu))menu=!menu;return snapshot();
    }
  };
  api.adapter=new VintedAdapter({windows:new Map([['profile-1',w]]),control,isBusy:()=>!!options.busy});api.account=new VintedAccount(api.adapter,{menuWaitMs:15,pollIntervalMs:10,timeoutMs:options.timeoutMs||200});return api;
}

test('native mobile profile candidate contains no identity authority and is validated once before navigation',async()=>{
 const f=fixture({mobile:true,url:'https://www.vinted.fr/',unrelated:true,profileHeading:false,logoutTag:'div',logoutRole:'button'}),candidate=await f.account.inspectOwnProfileLink('profile-1');
 assert.equal(candidate.verified,false);assert.equal(candidate.kind,'own-profile-candidate');assert.equal(candidate.memberId,'123456');assert.equal(candidate.profileURL,PROFILE);assert.equal(candidate.consistentReads,2);assert.equal(candidate.tabId,f.tab.id);assert.equal(Object.isFrozen(candidate),true);assert.equal(Object.hasOwn(candidate,'username'),false);assert.equal(Object.hasOwn(candidate,'guardToken'),false);assert.equal(f.calls.length,1);assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:candidate.documentKey}),null);
 assert.equal(await f.account.validateOwnProfileLink('profile-1',candidate),true);await assert.rejects(f.account.validateOwnProfileLink('profile-1',candidate),{code:'ACCOUNT_UNVERIFIED'});assert.equal(f.w.vintedDraftController,null);
});
test('profile candidates reject already-open, ambiguous, non-native and non-review pages without acquiring an identity',async()=>{
 for(const extra of [{open:true},{duplicateButton:true},{duplicateDrawer:true},{profileLabel:'Profil',duplicateProfile:true},{mobile:false},{url:FORM},{ariaOwned:true}]){
  const f=fixture({mobile:true,url:'https://www.vinted.fr/',unrelated:true,profileHeading:false,...extra});await assert.rejects(f.account.inspectOwnProfileLink('profile-1'));assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:'1'}),null);
 }
});
test('profile candidates preserve native menu continuity across both reads and reject transient member changes',async()=>{
 for(const restore of [false,true]){const f=fixture({mobile:true,url:'https://www.vinted.fr/',unrelated:true,profileHeading:false,beforeProbe:(api,count)=>{if(count===3)api.changeProfile('https://www.vinted.fr/member/999999',restore);}});await assert.rejects(f.account.inspectOwnProfileLink('profile-1'));assert.equal(f.calls.length,1);assert.equal(f.w.vintedDraftController,null);}
});
test('profile candidates cannot be forged, transferred, expired or consumed after their original menu changes',async()=>{
 for(const change of ['forged','profile','expired','tab','identity','navigation']){
  const f=fixture({mobile:true,url:'https://www.vinted.fr/',unrelated:true,profileHeading:false}),candidate=await f.account.inspectOwnProfileLink('profile-1');let value=candidate,id='profile-1',options={};
  if(change==='forged')value={...candidate};if(change==='profile')id='another-profile';if(change==='expired')options.now=candidate.expiresAt;if(change==='tab')f.w.activeTab='another-tab';if(change==='identity')f.changeProfile('https://www.vinted.fr/member/999999',true);if(change==='navigation')f.setURL(PROFILE);
  await assert.rejects(f.account.validateOwnProfileLink(id,value,options));assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:candidate.documentKey}),null);
 }
});
test('a mobile candidate follows only its original native Profil anchor once, including slug and SPA routes',async()=>{
 for(const [profileLabel,extra] of [['Mon profil',{}],['Profil',{profileURL:PROFILE+'-fixture',canonicalRedirect:true}],['Profil',{inPageOnly:true}]]){
  const f=fixture({mobile:true,url:'https://www.vinted.fr/',unrelated:true,profileHeading:false,nativeProfileClicks:true,profileLabel,...extra}),candidate=await f.account.inspectOwnProfileLink('profile-1');assert.equal(candidate.profileHref,extra.profileURL||PROFILE);
  const out=await f.account.clickOwnProfileLink('profile-1',candidate);assert.deepEqual(out,{profileId:'profile-1',tabId:f.tab.id,url:PROFILE});assert.equal(Object.hasOwn(out,'verified'),false);assert.equal(f.calls.length,2);assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:candidate.documentKey}),null);await assert.rejects(f.account.clickOwnProfileLink('profile-1',candidate));assert.equal(f.calls.length,2);assert.equal(f.w.vintedDraftController,null);
 }
});
test('canonical native profile clicks treat repeated same-address SPA state changes as one destination for both Electron event shapes',async()=>{
 for(const navigationDetailsOnly of [false,true]){
  const f=fixture({mobile:true,url:'https://www.vinted.fr/',unrelated:true,profileHeading:false,nativeProfileClicks:true,initialSameDocument:true,navigationDetailsOnly,extraNavigations:[{url:PROFILE,sameDocument:true},{url:PROFILE,sameDocument:true}]}),candidate=await f.account.inspectOwnProfileLink('profile-1');
  assert.equal(candidate.profileHref,PROFILE);assert.deepEqual(await f.account.clickOwnProfileLink('profile-1',candidate),{profileId:'profile-1',tabId:f.tab.id,url:PROFILE});assert.equal(f.calls.length,2);assert.equal(f.w.vintedDraftController,null);await assert.rejects(f.account.clickOwnProfileLink('profile-1',candidate),{code:'ACCOUNT_UNVERIFIED'});assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:candidate.documentKey}),null);
 }
});
test('same-address SPA compatibility cannot authorize another member, unknown address, URL change-and-back, or a repeated full navigation',async()=>{
 for(const navigationDetailsOnly of [false,true])for(const extraNavigations of [[{url:PROFILE,sameDocument:false}],[{url:PROFILE+'?unknown=1',sameDocument:true}],[{url:'https://www.vinted.fr/member/999999',sameDocument:true},{url:PROFILE,sameDocument:true}],[{url:'https://unrelated.invalid/member/123456',sameDocument:false}]]){
  const f=fixture({mobile:true,url:'https://www.vinted.fr/',unrelated:true,profileHeading:false,nativeProfileClicks:true,initialSameDocument:true,navigationDetailsOnly,extraNavigations}),candidate=await f.account.inspectOwnProfileLink('profile-1');await assert.rejects(f.account.clickOwnProfileLink('profile-1',candidate),{code:'PAGE_CHANGED'});assert.equal(f.calls.length,2);assert.equal(f.w.vintedDraftController,null);await assert.rejects(f.account.clickOwnProfileLink('profile-1',candidate),{code:'ACCOUNT_UNVERIFIED'});
 }
});
test('details-shaped subframe navigation cannot stop a mobile candidate or a strict account menu read',async()=>{
 const subframe=api=>api.tab.view.webContents.emit('did-start-navigation',{url:'https://subframe.invalid/',isMainFrame:false,isSameDocument:false});
 const candidateFixture=fixture({mobile:true,url:'https://www.vinted.fr/',unrelated:true,profileHeading:false,beforeAction:subframe}),candidate=await candidateFixture.account.inspectOwnProfileLink('profile-1');assert.equal(candidate.consistentReads,2);assert.equal(await candidateFixture.account.validateOwnProfileLink('profile-1',candidate),true);
 const accountFixture=fixture({beforeAction:subframe}),observed=await accountFixture.account.inspectAccount('profile-1',{closeMenu:true});assert.equal(observed.verified,true);assert.equal(observed.menuClosed,true);
});
test('bounded account cancellation preserves only safe typed causes without exposing arbitrary reason text',async()=>{
 for(const code of ['TAB_CHANGED','PAGE_BUSY','PAGE_CHANGED','WINDOW_CLOSED','PRIVATE_CODE']){
  const f=fixture(),controller=new AbortController(),reason=Object.assign(Error('PRIVATE_ACCOUNT_NAME https://private.invalid/member/123'),{code});
  await assert.rejects(f.account.bounded(()=>{controller.abort(reason);return new Promise(()=>{});},{controller,signal:controller.signal}),error=>{assert.equal(error.code,code==='PRIVATE_CODE'?'STOPPED':code);assert.equal(/PRIVATE_ACCOUNT_NAME|private\.invalid/.test(error.message),false);return true;});
 }
});
test('native profile clicks reject unknown targets, stale identity epochs, untrusted events and cancellation',async()=>{
 for(const extra of [{profileTarget:'_blank'},{profileDownload:true},{untrustedClick:true},{clickURL:'https://evil.invalid/member/123456'},{clickURL:'https://www.vinted.fr/member/999999'},{beforeAction:api=>{if(api.calls.length===2)api.changeProfile('https://www.vinted.fr/member/999999',true);}}]){
  const f=fixture({mobile:true,url:'https://www.vinted.fr/',unrelated:true,profileHeading:false,nativeProfileClicks:true,...extra}),candidate=await f.account.inspectOwnProfileLink('profile-1');await assert.rejects(f.account.clickOwnProfileLink('profile-1',candidate));assert.equal(f.w.vintedDraftController,null);assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:candidate.documentKey}),null);
 }
 const f=fixture({mobile:true,url:'https://www.vinted.fr/',unrelated:true,profileHeading:false,nativeProfileClicks:true}),candidate=await f.account.inspectOwnProfileLink('profile-1'),controller=new AbortController();controller.abort();await assert.rejects(f.account.clickOwnProfileLink('profile-1',candidate,{signal:controller.signal}),{code:'STOPPED'});assert.equal(f.calls.length,1);
});
test('explicit own-profile verification cannot borrow a stored mobile username when the profile heading is missing',async()=>{
 const f=fixture({mobile:true,url:PROFILE,profileHeading:false});await assert.rejects(f.account.inspectAccount('profile-1',{expectedAccount:{memberId:'123456',profileURL:PROFILE,username:'fixture_seller'},requireOwnProfileHeading:true,closeMenu:true}),{code:'ACCOUNT_UNVERIFIED'});assert.equal(f.calls.length,1);
});

test('opens only the account avatar once and obtains two consistent menu receipts',async()=>{
  const f=fixture();const out=await f.account.inspectAccount('profile-1');assert.equal(out.memberId,'123456');assert.equal(out.username,'fixture_seller');assert.equal(out.profileURL,PROFILE);assert.equal(out.verified,true);assert.equal(out.menuOpened,true);assert.equal(out.menuClosed,false);assert.equal(out.evidence.consistentReads,2);assert.equal(f.calls.length,1);assert.equal(f.calls[0].action,'click');assert.equal(f.w.vintedDraftController,null);assert.equal(f.tab.view.webContents.listenerCount('did-start-navigation'),0);assert.equal(f.adapter.readiness().capabilities.publish,false);
});
test('an existing expanded account menu is read without any action',async()=>{const f=fixture({open:true});const out=await f.account.inspectAccount('profile-1');assert.equal(out.menuOpened,false);assert.equal(f.calls.length,0);});
test('only observed header avatars count, so a body product avatar is ignored',async()=>{const f=fixture({bodyAvatar:true});assert.equal((await f.account.inspectAccount('profile-1')).memberId,'123456');assert.equal(f.calls.length,1);});
test('multiple visible header avatar buttons stop before any click',async()=>{const f=fixture({duplicateButton:true});await assert.rejects(f.account.inspectAccount('profile-1'),{code:'ACCOUNT_UNVERIFIED'});assert.equal(f.calls.length,0);});
test('a unrelated profile menu cannot prove current identity even after opening the avatar',async()=>{for(const open of [false,true]){const f=fixture({open,unrelated:true});await assert.rejects(f.account.inspectAccount('profile-1'),{code:'ACCOUNT_UNVERIFIED'});assert.equal(f.calls.length,open?0:1);}});
test('an explicitly aria-owned portal menu may be read without a shared header wrapper',async()=>{const f=fixture({open:true,ariaOwned:true});assert.equal((await f.account.inspectAccount('profile-1')).evidence.association,'aria');assert.equal(f.calls.length,0);});
test('two profile links inside the owned menu are ambiguous and neither is followed',async()=>{const f=fixture({open:true,duplicateProfile:true});await assert.rejects(f.account.inspectAccount('profile-1'),{code:'ACCOUNT_UNVERIFIED'});assert.equal(f.calls.length,0);});
test('another member link outside the proven menu never replaces its identity',async()=>{const f=fixture({open:true,foreignOutside:true});assert.equal((await f.account.inspectAccount('profile-1')).memberId,'123456');assert.equal(f.calls.length,0);});
test('partial or visibly expanded unknown menus are preserved without toggling',async()=>{for(const extra of [{open:true,partial:true},{open:true,partial:true,expanded:true}]){const f=fixture(extra);await assert.rejects(f.account.inspectAccount('profile-1'),{code:'ACCOUNT_UNVERIFIED'});assert.equal(f.calls.length,0);}});
test('missing menu receipt after the single click never causes a second click',async()=>{const f=fixture({noMenu:true});await assert.rejects(f.account.inspectAccount('profile-1'),{code:'ACCOUNT_UNVERIFIED'});assert.equal(f.calls.length,1);});
test('covered avatar fails without trying to click through the blocker',async()=>{const f=fixture({clickable:false});await assert.rejects(f.account.inspectAccount('profile-1'),{code:'ACCOUNT_UNVERIFIED'});assert.equal(f.calls.length,0);});
test('member URL must be an exact French origin profile without query or credentials',async()=>{
  for(const profileURL of ['https://www.vinted.fr.evil.test/member/123456','https://vinted.fr/member/123456','http://www.vinted.fr/member/123456','https://www.vinted.fr/member/123456?redirect=1','https://www.vinted.fr/member/123456#x','https://user@www.vinted.fr/member/123456','https://www.vinted.fr/member/0','https://www.vinted.fr/member/123456/items']){const f=fixture({open:true,profileURL});await assert.rejects(f.account.inspectAccount('profile-1'),{code:'ACCOUNT_UNVERIFIED'});assert.equal(f.calls.length,0);}
  assert.deepEqual(memberURL(PROFILE+'-fixture_seller'),{memberId:'123456',profileURL:PROFILE});
});
test('a foreign initial origin is rejected before reading or clicking',async()=>{const f=fixture({url:'https://evil.invalid/items/new'});await assert.rejects(f.account.inspectAccount('profile-1'),{code:'WRONG_SITE'});assert.equal(f.calls.length,0);});
test('AI, commerce tasks and another draft controller prevent account access',async()=>{
  const ai=fixture();ai.w.aiAgent.state.running=true;await assert.rejects(ai.account.inspectAccount('profile-1'),{code:'PAGE_BUSY'});
  const busy=fixture({busy:true});await assert.rejects(busy.account.inspectAccount('profile-1'),{code:'PAGE_BUSY'});
  const draft=fixture();const controller=new AbortController();draft.w.vintedDraftController=controller;await assert.rejects(draft.account.inspectAccount('profile-1'),{code:'PAGE_BUSY'});assert.equal(draft.w.vintedDraftController,controller);
  assert.equal(ai.calls.length+busy.calls.length+draft.calls.length,0);
});
test('a caller-owned shared controller remains locked after successful account read',async()=>{const f=fixture({open:true}),controller=new AbortController();f.w.vintedDraftController=controller;await f.account.inspectAccount('profile-1',{controller,tab:f.tab});assert.equal(f.w.vintedDraftController,controller);assert.equal(controller.signal.aborted,false);});
test('pre-cancellation prevents all access, and cancellation during click releases the lock',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(f.account.inspectAccount('profile-1',{signal:controller.signal}),{code:'STOPPED'});assert.equal(f.calls.length,0);
  const active=fixture({beforeAction:api=>api.w.vintedDraftController.abort()});await assert.rejects(active.account.inspectAccount('profile-1'),{code:'STOPPED'});assert.equal(active.w.vintedDraftController,null);
});
test('tab switching or AI takeover during the click stops before dispatch',async()=>{
  const tab=fixture({beforeAction:api=>api.w.activeTab='different-tab'});await assert.rejects(tab.account.inspectAccount('profile-1'),{code:'WINDOW_CLOSED'});
  const ai=fixture({beforeAction:api=>api.w.aiAgent.state.running=true});await assert.rejects(ai.account.inspectAccount('profile-1'),{code:'PAGE_BUSY'});
});
test('main-frame navigation and cross-site redirects cannot yield stale account identity',async()=>{
  const nav=fixture({beforeAction:api=>api.tab.view.webContents.emit('did-start-navigation',{},FORM,false,true)});await assert.rejects(nav.account.inspectAccount('profile-1'),{code:'PAGE_CHANGED'});
  const foreign=fixture({beforeAction:api=>api.setURL('https://evil.invalid/')});await assert.rejects(foreign.account.inspectAccount('profile-1'),{code:'WRONG_SITE'});
  const reload=fixture({beforeProbe:(api,count)=>{if(count===2)api.reload();}});await assert.rejects(reload.account.inspectAccount('profile-1'),{code:'PAGE_CHANGED'});
});
test('account changes between the first and final read invalidate the receipt',async()=>{
  const f=fixture({open:true,beforeProbe:(api,count)=>{if(count===1)api.setUsername('changed_fixture_seller');}});await assert.rejects(f.account.inspectAccount('profile-1'),{code:'ACCOUNT_CHANGED'});
});
test('a stalled isolated read times out and frees only the owned lock',async()=>{const f=fixture({hangRead:true,timeoutMs:25});await assert.rejects(f.account.inspectAccount('profile-1'),{code:'ACCOUNT_TIMEOUT'});assert.equal(f.w.vintedDraftController,null);assert.equal(f.tab.view.webContents.listenerCount('destroyed'),0);});

const expectedAccount={profileId:'profile-1',memberId:'123456',profileURL:PROFILE,username:'fixture_seller'};
test('mobile account menu derives current member from Mon profil and own-profile username from the information button heading',async()=>{
 const f=fixture({mobile:true,url:PROFILE}),out=await f.account.inspectAccount('profile-1',{closeMenu:true});assert.equal(out.memberId,'123456');assert.equal(out.username,'fixture_seller');assert.equal(out.usernameSource,'own-profile-heading');assert.equal(out.menuClosed,true);assert.equal(out.evidence.association,'mobile-header-navigation');assert.equal(f.calls.length,2);
 const receipt=getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:out.documentKey});assert.equal(Object.isFrozen(receipt),true);assert.equal(receipt.memberId,'123456');assert.equal(receipt.usernameSource,'own-profile-heading');
 const controller=new AbortController(),state=await f.account.state('profile-1',{controller,signal:controller.signal,tab:f.tab});assert.equal(state.closedMenu,true);assert.equal(state.account.memberId,'123456');assert.equal(f.calls.length,2);
});
test('mobile publishing pages use saved username only after freshly reading the same bound member ID',async()=>{
 const f=fixture({mobile:true,url:FORM}),out=await f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true});assert.equal(out.usernameSource,'saved-binding');assert.equal(out.memberId,'123456');assert.equal(out.menuClosed,true);assert.equal(f.calls.length,2);
 for(const account of [{...expectedAccount,memberId:'999'}, {...expectedAccount,profileURL:'https://www.vinted.fr/member/999'}]){const other=fixture({mobile:true});await assert.rejects(other.account.inspectAccount('profile-1',{expectedAccount:account,closeMenu:true}));assert.equal(getClosedAccountEvidence(other.adapter,{profileId:'profile-1',tab:other.tab,documentKey:'1'}),null);}
});
test('mobile page seller headings, missing account section and preexisting unrelated menus do not prove a logged-in account',async()=>{
 for(const options of [{url:'https://www.vinted.fr/member/999'},{profileHeading:false,url:PROFILE},{duplicateHeading:true,url:PROFILE},{missingAccountHeading:true,url:PROFILE},{unrelated:true,open:true,url:PROFILE}]){const f=fixture({mobile:true,...options});await assert.rejects(f.account.inspectAccount('profile-1',{closeMenu:true}),{code:'ACCOUNT_UNVERIFIED'});assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:'1'}),null);}
});
test('an owned mobile portal still needs all official menu links and exact current profile identity',async()=>{
 const f=fixture({mobile:true,url:PROFILE,ariaOwned:true}),out=await f.account.inspectAccount('profile-1',{closeMenu:true});assert.equal(out.memberId,'123456');assert.equal(out.evidence.association,'aria');assert.equal(out.menuClosed,true);
});
test('closed account receipts expire without extension and cannot be transferred to another adapter, profile, tab or document',async()=>{
 const f=fixture({mobile:true,url:FORM}),out=await f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true}),args={profileId:'profile-1',tab:f.tab,documentKey:out.documentKey},receipt=getClosedAccountEvidence(f.adapter,args);
 assert.ok(receipt);assert.equal(receipt.expiresAt-receipt.createdAt,CLOSED_RECEIPT_MS);assert.equal(getClosedAccountEvidence(f.adapter,{...args,now:receipt.expiresAt}),null);assert.equal(getClosedAccountEvidence(f.adapter,{...args,profileId:'profile-2'}),null);assert.equal(getClosedAccountEvidence(f.adapter,{...args,tab:{...f.tab}}),null);assert.equal(getClosedAccountEvidence(f.adapter,{...args,documentKey:'2'}),null);assert.equal(getClosedAccountEvidence(fixture().adapter,args),null);
 const controller=new AbortController();await f.account.state('profile-1',{controller,signal:controller.signal,tab:f.tab});assert.equal(getClosedAccountEvidence(f.adapter,args),receipt);f.setURL('https://evil.invalid');assert.equal(getClosedAccountEvidence(f.adapter,args),null);
});
test('an unclosed menu never issues a closed account receipt and a later inspection replaces its prior receipt',async()=>{
 const f=fixture({mobile:true,url:FORM,noClose:true});await assert.rejects(f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true}),{code:'ACCOUNT_UNVERIFIED'});assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:'1'}),null);
 const g=fixture({mobile:true,url:FORM}),first=await g.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true}),args={profileId:'profile-1',tab:g.tab,documentKey:first.documentKey},receipt=getClosedAccountEvidence(g.adapter,args);await g.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true});assert.notEqual(getClosedAccountEvidence(g.adapter,args),receipt);assert.equal(g.calls.length,4);
});
test('desktop menus can also close natively with an exact account receipt',async()=>{
 const f=fixture({expanded:true}),out=await f.account.inspectAccount('profile-1',{closeMenu:true});assert.equal(out.usernameSource,'avatar');assert.equal(out.menuClosed,true);assert.equal(f.calls.length,2);const controller=new AbortController(),state=await f.account.state('profile-1',{controller,signal:controller.signal,tab:f.tab});assert.equal(state.closedMenu,true);assert.equal(state.account.usernameSource,'avatar');
});

test('a menu mutation epoch is permanent even if the menu is already closed again when inspected',async()=>{
 const f=fixture({mobile:true,url:FORM});await f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true});f.invalidateMenu();
 const controller=new AbortController(),context={controller,signal:controller.signal,tab:f.tab};assert.equal((await f.account.state('profile-1',context)).account,undefined);assert.equal((await f.account.state('profile-1',context)).account,undefined);
 await f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true});assert.equal((await f.account.state('profile-1',context)).closedMenu,true);
});
test('same-document route changes cannot transfer a closed menu identity to another page',async()=>{
 const f=fixture({mobile:true,url:FORM}),out=await f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true});f.setURL(PROFILE);assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:out.documentKey}),null);
});

test('native menu closure permits only visual SVG replacement and geometry changes inside the original toggle',async()=>{
 const f=fixture({mobile:true,url:FORM,beforeAction:api=>{if(api.calls.length===2)api.queueIconMutation('visual');}}),out=await f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true});assert.equal(out.menuClosed,true);assert.equal(f.calls.length,2);assert.ok(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:out.documentKey}));
});
test('native menu closure cannot disguise links or href changes as a visual icon replacement',async()=>{
 for(const mode of ['link','nested-link','href']){const f=fixture({mobile:true,url:FORM,beforeAction:api=>{if(api.calls.length===2)api.queueIconMutation(mode);}});await assert.rejects(f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true}),{code:'ACCOUNT_UNVERIFIED'});assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:'1'}),null);}
});

test('failed mobile menu diagnostics expose fixed-label counts and structure without names, URLs or test IDs',async()=>{
 const secret='private_fixture_identity',profileURL=PROFILE+'-'+secret,f=fixture({mobile:true,url:PROFILE,username:secret,profileURL,missingAccountHeading:true,testId:'private-test-39817-'+secret});
 await assert.rejects(f.account.inspectAccount('profile-1',{closeMenu:true}),error=>{
  assert.equal(error.code,'ACCOUNT_UNVERIFIED');assert.ok(error.message.length<=400);assert.match(error.message,/菜单诊断：按钮1\(手机开\)/);assert.match(error.message,/标签快照1\/1\/1\/1→可见1\/1\/1\/1/);assert.match(error.message,/DOM1\/1\/1\/1/);assert.match(error.message,/DIV\/\-\[t\]:1\/1\/1\/1账0/);assert.match(error.message,/结构0/);
  for(const value of [secret,profileURL,'39817','private-test','https://',PROFILE])assert.equal(error.message.includes(value),false,value);return true;
 });assert.equal(f.calls.length,1);assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:'1'}),null);
});

test('diagnostic-only DOM matches reveal snapshot omissions but never authorize a menu receipt',async()=>{
 const f=fixture({mobile:true,url:PROFILE,omitMenuSnapshot:true});
 await assert.rejects(f.account.inspectAccount('profile-1',{closeMenu:true}),error=>{
  assert.equal(error.code,'ACCOUNT_UNVERIFIED');assert.match(error.message,/打开账号菜单后没有取得/);assert.match(error.message,/标签快照0\/0\/0\/0→可见0\/0\/0\/0/);assert.match(error.message,/DOM1\/1\/1\/1/);assert.match(error.message,/主页候选1\(DOM\)/);assert.ok(error.message.length<=400);assert.doesNotMatch(error.message,/fixture_seller|123456|https:/);return true;
 });assert.equal(f.calls.length,1);assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:'1'}),null);
});

test('a missing menu reports zero structural matches after the single attempted open',async()=>{
 const f=fixture({noMenu:true});await assert.rejects(f.account.inspectAccount('profile-1'),error=>{assert.match(error.message,/标签快照0\/0\/0\/0→可见0\/0\/0\/0/);assert.match(error.message,/DOM0\/0\/0\/0/);assert.ok(error.message.length<=400);return true;});assert.equal(f.calls.length,1);
});

test('owned mobile menus accept semantic logout buttons but only click the original menu toggle',async()=>{
 for(const options of [{logoutTag:'div'},{logoutTag:'span',ariaOwned:true}]){
  const f=fixture({mobile:true,url:FORM,logoutRole:'button',...options}),out=await f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true});
  assert.equal(out.memberId,'123456');assert.equal(out.usernameSource,'saved-binding');assert.equal(out.menuClosed,true);assert.equal(f.calls.length,2);
  const controller=new AbortController(),state=await f.account.state('profile-1',{controller,signal:controller.signal,tab:f.tab});assert.equal(state.closedMenu,true);
 }
});

test('semantic logout buttons do not establish ownership for a preexisting unrelated mobile drawer',async()=>{
 const f=fixture({mobile:true,url:FORM,logoutTag:'div',logoutRole:'button',unrelated:true,open:true});
 await assert.rejects(f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true}),error=>{
  assert.equal(error.code,'ACCOUNT_UNVERIFIED');assert.match(error.message,/标签快照1\/1\/1\/1→可见1\/1\/1\/1/);assert.match(error.message,/DOM1\/1\/1\/1/);assert.match(error.message,/退出候选DIV\/button/);assert.match(error.message,/归属aria0\/局部0\/导航0\/结构1/);assert.ok(error.message.length<=400);assert.doesNotMatch(error.message,/fixture_seller|123456|https:/);return true;
 });assert.equal(f.calls.length,0);assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:'1'}),null);
});

test('only the original native mobile toggle can attribute a newly visible independent account drawer',async()=>{
 for(const absentDrawer of [false,true]){
  const f=fixture({mobile:true,url:FORM,unrelated:true,absentDrawer,logoutTag:'div',logoutRole:'button'}),out=await f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true});
  assert.equal(out.memberId,'123456');assert.equal(out.evidence.association,'mobile-native-toggle-drawer');assert.equal(out.evidence.consistentReads,2);assert.equal(out.menuClosed,true);assert.equal(f.calls.length,2);
  const controller=new AbortController(),context={controller,signal:controller.signal,tab:f.tab},state=await f.account.state('profile-1',context);assert.equal(state.closedMenu,true);assert.equal(state.account.association,'mobile-native-toggle-drawer');
 }
});

test('native drawer evidence cannot survive a toggle replacement or duplicate independent drawers',async()=>{
 let replaced=false;const original=fixture({mobile:true,url:FORM,unrelated:true,beforeSnapshot:api=>{if(api.calls.length===1&&!replaced){replaced=true;api.replaceToggle();}}});
 const duplicate=fixture({mobile:true,url:FORM,unrelated:true,duplicateDrawer:true});
 for(const f of [original,duplicate]){await assert.rejects(f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true}),{code:'ACCOUNT_UNVERIFIED'});assert.equal(f.calls.length,1);assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:'1'}),null);}
});

test('native drawer identity links cannot change between reads or transiently change back',async()=>{
 for(const [read,restore] of [[2,true],[3,false],[3,true]]){
  const f=fixture({mobile:true,url:FORM,unrelated:true,beforeProbe:(api,count)=>{if(count===read)api.changeProfile('https://www.vinted.fr/member/999',restore);}});
  await assert.rejects(f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true}),{code:'ACCOUNT_UNVERIFIED'});assert.equal(f.calls.length,1);assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:'1'}),null);
 }
});

test('untyped or other-role logout elements cannot complete a mobile account menu',async()=>{
 for(const logoutRole of ['', 'menuitem']){
  const f=fixture({mobile:true,url:FORM,logoutTag:'div',logoutRole});
  await assert.rejects(f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true}),error=>{assert.equal(error.code,'ACCOUNT_UNVERIFIED');assert.match(error.message,/标签快照1\/1\/1\/0→可见1\/1\/1\/0/);if(logoutRole)assert.match(error.message,/退出候选DIV\/menuitem/);return true;});assert.equal(f.calls.length,1);
 }
});

test('multiple semantic logout buttons remain ambiguous and cannot yield a receipt',async()=>{
 const f=fixture({mobile:true,url:FORM,logoutTag:'div',logoutRole:'button',duplicateLogout:true});
 await assert.rejects(f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true}),error=>{assert.equal(error.code,'ACCOUNT_UNVERIFIED');assert.match(error.message,/标签快照1\/1\/1\/2→可见1\/1\/1\/2/);assert.match(error.message,/退出候选DIV\/button,DIV\/button/);return true;});assert.equal(f.calls.length,1);assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:'1'}),null);
});

test('failed closure reports bounded structural mutation diagnostics without private names, links or attribute names',async()=>{
 const secret='private_attr_61581',f=fixture({mobile:true,url:FORM,unrelated:true,username:secret,beforeAction:api=>{if(api.calls.length===2)api.queueDiagnosticMutation('data-'+secret);}});
 await assert.rejects(f.account.inspectAccount('profile-1',{expectedAccount:{...expectedAccount,username:secret},closeMenu:true}),error=>{
  assert.equal(error.code,'ACCOUNT_UNVERIFIED');assert.ok(error.message.length<=400);assert.match(error.message,/关闭诊断：因mutation/);assert.match(error.message,/守卫1\/令1\/期1\/效1\/文1\/址1/);assert.match(error.message,/原钮1\/顶1\/映1\/链1/);assert.match(error.message,/变2拒2\[attributes:BUTTON:data-\*/);assert.match(error.message,/childList:BUTTON:-\+OTHER/);assert.match(error.message,/回关1\/效1\/钮1\/项0\/手机\/文1\/址1/);
  for(const value of [secret,'61581','PRIVATE-TAG','https:','123456','guardToken','fixture-tab'])assert.equal(error.message.includes(value),false,value);return true;
 });assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:'1'}),null);assert.equal(f.calls.length,2);
});

test('a menu still visible after native close reports the closed probe counts and issues no receipt',async()=>{
 const f=fixture({mobile:true,url:FORM,unrelated:true,noClose:true});
 await assert.rejects(f.account.inspectAccount('profile-1',{expectedAccount,closeMenu:true}),error=>{assert.equal(error.code,'ACCOUNT_UNVERIFIED');assert.match(error.message,/关闭诊断：因closed-probe/);assert.match(error.message,/回关0\/效1\/钮1\/项4\/手机\/文1\/址1/);assert.doesNotMatch(error.message,/123456|fixture_seller|https:/);return true;});
 assert.equal(f.calls.length,2);assert.equal(getClosedAccountEvidence(f.adapter,{profileId:'profile-1',tab:f.tab,documentKey:'1'}),null);
});
