'use strict';
const {accountNeedsLoginReview,ACCOUNT_MUTATION_MESSAGES,normalizeIdentity}=require('./commerce-accounts.cjs');

// The renderer can ask to operate on an account ID, but never reads credentials.
// Authentication is separate from the general AI page-control interface.
const MESSAGES={
 ACCOUNT_BUSY:'账号正在操作，请等待当前步骤结束。',
 ACCOUNT_MISSING:'账号记录不存在，请刷新账号中心。',
 ACCOUNT_HISTORY:'账号关联了运营记录，不能删除、更换登录名或换绑环境。',
 PROFILE_OPEN:'请先关闭对应浏览器环境，再删除账号或换绑。',
 ACCOUNT_CHANGED:'当前 Vinted 身份与固定账号不一致，已保留原绑定。',
 ACCOUNT_CONFLICT:'此 Vinted 账号已绑定其他环境，请使用原环境。',
 ACCOUNT_CONFIRMATION_REQUIRED:'请先在窗口核对当前账号，再使用“核对登录”确认绑定。',
 ACCOUNT_INVALID:'账号保存失败，请检查输入、环境和本机加密状态。',
 ACCOUNT_UNAVAILABLE:'账号操作未完成，页面已保留，请在窗口核对。',
 ...ACCOUNT_MUTATION_MESSAGES
};
function fail(code){const error=Error(MESSAGES[code]||MESSAGES.ACCOUNT_UNAVAILABLE);error.code=Object.hasOwn(MESSAGES,code)?code:'ACCOUNT_UNAVAILABLE';return error;}
const pendingReview=new Set(['LOGIN_STARTED','LOGIN_OUTCOME_UNKNOWN','CHALLENGE_REQUIRED','ACCOUNT_CONFIRMATION_REQUIRED','PAGE_CHANGED','IDENTITY_UNVERIFIED']);
const safeCodes=new Set(['LOGIN_REQUIRED','LOGIN_VERIFIED','LOGIN_FAILED','CHALLENGE_REQUIRED','INVALID_CREDENTIALS','STOPPED','UNAVAILABLE','LOGIN_OUTCOME_UNKNOWN','ACCOUNT_CONFIRMATION_REQUIRED','ACCOUNT_CHANGED','ACCOUNT_CONFLICT','IDENTITY_UNVERIFIED','PAGE_UNSUPPORTED','PAGE_CHANGED','FORM_NOT_FOUND','PAGE_NOT_READY','INPUT_SURFACE_UNAVAILABLE','PAGE_BUSY','WINDOW_CLOSED']);
const resultCodes={LOGGED_IN:'LOGIN_VERIFIED',ACCOUNT_MISMATCH:'ACCOUNT_CHANGED',LOGIN_FORM_REQUIRED:'FORM_NOT_FOUND',LOGIN_FIELDS_NOT_EMPTY:'PAGE_UNSUPPORTED',LOGIN_CHALLENGE:'CHALLENGE_REQUIRED',LOGIN_RESULT_UNKNOWN:'LOGIN_OUTCOME_UNKNOWN',LOGIN_FORM_CHANGED:'PAGE_CHANGED',ACCOUNT_UNVERIFIED:'IDENTITY_UNVERIFIED',PROFILE_REVIEW_REQUIRED:'IDENTITY_UNVERIFIED',INPUT_SURFACE_UNAVAILABLE:'INPUT_SURFACE_UNAVAILABLE',WRONG_SITE:'PAGE_UNSUPPORTED',PAGE_BUSY:'PAGE_BUSY',WINDOW_CLOSED:'WINDOW_CLOSED',TAB_CHANGED:'PAGE_CHANGED',LOGIN_UNAVAILABLE:'UNAVAILABLE'};
const hasVerifiedResult=result=>result?.verified===true&&result.status==='logged_in'&&result.account?.verified===true;

