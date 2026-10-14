// Pure scheduling policy: never reads a browser, retries a request, or mutates
// persisted state. The engine must persist a returned decision before acting.
const TERMINAL=new Set(['completed','cancelled','rejected']);
const STATES=new Set([...TERMINAL,'queued','running','uncertain','needs_review']);
const CAPABILITIES={listing:['publish'],message:['messages'],offer:['offers'],sale_confirmation:['saleConfirmation'],fulfillment:['shippingLabel','procurement']};
const PRIORITY={fulfillment:0,sale_confirmation:0,offer:1,message:2,listing:3};
const WAITING_CODES=new Set(['VINTED_UNVERIFIED','CAPABILITY_UNVERIFIED','PROFILE_NOT_OPEN','ACCOUNT_RECHECK_REQUIRED','PAGE_BUSY','WORKSPACE_BUSY']);
const clean=value=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,500);
const hasEvidence=job=>job.operation!=null||job.mutationPending!==false||job.result!=null;
const timestamp=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'?Date.parse(value):NaN;
function time(value){const n=timestamp(value);if(!Number.isFinite(n)||n<0||n>8640000000000000)throw new TypeError('A valid clock value is required');return n;}
function decision(state,reasonCode,reason,nextAction,extra={}){return {state,reasonCode,reason,nextAction,...extra};}
const reconcile=()=>decision('uncertain','RECONCILE_REQUIRED','已有业务请求或结果记录，需要先核对原操作。','检查原刊登、消息、报价或货盘订单；结果确认前不要重发。');

function startupDecision(job){
  if(!job||typeof job!=='object'||!STATES.has(job.state))return decision('needs_review','INVALID_JOB_STATE','任务状态无效，已停止自动恢复。','检查原任务记录，保留业务编号。');
  if(job.mutationPending===true||(['queued','running'].includes(job.state)&&hasEvidence(job)))return reconcile();
  if(job.state==='running')return decision('queued','INTERRUPTED_BEFORE_MUTATION','上次运行在提交业务操作前中断，可重新检查前置条件。','等待账号和页面检查通过后重新调度。');
  if(job.state==='uncertain')return reconcile();
  return decision(job.state,'UNCHANGED','保留原任务状态。',TERMINAL.has(job.state)?'无需自动重试。':'按当前计划与前置条件继续核对。');
}

function retryDecision(job,error,{now=Date.now(),maxAttempts=5,baseDelayMs=15000,maxDelayMs=900000}={}){
  const current=time(now),attempts=job?.attempts===undefined?0:job.attempts;
  if(!job||hasEvidence(job)||error?.ambiguous===true)return {...reconcile(),attempts:Number.isSafeInteger(attempts)&&attempts>=0?attempts:0,retryAt:null};
  if(!Number.isSafeInteger(attempts)||attempts<0)return decision('needs_review','INVALID_RETRY_RECORD','重试次数记录无效。','检查任务记录后人工恢复。',{attempts:0,retryAt:null});
  if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>20||!Number.isSafeInteger(baseDelayMs)||baseDelayMs<1||!Number.isSafeInteger(maxDelayMs)||maxDelayMs<baseDelayMs)throw new TypeError('Invalid retry policy');
  if(error?.code==='STOPPED')return decision('queued','STOPPED','任务已停止，尚未产生业务提交记录。','手动恢复后台后会重新检查前置条件。',{attempts,retryAt:null});
  if(WAITING_CODES.has(error?.code))return decision('queued',error.code,clean(error.message)||'当前步骤的前置条件尚未满足。','保留原任务，等待对应环境或已验证能力就绪。',{attempts,retryAt:new Date(current+baseDelayMs).toISOString()});
  if(!['RETRY_LATER','READ_TIMEOUT'].includes(error?.code))return decision('needs_review',clean(error?.code)||'MANUAL_REVIEW',clean(error?.message)||'此错误不能自动重试。','检查当前页面或服务状态，再决定是否重新排队。',{attempts,retryAt:null});
  const nextAttempt=attempts+1;
  if(nextAttempt>=maxAttempts)return decision('needs_review','RETRY_EXHAUSTED','读取重试已达到上限，已暂停任务。','检查网络、代理和账号页面，再手动重新排队。',{attempts:nextAttempt,retryAt:null});
  const delayMs=Math.min(maxDelayMs,baseDelayMs*2**Math.min(20,attempts));
  return decision('queued','RETRY_SCHEDULED','读取暂时失败，已安排延后检查。','等待下次检查；不会重发任何结果不明的业务请求。',{attempts:nextAttempt,retryAt:new Date(current+delayMs).toISOString(),delayMs});
}

