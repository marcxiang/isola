'use strict';

const {createHash,randomUUID}=require('node:crypto');
const {isEnvironmentSessionAccount,assertEnvironmentSessionAuthority}=require('./commerce-session-authority.cjs');

const ORIGIN='https://www.vinted.fr',FORM_URL=ORIGIN+'/items/new';
const VERSION=1,MAX_PROOF_AGE_MS=15000,MAX_RECEIPT_AGE_MS=30000;
const FIELD_KEYS=Object.freeze(['title','description','categoryPath','priceCents','condition','brand','color','parcel']);
const issuedProofs=new WeakSet();
const reviewedOrigins=new WeakSet();
const clone=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))??'undefined').digest('hex');
function fail(code,message,ambiguous=false){const error=Error(message);error.code=code;error.ambiguous=ambiguous;throw error;}
function object(value,label){if(!value||typeof value!=='object'||Array.isArray(value))fail('PUBLICATION_INVALID',label+'格式无效');return value;}
function string(value,label,max=200,multiline=false){if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/:/[\u0000-\u001f\u007f]/).test(value))fail('PUBLICATION_INVALID',label+'无效');return value;}
function integer(value,label,min=0,max=100000000){if(!Number.isSafeInteger(value)||value<min||value>max)fail('PUBLICATION_INVALID',label+'无效');return value;}
function listingRevision(value){return value===undefined?0:integer(value,'重新刊登版本',0,100000000);}
function listingJobKey(planId,cycle,revision=0){string(planId,'计划编号');integer(cycle,'刊登周期',0,999);revision=listingRevision(revision);return 'listing:'+planId+':'+cycle+(revision?':r'+revision:'');}
function isPublicationOpen(record){return !!record&&record.state!=='cancelled'&&!record.closedSale&&!record.closedWithdrawal;}
function timestamp(value,label){const result=Date.parse(value);if(typeof value!=='string'||!Number.isFinite(result)||new Date(result).toISOString()!==value)fail('PUBLICATION_INVALID',label+'时间无效');return result;}
function fresh(value,current,maxAge){integer(current,'当前时间',0,8640000000000000);const observed=timestamp(value,'页面核对');if(observed>current||current-observed>maxAge)fail('PUBLICATION_STALE','页面核对已过期，请重新读取全部刊登证据');return observed;}
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function exact(value,expected,label){if(digest(value)!==digest(expected))fail('PUBLICATION_MISMATCH',label+'与销售计划或当前页面不一致');}
function sameDocument(value,documentKey,label){if(value!==documentKey)fail('PUBLICATION_PAGE_CHANGED',label+'不属于同一次商品页面');}
function noEntries(value,label){if(!Array.isArray(value)||value.length)fail('PUBLICATION_INCOMPLETE',label+'尚未全部核对');}
function boundedDispatch(dispatch,intent,{signal,timeoutMs}){
 return new Promise((resolve,reject)=>{
  let settled=false;const finish=(callback,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);callback(value);};
  const cancel=()=>finish(reject,Error('Publication cancelled')),timer=setTimeout(()=>finish(reject,Error('Publication timed out')),timeoutMs);
  signal?.addEventListener('abort',cancel,{once:true});
  Promise.resolve().then(()=>{if(signal?.aborted)throw Error('Publication cancelled');return dispatch(intent);}).then(value=>finish(resolve,value),error=>finish(reject,error));
 });
}
function frenchURL(value){let url;try{url=new URL(value);}catch{fail('PUBLICATION_INVALID','Vinted 地址无效');}if(url.origin!==ORIGIN||url.username||url.password||url.search||url.hash)fail('PUBLICATION_INVALID','只能核对无额外参数的法国 Vinted 地址');return url;}
function account(value,profileId,{verified=false}={}){
 if(value?.kind==='environment-session'){
  if(!isEnvironmentSessionAccount(value,profileId))fail('PUBLICATION_INVALID','环境会话刊登绑定无效');
  return {kind:'environment-session',profileId};
 }
 object(value,'账号');if(verified&&value.verified!==true)fail('PUBLICATION_ACCOUNT_UNVERIFIED','当前登录账号尚未验证');
 if(value.kind!==undefined)fail('PUBLICATION_INVALID','未知刊登账号绑定类型');
 exact(value.profileId,profileId,'账号所属环境');const memberId=string(value.memberId,'会员编号',30);
 if(!/^[1-9]\d{0,29}$/.test(memberId))fail('PUBLICATION_INVALID','会员编号格式无效');
 const url=frenchURL(value.profileURL),match=url.pathname.match(/^\/member\/([1-9]\d{0,29})(?:-[^/]+)?\/?$/);
 if(!match||match[1]!==memberId)fail('PUBLICATION_ACCOUNT_UNVERIFIED','会员地址与当前账号编号不一致');
 // A canonical member identity avoids treating a changed display name as a different account.
 return {profileId,memberId,profileURL:ORIGIN+'/member/'+memberId};
}
function samePublicationOwner(a,b){return a.profileId===b.profileId||!isEnvironmentSessionAccount(a)&&!isEnvironmentSessionAccount(b)&&a.memberId===b.memberId;}
function listingFields(plan){
 const listing=object(plan.listing,'刊登内容'),fields={};
 for(const key of ['title','description','condition','brand','color','parcel'])fields[key]=string(listing[key],key,key==='description'?5000:key==='title'?100:180,key==='description');
 if(!['Petit','Moyen','Grand'].includes(fields.parcel))fail('PUBLICATION_INVALID','包裹大小必须是已确认的 Vinted 规格');
 if(!Array.isArray(listing.categoryPath)||!listing.categoryPath.length||listing.categoryPath.length>10)fail('PUBLICATION_INVALID','必须提供完整已核对的分类路径');
 fields.categoryPath=listing.categoryPath.map(value=>string(value,'分类',180));
 fields.priceCents=integer(plan.listingPriceCents,'刊登价',1);
 if(listing.size!==undefined&&listing.size!==null&&listing.size!=='')fields.size=string(listing.size,'尺码',180);
 return fields;
}

