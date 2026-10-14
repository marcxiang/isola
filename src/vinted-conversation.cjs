'use strict';

// Conversation shapes below are an internal evidence contract, not selectors or
// proof that the live Vinted conversation UI has been validated. In particular,
// normalizing renderer/page JSON must never mint a verified commerce event.
const {createHash}=require('node:crypto');
const ORIGIN='https://www.vinted.fr';
const MAX_AGE_MS=30000;
const ACTIONS=Object.freeze({reply:'message',accept_offer:'offer',record_sale:'sale'});
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const error=(code,message)=>Object.assign(new Error(message),{code});
function ensure(ok,message){if(!ok)throw error('CONVERSATION_EVIDENCE_INVALID',message);}
function record(value,name){ensure(value&&typeof value==='object'&&!Array.isArray(value),name+'格式无效');return value;}
function text(value,name,max=160){ensure(typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value),name+'无效');return value;}
function identifier(value,name){text(value,name,120);ensure(/^[\p{L}\p{N}_.:-]+$/u.test(value),name+'无效');return value;}
function numericId(value,name){text(value,name,30);ensure(/^[1-9]\d*$/.test(value),name+'无效');return value;}
function timestamp(value,name){text(value,name,30);ensure(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value)),name+'无效');const normalized=new Date(value).toISOString();ensure(normalized===value||normalized===value.replace(/Z$/,'.000Z'),name+'无效');return normalized;}
function exactPageURL(value,name='页面地址'){
 text(value,name,2048);let url;try{url=new URL(value);}catch{throw error('CONVERSATION_EVIDENCE_INVALID',name+'无效');}
 ensure(url.origin===ORIGIN&&!url.username&&!url.password&&!url.search&&!url.hash&&url.href===value,name+'必须是无参数的法国 Vinted 地址');return url;
}
function entityURL(value,type,id){const url=exactPageURL(value);const pattern=type==='member'?/^\/member\/([1-9]\d*)(?:-[^/]+)?\/?$/:/^\/items\/([1-9]\d*)(?:-[^/]+)?\/?$/;ensure(pattern.exec(url.pathname)?.[1]===id,'可见链接与'+type+'编号不一致');return url.href;}
function identity(input,name){record(input,name);const memberId=numericId(input.memberId,name+'编号');return {memberId,username:text(input.username,name+'用户名',100),profileURL:entityURL(input.profileURL,'member',memberId)};}

// Deliberately accepts a single visible EUR amount, never a total with shipping,
// a range, grouping separators, exponent notation or a floating point number.
function euroCents(value){
 if(typeof value!=='string')return null;
 const match=/^(\d{1,7})(?:[,.](\d{1,2}))?[ \u00a0\u202f]?€$/.exec(value.trim());
 if(!match)return null;
 const cents=Number(match[1])*100+Number((match[2]||'').padEnd(2,'0'));
 return Number.isSafeInteger(cents)&&cents>0&&cents<=100000000?cents:null;
}