function accountProblem(profileId,job,input,now){
  if(input.accounts!==undefined&&!Array.isArray(input.accounts)||input.observedAccounts!==undefined&&!Array.isArray(input.observedAccounts))return decision('blocked','ACCOUNT_RECORD_CONFLICT','账号身份记录格式无效。','检查账号记录后重新核验。');
  const records=(input.accounts||[]).filter(a=>a?.profileId===profileId),observations=(input.observedAccounts||[]).filter(a=>a?.profileId===profileId);
  if(records.length>1||observations.length>1)return decision('blocked','ACCOUNT_RECORD_CONFLICT','同一环境存在多个账号身份记录。','核对账号绑定，不能选择其中一个猜测执行。');
  const bound=records[0],observed=observations[0];
  if(bound?.memberId&&(input.accounts||[]).some(account=>account.profileId!==profileId&&account.memberId===bound.memberId&&account.platform===bound.platform))return decision('blocked','ACCOUNT_RECORD_CONFLICT','同一个平台账号绑定了多个环境。','请保留原环境并人工核对账号绑定。');
  const validMember=value=>typeof value==='string'&&/^[1-9]\d{0,24}$/.test(value);
  if(bound&&!validMember(bound.memberId)||observed?.verified===true&&!validMember(observed.memberId))return decision('blocked','ACCOUNT_RECORD_CONFLICT','账号身份编号格式无效。','重新读取账号菜单，不能猜测账号编号。');
  if(bound?.memberId&&observed?.verified===true&&observed.memberId!==bound.memberId||job.accountMemberId&&((bound?.memberId&&job.accountMemberId!==bound.memberId)||(observed?.verified===true&&job.accountMemberId!==observed.memberId)))return decision('blocked','ACCOUNT_CHANGED','当前登录账号与环境或任务绑定不一致。','恢复原账号登录并重新核验，保留已有业务记录。');
  if(input.requireVerifiedAccount!==true)return null;
  if(!bound?.memberId)return decision('blocked','ACCOUNT_NOT_BOUND','该环境尚未绑定已核对的 Vinted 账号。','打开环境并核验顶部账号菜单。');
  const checkedAt=timestamp(observed?.checkedAt),age=now-checkedAt,maxAge=Number.isSafeInteger(input.accountMaxAgeMs)&&input.accountMaxAgeMs>0?input.accountMaxAgeMs:300000;
  if(observed?.verified!==true||observed.memberId!==bound.memberId||typeof observed.documentKey!=='string'||!observed.documentKey||!Number.isFinite(age)||age<0||age>maxAge)return decision('blocked','ACCOUNT_RECHECK_REQUIRED','当前页面缺少近期一致的账号核验。','重新读取账号菜单；实际业务操作前仍需再次核对账号与页面。');
  return null;
}