// This is a main-process contract, not an IPC validator. Evidence must be collected
// by the adapter from observed DOM controls; renderer-supplied "verified" flags
// confer no authority. Creating a proof performs no browser or network action.
function buildPublicationProof({plan,product,claim,expectedAccount,evidence},{now=Date.now()}={}){
 object(plan,'计划');object(product,'货盘商品');object(claim,'照片认领');object(evidence,'页面证据');
 const profileId=string(plan.profileId,'环境编号'),planId=string(plan.id,'计划编号'),productId=string(plan.productId,'商品编号'),sku=string(plan.sku,'SKU');
 if(plan.enabled!==true||plan.activeListingId)fail('PUBLICATION_PLAN_BLOCKED','计划已暂停或已有在售商品，不能再次刊登');
 const cycle=integer(plan.completedCount,'已售数量',0,1000),target=integer(plan.targetCount,'销售目标',1,1000),revision=listingRevision(plan.listingRevision);
 if(cycle>=target)fail('PUBLICATION_PLAN_BLOCKED','累计销售目标已达到');
 if(plan.currency!=='EUR')fail('PUBLICATION_MISMATCH','法国站刊登币种必须是 EUR');
 exact(product.id,productId,'货盘商品');exact(product.sku,sku,'货盘 SKU');integer(product.stock,'可售库存',1);
 if(isEnvironmentSessionAccount(expectedAccount,profileId))assertEnvironmentSessionAuthority(expectedAccount,profileId);
 const expected=account(expectedAccount,profileId),observed=account(evidence.account,profileId,{verified:true});exact(observed,expected,'刊登所属环境会话');
 exact(evidence.profileId,profileId,'当前环境');if(evidence.url!==FORM_URL)fail('PUBLICATION_PAGE_CHANGED','只能从法国站全新商品页发布');
 const documentKey=string(evidence.documentKey,'商品页面编号'),tabId=string(evidence.tabId,'标签编号');
 fresh(evidence.observedAt,now,MAX_PROOF_AGE_MS);
 if(evidence.challenge!==false)fail('PUBLICATION_CHALLENGE','页面有验证或拦截，不能继续自动刊登');
 const form=object(evidence.form,'表单证据');sameDocument(form.documentKey,documentKey,'商品字段');
 if(form.complete!==true)fail('PUBLICATION_INCOMPLETE','表单全部必填项尚未验证');
 noEntries(form.invalidFields,'无效字段');noEntries(form.unknownFields,'未知商品字段');
 const expectedFields=listingFields(plan),keys=Object.keys(expectedFields);
 if(!Array.isArray(form.fields)||form.fields.length!==keys.length||new Set(form.fields.map(field=>field?.field)).size!==keys.length)fail('PUBLICATION_INCOMPLETE','刊登字段数量或唯一性无法核对');
 for(const key of keys){const field=form.fields.find(field=>field?.field===key);if(!field||field.verified!==true)fail('PUBLICATION_INCOMPLETE',key+' 未经页面核对');exact(field.value,expectedFields[key],key);}
 const claimId=string(claim.id,'照片认领编号'),setId=string(claim.setId,'照片套组编号');
 exact(claim.profileId,profileId,'照片所属环境');exact(claim.productId,productId,'照片所属商品');
 if(!Array.isArray(claim.images)||!claim.images.length||claim.images.length>20)fail('PUBLICATION_INCOMPLETE','照片认领清单无效');
 const photos=object(evidence.photos,'照片回执');
 for(const [key,value] of Object.entries({claimId,setId,productId,profileId,count:claim.images.length}))exact(photos[key],value,'照片 '+key);
 sameDocument(photos.documentKey,documentKey,'已上传照片');
 if(photos.verified!==true||photos.busy!==false||photos.errorCount!==0)fail('PUBLICATION_INCOMPLETE','照片尚未取得完整且稳定的上传回执');
 const signature=string(photos.signature,'照片回执摘要',64);if(!/^[a-f0-9]{64}$/.test(signature))fail('PUBLICATION_INVALID','照片摘要格式无效');
 const publication=object(evidence.publication,'发布按钮');sameDocument(publication.documentKey,documentKey,'发布按钮');
 if(publication.count!==1||publication.label!=='Ajouter'||publication.enabled!==true||publication.observed!==true)fail('PUBLICATION_INCOMPLETE','未找到唯一且可操作的已核对发布按钮');
 const facts={planId,profileId,productId,sku,cycle,...(revision?{listingRevision:revision}:{}),currency:'EUR',account:expected,tabId,documentKey,url:FORM_URL,fields:expectedFields,photos:{claimId,setId,count:claim.images.length,signature}};
 const proof=freeze({version:VERSION,id:randomUUID(),observedAt:evidence.observedAt,expiresAt:new Date(Date.parse(evidence.observedAt)+MAX_PROOF_AGE_MS).toISOString(),facts,fingerprint:digest(facts)});
 issuedProofs.add(proof);return proof;
}
function validProof(proof,{now=Date.now(),issued=false,freshness=true}={}){
 object(proof,'发布证据');if(issued&&!issuedProofs.has(proof))fail('PUBLICATION_UNTRUSTED','发布证据必须由主进程从当前页面重新核对');
 if(proof.version!==VERSION||proof.fingerprint!==digest(proof.facts))fail('PUBLICATION_CORRUPT','发布证据损坏或发生变化');
 string(proof.id,'证据编号');timestamp(proof.observedAt,'证据');
 if(timestamp(proof.expiresAt,'证据期限')!==Date.parse(proof.observedAt)+MAX_PROOF_AGE_MS)fail('PUBLICATION_CORRUPT','发布证据有效期无效');
 if(freshness)fresh(proof.observedAt,now,MAX_PROOF_AGE_MS);
 const facts=object(proof.facts,'发布绑定');
 for(const key of ['planId','profileId','productId','sku','tabId','documentKey'])string(facts[key],key);
 integer(facts.cycle,'刊登周期',0,999);account(facts.account,facts.profileId);
 if(facts.listingRevision!==undefined)integer(facts.listingRevision,'重新刊登版本',1,100000000);
 if(facts.url!==FORM_URL||facts.currency!=='EUR')fail('PUBLICATION_CORRUPT','发布站点或币种无效');
 const fields=listingFields({listing:facts.fields,listingPriceCents:facts.fields?.priceCents});exact(facts.fields,fields,'刊登证据');
 string(facts.photos?.claimId,'照片认领编号');string(facts.photos?.setId,'照片套组编号');integer(facts.photos?.count,'照片数量',1,20);
 if(!/^[a-f0-9]{64}$/.test(facts.photos?.signature||''))fail('PUBLICATION_CORRUPT','照片回执摘要无效');
 return proof;
}
function listingIdentity(id,url){
 string(id,'平台刊登编号',30);if(!/^[1-9]\d{0,29}$/.test(id))fail('PUBLICATION_RECEIPT_INVALID','平台刊登编号格式无效');
 const parsed=frenchURL(url),match=parsed.pathname.match(/^\/items\/([1-9]\d{0,29})(?:-[^/]+)?\/?$/);
 if(!match||match[1]!==id)fail('PUBLICATION_RECEIPT_INVALID','刊登结果地址与编号不一致');
 return {listingId:id,url:ORIGIN+'/items/'+id};
}

