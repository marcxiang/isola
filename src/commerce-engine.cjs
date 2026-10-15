const {normalizeListing,missingListingFields}=require('./listing-config.cjs');
const {startupDecision,retryDecision,inspectQueue,ProfileOperationLeases,CAPABILITIES}=require('./commerce-scheduler.cjs');
const {restorePublicationState,listingRevision,listingJobKey,isPublicationOpen}=require('./vinted-publication.cjs');
const parseListingURL=value=>require('./vinted-listing-receipt.cjs').listingURL(value);
const {summarizePreparation,restorePhotoPreparations}=require('./commerce-photos.cjs');
const {restoreSupplierSync}=require('./commerce-supplier-outbox.cjs');
const {restoreLocalProducts,localCatalog,summarizeLocalPreparation}=require('./commerce-local-products.cjs');
const {restorePlanArchives,isPlanArchived,archivedPlanError}=require('./commerce-deletion.cjs');
const {recoverableJob,retryPatch,restoreRow}=require('./commerce-plan-recovery.cjs');
const {productCoverSource}=require('./commerce-product-display.cjs');
const {accountExpectation}=require('./commerce-account-binding.cjs');
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const DEFAULTS={baseURL:'https://sku.meetist.fr/api/v1',backgroundEnabled:false,maxConcurrent:2,perOrderLimitCents:0,dailyLimitCents:0,market:'FR',accountType:'personal',fulfillmentMethod:'wms'};
const terminal=new Set(['completed','cancelled','rejected']);
const now=()=>new Date().toISOString();
function problem(code,message,ambiguous=false){const e=Error(message);e.code=code;e.ambiguous=ambiguous;return e;}
function integer(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw Error(label+'无效');return value;}
function text(value,label,max=200){if(typeof value!=='string'||!value.trim()||value.length>max||/[\0\r\n]/.test(value))throw Error(label+'无效');return value.trim();}
function money(value,label='金额'){return integer(value,0,100000000,label);}
function own(object,keys){for(const key of keys)if(Object.hasOwn(object,key))return object[key];return undefined;}
function nullableInteger(v){return Number.isSafeInteger(v)&&v>=0?v:null;}
function normalizeProduct(p){const displayImageUrl=productCoverSource(p);return {id:String(p.id||''),sku:String(p.sku||''),name:String(p.name||p.sku||''),stock:nullableInteger(own(p,['stock','stock_quantity'])),priceCents:nullableInteger(own(p,['unitPriceCents','unit_price_cents','priceCents','price_cents','applicable_price_cents','catalog_price_cents'])),photoSetsAvailable:nullableInteger(own(p,['availablePhotoSets','available_photo_sets','photo_sets_available'])),revision:nullableInteger(p.revision),...(displayImageUrl?{displayImageUrl}:{})};}
function normalizeSet(s){return {id:String(s.id||''),productId:String(s.productId||s.product_id||''),name:String(s.name||s.id||''),claimStatus:s.claim?'claimed':String(s.status||'unknown'),claimedByMe:s.claimedByMe===true||s.claimed_by_me===true,imageCount:nullableInteger(s.imageCount??s.image_count??s.images?.length),claimId:s.claim?.id||s.claimId||null};}
function fingerprint(input){return createHash('sha256').update(JSON.stringify(input)).digest('hex');}
const clone=value=>JSON.parse(JSON.stringify(value));
const productListingKeys=['productId','sku','listing','listingPriceCents','minOfferCents','createdAt','updatedAt'];
const plainRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function draftPrice(value,label){return value===undefined||value===null||value===''?null:integer(value,1,100000000,label);}
function validateDraftPrices(listingPriceCents,minOfferCents){if(minOfferCents!==null&&(listingPriceCents===null||minOfferCents>listingPriceCents))throw Error('最低接受价需要先填写售价，且不能高于售价');}
function restoreProductListings(rows){
 if(rows===undefined)return [];
 if(!Array.isArray(rows))throw Error('商品刊登资料格式无效，原数据已保留');
 const ids=new Set();
 return rows.map(row=>{
  if(!plainRecord(row)||Object.keys(row).length!==productListingKeys.length||productListingKeys.some(key=>!Object.hasOwn(row,key)))throw Error('商品刊登资料记录无效，原数据已保留');
  const productId=text(row.productId,'商品编号'),sku=text(row.sku,'商品 SKU');
  if(productId!==row.productId||sku!==row.sku||ids.has(productId))throw Error('商品刊登资料编号重复或无效，原数据已保留');ids.add(productId);
  const listing=normalizeListing(row.listing),keys=Object.keys(listing);
  if(!plainRecord(row.listing)||Object.keys(row.listing).length!==keys.length||keys.some(key=>!Object.hasOwn(row.listing,key)||key==='categoryPath'&&(!Array.isArray(row.listing[key])||row.listing[key].length!==listing[key].length||row.listing[key].some((value,index)=>value!==listing[key][index]))||key!=='categoryPath'&&row.listing[key]!==listing[key]))throw Error('商品刊登资料字段无效，原数据已保留');
  const listingPriceCents=draftPrice(row.listingPriceCents,'商品售价'),minOfferCents=draftPrice(row.minOfferCents,'最低接受价');
  if(listingPriceCents!==row.listingPriceCents||minOfferCents!==row.minOfferCents)throw Error('商品刊登资料金额无效，原数据已保留');validateDraftPrices(listingPriceCents,minOfferCents);
  const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
  if(!date(row.createdAt)||!date(row.updatedAt)||Date.parse(row.updatedAt)<Date.parse(row.createdAt))throw Error('商品刊登资料时间无效，原数据已保留');
  return {productId,sku,listing,listingPriceCents,minOfferCents,createdAt:row.createdAt,updatedAt:row.updatedAt};
 });
}
const manuallyPausedProfile=(jobs,profileId)=>jobs.some(job=>job.profileId===profileId&&job.state==='needs_review'&&['PROFILE_CLOSED','PROFILE_STOPPED'].includes(job.blockedReason));
const validEventText=value=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
const eventIdentity=event=>Object.fromEntries(['type','id','profileId','memberId','listingId','buyerUsername','buyerMemberId','conversationId','text','priceCents','currency','quantity',...(event?.type==='sale'?['paid','cancelled']:[])].map(key=>[key,event?.[key]??null]));
function saleCycleComplete(db,planId){return db.sales.filter(sale=>sale.planId===planId).every(sale=>db.jobs.filter(job=>job.id===sale.jobId&&['fulfillment','sale_confirmation'].includes(job.type)&&job.planId===planId&&job.state==='completed'&&job.mutationPending===false&&job.result?.verified===true&&validEventText(job.result?.externalId)&&(job.type!=='sale_confirmation'||job.result.kind==='sale_confirmation'&&job.result.externalId===sale.platformOrderId)).length===1);}
function queuedJob(type,plan,payload,dedupeKey){return {id:randomUUID(),dedupeKey,type,planId:plan.id,profileId:plan.profileId,productId:plan.productId,state:'queued',step:'pending',payload,operation:null,mutationPending:false,createdAt:now(),updatedAt:now(),error:'',result:null};}
function stopped(){return problem('STOPPED','操作已停止，未提交过期结果');}
const SECRET_STORAGE_TIMEOUT_MS=30000;
function boundedSecret(work,signal){
 if(signal?.aborted)return Promise.reject(stopped());
 return new Promise((resolve,reject)=>{
  let settled=false,timer;
  const finish=(callback,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);callback(value);};
  const onAbort=()=>finish(reject,stopped());
  signal?.addEventListener('abort',onAbort,{once:true});
  timer=setTimeout(()=>finish(reject,problem('SECRET_STORAGE_TIMEOUT','系统密钥访问超时，操作已停止；请检查钥匙串后重试，原密钥已保留')),SECRET_STORAGE_TIMEOUT_MS);
  // Native async keychain work cannot be cancelled. Consume late settlements,
  // but never create a client, save a key or continue the original operation.
  Promise.resolve().then(()=>{if(signal?.aborted)throw stopped();return work();}).then(
   value=>finish(resolve,value),
   ()=>finish(reject,problem('SECRET_STORAGE_UNAVAILABLE','系统密钥暂时无法访问，操作已停止；原密钥已保留'))
  );
 });
}
function boundedRead(fn,signal,timeout=30000){
 if(signal?.aborted)return Promise.reject(stopped());
 const controller=new AbortController();let timer,onAbort;
 return new Promise((resolve,reject)=>{
  const finish=(callback,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);callback(value);};
  onAbort=()=>{controller.abort();finish(reject,stopped());};signal?.addEventListener('abort',onAbort,{once:true});
  timer=setTimeout(()=>{controller.abort();finish(reject,problem('READ_TIMEOUT','读取服务超时，旧结果不会提交'));},timeout);
  Promise.resolve().then(()=>{if(controller.signal.aborted)throw stopped();return fn(controller.signal);}).then(value=>finish(resolve,value),error=>finish(reject,error));
 });
}
function validatePlan(input,{profiles,products,previous}={}){
 const profileId=text(input.profileId,'浏览器环境'),productId=text(input.productId,'商品');
 const profile=profiles.find(p=>p.id===profileId);if(!profile)throw Error('浏览器环境不存在');if(profile.status==='starting')throw Error('浏览器环境正在启动或清理，请等待结束后再保存计划');
 if(!previous&&profile.windowType!==undefined&&profile.windowType!=='automation')throw problem('PROFILE_NOT_AUTOMATION','请先将环境用途设为自动化，再新建商品上架计划；本次未保存或启用计划');
 const product=products.find(p=>p.id===productId);if(!product)throw Error('请先同步货盘并选择已有商品');
 const listingPriceCents=money(input.listingPriceCents,'刊登价'),minOfferCents=money(input.minOfferCents,'最低接受价');
 if(!listingPriceCents||!minOfferCents||minOfferCents>listingPriceCents)throw Error('售价和最低接受价必须大于零，且最低接受价不能高于售价');
 if(input.currency&&input.currency!=='EUR')throw Error('当前法国流程仅支持 EUR');
 const targetCount=integer(input.targetCount,1,1000,'累计销售目标');
 if(targetCount<(previous?.completedCount||0))throw Error('累计目标不能低于已确认销售数量');
 for(const key of ['autoReply','autoAcceptOffers','reuseOwnPhotos','enabled'])if(input[key]!==undefined&&typeof input[key]!=='boolean')throw Error(key+'设置无效');
  return {id:previous?.id||randomUUID(),profileId,productId,source:product.source==='local'?'local':'supplier',sku:product.sku,name:product.name,targetCount,listingPriceCents,minOfferCents,currency:'EUR',enabled:input.enabled===true,autoReply:input.autoReply===true,autoAcceptOffers:input.autoAcceptOffers===true,reuseOwnPhotos:input.reuseOwnPhotos!==false,replyPolicy:String(input.replyPolicy||'').slice(0,2000),listing:normalizeListing(input.listing===undefined?previous?.listing:input.listing),completedCount:previous?.completedCount||0,listingRevision:listingRevision(previous?.listingRevision),activeListingId:previous?.activeListingId||null,status:previous?.status||'paused',createdAt:previous?.createdAt||now(),updatedAt:now()};
}
class CommerceEngine{
 constructor({dir,profiles=()=>[],clientFactory,adapter,seal,unseal,sealAsync=seal,unsealAsync=unseal,accounts=null,onChange=()=>{}}){
  this.accounts=accounts;
  this.dir=dir;this.profiles=profiles;this.clientFactory=clientFactory;this.adapter=adapter;this.seal=seal;this.unseal=unseal;this.sealAsync=sealAsync;this.unsealAsync=unsealAsync;this.onChange=onChange;this.active=new Map();this.leases=new ProfileOperationLeases();this.accountObservations=new Map();this.running=false;this.timer=null;this.ticking=false;this.faulted=false;this.connection={status:'not_connected'};this.runGeneration=0;this.tickController=null;this.tickPromise=null;this.closing=false;this.closePromise=null;this.configPending=0;this.configController=null;this.configTail=Promise.resolve();
  this.runningPlanIds=null;
  fs.mkdirSync(dir,{recursive:true,mode:0o700});this.file=path.join(dir,'commerce-state.json');
  this.db=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,settings:{...DEFAULTS},encryptedToken:'',plans:[],products:[],productListings:[],photoSets:[],jobs:[],events:[],claims:[],sales:[],reservations:[]};
  if(this.db.version!==1||!['plans','products','photoSets','jobs','events','claims','sales','reservations'].every(k=>Array.isArray(this.db[k])))throw Error('运营数据格式无效，原文件已保留，不能自动重新建单');
  this.db.productListings=restoreProductListings(this.db.productListings);
  restoreLocalProducts(this.db);
  for(const plan of this.db.plans)plan.listingRevision=listingRevision(plan.listingRevision);
  for(const job of this.db.jobs)if(job.type==='listing'){if(!job.payload||typeof job.payload!=='object'||Array.isArray(job.payload))throw Error('原刊登任务缺少周期记录');job.payload.listingRevision=listingRevision(job.payload.listingRevision);}
  restorePhotoPreparations(this.db);
  if(this.db.marketAccounts===undefined)this.db.marketAccounts=[];
  if(!Array.isArray(this.db.marketAccounts)||new Set(this.db.marketAccounts.map(a=>a?.profileId)).size!==this.db.marketAccounts.length)throw Error('平台账号记录无效，已保留原数据');
  for(const account of this.db.marketAccounts)this.validateMarketAccount(account);

