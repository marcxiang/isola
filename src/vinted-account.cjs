const {problem}=require('./commerce-engine.cjs');
const {randomUUID}=require('node:crypto');
const ORIGIN='https://www.vinted.fr';
const MENU_LABELS=['Mon profil','Profil','Paramètres','Mes commandes','Se déconnecter'];
const closedReceipts=new WeakMap(),CLOSED_RECEIPT_MS=30000;
const profileCandidates=new WeakMap(),PROFILE_CANDIDATE_MS=30000;
const receiptKey=(profileId,tab)=>profileId+'\0'+tab.id;
const norm=value=>String(value||'').replace(/\s+/g,' ').trim();
const stopped=()=>problem('STOPPED','账号核验已停止');

// Failure-only structural diagnostics: never include account names, hrefs,
// page text, native IDs or data-testid values in operator-visible errors.
function accountFailure(message,state){
 const value=state?.diagnostic;if(!value)return problem('ACCOUNT_UNVERIFIED',message);
 const count=value=>Number.isSafeInteger(value)&&value>=0?Math.min(value,999):0;
 const counts=value=>Array.isArray(value)?value.slice(0,4).map(count).join('/'):'—';
 const buttons=Array.isArray(value.buttons)?value.buttons.slice(0,2).map(row=>(row.kind==='mobile-menu'?'手机':row.kind==='avatar'?'头像':'其他')+(row.expanded==='true'?'开':row.expanded==='false'?'关':'?')).join(','):'—';
 const logout=Array.isArray(value.logoutCandidates)?value.logoutCandidates.slice(0,3).map(row=>`${['A','BUTTON','DIV','SPAN','LI'].includes(row.tag)?row.tag:'OTHER'}/${['button','link','menuitem'].includes(row.role)?row.role:'-'}`).join(','):'—';
 const ancestors=Array.isArray(value.ancestors)?value.ancestors.slice(0,6).map(row=>`${['A','BUTTON','DIV','LI','UL','HEADER','NAV','MAIN','FORM','SECTION','ASIDE','BODY','HTML'].includes(row.tag)?row.tag:'OTHER'}/${['navigation','menu','dialog','group','region','list','listitem'].includes(row.role)?row.role:'-'}${row.testId?'[t]':''}:${counts(row.rows)}账${row.accountHeading===true?1:0}`).join('>'):'—';
 const flags=value.ownership?`；归属aria${+!!value.ownership.aria}/局部${+!!value.ownership.local}/导航${+!!value.ownership.navigation}/结构${+!!value.ownership.structure}`:'';
 const summary=`菜单诊断：按钮${count(value.buttonCount)}(${buttons})；标签快照${counts(value.snapshotCounts)}→可见${counts(value.visibleCounts)}，含词${counts(value.containsCounts)}，DOM${counts(value.domCounts)}；退出候选${logout}；主页候选${count(value.profileCandidates)}(${value.candidateSource==='document'?'DOM':'快照'})${flags}；祖先${ancestors}`;
 return problem('ACCOUNT_UNVERIFIED',message+'。'+summary.slice(0,Math.max(0,399-message.length)));
}

function closedAccountFailure(message,state){
 const value=state?.diagnostic;if(!value)return problem('ACCOUNT_UNVERIFIED',message);
 const count=value=>Number.isSafeInteger(value)&&value>=0?Math.min(value,999):0,flag=value=>value===true?'1':'0';
 const reasons=new Set(['missing-guard','guard-token','guard-phase','guard-invalid','document','page-url','original-node','identity','mutation','closed-probe']);
 const tags=new Set(['A','BUTTON','DIV','SPAN','LI','UL','HEADER','NAV','MAIN','FORM','SECTION','ASIDE','BODY','HTML','SVG','G','PATH','CIRCLE','RECT','LINE','POLYLINE','POLYGON','ELLIPSE','TEXT','OTHER']);
 const attrs=new Set(['aria-label','aria-expanded','class','style','hidden','aria-hidden','data-state','data-testid','data-visible','data-expanded','inert','tabindex','role','href','aria-controls','aria-labelledby','d','fill','stroke','stroke-width','viewBox','data-*','OTHER','-']);
 const mutations=Array.isArray(value.mutations)?value.mutations.slice(0,3).map(row=>`${['attributes','childList','characterData'].includes(row.type)?row.type:'OTHER'}:${tags.has(row.tag)?row.tag:'OTHER'}:${attrs.has(row.attribute)?row.attribute:'OTHER'}+${Array.isArray(row.added)?row.added.slice(0,3).map(tag=>tags.has(tag)?tag:'OTHER').join('/'):'-'}-${Array.isArray(row.removed)?row.removed.slice(0,3).map(tag=>tags.has(tag)?tag:'OTHER').join('/'):'-'}`).join(','):'—';
 const probe=value.probe||{},kind=probe.toggleKind==='mobile-menu'?'手机':probe.toggleKind==='avatar'?'头像':'其他';
 const summary=`关闭诊断：因${reasons.has(value.reason)?value.reason:'OTHER'}；守卫${flag(value.guardExists)}/令${flag(value.tokenMatch)}/期${flag(value.phaseClosing)}/效${flag(value.guardValid)}/文${flag(value.documentMatch)}/址${flag(value.urlMatch)}；原钮${flag(value.buttonConnected)}/顶${flag(value.headerConnected)}/映${flag(value.buttonMapped)}/链${flag(value.profileHrefMatch)}；变${count(value.pendingCount)}拒${count(value.rejectedCount)}[${mutations}]；回关${flag(probe.closed)}/效${flag(probe.guardValid)}/钮${count(probe.buttonCount)}/项${count(probe.menuParts)}/${kind}/文${flag(probe.documentMatch)}/址${flag(probe.urlMatch)}`;
 return problem('ACCOUNT_UNVERIFIED',message+'。'+summary.slice(0,Math.max(0,399-message.length)));
}

function memberURL(value){
  let url;try{url=new URL(value);}catch{throw problem('ACCOUNT_UNVERIFIED','账号菜单的个人主页地址无效');}
  const match=/^\/member\/([1-9]\d*)(?:-[^/]+)?\/?$/.exec(url.pathname);
  if(url.origin!==ORIGIN||url.username||url.password||url.search||url.hash||!match)throw problem('ACCOUNT_UNVERIFIED','账号菜单的个人主页地址不属于法国 Vinted');
  return {memberId:match[1],profileURL:ORIGIN+'/member/'+match[1]};
}

function probeOwnProfileSurface(){
 const d=globalThis.__isolaDOM,visible=e=>!!e?.isConnected&&d.visible(e),clean=value=>String(value||'').replace(/\s+/g,' ').trim();
 const challenge=[...document.querySelectorAll('input')].some(e=>e.getAttribute('autocomplete')==='one-time-code')||[...document.querySelectorAll('iframe')].some(e=>visible(e)&&/captcha|challenge|verification/i.test((e.src||'')+' '+(e.title||'')))||[...document.querySelectorAll('h1,h2,[role=alert]')].filter(visible).some(e=>/captcha|vérifi(?:e|er|cation)|verification|two.factor|code de sécurité|security code|compte (?:bloqué|suspendu)|account (?:blocked|suspended)/i.test(clean(d.safeText(e,300))));
 return {documentKey:String(performance.timeOrigin),url:String(location.href),ready:document.readyState==='complete',challenge};
}