// No production completion selector is assumed here. The adapter must first
// establish a real mapping for seller identity, item-only price, images and live
// status. A click acknowledgement, toast or changed URL alone is insufficient.
function validatePublicationReceipt(record,evidence,{now=Date.now(),freshness=true}={}){
 object(record,'提交记录');object(evidence,'刊登结果');const facts=validProof(record.proof,{freshness:false}).facts;
 if(record.closedWithdrawal)fail('PUBLICATION_WITHDRAWN','原刊登已经由操作员确认删除，不能重新关联为在售');
 if(!['dispatching','uncertain','published'].includes(record.state)||record.attemptCount!==1)fail('PUBLICATION_NOT_SUBMITTED','当前记录尚未提交，不能认定已经刊登');
 timestamp(record.submittedAt,'刊登提交');
 if(evidence.verified!==true||evidence.mappingVerified!==true||evidence.publicationStatus!=='published')fail('PUBLICATION_RECEIPT_UNVERIFIED','刊登完成页面尚未按真实网页验证');
 if(freshness)fresh(evidence.observedAt,now,MAX_RECEIPT_AGE_MS);else timestamp(evidence.observedAt,'刊登结果');
 if(Date.parse(evidence.observedAt)<Date.parse(record.submittedAt))fail('PUBLICATION_RECEIPT_INVALID','刊登结果早于本次提交');
 exact(evidence.profileId,facts.profileId,'结果所属环境');
 const current=account(evidence.account,facts.profileId,{verified:true});exact(current,facts.account,'结果页面登录账号');
 if(!isEnvironmentSessionAccount(facts.account,facts.profileId)){const seller=account(evidence.seller,facts.profileId,{verified:true});exact(seller,facts.account,'实际卖家');}
 if(evidence.ownedByCurrentAccount!==true)fail('PUBLICATION_RECEIPT_UNVERIFIED','尚未确认刊登属于当前账号');
 const identity=listingIdentity(evidence.listingId,evidence.url),origin=object(evidence.origin,'原提交归属');
 const reviewed=origin.kind==='operator_reviewed_listing';
 if((origin.kind!=='observed_submission_navigation'&&!reviewed)||origin.submissionId!==record.id||origin.formDocumentKey!==facts.documentKey)fail('PUBLICATION_RECEIPT_UNATTRIBUTED','此刊登尚未与原提交建立可验证关联');
 if(isEnvironmentSessionAccount(facts.account,facts.profileId)&&!reviewed){
  const captured=(record.navigation||[]).find(row=>row.kind==='observed_submission_navigation'&&row.committed===true&&row.submissionId===record.id&&row.profileId===facts.profileId&&row.tabId===facts.tabId&&row.formDocumentKey===facts.documentKey&&row.listingId===identity.listingId&&row.url===identity.url&&digest(row)===digest(origin));
  if(!captured)fail('PUBLICATION_RECEIPT_UNATTRIBUTED','环境会话刊登缺少原提交已持久保存的同标签跳转回执；不会重复发布');
 }
 if(reviewed){
  if(!reviewedOrigins.has(origin))fail('PUBLICATION_RECEIPT_UNATTRIBUTED','操作员关联必须来自主进程的一次性核对');
  string(origin.reviewId,'核对编号');string(origin.listingDocumentKey,'详情页面编号');string(origin.tabId,'详情标签编号');
  fresh(origin.reviewedAt,now,MAX_RECEIPT_AGE_MS);
 }
 if(evidence.priceKind!=='item'||evidence.priceCents!==facts.fields.priceCents||evidence.currency!==facts.currency)fail('PUBLICATION_RECEIPT_INVALID','实际单品售价或币种与计划不一致');
 exact(evidence.title,facts.fields.title,'实际刊登标题');
 if(evidence.photos?.verified!==true||evidence.photos?.count!==facts.photos.count||evidence.photos?.signature!==facts.photos.signature)fail('PUBLICATION_RECEIPT_INVALID','实际刊登照片与本次上传不一致');
 return {...identity,verified:true,profileId:facts.profileId,...(isEnvironmentSessionAccount(facts.account,facts.profileId)?{account:clone(facts.account)}:{memberId:facts.account.memberId}),priceCents:facts.fields.priceCents,currency:facts.currency,title:facts.fields.title,imageCount:facts.photos.count,photoSignature:facts.photos.signature,observedAt:evidence.observedAt,...(reviewed?{origin:clone(origin)}:{})};
}