  this.db.publications=restorePublicationState(this.db.publications).state;
  this.db.publicationSupplierSync=restoreSupplierSync(this.db.publicationSupplierSync);
  this.db.settings={...DEFAULTS,...this.db.settings};
  restorePlanArchives(this.db);
  for(const job of this.db.jobs){const recovery=startupDecision(job);if(recovery.state!==job.state){job.state=recovery.state;job.error=recovery.reason;job.updatedAt=now();}}
  this.persist();
 }
 persist(){
  if(this.faulted)throw Error('运营存储已暂停，请检查磁盘后重启应用');
  try{const tmp=this.file+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(this.db,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,this.file);try{const d=fs.openSync(this.dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}catch{}}
  catch(e){this.faulted=true;this.running=false;throw Error('无法持久保存运营状态，已停止外部操作：'+e.message);}
 }
 storageFaulted(){return this.faulted||this.accounts?.faulted===true;}
 catalog(){
  const rows=[...this.db.products.map(product=>({...product,source:'supplier'})),...localCatalog(this.db)],ids=new Set(),skus=new Set();
  for(const row of rows){if(ids.has(row.id)||skus.has(row.sku))throw problem('PRODUCT_CONFLICT','本地商品与货盘的商品编号或 SKU 存在冲突，请核对原记录');ids.add(row.id);skus.add(row.sku);}
  return rows;
 }
 marketAccountRecords(){const rows=this.db.marketAccounts.map(row=>({...row}));for(const account of this.accounts?.list()||[]){if(account.identity&&!rows.some(row=>row.profileId===account.profileId&&row.memberId===account.identity.memberId))rows.push({...account.identity,platform:'vinted-fr',profileId:account.profileId});}return rows;}
 queueHealth(){return inspectQueue({runningPlanIds:this.running&&this.runningPlanIds instanceof Set?[...this.runningPlanIds]:null,jobs:this.db.jobs,plans:this.db.plans,sales:this.db.sales,profiles:this.profiles(),accounts:this.marketAccountRecords(),observedAccounts:[...this.accountObservations.values()],requireVerifiedAccount:true,readiness:this.adapter.readiness(),readinessByProfile:Object.fromEntries(this.profiles().map(p=>[p.id,this.adapter.readiness(p.id)])),activeProfileIds:[...this.active.keys()],maxConcurrent:this.db.settings.maxConcurrent,faulted:this.storageFaulted(),closing:this.closing,configBusy:this.configPending>0});}
 state(){const queue=this.queueHealth();return {runningPlanIds:this.running?(this.runningPlanIds instanceof Set?[...this.runningPlanIds]:null):[],accounts:this.accounts?.list()||[],queue,publications:this.db.publications.submissions.map(r=>({id:r.id,planId:r.proof.facts.planId,profileId:r.proof.facts.profileId,productId:r.proof.facts.productId,state:r.state,sessionListing:r.proof.facts.account?.kind==='environment-session',attemptCount:r.attemptCount,createdAt:r.createdAt,updatedAt:r.updatedAt,reason:r.reason,closedSale:!!r.closedSale,closedWithdrawal:!!r.closedWithdrawal,listingRevision:listingRevision(r.proof.facts.listingRevision),listingUrl:r.receipt?.url||r.navigation?.find(n=>n.committed)?.url||r.closedWithdrawal?.url||null})),settings:{...this.db.settings,hasToken:!!this.db.encryptedToken},connection:this.connection,profiles:this.profiles().map(p=>({id:p.id,name:p.name,status:p.status,fingerprintMode:p.fingerprintMode,operatingSystem:p.operatingSystem,deviceModel:p.deviceModel,windowType:p.windowType==='automation'?'automation':'normal',marketAccount:this.db.marketAccounts.find(a=>a.profileId===p.id)||null})),products:this.catalog(),productListings:this.db.productListings.map(row=>({...clone(row),missingFields:missingListingFields(row.listing)})),photoSets:this.db.photoSets,photoPreparations:this.db.photoPreparations.map(summarizePreparation).concat((this.db.localPhotoPreparations||[]).map(summarizeLocalPreparation)),plans:this.db.plans.map(plan=>({...clone(plan),archived:this.isPlanArchived(plan.id),archivedAt:(this.db.planArchives||[]).find(row=>row.planId===plan.id)?.archivedAt||null,missingFields:missingListingFields(plan.listing),activeListingUrl:this.listingURL(plan)})),jobs:this.db.jobs.map(record=>{const {payload,operation,result,archivedOperation,...job}=record;return {...job,scheduling:queue.jobs.find(row=>row.jobId===job.id)||null,canRetry:this.canRetry(record),result:result?{externalId:result.externalId||result.id||null,summary:result.summary||null}:null};}),events:this.db.events,running:this.running,configBusy:this.configPending>0,readiness:this.adapter.readiness(),faulted:this.storageFaulted()};}
 validateMarketAccount(account){
  if(!account||typeof account!=='object'||Array.isArray(account)||typeof account.profileId!=='string'||!account.profileId||account.platform!=='vinted-fr'||typeof account.memberId!=='string'||!/^[1-9]\d{0,24}$/.test(account.memberId)||typeof account.username!=='string'||!account.username.trim()||account.username.length>100||/[\x00-\x1f\x7f]/.test(account.username)||typeof account.verifiedAt!=='string'||!Number.isFinite(Date.parse(account.verifiedAt)))throw Error('平台账号身份记录无效');
  let url;try{url=new URL(account.profileURL);}catch{throw Error('平台账号地址无效');}
  if(url.origin!=='https://www.vinted.fr'||url.username||url.password||url.search||url.hash||url.pathname!=='/member/'+account.memberId)throw Error('平台账号地址与编号不一致');
  return account;
 }
 bindMarketAccount(profileId,observed){
  if(this.storageFaulted()||this.closing||!this.profiles().some(p=>p.id===profileId)||observed?.verified!==true)throw Error('平台账号核对无法保存');
  const account=this.validateMarketAccount({profileId,platform:'vinted-fr',memberId:observed.memberId,username:observed.username,profileURL:observed.profileURL,verifiedAt:now()}),old=this.db.marketAccounts.find(a=>a.profileId===profileId);
  if(old&&old.memberId!==account.memberId){this.accountObservations.delete(profileId);this.emit();throw problem('ACCOUNT_CHANGED','该环境登录了不同的 Vinted 账号；原账号绑定已保留，请核对登录状态');}
  if(this.db.marketAccounts.some(row=>row.profileId!==profileId&&row.platform===account.platform&&row.memberId===account.memberId)){this.accountObservations.delete(profileId);throw problem('ACCOUNT_CONFLICT','该 Vinted 账号已绑定其他环境，请使用原来的固定环境');}
  if((this.accounts?.list()||[]).some(row=>row.profileId!==profileId&&row.identity?.memberId===account.memberId)){this.accountObservations.delete(profileId);throw problem('ACCOUNT_CONFLICT','该 Vinted 账号已保存在其他固定环境，请先核对原绑定');}
  const saved=this.accounts?.findByProfile(profileId);if(saved)this.accounts.verify(saved.id,observed);
  if(old)Object.assign(old,account);else this.db.marketAccounts.push(account);
  if(observed.documentKey)this.accountObservations.set(profileId,{profileId,memberId:account.memberId,verified:true,documentKey:observed.documentKey,checkedAt:account.verifiedAt});
  this.persist();this.emit();return {...account};
 }
 bindJobAccount(jobId,observed,{signal,guard=()=>{}}={}){
  guard();const rows=this.db.jobs.filter(row=>row.id===jobId),job=rows[0];
  if(this.closing||this.storageFaulted?.()||this.configPending||signal?.aborted||rows.length!==1||job.state!=='running'||job.operation!=null||job.result!=null||job.mutationPending!==false||this.active.get(job.profileId)?.signal!==signal||!this.leases.snapshot().some(row=>row.profileId===job.profileId&&row.jobId===job.id))throw problem('STOPPED','原任务的账号确认已停止');
  const expected=accountExpectation(this,job.profileId);
  if(observed?.verified!==true||expected.memberId&&expected.memberId!==observed.memberId)throw problem('ACCOUNT_CHANGED','当前登录账号与原环境或任务身份不一致');
  const account=this.validateMarketAccount({profileId:job.profileId,platform:'vinted-fr',memberId:observed.memberId,username:observed.username,profileURL:observed.profileURL,verifiedAt:now()});
  if(this.db.marketAccounts.some(row=>row.profileId!==job.profileId&&row.memberId===account.memberId)||(this.accounts?.list()||[]).some(row=>row.profileId!==job.profileId&&row.identity?.memberId===account.memberId))throw problem('ACCOUNT_CONFLICT','该 Vinted 账号已绑定其他环境，请使用原来的固定环境');
  const saved=this.accounts?.findByProfile(job.profileId);if(saved)this.accounts.verify(saved.id,observed);guard();
  const previous=clone(job),accountsBefore=clone(this.db.marketAccounts),observedBefore=this.accountObservations.get(job.profileId),old=this.db.marketAccounts.find(row=>row.profileId===job.profileId);
  job.accountMemberId=account.memberId;if(old)Object.assign(old,account);else this.db.marketAccounts.push(account);
  if(observed.documentKey)this.accountObservations.set(job.profileId,{profileId:job.profileId,memberId:account.memberId,verified:true,documentKey:observed.documentKey,checkedAt:account.verifiedAt});
  try{this.persist();}
  catch(error){restoreRow(job,previous);this.db.marketAccounts=accountsBefore;if(observedBefore)this.accountObservations.set(job.profileId,observedBefore);else this.accountObservations.delete(job.profileId);throw error;}
  this.emit();return {...account};
 }
 listingURL(plan){
  const id=String(plan.activeListingId||'');if(!/^[1-9]\d*$/.test(id))return null;
  const matches=this.db.claims.filter(claim=>claim.profileId===plan.profileId&&claim.productId===plan.productId).flatMap(claim=>Array.isArray(claim.listings)?claim.listings:[]).filter(row=>String(row.listingId)===id);
  if(matches.length!==1||typeof matches[0].url!=='string')return null;
  try{const u=new URL(matches[0].url);return u.origin==='https://www.vinted.fr'&&!u.username&&!u.password&&!u.search&&!u.hash&&new RegExp('^/items/'+id+'(?:-[^/]+)?$').test(u.pathname)?u.href:null;}catch{return null;}
 }
 emit(){this.onChange(this.state());}
 event(kind,message){this.db.events.push({time:now(),kind,text:String(message).slice(0,500)});if(this.db.events.length>300)this.db.events.shift();}
 async client(signal){
  if(this.closing||this.storageFaulted()||signal?.aborted)throw stopped();
  const encrypted=this.db.encryptedToken,baseURL=this.db.settings.baseURL;
  if(!encrypted)throw problem('NOT_CONNECTED','请先填写货盘 API 密钥并测试连接');
  const token=await boundedSecret(()=>this.unsealAsync(encrypted),signal);
  if(this.closing||this.storageFaulted()||signal?.aborted||this.db.encryptedToken!==encrypted||this.db.settings.baseURL!==baseURL)throw stopped();
  if(typeof token!=='string'||!token.trim())throw problem('SECRET_STORAGE_UNAVAILABLE','系统密钥暂时无法访问，操作已停止；原密钥已保留');
  return this.clientFactory({baseURL,token});
 }
 hasHistory(){return ['plans','jobs','claims','sales','reservations','photoPreparations'].some(key=>this.db[key].length>0);}
 hasSupplierHistory(){
  const localIds=new Set(this.db.plans.filter(plan=>plan.source==='local').map(plan=>plan.id));
  return this.db.plans.some(plan=>plan.source!=='local')||['jobs','sales','reservations'].some(key=>this.db[key].some(row=>!localIds.has(row.planId)))||this.db.claims.some(row=>row.source!=='local')||this.db.photoPreparations.length>0;
 }
 clearSupplierCatalog(){
  const localIds=new Set((this.db.localProducts||[]).map(product=>product.id));
  this.db.products=[];this.db.photoSets=[];this.db.productListings=this.db.productListings.filter(row=>localIds.has(row.productId));
 }
 configure(work){
  if(this.closing||this.storageFaulted())return Promise.reject(stopped());if(this.active.size||this.running||this.ticking)return Promise.reject(Error('请先停止后台并等待当前步骤结束，再读取或修改货盘配置'));
  this.configPending++;
  const task=this.configTail.then(async()=>{if(this.closing||this.storageFaulted())throw stopped();const controller=new AbortController();this.configController=controller;const guard=()=>{if(this.closing||this.storageFaulted()||controller.signal.aborted)throw stopped();};try{guard();return await work(controller.signal,guard);}finally{if(this.configController===controller)this.configController=null;}});
  const finished=task.finally(()=>{this.configPending--;this.emit();});this.configTail=finished.catch(()=>{});return finished;
 }
 async saveSettings(input){
  input={...input};return this.configure(async(signal,guard)=>{
  const u=new URL(input.baseURL||this.db.settings.baseURL),local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&local)||u.username||u.password||u.search||u.hash)throw Error('货盘地址需 HTTPS，且不能带凭据、查询或片段');
  const baseURL=u.href.replace(/\/$/,'').replace(/(?:\/api\/v1)?$/,'/api/v1');
  const next={...this.db.settings,baseURL,backgroundEnabled:input.backgroundEnabled===true,maxConcurrent:integer(Number(input.maxConcurrent??2),1,3,'并发窗口数'),perOrderLimitCents:money(input.perOrderLimitCents??0,'单笔采购限额'),dailyLimitCents:money(input.dailyLimitCents??0,'每日采购限额'),fulfillmentMethod:input.fulfillmentMethod||this.db.settings.fulfillmentMethod};
  if(!['self','wms'].includes(next.fulfillmentMethod))throw Error('发货方式无效');
  if(next.dailyLimitCents&&next.perOrderLimitCents>next.dailyLimitCents)throw Error('单笔限额不能高于每日限额');
  let encrypted=this.db.encryptedToken;const endpointChanged=baseURL!==this.db.settings.baseURL,history=this.hasSupplierHistory();
  const token=!input.clearToken&&input.token?text(input.token,'API 密钥',4096):'',oldToken=token&&encrypted?await boundedSecret(()=>this.unsealAsync(encrypted),signal):null;guard();
  if(token&&encrypted&&(typeof oldToken!=='string'||!oldToken.trim()))throw problem('SECRET_STORAGE_UNAVAILABLE','系统密钥暂时无法访问，操作已停止；原密钥已保留');
  const tokenChanged=!!input.clearToken||!!token&&(!encrypted||token!==oldToken);
  if(endpointChanged){if(history)throw Error('已有运营计划或历史，不能把原照片和订单切换到另一货盘');encrypted='';}
  let accountId=this.db.supplierAccountId;
  if(input.clearToken)encrypted='';else if(token){if(history){const client=this.clientFactory({baseURL,token}),me=await boundedRead(requestSignal=>client.me({signal:requestSignal}),signal);guard();const id=this.accountIdentity(me);if(!accountId||!id||id!==accountId)throw Error('更换密钥前必须核对为同一个货盘账号，原密钥已保留');}encrypted=await boundedSecret(()=>this.sealAsync(token),signal);guard();if(typeof encrypted!=='string'||!encrypted)throw problem('SECRET_STORAGE_UNAVAILABLE','系统密钥暂时无法访问，操作已停止；原密钥已保留');}
  guard();const previous={settings:this.db.settings,encryptedToken:this.db.encryptedToken,supplierAccountId:this.db.supplierAccountId,hadSupplierAccount:Object.hasOwn(this.db,'supplierAccountId'),products:this.db.products,photoSets:this.db.photoSets,productListings:this.db.productListings,connection:this.connection};
  try{if(!history&&(endpointChanged||tokenChanged)){this.db.supplierAccountId=null;this.clearSupplierCatalog();}this.db.settings=next;this.db.encryptedToken=encrypted;this.connection={status:'not_connected'};this.persist();}
  catch(error){for(const key of ['settings','encryptedToken','products','photoSets','productListings'])this.db[key]=previous[key];if(previous.hadSupplierAccount)this.db.supplierAccountId=previous.supplierAccountId;else delete this.db.supplierAccountId;this.connection=previous.connection;throw error;}
  this.emit();return this.state();});
 }
 accountIdentity(data){const value=data.user?.id??data.account?.id??data.userId??data.accountId;return typeof value==='string'||Number.isSafeInteger(value)?String(value):null;}
 async connect(){
  return this.configure(async(signal,guard)=>{try{const client=await this.client(signal);guard();const data=await boundedRead(requestSignal=>client.me({signal:requestSignal}),signal);guard();const id=this.accountIdentity(data);if(this.db.supplierAccountId&&id!==this.db.supplierAccountId){if(this.hasSupplierHistory())throw Error('货盘账号与现有运营历史不匹配');this.clearSupplierCatalog();this.db.supplierAccountId=null;}if(id)this.db.supplierAccountId=id;this.connection={status:'connected',account:String(data.user?.username||data.account?.username||data.username||data.user?.id||data.account?.id||'已验证 API 密钥；账号字段待核对'),scopes:Array.isArray(data.scopes)?data.scopes:Array.isArray(data.permissions)?data.permissions:[],checkedAt:now()};this.event('info','货盘连接已验证');}
  catch(e){guard();this.connection={status:'error',error:e.message,checkedAt:now()};this.persist();throw e;}guard();this.persist();this.emit();return this.state();});
 }
 async sync(){
  return this.configure(async(signal,guard)=>{const client=await this.client(signal);guard();const all=async(method,key)=>{let rows=[];for(let page=1;page<=100;page++){guard();const response=await boundedRead(requestSignal=>client[method]({page,pageSize:100},{signal:requestSignal}),signal);guard();if(!Array.isArray(response[key]))throw Error('货盘返回格式不兼容：'+key);rows.push(...response[key]);if(response[key].length<100||Number.isFinite(response.total)&&rows.length>=response.total)return rows;}throw Error('数据超过本次同步上限，已保留旧数据');};
  // Keep below the provider's four-request server limit; avoid partial catalog commits.
  const products=await all('products','products'),sets=await all('photoSets','sets');
  guard();this.db.products=products.map(normalizeProduct).filter(p=>p.id&&p.sku);this.db.photoSets=sets.map(normalizeSet);this.event('info','已同步 '+this.db.products.length+' 个商品、'+this.db.photoSets.length+' 套照片');this.persist();this.emit();return this.state();});
 }
 saveProductListing(input){
  if(this.closing||this.configPending)throw Error('货盘配置正在更新，请稍后保存商品资料');
  if(this.storageFaulted())throw Error('运营存储不可用，请先修复后保存商品资料');
  if(!plainRecord(input))throw Error('商品刊登资料格式无效');
  const productId=text(input.productId,'商品编号'),products=this.catalog().filter(product=>product.id===productId),product=products[0];
  if(products.length!==1||!product?.sku||text(product.sku,'商品 SKU')!==product.sku)throw Error('请先同步货盘并选择唯一有效的商品');
  if(input.sku!==undefined&&input.sku!==product.sku)throw problem('PRODUCT_MISMATCH','编辑期间商品 SKU 已改变，请重新核对商品资料');
  const previous=this.db.productListings.find(row=>row.productId===productId);
  if(previous&&previous.sku!==product.sku)throw problem('PRODUCT_MISMATCH','货盘商品 SKU 与原商品资料不一致，原资料已保留');
  const listing=normalizeListing(input.listing),listingPriceCents=draftPrice(input.listingPriceCents,'商品售价'),minOfferCents=draftPrice(input.minOfferCents,'最低接受价');
  validateDraftPrices(listingPriceCents,minOfferCents);
  const row={productId,sku:product.sku,listing,listingPriceCents,minOfferCents,createdAt:previous?.createdAt||now(),updatedAt:now()},before=this.db.productListings;
  this.db.productListings=previous?before.map(item=>item===previous?row:item):[...before,row];
  try{this.persist();}catch(error){this.db.productListings=before;throw error;}
  this.emit();return {...clone(row),missingFields:missingListingFields(row.listing)};
 }
 preparePlan(input){
  if(this.closing||this.configPending)throw Error('货盘配置正在更新，请稍后保存计划');
  const previous=input.id?this.db.plans.find(p=>p.id===input.id):null;if(input.id&&!previous)throw Error('计划不存在');
  if(previous&&this.isPlanArchived(previous.id))throw archivedPlanError();
  if(previous&&this.db.publications.submissions.some(r=>r.proof.facts.planId===previous.id&&isPublicationOpen(r)))throw Error('该计划已有未完成的刊登提交记录，请先核对原刊登');
  if(previous&&(this.profileBusy(previous.profileId)||this.profileBusy(input.profileId)||this.db.jobs.some(j=>j.planId===previous.id&&!terminal.has(j.state)&&!this.recoverableJob(j,previous,{allowQueued:true}))))throw Error('该计划的环境仍有执行中或已提交的任务，请先停止并核对原任务再修改；其他环境可继续管理');
  const plan=validatePlan(input,{profiles:this.profiles(),products:this.catalog(),previous});
  const hasPhotos=previous&&[...this.db.photoPreparations,...(this.db.localPhotoPreparations||[])].some(row=>row.planId===previous.id);
  if(previous&&previous.sku!==plan.sku&&hasPhotos)throw Error('已有照片领取的计划不能更换 SKU，原记录已保留');
  if(previous&&(previous.profileId!==plan.profileId||previous.productId!==plan.productId)&&(previous.activeListingId||previous.completedCount||this.db.jobs.some(j=>j.planId===previous.id)||hasPhotos))throw Error('已有业务记录的计划不能更换窗口或 SKU，请新建计划');
  if(input.sku!==undefined&&input.sku!==plan.sku)throw problem('PRODUCT_MISMATCH','编辑期间商品 SKU 已改变，请重新核对上架计划');
  const duplicate=this.db.plans.find(p=>p.id!==plan.id&&p.profileId===plan.profileId&&p.productId===plan.productId);
  if(duplicate){if(this.isPlanArchived(duplicate.id))throw archivedPlanError();throw Error('该窗口已存在此商品的计划，请编辑原计划');}
  return {previous,plan};
 }
 savePlan(input){
  const {previous,plan}=this.preparePlan(input);
  if(previous)Object.assign(previous,plan);else this.db.plans.push(plan);this.event('info','已保存 '+plan.name+' 的销售计划');this.persist();this.emit();return plan;
 }
 assertPlanStart(plan){
  if(this.isPlanArchived(plan.id))throw archivedPlanError();
  if(this.closing)throw stopped();
  if(this.storageFaulted())throw Error('运营存储不可用，请修复后再启用计划');
  if(this.configPending)throw Error('货盘配置正在更新，请等待完成后启用计划');
  if(this.db.settings.backgroundEnabled!==true)throw problem('BACKGROUND_NOT_ALLOWED','请先在「连接与规则」勾选「允许后台持续调度」并保存，再启用并开始计划；本次未启用计划');
  if(!this.running&&this.profileBusy(plan.profileId))throw problem('PAGE_BUSY','这个环境仍在停止，请等待当前步骤结束后再启用计划；其他环境可继续管理');
  const profiles=this.profiles().filter(row=>row.id===plan.profileId),products=this.catalog().filter(row=>row.id===plan.productId);
  if(profiles.length!==1||profiles[0].status==='starting')throw problem('PROFILE_MISSING','计划的固定环境不存在或尚未启动完成');
  if(products.length!==1||products[0].sku!==plan.sku)throw problem('PRODUCT_MISMATCH','商品或 SKU 已改变，请同步货盘并重新核对计划');
  if((plan.source||'supplier')!==products[0].source)throw problem('PRODUCT_MISMATCH','计划商品来源与保存的商品不一致，请重新核对原商品');
  if(plan.source==='local'){
   if(!Number.isInteger(products[0].localPhotoCount)||products[0].localPhotoCount<1||products[0].localPhotoCount>20)throw problem('PHOTO_UNVERIFIED','请先为本地商品导入 1–20 张自己的照片，再启用计划');
  }else if(!this.db.encryptedToken||!validEventText(this.db.supplierAccountId))throw problem('SUPPLIER_NOT_CONNECTED','请先保存货盘凭据并检查连接，确认货盘账号后再启用计划');
  const missing=missingListingFields(plan.listing),labels={title:'商品标题',description:'商品描述',categoryPath:'分类路径',condition:'成色',brand:'品牌',color:'颜色',parcel:'包裹规格'};
  if(missing.length)throw problem('LISTING_INCOMPLETE','请先补全商品资料：'+missing.map(key=>labels[key]||key).join('、'));
  if(!['Petit','Moyen','Grand'].includes(plan.listing.parcel))throw problem('LISTING_INCOMPLETE','请按实际包装选择包裹规格 Petit / Moyen / Grand');
  if(!Number.isSafeInteger(products[0].stock)||products[0].stock<1)throw problem('NO_STOCK','货盘库存未知或不足，请同步商品并核对库存后再启用计划');
  const readiness=this.adapter.readiness(plan.profileId),publish=readiness?.capabilities?.listingPublish??readiness?.capabilities?.publish;
  if(readiness?.capabilities?.sessionListing!==true){
   const expected=accountExpectation(this,plan.profileId),own=this.db.marketAccounts.filter(row=>row.profileId===plan.profileId),account=own[0];
   if(own.length!==1&&readiness?.capabilities?.autoBindAccount!==true)throw problem('ACCOUNT_NOT_BOUND','当前执行器不能自动确认登录身份，请先确认该环境的 Vinted 登录');
   if(account){this.validateMarketAccount(account);if(expected.memberId!==account.memberId)throw problem('ACCOUNT_CONFLICT','Vinted 账号绑定冲突，请先核对原账号和环境');}
  }
  if(publish!==true)throw problem('CAPABILITY_UNVERIFIED','当前版本尚未提供可运行的自动上架流程');
  if(this.db.jobs.some(row=>row.profileId===plan.profileId&&(row.state==='uncertain'||row.mutationPending===true||['queued','running'].includes(row.state)&&(row.operation!=null||row.result!=null)))||this.db.publications.submissions.some(row=>row.proof.facts.profileId===plan.profileId&&row.state==='uncertain'&&isPublicationOpen(row)))throw problem('RECONCILE_REQUIRED','这个账号有结果未知的原操作，请先核对原任务，不能再次上架');
  if(plan.activeListingId||this.db.publications.submissions.some(row=>row.proof.facts.planId===plan.id&&isPublicationOpen(row)))throw problem('PUBLICATION_EXISTS','这个计划已有在售商品或原提交记录，请核对原刊登，不能重复上架');
  if(plan.completedCount>=plan.targetCount||!saleCycleComplete(this.db,plan.id))throw problem('SALE_CYCLE_PENDING','销售目标已完成或原成交尚未核对，请先处理原记录');
  const pending=this.db.jobs.filter(row=>row.planId===plan.id&&!terminal.has(row.state)),current=this.db.jobs.filter(row=>row.type==='listing'&&row.planId===plan.id&&row.payload?.cycle===plan.completedCount&&listingRevision(row.payload?.listingRevision)===listingRevision(plan.listingRevision));
  const resume=current.filter(row=>['needs_review','cancelled','rejected'].includes(row.state)&&this.recoverableJob(row,plan)),resuming=new Set(resume.map(row=>row.id));
  if(this.db.jobs.some(row=>row.profileId===plan.profileId&&row.state==='needs_review'&&['PROFILE_CLOSED','PROFILE_STOPPED'].includes(row.blockedReason)&&!resuming.has(row.id)))throw problem('PROFILE_MANUALLY_PAUSED','这个账号的另一个原任务已被手动停止；请在对应计划继续或核对原任务，本次不会清除其他计划的暂停');
  if(pending.some(row=>row.state==='needs_review'&&!resuming.has(row.id)||row.state==='queued'&&!this.recoverableJob(row,plan,{allowQueued:true}))||current.some(row=>terminal.has(row.state)&&!resuming.has(row.id)))throw problem('JOB_REVIEW_REQUIRED','原任务的提交、周期或身份尚无法核对，请检查原记录；确定未提交的原任务可直接点击开始继续');
  return resume;
 }
 startPlan(id){
  const plans=this.db.plans.filter(row=>row.id===id);if(plans.length!==1)throw Error('销售计划不存在或不唯一');
  const previous=plans[0],plan={...clone(previous),enabled:true,status:'ready',updatedAt:now()},resume=this.assertPlanStart(plan);return this.commitPlanStart(previous,plan,resume);
 }
 saveAndStartPlan(input){
  const {previous,plan}=this.preparePlan({...input,enabled:true}),resume=this.assertPlanStart(plan);return this.commitPlanStart(previous,{...plan,status:'ready'},resume);
 }
 commitPlanStart(previous,plan,resume=[]){
  const plansBefore=this.db.plans,previousBefore=previous&&clone(previous),eventsBefore=this.db.events.slice(),scopeBefore=this.runningPlanIds,runningBefore=this.running;
  const jobsBefore=resume.map(job=>({job,before:clone(job)}));for(const {job}of jobsBefore)Object.assign(job,retryPatch());
  if(previous)Object.assign(previous,plan);else this.db.plans=[...this.db.plans,plan];
  this.runningPlanIds=runningBefore&&scopeBefore==null?null:new Set([...(runningBefore?scopeBefore||[]:[]),plan.id]);this.running=true;
  this.event('info',plan.name+'：已启用并开始；'+(this.runningPlanIds===null?'沿用当前全部已启用计划调度':'仅调度本次明确启动的计划'));
  try{this.persist();}catch(error){if(previous)Object.assign(previous,previousBefore);for(const {job,before}of jobsBefore)restoreRow(job,before);this.db.plans=plansBefore;this.db.events=eventsBefore;this.runningPlanIds=scopeBefore;this.running=this.storageFaulted()?false:runningBefore;throw error;}
  this.ensureRunnerTimer();this.emit();this.kickRun();return {started:true,resumedJobIds:resume.map(job=>job.id),plan:clone(previous||plan),state:this.state()};
 }
 ensureRunnerTimer(){
  if(!this.timer)this.timer=setInterval(()=>{if(this.running)this.kickRun();},15000);
 }
 kickRun(){
  const generation=this.runGeneration,previous=this.tickPromise;
  void Promise.resolve(previous).then(()=>{if(this.running&&generation===this.runGeneration&&!this.closing)return this.runOnce();}).catch(error=>{if(this.closing||generation!==this.runGeneration)return;this.running=false;this.event('error',String(error.message||'后台执行失败').slice(0,700));if(!this.storageFaulted())try{this.persist();}catch{}this.emit();});
 }
 runningScope(){return this.running&&this.runningPlanIds instanceof Set?new Set(this.runningPlanIds):null;}
 planInScope(planId,scope=this.runningScope()){return !this.isPlanArchived(planId)&&(scope===null||scope.has(planId));}
 setPlanEnabled(id,enabled){const plan=this.plan(id);plan.enabled=enabled===true;if(!plan.enabled){const lease=this.leases.snapshot().find(item=>item.profileId===plan.profileId),job=lease&&this.db.jobs.find(item=>item.id===lease.jobId);if(job?.planId===id)this.active.get(plan.profileId)?.abort();}plan.status=plan.enabled?'ready':'paused';plan.updatedAt=now();this.persist();this.emit();return plan;}
 isPlanArchived(id){return isPlanArchived(this.db,id);}
 plan(id,{includeArchived=false}={}){const p=this.db.plans.find(p=>p.id===id);if(!p)throw Error('销售计划不存在');if(!includeArchived&&this.isPlanArchived(id))throw archivedPlanError();return p;}
 profileBusy(profileId){return this.active.has(profileId)||this.leases.snapshot().some(row=>row.profileId===profileId);}
 recoverableJob(job,plan,{allowQueued=false}={}){return recoverableJob(job,plan,this.db,{allowQueued,sessionListing:job.type==='listing'&&this.adapter.readiness(plan.profileId)?.capabilities?.sessionListing===true})&&(job.type!=='listing'||saleCycleComplete(this.db,plan.id));}
 canRetry(job){
  const plan=job&&this.db.plans.find(p=>p.id===job.planId);return !!plan&&this.recoverableJob(job,plan);
 }
 enqueue(type,plan,payload={},dedupeKey){
  if(this.isPlanArchived(plan.id))throw archivedPlanError();
  const found=this.db.jobs.find(j=>j.dedupeKey===dedupeKey);if(found)return found;
  const job=queuedJob(type,plan,payload,dedupeKey);this.db.jobs.push(job);this.persist();return job;
 }
 seed(profileId,scope=this.runningScope()){for(const p of this.db.plans){if(!this.planInScope(p.id,scope)||profileId!==undefined&&p.profileId!==profileId||!p.enabled||p.completedCount>=p.targetCount||p.activeListingId||!saleCycleComplete(this.db,p.id)||this.db.publications.submissions.some(r=>r.proof.facts.planId===p.id&&isPublicationOpen(r)))continue;const outstanding=this.db.jobs.some(j=>j.planId===p.id&&!terminal.has(j.state));if(!outstanding)this.enqueue('listing',p,{cycle:p.completedCount,listingRevision:listingRevision(p.listingRevision)},listingJobKey(p.id,p.completedCount,p.listingRevision));}}
 stopProfile(profileId,code='PROFILE_STOPPED'){
  if(!['PROFILE_CLOSED','PROFILE_STOPPED'].includes(code))throw new TypeError('Invalid profile stop reason');
  const reason=problem(code,code==='PROFILE_CLOSED'?'你已关闭该环境；此账号任务暂停，请在任务记录中确认后重试':'你已停止该环境的自动操作；此账号任务暂停，请在任务记录中确认后重试');
  const controller=this.active.get(profileId),lease=this.leases.snapshot().find(row=>row.profileId===profileId);
  controller?.abort(reason);
  // A running business job records its own abort result and preserves any
  // uncertain submission. Polling and supplier maintenance have no such job.
  if(controller&&this.db.jobs.some(job=>job.id===lease?.jobId&&job.profileId===profileId&&job.state==='running')){this.emit();return true;}
  if(!this.running||this.closing||this.storageFaulted()||manuallyPausedProfile(this.db.jobs,profileId))return !!controller;
  const pending=()=>this.db.jobs.find(job=>job.profileId===profileId&&job.state==='queued'&&job.operation==null&&job.mutationPending===false&&job.result==null);
  let job=pending();if(!job){this.seed(profileId);job=pending();}if(!job)return !!controller;
  job.state='needs_review';job.blockedReason=code;job.error=reason.message;job.retryAt=null;job.updatedAt=now();
  this.event('warning',reason.message);this.persist();this.emit();return true;
 }
 missingCapabilities(job){const readiness=this.adapter.readiness(job.profileId);if(readiness?.salesOnly===true&&job.type==='fulfillment')return ['procurementDisabled'];return !readiness?.capabilities&&typeof this.adapter.executeJob!=='function'?[]:(CAPABILITIES[job.type]||['unknown']).filter(cap=>readiness?.capabilities?.[cap]!==true);}
 setRunning(enabled){
  if(this.closing)throw stopped();if(enabled&&this.storageFaulted())throw Error('请先修复运营存储');if(enabled&&this.configPending)throw Error('货盘配置正在更新，请等待完成后启动后台');if(enabled&&this.db.settings.backgroundEnabled!==true)throw Error('请先在连接与规则中启用后台运行，再启动持续调度');
  this.running=enabled===true;this.runningPlanIds=null;if(this.running)this.ensureRunnerTimer();else{this.runGeneration++;this.tickController?.abort();for(const controller of this.active.values())controller.abort();}
  this.event('info',this.running?'全部已启用计划的后台队列已启动；未验证的页面步骤会停在待核对。':'后台已停止；已提交但未确认的请求需要核对原记录。');this.persist();this.emit();if(this.running)this.kickRun();return this.state();
 }
 tickCurrent(generation,signal){return !this.closing&&!this.storageFaulted()&&!this.configPending&&generation===this.runGeneration&&!signal?.aborted;}
 async runOnce(){
  if(this.closing)throw stopped();if(this.configPending)throw Error('货盘配置正在更新，请等待完成后运行');if(this.ticking)return this.tickPromise?await this.tickPromise:this.state();if(this.storageFaulted())throw Error('运营存储不可用');this.ticking=true;
  const generation=this.runGeneration,controller=new AbortController(),planIds=this.runningScope();this.tickController=controller;
  const cycle=(async()=>{if(typeof this.adapter.maintenance==='function'&&this.tickCurrent(generation,controller.signal)){try{await this.adapter.maintenance({engine:this,signal:controller.signal,planIds});}catch(error){if(this.storageFaulted())throw error;if(this.tickCurrent(generation,controller.signal)){this.event('warning',String(error.message||'货盘刊登关联核对失败').slice(0,500));this.persist();}}}if(!this.tickCurrent(generation,controller.signal))return this.state();await this.poll({signal:controller.signal,generation,planIds});if(!this.tickCurrent(generation,controller.signal))return this.state();this.seed(undefined,planIds);const selected=[],busy=new Set(this.active.keys());let changed=false;for(const j of [...this.db.jobs].sort((a,b)=>({fulfillment:0,sale_confirmation:0,offer:1,message:2,listing:3}[a.type]??9)-({fulfillment:0,sale_confirmation:0,offer:1,message:2,listing:3}[b.type]??9))){if(!this.tickCurrent(generation,controller.signal))break;if(selected.length+this.active.size>=this.db.settings.maxConcurrent)break;if(!this.planInScope(j.planId,planIds)||j.state!=='queued'||manuallyPausedProfile(this.db.jobs,j.profileId))continue;if(this.db.jobs.filter(other=>other.id===j.id).length!==1||!j.dedupeKey||this.db.jobs.filter(other=>other.dedupeKey===j.dedupeKey).length!==1){j.state='needs_review';j.error='任务或业务去重编号重复，已停止调度';changed=true;continue;}if(j.type==='listing'&&this.db.publications.submissions.some(r=>r.proof.facts.planId===j.planId&&isPublicationOpen(r))){j.state='needs_review';j.error='原刊登提交记录尚未关闭，不能重复执行刊登';changed=true;continue;}const p=this.db.plans.find(plan=>plan.id===j.planId);if(!p||p.profileId!==j.profileId||p.productId!==j.productId){j.state='needs_review';j.error='任务与原销售计划不匹配，请核对原记录';changed=true;continue;}if(j.type==='listing'&&(j.payload?.cycle!==p.completedCount||listingRevision(j.payload?.listingRevision)!==listingRevision(p.listingRevision))){j.state='needs_review';j.error='该任务属于旧刊登周期或删除前版本，不能再次执行';j.blockedReason='LISTING_REVISION_CHANGED';changed=true;continue;}if(!p.enabled||busy.has(j.profileId)||this.missingCapabilities(j).length||j.type==='listing'&&!saleCycleComplete(this.db,p.id))continue;if(j.retryAt!=null){const due=Date.parse(j.retryAt);if(!Number.isFinite(due)){j.state='needs_review';j.error='任务重试时间无效，已停止调度';changed=true;continue;}if(due>Date.now())continue;}if(this.db.jobs.some(other=>other.profileId===j.profileId&&(other.state==='uncertain'||other.mutationPending===true)))continue;busy.add(j.profileId);selected.push(j);}if(changed)this.persist();await Promise.all(selected.map(j=>this.tickCurrent(generation,controller.signal)?this.runJob(j):undefined));return this.state();})();this.tickPromise=cycle;
  try{return await cycle;}finally{if(this.tickPromise===cycle){this.ticking=false;this.tickPromise=null;this.tickController=null;}this.emit();}
 }
 async external(job,kind,payload,fn){
  if(this.active.get(job.profileId)?.signal.aborted||!this.plan(job.planId).enabled)throw problem('STOPPED','任务已停止，尚未发出下一步请求');
  const hash=fingerprint(payload),old=job.operation;
  if(old?.kind===kind){if(old.fingerprint!==hash)throw problem('PAYLOAD_CHANGED','原业务请求内容发生变化，禁止复用编号重试',true);if(Object.hasOwn(old,'receipt'))return old.receipt;if(job.mutationPending)throw problem('UNKNOWN_RESULT','原请求结果未知，先核对，不能自动重发',true);}
  job.operation={kind,idempotencyKey:old?.kind===kind?old.idempotencyKey:'isola-'+randomUUID(),fingerprint:hash};job.mutationPending=true;job.updatedAt=now();this.persist();
  const result=await fn(job.operation.idempotencyKey);job.operation.receipt=result;job.mutationPending=false;job.updatedAt=now();this.persist();return result;
 }
 async runJob(job){
  if(this.closing||this.storageFaulted()||this.configPending)throw problem('STOPPED','运营调度当前不可执行');
  if(this.isPlanArchived(job?.planId))throw archivedPlanError();
  if(!this.db.jobs.includes(job)||job.state!=='queued'||job.operation!=null||job.mutationPending!==false||job.result!=null)throw problem('JOB_NOT_RUNNABLE','任务状态不允许重新执行，请先核对原记录');
  if(!(job.type==='listing'&&this.adapter.readiness(job.profileId)?.capabilities?.sessionListing===true)){
   const records=this.marketAccountRecords(),ownAccounts=records.filter(row=>row.profileId===job.profileId);
   if(ownAccounts.length>1||ownAccounts.some(own=>records.some(row=>row.profileId!==job.profileId&&row.platform===own.platform&&row.memberId===own.memberId)))throw problem('ACCOUNT_CONFLICT','账号绑定记录冲突，已停止该账号的业务操作');
  }
  if(this.db.jobs.filter(j=>j.id===job.id).length!==1||typeof job.dedupeKey!=='string'||!job.dedupeKey||this.db.jobs.filter(j=>j.dedupeKey===job.dedupeKey).length!==1)throw problem('DUPLICATE_JOB','任务编号或业务去重编号重复，已停止执行');
  const boundPlan=this.db.plans.find(p=>p.id===job.planId);if(!boundPlan||boundPlan.profileId!==job.profileId||boundPlan.productId!==job.productId||!this.profiles().some(p=>p.id===job.profileId))throw problem('PLAN_MISMATCH','任务与原计划、商品或环境不一致');
  if(job.type==='listing'&&this.db.publications.submissions.some(r=>r.proof.facts.planId===job.planId&&isPublicationOpen(r)))throw problem('PUBLICATION_EXISTS','原刊登提交记录尚未关闭，不能再次执行刊登');
  if(job.type==='listing'&&(job.payload?.cycle!==boundPlan.completedCount||listingRevision(job.payload?.listingRevision)!==listingRevision(boundPlan.listingRevision)))throw problem('LISTING_REVISION_CHANGED','该任务属于旧刊登周期或删除前版本，不能再次执行');
  if(!this.planInScope(job.planId)||manuallyPausedProfile(this.db.jobs,job.profileId)||!boundPlan.enabled||this.missingCapabilities(job).length||job.type==='listing'&&!saleCycleComplete(this.db,boundPlan.id))return false;
  if(this.active.has(job.profileId))return false;
  const lease=this.leases.acquire(job.profileId,job.id);if(!lease)return false;
  const controller=new AbortController();this.active.set(job.profileId,controller);
  const jobId=job.id,profileId=job.profileId;
  const currentJob=()=>{const found=this.db.jobs.filter(row=>row.id===jobId);if(found.length!==1)throw problem('JOB_CHANGED','原任务在运行期间发生变化，已停止');return found[0];};
  try{
   job.state='running';job.updatedAt=now();this.persist();this.emit();
   const plan=this.plan(job.planId),signal=controller.signal;
   await this.adapter.requireReady(plan.profileId,{job,plan,engine:this,signal});
   job=currentJob();
   if(signal.aborted||!this.plan(job.planId).enabled)throw problem('STOPPED','任务已停止');
   if(typeof this.adapter.executeJob==='function')await this.adapter.executeJob({engine:this,job,plan:this.plan(job.planId),signal});
   else if(job.type==='listing')await this.listing(job,plan,signal);
   else if(job.type==='message')await this.message(job,plan,signal);
   else if(job.type==='offer')await this.offer(job,plan,signal);
   else if(job.type==='fulfillment')await this.fulfill(job,plan,signal);
   else throw Error('未知运营任务');
   job=currentJob();
   if(['fulfillment','sale_confirmation'].includes(job.type)&&(job.result?.verified!==true||!validEventText(job.result?.externalId)||job.type==='sale_confirmation'&&(job.result.kind!=='sale_confirmation'||job.result.externalId!==job.payload.id)))throw problem('SALE_COMPLETION_UNVERIFIED','原成交任务尚无与原订单一致的已验证结果，不能开始下一周期',!!job.operation);
   if(job.type==='sale_confirmation'){const currentPlan=this.plan(job.planId);currentPlan.status=currentPlan.completedCount>=currentPlan.targetCount?'target_reached':'ready';}
   job.state='completed';job.error='';job.blockedReason=null;this.event('success',plan.name+'：'+job.type+' 步骤已核对完成');
  }catch(e){
   if(controller.signal.aborted&&['PROFILE_CLOSED','PROFILE_STOPPED'].includes(controller.signal.reason?.code)&&!e.ambiguous)e=controller.signal.reason;
   else if(e?.code==='STOPPED'&&!controller.signal.aborted){const interrupted=problem('OPERATION_INTERRUPTED','原步骤在任务未取消时中断，已暂停原任务：'+String(e.message||'页面或环境发生变化').slice(0,500),e.ambiguous===true);interrupted.cause=e;e=interrupted;}
   job=currentJob();if(job.mutationPending&&e.ambiguous===false&&e.status>=400&&e.status<500){job.mutationPending=false;job.operation.rejected=true;}const recovery=retryDecision(job,e);job.state=recovery.state;job.attempts=recovery.attempts;job.retryAt=recovery.retryAt;job.blockedReason=recovery.reasonCode;job.error=String(e.message).slice(0,700);this.event('warning',(this.db.plans.find(p=>p.id===job.planId)?.name||'原计划')+'：'+job.error);
  }
  finally{try{job=currentJob();job.updatedAt=now();if(!this.faulted)this.persist();}finally{if(this.active.get(profileId)===controller)this.active.delete(profileId);this.leases.release(lease);this.emit();}}
 }
 async product(plan,client,signal){const data=await boundedRead(requestSignal=>client.product(plan.productId,{signal:requestSignal}),signal),raw=data.product||data,p=normalizeProduct(raw);if(p.id!==plan.productId||p.sku!==plan.sku)throw problem('PRODUCT_MISMATCH','货盘商品编号或 SKU 不一致');if(p.stock===null||p.stock<1)throw problem('NO_STOCK','库存未知或不足，已停止');return p;}
 async listing(job,plan,signal){
  if(plan.activeListingId)throw problem('ACTIVE_LISTING','该商品已有在售记录，禁止重复刊登');
  const client=await this.client(signal);if(signal?.aborted||this.closing)throw stopped();const product=await this.product(plan,client,signal);
  const check=await this.adapter.findListing(plan,{signal});if(check?.exists)throw problem('EXISTING_LISTING','网页已有匹配刊登，请先关联原刊登，不能重复发布');
  let claim=this.db.claims.find(c=>c.profileId===plan.profileId&&c.productId===plan.productId&&(plan.reuseOwnPhotos||!c.listings.length));
  if(!claim){job.step='claim_photos';const result=await this.external(job,'claim',{productId:plan.productId},key=>client.claimPhotos({productId:plan.productId},{idempotencyKey:key,signal}));if(!result.claimId||!result.set?.images?.length)throw problem('CLAIM_UNVERIFIED','照片领取返回内容不完整，请核对原领取',true);claim={id:result.claimId,profileId:plan.profileId,productId:plan.productId,setId:result.set.id,images:result.set.images,listings:[]};this.db.claims.push(claim);job.payload.claimId=claim.id;this.persist();}
  job.step='prepare_listing';const draft=await this.adapter.prepareListing(plan,{product,claim,client,signal});
  if(draft?.productId!==plan.productId||draft.claimId!==claim.id||draft.priceCents!==plan.listingPriceCents||draft.currency!=='EUR'||draft.imageCount!==claim.images.length||draft.imagesVerified!==true)throw problem('DRAFT_MISMATCH','刊登草稿的商品、价格、币种或照片内容没有完全匹配');
  job.step='publish_listing';const result=await this.external(job,'publish',{planId:plan.id,cycle:job.payload.cycle,listingRevision:listingRevision(job.payload.listingRevision),draft},()=>this.adapter.publishListing(plan,draft,{signal}));
  if(!result?.listingId||!result.url||result.verified!==true||result.priceCents!==plan.listingPriceCents)throw problem('LISTING_UNVERIFIED','刊登结果不明确，请核对实际商品页',true);
  plan.activeListingId=result.listingId;plan.status='listed';claim.listings.push({listingId:result.listingId,url:result.url,createdAt:now()});job.result={externalId:result.listingId};job.step='record_listing';this.persist();
  if(claim.listings.length===1)await this.external(job,'mark_listed',{claimId:claim.id,listingId:result.listingId},key=>client.markListed(claim.id,{action:'published',platform:'Vinted',listingId:result.listingId,listingUrl:result.url},{idempotencyKey:key,signal}));
 }
 // Only a validated main-process adapter may ingest platform events. IPC never
 // accepts raw event facts or a publication closure supplied by a renderer.
 eventInput(planId,event,db=this.db){
  if(isPlanArchived(db,planId))throw archivedPlanError();
  const plans=db.plans.filter(row=>row.id===planId),plan=plans[0];
  if(plans.length!==1||!event||typeof event!=='object'||Array.isArray(event)||event.verified!==true||event.profileId!==plan.profileId||!['message','offer','sale'].includes(event.type)||!['id','listingId','buyerUsername'].every(key=>validEventText(event[key])))throw problem('EVENT_UNVERIFIED','平台事件的类型、账号、买家或刊登编号无法核对');
  const accounts=db.marketAccounts.filter(row=>row.profileId===plan.profileId);
  if(accounts.length>1||typeof this.adapter.executeJob==='function'&&accounts.length!==1||accounts.length===1&&event.memberId!==accounts[0].memberId||event.buyerMemberId!==undefined&&(typeof event.buyerMemberId!=='string'||!/^[1-9]\d{0,24}$/.test(event.buyerMemberId)))throw problem('EVENT_ACCOUNT_MISMATCH','平台事件与当前绑定账号或买家编号不一致');
  const dedupeKey=event.type==='sale'?'vinted-order:'+event.id:'vinted-'+event.type+':'+event.id;
  const existing=db.jobs.filter(job=>job.dedupeKey===dedupeKey);
  if(event.type==='sale'){
   const sales=db.sales.filter(row=>row.platformOrderId===event.id);
   if(sales.length||existing.length){
    const job=existing[0];
    if(sales.length!==1||existing.length!==1||sales[0].planId!==planId||sales[0].jobId!==job?.id||job.planId!==planId||!['fulfillment','sale_confirmation'].includes(job.type)||fingerprint(eventIdentity(event))!==fingerprint(eventIdentity(job.payload)))throw problem('SALE_CONFLICT','相同订单编号出现不同的商品、账号、买家或金额，已停止核对');
    return {plan,dedupeKey,existing:job};
   }
  }else if(existing.length){
   const job=existing[0];if(existing.length!==1||job.planId!==planId||job.type!==event.type||fingerprint(eventIdentity(event))!==fingerprint(eventIdentity(job.payload)))throw problem('EVENT_CONFLICT','同一平台事件编号出现不同的对话、买家、商品或内容，已保留原任务');
   return {plan,dedupeKey,existing:job};
  }
  if(event.listingId!==plan.activeListingId)throw problem('EVENT_UNVERIFIED','平台事件与当前在售商品无法核对');
  if(event.type==='sale'&&(event.paid!==true||event.cancelled!==false||event.currency!=='EUR'||!Number.isSafeInteger(event.priceCents)||event.priceCents<plan.minOfferCents||event.priceCents>plan.listingPriceCents||event.quantity!==1))throw problem('SALE_UNVERIFIED','成交付款、取消状态、单品金额或数量需要核对');
  if(event.type==='offer'&&(event.currency!=='EUR'||!Number.isSafeInteger(event.priceCents)||event.priceCents<1||event.quantity!==1))throw problem('OFFER_UNVERIFIED','报价币种、单品金额或数量需要核对');
  return {plan,dedupeKey,existing:null};
 }
 applySale(db,plan,event,job){
  db.jobs.push(job);db.sales.push({platformOrderId:event.id,planId:plan.id,jobId:job.id,priceCents:event.priceCents,createdAt:now()});
  plan.completedCount++;plan.activeListingId=null;plan.status=job.type==='sale_confirmation'?'sale_pending_confirmation':'fulfilling';plan.updatedAt=now();
 }
 saleJob(plan,event,dedupeKey){return queuedJob(this.adapter.readiness(plan.profileId)?.salesOnly===true?'sale_confirmation':'fulfillment',plan,clone(event),dedupeKey);}
 ingestEvent(planId,event){
  if(this.closing||this.storageFaulted())throw stopped();
  const {plan,dedupeKey,existing}=this.eventInput(planId,event);if(existing)return existing;
  if(event.type==='sale'){
   if(this.db.publications.submissions.some(row=>row.proof.facts.planId===planId&&isPublicationOpen(row)))throw problem('PUBLICATION_SALE_TRANSACTION_REQUIRED','原刊登成交必须通过完整的刊登和销售原子事务核对');
   const job=this.saleJob(plan,event,dedupeKey);this.applySale(this.db,plan,event,job);this.persist();this.emit();return job;
  }
  if(event.type==='message'&&!plan.autoReply||event.type==='offer'&&!plan.autoAcceptOffers)return null;
  return this.enqueue(event.type,plan,clone(event),dedupeKey);
 }
 async ingestVerifiedEvent(planId,event){
  if(this.closing||this.storageFaulted())throw stopped();event=clone(event);
  const {plan,dedupeKey,existing}=this.eventInput(planId,event);if(existing)return existing;
  if(event.type!=='sale')return this.ingestEvent(planId,event);
  const records=this.db.publications.submissions.filter(row=>row.proof.facts.planId===planId&&isPublicationOpen(row));
  if(!records.length)return this.ingestEvent(planId,event);
  if(records.length!==1||records[0].state!=='published'||records[0].receipt?.listingId!==event.listingId)throw problem('PUBLICATION_SALE_UNVERIFIED','原刊登及成交尚未唯一关联，不能释放该商品的在售占用');
  const record=records[0],job=this.saleJob(plan,event,dedupeKey);
  const evidence={verified:true,profileId:event.profileId,memberId:event.memberId,listingId:event.listingId,orderId:event.id,paid:event.paid,cancelled:event.cancelled,quantity:event.quantity,priceCents:event.priceCents,currency:event.currency,observedAt:event.observedAt};
  const {commitPublicationSale}=require('./vinted-publish-submit.cjs');
  await commitPublicationSale(this,record.id,evidence,(before,publications)=>{
   const staged=clone(before),current=this.eventInput(planId,event,staged);if(current.existing)throw problem('SALE_CONFLICT','原成交已由另一操作提交，不能重复累计');
   if(current.plan.completedCount!==record.proof.facts.cycle)throw problem('SALE_CONFLICT','原刊登的销售周期已经改变');
   this.applySale(staged,current.plan,event,job);staged.publications=publications;
   return staged;
  });
  return this.db.jobs.find(row=>row.id===job.id);
 }
 async message(job,plan,signal){
  job.step='draft_reply';const latest=await this.adapter.readMessage(job.payload,{signal});if(latest.id!==job.payload.id||latest.listingId!==plan.activeListingId||latest.buyerUsername!==job.payload.buyerUsername)throw problem('MESSAGE_CHANGED','对话、买家或商品已改变');
  const draft=await this.adapter.draftReply(plan,latest,{signal});if(draft?.factual!==true||typeof draft.text!=='string'||!draft.text.trim()||draft.text.length>1500||draft.requiresReview)throw problem('REPLY_REVIEW','问题无法仅凭已确认商品资料回答，请人工处理');
  job.step='send_reply';const result=await this.external(job,'reply',{messageId:latest.id,text:draft.text},()=>this.adapter.sendReply(latest,draft,{signal}));if(result?.verified!==true||!result.messageId)throw problem('REPLY_UNVERIFIED','消息发送结果不明确，请核对当前对话',true);job.result={externalId:result.messageId};
 }
 async offer(job,plan,signal){
  job.step='check_offer';const latest=await this.adapter.readOffer(job.payload,{signal});if(latest?.id!==job.payload.id||latest.listingId!==plan.activeListingId||latest.buyerUsername!==job.payload.buyerUsername||latest.buyerMemberId!==job.payload.buyerMemberId||latest.profileId!==job.payload.profileId||latest.memberId!==job.payload.memberId||latest.priceCents!==job.payload.priceCents||latest.currency!=='EUR'||!Number.isSafeInteger(latest.priceCents)||latest.quantity!==1||latest.status!=='pending')throw problem('OFFER_CHANGED','报价所属商品、币种、数量或状态需要核对');
  if(latest.priceCents<plan.minOfferCents){job.result={summary:'报价低于最低接受价，未接受'};return;}
  if(latest.priceCents>plan.listingPriceCents)throw problem('OFFER_PRICE','报价高于刊登价，请核对是否误读了总额或运费');
  const client=await this.client(signal);if(signal?.aborted||this.closing)throw stopped();await this.product(plan,client,signal);job.step='accept_offer';const result=await this.external(job,'accept_offer',{id:latest.id,priceCents:latest.priceCents},()=>this.adapter.acceptOffer(latest,{signal}));if(result?.verified!==true||result.priceCents!==latest.priceCents)throw problem('OFFER_UNVERIFIED','接受报价结果不明确，请核对原报价',true);job.result={externalId:latest.id,summary:'已接受报价；等待买家付款，不据此采购'};
 }
 reserve(job,total){
  const settings=this.db.settings,day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris'}).format(new Date());
  if(!settings.perOrderLimitCents||!settings.dailyLimitCents)throw problem('PURCHASE_LIMIT','真实下单前必须设置单笔和每日采购上限');
  if(total>settings.perOrderLimitCents)throw problem('PURCHASE_LIMIT','采购金额超出单笔上限');
  if(this.db.reservations.some(r=>r.jobId===job.id))return;
  const reserved=this.db.reservations.filter(r=>r.day===day).reduce((s,r)=>s+r.cents,0);if(reserved+total>settings.dailyLimitCents)throw problem('PURCHASE_LIMIT','采购金额超出当日上限（包含尚未核对的请求）');
  this.db.reservations.push({jobId:job.id,day,cents:total});this.persist();
 }
 async fulfill(job,plan,signal){
  const client=await this.client(signal);if(signal?.aborted||this.closing)throw stopped();const sale=await this.adapter.readSale(job.payload,{signal});
  if(sale?.id!==job.payload.id||sale.listingId!==job.payload.listingId||sale.buyerUsername!==job.payload.buyerUsername||sale.buyerMemberId!==job.payload.buyerMemberId||sale.profileId!==job.payload.profileId||sale.memberId!==job.payload.memberId||sale.verified!==true||sale.paid!==true||sale.cancelled!==false||sale.currency!=='EUR'||sale.priceCents!==job.payload.priceCents||sale.quantity!==1)throw problem('SALE_CHANGED','订单、买家、付款或取消状态发生变化，停止采购');
  job.step='download_label';const label=await this.adapter.shippingLabel(sale,{signal});
  if(label?.verified!==true||label.orderId!==sale.id||label.buyerUsername!==sale.buyerUsername||!label.data||!['application/pdf','image/jpeg','image/png'].includes(label.contentType)||label.data.length>10*1024*1024||label.pages!==1)throw problem('LABEL_UNVERIFIED','运单未能核对订单、买家、格式或页数，不会下单');
  job.step='check_stock_price';const product=await this.product(plan,client,signal);if(product.priceCents===null)throw problem('PRICE_UNSET','货盘采购价未设置或格式未知，禁止使用零价猜测下单');
  const items=[{productId:plan.productId,quantity:1,...(product.revision!==null?{productRevision:product.revision}:{})}];
  const payload={items,buyerUsername:sale.buyerUsername,fulfillmentMethod:this.db.settings.fulfillmentMethod,note:'Vinted order '+sale.id,file:{data:label.data,contentType:label.contentType}};
  let checkout=null;if(payload.fulfillmentMethod==='wms'){job.step='wms_checkout';checkout=await client.checkout({items},{signal});const available=checkout.warehouses?.filter(w=>w.canFulfill===true);const warehouse=available?.find(w=>w.code===checkout.recommendedWarehouse)||available?.[0];if(!warehouse?.code||!checkout.confirmationKey)throw problem('WMS_STOCK','没有已确认可发货的仓库');Object.assign(payload,{warehouse:warehouse.code,confirmationKey:checkout.confirmationKey,confirmWms:'1'});}
  const quote=await this.adapter.purchaseQuote?.(plan,product,sale,checkout);
  if(quote?.verified!==true||quote.currency!=='EUR'||!Number.isSafeInteger(quote.totalCents)||quote.totalCents<product.priceCents||product.revision===null||quote.productRevision!==product.revision)throw problem('QUOTE_UNVERIFIED','采购总额、额外费用或价格版本尚未核对，不会真实下单');
  this.reserve(job,quote.totalCents);job.step='create_supplier_order';const digest={...payload,file:{sha256:createHash('sha256').update(label.data).digest('hex'),contentType:label.contentType}};
  // Freeze exact request bytes locally, encrypted, before the first external mutation.
  const saved={...payload,file:{data:Buffer.from(label.data).toString('base64'),contentType:label.contentType}};job.payload.encryptedOrder=this.seal(JSON.stringify(saved));job.payload.orderDigest=digest;this.persist();
  const result=await this.external(job,'create_order',digest,key=>client.createOrder(payload,{idempotencyKey:key,signal}));
  if(!result?.id)throw problem('ORDER_UNVERIFIED','货盘未返回订单编号，请核对原幂等请求',true);
  job.result={externalId:result.id,wmsOrderId:result.orderId||null,wmsStatus:result.wmsStatus};this.persist();
  if(payload.fulfillmentMethod==='wms'&&result.wmsStatus!=='submitted')throw problem('WMS_PENDING','货盘本地订单已保存，WMS 尚未确认接单。仅核对原订单 '+result.id+'，禁止重新下单',true);
  job.result.verified=true;plan.status=plan.completedCount>=plan.targetCount?'target_reached':'ready';job.step='verified';
 }
 // Explicit operator confirmation records a withdrawal, never a paid sale.
 // The old submission, task and photos remain available for audit; only a new
 // listing revision may run after this atomic journal/database transaction.
 async confirmDeletedListing(planId,request={}){
  const input=clone(request);
  return this.configure(async(signal,guard)=>{
   if(this.isPlanArchived(planId))throw archivedPlanError();
   if(this.storageFaulted()||input.confirmed!==true)throw problem('DELETION_CONFIRMATION_REQUIRED','需要明确确认原商品已删除，才能安排重新上架');
   const id=text(planId,'销售计划编号',256),submissionId=text(input.submissionId,'原提交编号',256),identity=parseListingURL(input.listingURL);
   const inspect=db=>{
    guard();
    const plans=db.plans.filter(row=>row.id===id),plan=plans[0];
    if(plans.length!==1||!plan.enabled||!Number.isSafeInteger(plan.completedCount)||!Number.isSafeInteger(plan.targetCount)||plan.completedCount>=plan.targetCount||!saleCycleComplete(db,id))throw problem('DELETION_PLAN_CHANGED','原计划需启用且销售目标尚未完成，原成交步骤需先核对');
    const records=db.publications.submissions.filter(row=>row.proof.facts.planId===id&&isPublicationOpen(row)),record=records[0];
    if(records.length!==1||record.id!==submissionId||!['uncertain','published'].includes(record.state)||record.attemptCount!==1)throw problem('DELETION_SUBMISSION_CONFLICT','原提交无法唯一匹配或已处理，不能再次确认删除');
    const facts=record.proof.facts,revision=listingRevision(plan.listingRevision);
    if(facts.profileId!==plan.profileId||facts.productId!==plan.productId||facts.sku!==plan.sku||facts.cycle!==plan.completedCount||listingRevision(facts.listingRevision)!==revision||this.profiles().filter(row=>row.id===plan.profileId).length!==1)throw problem('DELETION_PLAN_CHANGED','原提交与当前计划、环境、商品或刊登版本不一致');
    listingRevision(revision+1);
    if(!require('./commerce-session-authority.cjs').isEnvironmentSessionAccount(facts.account,plan.profileId)){
     const accounts=db.marketAccounts.filter(row=>row.profileId===plan.profileId),account=accounts[0];
     if(accounts.length!==1||account.memberId!==facts.account.memberId||account.profileURL!==facts.account.profileURL||db.marketAccounts.some(row=>row.profileId!==plan.profileId&&row.memberId===account.memberId)||(this.accounts?.list()||[]).some(row=>row.profileId!==plan.profileId&&row.identity?.memberId===account.memberId||row.profileId===plan.profileId&&row.identity&&(row.identity.memberId!==account.memberId||row.identity.profileURL!==account.profileURL)))throw problem('DELETION_ACCOUNT_CHANGED','删除确认的账号与原刊登绑定不一致');
    }
    const known=[record.receipt,...(record.navigation||[])].filter(Boolean);
    for(const row of known){const parsed=parseListingURL(row.url);if(parsed.listingId!==identity.listingId||row.listingId!==identity.listingId||row.profileId!==undefined&&row.profileId!==plan.profileId)throw problem('DELETION_LISTING_CONFLICT','填写商品与原刊登或导航回执不一致');}
    if(plan.activeListingId&&plan.activeListingId!==identity.listingId||db.plans.some(row=>row.id!==id&&row.activeListingId===identity.listingId))throw problem('DELETION_LISTING_CONFLICT','原在售商品编号与删除确认不一致');
    if(db.publications.submissions.some(row=>row.id!==record.id&&(row.receipt?.listingId===identity.listingId||row.closedWithdrawal?.listingId===identity.listingId||row.navigation?.some(n=>n.listingId===identity.listingId)))||db.sales.some(row=>row.listingId===identity.listingId||row.planId===id&&db.jobs.find(job=>job.id===row.jobId)?.payload?.listingId===identity.listingId))throw problem('DELETION_LISTING_CONFLICT','同一商品已关联其他刊登或成交记录，不能记为删除');
    const key=listingJobKey(id,plan.completedCount,revision),jobs=db.jobs.filter(row=>row.dedupeKey===key||row.type==='listing'&&row.planId===id&&row.payload?.cycle===plan.completedCount&&listingRevision(row.payload?.listingRevision)===revision),job=jobs[0];
    if(jobs.length>1||job&&(job.type!=='listing'||job.planId!==id||job.profileId!==plan.profileId||job.productId!==plan.productId||job.dedupeKey!==key||job.payload?.cycle!==plan.completedCount||listingRevision(job.payload?.listingRevision)!==revision||!validEventText(job.id)||db.jobs.filter(row=>row.id===job.id).length!==1||job.state==='running'||job.result?.externalId&&job.result.externalId!==identity.listingId||job.result?.submissionId&&job.result.submissionId!==record.id||job.operation&&!['publish','publication'].includes(job.operation.kind)))throw problem('DELETION_JOB_CONFLICT','原刊登任务存在身份或业务请求冲突，不能覆盖');
    if(db.jobs.some(row=>row.id!==job?.id&&row.profileId===plan.profileId&&(row.state==='running'||row.state==='uncertain'||row.mutationPending===true||row.planId===id&&!terminal.has(row.state))))throw problem('DELETION_JOB_CONFLICT','该账号仍有其他执行中或结果待核对的操作，请先核对原任务');
    const nextKey=listingJobKey(id,plan.completedCount,revision+1);if(db.jobs.some(row=>row.dedupeKey===nextKey))throw problem('DELETION_JOB_CONFLICT','重新上架任务已存在，不能重复创建');
    return {plan,record,revision,job,key,nextKey};
   };
   const current=inspect(this.db),signature=fingerprint({plan:current.plan,record:current.record,job:current.job||null});
   const originalAccount=current.record.proof.facts.account,sessionAccount=require('./commerce-session-authority.cjs').isEnvironmentSessionAccount(originalAccount,current.plan.profileId);
   const evidence={kind:'operator_confirmed_deletion',confirmed:true,reason:'deleted_not_sold',reviewId:randomUUID(),profileId:current.plan.profileId,...(sessionAccount?{account:clone(originalAccount)}:{memberId:originalAccount.memberId}),listingId:identity.listingId,url:identity.url,confirmedAt:now()};
   const {commitPublicationDeletion}=require('./vinted-publish-submit.cjs');
   await commitPublicationDeletion(this,submissionId,evidence,(before,publications)=>{
    const fresh=inspect(before);if(signature!==fingerprint({plan:fresh.plan,record:fresh.record,job:fresh.job||null}))throw problem('DELETION_PLAN_CHANGED','确认期间原计划、刊登或任务发生变化，已停止');
    const staged=clone(before),plan=staged.plans.find(row=>row.id===id);let job=fresh.job&&staged.jobs.find(row=>row.id===fresh.job.id);
    if(!job){job=queuedJob('listing',plan,{cycle:plan.completedCount,listingRevision:fresh.revision},fresh.key);staged.jobs.push(job);}
    const previousResult=job.result,previousOperation=job.operation;
    Object.assign(job,{state:'cancelled',step:'listing_deleted',mutationPending:false,operation:null,retryAt:null,blockedReason:null,error:'原商品已确认删除，未计入销售数量',updatedAt:now(),deletion:{...evidence,submissionId},result:{kind:'listing_deleted',submissionId,externalId:identity.listingId,summary:'已确认删除，未计入销量；已安排重新上架',...(previousResult?{previousResult}:{} )},...(previousOperation?{archivedOperation:previousOperation}:{})});
    plan.listingRevision=fresh.revision+1;plan.activeListingId=null;plan.status='ready';plan.updatedAt=now();
    staged.jobs.push(queuedJob('listing',plan,{cycle:plan.completedCount,listingRevision:plan.listingRevision},fresh.nextKey));
    staged.publications=publications;
    for(const sync of staged.publicationSupplierSync||[])if(sync.submissionId===submissionId&&sync.state==='pending'&&sync.attemptCount===0&&sync.operation==null){sync.state='cancelled';sync.updatedAt=now();sync.reason='原刊登已确认删除；尚未发送的照片刊登关联已取消';}
    staged.events.push({time:now(),kind:'info',text:'原商品已确认删除，保留原照片与销量，已安排重新上架：'+plan.name});if(staged.events.length>300)staged.events.shift();
    return staged;
   },{guard});
   guard();return this.state();
  });
 }
 async resolve(id,action,data={}){
  if(this.closing||this.faulted)throw Error('运营队列已关闭或存储不可用，不能修改任务');
  if(this.configPending)throw Error('配置正在更新，请等待完成后处理原任务');const job=this.db.jobs.find(j=>j.id===id);if(!job)throw Error('任务不存在');
  if(this.isPlanArchived(job.planId))throw archivedPlanError();
  if(this.profileBusy(job.profileId)||job.state==='running')throw Error('这个环境仍有运行任务，请等待原步骤结束；其他环境可继续管理');
  if(action==='reconcile'&&(this.active.size||this.running||this.ticking))throw Error('核对原请求前，请先停止后台并等待当前请求结束');
  const before=clone(job),eventsBefore=this.db.events.slice();
  if(action==='cancel'){if(job.mutationPending||job.state==='uncertain'||job.result?.externalId)throw Error('结果不明或已有外部记录的任务不能直接取消，请先核对原记录');job.state='cancelled';job.error='用户取消了尚未提交的任务';}
  else if(action==='retry'){
   if(!this.canRetry(job))throw Error('只有待核对、已取消或已拒绝且确定未提交、无提交记录或结果、与原计划和刊登周期匹配的任务才能重新排队');
   Object.assign(job,retryPatch());
   this.event('info','未提交任务已重新排队；销售计划的启用状态保持不变');
  }
  else if(action==='reconcile'){
   if(!['uncertain','needs_review'].includes(job.state))throw Error('此任务不需要核对');
   if(job.type==='fulfillment'&&job.result?.externalId)return this.configure(async(signal,guard)=>{
    const original=JSON.stringify(job),check=()=>{guard();if(this.db.jobs.filter(row=>row.id===id).length!==1||this.db.jobs.find(row=>row.id===id)!==job||JSON.stringify(job)!==original||this.profileBusy(job.profileId))throw stopped();};check();
    const client=await this.client(signal);check();const response=await boundedRead(s=>client.order(job.result.externalId,{signal:s}),signal);check();const order=response.order;if(!order||String(order.id)!==String(job.result.externalId))throw Error('货盘返回订单不匹配');
    if(job.result.wmsOrderId){const r=await boundedRead(s=>client.wmsOrder(job.result.wmsOrderId,{signal:s}),signal);check();const status=r.order?.status||r.wmsStatus||r.status;if(status!=='submitted')throw Error('WMS 原订单仍未确认接单，已保持待核对');}else if(this.db.settings.fulfillmentMethod==='wms')throw Error('缺少原 WMS 编号，不能自动认定发货成功');
    const plan=this.plan(job.planId),statusBefore=plan.status;check();job.state='completed';job.error='原货盘订单已核对';job.mutationPending=false;job.result.verified=true;plan.status=plan.completedCount>=plan.targetCount?'target_reached':'ready';
    try{this.persist();}catch(error){restoreRow(job,before);plan.status=statusBefore;throw error;}this.emit();return this.state();
   });
   else throw Error('当前任务需要真实页面或原请求记录核对，不能仅凭手工填写编号恢复。记录已保留。');
  }else throw Error('不支持的核对操作');try{this.persist();}catch(error){restoreRow(job,before);this.db.events=eventsBefore;throw error;}this.emit();if(action==='retry'&&this.running)this.kickRun();return this.state();
 }
 async poll({signal,generation=this.runGeneration,planIds=this.runningScope()}={}){
  if(!this.running||!this.tickCurrent(generation,signal)||typeof this.adapter.poll!=='function')return;
  if(this.adapter.readiness()?.salesOnly===true&&this.adapter.readiness()?.capabilities?.sessionListing===true)return;
  const ids=[...new Set(this.db.plans.filter(plan=>plan.enabled&&this.planInScope(plan.id,planIds)).map(plan=>plan.profileId))];
  for(const profileId of ids){
   if(!this.running||!this.tickCurrent(generation,signal))return;
   if(this.active.has(profileId)||this.db.jobs.some(job=>job.profileId===profileId&&(job.state==='uncertain'||job.mutationPending===true)))continue;
   const lease=this.leases.acquire(profileId,'poll:'+randomUUID());if(!lease)continue;
   const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();this.active.set(profileId,controller);
   try{
    const accounts=this.marketAccountRecords().filter(row=>row.profileId===profileId);
    if(accounts.length>1)throw problem('ACCOUNT_CONFLICT','账号绑定记录冲突，已停止页面轮询');
    const plans=clone(this.db.plans.filter(plan=>plan.enabled&&plan.profileId===profileId&&this.planInScope(plan.id,planIds))),expectedAccount=accounts[0]?clone(accounts[0]):null;
    const events=await boundedRead(requestSignal=>this.adapter.poll(profileId,{signal:requestSignal,plans,expectedAccount}),controller.signal);
    if(!this.running||!this.tickCurrent(generation,controller.signal))return;
    if(!Array.isArray(events)||events.length>100||events.some(event=>!event||!['message','offer','sale'].includes(event.type)||event.profileId!==profileId))throw problem('EVENT_BATCH_UNVERIFIED','页面轮询返回了无法识别或跨账号的事件，已停止处理该批结果');
    const identities=new Map();
    for(const event of events){const key=event.type+':'+event.id,identity=fingerprint(eventIdentity(event));if(identities.has(key)&&identities.get(key)!==identity)throw problem('EVENT_CONFLICT','同一轮页面轮询中的同编号事件互相冲突，已暂停该账号队列');identities.set(key,identity);}
    for(const event of events){
     if(!this.running||!this.tickCurrent(generation,controller.signal))return;
     const matching=this.db.plans.filter(plan=>plan.enabled&&plan.profileId===profileId&&this.planInScope(plan.id,planIds)&&(plan.activeListingId===event.listingId||event.type==='sale'&&this.db.sales.some(sale=>sale.planId===plan.id&&sale.platformOrderId===event.id)));
     if(matching.length>1)throw problem('EVENT_PLAN_CONFLICT','同一平台事件对应多个销售计划，已停止处理');
     if(matching.length===1)await this.ingestVerifiedEvent(matching[0].id,event);
    }
   }catch(error){
    if(!this.running||!this.tickCurrent(generation,controller.signal))return;
    if(['SALE_CONFLICT','EVENT_CONFLICT','EVENT_ACCOUNT_MISMATCH','EVENT_PLAN_CONFLICT'].includes(error.code)){
     for(const job of this.db.jobs.filter(row=>row.profileId===profileId&&row.state==='queued'))Object.assign(job,{state:'needs_review',blockedReason:error.code,error:'平台事件事实冲突，原任务已保留：'+String(error.message).slice(0,500),updatedAt:now()});
     this.persist();
    }
    this.event('warning',String(error.message||'页面轮询失败').slice(0,500));
   }
   finally{signal?.removeEventListener('abort',abort);if(this.active.get(profileId)===controller)this.active.delete(profileId);this.leases.release(lease);}
  }
 }
 async close(){if(this.closePromise)return this.closePromise;this.closing=true;this.running=false;this.runGeneration++;if(this.timer)clearInterval(this.timer);this.timer=null;this.tickController?.abort();this.configController?.abort();for(const c of this.active.values())c.abort();this.closePromise=(async()=>{await Promise.allSettled([this.tickPromise,this.configTail].filter(Boolean));while(this.active.size)await new Promise(r=>setTimeout(r,25));if(!this.faulted)this.persist();})();return this.closePromise;}
}
module.exports={CommerceEngine,DEFAULTS,validatePlan,normalizeProduct,normalizeSet,problem,saleCycleComplete,SECRET_STORAGE_TIMEOUT_MS};
