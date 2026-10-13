const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {VintedAdapter}=require('../src/vinted-adapter.cjs');
const {VintedAccount,memberURL}=require('../src/vinted-account.cjs');
const FORM='https://www.vinted.fr/items/new',PROFILE='https://www.vinted.fr/member/123456';

function fixture(options={}){
  let url=options.url||FORM,documentKey=1,version=0,menu=!!options.open,ids=new Map(),stateReads=0;
  const calls=[],contents=Object.assign(new EventEmitter(),{isDestroyed:()=>false,getURL:()=>url});
  const tab={id:'fixture-tab',view:{webContents:contents}},w={isDestroyed:()=>false,tabs:[tab],activeTab:tab.id,aiAgent:{state:{running:false}}};
  const api={calls,w,tab,setURL(v){url=v;},reload(){documentKey++;},setMenu(v){menu=v;},setUsername(v){options.username=v;}};
  const parents=e=>{const out=[];for(let p=e;p;p=p.parent)out.push(p);return out;};
  const matches=(e,selector)=>selector.split(',').some(part=>{if(part==='[role=navigation]')return e.attrs.role==='navigation';if(part==='a[href]')return e.tagName==='A'&&!!e.href;return e.tagName===part.toUpperCase();});
  const node=(tag,attrs={},parent=null,text='')=>{
    const e={tagName:tag.toUpperCase(),attrs,parent,children:[],isConnected:true,text,hidden:false,id:attrs.id||'',href:attrs.href||'',getAttribute:key=>attrs[key]??null,getBoundingClientRect:()=>({top:10,bottom:50,left:100,right:140,width:40,height:40}),contains(other){return parents(other).includes(this);},querySelectorAll(selector){const out=[];const visit=p=>{for(const child of p.children){if(matches(child,selector))out.push(child);visit(child);}};visit(this);return out;},querySelector(selector){return this.querySelectorAll(selector)[0]||null;}};
    parent?.children.push(e);return e;
  };
  let currentButtons=[];
  const snapshot=()=>{
    version++;ids=new Map();const body=node('body'),header=node('header',{},body),wrapper=node('div',{},header),elements=[];currentButtons=[];
    const register=(e,extra={})=>{const id='e'+version+'-'+elements.length;ids.set(id,e);elements.push({id,tag:e.tagName.toLowerCase(),label:e.text||'button',clickable:true,...extra});};
    const addAvatar=(parent,username)=>{const b=node('button',{id:'avatar'+currentButtons.length,...(options.expanded?{'aria-expanded':menu?'true':'false'}:{})},parent);node('img',{alt:username},b);currentButtons.push(b);register(b,{clickable:options.clickable!==false});return b;};
    const b=addAvatar(wrapper,options.username||'fixture_seller');
    if(options.duplicateButton)addAvatar(wrapper,'second_fixture_seller');
    if(options.bodyAvatar)addAvatar(body,'not_header_avatar');
    if(menu){
      const root=node('div',{id:'fixture-account-menu'},options.unrelated?body:wrapper);
      if(options.ariaOwned){root.parent.children=root.parent.children.filter(e=>e!==root);root.parent=body;body.children.push(root);b.attrs['aria-controls']=root.id;}
      const labels=options.partial?['Mon profil']:['Mon profil','Paramètres','Mes commandes','Se déconnecter'];
      for(const label of labels){const e=node(label==='Se déconnecter'?'button':'a',{...(label==='Mon profil'?{href:options.profileURL||PROFILE}:{href:'https://www.vinted.fr/settings'})},root,label);register(e,{label,...(e.tagName==='A'?{href:e.href}:{})});}
      if(options.duplicateProfile){const e=node('a',{href:'https://www.vinted.fr/member/654321'},root,'Mon profil');register(e,{label:'Mon profil',href:e.href});}
      if(options.foreignOutside){const e=node('a',{href:'https://www.vinted.fr/member/987654'},body,'Mon profil');register(e,{label:'Mon profil',href:e.href});}
    }
    return {url,title:'Fixture listing form',elements};
  };
  const control={
    checkedSnapshot:async()=>{options.beforeSnapshot?.(api);return snapshot();},
    isolated:async(_tab,expression)=>{
      if(expression.includes('probeAccountDOM')){stateReads++;options.beforeProbe?.(api,stateReads);if(options.hangRead)return new Promise(()=>{});}
      return vm.runInNewContext(expression,{globalThis:{__isolaElements:ids,__isolaDOM:{parents,closest:(e,selector)=>parents(e).find(p=>matches(p,selector))||null,visible:e=>!e.hidden,disabled:e=>!!e.attrs.disabled,safeText:e=>e.text||'',label:e=>e.text||'button'}},performance:{timeOrigin:documentKey},innerHeight:900,innerWidth:1200});
    },
    performAction:async(_tab,args,opts)=>{
      calls.push(args);options.beforeAction?.(api);await opts.onProgress?.();if(opts.signal.aborted)throw Object.assign(Error('stopped'),{code:'STOPPED'});
      const target=ids.get(args.elementId);assert.ok(currentButtons.includes(target),'only the observed avatar button can receive a click');assert.equal(args.action,'click');
      if(!options.noMenu)menu=true;return snapshot();
    }
  };
  api.adapter=new VintedAdapter({windows:new Map([['profile-1',w]]),control,isBusy:()=>!!options.busy});api.account=new VintedAccount(api.adapter,{menuWaitMs:15,pollIntervalMs:10,timeoutMs:options.timeoutMs||200});return api;
}

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
  const tab=fixture({beforeAction:api=>api.w.activeTab='different-tab'});await assert.rejects(tab.account.inspectAccount('profile-1'),{code:'STOPPED'});
  const ai=fixture({beforeAction:api=>api.w.aiAgent.state.running=true});await assert.rejects(ai.account.inspectAccount('profile-1'),{code:'STOPPED'});
});
test('main-frame navigation and cross-site redirects cannot yield stale account identity',async()=>{
  const nav=fixture({beforeAction:api=>api.tab.view.webContents.emit('did-start-navigation',{},FORM,false,true)});await assert.rejects(nav.account.inspectAccount('profile-1'),{code:'STOPPED'});
  const foreign=fixture({beforeAction:api=>api.setURL('https://evil.invalid/')});await assert.rejects(foreign.account.inspectAccount('profile-1'),{code:'STOPPED'});
  const reload=fixture({beforeProbe:(api,count)=>{if(count===2)api.reload();}});await assert.rejects(reload.account.inspectAccount('profile-1'),{code:'PAGE_CHANGED'});
});
test('account changes between the first and final read invalidate the receipt',async()=>{
  const f=fixture({open:true,beforeProbe:(api,count)=>{if(count===1)api.setUsername('changed_fixture_seller');}});await assert.rejects(f.account.inspectAccount('profile-1'),{code:'ACCOUNT_CHANGED'});
});
test('a stalled isolated read times out and frees only the owned lock',async()=>{const f=fixture({hangRead:true,timeoutMs:25});await assert.rejects(f.account.inspectAccount('profile-1'),{code:'ACCOUNT_TIMEOUT'});assert.equal(f.w.vintedDraftController,null);assert.equal(f.tab.view.webContents.listenerCount('destroyed'),0);});