// Main-only: called after consuming a review capability and re-reading the same
// listing document. A renderer-created origin can never pass the WeakSet check.
function operatorReviewedEvidence(record,evidence,{reviewId,documentKey,tabId},now=Date.now()){
 const origin=Object.freeze({kind:'operator_reviewed_listing',submissionId:record.id,formDocumentKey:record.proof.facts.documentKey,reviewId,listingDocumentKey:documentKey,tabId,reviewedAt:new Date(now).toISOString()});
 reviewedOrigins.add(origin);return {...evidence,origin};
}

function validateSaleClosure(record,evidence,{now=Date.now(),freshness=true}={}){
 object(evidence,'成交回执');const facts=record.proof.facts;
 if(isEnvironmentSessionAccount(facts.account,facts.profileId))fail('PUBLICATION_SALE_UNVERIFIED','环境会话刊登没有会员成交核验，不会自动记为成交');
 if(record.closedWithdrawal)fail('PUBLICATION_WITHDRAWN','原刊登已经确认删除，不能计为成交');
 if(record.state!=='published'||!record.receipt||evidence.verified!==true||evidence.paid!==true||evidence.cancelled!==false||evidence.quantity!==1)fail('PUBLICATION_SALE_UNVERIFIED','只有已经核对的单件已付款成交才能解除在售占用');
 if(freshness)fresh(evidence.observedAt,now,MAX_RECEIPT_AGE_MS);else timestamp(evidence.observedAt,'成交回执');
 if(Date.parse(evidence.observedAt)<Date.parse(record.submittedAt))fail('PUBLICATION_SALE_UNVERIFIED','成交回执早于刊登提交');
 if(evidence.profileId!==facts.profileId||evidence.memberId!==facts.account.memberId||evidence.listingId!==record.receipt.listingId||evidence.currency!==facts.currency)fail('PUBLICATION_SALE_UNVERIFIED','成交所属账号、原刊登或币种不一致');
 const orderId=string(evidence.orderId,'平台成交编号'),priceCents=integer(evidence.priceCents,'已付款单品金额',1,facts.fields.priceCents);
 return {verified:true,orderId,profileId:facts.profileId,memberId:facts.account.memberId,listingId:record.receipt.listingId,currency:facts.currency,priceCents,quantity:1,paid:true,cancelled:false,observedAt:evidence.observedAt};
}

