'use strict';

const {createHash}=require('node:crypto');
const {normalizeBaseURL}=require('./sku-desk.cjs');
function stableJSON(value){if(Array.isArray(value))return '['+value.map(stableJSON).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>JSON.stringify(key)+':'+stableJSON(value[key])).join(',')+'}';return JSON.stringify(value);}
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=value=>createHash('sha256').update(stableJSON(value)).digest('hex');
const locks=new WeakMap();
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
const instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function fail(code,message){return Object.assign(Error(message),{code});}
function ensure(ok,message,code='SUPPLIER_OUTBOX_INVALID'){if(!ok)throw fail(code,message);}
function validURL(value,id){try{const url=new URL(value);return url.origin==='https://www.vinted.fr'&&!url.username&&!url.password&&!url.search&&!url.hash&&new RegExp('^/items/'+id+'(?:-[^/]+)?/?$').test(url.pathname);}catch{return false;}}
function payloadValid(payload){return object(payload)&&Object.keys(payload).length===4&&payload.action==='published'&&payload.platform==='Vinted'&&/^[1-9]\d{0,29}$/.test(payload.listingId)&&validURL(payload.listingUrl,payload.listingId);}
function same(a,b){return stableJSON(a)===stableJSON(b);}

// Keep this validator reusable by publication projection. A completed outbox
// must remain a valid immutable part of all later journal snapshots.
function validateSupplierSyncRecord(row){
 ensure(object(row)&&identifier(row.id)&&row.kind==='mark_listed'&&['claimId','profileId','productId'].every(key=>identifier(row[key]))&&(row.submissionId===null||identifier(row.submissionId))&&payloadValid(row.payload),'货盘关联记录身份或请求无效');
 ensure(row.id==='mark-listed-'+hash([row.claimId,row.payload.listingId]),'货盘关联编号与原领取不一致');
 ensure(instant(row.createdAt)&&instant(row.updatedAt)&&typeof row.reason==='string'&&[0,1].includes(row.attemptCount)&&['pending','dispatching','uncertain','needs_review','synced','cancelled'].includes(row.state),'货盘关联状态无效');
 if(row.attemptCount===0){ensure(row.operation===null&&!['dispatching','uncertain'].includes(row.state),'未发送关联不能包含已发送操作');}
 else{
  const operation=row.operation,request=operation?.request;
  ensure(!['pending','cancelled'].includes(row.state)&&object(operation)&&operation.kind==='mark_listed'&&operation.idempotencyKey==='isola-'+row.id&&object(request)&&identifier(request.supplierAccountId)&&request.claimId===row.claimId&&same(request.payload,row.payload),'货盘原请求或固定编号已改变');
  ensure(typeof request.baseURL==='string'&&normalizeBaseURL(request.baseURL)===request.baseURL&&operation.fingerprint===hash(request),'货盘请求地址或内容校验失败');
 }
 if(row.state==='synced'){
  const receipt=row.receipt;
  ensure(object(receipt)&&receipt.source==='claim_detail'&&receipt.claimId===row.claimId&&receipt.productId===row.productId&&identifier(receipt.setId)&&receipt.platform==='Vinted'&&receipt.listingId===row.payload.listingId&&receipt.listingUrl===row.payload.listingUrl&&instant(receipt.observedAt),'货盘关联缺少精确领取详情回执');
 }else ensure(row.receipt===null,'未核对的货盘关联不能标记有回执');
 return row;
}

function restoreSupplierSync(rows=[],{now=Date.now()}={}){
 ensure(Array.isArray(rows),'货盘关联列表无效');
 const next=clone(rows),ids=new Set(),activeClaims=new Set();
 for(const row of next){
  validateSupplierSyncRecord(row);ensure(!ids.has(row.id),'货盘关联编号重复');ids.add(row.id);
  if(['pending','dispatching','uncertain'].includes(row.state)){ensure(!activeClaims.has(row.claimId),'同一照片领取有多个未完成的关联请求');activeClaims.add(row.claimId);}
  if(row.state==='dispatching'){row.state='uncertain';row.updatedAt=new Date(now).toISOString();row.reason='应用在关联请求期间退出；只核对原领取详情，不重复发送';}
 }
 return next;
}

function summarizeSupplierSync(row){
 validateSupplierSyncRecord(row);
 return {id:row.id,kind:row.kind,profileId:row.profileId,productId:row.productId,submissionId:row.submissionId,state:row.state,attemptCount:row.attemptCount,reason:row.reason,updatedAt:row.updatedAt,listingUrl:row.payload.listingUrl};
}

