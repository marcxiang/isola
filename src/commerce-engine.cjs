const {normalizeListing}=require('./listing-config.cjs');
const {startupDecision,retryDecision,inspectQueue,ProfileOperationLeases}=require('./commerce-scheduler.cjs');
const {restorePublicationState}=require('./vinted-publication.cjs');
const {summarizePreparation,restorePhotoPreparations}=require('./commerce-photos.cjs');
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
function normalizeProduct(p){return {id:String(p.id||''),sku:String(p.sku||''),name:String(p.name||p.sku||''),stock:nullableInteger(own(p,['stock','stock_quantity'])),priceCents:nullableInteger(own(p,['unitPriceCents','unit_price_cents','priceCents','price_cents','applicable_price_cents','catalog_price_cents'])),photoSetsAvailable:nullableInteger(own(p,['availablePhotoSets','available_photo_sets','photo_sets_available'])),revision:nullableInteger(p.revision)};}
function normalizeSet(s){return {id:String(s.id||''),productId:String(s.productId||s.product_id||''),name:String(s.name||s.id||''),claimStatus:s.claim?'claimed':String(s.status||'unknown'),claimedByMe:s.claimedByMe===true||s.claimed_by_me===true,imageCount:nullableInteger(s.imageCount??s.image_count??s.images?.length),claimId:s.claim?.id||s.claimId||null};}
function fingerprint(input){return createHash('sha256').update(JSON.stringify(input)).digest('hex');}
function queuedJob(type,plan,payload,dedupeKey){return {id:randomUUID(),dedupeKey,type,planId:plan.id,profileId:plan.profileId,productId:plan.productId,state:'queued',step:'pending',payload,operation:null,mutationPending:false,createdAt:now(),updatedAt:now(),error:'',result:null};}
function stopped(){return problem('STOPPED','操作已停止，未提交过期结果');}
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
 const product=products.find(p=>p.id===productId);if(!product)throw Error('请先同步货盘并选择已有商品');
 const listingPriceCents=money(input.listingPriceCents,'刊登价'),minOfferCents=money(input.minOfferCents,'最低接受价');
 if(!listingPriceCents||!minOfferCents||minOfferCents>listingPriceCents)throw Error('售价和最低接受价必须大于零，且最低接受价不能高于售价');
 if(input.currency&&input.currency!=='EUR')throw Error('当前法国流程仅支持 EUR');
 const targetCount=integer(input.targetCount,1,1000,'累计销售目标');
 if(targetCount<(previous?.completedCount||0))throw Error('累计目标不能低于已确认销售数量');
 for(const key of ['autoReply','autoAcceptOffers','reuseOwnPhotos','enabled'])if(input[key]!==undefined&&typeof input[key]!=='boolean')throw Error(key+'设置无效');
 return {id:previous?.id||randomUUID(),profileId,productId,sku:product.sku,name:product.name,targetCount,listingPriceCents,minOfferCents,currency:'EUR',enabled:input.enabled===true,autoReply:input.autoReply===true,autoAcceptOffers:input.autoAcceptOffers===true,reuseOwnPhotos:input.reuseOwnPhotos!==false,replyPolicy:String(input.replyPolicy||'').slice(0,2000),listing:normalizeListing(input.listing===undefined?previous?.listing:input.listing),completedCount:previous?.completedCount||0,activeListingId:previous?.activeListingId||null,status:previous?.status||'paused',createdAt:previous?.createdAt||now(),updatedAt:now()};
}
class CommerceEngine{
 constructor({dir,profiles=()=>[],clientFactory,adapter,seal,unseal,onChange=()=>{}}){
  this.dir=dir;this.profiles=profiles;this.clientFactory=clientFactory;this.adapter=adapter;this.seal=seal;this.unseal=unseal;this.onChange=onChange;this.active=new Map();this.leases=new ProfileOperationLeases();this.accountObservations=new Map();this.running=false;this.timer=null;this.ticking=false;this.faulted=false;this.connection={status:'not_connected'};this.runGeneration=0;this.tickController=null;this.tickPromise=null;this.closing=false;this.closePromise=null;this.configPending=0;this.configController=null;this.configTail=Promise.resolve();
  fs.mkdirSync(dir,{recursive:true,mode:0o700});this.file=path.join(dir,'commerce-state.json');
  this.db=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,settings:{...DEFAULTS},encryptedToken:'',plans:[],products:[],photoSets:[],jobs:[],events:[],claims:[],sales:[],reservations:[]};
  if(this.db.version!==1||!['plans','products','photoSets','jobs','events','claims','sales','reservations'].every(k=>Array.isArray(this.db[k])))throw Error('运营数据格式无效，原文件已保留，不能自动重新建单');
  restorePhotoPreparations(this.db);
  if(this.db.marketAccounts===undefined)this.db.marketAccounts=[];
  if(!Array.isArray(this.db.marketAccounts)||new Set(this.db.marketAccounts.map(a=>a?.profileId)).size!==this.db.marketAccounts.length)throw Error('平台账号记录无效，已保留原数据');
  for(const account of this.db.marketAccounts)this.validateMarketAccount(account);