// An explicit operator declaration is intentionally separate from a verified
// platform receipt. It retires one submitted attempt without inventing a sale.
function validateDeletionClosure(record,evidence,{now=Date.now(),freshness=true}={}){
 object(evidence,'删除确认');const facts=record.proof.facts;
 if(record.closedSale||!['uncertain','published'].includes(record.state)||record.attemptCount!==1)fail('PUBLICATION_DELETION_BLOCKED','只有已经提交、尚未成交且未在执行的原刊登可以确认删除');
 if(evidence.kind!=='operator_confirmed_deletion'||evidence.confirmed!==true||evidence.reason!=='deleted_not_sold'||evidence.verified!==undefined||evidence.webVerified!==undefined)fail('PUBLICATION_DELETION_INVALID','必须明确确认原刊登已删除且并未售出');
 const reviewId=string(evidence.reviewId,'删除确认编号'),confirmed=timestamp(evidence.confirmedAt,'删除确认'),submitted=timestamp(record.submittedAt,'刊登提交');
 if(confirmed<submitted||(freshness&&confirmed>now))fail('PUBLICATION_DELETION_INVALID','删除确认时间早于原提交或晚于当前时间');
 if(evidence.profileId!==facts.profileId)fail('PUBLICATION_DELETION_INVALID','删除确认不属于原环境');
 if(isEnvironmentSessionAccount(facts.account,facts.profileId)){exact(evidence.account,facts.account,'删除确认的原环境会话');if(evidence.memberId!==undefined)fail('PUBLICATION_DELETION_INVALID','环境会话删除确认不能虚构会员编号');}
 else if(evidence.memberId!==facts.account.memberId)fail('PUBLICATION_DELETION_INVALID','删除确认不属于原会员');
 const identity=listingIdentity(evidence.listingId,evidence.url);
 if(record.receipt&&record.receipt.listingId!==identity.listingId)fail('PUBLICATION_DELETION_INVALID','删除确认与原刊登回执不一致');
 const candidates=[...new Set((record.navigation||[]).filter(row=>row.committed===true).map(row=>row.listingId).filter(Boolean))];
 if(!record.receipt&&candidates.length&&!(candidates.length===1&&candidates[0]===identity.listingId))fail('PUBLICATION_DELETION_INVALID','删除确认与原提交跳转记录不一致');
 return {kind:'operator_confirmed_deletion',confirmed:true,reason:'deleted_not_sold',reviewId,profileId:facts.profileId,...(isEnvironmentSessionAccount(facts.account,facts.profileId)?{account:clone(facts.account)}:{memberId:facts.account.memberId}),...identity,confirmedAt:evidence.confirmedAt};
}