// API 1.8 leaves response schemas open. Accept only explicit, consistent fields
// from GET claim; ok=true, published status, a POST acknowledgement or a URL
// without its exact platform/id never constitutes a verified association.
function aliased(source,names,{required=true}={}){
 const values=names.filter(key=>Object.hasOwn(source,key)).map(key=>source[key]);
 if(!values.length){ensure(!required,'领取详情缺少可核对字段','SUPPLIER_RECEIPT_UNVERIFIED');return undefined;}
 ensure(values.every(value=>value===values[0]),'领取详情包含冲突字段','SUPPLIER_RECEIPT_UNVERIFIED');return values[0];
}
function inspectSupplierClaim(data,expected,{now=Date.now()}={}){
 const code='SUPPLIER_RECEIPT_UNVERIFIED',set=data?.set;
 ensure(object(data)&&object(set)&&set.id===expected.setId&&aliased(set,['productId','product_id'])===expected.productId,'领取详情的照片套组或商品不一致',code);
 const claims=[data.claim,set.claim].filter(value=>value!==undefined);
 ensure(claims.length>0&&claims.every(object),'领取详情缺少原领取记录',code);
 if(Object.hasOwn(data,'claimId'))ensure(data.claimId===expected.claimId,'领取详情的领取编号不一致',code);
 let result;
 for(const claim of claims){
  ensure(aliased(claim,['id','claimId','claim_id'])===expected.claimId,'领取详情的领取编号不一致',code);
  const platform=aliased(claim,['platform']),listingId=aliased(claim,['listingId','listing_id']),listingUrl=aliased(claim,['listingUrl','listing_url']);
  const absent=[platform,listingId,listingUrl].every(value=>value===null||value==='');
  const current=absent?{status:'absent'}:{status:'matched',receipt:{claimId:expected.claimId,setId:expected.setId,productId:expected.productId,platform,listingId,listingUrl,observedAt:new Date(now).toISOString(),source:'claim_detail'}};
  if(!absent)ensure(platform===expected.payload.platform&&listingId===expected.payload.listingId&&listingUrl===expected.payload.listingUrl,'货盘已关联另一刊登，或编号、链接与原请求不一致',code);
  if(result)ensure(same(result,current),'领取详情的关联记录互相冲突',code);result=current;
 }
 return result;
}

function one(rows,predicate,message){ensure(Array.isArray(rows),message);const found=rows.filter(predicate);ensure(found.length===1,message);return found[0];}
function binding(engine,id){
 const db=engine.db,row=one(db.publicationSupplierSync,item=>item.id===id,'货盘关联记录缺失或重复');validateSupplierSyncRecord(row);
 const related=db.publicationSupplierSync.filter(item=>item.claimId===row.claimId);
 ensure(related.every(item=>item.profileId===row.profileId&&item.productId===row.productId)&&related.filter(item=>['pending','dispatching','uncertain'].includes(item.state)).length<=1,'照片领取关联记录冲突');
 const claim=one(db.claims,item=>item.id===row.claimId,'原照片领取缺失或重复');
 ensure(claim.profileId===row.profileId&&claim.productId===row.productId&&identifier(claim.setId)&&Array.isArray(claim.listings),'原照片领取与环境或商品不一致');
 const link=one(claim.listings,item=>String(item.listingId)===row.payload.listingId,'原刊登在照片领取历史中缺失或重复');ensure(link.url===row.payload.listingUrl,'原刊登与货盘关联链接不一致');
 const reused=claim.listings.indexOf(link)>0;
 ensure(identifier(db.supplierAccountId)&&(!claim.supplierAccountId||claim.supplierAccountId===db.supplierAccountId),'照片领取所属货盘账号无法核对');
 const account=one(db.marketAccounts,item=>item.profileId===row.profileId,'原环境账号绑定缺失或重复');
 ensure(!db.marketAccounts.some(item=>item.profileId!==row.profileId&&item.memberId===account.memberId),'同一平台账号绑定多个环境');
 ensure(!engine.profiles||engine.profiles().some(item=>item.id===row.profileId),'原浏览器环境不存在');
 let plan;
 if(row.submissionId){
  const record=one(db.publications?.submissions,item=>item.id===row.submissionId,'原平台刊登回执缺失或重复'),facts=record.proof?.facts;
  ensure(record.state==='published'&&record.attemptCount===1&&record.receipt?.listingId===row.payload.listingId&&validURL(record.receipt?.url,row.payload.listingId),'原平台刊登尚未核对');
  ensure(facts?.profileId===row.profileId&&facts.productId===row.productId&&facts.photos?.claimId===row.claimId&&facts.photos?.setId===claim.setId&&facts.account?.memberId===account.memberId&&facts.account?.profileURL===account.profileURL,'原平台刊登的账号、商品或照片绑定已改变');
  plan=one(db.plans,item=>item.id===facts.planId,'原销售计划缺失或重复');
  ensure(plan.profileId===row.profileId&&plan.productId===row.productId&&plan.sku===facts.sku,'原销售计划绑定已改变');
 }
 const request={baseURL:normalizeBaseURL(db.settings.baseURL),supplierAccountId:db.supplierAccountId,claimId:row.claimId,payload:clone(row.payload)};
 if(row.operation)ensure(same(row.operation.request,request),'原货盘请求的地址或账号已改变');
 return {row,plan,reused,expected:{claimId:claim.id,setId:claim.setId,productId:claim.productId,payload:clone(row.payload)},request,signature:hash({request,setId:claim.setId,profileId:row.profileId,submissionId:row.submissionId,memberId:account.memberId,profileURL:account.profileURL,planId:plan?.id||null,reused})};
}