function inspectQueue(input,{now=Date.now()}={}){
  const current=time(now),jobs=Array.isArray(input.jobs)?input.jobs:[],plans=Array.isArray(input.plans)?input.plans:[],profiles=Array.isArray(input.profiles)?input.profiles:[];
  const active=new Set(input.activeProfileIds||[]),maxConcurrent=Number.isSafeInteger(input.maxConcurrent)&&input.maxConcurrent>=1&&input.maxConcurrent<=3?input.maxConcurrent:1;
  const capacity=Math.max(0,maxConcurrent-active.size),runnableJobIds=[],rows=[];
  const counts=(values,key)=>{const map=new Map();for(const value of values){const k=value?.[key];if(k)map.set(k,(map.get(k)||0)+1);}return map;};
  const jobIds=counts(jobs,'id'),dedupes=counts(jobs,'dedupeKey'),planIds=counts(plans,'id'),profileIds=counts(profiles,'id');
  const quarantined=new Set(jobs.filter(j=>j?.state==='uncertain'||j?.mutationPending===true||(['queued','running'].includes(j?.state)&&hasEvidence(j))).map(j=>j.profileId));
  const manuallyPaused=new Set(jobs.filter(j=>j?.state==='needs_review'&&['PROFILE_CLOSED','PROFILE_STOPPED'].includes(j.blockedReason)).map(j=>j.profileId));
  for(const job of jobs){
    let status;
    const plan=plans.find(p=>p?.id===job?.planId),profile=profiles.find(p=>p?.id===job?.profileId),readiness=input.readinessByProfile?.[job?.profileId]||input.readiness;
    // This runtime freshly verifies the original account before preparing or
    // publishing, whether it opens the fixed profile or uses an existing window.
    const liveAccountCheck=job?.type==='listing'&&['closed','running'].includes(profile?.status)&&readiness?.capabilities?.publish===true&&readiness?.capabilities?.autoOpenProfile===true;
    const autoOpen=liveAccountCheck&&profile.status==='closed';
    if(!job?.id||jobIds.get(job.id)!==1||!job.dedupeKey||dedupes.get(job.dedupeKey)!==1)status=decision('blocked','DUPLICATE_JOB','任务编号或业务去重编号缺失或重复。','核对原任务，不能自动选择或重新创建。');
    else if(!STATES.has(job.state)||!CAPABILITIES[job.type])status=decision('blocked','INVALID_JOB_STATE','任务类型或状态无法识别。','保留原记录并检查数据。');
    else if(job.state==='uncertain'||job.mutationPending===true||(['queued','running'].includes(job.state)&&hasEvidence(job)))status={...reconcile(),state:'blocked'};
    else if(TERMINAL.has(job.state))status=decision('finished','TERMINAL','任务已结束。','无需调度。');
    else if(!plan||planIds.get(job.planId)!==1||plan.profileId!==job.profileId||plan.productId!==job.productId)status=decision('blocked','PLAN_MISMATCH','任务与销售计划不匹配或计划已缺失。','检查商品和环境关联，不能自动迁移该任务。');
    else if(!profile||profileIds.get(job.profileId)!==1)status=decision('blocked','PROFILE_MISSING','任务对应的浏览器环境不存在或不唯一。','恢复原环境后核对账号与业务记录。');
    else if(input.faulted)status=decision('blocked','STORAGE_UNAVAILABLE','运营数据无法可靠保存。','修复存储后重新启动并核对原操作。');
    else if(input.closing)status=decision('paused','APP_CLOSING','应用正在关闭。','重新打开应用后核对队列。');
    else if(job.state==='needs_review')status=decision('blocked','MANUAL_REVIEW',clean(job.error)||'此任务等待人工核对。','检查原记录，再决定重试或取消。');
    else if(job.state==='running')status=active.has(job.profileId)?decision('running','OPERATION_ACTIVE','该环境正在执行任务。','等待当前步骤结束。'):decision('blocked','ORPHAN_RUNNING','运行中的任务缺少当前操作租约。','先执行重启恢复检查，不能直接重复执行。');
    else if(!plan.enabled)status=decision('paused','PLAN_PAUSED','该销售计划已暂停。','启用计划后重新检查前置条件。');
    else if(input.configBusy)status=decision('waiting','CONFIG_BUSY','连接或配置正在更新。','等待配置保存完成。');
    else if(active.has(job.profileId))status=decision('waiting','PROFILE_BUSY','该环境已有操作正在执行。','等待原操作释放环境。');
    else if(quarantined.has(job.profileId))status=decision('blocked','PROFILE_RECONCILE_REQUIRED','该环境存在结果不明的业务操作。','先核对原操作，再恢复该账号的其他任务。');
    else if(manuallyPaused.has(job.profileId))status=decision('blocked','PROFILE_MANUALLY_PAUSED','此账号的后台操作已被手动停止。','先核对任务记录中被关闭或停止的原任务，再重试或取消该任务以恢复此账号。');
    else if(profile.status!=='running'&&!autoOpen)status=decision('waiting','PROFILE_NOT_OPEN',profile.status==='starting'?'该环境正在启动或清理。':'该环境尚未就绪。',profile.status==='starting'?'等待环境启动或清理完成。':'打开对应环境并确认账号登录。');
    else if(job.type==='listing'&&(plan.activeListingId||!Number.isSafeInteger(plan.completedCount)||!Number.isSafeInteger(plan.targetCount)||plan.completedCount>=plan.targetCount||job.payload?.cycle!==plan.completedCount))status=decision('blocked','LISTING_CYCLE_CHANGED','该刊登周期已变化、已有在售商品或销售目标已完成。','核对原在售记录和累计销量，不能重复刊登。');
    else if(job.type==='listing'&&Array.isArray(input.sales)&&input.sales.some(s=>s.planId===plan.id&&!jobs.some(other=>other.id===s.jobId&&['fulfillment','sale_confirmation'].includes(other.type)&&other.planId===plan.id&&other.state==='completed'&&other.mutationPending===false&&other.result?.verified===true&&other.result?.externalId&&(other.type!=='sale_confirmation'||other.result.externalId===s.platformOrderId&&other.result.kind==='sale_confirmation'))))status=decision('blocked','SALE_CYCLE_PENDING','原成交的处理结果尚未完整核对。','先核对原成交任务，完成后才能进入下一次刊登周期。');
    else if(job.retryAt!=null&&!Number.isFinite(timestamp(job.retryAt)))status=decision('blocked','INVALID_RETRY_RECORD','任务重试时间无效。','检查任务记录后人工恢复。');
    else if(job.retryAt!=null&&timestamp(job.retryAt)>current)status=WAITING_CODES.has(job.blockedReason)?decision('waiting',job.blockedReason,clean(job.error)||'原任务正在等待已验证能力或窗口就绪。','保持原任务，等待对应前置条件完成。',{retryAt:new Date(timestamp(job.retryAt)).toISOString()}):decision('waiting','RETRY_DELAY','任务正在等待下次读取检查。','等待约定时间；无需重复点击运行。',{retryAt:new Date(timestamp(job.retryAt)).toISOString()});
    else {
      const missing=CAPABILITIES[job.type].filter(cap=>readiness?.capabilities?.[cap]!==true);
      status=readiness?.salesOnly===true&&job.type==='fulfillment'?decision('blocked','PROCUREMENT_DISABLED','当前为纯售卖模式，采购履约任务不会执行。','保留原业务记录；该模式只处理售卖和成交确认。'):missing.length?decision('blocked','CAPABILITY_UNVERIFIED','此任务所需网页步骤尚未验证：'+missing.join('、')+'。','先完成对应步骤的真实页面联调。',{missingCapabilities:missing}):accountProblem(job.profileId,job,input,current);
      if(liveAccountCheck&&status?.reasonCode==='ACCOUNT_RECHECK_REQUIRED')status=null;
      if(!status)status=autoOpen?decision('eligible','PROFILE_AUTO_OPEN','调度时将自动打开此账号的固定环境。','无需手动打开；重新核对登录身份和商品资料，通过后上架。'):decision('eligible','READY','任务前置检查通过，等待本轮调度。',liveAccountCheck?'执行时会重新核对当前页面的登录身份，确认一致后继续核对商品和发布回执。':'运行时继续逐步核对账号、页面及业务回执。');
    }
    rows.push({jobId:job?.id||null,profileId:job?.profileId||null,planId:job?.planId||null,type:job?.type||null,...status});
  }
  const candidates=rows.filter(row=>row.state==='eligible').sort((a,b)=>{
    const ja=jobs.find(j=>j.id===a.jobId),jb=jobs.find(j=>j.id===b.jobId),ta=timestamp(ja.createdAt),tb=timestamp(jb.createdAt);
    return PRIORITY[a.type]-PRIORITY[b.type]||(Number.isFinite(ta)&&Number.isFinite(tb)?ta-tb:0)||a.jobId.localeCompare(b.jobId,'en');
  });
  const selectedProfiles=new Set();
  for(const row of candidates){
    if(selectedProfiles.has(row.profileId)){Object.assign(row,decision('waiting','PROFILE_QUEUED','该环境本轮已有另一个任务。','等待当前账号的前一个步骤结束。'));continue;}
    if(runnableJobIds.length>=capacity){Object.assign(row,decision('waiting','CONCURRENCY_LIMIT','本轮并发窗口已达到上限。','等待其他环境完成当前步骤。'));continue;}
    selectedProfiles.add(row.profileId);runnableJobIds.push(row.jobId);row.state='ready';
  }
  const profileHealth=profiles.map(profile=>{const own=rows.filter(row=>row.profileId===profile.id),blocked=own.filter(row=>row.state==='blocked');return {profileId:profile.id,state:blocked.length?'attention':active.has(profile.id)?'running':own.some(row=>row.state==='ready')?'ready':own.some(row=>row.state==='waiting')?'waiting':'idle',blockedCount:blocked.length,reason:blocked[0]?.reason||'',nextAction:blocked[0]?.nextAction||''};});
  return {checkedAt:new Date(current).toISOString(),runnableJobIds,capacity,jobs:rows,profiles:profileHealth};
}

class ProfileOperationLeases {
  constructor({clock=Date.now}={}){if(typeof clock!=='function')throw new TypeError('clock must be callable');this.clock=clock;this.leases=new Map();}
  acquire(profileId,jobId){
    if(typeof profileId!=='string'||!profileId||typeof jobId!=='string'||!jobId)throw new TypeError('Profile and job IDs are required');
    if(this.leases.has(profileId))return null;
    const lease=Object.freeze({profileId,jobId,startedAt:new Date(time(this.clock())).toISOString()});this.leases.set(profileId,lease);return lease;
  }
  release(lease){if(!lease||this.leases.get(lease.profileId)!==lease)return false;this.leases.delete(lease.profileId);return true;}
  activeProfileIds(){return [...this.leases.keys()];}
  snapshot(){return [...this.leases.values()].map(lease=>({...lease}));}
}
module.exports={startupDecision,retryDecision,inspectQueue,ProfileOperationLeases,CAPABILITIES};