function restorePublicationState(input,{now=Date.now()}={}){
 const state=input===undefined?{version:VERSION,submissions:[]}:clone(object(input,'发布记录'));
 if(state.version!==VERSION||!Array.isArray(state.submissions)||state.submissions.length>100000)fail('PUBLICATION_CORRUPT','发布记录格式无效，不能自动重建刊登');
 const ids=new Set(),cycles=new Set(),occupancies=[],orders=new Set(),withdrawals=new Set();let recovered=false;
 for(const record of state.submissions){
  object(record,'提交记录');string(record.id,'提交编号');if(ids.has(record.id))fail('PUBLICATION_CORRUPT','重复的刊登提交编号');ids.add(record.id);
  validProof(record.proof,{freshness:false});timestamp(record.createdAt,'提交记录');timestamp(record.updatedAt,'提交更新');
  if(!['prepared','needs_review','dispatching','uncertain','published','cancelled'].includes(record.state)||![0,1].includes(record.attemptCount))fail('PUBLICATION_CORRUPT','刊登状态无效');
  const attempted=['dispatching','uncertain','published'].includes(record.state);
  if(attempted!==(record.attemptCount===1)||attempted&&(!record.submittedAt||timestamp(record.submittedAt,'提交')<Date.parse(record.createdAt)))fail('PUBLICATION_CORRUPT','提交次数与刊登状态不一致');
  if(!attempted&&(record.submittedAt||record.receipt))fail('PUBLICATION_CORRUPT','未提交的刊登存在外部回执');
  if(record.state==='published'){
   const receipt=object(record.receipt,'已发布回执'),facts=record.proof.facts;listingIdentity(receipt.listingId,receipt.url);
   const sessionAccount=isEnvironmentSessionAccount(facts.account,facts.profileId),accountMatches=sessionAccount?receipt.memberId===undefined&&isEnvironmentSessionAccount(receipt.account,facts.profileId):receipt.memberId===facts.account.memberId;
   if(receipt.verified!==true||receipt.profileId!==facts.profileId||!accountMatches||receipt.priceCents!==facts.fields.priceCents||receipt.currency!==facts.currency||receipt.title!==facts.fields.title||receipt.imageCount!==facts.photos.count||receipt.photoSignature!==facts.photos.signature)fail('PUBLICATION_CORRUPT','已发布回执与提交记录不一致');
   if(timestamp(receipt.observedAt,'刊登结果')<Date.parse(record.submittedAt))fail('PUBLICATION_CORRUPT','刊登结果早于本次提交');
   if(receipt.origin){const o=object(receipt.origin,'关联来源');if(o.kind!=='operator_reviewed_listing'||o.submissionId!==record.id||o.formDocumentKey!==facts.documentKey)fail('PUBLICATION_CORRUPT','操作员关联来源无效');for(const key of ['reviewId','listingDocumentKey','tabId'])string(o[key],key);if(timestamp(o.reviewedAt,'关联核对')<Date.parse(record.submittedAt)||Math.abs(Date.parse(o.reviewedAt)-Date.parse(receipt.observedAt))>MAX_RECEIPT_AGE_MS)fail('PUBLICATION_CORRUPT','操作员关联时间无效');}
  }else if(record.receipt)fail('PUBLICATION_CORRUPT','未核对完成的刊登含有完成回执');
  if(record.closedSale){validateSaleClosure(record,record.closedSale,{freshness:false});if(orders.has(record.closedSale.orderId))fail('PUBLICATION_CORRUPT','成交编号重复关联刊登');orders.add(record.closedSale.orderId);}
  if(record.closedWithdrawal){const closure=validateDeletionClosure(record,record.closedWithdrawal,{freshness:false});exact(record.closedWithdrawal,closure,'原删除确认');if(withdrawals.has(closure.reviewId))fail('PUBLICATION_CORRUPT','删除确认编号重复关联刊登');withdrawals.add(closure.reviewId);}
  const cycle=digest([record.proof.facts.planId,record.proof.facts.cycle,listingRevision(record.proof.facts.listingRevision)]);
  if(record.state!=='cancelled'){if(cycles.has(cycle))fail('PUBLICATION_CORRUPT','同一销售周期存在多次刊登');cycles.add(cycle);}
  if(isPublicationOpen(record)){const facts=record.proof.facts;if(occupancies.some(other=>other.sku===facts.sku&&samePublicationOwner(other.account,facts.account)))fail('PUBLICATION_CORRUPT','同一环境会话或账号和 SKU 存在重复的待提交或在售刊登');occupancies.push(facts);}
  if(record.state==='dispatching'){record.state='uncertain';record.reason='上次退出时刊登结果尚未核对；仅允许读取原结果';record.updatedAt=new Date(now).toISOString();recovered=true;}
  if(record.state==='prepared'){record.state='needs_review';record.reason='上次准备的页面证据已失效；取消未提交记录后重新核对页面';record.updatedAt=new Date(now).toISOString();recovered=true;}
 }
 return {state,recovered};
}