function normalizeConversationEvidence(raw){
 record(raw,'对话证据');ensure(raw.schemaVersion===1,'对话证据版本不支持');
 const profileId=identifier(raw.profileId,'环境编号'),tabId=identifier(raw.tabId,'标签编号'),documentKey=text(raw.documentKey,'页面编号',100);
 const observedAt=timestamp(raw.observedAt,'读取时间'),url=exactPageURL(raw.url).href;
 const account=identity(raw.account,'当前账号'),conversation=record(raw.conversation,'对话');
 ensure(raw.account.documentKey===documentKey,'账号回执不属于同一页面');
 const conversationId=identifier(conversation.id,'对话编号'),conversationURL=exactPageURL(conversation.url,'对话地址').href;
 ensure(conversationURL===url,'当前页面与对话地址不一致');
 const buyer=identity(conversation.buyer,'买家');ensure(buyer.memberId!==account.memberId,'买家不能是当前账号');
 const listingId=numericId(conversation.listingId,'商品编号'),listingURL=entityURL(conversation.listingURL,'items',listingId);
 const event=record(raw.event,'页面事件');ensure(['message','offer','sale'].includes(event.type),'页面事件类型无效');
 const id=identifier(event.id,'事件编号');
 ensure(event.conversationId===conversationId&&event.listingId===listingId&&event.buyerMemberId===buyer.memberId,'事件没有唯一关联当前对话、买家和商品');
 const base={schemaVersion:1,profileId,tabId,documentKey,url,observedAt,account:{...account,documentKey},conversation:{id:conversationId,url:conversationURL,buyer,listingId,listingURL},event:{id,type:event.type,conversationId,listingId,buyerMemberId:buyer.memberId},verified:false,liveVerified:false};
 if(event.type==='message'){
  ensure(['incoming','outgoing','system'].includes(event.direction),'消息方向无法核对');
  ensure(event.direction==='system'?event.authorMemberId===null:event.authorMemberId===(event.direction==='incoming'?buyer.memberId:account.memberId),'消息作者与方向不一致');
  ensure(typeof event.text==='string'&&event.text.trim().length>0&&event.text.length<=6000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(event.text),'消息正文无效');
  ensure(typeof event.alreadyReplied==='boolean','消息回复状态尚未核对');
  Object.assign(base.event,{direction:event.direction,authorMemberId:event.authorMemberId,text:event.text,alreadyReplied:event.alreadyReplied});
 }else{
  ensure(event.currency==='EUR'&&event.priceBasis==='item','金额必须是商品本身的欧元价格');
  const priceCents=euroCents(event.priceText);ensure(priceCents!==null,'商品价格无法按欧分核对');
  ensure(Number.isSafeInteger(event.quantity)&&event.quantity>0&&event.quantity<=100,'商品数量无法核对');
  ensure(typeof event.bundled==='boolean','尚未核对是否为套装订单');
  Object.assign(base.event,{priceText:event.priceText,priceCents,currency:'EUR',priceBasis:'item',quantity:event.quantity,bundled:event.bundled});
  if(event.type==='offer'){
   ensure(['pending','accepted','rejected','cancelled','expired'].includes(event.status),'报价状态无法核对');
   ensure(event.offeredByMemberId===buyer.memberId,'报价不是来自当前买家');
   Object.assign(base.event,{status:event.status,offeredByMemberId:event.offeredByMemberId});
  }else{
   ensure(['awaiting_payment','paid','cancelled','refunded','disputed','completed'].includes(event.status),'成交状态无法核对');
   const orderId=identifier(event.orderId,'订单编号');ensure(orderId===id,'成交事件必须使用原始订单编号');
   const payment=record(event.payment,'付款证据');
   ensure(['unconfirmed','paid-order','offer-accepted'].includes(payment.kind),'付款证据类型无效');
   ensure(payment.orderId===orderId,'付款回执与订单编号不一致');
   const label=text(payment.label,'可见付款状态',300);
   // A button or accepted-offer card does not prove payment. A live adapter must
   // separately validate the observed status label against its verified page contract.
   ensure(event.status!=='paid'||payment.kind==='paid-order','已接受报价不能作为买家已付款证据');
   Object.assign(base.event,{status:event.status,orderId,payment:{kind:payment.kind,orderId,label},paid:event.status==='paid'&&payment.kind==='paid-order'});
  }
 }
 return base;
}