// Read only nodes from the current trusted snapshot, plus their descendants and
// ancestors. A random profile link elsewhere in the document proves no account.
function probeAccountDOM(buttonIds,menuIds,nativeDrawerToken=''){
  const d=globalThis.__isolaDOM,map=globalThis.__isolaElements,clean=v=>String(v||'').replace(/\s+/g,' ').trim();
  const visible=e=>!!e?.isConnected&&d.visible(e),menuLabel=e=>{const label=clean(d.label(e));return label==='Profil'?'Mon profil':label;};
  const broad=e=>!e||['HTML','BODY','HEADER','NAV','MAIN','FORM'].includes(e.tagName)||['navigation','main'].includes(e.getAttribute?.('role'));
  const nodes=menuIds.map(item=>({...item,node:map?.get(item.id)})).filter(item=>visible(item.node)&&clean(d.label(item.node))===item.label&&(['A','BUTTON'].includes(item.node.tagName)||item.label==='Se déconnecter'&&item.node.getAttribute('role')==='button')).map(item=>({...item,label:item.label==='Profil'?'Mon profil':item.label}));
  const fixedLabels=['Mon profil','Paramètres','Mes commandes','Se déconnecter'];
  const snapshotNodes=[...(map||new Map()).values()].filter(e=>(['A','BUTTON'].includes(e?.tagName)||e?.getAttribute?.('role')==='button')&&visible(e));
  const documentNodes=typeof document==='object'?[...document.querySelectorAll('a,button,[role=button]')].filter(visible):[],snapshotProfiles=snapshotNodes.filter(e=>menuLabel(e).includes('Mon profil'));
  // Broader DOM candidates are diagnostic-only; verification below continues
  // to use exactly the original trusted snapshot nodes and ownership rules.
  const profileCandidates=snapshotProfiles.length?snapshotProfiles:documentNodes.filter(e=>menuLabel(e).includes('Mon profil'));
  const structuralTags=new Set(['A','BUTTON','DIV','LI','UL','HEADER','NAV','MAIN','FORM','SECTION','ASIDE','BODY','HTML']),roles=new Set(['navigation','menu','dialog','group','region','list','listitem']);
  const diagnostic={snapshotCounts:fixedLabels.map(label=>menuIds.filter(row=>row.label===label).length),visibleCounts:fixedLabels.map(label=>nodes.filter(row=>row.label===label).length),containsCounts:fixedLabels.map(label=>snapshotNodes.filter(e=>clean(d.label(e)).includes(label)).length),domCounts:fixedLabels.map(label=>documentNodes.filter(e=>clean(d.label(e))===label).length),profileCandidates:profileCandidates.length,candidateSource:snapshotProfiles.length?'snapshot':'document',ancestors:profileCandidates[0]?d.parents(profileCandidates[0]).slice(1,7).map(parent=>({tag:structuralTags.has(parent.tagName)?parent.tagName:'OTHER',role:roles.has(parent.getAttribute?.('role'))?parent.getAttribute('role'):'-',testId:!!parent.getAttribute?.('data-testid'),rows:fixedLabels.map(label=>nodes.filter(row=>row.label===label&&parent.contains(row.node)).length),accountHeading:/\bMon Compte\b/.test(clean(d.safeText(parent,4000)))})):[]};
  diagnostic.logoutCandidates=(typeof document==='object'?[...document.querySelectorAll('a,button,[role]')]:[]).filter(e=>visible(e)&&clean(d.label(e))==='Se déconnecter').slice(0,3).map(e=>({tag:['A','BUTTON','DIV','SPAN','LI'].includes(e.tagName)?e.tagName:'OTHER',role:['button','link','menuitem'].includes(e.getAttribute('role'))?e.getAttribute('role'):'-'}));
  const pageURL=typeof location==='object'?String(location.href):'',headingNames=[];
  // Only profile information headings inside a button qualify; empty-wardrobe
  // marketing headings and product/seller text cannot supply account identity.
  if(/^https:\/\/www\.vinted\.fr\/member\/[1-9]\d*(?:-[^/?#]+)?\/?$/.test(pageURL)&&typeof document==='object')for(const h of document.querySelectorAll('h1')){
    const parent=d.closest(h,'button');if(!visible(h)||!parent||!visible(parent)||d.closest(parent,'header,nav,[role=navigation],form,article,a[href]'))continue;
    const name=clean(d.safeText(h,120));if(/^[a-zA-Z0-9_.-]{1,100}$/.test(name)&&clean(d.label(parent))===name)headingNames.push(name);
  }
  const username=headingNames.length===1?headingNames[0]:null,buttons=[];
  for(const id of buttonIds){
    const e=map?.get(id);if(!visible(e)||e.tagName!=='BUTTON'||d.disabled(e)||d.closest(e,'a[href],form')||!d.closest(e,'header,nav,[role=navigation]'))continue;
    const r=e.getBoundingClientRect();if(r.top<0||r.top>Math.min(300,innerHeight*0.45)||r.bottom>innerHeight||r.right<=0||r.left>=innerWidth)continue;
    const label=clean(d.label(e));
    if(['Menu ouvert','Menu fermé'].includes(label)){const expanded=e.getAttribute('aria-expanded');if(expanded!==null&&expanded!==(label==='Menu fermé'?'true':'false'))continue;buttons.push({id,node:e,username,kind:'mobile-menu',nativeId:e.id||null,label,expanded:label==='Menu fermé'?'true':'false'});continue;}
    if(clean(e.getAttribute('aria-label'))||clean(d.safeText(e,180)))continue;
    const imgs=[...e.querySelectorAll('img')].filter(visible),usernames=imgs.map(img=>clean(img.getAttribute('alt')));
    if(imgs.length!==1||!usernames[0]||usernames[0].length>100||/[\u0000-\u001f\u007f]/.test(usernames[0]))continue;
    buttons.push({id,node:e,username:usernames[0],kind:'avatar',nativeId:e.id||null,label:'',expanded:e.getAttribute('aria-expanded')});
  }
  const summaries=buttons.map(({id,username,expanded,kind,nativeId,label})=>({id,username,expanded,kind,nativeId,label}));
  diagnostic.buttonCount=buttons.length;diagnostic.buttons=buttons.map(({kind,expanded})=>({kind,expanded}));
  if(buttons.length!==1)return {documentKey:String(performance.timeOrigin),buttons:summaries,menus:[],visibleMenuParts:nodes.length,pageURL,diagnostic};
  const button=buttons[0],menus=[];
  for(const profile of nodes.filter(item=>item.label==='Mon profil')){
    const roots=d.parents(profile.node).filter(root=>!broad(root)&&visible(root));
    const root=roots.find(root=>['Mon profil','Paramètres','Mes commandes','Se déconnecter'].every(label=>nodes.some(item=>item.label===label&&root.contains(item.node))));
    if(!root)continue;
    const rows=nodes.filter(item=>root.contains(item.node));
    if(['Mon profil','Paramètres','Mes commandes','Se déconnecter'].some(label=>rows.filter(item=>item.label===label).length!==1)){menus.push({valid:false,reason:'ambiguous-menu'});continue;}
    if(profile.node.tagName!=='A'||!profile.node.href){menus.push({valid:false,reason:'invalid-profile-link'});continue;}
    const controls=clean(button.node.getAttribute('aria-controls')).split(' '),labels=clean(root.getAttribute('aria-labelledby')).split(' ');
    const explicitlyOwned=!!root.id&&controls.includes(root.id)||!!button.node.id&&labels.includes(button.node.id);
    const common=d.parents(root).find(p=>!broad(p)&&p.contains(button.node)&&d.closest(p,'header,nav,[role=navigation]'));
    const locallyOwned=!!common&&buttons.filter(item=>common.contains(item.node)).length===1&&!common.querySelector('input,textarea,select,form,main')&&[...common.querySelectorAll('button,a[href]')].every(e=>e===button.node||root.contains(e));
    const nav=d.closest(root,'header,nav,[role=navigation]'),buttonNav=d.closest(button.node,'header,nav,[role=navigation]');
    const mobileNavigation=button.kind==='mobile-menu'&&!!nav&&!!buttonNav&&(nav===buttonNav||nav.contains(buttonNav)||buttonNav.contains(nav))&&!d.closest(root,'main,form,article');
    const logout=rows.find(row=>row.label==='Se déconnecter').node;
    const mobileStructure=button.kind!=='mobile-menu'||/\bMon Compte\b/.test(clean(d.safeText(root,4000)))&&rows.find(row=>row.label==='Paramètres').node.href==='https://www.vinted.fr/settings/profile'&&rows.find(row=>row.label==='Mes commandes').node.href==='https://www.vinted.fr/my_orders'&&(logout.tagName==='BUTTON'||logout.getAttribute('role')==='button');
    diagnostic.ownership={aria:!!explicitlyOwned,local:!!locallyOwned,navigation:!!mobileNavigation,structure:!!mobileStructure};
    let nativeDrawer=false;
    const native=globalThis.__isolaNativeAccountDrawerGuard;
    if(button.kind==='mobile-menu'&&button.expanded==='true'&&mobileStructure&&nativeDrawerToken&&native?.token===nativeDrawerToken&&(native.root||!explicitlyOwned&&!locallyOwned&&!mobileNavigation)){
      native.inspect(native.observer.takeRecords());
      const exactRows=fixedLabels.map(label=>rows.find(item=>item.label===label)?.node);
      const unique=fixedLabels.every(label=>nodes.filter(item=>item.label===label).length===1&&documentNodes.filter(e=>menuLabel(e)===label).length===1);
      const unchanged=exactRows.every(node=>!native.baseline.has(node)||native.baseline.get(node).href===String(node.href||'')&&native.baseline.get(node).label===menuLabel(node));
      const same=native.root?native.root===root&&exactRows.every((node,index)=>native.rows[index]===node&&native.hrefs[index]===String(node.href||'')):true;
      nativeDrawer=native.valid&&native.documentKey===String(performance.timeOrigin)&&native.pageURL===pageURL&&native.button===button.node&&native.header.isConnected&&d.closest(button.node,'header,nav,[role=navigation]')===native.header&&unique&&unchanged&&same&&!d.closest(root,'main,form,article');
      if(nativeDrawer&&!native.root){native.root=root;native.rows=exactRows;native.hrefs=exactRows.map(node=>String(node.href||''));}
      else if(!nativeDrawer)native.valid=false;
    }
    const nativeBound=!!nativeDrawerToken&&native?.token===nativeDrawerToken&&!!native.root;
    const owned=(nativeBound?nativeDrawer:explicitlyOwned||locallyOwned||mobileNavigation||nativeDrawer)&&button.expanded!=='false'&&mobileStructure;
    menus.push({valid:owned,reason:owned?'':'unrelated-menu',href:String(profile.node.href),profileNodeId:profile.id,association:nativeDrawer?'mobile-native-toggle-drawer':explicitlyOwned?'aria':mobileNavigation?'mobile-header-navigation':'local-header-container'});
    if(owned)globalThis.__isolaAccountMenuObservation={documentKey:String(performance.timeOrigin),button:button.node,root,profileNode:profile.node,href:String(profile.node.href),nativeDrawerToken:nativeDrawer?nativeDrawerToken:null};
  }
  return {documentKey:String(performance.timeOrigin),buttons:summaries,menus,visibleMenuParts:nodes.length,pageURL,diagnostic};
}

// A portal drawer without an aria/header relationship can be attributed only
// to the original closed mobile toggle clicked during this inspection. The
// token remains in main/isolated memory and is never a page-provided marker.
function beginNativeDrawerGuard(buttonId,documentKey,pageURL,token){
 const d=globalThis.__isolaDOM,map=globalThis.__isolaElements,button=map?.get(buttonId),clean=v=>String(v||'').replace(/\s+/g,' ').trim();
 const menuLabel=e=>{const label=clean(d.label(e));return label==='Profil'?'Mon profil':label;};
 if(!d||!button||typeof MutationObserver!=='function'||String(performance.timeOrigin)!==documentKey||String(location.href)!==pageURL||!button.isConnected||button.tagName!=='BUTTON'||d.disabled(button)||!d.visible(button)||clean(d.label(button))!=='Menu ouvert'||button.getAttribute('aria-expanded')==='true'||d.closest(button,'a[href],form'))return {armed:false};
 const header=d.closest(button,'header,nav,[role=navigation]');if(!header)return {armed:false};
 const toggles=[...document.querySelectorAll('button')].filter(e=>e.isConnected&&d.visible(e)&&!d.disabled(e)&&d.closest(e,'header,nav,[role=navigation]')&&['Menu ouvert','Menu fermé'].includes(clean(d.label(e))));if(toggles.length!==1||toggles[0]!==button)return {armed:false};
 const labels=['Mon profil','Paramètres','Mes commandes','Se déconnecter'],semantic=e=>['A','BUTTON'].includes(e.tagName)||e.getAttribute?.('role')==='button';
 const candidates=[...document.querySelectorAll('a,button,[role=button]')].filter(e=>semantic(e)&&labels.includes(menuLabel(e)));
 if(candidates.some(e=>e.isConnected&&d.visible(e)))return {armed:false};
 globalThis.__isolaNativeAccountDrawerGuard?.stop?.();
 const guard={token,documentKey,pageURL,button,header,valid:true,root:null,rows:[],hrefs:[],baseline:new Map(candidates.map(e=>[e,{label:menuLabel(e),href:String(e.href||'')}]))};
 const contains=(a,b)=>a===b||!!a?.contains?.(b),element=node=>node?.nodeType===3?node.parentNode:node;
 guard.inspect=records=>{for(const record of records){
  const target=element(record.target);if(!target){guard.valid=false;continue;}
  if(guard.root&&contains(button,target)&&record.type==='attributes'&&['aria-label','aria-expanded'].includes(record.attributeName))guard.valid=false;
  if(record.type==='childList'&&[...record.removedNodes].some(node=>contains(node,button)||contains(node,header)||guard.root&&contains(node,guard.root))){guard.valid=false;continue;}
  const identity=[...guard.baseline.keys(),...guard.rows];
  if(identity.some(node=>contains(node,target))&&(record.type!=='attributes'||['href','role','aria-label'].includes(record.attributeName)))guard.valid=false;
  if(record.type==='childList'&&[...record.removedNodes].some(node=>identity.some(row=>contains(node,row))))guard.valid=false;
  if(guard.root&&record.type==='childList'&&[...record.addedNodes].some(node=>{
   if(node?.nodeType!==1)return false;return [node,...node.querySelectorAll('a,button,[role=button]')].some(row=>semantic(row)&&labels.includes(menuLabel(row))&&!guard.rows.includes(row));
  }))guard.valid=false;
 }};
 guard.observer=new MutationObserver(records=>guard.inspect(records));guard.observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
 let clicks=0;const interaction=event=>{if(event.type==='keydown'||!contains(button,event.target)||++clicks>1||event.isTrusted===false)guard.valid=false;};for(const type of ['click','keydown'])header.addEventListener?.(type,interaction,true);
 guard.stop=()=>{guard.observer.disconnect();for(const type of ['click','keydown'])header.removeEventListener?.(type,interaction,true);};globalThis.__isolaNativeAccountDrawerGuard=guard;return {armed:true};
}

// The final trusted anchor click must still belong to the original drawer.
// Flush the mutation epoch again in the capture listener, after hover/paint
// and before the browser is allowed to follow the anchor's default action.
function armOwnProfileClick(candidate,token){
 const d=globalThis.__isolaDOM,map=globalThis.__isolaElements,native=globalThis.__isolaNativeAccountDrawerGuard,observation=globalThis.__isolaAccountMenuObservation,clean=value=>String(value||'').replace(/\s+/g,' ').trim();
 const label=e=>{const value=clean(d.label(e));return value==='Profil'?'Mon profil':value;};
 const original=observation?.profileNode,valid=()=>{
  native?.inspect(native.observer.takeRecords());
  if(!d||!map||!native?.valid||native.token!==token||native.documentKey!==candidate.documentKey||String(performance.timeOrigin)!==candidate.documentKey||String(location.href)!=='https://www.vinted.fr/'||Date.now()>=candidate.expiresAt||observation?.nativeDrawerToken!==token||observation.root!==native.root||observation.button!==native.button||native.rows[0]!==original||!original?.isConnected||!d.visible(original)||String(original.href)!==candidate.profileHref||!['','_self'].includes(clean(original.getAttribute('target')).toLowerCase())||original.getAttribute('download')!==null)return false;
  const labels=['Mon profil','Paramètres','Mes commandes','Se déconnecter'],nodes=[...document.querySelectorAll('a,button,[role=button]')].filter(e=>e.isConnected&&d.visible(e));
  return native.header.isConnected&&native.button.isConnected&&native.root.isConnected&&d.visible(native.root)&&clean(d.label(native.button))==='Menu fermé'&&labels.every((value,index)=>native.rows[index]?.isConnected&&d.visible(native.rows[index])&&label(native.rows[index])===value&&String(native.rows[index].href||'')===native.hrefs[index]&&nodes.filter(e=>label(e)===value).length===1);
 };
 if(!valid())return {armed:false};const ids=[...map].filter(([,node])=>node===original).map(([id])=>id);if(ids.length!==1)return {armed:false};
 globalThis.__isolaOwnProfileClickGuard?.stop?.();
 const guard={token,clicked:false,valid:true},listener=event=>{if(event.isTrusted!==true||guard.clicked||!valid()){guard.valid=false;event.preventDefault();event.stopImmediatePropagation?.();return;}guard.clicked=true;};
 if(typeof original.addEventListener!=='function')return {armed:false};original.addEventListener('click',listener,true);guard.stop=()=>original.removeEventListener('click',listener,true);globalThis.__isolaOwnProfileClickGuard=guard;
 return {armed:true,elementId:ids[0],href:String(original.href)};
}

// This probe is self-contained for the final synchronous native publish check.
// It proves only that the previously verified menu was closed on this document;
// the identity must separately come from this module's unexpired main cache.
function probeClosedAccountDOM(receipt){
 const d=globalThis.__isolaDOM,map=globalThis.__isolaElements,clean=v=>String(v||'').replace(/\s+/g,' ').trim(),buttons=[];
 const epoch=globalThis.__isolaClosedAccountGuard;
 if(!d||!map||String(performance.timeOrigin)!==receipt.documentKey||String(location.href)!==receipt.pageURL||!epoch||epoch.token!==receipt.guardToken||epoch.documentKey!==receipt.documentKey)return {closed:false};
 epoch.inspect(epoch.observer.takeRecords());
 const guardUsable=epoch.valid&&epoch.button.isConnected&&epoch.header.isConnected;
 const visible=e=>!!e?.isConnected&&d.visible(e);let menuParts=0;
 for(const [,e] of map){
  if(!visible(e))continue;const label=clean(d.label(e));
  if((['A','BUTTON'].includes(e.tagName)||label==='Se déconnecter'&&e.getAttribute('role')==='button')&&['Mon profil','Profil','Paramètres','Mes commandes','Se déconnecter'].includes(label))menuParts++;
  if(e.tagName!=='BUTTON'||d.disabled(e)||d.closest(e,'a[href],form')||!d.closest(e,'header,nav,[role=navigation]'))continue;
  const r=e.getBoundingClientRect();if(r.top<0||r.top>Math.min(300,innerHeight*0.45)||r.bottom>innerHeight||r.right<=0||r.left>=innerWidth)continue;
  if(['Menu ouvert','Menu fermé'].includes(label)){buttons.push({node:e,kind:'mobile-menu',nativeId:e.id||null,closed:label==='Menu ouvert'&&e.getAttribute('aria-expanded')!=='true'});continue;}
  if(clean(e.getAttribute('aria-label'))||clean(d.safeText(e,180)))continue;
  const imgs=[...e.querySelectorAll('img')].filter(visible);if(imgs.length===1&&clean(imgs[0].getAttribute('alt')))buttons.push({node:e,kind:'avatar',nativeId:e.id||null,username:clean(imgs[0].getAttribute('alt')),closed:e.getAttribute('aria-expanded')!=='true'});
 }
 const button=buttons[0],sameNode=[...map.values()].includes(epoch.button),closed=guardUsable&&sameNode&&buttons.length===1&&button.node===epoch.button&&button.kind===receipt.toggleKind&&button.closed&&(!receipt.toggleNativeId||button.nativeId===receipt.toggleNativeId)&&(!button.username||button.username===receipt.username)&&menuParts===0;
 return {documentKey:String(performance.timeOrigin),pageURL:String(location.href),guardToken:receipt.guardToken,guardValid:epoch.valid,closed,buttonCount:buttons.length,menuParts,toggleKind:button?.kind,toggleNativeId:button?.nativeId};
}
function beginClosedAccountGuard(receipt){
 const observation=globalThis.__isolaAccountMenuObservation,d=globalThis.__isolaDOM,map=globalThis.__isolaElements;
 if(!observation||observation.documentKey!==receipt.documentKey||String(location.href)!==receipt.pageURL||!observation.button.isConnected||!observation.root.isConnected||!observation.profileNode.isConnected||String(observation.profileNode.href)!==observation.href||typeof MutationObserver!=='function'||![...map.values()].includes(observation.button))return {armed:false};
 let identity;try{const url=new URL(observation.href),match=/^\/member\/([1-9]\d*)(?:-[^/]+)?\/?$/.exec(url.pathname);if(url.origin!=='https://www.vinted.fr'||url.username||url.password||url.search||url.hash||!match)return {armed:false};identity=match[1];}catch{return {armed:false};}
 const header=d.closest(observation.button,'header,nav,[role=navigation]');if(identity!==receipt.memberId||!header)return {armed:false};
 if(observation.nativeDrawerToken){const native=globalThis.__isolaNativeAccountDrawerGuard;native?.inspect(native.observer.takeRecords());if(!native||!native.valid||native.token!==observation.nativeDrawerToken||native.button!==observation.button||native.root!==observation.root||!native.rows.includes(observation.profileNode))return {armed:false};native.stop();}
 if(globalThis.__isolaClosedAccountGuard?.stop)globalThis.__isolaClosedAccountGuard.stop();else globalThis.__isolaClosedAccountGuard?.observer?.disconnect();
 const epoch={token:receipt.guardToken,documentKey:receipt.documentKey,button:observation.button,root:observation.root,header,profileNode:observation.profileNode,href:observation.href,valid:true,phase:'closing',pending:[],buttonNodes:new Set([observation.button,...observation.button.querySelectorAll('*')]),menuNodes:new Set([observation.root,...observation.root.querySelectorAll('*')])};
 const contains=(a,b)=>a===b||!!a?.contains?.(b),element=node=>node?.nodeType===3?node.parentNode:node;
 const menuAdded=node=>{if(node?.nodeType!==1)return false;const nodes=[node,...node.querySelectorAll('a,button')];return nodes.some(item=>['Mon profil','Profil'].includes(String(d.label(item)).replace(/\s+/g,' ').trim()))||!!epoch.root.id&&node.id===epoch.root.id;};
 epoch.relevant=record=>{
  const node=element(record.target);if(!node)return true;
  if(epoch.buttonNodes.has(node)||epoch.menuNodes.has(node)||contains(epoch.header,node)||contains(epoch.root,node)||contains(epoch.button,node))return true;
  if(record.type==='attributes')return contains(node,epoch.header)||contains(node,epoch.root);
  if(record.type==='childList')return [...record.addedNodes,...record.removedNodes].some(item=>contains(item,epoch.header)||contains(item,epoch.root)||contains(item,epoch.button)||menuAdded(item));
  return false;
 };
 epoch.inspect=records=>{for(const record of records)if(epoch.relevant(record)){if(epoch.phase==='closing')epoch.pending.push(record);else epoch.valid=false;}};
 epoch.observer=new MutationObserver(records=>epoch.inspect(records));epoch.observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
 const interaction=event=>{if(epoch.phase==='closed'||!contains(epoch.button,event.target))epoch.valid=false;};for(const type of ['pointerdown','keydown','click'])header.addEventListener?.(type,interaction,true);
 epoch.stop=()=>{epoch.observer.disconnect();for(const type of ['pointerdown','keydown','click'])header.removeEventListener?.(type,interaction,true);epoch.valid=false;};globalThis.__isolaClosedAccountGuard=epoch;
 return {armed:true};
}
function sealClosedAccountGuard(receipt,probe){
 const epoch=globalThis.__isolaClosedAccountGuard;
 const tags=new Set(['A','BUTTON','DIV','SPAN','LI','UL','HEADER','NAV','MAIN','FORM','SECTION','ASIDE','BODY','HTML','SVG','G','PATH','CIRCLE','RECT','LINE','POLYLINE','POLYGON','ELLIPSE']);
 const attrs=new Set(['aria-label','aria-expanded','class','style','hidden','aria-hidden','data-state','data-testid','data-visible','data-expanded','inert','tabindex','role','href','aria-controls','aria-labelledby','d','fill','stroke','stroke-width','viewBox']);
 const tag=node=>node?.nodeType===3?'TEXT':tags.has(String(node?.tagName||'').toUpperCase())?String(node.tagName).toUpperCase():'OTHER';
 const summary=record=>({type:['attributes','childList','characterData'].includes(record.type)?record.type:'OTHER',tag:tag(record.target),attribute:record.type==='attributes'?(attrs.has(record.attributeName)?record.attributeName:String(record.attributeName||'').startsWith('data-')?'data-*':'OTHER'):'-',added:[...(record.addedNodes||[])].slice(0,3).map(tag),removed:[...(record.removedNodes||[])].slice(0,3).map(tag)});
 const failure=(reason,result,rejected=[])=>({closed:false,diagnostic:{reason,guardExists:!!epoch,tokenMatch:!!epoch&&epoch.token===receipt.guardToken,phaseClosing:epoch?.phase==='closing',guardValid:epoch?.valid===true,documentMatch:String(performance.timeOrigin)===receipt.documentKey,urlMatch:String(location.href)===receipt.pageURL,buttonConnected:epoch?.button?.isConnected===true,headerConnected:epoch?.header?.isConnected===true,buttonMapped:!!epoch&&[...(globalThis.__isolaElements?.values()||[])].includes(epoch.button),profileHrefMatch:!!epoch&&(!epoch.profileNode.isConnected||String(epoch.profileNode.href)===epoch.href),pendingCount:epoch?.pending?.length||0,rejectedCount:rejected.length,mutations:(rejected.length?rejected:epoch?.pending||[]).slice(0,3).map(summary),probe:{closed:result?.closed===true,guardValid:result?.guardValid===true,buttonCount:result?.buttonCount,menuParts:result?.menuParts,toggleKind:['mobile-menu','avatar'].includes(result?.toggleKind)?result.toggleKind:null,documentMatch:result?.documentKey===receipt.documentKey,urlMatch:result?.pageURL===receipt.pageURL}}});
 if(!epoch)return failure('missing-guard');
 if(epoch.token!==receipt.guardToken)return failure('guard-token');
 if(epoch.phase!=='closing')return failure('guard-phase');
 if(!epoch.valid)return failure('guard-invalid',probe(receipt));
 epoch.inspect(epoch.observer.takeRecords());
 if(String(performance.timeOrigin)!==receipt.documentKey){const out=failure('document',probe(receipt));epoch.valid=false;return out;}
 if(String(location.href)!==receipt.pageURL){const out=failure('page-url',probe(receipt));epoch.valid=false;return out;}
 const inside=(a,b)=>a===b||!!a?.contains?.(b),element=node=>node?.nodeType===3?node.parentNode:node;
 const svgTags=new Set(['SVG','G','PATH','CIRCLE','RECT','LINE','POLYLINE','POLYGON','ELLIPSE']);
 const visual=node=>node?.nodeType===3?!String(node.textContent||'').trim():svgTags.has(String(node?.tagName||'').toUpperCase())&&[...(node.childNodes||node.children||[])].every(visual);
 const svgAttributes=new Set(['d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','viewBox','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','points','transform','opacity','fill-rule','clip-rule','aria-hidden','focusable']);
 const inButton=node=>epoch.buttonNodes.has(node)||inside(epoch.button,node);
 const expected=record=>{
  const node=element(record.target);if(!node)return false;
  if(record.type==='attributes'){
   if(inside(epoch.profileNode,node))return false;
   if(inButton(node))return ['aria-label','aria-expanded','class','style'].includes(record.attributeName)||visual(node)&&svgAttributes.has(record.attributeName);
   return (epoch.menuNodes.has(node)||inside(node,epoch.root)||inside(node,epoch.header))&&['class','style','hidden','aria-hidden'].includes(record.attributeName);
  }
  if(record.type==='characterData')return inside(epoch.button,node);
  if(record.type==='childList'&&inButton(node))return (node===epoch.button||visual(node))&&[...record.addedNodes,...record.removedNodes].every(visual);
  if(record.type==='childList')return record.addedNodes.length===0&&record.removedNodes.length>0&&[...record.removedNodes].every(node=>epoch.menuNodes.has(node)||inside(node,epoch.root))&&![...record.removedNodes].some(node=>inside(node,epoch.button)||inside(node,epoch.header));
  return false;
 };
 const rejected=epoch.pending.filter(record=>!expected(record));
 if(!epoch.button.isConnected||!epoch.header.isConnected||epoch.profileNode.isConnected&&String(epoch.profileNode.href)!==epoch.href||rejected.length){const result=probe(receipt),reason=!epoch.button.isConnected||!epoch.header.isConnected?'original-node':epoch.profileNode.isConnected&&String(epoch.profileNode.href)!==epoch.href?'identity':'mutation',out=failure(reason,result,rejected);epoch.valid=false;return out;}
 epoch.phase='closed';epoch.pending=[];const result=probe(receipt);if(!result.closed){const out=failure('closed-probe',result);epoch.valid=false;return out;}return result;
}

function getClosedAccountEvidence(adapter,{profileId,tab,documentKey,now=Date.now()}={}){
 const entry=tab&&closedReceipts.get(adapter)?.get(receiptKey(profileId,tab));
 let url;try{url=new URL(tab?.view?.webContents?.getURL());}catch{return null;}if(url.origin!==ORIGIN||url.username||url.password)return null;
 if(!entry||url.href!==entry.receipt.pageURL||entry.tab!==tab||entry.receipt.documentKey!==documentKey||entry.receipt.expiresAt<=now||entry.receipt.createdAt>now||tab.view?.webContents?.isDestroyed?.())return null;
 return entry.receipt;
}
function validateClosedAccountDOM(state,receipt,{now=Date.now()}={}){
 return !!receipt&&receipt.kind==='closed-account-menu'&&receipt.createdAt<=now&&receipt.expiresAt>now&&state?.documentKey===receipt.documentKey&&state.pageURL===receipt.pageURL&&typeof receipt.guardToken==='string'&&state.guardToken===receipt.guardToken&&state.guardValid===true&&state.closed===true&&state.buttonCount===1&&state.menuParts===0&&state.toggleKind===receipt.toggleKind&&(!receipt.toggleNativeId||state.toggleNativeId===receipt.toggleNativeId);
}

class VintedAccount {
  constructor(adapter,{timeoutMs=10000,menuWaitMs=3000,pollIntervalMs=100}={}){
    if(!adapter?.current||!adapter?.read||!adapter?.control)throw new TypeError('VintedAdapter is required');
    this.adapter=adapter;this.timeoutMs=Math.max(20,Math.min(10000,timeoutMs));this.menuWaitMs=Math.max(0,Math.min(3000,menuWaitMs));this.pollIntervalMs=Math.max(10,Math.min(200,pollIntervalMs));
  }
  async bounded(task,context){
    if(context.signal.aborted)throw stopped();
    let timer,onAbort;
    const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(stopped());context.signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>{reject(problem('ACCOUNT_TIMEOUT','账号页面没有及时响应，已停止核验'));context.controller.abort();},this.timeoutMs);});
    try{return await Promise.race([Promise.resolve().then(task),cancelled]);}finally{clearTimeout(timer);context.signal.removeEventListener('abort',onAbort);}
  }
  async state(profileId,context,expected){
    const page=await this.bounded(()=>this.adapter.read(profileId,context),context);this.adapter.current(profileId,context);
    const buttons=page.elements.filter(e=>e.tag==='button'&&!e.disabled&&!e.sensitive).map(e=>e.id);
    const menus=page.elements.filter(e=>(['a','button'].includes(e.tag)||norm(e.label)==='Se déconnecter'&&e.role==='button')&&!e.sensitive&&MENU_LABELS.includes(norm(e.label))).map(e=>({id:e.id,label:norm(e.label)}));
    const state=await this.bounded(()=>this.adapter.control.isolated(context.tab,'('+probeAccountDOM.toString()+')('+JSON.stringify(buttons)+','+JSON.stringify(menus)+','+JSON.stringify(context.nativeDrawerToken||'')+')'),context);this.adapter.current(profileId,context);
    if(!state||typeof state.documentKey!=='string'||!state.documentKey||!Array.isArray(state.buttons)||!Array.isArray(state.menus))throw problem('ACCOUNT_UNVERIFIED','账号页面结构无法核对');
    if(expected&&state.documentKey!==expected.documentKey)throw problem('PAGE_CHANGED','账号页面已重新加载，核验已停止');
    if(state.buttons.length!==1)throw accountFailure(state.buttons.length?'页面存在多个头像按钮，无法确定当前账号':'未找到唯一的顶部账号头像按钮',state);
    if(expected?.username&&state.buttons[0].username&&state.buttons[0].username!==expected.username)throw problem('ACCOUNT_CHANGED','核验过程中账号头像已改变');
    const button=state.buttons[0];state.button=button;state.clickable=page.elements.find(e=>e.id===button.id)?.clickable!==false;
    if(state.menus.length){
      closedReceipts.get(this.adapter)?.delete(receiptKey(profileId,context.tab));
      if(state.menus.length!==1||!state.menus[0].valid)throw accountFailure('个人主页链接无法唯一关联当前账号菜单',state);
      const identity=memberURL(state.menus[0].href),bound=context.expectedAccount;
      if(context.profileCandidateOnly===true){
        if(button.kind!=='mobile-menu'||!context.nativeDrawerToken||state.menus[0].association!=='mobile-native-toggle-drawer')throw accountFailure('个人主页候选缺少本次原生打开的手机菜单关联',state);
        state.profileCandidate={...identity,association:state.menus[0].association};return state;
      }
      let username=button.username,usernameSource=button.kind==='mobile-menu'?'own-profile-heading':'avatar';
      if(button.kind==='mobile-menu'){
        let own=false;try{own=memberURL(state.pageURL).memberId===identity.memberId;}catch{}
        if(!own)username=null;
        if(!username&&!context.requireOwnProfileHeading&&bound&&bound.memberId===identity.memberId&&bound.profileURL===identity.profileURL&&typeof bound.username==='string'&&bound.username.trim()===bound.username&&bound.username.length>0&&bound.username.length<=100){username=bound.username;usernameSource='saved-binding';}
        if(!username)throw problem('ACCOUNT_UNVERIFIED','已读到账号菜单，但当前页面缺少该账号自己的用户名证据；请先在该账号个人主页完成绑定');
      }
      if(bound&&(bound.memberId!==identity.memberId||bound.profileURL!==identity.profileURL))throw problem('ACCOUNT_CHANGED','当前账号菜单与保存的账号编号不一致');
      state.account={...identity,username,usernameSource,association:state.menus[0].association};
    }else{
      const receipt=getClosedAccountEvidence(this.adapter,{profileId,tab:context.tab,documentKey:state.documentKey});
      if(receipt){
        if(context.expectedAccount&&(context.expectedAccount.memberId!==receipt.memberId||context.expectedAccount.profileURL!==receipt.profileURL))throw problem('ACCOUNT_CHANGED','刚核对的账号与保存绑定已不一致');
        const closed=await this.bounded(()=>this.adapter.control.isolated(context.tab,'('+probeClosedAccountDOM.toString()+')('+JSON.stringify(receipt)+')'),context);this.adapter.current(profileId,context);
        if(validateClosedAccountDOM(closed,receipt)&&getClosedAccountEvidence(this.adapter,{profileId,tab:context.tab,documentKey:state.documentKey})===receipt){state.account={memberId:receipt.memberId,profileURL:receipt.profileURL,username:receipt.username,usernameSource:receipt.usernameSource,association:receipt.association};state.closedMenu=true;}
      }
    }
    return state;
  }
  // A navigation candidate is deliberately weaker than an account receipt.
  // Only a freshly opened native mobile drawer may produce one; it supplies
  // no username, binding, login status or closed-menu publication authority.
  async inspectOwnProfileLink(profileId,{signal}={}){
    const controller=new AbortController(),cancel=()=>controller.abort(),context={controller,signal:controller.signal,profileCandidateOnly:true};let w,contents,menuOpenAttempted=false;
    const navigated=(_event,_url,_inPlace,mainFrame)=>{if(mainFrame!==false)cancel();};
    try{
      if(signal?.aborted)throw stopped();signal?.addEventListener('abort',cancel,{once:true});
      const selected=this.adapter.current(profileId,context);w=selected.w;context.tab=selected.tab;contents=context.tab.view.webContents;
      if(contents.getURL()!==ORIGIN+'/'||contents.isLoadingMainFrame?.())throw problem('ACCOUNT_UNVERIFIED','请在新建的本人账号核验标签页读取个人主页');
      w.vintedDraftController=controller;closedReceipts.get(this.adapter)?.delete(receiptKey(profileId,context.tab));
      contents.on?.('did-start-navigation',navigated);contents.on?.('destroyed',cancel);contents.on?.('render-process-gone',cancel);
      const surface=await this.bounded(()=>this.adapter.control.isolated(context.tab,'('+probeOwnProfileSurface.toString()+')()'),context);
      if(surface?.challenge)throw problem('LOGIN_CHALLENGE','请先在核验标签页完成人工验证');if(surface?.ready!==true||surface.url!==ORIGIN+'/')throw problem('ACCOUNT_UNVERIFIED','本人账号核验页尚未完整加载');
      const guard=()=>this.adapter.current(profileId,context),initial=await this.state(profileId,context),expected={documentKey:initial.documentKey};
      if(surface.documentKey!==expected.documentKey)throw problem('PAGE_CHANGED','本人账号核验页已经重新加载');
      if(initial.button.kind!=='mobile-menu'||initial.button.expanded!=='false'||initial.visibleMenuParts||initial.menus.length||!initial.clickable)throw accountFailure('个人主页候选必须从本次尚未展开的唯一手机菜单开始',initial);
      const token=randomUUID(),armed=await this.bounded(()=>this.adapter.control.isolated(context.tab,'('+beginNativeDrawerGuard.toString()+')('+JSON.stringify(initial.button.id)+','+JSON.stringify(expected.documentKey)+','+JSON.stringify(contents.getURL())+','+JSON.stringify(token)+')'),context);guard();
      if(armed?.armed!==true)throw problem('ACCOUNT_CHANGED','读取个人主页前原手机菜单按钮或页面已改变');context.nativeDrawerToken=token;menuOpenAttempted=true;
      await this.bounded(()=>this.adapter.control.performAction(context.tab,{action:'click',elementId:initial.button.id},this.adapter.options(context.signal,guard)),context);guard();
      const until=Date.now()+this.menuWaitMs;let first;
      do{first=await this.state(profileId,context,expected);if(first.profileCandidate)break;if(Date.now()>=until)throw accountFailure('打开手机菜单后没有取得可核对的本人主页候选',first);await this.bounded(()=>new Promise(resolve=>setTimeout(resolve,this.pollIntervalMs)),context);}while(true);
      const second=await this.state(profileId,context,expected);guard();
      if(!second.profileCandidate||JSON.stringify(first.profileCandidate)!==JSON.stringify(second.profileCandidate)||first.pageURL!==second.pageURL||second.pageURL!==ORIGIN+'/')throw problem('ACCOUNT_CHANGED','两次手机菜单读取的本人主页候选不一致');
      const createdAt=Date.now(),candidate=Object.freeze({kind:'own-profile-candidate',verified:false,profileId,tabId:context.tab.id,documentKey:second.documentKey,...memberURL(second.profileCandidate.profileURL),profileHref:second.menus[0].href,observedAt:new Date(createdAt).toISOString(),expiresAt:createdAt+PROFILE_CANDIDATE_MS,consistentReads:2});
      profileCandidates.set(candidate,{adapter:this.adapter,profileId,tab:context.tab,token,createdAt});return candidate;
    }catch(error){error.accountMenuOpenAttempted=menuOpenAttempted;throw error;}
    finally{signal?.removeEventListener('abort',cancel);contents?.removeListener?.('did-start-navigation',navigated);contents?.removeListener?.('destroyed',cancel);contents?.removeListener?.('render-process-gone',cancel);if(w?.vintedDraftController===controller)w.vintedDraftController=null;}
  }
  validateOwnProfileLink(profileId,candidate,options={}){return this.consumeOwnProfileLink(profileId,candidate,options,false);}
  clickOwnProfileLink(profileId,candidate,options={}){return this.consumeOwnProfileLink(profileId,candidate,options,true);}
  async consumeOwnProfileLink(profileId,candidate,{signal,now=Date.now()}={},click=false){
    const entry=profileCandidates.get(candidate);profileCandidates.delete(candidate);
    if(!entry||entry.adapter!==this.adapter||entry.profileId!==profileId||candidate.verified!==false||candidate.expiresAt<=now||entry.createdAt>now)throw problem('ACCOUNT_UNVERIFIED','个人主页候选已过期或不属于原环境，请重新核验');
    const controller=new AbortController(),cancel=()=>controller.abort(),context={controller,signal:controller.signal,tab:entry.tab,profileCandidateOnly:true,nativeDrawerToken:entry.token};let w,contents,clickAllowed=false,navigationCount=0,lastNavigationURL;
    const navigated=(event,url,_inPlace,mainFrame)=>{if((event?.isMainFrame??mainFrame)===false)return;if(!clickAllowed||navigationCount===0&&url!==candidate.profileHref||navigationCount>0&&(navigationCount!==1||candidate.profileHref===candidate.profileURL||url!==candidate.profileURL)){cancel();return;}navigationCount++;lastNavigationURL=url;};
    const inPage=(event,url,isMain)=>{if((event?.isMainFrame??isMain)===false)return;if(url!==lastNavigationURL)navigated(event,url,true,true);};
    try{
      if(signal?.aborted)throw stopped();signal?.addEventListener('abort',cancel,{once:true});const selected=this.adapter.current(profileId,context);w=selected.w;contents=entry.tab.view.webContents;w.vintedDraftController=controller;
      contents.on?.('did-start-navigation',navigated);contents.on?.('did-navigate-in-page',inPage);contents.on?.('destroyed',cancel);contents.on?.('render-process-gone',cancel);
      if(contents.getURL()!==ORIGIN+'/'||contents.isLoadingMainFrame?.())throw problem('ACCOUNT_CHANGED','原个人主页核验标签页已改变');
      const surface=await this.bounded(()=>this.adapter.control.isolated(context.tab,'('+probeOwnProfileSurface.toString()+')()'),context);
      if(surface?.challenge)throw problem('LOGIN_CHALLENGE','请先在核验标签页完成人工验证');if(surface?.ready!==true||surface.url!==ORIGIN+'/'||surface.documentKey!==candidate.documentKey)throw problem('ACCOUNT_CHANGED','原个人主页核验页已改变');
      const state=await this.state(profileId,context,{documentKey:candidate.documentKey});this.adapter.current(profileId,context);
      if(state.profileCandidate?.memberId!==candidate.memberId||state.profileCandidate?.profileURL!==candidate.profileURL||state.menus[0]?.href!==candidate.profileHref||state.pageURL!==ORIGIN+'/'||candidate.expiresAt<=Date.now())throw problem('ACCOUNT_CHANGED','导航前手机菜单或个人主页候选已改变');if(!click)return true;
      const armed=await this.bounded(()=>this.adapter.control.isolated(context.tab,'('+armOwnProfileClick.toString()+')('+JSON.stringify(candidate)+','+JSON.stringify(entry.token)+')'),context);this.adapter.current(profileId,context);
      if(armed?.armed!==true||armed.href!==candidate.profileHref||armed.elementId!==state.menus[0].profileNodeId)throw problem('ACCOUNT_CHANGED','点击前原本人主页控件或菜单已改变');
      clickAllowed=true;await this.bounded(()=>this.adapter.control.performAction(context.tab,{action:'click',elementId:armed.elementId},this.adapter.options(context.signal,()=>this.adapter.current(profileId,context))),context);this.adapter.current(profileId,context);
      const url=contents.getURL();if(navigationCount<1||![candidate.profileHref,candidate.profileURL].includes(url)||memberURL(url).memberId!==candidate.memberId)throw problem('ACCOUNT_CHANGED','原生点击后未进入该账号本人的个人主页');
      return {profileId,tabId:context.tab.id,url};
    }finally{signal?.removeEventListener('abort',cancel);contents?.removeListener?.('did-start-navigation',navigated);contents?.removeListener?.('did-navigate-in-page',inPage);contents?.removeListener?.('destroyed',cancel);contents?.removeListener?.('render-process-gone',cancel);if(contents&&!contents.isDestroyed()&&[ORIGIN+'/',candidate.profileHref,candidate.profileURL].includes(contents.getURL()))await this.adapter.control.isolated(context.tab,'(()=>{const guard=globalThis.__isolaOwnProfileClickGuard;if(guard?.token==='+JSON.stringify(entry.token)+'){guard.stop();delete globalThis.__isolaOwnProfileClickGuard;}})()').catch(()=>{});if(w?.vintedDraftController===controller)w.vintedDraftController=null;}
  }
  async inspectAccount(profileId,{signal,controller:providedController,tab:providedTab,expectedAccount,closeMenu=false,requireOwnProfileHeading=false}={}){
    const controller=providedController||new AbortController();
    if(!controller?.signal||typeof controller.abort!=='function')throw new TypeError('AbortController is required');
    const cancel=()=>controller.abort();if(signal?.aborted)throw stopped();signal?.addEventListener('abort',cancel,{once:true});
    const context={signal:controller.signal,controller,tab:providedTab,expectedAccount,requireOwnProfileHeading:requireOwnProfileHeading===true};
    let w,contents,ownsLock=false,menuOpened=false,menuOpenAttempted=false;
    const changed=()=>controller.abort(),navigated=(_event,_url,_inPlace,mainFrame)=>{if(mainFrame!==false)changed();};
    try{
      const selected=this.adapter.current(profileId,context);w=selected.w;context.tab=selected.tab;contents=selected.tab.view.webContents;
      closedReceipts.get(this.adapter)?.delete(receiptKey(profileId,context.tab));
      ownsLock=w.vintedDraftController!==controller;if(ownsLock)w.vintedDraftController=controller;
      contents.on?.('did-start-navigation',navigated);contents.on?.('destroyed',changed);contents.on?.('render-process-gone',changed);
      const guard=()=>this.adapter.current(profileId,context);
      let state=await this.state(profileId,context),expected={documentKey:state.documentKey,username:state.button.username};
      if(!state.account){
        if(state.visibleMenuParts||state.button.expanded==='true')throw accountFailure('已有菜单无法核对，未再次点击账号按钮',state);
        if(!state.clickable)throw problem('ACCOUNT_UNVERIFIED','账号头像按钮不可点击，请先关闭遮挡');
        if(state.button.kind==='mobile-menu'){
          const token=randomUUID(),armed=await this.bounded(()=>this.adapter.control.isolated(context.tab,'('+beginNativeDrawerGuard.toString()+')('+JSON.stringify(state.button.id)+','+JSON.stringify(expected.documentKey)+','+JSON.stringify(contents.getURL())+','+JSON.stringify(token)+')'),context);guard();
          if(armed?.armed!==true)throw problem('ACCOUNT_CHANGED','打开账号菜单前原手机菜单按钮或页面身份已改变');context.nativeDrawerToken=token;
        }
        guard();menuOpenAttempted=true;
        await this.bounded(()=>this.adapter.control.performAction(context.tab,{action:'click',elementId:state.button.id},this.adapter.options(context.signal,guard)),context);guard();
        const until=Date.now()+this.menuWaitMs;
        do{
          state=await this.state(profileId,context,expected);if(state.account){menuOpened=true;break;}
          if(Date.now()>=until)throw accountFailure('打开账号菜单后没有取得唯一个人主页回执',state);
          await this.bounded(()=>new Promise(resolve=>setTimeout(resolve,this.pollIntervalMs)),context);
        }while(true);
      }
      const confirmed=await this.state(profileId,context,expected);
      if(!confirmed.account||confirmed.account.memberId!==state.account.memberId||confirmed.account.profileURL!==state.account.profileURL)throw problem('ACCOUNT_CHANGED','两次读取的账号回执不一致');
      guard();let menuClosed=false;
      if(closeMenu){
        if(!confirmed.clickable)throw problem('ACCOUNT_UNVERIFIED','账号菜单关闭按钮不可点击，未继续操作页面');
        const createdAt=Date.now(),receipt=Object.freeze({kind:'closed-account-menu',profileId,tabId:context.tab.id,documentKey:expected.documentKey,pageURL:contents.getURL(),guardToken:randomUUID(),...confirmed.account,toggleKind:confirmed.button.kind,toggleNativeId:confirmed.button.nativeId||null,createdAt,observedAt:new Date(createdAt).toISOString(),expiresAt:createdAt+CLOSED_RECEIPT_MS});
        const armed=await this.bounded(()=>this.adapter.control.isolated(context.tab,'('+beginClosedAccountGuard.toString()+')('+JSON.stringify(receipt)+')'),context);guard();if(armed?.armed!==true)throw problem('ACCOUNT_CHANGED','关闭账号菜单前原身份节点已改变');
        await this.bounded(()=>this.adapter.control.performAction(context.tab,{action:'click',elementId:confirmed.button.id},this.adapter.options(context.signal,guard)),context);guard();
        await this.bounded(()=>this.adapter.read(profileId,context),context);guard();
        const closed=await this.bounded(()=>this.adapter.control.isolated(context.tab,'('+sealClosedAccountGuard.toString()+')('+JSON.stringify(receipt)+','+probeClosedAccountDOM.toString()+')'),context);guard();
        if(!validateClosedAccountDOM(closed,receipt))throw closedAccountFailure('账号菜单关闭后状态无法核对，已停止后续操作',closed);
        let records=closedReceipts.get(this.adapter);if(!records){records=new Map();closedReceipts.set(this.adapter,records);}records.set(receiptKey(profileId,context.tab),{tab:context.tab,receipt});menuClosed=true;
      }
      return {verified:true,site:ORIGIN,memberId:confirmed.account.memberId,username:confirmed.account.username,usernameSource:confirmed.account.usernameSource,profileURL:confirmed.account.profileURL,documentKey:expected.documentKey,menuOpened,menuClosed,evidence:{kind:'current-account-menu',identitySource:'current-account-menu',association:confirmed.account.association,consistentReads:2},message:menuClosed?'已从当前账号菜单核对会员编号并关闭菜单；未打开个人主页或改动商品表单。':'已核对当前窗口的账号菜单；菜单保持展开，未打开个人主页或改动商品表单。'};
    }catch(error){error.accountMenuOpened=menuOpened?true:menuOpenAttempted?null:false;error.accountMenuOpenAttempted=menuOpenAttempted;error.accountMenuClosed=false;throw error;}
    finally{
      signal?.removeEventListener('abort',cancel);contents?.removeListener?.('did-start-navigation',navigated);contents?.removeListener?.('destroyed',changed);contents?.removeListener?.('render-process-gone',changed);
      if(ownsLock&&w?.vintedDraftController===controller)w.vintedDraftController=null;
    }
  }
}
module.exports={VintedAccount,memberURL,probeAccountDOM,getClosedAccountEvidence,probeClosedAccountDOM,validateClosedAccountDOM,CLOSED_RECEIPT_MS};