  this.db.publications=restorePublicationState(this.db.publications).state;
  this.db.settings={...DEFAULTS,...this.db.settings};
  for(const job of this.db.jobs){const recovery=startupDecision(job);if(recovery.state!==job.state){job.state=recovery.state;job.error=recovery.reason;job.updatedAt=now();}}
  this.persist();
 }
 persist(){
  if(this.faulted)throw Error('运营存储已暂停，请检查磁盘后重启应用');
  try{const tmp=this.file+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(this.db,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,this.file);try{const d=fs.openSync(this.dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}catch{}}
  catch(e){this.faulted=true;this.running=false;throw Error('无法持久保存运营状态，已停止外部操作：'+e.message);}
 }
 queueHealth(){return inspectQueue({jobs:this.db.jobs,plans:this.db.plans,profiles:this.profiles(),accounts:this.db.marketAccounts,observedAccounts:[...this.accountObservations.values()],requireVerifiedAccount:true,readiness:this.adapter.readiness(),activeProfileIds:[...this.active.keys()],maxConcurrent:this.db.settings.maxConcurrent,faulted:this.faulted,closing:this.closing,configBusy:this.configPending>0});}
 state(){const queue=this.queueHealth();return {queue,publications:this.db.publications.submissions.map(r=>({id:r.id,planId:r.proof.facts.planId,profileId:r.proof.facts.profileId,productId:r.proof.facts.productId,state:r.state,attemptCount:r.attemptCount,createdAt:r.createdAt,updatedAt:r.updatedAt,reason:r.reason,closedSale:!!r.closedSale,listingUrl:r.receipt?.url||null})),settings:{...this.db.settings,hasToken:!!this.db.encryptedToken},connection:this.connection,profiles:this.profiles().map(p=>({id:p.id,name:p.name,status:p.status,marketAccount:this.db.marketAccounts.find(a=>a.profileId===p.id)||null})),products:this.db.products,photoSets:this.db.photoSets,photoPreparations:this.db.photoPreparations.map(summarizePreparation),plans:this.db.plans.map(plan=>({...plan,activeListingUrl:this.listingURL(plan)})),jobs:this.db.jobs.map(record=>{const {payload,operation,result,...job}=record;return {...job,scheduling:queue.jobs.find(row=>row.jobId===job.id)||null,canRetry:this.canRetry(record),result:result?{externalId:result.externalId||result.id||null,summary:result.summary||null}:null};}),events:this.db.events,running:this.running,configBusy:this.configPending>0,readiness:this.adapter.readiness(),faulted:this.faulted};}
 validateMarketAccount(account){
  if(!account||typeof account!=='object'||Array.isArray(account)||typeof account.profileId!=='string'||!account.profileId||account.platform!=='vinted-fr'||typeof account.memberId!=='string'||!/^[1-9]\d{0,24}$/.test(account.memberId)||typeof account.username!=='string'||!account.username.trim()||account.username.length>100||/[\x00-\x1f\x7f]/.test(account.username)||typeof account.verifiedAt!=='string'||!Number.isFinite(Date.parse(account.verifiedAt)))throw Error('平台账号身份记录无效');
  let url;try{url=new URL(account.profileURL);}catch{throw Error('平台账号地址无效');}
  if(url.origin!=='https://www.vinted.fr'||url.username||url.password||url.search||url.hash||url.pathname!=='/member/'+account.memberId)throw Error('平台账号地址与编号不一致');
  return account;
 }
 bindMarketAccount(profileId,observed){
  if(this.faulted||this.closing||!this.profiles().some(p=>p.id===profileId)||observed?.verified!==true)throw Error('平台账号核对无法保存');
  const account=this.validateMarketAccount({profileId,platform:'vinted-fr',memberId:observed.memberId,username:observed.username,profileURL:observed.profileURL,verifiedAt:now()}),old=this.db.marketAccounts.find(a=>a.profileId===profileId);
  if(old&&old.memberId!==account.memberId){this.accountObservations.delete(profileId);this.emit();throw problem('ACCOUNT_CHANGED','该环境登录了不同的 Vinted 账号；原账号绑定已保留，请核对登录状态');}
  if(old)Object.assign(old,account);else this.db.marketAccounts.push(account);
  if(observed.documentKey)this.accountObservations.set(profileId,{profileId,memberId:account.memberId,verified:true,documentKey:observed.documentKey,checkedAt:account.verifiedAt});
  this.persist();this.emit();return {...account};
 }
 listingURL(plan){
  const id=String(plan.activeListingId||'');if(!/^[1-9]\d*$/.test(id))return null;
  const matches=this.db.claims.filter(claim=>claim.profileId===plan.profileId&&claim.productId===plan.productId).flatMap(claim=>Array.isArray(claim.listings)?claim.listings:[]).filter(row=>String(row.listingId)===id);
  if(matches.length!==1||typeof matches[0].url!=='string')return null;
  try{const u=new URL(matches[0].url);return u.origin==='https://www.vinted.fr'&&!u.username&&!u.password&&!u.search&&!u.hash&&new RegExp('^/items/'+id+'(?:-[^/]+)?$').test(u.pathname)?u.href:null;}catch{return null;}
 }
 emit(){this.onChange(this.state());}
 event(kind,message){this.db.events.push({time:now(),kind,text:String(message).slice(0,500)});if(this.db.events.length>300)this.db.events.shift();}
 client(){if(!this.db.encryptedToken)throw problem('NOT_CONNECTED','请先填写货盘 API 密钥并测试连接');return this.clientFactory({baseURL:this.db.settings.baseURL,token:this.unseal(this.db.encryptedToken)});}
 hasHistory(){return ['plans','jobs','claims','sales','reservations','photoPreparations'].some(key=>this.db[key].length>0);}
 configure(work){
  if(this.closing)return Promise.reject(stopped());if(this.active.size||this.running||this.ticking)return Promise.reject(Error('请先停止后台并等待当前步骤结束，再读取或修改货盘配置'));
  this.configPending++;
  const task=this.configTail.then(async()=>{if(this.closing)throw stopped();const controller=new AbortController();this.configController=controller;const guard=()=>{if(this.closing||controller.signal.aborted)throw stopped();};try{guard();return await work(controller.signal,guard);}finally{if(this.configController===controller)this.configController=null;}});
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
  let encrypted=this.db.encryptedToken;const endpointChanged=baseURL!==this.db.settings.baseURL,history=this.hasHistory(),tokenChanged=!!input.clearToken||!!input.token&&(!encrypted||text(input.token,'API 密钥',4096)!==this.unseal(encrypted));
  if(endpointChanged){if(history)throw Error('已有运营计划或历史，不能把原照片和订单切换到另一货盘');encrypted='';}
  let accountId=this.db.supplierAccountId;
  if(input.clearToken)encrypted='';else if(input.token){const token=text(input.token,'API 密钥',4096);if(history){const client=this.clientFactory({baseURL,token}),me=await boundedRead(requestSignal=>client.me({signal:requestSignal}),signal);guard();const id=this.accountIdentity(me);if(!accountId||!id||id!==accountId)throw Error('更换密钥前必须核对为同一个货盘账号，原密钥已保留');}encrypted=this.seal(token);}
  guard();if(!history&&(endpointChanged||tokenChanged)){this.db.supplierAccountId=null;this.db.products=[];this.db.photoSets=[];}
  this.db.settings=next;this.db.encryptedToken=encrypted;this.connection={status:'not_connected'};this.persist();this.emit();return this.state();});
 }
 accountIdentity(data){const value=data.user?.id??data.account?.id??data.userId??data.accountId;return typeof value==='string'||Number.isSafeInteger(value)?String(value):null;}
 async connect(){
  return this.configure(async(signal,guard)=>{try{const client=this.client(),data=await boundedRead(requestSignal=>client.me({signal:requestSignal}),signal);guard();const id=this.accountIdentity(data);if(this.db.supplierAccountId&&id!==this.db.supplierAccountId){if(this.hasHistory())throw Error('货盘账号与现有运营历史不匹配');this.db.products=[];this.db.photoSets=[];this.db.supplierAccountId=null;}if(id)this.db.supplierAccountId=id;this.connection={status:'connected',account:String(data.user?.username||data.account?.username||data.username||data.user?.id||data.account?.id||'已验证 API 密钥；账号字段待核对'),scopes:Array.isArray(data.scopes)?data.scopes:Array.isArray(data.permissions)?data.permissions:[],checkedAt:now()};this.event('info','货盘连接已验证');}
  catch(e){guard();this.connection={status:'error',error:e.message,checkedAt:now()};this.persist();throw e;}guard();this.persist();this.emit();return this.state();});
 }
 async sync(){
  return this.configure(async(signal,guard)=>{const client=this.client();const all=async(method,key)=>{let rows=[];for(let page=1;page<=100;page++){guard();const response=await boundedRead(requestSignal=>client[method]({page,pageSize:100},{signal:requestSignal}),signal);guard();if(!Array.isArray(response[key]))throw Error('货盘返回格式不兼容：'+key);rows.push(...response[key]);if(response[key].length<100||Number.isFinite(response.total)&&rows.length>=response.total)return rows;}throw Error('数据超过本次同步上限，已保留旧数据');};
  // Keep below the provider's four-request server limit; avoid partial catalog commits.
  const products=await all('products','products'),sets=await all('photoSets','sets');
  guard();this.db.products=products.map(normalizeProduct).filter(p=>p.id&&p.sku);this.db.photoSets=sets.map(normalizeSet);this.event('info','已同步 '+this.db.products.length+' 个商品、'+this.db.photoSets.length+' 套照片');this.persist();this.emit();return this.state();});
 }
 savePlan(input){
  if(this.closing||this.configPending)throw Error('货盘配置正在更新，请稍后保存计划');
  const previous=input.id?this.db.plans.find(p=>p.id===input.id):null;if(input.id&&!previous)throw Error('计划不存在');
  if(previous&&this.db.publications.submissions.some(r=>r.proof.facts.planId===previous.id&&r.state!=='cancelled'&&!r.closedSale))throw Error('该计划已有未完成的刊登提交记录，请先核对原刊登');
  if(previous&&(this.active.size||this.ticking||this.db.jobs.some(j=>j.planId===previous.id&&!terminal.has(j.state)&&!this.canRetry(j))))throw Error('该计划仍有执行中或已提交的任务，请先停止并核对任务再修改');
  const plan=validatePlan(input,{profiles:this.profiles(),products:this.db.products,previous});
  if(previous&&previous.sku!==plan.sku&&this.db.photoPreparations.some(p=>p.planId===previous.id))throw Error('已有照片领取的计划不能更换 SKU，原记录已保留');
  if(previous&&(previous.profileId!==plan.profileId||previous.productId!==plan.productId)&&(previous.activeListingId||previous.completedCount||this.db.jobs.some(j=>j.planId===previous.id)||this.db.photoPreparations.some(p=>p.planId===previous.id)))throw Error('已有业务记录的计划不能更换窗口或 SKU，请新建计划');
  if(this.db.plans.some(p=>p.id!==plan.id&&p.profileId===plan.profileId&&p.productId===plan.productId))throw Error('该窗口已存在此商品的计划，请编辑原计划');
  if(previous)Object.assign(previous,plan);else this.db.plans.push(plan);this.event('info','已保存 '+plan.name+' 的销售计划');this.persist();this.emit();return plan;
 }
 setPlanEnabled(id,enabled){const plan=this.plan(id);plan.enabled=enabled===true;if(!plan.enabled){const lease=this.leases.snapshot().find(item=>item.profileId===plan.profileId),job=lease&&this.db.jobs.find(item=>item.id===lease.jobId);if(job?.planId===id)this.active.get(plan.profileId)?.abort();}plan.status=plan.enabled?'ready':'paused';plan.updatedAt=now();this.persist();this.emit();return plan;}
 plan(id){const p=this.db.plans.find(p=>p.id===id);if(!p)throw Error('销售计划不存在');return p;}
 canRetry(job){
  if(job?.type==='listing'&&this.db.publications.submissions.some(r=>r.proof.facts.planId===job.planId&&r.state!=='cancelled'&&!r.closedSale))return false;
  if(!job||!['needs_review','cancelled'].includes(job.state)||!['listing','message','offer','fulfillment'].includes(job.type))return false;
  if(job.operation!=null||job.mutationPending!==false||job.result!=null)return false;
  const plan=this.db.plans.find(p=>p.id===job.planId);
  if(!plan||plan.profileId!==job.profileId||plan.productId!==job.productId)return false;
  return job.type!=='listing'||(!plan.activeListingId&&plan.completedCount<plan.targetCount&&job.payload?.cycle===plan.completedCount);
 }
 enqueue(type,plan,payload={},dedupeKey){
  const found=this.db.jobs.find(j=>j.dedupeKey===dedupeKey);if(found)return found;
  const job=queuedJob(type,plan,payload,dedupeKey);this.db.jobs.push(job);this.persist();return job;
 }
 seed(){for(const p of this.db.plans){if(!p.enabled||p.completedCount>=p.targetCount||p.activeListingId||this.db.publications.submissions.some(r=>r.proof.facts.planId===p.id&&r.state!=='cancelled'&&!r.closedSale))continue;const outstanding=this.db.jobs.some(j=>j.planId===p.id&&!terminal.has(j.state));if(!outstanding)this.enqueue('listing',p,{cycle:p.completedCount},'listing:'+p.id+':'+p.completedCount);}}
 setRunning(enabled){if(this.closing)throw stopped();if(enabled&&this.faulted)throw Error('请先修复运营存储');if(enabled&&this.configPending)throw Error('货盘配置正在更新，请等待完成后启动后台');if(enabled&&this.db.settings.backgroundEnabled!==true)throw Error('请先在连接与规则中启用后台运行，再启动持续调度');this.running=enabled===true;if(this.running&&!this.timer)this.timer=setInterval(()=>{if(this.running)this.runOnce().catch(e=>{if(this.closing)return;this.event('error',e.message);this.running=false;if(!this.faulted)this.persist();this.emit();});},15000);if(!this.running){this.runGeneration++;this.tickController?.abort();for(const controller of this.active.values())controller.abort();}this.event('info',this.running?'后台队列已启动；未验证的页面步骤会停在待核对。':'后台已停止；已提交但未确认的请求需要核对原记录。');this.persist();this.emit();if(this.running)void this.runOnce().catch(e=>{if(this.closing)return;this.running=false;this.event('error',e.message);this.emit();});return this.state();}
 tickCurrent(generation,signal){return !this.closing&&!this.faulted&&!this.configPending&&generation===this.runGeneration&&!signal?.aborted;}
 async runOnce(){
  if(this.closing)throw stopped();if(this.configPending)throw Error('货盘配置正在更新，请等待完成后运行');if(this.ticking)return this.tickPromise?await this.tickPromise:this.state();if(this.faulted)throw Error('运营存储不可用');this.ticking=true;
  const generation=this.runGeneration,controller=new AbortController();this.tickController=controller;
  const cycle=(async()=>{await this.poll({signal:controller.signal,generation});if(!this.tickCurrent(generation,controller.signal))return this.state();this.seed();const selected=[],busy=new Set(this.active.keys());let changed=false;for(const j of this.db.jobs){if(!this.tickCurrent(generation,controller.signal))break;if(selected.length+this.active.size>=this.db.settings.maxConcurrent)break;if(j.state!=='queued')continue;if(this.db.jobs.filter(other=>other.id===j.id).length!==1||!j.dedupeKey||this.db.jobs.filter(other=>other.dedupeKey===j.dedupeKey).length!==1){j.state='needs_review';j.error='任务或业务去重编号重复，已停止调度';changed=true;continue;}if(j.type==='listing'&&this.db.publications.submissions.some(r=>r.proof.facts.planId===j.planId&&r.state!=='cancelled'&&!r.closedSale)){j.state='needs_review';j.error='原刊登提交记录尚未关闭，不能重复执行刊登';changed=true;continue;}const p=this.db.plans.find(plan=>plan.id===j.planId);if(!p||p.profileId!==j.profileId||p.productId!==j.productId){j.state='needs_review';j.error='任务与原销售计划不匹配，请核对原记录';changed=true;continue;}if(!p.enabled||busy.has(j.profileId))continue;if(j.retryAt!=null){const due=Date.parse(j.retryAt);if(!Number.isFinite(due)){j.state='needs_review';j.error='任务重试时间无效，已停止调度';changed=true;continue;}if(due>Date.now())continue;}if(this.db.jobs.some(other=>other.profileId===j.profileId&&(other.state==='uncertain'||other.mutationPending===true)))continue;busy.add(j.profileId);selected.push(j);}if(changed)this.persist();await Promise.all(selected.map(j=>this.tickCurrent(generation,controller.signal)?this.runJob(j):undefined));return this.state();})();this.tickPromise=cycle;
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
  if(this.closing||this.faulted||this.configPending)throw problem('STOPPED','运营调度当前不可执行');
  if(!this.db.jobs.includes(job)||job.state!=='queued'||job.operation!=null||job.mutationPending!==false||job.result!=null)throw problem('JOB_NOT_RUNNABLE','任务状态不允许重新执行，请先核对原记录');
  if(this.db.jobs.filter(j=>j.id===job.id).length!==1||typeof job.dedupeKey!=='string'||!job.dedupeKey||this.db.jobs.filter(j=>j.dedupeKey===job.dedupeKey).length!==1)throw problem('DUPLICATE_JOB','任务编号或业务去重编号重复，已停止执行');
  const boundPlan=this.db.plans.find(p=>p.id===job.planId);if(!boundPlan||boundPlan.profileId!==job.profileId||boundPlan.productId!==job.productId||!this.profiles().some(p=>p.id===job.profileId))throw problem('PLAN_MISMATCH','任务与原计划、商品或环境不一致');
  if(job.type==='listing'&&this.db.publications.submissions.some(r=>r.proof.facts.planId===job.planId&&r.state!=='cancelled'&&!r.closedSale))throw problem('PUBLICATION_EXISTS','原刊登提交记录尚未关闭，不能再次执行刊登');
  if(this.active.has(job.profileId))return false;
  const lease=this.leases.acquire(job.profileId,job.id);if(!lease)return false;
  const controller=new AbortController();this.active.set(job.profileId,controller);
  try{
   job.state='running';job.updatedAt=now();this.persist();this.emit();
   const plan=this.plan(job.planId),signal=controller.signal;
   await this.adapter.requireReady(plan.profileId);
   if(signal.aborted)throw problem('STOPPED','任务已停止');
   if(job.type==='listing')await this.listing(job,plan,signal);
   else if(job.type==='message')await this.message(job,plan,signal);
   else if(job.type==='offer')await this.offer(job,plan,signal);
   else if(job.type==='fulfillment')await this.fulfill(job,plan,signal);
   else throw Error('未知运营任务');
   job.state='completed';job.error='';this.event('success',plan.name+'：'+job.type+' 步骤已核对完成');
  }catch(e){if(job.mutationPending&&e.ambiguous===false&&e.status>=400&&e.status<500){job.mutationPending=false;job.operation.rejected=true;}const recovery=retryDecision(job,e);job.state=recovery.state;job.attempts=recovery.attempts;job.retryAt=recovery.retryAt;job.error=String(e.message).slice(0,700);this.event('warning',(this.db.plans.find(p=>p.id===job.planId)?.name||'原计划')+'：'+job.error);}
  finally{try{job.updatedAt=now();if(!this.faulted)this.persist();}finally{if(this.active.get(job.profileId)===controller)this.active.delete(job.profileId);this.leases.release(lease);this.emit();}}
 }
 async product(plan,client,signal){const data=await boundedRead(requestSignal=>client.product(plan.productId,{signal:requestSignal}),signal),raw=data.product||data,p=normalizeProduct(raw);if(p.id!==plan.productId||p.sku!==plan.sku)throw problem('PRODUCT_MISMATCH','货盘商品编号或 SKU 不一致');if(p.stock===null||p.stock<1)throw problem('NO_STOCK','库存未知或不足，已停止');return p;}
 async listing(job,plan,signal){
  if(plan.activeListingId)throw problem('ACTIVE_LISTING','该商品已有在售记录，禁止重复刊登');
  const client=this.client(),product=await this.product(plan,client,signal);
  const check=await this.adapter.findListing(plan,{signal});if(check?.exists)throw problem('EXISTING_LISTING','网页已有匹配刊登，请先关联原刊登，不能重复发布');
  let claim=this.db.claims.find(c=>c.profileId===plan.profileId&&c.productId===plan.productId&&(plan.reuseOwnPhotos||!c.listings.length));
  if(!claim){job.step='claim_photos';const result=await this.external(job,'claim',{productId:plan.productId},key=>client.claimPhotos({productId:plan.productId},{idempotencyKey:key,signal}));if(!result.claimId||!result.set?.images?.length)throw problem('CLAIM_UNVERIFIED','照片领取返回内容不完整，请核对原领取',true);claim={id:result.claimId,profileId:plan.profileId,productId:plan.productId,setId:result.set.id,images:result.set.images,listings:[]};this.db.claims.push(claim);job.payload.claimId=claim.id;this.persist();}
  job.step='prepare_listing';const draft=await this.adapter.prepareListing(plan,{product,claim,client,signal});
  if(draft?.productId!==plan.productId||draft.claimId!==claim.id||draft.priceCents!==plan.listingPriceCents||draft.currency!=='EUR'||draft.imageCount!==claim.images.length||draft.imagesVerified!==true)throw problem('DRAFT_MISMATCH','刊登草稿的商品、价格、币种或照片内容没有完全匹配');
  job.step='publish_listing';const result=await this.external(job,'publish',{planId:plan.id,cycle:job.payload.cycle,draft},()=>this.adapter.publishListing(plan,draft,{signal}));
  if(!result?.listingId||!result.url||result.verified!==true||result.priceCents!==plan.listingPriceCents)throw problem('LISTING_UNVERIFIED','刊登结果不明确，请核对实际商品页',true);
  plan.activeListingId=result.listingId;plan.status='listed';claim.listings.push({listingId:result.listingId,url:result.url,createdAt:now()});job.result={externalId:result.listingId};job.step='record_listing';this.persist();
  if(claim.listings.length===1)await this.external(job,'mark_listed',{claimId:claim.id,listingId:result.listingId},key=>client.markListed(claim.id,{action:'published',platform:'Vinted',listingId:result.listingId,listingUrl:result.url},{idempotencyKey:key,signal}));
 }
 // Only a validated platform adapter may enqueue authoritative events. Renderer IPC never accepts raw sale/offer events.
 ingestEvent(planId,event){
  const plan=this.plan(planId);if(event?.verified!==true||event.profileId!==plan.profileId||typeof event.id!=='string'||!event.id)throw problem('EVENT_UNVERIFIED','平台事件与窗口/在售商品无法核对');
  if(!['message','offer','sale'].includes(event.type))throw Error('平台事件类型无效');
  if(event.type==='sale'){
   const old=this.db.sales.find(s=>s.platformOrderId===event.id);if(old){const job=this.db.jobs.find(j=>j.id===old.jobId);if(old.planId!==planId||!job||event.paid!==true||['listingId','buyerUsername','profileId','priceCents','currency','quantity'].some(k=>event[k]!==job.payload[k]))throw problem('SALE_CONFLICT','相同订单编号出现了不同的商品、账号或金额，已停止核对');return job;}
  }
  if(event.listingId!==plan.activeListingId)throw problem('EVENT_UNVERIFIED','平台事件与当前在售商品无法核对');
  if(event.type==='sale'){
   if(event.paid!==true||event.currency!=='EUR'||!Number.isSafeInteger(event.priceCents)||event.priceCents<plan.minOfferCents||event.quantity!==1)throw problem('SALE_UNVERIFIED','成交付款状态、金额或数量需要人工核对');
   const dedupeKey='vinted-order:'+event.id;
   if(this.db.jobs.some(j=>j.dedupeKey===dedupeKey))throw problem('SALE_CONFLICT','原成交任务缺少对应销售记录，请先核对，不能重新创建');
   const job=queuedJob('fulfillment',plan,{...event},dedupeKey);
   // Commit the task, sale count and consumed listing in one durable snapshot.
   this.db.jobs.push(job);this.db.sales.push({platformOrderId:event.id,planId,jobId:job.id,priceCents:event.priceCents,createdAt:now()});plan.completedCount++;plan.activeListingId=null;plan.status='fulfilling';this.persist();this.emit();return job;
  }
  if(event.type==='message'&&!plan.autoReply||event.type==='offer'&&!plan.autoAcceptOffers)return null;
  return this.enqueue(event.type,plan,event,'vinted-'+event.type+':'+event.id);
 }
 async message(job,plan,signal){
  job.step='draft_reply';const latest=await this.adapter.readMessage(job.payload,{signal});if(latest.id!==job.payload.id||latest.listingId!==plan.activeListingId||latest.buyerUsername!==job.payload.buyerUsername)throw problem('MESSAGE_CHANGED','对话、买家或商品已改变');
  const draft=await this.adapter.draftReply(plan,latest,{signal});if(draft?.factual!==true||typeof draft.text!=='string'||!draft.text.trim()||draft.text.length>1500||draft.requiresReview)throw problem('REPLY_REVIEW','问题无法仅凭已确认商品资料回答，请人工处理');
  job.step='send_reply';const result=await this.external(job,'reply',{messageId:latest.id,text:draft.text},()=>this.adapter.sendReply(latest,draft,{signal}));if(result?.verified!==true||!result.messageId)throw problem('REPLY_UNVERIFIED','消息发送结果不明确，请核对当前对话',true);job.result={externalId:result.messageId};
 }
 async offer(job,plan,signal){
  job.step='check_offer';const latest=await this.adapter.readOffer(job.payload,{signal});if(latest.id!==job.payload.id||latest.listingId!==plan.activeListingId||latest.currency!=='EUR'||!Number.isSafeInteger(latest.priceCents)||latest.quantity!==1||latest.status!=='pending')throw problem('OFFER_CHANGED','报价所属商品、币种、数量或状态需要核对');
  if(latest.priceCents<plan.minOfferCents){job.result={summary:'报价低于最低接受价，未接受'};return;}
  if(latest.priceCents>plan.listingPriceCents)throw problem('OFFER_PRICE','报价高于刊登价，请核对是否误读了总额或运费');
  await this.product(plan,this.client(),signal);job.step='accept_offer';const result=await this.external(job,'accept_offer',{id:latest.id,priceCents:latest.priceCents},()=>this.adapter.acceptOffer(latest,{signal}));if(result?.verified!==true||result.priceCents!==latest.priceCents)throw problem('OFFER_UNVERIFIED','接受报价结果不明确，请核对原报价',true);job.result={externalId:latest.id,summary:'已接受报价；等待买家付款，不据此采购'};
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
  const client=this.client(),sale=await this.adapter.readSale(job.payload,{signal});
  if(sale?.id!==job.payload.id||sale.listingId!==job.payload.listingId||sale.buyerUsername!==job.payload.buyerUsername||sale.paid!==true||sale.cancelled||sale.currency!=='EUR'||sale.priceCents!==job.payload.priceCents||sale.quantity!==1)throw problem('SALE_CHANGED','订单、买家、付款或取消状态发生变化，停止采购');
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
  plan.status=plan.completedCount>=plan.targetCount?'target_reached':'ready';job.step='verified';
 }
 async resolve(id,action,data={}){
  if(this.closing||this.faulted)throw Error('运营队列已关闭或存储不可用，不能修改任务');
  if(this.active.size||this.running||this.ticking||this.configPending)throw Error('请先停止后台并等待当前请求结束');const job=this.db.jobs.find(j=>j.id===id);if(!job)throw Error('任务不存在');
  if(action==='cancel'){if(job.mutationPending||job.state==='uncertain'||job.result?.externalId)throw Error('结果不明或已有外部记录的任务不能直接取消，请先核对原记录');job.state='cancelled';job.error='用户取消了尚未提交的任务';}
  else if(action==='retry'){
   if(!this.canRetry(job))throw Error('只有待核对或已取消、无提交记录或结果且与当前计划和刊登周期匹配的任务才能重新排队');
   job.state='queued';job.step='pending';job.error='';job.attempts=0;job.retryAt=null;job.updatedAt=now();
   this.event('info','未提交任务已重新排队；销售计划的启用状态保持不变');
  }
  else if(action==='reconcile'){
   if(!['uncertain','needs_review'].includes(job.state))throw Error('此任务不需要核对');
   if(job.type==='fulfillment'&&job.result?.externalId){const response=await this.client().order(job.result.externalId),order=response.order;if(!order||String(order.id)!==String(job.result.externalId))throw Error('货盘返回订单不匹配');if(job.result.wmsOrderId){const r=await this.client().wmsOrder(job.result.wmsOrderId);const status=r.order?.status||r.wmsStatus||r.status;if(status!=='submitted')throw Error('WMS 原订单仍未确认接单，已保持待核对');}else if(this.db.settings.fulfillmentMethod==='wms')throw Error('缺少原 WMS 编号，不能自动认定发货成功');job.state='completed';job.error='原货盘订单已核对';job.mutationPending=false;}
   else throw Error('当前任务需要真实页面或原请求记录核对，不能仅凭手工填写编号恢复。记录已保留。');
  }else throw Error('不支持的核对操作');this.persist();this.emit();return this.state();
 }
 async poll({signal,generation=this.runGeneration}={}){if(!this.running||!this.tickCurrent(generation,signal))return;const ids=[...new Set(this.db.plans.filter(p=>p.enabled).map(p=>p.profileId))];for(const id of ids){if(!this.running||!this.tickCurrent(generation,signal))return;if(this.active.has(id))continue;try{const events=await boundedRead(requestSignal=>this.adapter.poll(id,{signal:requestSignal}),signal);if(!this.running||!this.tickCurrent(generation,signal))return;for(const event of events){const plan=this.db.plans.find(p=>p.enabled&&p.profileId===id&&p.activeListingId===event.listingId);if(plan)this.ingestEvent(plan.id,event);}}catch(e){if(!this.running||!this.tickCurrent(generation,signal))return;this.event('warning',e.message);}}}
 async close(){if(this.closePromise)return this.closePromise;this.closing=true;this.running=false;this.runGeneration++;if(this.timer)clearInterval(this.timer);this.timer=null;this.tickController?.abort();this.configController?.abort();for(const c of this.active.values())c.abort();this.closePromise=(async()=>{await Promise.allSettled([this.tickPromise,this.configTail].filter(Boolean));while(this.active.size)await new Promise(r=>setTimeout(r,25));if(!this.faulted)this.persist();})();return this.closePromise;}
}
module.exports={CommerceEngine,DEFAULTS,validatePlan,normalizeProduct,normalizeSet,problem};