// This reports missing conditions for a future live adapter. It never authorizes
// a click or emits verified:true, even if the caller supplies such JSON fields.
function guardConversationAction(action,raw,expected,{now=Date.now(),maxAgeMs=MAX_AGE_MS}={}){
 const blockers=[],add=(code,message)=>blockers.push({code,message});let evidence;
 if(!own(ACTIONS,action))add('ACTION_UNSUPPORTED','不支持的对话操作');
 try{evidence=normalizeConversationEvidence(raw);}catch(cause){add(cause.code||'CONVERSATION_EVIDENCE_INVALID',cause.message);}
 const expectedValid=expected&&typeof expected==='object'&&!Array.isArray(expected);
 if(!expectedValid)add('EXPECTED_CONTEXT_MISSING','缺少保存的账号、商品和原始事件记录');
 if(evidence&&expectedValid){
  const event=evidence.event,conversation=evidence.conversation;
  const matches=[['profileId',evidence.profileId],['tabId',evidence.tabId],['documentKey',evidence.documentKey],['conversationId',conversation.id],['conversationURL',conversation.url],['listingId',conversation.listingId],['buyerMemberId',conversation.buyer.memberId],['buyerUsername',conversation.buyer.username],['eventId',event.id]];
  for(const [key,value]of matches)if(expected[key]!==value)add('CONTEXT_CHANGED','当前'+key+'与保存的任务不一致');
  const account=expected.account;
  if(!account||account.memberId!==evidence.account.memberId||account.username!==evidence.account.username||account.profileURL!==evidence.account.profileURL||account.profileId!==evidence.profileId)add('ACCOUNT_CHANGED','当前登录账号与该环境绑定不一致');
  if(!Number.isFinite(now)||!Number.isFinite(maxAgeMs)||maxAgeMs<0||maxAgeMs>MAX_AGE_MS||now-Date.parse(evidence.observedAt)<0||now-Date.parse(evidence.observedAt)>maxAgeMs)add('EVIDENCE_STALE','页面证据已过期或时间无效');
  if(expected.attemptCount!==0||expected.mutationPending!==false)add('PRIOR_ATTEMPT_UNRESOLVED','缺少无历史尝试回执，或已有尚未核对的执行记录');
  if(event.type!==ACTIONS[action])add('EVENT_TYPE_MISMATCH','页面事件类型与待执行步骤不一致');
  if(raw.challenge!==false||raw.dialogs!==0||raw.busy!==false)add('PAGE_NOT_READY','验证、弹窗或页面加载状态未排除');
  if(action==='reply'){
   if(expected.autoReply!==true)add('REPLY_DISABLED','该计划没有启用自动回复');
   if(event.direction!=='incoming'||event.alreadyReplied!==false)add('MESSAGE_NOT_PENDING','该消息不是尚未回复的买家消息');
   if(expected.messageText!==event.text)add('MESSAGE_CHANGED','消息正文已改变');
  }
  if(action==='accept_offer'||action==='record_sale'){
   if(event.quantity!==1||event.bundled!==false)add('MULTIPLE_ITEMS','仅能处理已确认的单件非套装商品');
   if(!Number.isSafeInteger(expected.minOfferCents)||expected.minOfferCents<1||!Number.isSafeInteger(expected.listingPriceCents)||expected.listingPriceCents<expected.minOfferCents)add('PRICE_POLICY_MISSING','最低接受价或刊登价尚未明确');
   else if(event.priceCents<expected.minOfferCents||event.priceCents>expected.listingPriceCents)add('PRICE_OUTSIDE_POLICY','商品金额不在已保存价格范围内');
   if(expected.priceCents!==event.priceCents)add('PRICE_CHANGED','商品金额已改变');
  }
  if(action==='accept_offer'){
   if(expected.autoAcceptOffers!==true)add('OFFERS_DISABLED','该计划没有启用自动接受报价');
   if(event.status!=='pending')add('OFFER_NOT_PENDING','报价已接受、过期或取消，不能再次接受');
  }
  if(action==='record_sale'&&(!event.paid||event.status!=='paid'||event.payment?.kind!=='paid-order'||event.orderId!==expected.orderId))add('PAYMENT_UNVERIFIED','只有订单明确已付款才可记录成交，接受报价不算成交');
 }
 const evidenceReady=blockers.length===0;
 add('LIVE_READER_UNVERIFIED','真实 Vinted 对话和成交页面仍需验证；此证据合同不会启用发送、接受报价或记录成交');
 return {action,evidenceReady,executionAllowed:false,verified:false,liveVerified:false,blockers,evidence:evidence||null};
}