class CommerceAccountService{
 constructor({engine,store,openPage,login}){this.engine=engine;this.store=store;this.openPage=openPage;this.loginService=login;this.pending=new Set();}
 isBusy(id){return this.pending.has(id);}
 async configured(work,fallback='ACCOUNT_UNAVAILABLE'){
  try{return await this.engine.configure(work);}catch(error){throw fail(Object.hasOwn(MESSAGES,error?.code)?error.code:fallback);}
 }
 async mutate(id,work,fallback='ACCOUNT_UNAVAILABLE'){
  try{
   if(this.engine.closing)throw fail('ACCOUNT_CLOSED');
   if(this.store.faulted||this.engine.faulted||this.engine.storageFaulted?.())throw fail('ACCOUNT_STORAGE_UNAVAILABLE');
   if(id&&(this.isBusy(id)||this.store.isBusy?.(id)))throw fail('ACCOUNT_BUSY');
   // The vault commits synchronously and atomically. It does not need to stop
   // other profiles' scheduler or await the global configuration queue.
   return work();
  }catch(error){throw fail(Object.hasOwn(MESSAGES,error?.code)?error.code:fallback);}
 }
 save(input){return this.mutate(input?.id,()=>({account:this.store.save(input),message:'账号已加密保存在本机；原账号身份和待核对记录保持。'}),'ACCOUNT_INVALID');}
 removalBinding(account){
  const db=this.engine.db,bindings=(db.marketAccounts||[]).filter(row=>row.profileId===account.profileId),binding=bindings[0];
  if(bindings.length>1)throw fail('ACCOUNT_CHANGED');
  if(binding){
   let identity;try{identity=normalizeIdentity({...binding,verified:true},binding.verifiedAt);}catch{throw fail('ACCOUNT_CHANGED');}
   if(binding.platform!=='vinted-fr'||binding.profileURL!==identity.profileURL||account.identity&&(account.identity.memberId!==identity.memberId||account.identity.profileURL!==identity.profileURL))throw fail('ACCOUNT_CHANGED');
  }
  const planIds=new Set((db.plans||[]).filter(row=>row.profileId===account.profileId).map(row=>row.id)),jobIds=new Set((db.jobs||[]).filter(row=>row.profileId===account.profileId||planIds.has(row.planId)).map(row=>row.id));
  const related=row=>row&&(row.profileId===account.profileId||planIds.has(row.planId)||jobIds.has(row.jobId));
  const history=planIds.size>0||['jobs','claims','photoPreparations','localPhotoPreparations','sales','reservations','publicationSupplierSync'].some(key=>(db[key]||[]).some(row=>related(row)||Array.isArray(row.listings)&&row.listings.some(link=>planIds.has(link.planId))))||(db.publications?.submissions||[]).some(row=>related(row.proof?.facts));
  if(history&&account.identity&&!binding)throw fail('ACCOUNT_BINDING_REQUIRED');
 }
 remove(id){return this.mutate(id,()=>{let account;try{account=this.store.get(id);}catch{throw fail('ACCOUNT_MISSING');}this.removalBinding(account);this.store.remove(id);return {message:'本机登录资料已删除；原运营账号绑定、任务历史和窗口登录保持。'};});}
 async operate(id,work){
  if(typeof id!=='string'||!id)throw fail('ACCOUNT_MISSING');
  if(this.pending.has(id))throw fail('ACCOUNT_BUSY');
  this.pending.add(id);
  try{return await this.configured(async(signal,guard)=>{let account;try{account=this.store.get(id);}catch{throw fail('ACCOUNT_MISSING');}if(!account)throw fail('ACCOUNT_MISSING');guard();return work(account,signal,guard);});}
  finally{this.pending.delete(id);}
 }
 expectations(account){
  const bound=this.engine.db.marketAccounts.find(row=>row.profileId===account.profileId);
  if(bound&&account.identity&&bound.memberId!==account.identity.memberId)throw fail('ACCOUNT_CHANGED');
  const expectedMemberId=account.identity?.memberId||bound?.memberId;
  // Only an earlier verified binding can supply the username omitted from a
  // mobile home-page drawer. A saved email/login or confirmCurrent cannot.
  const previous=[account.identity,bound].find(value=>value?.profileURL!==undefined&&value?.username!==undefined);
  let expectedAccount;
  if(previous){
   if(typeof expectedMemberId!=='string'||!/^[1-9]\d{0,29}$/.test(expectedMemberId)||previous.memberId!==expectedMemberId||previous.profileURL!=='https://www.vinted.fr/member/'+expectedMemberId||typeof previous.username!=='string'||!previous.username||previous.username.trim()!==previous.username||previous.username.length>100||/[\u0000-\u001f\u007f]/.test(previous.username))throw fail('ACCOUNT_CHANGED');
   expectedAccount=Object.freeze({profileId:account.profileId,memberId:expectedMemberId,profileURL:previous.profileURL,username:previous.username});
  }
  return {login:account.login,expectedMemberId,expectedUsername:undefined,...(expectedAccount?{expectedAccount}:{})};
 }
 commitIdentity(account,observed,guard){
  guard();if(observed?.verified!==true)throw fail('ACCOUNT_UNAVAILABLE');
  this.engine.bindMarketAccount(account.profileId,observed);
  this.engine.emit();
  return {account:this.store.get(account.id),result:{status:'logged_in',code:'LOGIN_VERIFIED',submitted:false,verified:true},message:'已核对当前 Vinted 登录身份。'};
 }
 open(id){return this.operate(id,async(account,signal,guard)=>{await this.openPage(account.profileId,{signal,guard});guard();return {account:this.store.get(id),message:'已打开固定环境，可在页面继续操作。'};});}
 verify(id,options={}){return this.operate(id,async(account,signal,guard)=>{
  let result;
  try{
   await this.openPage(account.profileId,{signal,guard,reviewCurrent:true});guard();
   const expected=this.expectations(account),confirmed=options?.confirmCurrent===true;
   result=await this.loginService.verify(account.profileId,{...expected,signal,confirmCurrent:confirmed,closeAccountMenu:true,requireOwnProfileClick:true});guard();
   if(!hasVerifiedResult(result)&&(result?.code==='PROFILE_REVIEW_REQUIRED'||!expected.expectedMemberId&&result?.code==='ACCOUNT_UNVERIFIED')&&confirmed&&typeof this.loginService.inspectOwnProfileLink==='function'&&typeof this.loginService.clickOwnProfileLink==='function'){
    const review=await this.openPage(account.profileId,{signal,guard,freshAccountReview:true});guard();
    if(review?.profileId!==account.profileId||review.url!=='https://www.vinted.fr/')throw fail('ACCOUNT_UNAVAILABLE');
    const candidate=await this.loginService.inspectOwnProfileLink(account.profileId,{signal});guard();
    if(candidate?.kind!=='own-profile-candidate'||candidate.verified!==false||candidate.profileId!==account.profileId||candidate.tabId!==review.tabId||candidate.consistentReads!==2||typeof candidate.memberId!=='string'||!/^[1-9]\d{0,29}$/.test(candidate.memberId)||candidate.profileURL!=='https://www.vinted.fr/member/'+candidate.memberId||typeof candidate.profileHref!=='string'||candidate.expiresAt<=Date.now())throw fail('ACCOUNT_UNAVAILABLE');
    if(expected.expectedMemberId&&candidate.memberId!==expected.expectedMemberId)throw fail('ACCOUNT_CHANGED');
    const opened=await this.openPage(account.profileId,{signal,guard,ownProfileURL:candidate.profileURL,ownProfileHref:candidate.profileHref,clickOwnProfile:({signal:clickSignal}={})=>this.loginService.clickOwnProfileLink(account.profileId,candidate,{signal:clickSignal||signal})});guard();
    if(opened?.profileId!==account.profileId||opened.url!==candidate.profileURL||opened.tabId!==candidate.tabId)throw fail('ACCOUNT_UNAVAILABLE');
    // A candidate is not a prior account mapping. Do not promote its member ID
    // to expectedMemberId or synthesize a username before the normal reader.
    result=await this.loginService.verify(account.profileId,{...expected,signal,confirmCurrent:confirmed,closeAccountMenu:true,requireOwnProfileHeading:true});guard();
    if(hasVerifiedResult(result)&&(candidate.expiresAt<=Date.now()||result.account.memberId!==candidate.memberId||result.account.profileURL!==candidate.profileURL))throw fail('ACCOUNT_CHANGED');
   }
  }
  catch(error){return this.record(account,{status:'awaiting_user',code:error?.code,submitted:false},guard);}
  if(hasVerifiedResult(result))return this.commitIdentity(account,result.account,guard);
  return this.record(account,{...result,submitted:result?.submitted===true},guard);
 });}
 record(account,result,guard){
  guard();const mapped=resultCodes[result?.code]||result?.code;let code=safeCodes.has(mapped)?mapped:result?.submitted?'LOGIN_OUTCOME_UNKNOWN':'UNAVAILABLE';
  if(result?.submitted===true&&!pendingReview.has(code))code='LOGIN_OUTCOME_UNKNOWN';
  const status=result?.status==='error'&&!result?.submitted?'error':'awaiting_user';
  this.store.markResult(account.id,{status,code,loginReviewPending:accountNeedsLoginReview(account)||result?.submitted===true});this.engine.accountObservations.delete(account.profileId);this.engine.emit();
  const saved=this.store.get(account.id);
  return {account:saved,result:{status,code,submitted:result?.submitted===true,verified:false,loginReviewPending:accountNeedsLoginReview(saved)},message:code==='UNAVAILABLE'?'本次账号核对未完成，请显示当前 Vinted 环境并在页面就绪后重试；尚未确认登录身份。':saved.lastResult?.message||MESSAGES.ACCOUNT_UNAVAILABLE};
 }
 login(id){return this.operate(id,async(account,signal,guard)=>{
  const expected=this.expectations(account);
  const page=await this.openPage(account.profileId,{signal,guard});guard();
  // A previous submission or interrupted attempt must be read back first.
  // Credential edits preserve the read-before-login latch. A fresh verified
  // identity is required before an interrupted authentication may be cleared.
  if(accountNeedsLoginReview(account)){
   let result;try{result=await this.loginService.verify(account.profileId,{...expected,signal});guard();}catch(error){result={status:'awaiting_user',code:error?.code||'LOGIN_OUTCOME_UNKNOWN'};}
   if(hasVerifiedResult(result))return this.commitIdentity(account,result.account,guard);
   return this.record(account,{...result,submitted:result?.submitted===true},guard);
  }
  if(!account.hasPassword){
   const result=await this.loginService.verify(account.profileId,{...expected,signal});guard();
   if(hasVerifiedResult(result))return this.commitIdentity(account,result.account,guard);
   return this.record(account,result?.code==='ACCOUNT_UNVERIFIED'?{status:'awaiting_user',code:'LOGIN_REQUIRED'}:result,guard);
  }
  this.store.markResult(id,{status:'logging_in',code:'LOGIN_STARTED'});
  this.engine.accountObservations.delete(account.profileId);this.engine.emit();
  let result;
  try{result=await this.store.withCredentials(id,async credentials=>{
   const options={...expected,login:credentials.login,password:credentials.password,signal};
   let out=await this.loginService.login(account.profileId,options);guard();
   // An anonymous home page is not the email form. Opening the official login
   // route is safe only when the first read entered no credentials or submit.
   if(out?.code==='LOGIN_FORM_REQUIRED'&&out.submitted===false&&page?.url&&page.url!=='https://www.vinted.fr/member/login/email'){
    await this.openPage(account.profileId,{signal,guard,freshLogin:true});guard();out=await this.loginService.login(account.profileId,options);
   }
   return out;
  });guard();}
  catch(error){result={status:'awaiting_user',code:safeCodes.has(error?.code)?error.code:'LOGIN_OUTCOME_UNKNOWN',submitted:true};}
  try{
   if(hasVerifiedResult(result)){const committed=this.commitIdentity(account,result.account,guard);committed.result.submitted=result.submitted===true;return committed;}
   return this.record(account,result,guard);
  }finally{
   // A cancelled guard or binding/storage failure cannot leave the live UI
   // claiming that an authentication attempt is still running indefinitely.
   try{if(this.store.get(id).status==='logging_in')this.store.markResult(id,{status:'awaiting_user',code:'LOGIN_OUTCOME_UNKNOWN'});}catch{}
  }
 });}
}
module.exports={CommerceAccountService,accountError:fail};
