'use strict';

const {VintedAccount,memberURL}=require('./vinted-account.cjs');
const ORIGIN='https://www.vinted.fr';
const fail=(code,message)=>Object.assign(new Error(message),{code});
function ensure(ok,code,message){if(!ok)throw fail(code,message);}
const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
function normalizedTitle(value){
 ensure(typeof value==='string'&&value.trim().length>0&&value.length<=100&&!/[\u0000-\u001f\u007f]/.test(value),'CATALOG_TITLE_INVALID','待核对的商品标题无效');
 return clean(value).normalize('NFKC').toLocaleLowerCase('fr-FR');
}
function itemIdentity(value){
 let url;try{url=new URL(value);}catch{throw fail('CATALOG_ITEM_INVALID','衣橱商品地址无法核对');}
 const match=/^\/items\/([1-9]\d{0,29})(?:-[^/]+)?\/?$/.exec(url.pathname);
 ensure(url.origin===ORIGIN&&!url.username&&!url.password&&!url.search&&!url.hash&&match,'CATALOG_ITEM_INVALID','衣橱商品地址无法核对');
 return {listingId:match[1],url:ORIGIN+'/items/'+match[1]};
}

// This is the complete accessible card shape observed on the French wardrobe.
// Neither a loose product name nor a guessed data-testid is a title receipt.
function parseCardLabel(value){
 if(typeof value!=='string'||value.length>500)return null;
 const match=/^(.+), état: (Neuf avec étiquette|Neuf sans étiquette|Très bon état|Bon état|Satisfaisant), (\d{1,7})(?:[,.](\d{2}))?\s*€$/u.exec(clean(value));
 if(!match)return null;
 let normalized;try{normalized=normalizedTitle(match[1]);}catch{return null;}
 const priceCents=Number(match[3])*100+Number(match[4]||0);
 if(!Number.isSafeInteger(priceCents)||priceCents<1||priceCents>100000000)return null;
 return {title:clean(match[1]),normalizedTitle:normalized,condition:match[2],priceCents,currency:'EUR'};
}

