'use strict';
const {createHash}=require('node:crypto');
const {VintedAccount,memberURL}=require('./vinted-account.cjs');
const {restorePublicationState}=require('./vinted-publication.cjs');
const ORIGIN='https://www.vinted.fr';
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function failure(code,message){return Object.assign(Error(message),{code});}
function ensure(value,code,message){if(!value)throw failure(code,message);}
function listingURL(value){
 let url;try{url=new URL(value);}catch{throw failure('LISTING_WRONG_PAGE','请打开法国站的具体商品详情页');}
 const match=/^\/items\/([1-9]\d{0,29})(?:-[^/]+)?\/?$/.exec(url.pathname);
 ensure(url.origin===ORIGIN&&!url.username&&!url.password&&!url.search&&!url.hash&&match,'LISTING_WRONG_PAGE','请打开没有额外参数的法国站具体商品详情页');
 return {listingId:match[1],url:ORIGIN+'/items/'+match[1]};
}

// Visible/native DOM only. No clicks, data stores, network requests or hidden
// marketplace fields. Raw image URLs leave the isolated world only for hashing
// in the main process; they are removed before any report/evidence is returned.
function probeListingDOM(expectedTitle,username){
 const d=globalThis.__isolaDOM,clean=value=>String(value||'').replace(/\s+/g,' ').trim();
 const visible=e=>!!e?.isConnected&&d.visible(e),outside=e=>!!d.closest(e,'header,nav,[role=navigation],footer');
 const result={url:location.href,documentKey:String(performance.timeOrigin),errors:[]};
 const headings=[...document.querySelectorAll('h1')].filter(e=>visible(e)&&!outside(e));
 if(headings.length!==1)return {...result,errors:['详情页未找到唯一商品标题']};
 const heading=headings[0],title=clean(d.safeText(heading,300));result.title=title;
 if(title!==expectedTitle)return {...result,errors:['商品标题与原提交不一致']};
 const related=[...document.querySelectorAll('h2')].filter(e=>visible(e)&&clean(d.safeText(e,180))==='Articles similaires');
 if(related.length>1)return {...result,errors:['类似商品区域出现多个同名边界']};
 const beforeRelated=e=>!related.length||!!(e.compareDocumentPosition(related[0])&4);
 if(!beforeRelated(heading))return {...result,errors:['商品标题位于类似商品区域中']};
 const buttonLabels=["Modifier l'annonce",'Masquer','Supprimer'],linkLabels=['Indiquer comme vendu','Marquer comme réservé'];
 const buttons=[...document.querySelectorAll('button')].filter(e=>visible(e)&&!outside(e)&&beforeRelated(e));
 const links=[...document.querySelectorAll('a[href]')].filter(e=>visible(e)&&!outside(e)&&beforeRelated(e));
 const broad=e=>['HTML','BODY','HEADER','NAV','FOOTER'].includes(e.tagName);
 const scope=d.parents(heading).find(e=>!broad(e)&&buttonLabels.every(label=>buttons.some(b=>e.contains(b)&&clean(d.label(b))===label))&&linkLabels.every(label=>links.some(a=>e.contains(a)&&clean(d.label(a))===label)));
 if(!scope)return {...result,errors:['商品详情缺少同一区域内的完整本人管理控件']};
 if(related.length&&scope.contains(related[0]))return {...result,errors:['商品管理范围混入了类似商品区域']};
 result.ownControls=[];
 for(const label of buttonLabels){const matches=buttons.filter(e=>scope.contains(e)&&clean(d.label(e))===label);result.ownControls.push({label,count:matches.length,enabled:matches.length===1&&!d.disabled(matches[0]),kind:'button'});}
 for(const [index,label] of linkLabels.entries()){
  const matches=links.filter(e=>scope.contains(e)&&clean(d.label(e))===label),route=index===0?'/member/items/close':'/member/items/reservation';
  let valid=false;if(matches.length===1){try{const url=new URL(matches[0].href);valid=url.origin==='https://www.vinted.fr'&&!url.username&&!url.password&&url.pathname===route&&!d.disabled(matches[0]);}catch{}}
  result.ownControls.push({label,count:matches.length,enabled:valid,kind:'link'});
 }
 // Use the closest title ancestor containing a standalone euro value, excluding
 // every button/link. The "frais Vinted inclus" buyer total cannot be a price.
 const euro=/^(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})*|\d+)[,.]\d{2}\s*€$/;
 let priceNodes=[];
 for(const parent of d.parents(heading)){
  if(!scope.contains(parent)&&parent!==scope)break;
  const candidates=[parent,...parent.querySelectorAll('*')].filter(e=>visible(e)&&!d.closest(e,'button,a,[role=button],[role=link]')&&e!==heading&&!heading.contains(e)&&euro.test(clean(d.safeText(e,100))));
  const leaves=candidates.filter(e=>!candidates.some(other=>other!==e&&e.contains(other)));
  if(leaves.length){priceNodes=leaves;break;}
  if(parent===scope)break;
 }
 result.priceTexts=priceNodes.map(e=>clean(d.safeText(e,100)));
 const sellers=links.filter(e=>clean(d.label(e))===username).filter(e=>{try{return /^\/member\/[1-9]\d*(?:-[^/]+)?\/?$/.test(new URL(e.href).pathname);}catch{return false;}});
 result.sellers=sellers.map(e=>({label:clean(d.label(e)),href:String(e.href)}));
 const images=[...document.querySelectorAll('img')].filter(e=>visible(e)&&!outside(e)&&beforeRelated(e)&&clean(e.getAttribute('alt'))===title);
 result.images=images.map(img=>{
  const button=d.closest(img,'button,[role=button]'),named=button&&(clean(d.label(button))===title||!clean(button.getAttribute('aria-label'))&&!clean(d.safeText(button,300))&&[...button.querySelectorAll('img')].filter(visible).length===1);
  return {alt:clean(img.getAttribute('alt')),inNamedButton:!!named,loaded:img.complete&&img.naturalWidth>0&&img.naturalHeight>0,source:img.currentSrc||img.src||''};
 });
 result.challenge=[...document.querySelectorAll('iframe')].some(e=>visible(e)&&/captcha|challenges\.cloudflare|challenge-platform/i.test((e.getAttribute('src')||'')+' '+(e.getAttribute('title')||'')))||[...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].some(e=>visible(e)&&/captcha|vérifi.{0,30}humain|vérification de sécurité|pas un robot/i.test(d.safeText(e,500)));
 result.dialogs=[...document.querySelectorAll('[aria-modal=true],dialog[open]')].filter(visible).length;
 result.alerts=[...scope.querySelectorAll('[role=alert],[aria-live=assertive]')].filter(visible).map(e=>clean(d.safeText(e,400))).filter(Boolean);
 return result;
}