const QUESTIONS=Object.freeze({
 color:[/^(?:quelle est |c'est quoi )?(?:la )?couleur(?: de (?:l'article|cet article|cet accessoire))?$/,/^(?:de )?quelle couleur est (?:l'article|cet article|cet accessoire)$/],
 brand:[/^(?:quelle est |c'est quoi )?(?:la )?marque(?: de (?:l'article|cet article|cet accessoire))?$/,/^(?:de )?quelle marque est (?:l'article|cet article|cet accessoire)$/],
 condition:[/^(?:quel est |c'est quoi )?(?:l')?etat(?: de (?:l'article|cet article|cet accessoire))?$/,/^dans quel etat est (?:l'article|cet article|cet accessoire)$/,/^(?:est[- ]il |c'est |il est )?neuf$/],
 priceCents:[/^(?:quel est |c'est quoi )?(?:le )?prix(?: de (?:l'article|cet article|cet accessoire))?$/,/^combien coute (?:l'article|cet article|cet accessoire)$/],
 availability:[/^(?:est[- ]il |c'est |il est )?(?:toujours |encore )?disponible$/,/^(?:l'article|cet article|cet accessoire) est[- ]il (?:toujours |encore )?disponible$/]
});
const CANONICAL_CONDITIONS=new Set(['Neuf avec étiquette','Neuf sans étiquette','Très bon état','Bon état','Satisfaisant']);
function buildFactualReply(input={}){
 const review=reason=>({factual:false,requiresReview:true,autoSend:false,text:'',reason,sourceFields:[]});
 if(!input||typeof input!=='object'||Array.isArray(input))return review('回复预览资料格式无效');
 const {message,listing={},confirmedFields=[]}=input;
 if(!listing||typeof listing!=='object'||Array.isArray(listing))return review('商品资料格式无效');
 if(typeof message!=='string'||!message.trim()||message.length>6000)return review('消息正文无效');
 let question=message.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim();
 question=question.replace(/^(?:bonjour|bonsoir|salut)(?:\s*[,!.]\s*|\s+|$)/,'').trim().replace(/[?.!]+$/,'').trim();
 if(!question)return {factual:true,requiresReview:false,autoSend:false,text:'Bonjour ! Comment puis-je vous aider ?',reason:'greeting',sourceFields:[]};
 const keys=Object.entries(QUESTIONS).filter(([,patterns])=>patterns.some(pattern=>pattern.test(question))).map(([key])=>key);
 if(keys.length!==1)return review('问题含有未知或多项要求；兼容型号、材质、运费、发货时间和议价需要核对');
 const field=keys[0];
 if(!Array.isArray(confirmedFields)||!confirmedFields.includes(field)||!own(listing,field))return review('回答所需的商品资料尚未确认');
 const value=listing[field];let reply;
 if(field==='priceCents'){
  if(!Number.isSafeInteger(value)||value<1||value>100000000)return review('刊登价格无效');
  reply=`Le prix de l’article est de ${Math.floor(value/100)},${String(value%100).padStart(2,'0')} €, hors frais affichés par Vinted.`;
 }else if(field==='availability'){
  if(value!=='available')return review('商品当前在售状态尚未确认');reply='L’article est disponible.';
 }else{
  if(typeof value!=='string'||value.trim()!==value||!value||value.length>100||!/^[-\p{L}\p{N} '&(),]+$/u.test(value))return review('商品字段不是可直接复述的已确认短语');
  if(field==='condition'&&!CANONICAL_CONDITIONS.has(value))return review('商品成色尚未对应明确的法国站选项');
  reply=field==='color'?`La couleur indiquée est « ${value} ».`:field==='brand'?`La marque indiquée est « ${value} ».`:`L’état indiqué est « ${value} ».`;
 }
 return {factual:true,requiresReview:false,autoSend:false,text:reply,reason:'confirmed-product-field',sourceFields:[field],factsHash:createHash('sha256').update(JSON.stringify({field,value})).digest('hex')};
}

// Isolated-world, read-only observation of explicitly supplied *current snapshot*
// nodes. No page-world state, guessed platform selectors, hidden fields, clicks,
// forms or arbitrary input values are read. Static message ownership and paid
// status are deliberately NOT inferred from this generic observation alone.
function probeConversationDOM(contract){
 const d=globalThis.__isolaDOM,map=globalThis.__isolaElements,documentKey=String(performance.timeOrigin);
 const fail=reason=>({verified:false,liveVerified:false,complete:false,documentKey,reason,observations:[]});
 if(!d||!map||!contract||contract.documentKey!==documentKey||!Array.isArray(contract.bindings)||contract.bindings.length<1||contract.bindings.length>30)return fail('invalid-contract');
 let page;try{page=new URL(location.href);}catch{return fail('wrong-site');}
 if(page.origin!=='https://www.vinted.fr'||page.username||page.password)return fail('wrong-site');
 const ids=new Set(),keys=new Set(),observations=[];
 for(const binding of contract.bindings){
  if(!binding||typeof binding.key!=='string'||!/^[-a-zA-Z0-9_]{1,40}$/.test(binding.key)||keys.has(binding.key)||typeof binding.elementId!=='string'||!/^e\d+-\d+$/.test(binding.elementId)||ids.has(binding.elementId)||!['text','link'].includes(binding.read)||typeof binding.tag!=='string'||typeof binding.label!=='string'||binding.label.length>180)return fail('invalid-binding');
  keys.add(binding.key);ids.add(binding.elementId);
  const node=map.get(binding.elementId);
  if(!node?.isConnected||!d.visible(node)||node.tagName.toLowerCase()!==binding.tag||String(d.label(node)).replace(/\s+/g,' ').trim()!==binding.label)return fail('stale-or-hidden-node');
  if(d.closest(node,'input,textarea,select,[contenteditable],script,style,noscript,[hidden],[aria-hidden="true"]'))return fail('protected-node');
  const value=String(d.safeText(node,6001));if(value.length>6000)return fail('text-too-long');
  const observation={key:binding.key,elementId:binding.elementId,tag:binding.tag,label:binding.label,text:value,disabled:!!d.disabled(node)};
  if(binding.read==='link'){
   let link;try{link=new URL(node.href);}catch{return fail('invalid-link');}
   if(node.tagName!=='A'||link.origin!==page.origin||link.username||link.password||link.search||link.hash)return fail('foreign-or-ambiguous-link');
   observation.href=link.href;
  }
  observations.push(observation);
 }
 return {verified:false,liveVerified:false,complete:false,url:page.href,documentKey,observations,reason:'live-conversation-ownership-unverified'};
}

// Diagnostics for the current page only. Reading an arbitrary member link must
// never identify the signed-in seller, and a visible amount must never be
// classified as an offer or payment without the real page's ownership evidence.
class VintedConversationObserver{
 constructor(adapter,{timeoutMs=10000,now=Date.now}={}){
  if(!adapter?.current||!adapter?.read||!adapter?.control?.isolated)throw new TypeError('VintedAdapter is required');
  this.adapter=adapter;this.timeoutMs=Math.max(20,Math.min(10000,timeoutMs));this.now=now;
 }
 async wait(work,context){
  if(context.signal.aborted)throw error('STOPPED','对话页面读取已停止');let cancel;
  const aborted=new Promise((_,reject)=>{cancel=()=>reject(error('STOPPED','对话页面读取已停止'));context.signal.addEventListener('abort',cancel,{once:true});});
  try{return await Promise.race([Promise.resolve().then(()=>{if(context.signal.aborted)throw error('STOPPED','对话页面读取已停止');return work();}),aborted]);}
  finally{context.signal.removeEventListener('abort',cancel);}
 }
 async readPass(profileId,context){
  const guard=()=>this.adapter.current(profileId,context),page=await this.wait(()=>this.adapter.read(profileId,context),context);guard();
  const url=exactPageURL(page.url).href;ensure(Array.isArray(page.elements),'页面控件快照无效');
  const documentKey=await this.wait(()=>this.adapter.control.isolated(context.tab,'String(performance.timeOrigin)'),context);guard();text(documentKey,'页面编号',100);
  const candidates=[];
  for(const node of page.elements){
   if(node.sensitive||typeof node.id!=='string'||!/^e\d+-\d+$/.test(node.id)||typeof node.label!=='string'||!node.label.trim())continue;
   if(node.tag==='a'){
    let href;try{href=exactPageURL(node.href);}catch{continue;}
    const kind=/^\/items\/[1-9]\d*(?:-[^/]+)?\/?$/.test(href.pathname)?'item-link':/^\/member\/[1-9]\d*(?:-[^/]+)?\/?$/.test(href.pathname)?'member-link':null;
    if(kind)candidates.push({node,kind,read:'link'});
   }else if(node.tag==='button')candidates.push({node,kind:'control',read:'text'});
  }
  const selected=candidates.slice(0,30),contract={documentKey,bindings:selected.map(({node,read},index)=>({key:'observed_'+index,elementId:node.id,tag:node.tag,label:node.label.replace(/\s+/g,' ').trim(),read}))};
  let observations=[];
  if(selected.length){
   const probe=await this.wait(()=>this.adapter.control.isolated(context.tab,'('+probeConversationDOM.toString()+')('+JSON.stringify(contract)+')'),context);guard();
   ensure(probe?.reason==='live-conversation-ownership-unverified'&&probe.url===url&&probe.documentKey===documentKey&&Array.isArray(probe.observations)&&probe.observations.length===selected.length,'页面节点已改变，未取得完整的只读观察');
   observations=probe.observations.map((item,index)=>{const {elementId,key,...rest}=item;return {kind:selected[index].kind,...rest};});
  }
  return {url,documentKey,observations,truncated:candidates.length>30};
 }
 async inspect(profileId,{signal,controller:providedController,tab:providedTab}={}){
  const controller=providedController||new AbortController();if(!controller?.signal||typeof controller.abort!=='function')throw new TypeError('AbortController is required');
  const cancel=()=>controller.abort(),context={signal:controller.signal,controller,tab:providedTab};let w,contents,timer,ownsLock=false,timedOut=false;
  if(signal?.aborted||context.signal.aborted)throw error('STOPPED','对话页面读取已停止');signal?.addEventListener('abort',cancel,{once:true});
  const navigated=(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame!==false)cancel();};
  try{
   const selected=this.adapter.current(profileId,context);w=selected.w;context.tab=selected.tab;contents=selected.tab.view.webContents;
   ownsLock=w.vintedDraftController!==controller;if(ownsLock)w.vintedDraftController=controller;
   contents.on?.('did-start-navigation',navigated);contents.on?.('destroyed',cancel);contents.on?.('render-process-gone',cancel);
   timer=setTimeout(()=>{timedOut=true;cancel();},this.timeoutMs);
   const first=await this.readPass(profileId,context),second=await this.readPass(profileId,context);this.adapter.current(profileId,context);
   if(JSON.stringify(first)!==JSON.stringify(second))throw error('CONVERSATION_PAGE_CHANGED','两次读取的对话页面内容不一致，请重新读取');
   return {...second,profileId,tabId:context.tab.id,checkedAt:new Date(this.now()).toISOString(),consistentReads:2,verified:false,liveVerified:false,complete:false,accountVerified:false,conversationVerified:false,actionableEvents:[],message:'已只读核对当前可见链接和控件；消息、报价及付款归属仍待真实页面验证，没有发送消息或点击交易按钮。'};
  }catch(cause){if(timedOut)throw error('CONVERSATION_TIMEOUT','对话页面读取超时，没有发送消息或接受报价');throw cause;}
  finally{
   clearTimeout(timer);signal?.removeEventListener('abort',cancel);contents?.removeListener?.('did-start-navigation',navigated);contents?.removeListener?.('destroyed',cancel);contents?.removeListener?.('render-process-gone',cancel);
   if(ownsLock&&w?.vintedDraftController===controller)w.vintedDraftController=null;
  }
 }
}

module.exports={normalizeConversationEvidence,guardConversationAction,buildFactualReply,probeConversationDOM,VintedConversationObserver,euroCents,MAX_AGE_MS};