// Read-only visible DOM. This intentionally has no Vinted class/test-id guesses,
// hidden application state or implicit pagination. A count is not complete
// unless every distinct visible item can be tied to a reliable title receipt.
// Empty-state labels must be supplied from an observed French wardrobe screen;
// no unobserved copy is silently assumed to describe an empty account.
function probeCatalogDOM(emptyStateLabels){
 const d=globalThis.__isolaDOM,clean=v=>String(v||'').replace(/\s+/g,' ').trim(),visible=e=>!!e?.isConnected&&d.visible(e);
 const outside=e=>!!d.closest(e,'header,nav,[role=navigation],footer');
 const raw={url:location.href,documentKey:String(performance.timeOrigin),countLabels:[],links:[],emptyLabels:[],errors:[],ready:document.readyState==='complete'};
 if(!d)return {...raw,errors:['DOM helpers unavailable']};
 const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')].filter(e=>visible(e)&&!outside(e));
 const counts=headings.filter(e=>/^(?:0|[1-9]\d*) articles?$/.test(clean(d.safeText(e,120))));
 raw.countLabels=counts.map(e=>clean(d.safeText(e,120)));
 if(counts.length!==1)return {...raw,errors:['衣橱商品总数缺失或不唯一']};
 const anchors=[...document.querySelectorAll('a[href]')].filter(e=>visible(e)&&!outside(e));
 const links=[];
 for(const anchor of anchors){
  let url;try{url=new URL(anchor.href);}catch{continue;}
  if(!/^\/items\//.test(url.pathname))continue;
  if(url.origin!=='https://www.vinted.fr'||url.username||url.password||url.search||url.hash||!/^\/items\/[1-9]\d{0,29}(?:-[^/]+)?\/?$/.test(url.pathname)){raw.errors.push('存在无法核对的商品链接');continue;}
  links.push(anchor);
 }
 const broad=e=>['HTML','BODY','HEADER','NAV','FOOTER'].includes(e.tagName);
 const heading=counts[0],parents=d.parents(heading).filter(e=>!broad(e)&&visible(e));
 const labels=Array.isArray(emptyStateLabels)?emptyStateLabels.filter(v=>typeof v==='string'&&v.length>0&&v.length<=300):[];
 let scope;
 if(links.length)scope=parents.find(e=>e!==heading&&links.every(link=>e.contains(link)));
 else scope=parents.find(e=>e!==heading&&[...e.querySelectorAll('p,span,div,[role=status]')].some(node=>visible(node)&&labels.includes(clean(d.safeText(node,301)))));
 if(!scope)return {...raw,errors:[...raw.errors,'商品总数、商品卡片或空衣橱标记无法关联同一区域']};
 for(const anchor of links){
  const labels=[anchor.getAttribute('aria-label'),d.safeText(anchor,501),...Array.from(anchor.querySelectorAll('img')).filter(visible).map(img=>img.getAttribute('alt'))].map(clean).filter(Boolean);
  raw.links.push({href:String(anchor.href),labels:[...new Set(labels)]});
 }
 raw.emptyLabels=[...scope.querySelectorAll('p,span,div,[role=status]')].filter(node=>visible(node)&&labels.includes(clean(d.safeText(node,301)))).map(node=>clean(d.safeText(node,301)));
 raw.emptyLabels=[...new Set(raw.emptyLabels)];
 const pending=[...document.querySelectorAll('[aria-busy=true],[role=progressbar]')].some(visible);
 const more=[...scope.querySelectorAll('a[href],button,[role=button]')].filter(visible).some(node=>node.getAttribute('rel')?.split(/\s+/).includes('next')||/^(?:Suivant|Suivante|Afficher plus|Voir plus|Charger plus|Page suivante)$/i.test(clean(d.label(node))));
 const pagination=[...document.querySelectorAll('nav,[role=navigation]')].filter(visible).some(node=>/pagination/i.test(clean(node.getAttribute('aria-label'))));
 raw.busy=pending;raw.pagination=more||pagination;
 raw.challenge=[...document.querySelectorAll('iframe')].some(e=>visible(e)&&/captcha|challenges\.cloudflare|challenge-platform/i.test((e.getAttribute('src')||'')+' '+(e.getAttribute('title')||'')));
 raw.dialogs=[...document.querySelectorAll('[aria-modal=true],dialog[open]')].filter(visible).length;
 raw.alerts=[...scope.querySelectorAll('[role=alert],[aria-live=assertive]')].filter(visible).map(e=>clean(d.safeText(e,400))).filter(Boolean);
 return raw;
}

function catalogSurface(raw,{expectedAccount,title,emptyStateLabels=[]}){
 const target=normalizedTitle(title),identity=memberURL(raw?.url);
 ensure(identity.memberId===expectedAccount.memberId&&identity.profileURL===expectedAccount.profileURL,'CATALOG_WRONG_ACCOUNT','当前页面不是绑定账号自己的衣橱');
 const issues=[];if(!Array.isArray(raw.errors)||raw.errors.length)issues.push(...(Array.isArray(raw.errors)?raw.errors:['衣橱页面结构无法核对']));
 if(typeof raw.documentKey!=='string'||!raw.documentKey||raw.documentKey.length>100)issues.push('衣橱页面编号缺失或无效');
 const count=Array.isArray(raw.countLabels)&&raw.countLabels.length===1&&/^(?:0|[1-9]\d*) articles?$/.test(raw.countLabels[0])?Number.parseInt(raw.countLabels[0],10):null;
 if(!Number.isSafeInteger(count)||count<0||count>100000)issues.push('衣橱商品总数缺失或无效');
 const entries=new Map();
 if(!Array.isArray(raw.links))issues.push('衣橱商品列表无法读取');
 for(const link of Array.isArray(raw.links)?raw.links:[]){
  let identity;try{identity=itemIdentity(link?.href);}catch{issues.push('衣橱商品地址无法核对');continue;}
  const entry=entries.get(identity.listingId)||{...identity,cards:[]};entries.set(identity.listingId,entry);
  if(!Array.isArray(link.labels))continue;
  for(const label of link.labels){const card=parseCardLabel(label);if(card)entry.cards.push(card);}
 }
 const items=[];
 for(const entry of entries.values()){
  const values=[...new Set(entry.cards.map(card=>JSON.stringify(card)))];
  if(values.length!==1){issues.push(values.length?'同一商品卡片的标题、成色或金额不一致':'商品标题无法从完整可见卡片资料核对');continue;}
  items.push({listingId:entry.listingId,url:entry.url,...entry.cards[0]});
 }
 if(entries.size!==count)issues.push('可见商品数量不等于衣橱总数，可能尚未加载完整或使用了分页');
 if(count===0&&(!Array.isArray(raw.emptyLabels)||!raw.emptyLabels.some(label=>emptyStateLabels.includes(label))))issues.push('没有已核对的可见空衣橱标记');
 if(raw.ready!==true||raw.busy!==false||raw.pagination!==false||raw.challenge!==false||raw.dialogs!==0||!Array.isArray(raw.alerts)||raw.alerts.length)issues.push('页面仍在加载、分页、存在验证或弹窗，不能确认衣橱完整');
 items.sort((a,b)=>a.listingId.localeCompare(b.listingId,'en'));
 const duplicate=items.some(item=>item.normalizedTitle===target),complete=issues.length===0;
 return {complete,duplicate:duplicate?true:complete?false:null,absent:complete&&!duplicate,items,count,reason:issues.length?[...new Set(issues)].join('；'):duplicate?'已找到同标题商品，不会重复刊登':'已核对完整的本人衣橱，没有同标题商品',issues:[...new Set(issues)],documentKey:raw.documentKey,url:identity.profileURL};
}

class VintedCatalog{
 constructor(adapter,{accountReader,timeoutMs=20000,now=Date.now,emptyStateLabels=[]}={}){
  if(!adapter?.current||!adapter?.read||!adapter?.control?.isolated)throw new TypeError('VintedAdapter is required');
  ensure(Array.isArray(emptyStateLabels)&&emptyStateLabels.every(label=>typeof label==='string'&&clean(label)===label&&label.length>0&&label.length<=300),'CATALOG_CONFIG_INVALID','空衣橱标记必须来自已观察的明确页面文案');
  this.adapter=adapter;this.account=accountReader||new VintedAccount(adapter);this.timeoutMs=Math.max(20,Math.min(30000,timeoutMs));this.now=now;this.emptyStateLabels=[...emptyStateLabels];
 }
 async wait(work,context){
  context.guard();let abort;const stopped=new Promise((_,reject)=>{abort=()=>reject(fail('STOPPED','衣橱核查已停止'));context.signal.addEventListener('abort',abort,{once:true});});
  try{const result=await Promise.race([Promise.resolve().then(()=>{context.guard();return work();}),stopped]);context.guard();return result;}
  finally{context.signal.removeEventListener('abort',abort);}
 }
 async accountState(profileId,context,expectedAccount,expectedDocument){
  const state=await this.wait(()=>this.account.state(profileId,context,expectedDocument?{documentKey:expectedDocument,username:expectedAccount.username}:undefined),context);
  ensure(typeof state?.documentKey==='string'&&state.documentKey&&state.account?.memberId===expectedAccount.memberId&&state.account.profileURL===expectedAccount.profileURL&&state.account.username===expectedAccount.username,'CATALOG_ACCOUNT_CHANGED','当前账号菜单与绑定账号不一致，或菜单尚未核验');
  if(expectedDocument)ensure(state.documentKey===expectedDocument,'CATALOG_PAGE_CHANGED','衣橱页面已重新加载');
  return state;
 }
 async readPass(profileId,input,context,documentKey){
  const before=await this.accountState(profileId,context,input.expectedAccount,documentKey);
  const raw=await this.wait(()=>this.adapter.control.isolated(context.tab,'('+probeCatalogDOM.toString()+')('+JSON.stringify(this.emptyStateLabels)+')'),context);
  ensure(raw?.documentKey===documentKey,'CATALOG_PAGE_CHANGED','衣橱和账号不属于同一页面');
  const surface=catalogSurface(raw,{...input,emptyStateLabels:this.emptyStateLabels}),after=await this.accountState(profileId,context,input.expectedAccount,documentKey);
  ensure(JSON.stringify(before.account)===JSON.stringify(after.account),'CATALOG_ACCOUNT_CHANGED','读取衣橱时当前账号发生变化');
  return surface;
 }
 async run(profileId,{expectedAccount,title,signal,controller:providedController,tab:providedTab}={},openAccount=false){
  let controller,w,contents,timer,ownsLock=false,timedOut=false;const cancel=()=>controller?.abort(),navigation=(_event,_url,_inPlace,mainFrame)=>{if(mainFrame!==false)cancel();};
  const failure={complete:false,duplicate:null,absent:false,items:[],count:null,reason:'衣橱尚未核验'};
  try{
   normalizedTitle(title);const identity=memberURL(expectedAccount?.profileURL);
   ensure(expectedAccount.profileId===profileId&&identity.profileURL===expectedAccount.profileURL&&identity.memberId===expectedAccount.memberId&&typeof expectedAccount.username==='string'&&expectedAccount.username.trim().length>0,'CATALOG_ACCOUNT_CHANGED','环境绑定的账号资料无效');
   controller=providedController||new AbortController();ensure(controller?.signal&&typeof controller.abort==='function','CATALOG_CONFIG_INVALID','缺少页面取消控制器');
   if(signal?.aborted||controller.signal.aborted)throw fail('STOPPED','衣橱核查已停止');signal?.addEventListener('abort',cancel,{once:true});
   const context={controller,signal:controller.signal,tab:providedTab};context.guard=()=>{ensure(!controller.signal.aborted,'STOPPED','衣橱核查已停止');const current=this.adapter.current(profileId,context),page=memberURL(current.tab.view.webContents.getURL());ensure(page.memberId===identity.memberId&&page.profileURL===identity.profileURL,'CATALOG_WRONG_ACCOUNT','请在当前窗口打开绑定账号自己的衣橱');};
   context.guard();const selected=this.adapter.current(profileId,context);w=selected.w;context.tab=selected.tab;contents=selected.tab.view.webContents;
   ownsLock=w.vintedDraftController!==controller;if(ownsLock)w.vintedDraftController=controller;
   contents.on?.('did-start-navigation',navigation);contents.on?.('destroyed',cancel);contents.on?.('render-process-gone',cancel);timer=setTimeout(()=>{timedOut=true;controller.abort();},this.timeoutMs);
   if(openAccount){const receipt=await this.wait(()=>this.account.inspectAccount(profileId,{controller,signal:controller.signal,tab:context.tab}),context);ensure(receipt?.verified===true&&receipt.memberId===identity.memberId&&receipt.profileURL===identity.profileURL&&receipt.username===expectedAccount.username,'CATALOG_ACCOUNT_CHANGED','当前登录账号与保存的环境绑定不一致');}
   const initial=await this.accountState(profileId,context,expectedAccount),input={expectedAccount,title};
   const first=await this.readPass(profileId,input,context,initial.documentKey),second=await this.readPass(profileId,input,context,initial.documentKey);context.guard();
   ensure(JSON.stringify(first)===JSON.stringify(second),'CATALOG_PAGE_CHANGED','两次读取之间衣橱内容或账号发生变化');
   return {...second,profileId,tabId:context.tab.id,checkedAt:new Date(this.now()).toISOString(),consistentReads:2};
  }catch(cause){return {...failure,code:timedOut?'CATALOG_TIMEOUT':cause.code||'CATALOG_FAILED',reason:timedOut?'衣橱读取超时，没有确认商品不存在':String(cause.message||'衣橱读取失败').slice(0,700),checkedAt:new Date(this.now()).toISOString()};}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);contents?.removeListener?.('did-start-navigation',navigation);contents?.removeListener?.('destroyed',cancel);contents?.removeListener?.('render-process-gone',cancel);if(ownsLock&&w?.vintedDraftController===controller)w.vintedDraftController=null;}
 }
 async inspect(profileId,options){return this.run(profileId,options,true);}
 async collect(profileId,options){return this.run(profileId,options,false);}
}

module.exports={VintedCatalog,probeCatalogDOM,catalogSurface,parseCardLabel,normalizedTitle,itemIdentity};