// persist(snapshot) must durably fsync+rename the engine snapshot before it
// resolves. Keep one journal per durable database; do not pass renderer data as
// proofs/receipts. The journal never performs a browser action itself.
class PublicationJournal{
 constructor({state,persist,now=Date.now,dispatchEnabled=false}){
  if(typeof persist!=='function'||typeof now!=='function')throw TypeError('PublicationJournal requires persistence and a clock');
  const restored=restorePublicationState(state,{now:now()});this._state=restored.state;this._persist=persist;this._now=now;this.dispatchEnabled=dispatchEnabled===true;this.faulted=false;this._tail=Promise.resolve();
 }
 state(){return clone(this._state);}
 get(id){const record=this._state.submissions.find(record=>record.id===id);if(!record)fail('PUBLICATION_NOT_FOUND','找不到原刊登提交记录');return clone(record);}
 _atomic(work){
  const task=this._tail.then(async()=>{
   if(this.faulted)fail('PUBLICATION_STORAGE_FAILED','刊登存储失败，已停止所有外部动作');
   const next=clone(this._state),result=work(next);
   try{await this._persist(clone(next));}catch{this.faulted=true;fail('PUBLICATION_STORAGE_FAILED','不能持久保存刊登记录，未授权下一步外部动作');}
   this._state=next;return result;
  });this._tail=task.catch(()=>{});return task;
 }
 prepare(proof){
  return this._atomic(state=>{
   validProof(proof,{now:this._now(),issued:true});const facts=proof.facts;
   const conflict=state.submissions.find(record=>record.state!=='cancelled'&&((record.proof.facts.planId===facts.planId&&record.proof.facts.cycle===facts.cycle&&listingRevision(record.proof.facts.listingRevision)===listingRevision(facts.listingRevision))||(record.proof.facts.profileId===facts.profileId&&record.proof.facts.documentKey===facts.documentKey&&record.proof.facts.tabId===facts.tabId)||(isPublicationOpen(record)&&samePublicationOwner(record.proof.facts.account,facts.account)&&record.proof.facts.sku===facts.sku)));
   if(conflict)fail('PUBLICATION_EXISTS','该账号和 SKU、销售周期或商品页面已有刊登记录，请核对原提交，不能新建');
   const now=new Date(this._now()).toISOString(),record={id:randomUUID(),state:'prepared',attemptCount:0,proof:clone(proof),createdAt:now,updatedAt:now,submittedAt:null,receipt:null,reason:''};
   state.submissions.push(record);return clone(record);
  });
 }
 cancelPrepared(id){
  return this._atomic(state=>{
   const record=state.submissions.find(record=>record.id===id);if(!record)fail('PUBLICATION_NOT_FOUND','找不到原刊登提交记录');
   if(!['prepared','needs_review'].includes(record.state)||record.attemptCount!==0)fail('PUBLICATION_UNKNOWN_RESULT','已尝试提交的刊登不能取消后重发',true);
   record.state='cancelled';record.updatedAt=new Date(this._now()).toISOString();record.reason='已取消尚未提交的本地准备记录';return clone(record);
  });
 }
 async dispatchOnce(id,currentProof,dispatch,{signal,timeoutMs=30000}={}){
  if(!this.dispatchEnabled)fail('PUBLICATION_NOT_ENABLED','真实发布步骤尚未启用；只可准备和核对证据');
  if(typeof dispatch!=='function')throw TypeError('A main-process dispatch callback is required');
  integer(timeoutMs,'发布动作时限',1,30000);
  const intent=await this._atomic(state=>{
   if(signal?.aborted)fail('STOPPED','刊登已停止，未发送发布动作');
   validProof(currentProof,{now:this._now(),issued:true});const record=state.submissions.find(record=>record.id===id);
   if(!record)fail('PUBLICATION_NOT_FOUND','找不到原刊登提交记录');
   if(record.state!=='prepared'||record.attemptCount!==0)fail('PUBLICATION_UNKNOWN_RESULT','原刊登已提交或需核对，禁止再次点击发布',true);
   if(record.proof.fingerprint!==currentProof.fingerprint)fail('PUBLICATION_MISMATCH','提交前商品、账号、页面或照片发生变化，未发布');
   record.state='dispatching';record.attemptCount=1;record.submittedAt=new Date(this._now()).toISOString();record.updatedAt=record.submittedAt;record.dispatchProofObservedAt=currentProof.observedAt;
   return freeze({submissionId:record.id,fingerprint:record.proof.fingerprint,...clone(record.proof.facts)});
  });
  let error;
  try{
   // Recheck after durable storage: a slow fsync or cancellation cannot permit a
   // stale action. Once dispatching is durable, even a pre-click abort is kept
   // uncertain; this sacrifices a retry rather than risk a duplicate listing.
   if(signal?.aborted)fail('STOPPED','刊登已停止');validProof(currentProof,{now:this._now(),issued:true});
   await boundedDispatch(dispatch,intent,{signal,timeoutMs});
  }catch(caught){error=caught;}
  try{await this._atomic(state=>{const record=state.submissions.find(record=>record.id===id);if(record.state==='dispatching'){record.state='uncertain';record.reason=error?'发布动作未取得可验证结果；请读取原刊登，不能重发':'发布动作已发送；仍需核对实际刊登编号、账号、单品价格及照片';record.updatedAt=new Date(this._now()).toISOString();}return null;});}
  catch(storageError){storageError.ambiguous=true;throw storageError;}
  if(error&&this.get(id).state!=='published')fail('PUBLICATION_UNKNOWN_RESULT','原发布动作结果尚未确认，请只读核对，不能重试点击',true);
  return this.get(id);
 }
 reconcile(id,evidence,{guard=()=>{}}={}){
  return this._atomic(state=>{
   guard();
   const record=state.submissions.find(record=>record.id===id);if(!record)fail('PUBLICATION_NOT_FOUND','找不到原刊登提交记录');
   if(!['dispatching','uncertain','published'].includes(record.state)||record.attemptCount!==1)fail('PUBLICATION_NOT_SUBMITTED','当前记录尚未提交，不能认定已经刊登');
   const receipt=validatePublicationReceipt(record,evidence,{now:this._now()});
   if(record.receipt){const previous={...record.receipt},current={...receipt};delete previous.observedAt;delete current.observedAt;exact(current,previous,'原刊登结果');}
   if(state.submissions.some(other=>other.id!==id&&(other.receipt?.listingId===receipt.listingId||other.closedWithdrawal?.listingId===receipt.listingId)))fail('PUBLICATION_RECEIPT_CONFLICT','这个平台刊登编号已经关联另一条提交记录');
   record.state='published';record.receipt=receipt;record.updatedAt=new Date(this._now()).toISOString();record.reason='实际刊登内容及归属已核对';return clone(record);
  });
 }
 releaseAfterSale(id,evidence){
  return this._atomic(state=>{
   const record=state.submissions.find(record=>record.id===id);if(!record)fail('PUBLICATION_NOT_FOUND','找不到原刊登提交记录');
   const sale=validateSaleClosure(record,evidence,{now:this._now()});
   if(record.closedSale){const previous={...record.closedSale},current={...sale};delete previous.observedAt;delete current.observedAt;exact(current,previous,'原成交回执');return clone(record);}
   if(state.submissions.some(other=>other.id!==id&&other.closedSale?.orderId===sale.orderId))fail('PUBLICATION_SALE_CONFLICT','平台成交编号已关联另一条刊登，不能重复解除在售占用');
   record.closedSale=sale;record.updatedAt=new Date(this._now()).toISOString();record.reason='原刊登已核对付款成交，可由后续销售周期准备补货刊登';return clone(record);
  });
 }
 releaseAfterDeletion(id,evidence,{guard=()=>{}}={}){
  if(typeof guard!=='function')throw TypeError('Deletion guard must be a function');
  return this._atomic(state=>{
   guard();const record=state.submissions.find(record=>record.id===id);if(!record)fail('PUBLICATION_NOT_FOUND','找不到原刊登提交记录');
   if(record.closedWithdrawal)fail('PUBLICATION_DELETION_CLOSED','原刊登已经确认删除，不能再次释放占用');
   const closure=validateDeletionClosure(record,evidence,{now:this._now()});
   if(state.submissions.some(other=>other.id!==id&&(other.closedWithdrawal?.reviewId===closure.reviewId||other.closedWithdrawal?.listingId===closure.listingId||other.receipt?.listingId===closure.listingId)))fail('PUBLICATION_DELETION_CONFLICT','删除确认编号或原刊登已关联另一条提交');
   record.closedWithdrawal=closure;record.updatedAt=new Date(this._now()).toISOString();record.reason='操作员确认原刊登已删除且未售出；保留原提交记录并准备同一销售周期重新刊登';return clone(record);
  });
 }
}

module.exports={buildPublicationProof,validatePublicationReceipt,operatorReviewedEvidence,restorePublicationState,PublicationJournal,listingRevision,listingJobKey,isPublicationOpen,FIELD_KEYS,FORM_URL,MAX_PROOF_AGE_MS,MAX_RECEIPT_AGE_MS};