function createSupplierOutbox({now=Date.now,timeoutMs=30000}={}){
 ensure(typeof now==='function'&&Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=120000,'货盘关联执行器配置无效');
 async function run(engine,id,{signal,guard=()=>{},allowDispatch=false}={}){
  const initial=binding(engine,id),profileId=initial.row.profileId;
  let owned=locks.get(engine);if(!owned){owned=new Map();locks.set(engine,owned);}
  ensure(!owned.has(profileId),'该环境已有货盘关联正在核对','SUPPLIER_OUTBOX_BUSY');
  const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const lease={id,controller};owned.set(profileId,lease);let expectedRow=stableJSON(initial.row),expectedSignature=initial.signature;
  const current=()=>{
   ensure(!engine.closing&&!engine.faulted&&engine.storageFaulted?.()!==true,'运营已停止或存储不可用','SUPPLIER_OUTBOX_STOPPED');
   ensure(!controller.signal.aborted,'货盘关联已停止；保留原请求核对','SUPPLIER_OUTBOX_STOPPED');guard();
   const next=binding(engine,id);ensure(stableJSON(next.row)===expectedRow&&next.signature===expectedSignature,'核对期间货盘关联或账号绑定发生变化','SUPPLIER_OUTBOX_CHANGED');
   ensure(next.plan?.enabled!==false||['synced','cancelled'].includes(next.row.state),'销售计划已暂停，未继续货盘关联','SUPPLIER_OUTBOX_STOPPED');
   return next;
  };
  async function commit(patch){
   const {row}=current(),next=validateSupplierSyncRecord({...row,...patch,updatedAt:new Date(now()).toISOString()});
   // Change only the outbox on the latest live database. Replacing a captured
   // whole-db snapshot here loses concurrent jobs and invalidates the journal.
   engine.db.publicationSupplierSync=engine.db.publicationSupplierSync.map(item=>item.id===id?next:item);
   expectedRow=stableJSON(next);
   try{await engine.persist();}catch(error){engine.faulted=true;engine.running=false;throw error;}
   engine.emit?.();return next;
  }
  async function request(fn){
   current();const requestController=new AbortController(),abort=()=>requestController.abort();controller.signal.addEventListener('abort',abort,{once:true});
   let timer,onAbort;
   try{
    const result=await Promise.race([Promise.resolve().then(()=>{current();return fn(requestController.signal);}),new Promise((resolve,reject)=>{
     onAbort=()=>reject(fail('SUPPLIER_OUTBOX_STOPPED','货盘关联已停止；保留原请求核对'));controller.signal.addEventListener('abort',onAbort,{once:true});
     timer=setTimeout(()=>{requestController.abort();reject(fail('SUPPLIER_OUTBOX_TIMEOUT','货盘关联读取超时，请核对原领取'));},timeoutMs);
    })]);current();return result;
   }finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);}
  }
  try{
   let context=current();if(['synced','cancelled'].includes(context.row.state))return summarizeSupplierSync(context.row);
   // API 1.8 explicitly returns 409 when a claim's original listing reference
   // changes. Reused photos remain valid locally, but never overwrite that
   // first supplier reference or reject the whole store merely for old history.
   if(context.reused){await commit({state:'needs_review',reason:'本套照片用于后续刊登；货盘 API 1.8 不支持更换首次关联，原回执已保留，未发送覆盖请求'});return summarizeSupplierSync(current().row);}
   if(context.row.state==='dispatching')await commit({state:'uncertain',reason:'原请求可能已经发送；只核对领取详情，不重复发送'});
   context=current();if(context.plan?.enabled===false)throw fail('SUPPLIER_OUTBOX_STOPPED','销售计划已暂停，未继续货盘关联');
   const client=engine.client(),me=await request(requestSignal=>client.me({signal:requestSignal}));
   const identity=engine.accountIdentity?engine.accountIdentity(me):String(me?.user?.id??me?.account?.id??'');
   ensure(identity===context.request.supplierAccountId,'当前密钥不属于原照片领取账号','SUPPLIER_OUTBOX_ACCOUNT');
   const inspect=async()=>inspectSupplierClaim(await request(requestSignal=>client.claim(context.expected.claimId,{signal:requestSignal})),context.expected,{now:now()});
   let receipt;
   try{receipt=await inspect();}catch(error){if(controller.signal.aborted||engine.faulted||engine.closing)throw error;await commit({state:'needs_review',reason:String(error.message).slice(0,500)});return summarizeSupplierSync(current().row);}
   if(receipt.status==='matched'){await commit({state:'synced',receipt:receipt.receipt,reason:'货盘原领取详情已核对同一平台刊登'});return summarizeSupplierSync(current().row);}
   context=current();
   if(context.row.attemptCount===1){await commit({state:'needs_review',reason:'原关联请求已尝试，但领取详情尚未出现精确回执；不会重复发送'});return summarizeSupplierSync(current().row);}
   if(!allowDispatch||context.row.state!=='pending'||!context.row.submissionId)return summarizeSupplierSync(context.row);
   ensure(context.plan?.enabled===true,'销售计划已暂停，未发送货盘关联','SUPPLIER_OUTBOX_STOPPED');
   await commit({state:'dispatching',attemptCount:1,operation:{kind:'mark_listed',idempotencyKey:'isola-'+id,fingerprint:hash(context.request),request:context.request},reason:'固定货盘关联请求已持久保存，正在发送一次'});
   let dispatchError;
   try{await request(requestSignal=>client.markListed(context.expected.claimId,clone(context.request.payload),{idempotencyKey:'isola-'+id,signal:requestSignal}));}catch(error){dispatchError=error;}
   // A POST acknowledgement is never a receipt. Even a definite HTTP rejection
   // is not retried by this worker: an operator can inspect its original record.
   if(controller.signal.aborted||engine.faulted||engine.closing)throw dispatchError||fail('SUPPLIER_OUTBOX_STOPPED','货盘关联已停止');
   await commit({state:'uncertain',reason:dispatchError?'关联请求结果待核对；只读取原领取详情':'关联请求已返回，等待原领取详情精确回执'});
   try{receipt=await inspect();}catch(error){if(controller.signal.aborted||engine.faulted||engine.closing)throw error;await commit({state:'needs_review',reason:String(error.message).slice(0,500)});return summarizeSupplierSync(current().row);}
   await commit(receipt.status==='matched'?{state:'synced',receipt:receipt.receipt,reason:'货盘原领取详情已核对同一平台刊登'}:{state:'needs_review',reason:'领取详情尚未出现原刊登关联；保留原请求，不重复发送'});
   return summarizeSupplierSync(current().row);
  }finally{signal?.removeEventListener('abort',cancel);if(owned.get(profileId)===lease)owned.delete(profileId);}
 }
 async function cancel(engine,id){
  const {row}=binding(engine,id),lease=locks.get(engine)?.get(row.profileId);if(lease?.id===id)lease.controller.abort();
  if(row.state==='synced'||row.state==='cancelled')return summarizeSupplierSync(row);
  const next=validateSupplierSyncRecord({...row,state:row.attemptCount?'uncertain':'cancelled',updatedAt:new Date(now()).toISOString(),reason:row.attemptCount?'已停止后续请求；原关联可能已发送，需核对领取详情':'已取消尚未发送的货盘关联'});
  ensure(!engine.faulted&&!engine.closing,'运营存储不可用','SUPPLIER_OUTBOX_STOPPED');
  engine.db.publicationSupplierSync=engine.db.publicationSupplierSync.map(item=>item.id===id?next:item);
  try{await engine.persist();}catch(error){engine.faulted=true;engine.running=false;throw error;}engine.emit?.();return summarizeSupplierSync(next);
 }
 return {run,cancel};
}

module.exports={createSupplierOutbox,validateSupplierSyncRecord,restoreSupplierSync,summarizeSupplierSync,inspectSupplierClaim};