function priceCents(value){const text=String(value||'').replace(/\s*€$/,'').replace(/[ \u00a0\u202f]/g,'');if(!/^\d+[,.]\d{2}$/.test(text))return null;const cents=Math.round(Number(text.replace(',','.'))*100);return Number.isSafeInteger(cents)&&cents>0&&cents<=100000000?cents:null;}
function surface(raw,account,record){
 const facts=record.proof.facts,identity=listingURL(raw?.url),checks=[];
 const check=(name,ok,detail)=>checks.push({name,ok:!!ok,detail});
 check('详情页结构',Array.isArray(raw.errors)&&raw.errors.length===0,raw.errors?.length?raw.errors.join('；'):'标题与管理区域已限定');
 check('商品标题',raw.title===facts.fields.title,raw.title===facts.fields.title?'标题与原提交一致':'标题缺失或与原提交不一致');
 const own=raw.ownControls,ownership=Array.isArray(own)&&own.length===5&&own.every(item=>item.count===1&&item.enabled===true)&&equal(own.map(item=>item.label),["Modifier l'annonce",'Masquer','Supprimer','Indiquer comme vendu','Marquer comme réservé']);
 check('本人管理控件',ownership,ownership?'修改、隐藏、删除、已售与预留控件在同一详情区域':'本人管理控件缺失、重复或不可用');
 const amount=raw.priceTexts?.length===1?priceCents(raw.priceTexts[0]):null,priceOK=amount===facts.fields.priceCents;
 check('单品价格',priceOK,priceOK?'已核对独立单品售价，未使用含平台费的买家总价':'独立单品价格缺失、重复或与原提交不一致');
 let seller=null;if(raw.sellers?.length===1){try{seller=memberURL(raw.sellers[0].href);}catch{}}
 const sellerOK=seller?.memberId===facts.account.memberId&&seller?.profileURL===facts.account.profileURL&&raw.sellers[0].label===account.username;
 check('实际卖家',sellerOK,sellerOK?'详情页卖家与当前账号及原提交一致':'详情页卖家链接不唯一或与原账号不一致');
 const images=Array.isArray(raw.images)?raw.images:[],loaded=images.length===facts.photos.count&&images.every(img=>img.alt===facts.fields.title&&img.inNamedButton&&img.loaded&&typeof img.source==='string'&&img.source.length<=65536&&/^https?:\/\//.test(img.source));
 check('商品主图',loaded,loaded?'主图数量、标题关联与加载状态已核对':'主图数量、标题关联或加载状态未完全匹配');
 const fingerprints=loaded?images.map(img=>hash(img.source)):[],unique=loaded&&new Set(fingerprints).size===fingerprints.length,signature=unique?hash(JSON.stringify(fingerprints)):null;
 const photoSignatureMatched=signature===facts.photos.signature;
 check('原上传照片',photoSignatureMatched,photoSignatureMatched?'主图地址摘要与原上传回执一致':'主图地址摘要与原上传回执不同；没有把不同图片认定为同一张');
 const clear=raw.challenge===false&&raw.dialogs===0&&Array.isArray(raw.alerts)&&raw.alerts.length===0;
 check('页面状态',clear,clear?'未发现阻断验证、弹窗或详情错误提示':'页面存在验证、弹窗或错误提示，需人工核对');
 return {identity,checks,photoSignatureMatched,signature,priceCents:amount,seller,images:images.map(img=>({alt:img.alt,inNamedButton:img.inNamedButton,loaded:img.loaded})),verified:checks.every(item=>item.ok)};
}

class VintedListingReceipt {
 constructor(adapter,{accountReader,timeoutMs=20000,now=Date.now}={}){this.adapter=adapter;this.account=accountReader||new VintedAccount(adapter);this.timeoutMs=Math.max(20,Math.min(30000,timeoutMs));this.now=now;}
 async wait(work,context){
  context.guard();let cancel;const abort=new Promise((_,reject)=>{cancel=()=>reject(failure('STOPPED','刊登详情核对已停止'));context.signal.addEventListener('abort',cancel,{once:true});});
  try{const value=await Promise.race([Promise.resolve().then(()=>{context.guard();return work();}),abort]);context.guard();return value;}finally{context.signal.removeEventListener('abort',cancel);}
 }
 async readPass(input,context,initial){
  const profileId=input.record.proof.facts.profileId;
  const before=await this.wait(()=>this.account.state(profileId,context,{documentKey:initial.documentKey,username:initial.username}),context);
  ensure(before.account?.memberId===initial.memberId,'LISTING_ACCOUNT_CHANGED','详情核对期间当前账号发生变化');
  const raw=await this.wait(()=>this.adapter.control.isolated(context.tab,'('+probeListingDOM.toString()+')('+JSON.stringify(input.record.proof.facts.fields.title)+','+JSON.stringify(initial.username)+')'),context);
  ensure(raw?.documentKey===initial.documentKey,'LISTING_PAGE_CHANGED','账号和商品详情不属于同一次页面');
  const view=surface(raw,initial,input.record),after=await this.wait(()=>this.account.state(profileId,context,{documentKey:initial.documentKey,username:initial.username}),context);
  ensure(after.account?.memberId===initial.memberId&&after.documentKey===raw.documentKey,'LISTING_ACCOUNT_CHANGED','读取商品详情期间当前账号发生变化');
  return {...view,documentKey:raw.documentKey};
 }
 async collect({record,expectedAccount},{signal}={}){
  const summary={checks:[],blockers:[],listingId:null,url:null,photoSignatureMatched:false,verified:false,needsOriginAssociation:true,reconciled:false,menuOpened:false,menuClosed:false};
  let controller,w,contents,timer,timedOut=false;const cancel=()=>controller?.abort(),navigation=(_event,_url,_inPlace,mainFrame)=>{if(mainFrame!==false)cancel();};
  try{
   const checked=restorePublicationState({version:1,submissions:[record]}).state.submissions[0];
   ensure(['uncertain','dispatching','published'].includes(record.state)&&record.attemptCount===1,'LISTING_NOT_SUBMITTED','仅能核对已经尝试提交的原刊登记录');
   const facts=checked.proof.facts,expected=memberURL(expectedAccount?.profileURL);
   ensure(expectedAccount.profileId===facts.profileId&&expectedAccount.memberId===facts.account.memberId&&expected.memberId===facts.account.memberId,'LISTING_ACCOUNT_CHANGED','环境绑定账号与原提交不一致');
   if(signal?.aborted)throw failure('STOPPED','刊登详情核对已停止');
   controller=new AbortController();signal?.addEventListener('abort',cancel,{once:true});
   const context={controller,signal:controller.signal,form:false};context.guard=()=>{ensure(!controller.signal.aborted,'STOPPED','刊登详情核对已停止');const selected=this.adapter.current(facts.profileId,context);listingURL(selected.tab.view.webContents.getURL());};
   const selected=this.adapter.current(facts.profileId,context);w=selected.w;context.tab=selected.tab;contents=selected.tab.view.webContents;const identity=listingURL(contents.getURL());Object.assign(summary,identity);w.vintedDraftController=controller;
   contents.on?.('did-start-navigation',navigation);contents.on?.('destroyed',cancel);contents.on?.('render-process-gone',cancel);timer=setTimeout(()=>{timedOut=true;controller.abort();},this.timeoutMs);
   const initial=await this.wait(()=>this.account.inspectAccount(facts.profileId,{controller,signal:controller.signal,tab:context.tab}),context);summary.menuOpened=initial.menuOpened===true;
   ensure(initial.verified===true&&initial.memberId===facts.account.memberId&&initial.profileURL===facts.account.profileURL,'LISTING_ACCOUNT_CHANGED','当前账号与原刊登提交的账号不一致');
   summary.checks.push({name:'当前登录账号',ok:true,detail:'账号菜单与原提交和环境绑定一致'});
   const input={record:checked,expectedAccount},first=await this.readPass(input,context,initial),second=await this.readPass(input,context,initial);
   const stable=equal(first,second);summary.checks.push({name:'连续两次详情核对',ok:stable,detail:stable?'账号、商品、卖家、价格和图片摘要保持一致':'两次读取之间详情发生变化'});
   summary.checks.push(...second.checks);summary.photoSignatureMatched=second.photoSignatureMatched;summary.verified=stable&&second.verified&&second.identity.listingId===identity.listingId;
   if(second.identity.listingId!==identity.listingId)summary.checks.push({name:'同一商品页面',ok:false,detail:'当前商品编号在核对期间发生变化'});
   summary.blockers=summary.checks.filter(check=>!check.ok).map(check=>check.detail);summary.checkedAt=new Date(this.now()).toISOString();
   ensure(Date.parse(summary.checkedAt)>=Date.parse(record.submittedAt),'LISTING_RECORD_TIME','详情核对时间早于原提交记录');
   const evidence=summary.verified?{verified:true,mappingVerified:true,publicationStatus:'published',observedAt:summary.checkedAt,profileId:facts.profileId,listingId:identity.listingId,url:identity.url,title:facts.fields.title,priceKind:'item',priceCents:second.priceCents,currency:'EUR',account:{profileId:facts.profileId,memberId:initial.memberId,profileURL:initial.profileURL,verified:true},seller:{profileId:facts.profileId,...second.seller,verified:true},ownedByCurrentAccount:true,photos:{verified:true,count:facts.photos.count,signature:second.signature}}:null;
   summary.message=summary.verified?'详情表面已核对；尚未关联原提交，也未更新运营记录。':'详情核对未通过；没有关联刊登或改动页面。';
   return {summary,evidence};
  }catch(error){summary.verified=false;summary.code=timedOut?'LISTING_RECEIPT_TIMEOUT':error.code||'LISTING_RECEIPT_FAILED';const detail=timedOut?'商品详情读取超时，未关联原提交':String(error.message||'详情核对失败').slice(0,700);summary.checks.push({name:'详情核验',ok:false,detail});summary.blockers=summary.checks.filter(check=>!check.ok).map(check=>check.detail);summary.checkedAt=new Date(this.now()).toISOString();summary.message='详情核对未通过；没有关联刊登或改动页面。';return {summary,evidence:null};}
  finally{controller?.abort();clearTimeout(timer);signal?.removeEventListener('abort',cancel);contents?.removeListener?.('did-start-navigation',navigation);contents?.removeListener?.('destroyed',cancel);contents?.removeListener?.('render-process-gone',cancel);if(w&&controller&&w.vintedDraftController===controller)w.vintedDraftController=null;}
 }
 async inspect(input,options){return (await this.collect(input,options)).summary;}
}
module.exports={VintedListingReceipt,probeListingDOM,listingURL,priceCents,surface};
