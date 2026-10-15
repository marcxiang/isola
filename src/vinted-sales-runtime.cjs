'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const {VintedAdapter}=require('./vinted-adapter.cjs');
const {VintedAccount}=require('./vinted-account.cjs');
const {VintedCatalog}=require('./vinted-catalog.cjs');
const {preparePhotosForJob}=require('./commerce-photos.cjs');
const {createTrustedPhotoManifest}=require('./vinted-photo-upload.cjs');
const {publicationInput}=require('./commerce-publication-service.cjs');
const {VintedPublishSubmit,publicationJournal}=require('./vinted-publish-submit.cjs');
const {VintedListingReceipt,listingURL}=require('./vinted-listing-receipt.cjs');
const {createSupplierOutbox}=require('./commerce-supplier-outbox.cjs');
const {FORM_URL,listingRevision,isPublicationOpen}=require('./vinted-publication.cjs');
const {missingListingFields}=require('./listing-config.cjs');
const {accountExpectation}=require('./commerce-account-binding.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const fail=(code,message,ambiguous=false)=>Object.assign(Error(message),{code,ambiguous});
const binding=plan=>JSON.stringify([plan.id,plan.profileId,plan.productId,plan.source||'supplier',plan.sku,plan.enabled,plan.completedCount,listingRevision(plan.listingRevision),plan.targetCount,plan.listingPriceCents,plan.minOfferCents,plan.reuseOwnPhotos,plan.listing]);

// One visible browser action at a time across profiles. The engine may run
// independent supplier reads concurrently, but never steals focus mid-click.
// Scope exists only in the main process; manual calls cannot waive a job lease.
class VintedSalesRuntime extends VintedAdapter {
 constructor({openPage,ensureProfile,validateImage,...options}){
  const scope=new AsyncLocalStorage(),externalBusy=options.isBusy||(()=>false);
  super({...options,isBusy:(id,w)=>{
   const own=scope.getStore();
   if(own?.profileId===id&&own.engine.active.get(id)?.signal===own.signal&&own.engine.leases.snapshot().some(row=>row.profileId===id&&row.jobId===own.jobId))return !!w.closingPromise||!!w.navigationPending;
   return externalBusy(id,w);
  }});
  this.scope=scope;this.openPage=openPage;this.ensureProfile=ensureProfile;this.validateImage=validateImage;this.uiOwner=null;this.outbox=createSupplierOutbox();this.maintenanceAfter=new Map();
 }
 readiness(){
  const base=super.readiness(),publish=typeof this.openPage==='function'&&typeof this.validateImage==='function';return {...base,vinted:'partial',salesOnly:true,capabilities:{...base.capabilities,publish,autoBindAccount:publish,autoOpenProfile:publish&&typeof this.ensureProfile==='function',messages:false,offers:false,saleConfirmation:false,shippingLabel:false,procurement:false},message:'启动后台后会自动打开计划对应环境，沿用原登录会话，读取本人身份并保留固定账号绑定，再准备照片、填写商品和单次发布。无需先手动核对账号；登录失效、身份变化或结果不明确会暂停。消息、报价和成交页面仍待真实联调；采购不在此模式中执行。'};
 }
 assertOwned({engine,job,signal},expected){
  const rows=engine.db.jobs.filter(row=>row.id===job.id),current=rows[0],plans=engine.db.plans.filter(row=>row.id===job.planId),plan=plans[0];
  if(!signal||signal.aborted||engine.faulted||engine.closing||engine.configPending||engine.active.get(job.profileId)?.signal!==signal||!engine.leases.snapshot().some(row=>row.profileId===job.profileId&&row.jobId===job.id)||rows.length!==1||plans.length!==1||!['running','completed'].includes(current?.state)||current.planId!==job.planId||current.profileId!==job.profileId||current.productId!==job.productId||current.type!=='listing'||!plan?.enabled||plan.profileId!==job.profileId||plan.productId!==job.productId||current.payload?.cycle!==plan.completedCount||listingRevision(current.payload?.listingRevision)!==listingRevision(plan.listingRevision)||listingRevision(current.payload?.listingRevision)!==listingRevision(job.payload?.listingRevision))throw fail('STOPPED','售卖任务已停止或所属计划已改变');
  if(expected&&binding(plan)!==expected)throw fail('PLAN_CHANGED','商品配置在执行中发生变化，已停止');
  return {job:current,plan};
 }
 async requireReady(profileId,context){
  if(context?.job?.type!=='listing'||!this.readiness().capabilities.publish)throw fail('CAPABILITY_UNVERIFIED','此网页步骤尚未验证，任务保留等待联调');
  this.assertOwned(context);
  const w=this.windows.get(profileId);if((!w||w.isDestroyed())&&!this.readiness().capabilities.autoOpenProfile)throw fail('PROFILE_NOT_OPEN','请先打开对应账号环境并完成登录');
  if(w&&(w.aiAgent?.state?.running||w.closingPromise||w.navigationPending||w.vintedDraftController))throw fail('PAGE_BUSY','该窗口正在使用，后台将在空闲后继续');
  if(this.uiOwner)throw fail('WORKSPACE_BUSY','另一个账号正在操作网页，当前任务等待页面操作完成');
 }
 account(engine,profileId){
  const rows=engine.db.marketAccounts.filter(row=>row.profileId===profileId),account=rows[0];
  if(rows.length!==1||!/^[1-9]\d+$/.test(account.memberId)||account.profileURL!=='https://www.vinted.fr/member/'+account.memberId||engine.db.marketAccounts.some(row=>row.profileId!==profileId&&row.memberId===account.memberId))throw fail('ACCOUNT_RECHECK_REQUIRED','请先在账号中心核对唯一的 Vinted 法国站账号');
  return clone(account);
 }
 step(context,name,expected){const {job}=this.assertOwned(context,expected);job.step=name;job.updatedAt=new Date().toISOString();context.engine.persist();context.engine.emit();}
 async inspectCatalog(profileId,options){return new VintedCatalog(this).inspect(profileId,options);}
 async inspectCurrentAccount(profileId,options){return new VintedAccount(this).inspectAccount(profileId,options);}
 accountReader(){return new VintedAccount(this);}
 async inspectInitialAccount(profileId,{signal,guard,tab,expectedAccount,expectedMemberId=expectedAccount?.memberId}){
  const page=await this.read(profileId,{signal,tab});guard();
  const mobile=page.elements.some(row=>row.tag==='button'&&['Menu ouvert','Menu fermé'].includes(String(row.label||'').trim()));
  if(!mobile)return this.inspectCurrentAccount(profileId,{signal,expectedAccount,closeMenu:true});
  const reader=this.accountReader(),candidate=await reader.inspectOwnProfileLink(profileId,{signal});guard();
  if(candidate.profileId!==profileId||candidate.tabId!==tab.id||candidate.verified!==false||candidate.consistentReads!==2||candidate.expiresAt<=Date.now()||expectedMemberId&&candidate.memberId!==expectedMemberId)throw fail('ACCOUNT_CHANGED','本人主页候选与原环境或账号身份不一致');
  const clicked=await reader.clickOwnProfileLink(profileId,candidate,{signal});guard();
  if(clicked.profileId!==profileId||clicked.tabId!==tab.id||![candidate.profileHref,candidate.profileURL].includes(clicked.url))throw fail('ACCOUNT_CHANGED','原生点击后未进入该账号本人的个人主页');
  const ready=await this.openPage(profileId,clicked.url,{signal,guard,jobId:this.scope.getStore()?.jobId,role:'identity-ready',tab});guard();
  if(ready?.tab!==tab)throw fail('TAB_CHANGED','本人身份确认标签页已改变');
  const observed=await this.inspectCurrentAccount(profileId,{signal,expectedAccount,requireOwnProfileHeading:true,closeMenu:true});guard();
  if(candidate.expiresAt<=Date.now()||observed.memberId!==candidate.memberId||observed.profileURL!==candidate.profileURL)throw fail('ACCOUNT_CHANGED','本人主页与原手机菜单身份不一致');
  return observed;
 }
 async prepareJobPhotos(engine,job,signal){return preparePhotosForJob(engine,job,{signal,validateImage:this.validateImage});}
 async trustedManifest(manifest){return createTrustedPhotoManifest(manifest);}
 async readPublicationInput(engine,id,signal,guard){return publicationInput(engine,id,signal,guard);}
 async submit(input){return new VintedPublishSubmit({enabled:true}).submit(input);}
 async collectReceipt(input,options){return new VintedListingReceipt(this).collect(input,options);}
 journal(engine){return publicationJournal(engine);}
 async executeJob(context){
  await this.requireReady(context.job.profileId,context);
  if(this.uiOwner)throw fail('WORKSPACE_BUSY','另一个账号正在操作网页，当前任务等待页面操作完成');
  const {engine,signal}=context,job=clone(context.job),plan=clone(context.plan),expected=binding(plan),profileId=job.profileId,owner={engine,jobId:job.id,profileId,signal};
  this.uiOwner=owner;
  return this.scope.run(owner,async()=>{
   let submitted=false,ownedTab=null;
   const guard=()=>this.assertOwned({...context,job},expected);
   let account,initialIdentity;const identityGuard=()=>{
    guard();const latest=accountExpectation(engine,profileId);
    if(account){const current=this.account(engine,profileId);if(current.memberId!==account.memberId||current.profileURL!==account.profileURL||latest.memberId!==account.memberId||context.job.accountMemberId!==undefined&&context.job.accountMemberId!==account.memberId)throw fail('ACCOUNT_CHANGED','环境或原任务登录绑定已改变');}
    else if(latest.memberId!==initialIdentity.memberId)throw fail('ACCOUNT_CHANGED','确认登录期间原账号绑定已改变');
   };
   const accountGuard=()=>{
    identityGuard();
    const w=this.windows.get(profileId);if(!w||w.isDestroyed()||w.aiAgent?.state?.running||w.closingPromise)throw fail('PAGE_BUSY','当前窗口正在被使用，已停止后台操作');
    if(ownedTab&&(w.activeTab!==ownedTab.id||ownedTab.view.webContents.isDestroyed()))throw fail('TAB_CHANGED','当前标签已切换，保留原页面等待核对');
   };
   const go=async(url,role)=>{accountGuard();ownedTab=null;const opened=await this.openPage(profileId,url,{signal,guard:accountGuard,jobId:job.id,role});ownedTab=opened?.tab;if(!ownedTab)throw fail('PAGE_CHANGED','后台页面没有返回原标签回执');accountGuard();};
   try{
    initialIdentity=accountExpectation(engine,profileId);account=engine.db.marketAccounts.some(row=>row.profileId===profileId)?this.account(engine,profileId):null;
    identityGuard();
    if(plan.activeListingId||engine.db.publications.submissions.some(row=>row.proof.facts.planId===plan.id&&isPublicationOpen(row)))throw fail('PUBLICATION_EXISTS','原商品或提交记录尚未关闭，不能再次刊登');
    const missing=missingListingFields(plan.listing),labels={title:'标题',description:'商品描述',condition:'成色',brand:'品牌',color:'颜色',parcel:'包裹规格',categoryPath:'完整商品分类'};
    if(missing.length)throw fail('LISTING_INCOMPLETE','计划缺少已确认的商品字段：'+missing.map(key=>labels[key]).join('、'));
    if(typeof this.ensureProfile==='function'){
     this.step(context,'open_environment',expected);
     await this.ensureProfile(profileId,{signal,guard:identityGuard,jobId:job.id});
    }
    accountGuard();
    this.step(context,'check_catalog',expected);
    if(!account){
     await go('https://www.vinted.fr/','identity');
     const observed=await this.inspectInitialAccount(profileId,{signal,guard:accountGuard,tab:ownedTab,expectedAccount:initialIdentity.account,expectedMemberId:initialIdentity.memberId});accountGuard();
     if(initialIdentity.memberId&&observed.memberId!==initialIdentity.memberId)throw fail('ACCOUNT_CHANGED','当前登录账号与原任务身份不一致');
     account=engine.bindJobAccount(job.id,observed,{signal,guard});accountGuard();
    }
    await go(account.profileURL,'catalog');
    const ownerAccount=await this.inspectCurrentAccount(profileId,{signal,expectedAccount:account,closeMenu:true});accountGuard();
    account=engine.bindJobAccount(job.id,ownerAccount,{signal,guard});accountGuard();
    const catalog=await this.inspectCatalog(profileId,{expectedAccount:account,title:plan.listing.title,signal});accountGuard();
    if(catalog.complete!==true)throw fail('CATALOG_INCOMPLETE',catalog.reason||'衣橱未完整加载，无法核对是否已有相同商品');
    if(catalog.duplicate!==false)throw fail('LISTING_EXISTS','该账号衣橱中已有相同标题的商品，已停止重复刊登');
    this.step(context,'prepare_photos',expected);
    const photos=await this.prepareJobPhotos(engine,job,signal);accountGuard();
    if(!photos.summary?.ready||!photos.manifest)throw fail('PHOTO_UNVERIFIED','照片领取、下载或校验尚未完成');
    this.step(context,'prepare_listing',expected);
    await go(FORM_URL,'listing');
    const draft=await this.prepareFields(profileId,{...plan.listing,priceCents:plan.listingPriceCents},{signal});accountGuard();
    const unresolved=[...(draft.missing||[]),...(draft.unresolved||[]).filter(row=>row.field!=='photos')];
    if(unresolved.length)throw fail('LISTING_INCOMPLETE','网页商品字段未核对完成：'+unresolved.map(row=>row.label||row.field).join('、'));
    this.step(context,'upload_photos',expected);
    const manifest=await this.trustedManifest(photos.manifest);accountGuard();
    const upload=await this.uploadPhotos(profileId,manifest,{signal});accountGuard();
    if(upload?.verified!==true||upload.uncertain!==false||upload.claimId!==photos.manifest.claimId||upload.count!==photos.manifest.count)throw fail('PHOTO_UNVERIFIED','原页面照片上传结果待核对，未重复上传',upload?.uncertain===true);
    const observed=await this.inspectCurrentAccount(profileId,{signal,expectedAccount:account,closeMenu:true});accountGuard();
    if(observed.verified!==true||observed.memberId!==account.memberId||observed.profileURL!==account.profileURL)throw fail('ACCOUNT_CHANGED','发布页账号与原绑定不一致');
    engine.accountObservations.set(profileId,{...observed,profileId,checkedAt:new Date().toISOString()});
    const input=await this.readPublicationInput(engine,plan.id,signal,accountGuard);accountGuard();
    this.step(context,'publish_listing',expected);
    const result=await this.submit({engine,planId:plan.id,input,signal,guard:accountGuard});submitted=true;accountGuard();
    const journal=this.journal(engine),record=journal.get(result.submissionId),candidate=result.navigationCandidate;
    // Only the native navigation captured during this exact click can link a
    // new item automatically. A changed URL or matching title alone cannot.
    if(!candidate?.committed||candidate.submissionId!==record.id||candidate.formDocumentKey!==record.proof.facts.documentKey||candidate.profileId!==profileId||!record.navigation?.some(row=>JSON.stringify(row)===JSON.stringify(candidate)))throw fail('PUBLICATION_UNKNOWN_RESULT','发布已尝试一次，但没有原提交的完整导航回执；请核对原刊登',true);
    const selected=this.current(profileId,{signal});
    if(selected.tab.id!==candidate.tabId||listingURL(selected.tab.view.webContents.getURL()).listingId!==candidate.listingId)throw fail('PUBLICATION_UNKNOWN_RESULT','发布后页面已改变；原提交保留等待核对',true);
    this.step(context,'verify_listing',expected);
    const verified=await this.collectReceipt({record,expectedAccount:account},{signal,withEvidence:async({evidence,binding:page},pageGuard)=>{
     accountGuard();pageGuard();if(page.tabId!==candidate.tabId||evidence.listingId!==candidate.listingId)throw fail('PUBLICATION_UNKNOWN_RESULT','详情页与原提交导航不一致',true);
     return journal.reconcile(record.id,{...evidence,origin:clone(candidate)},{guard:()=>{accountGuard();pageGuard();}});
    }});
    if(verified?.state!=='published')throw fail('PUBLICATION_UNKNOWN_RESULT','发布已尝试一次，实际商品、照片或账号回执未完全一致；保留原记录等待核对',true);
    const latest=engine.db.jobs.find(row=>row.id===job.id);
    if(latest?.state!=='completed'||latest.result?.externalId!==verified.receipt.listingId||latest.result?.submissionId!==record.id)throw fail('PUBLICATION_UNKNOWN_RESULT','原刊登回执未能完整保存到任务，已停止',true);
   }catch(error){
    const attempted=engine.db.publications.submissions.some(row=>row.proof.facts.planId===plan.id&&row.proof.facts.cycle===job.payload.cycle&&listingRevision(row.proof.facts.listingRevision)===listingRevision(job.payload.listingRevision)&&isPublicationOpen(row)&&row.attemptCount===1);
    if(submitted||attempted)error.ambiguous=true;
    throw error;
   }finally{if(this.uiOwner===owner)this.uiOwner=null;}
  });
 }
 async maintenance({engine,signal,planIds=null}){
  if(signal.aborted||engine.closing||engine.faulted)return;
  // A scoped plan start cannot dispatch associations belonging to another plan.
  // Missing or ambiguous original publications never authorize an outbox write.
  const owned=id=>{
   if(planIds!==null&&!(planIds instanceof Set))return null;
   const rows=(engine.db.publicationSupplierSync||[]).filter(row=>row.id===id),row=rows[0];if(rows.length!==1)return null;
   const records=(engine.db.publications?.submissions||[]).filter(record=>record.id===row.submissionId),record=records[0],facts=record?.proof?.facts;
   if(records.length!==1||record.state!=='published'||typeof facts?.planId!=='string'||!facts.planId||facts.profileId!==row.profileId||facts.productId!==row.productId||planIds!==null&&!planIds.has(facts.planId)||engine.db.plans?.some(plan=>plan.id===facts.planId&&plan.source==='local'))return null;
   return {row,signature:JSON.stringify([row.id,row.submissionId,row.profileId,row.productId,record.id,record.state,facts.planId,facts.profileId,facts.productId])};
  };
  for(const id of (engine.db.publicationSupplierSync||[]).filter(row=>!['synced','cancelled','needs_review'].includes(row.state)).map(row=>row.id)){
   if(signal.aborted||engine.closing||engine.faulted)return;
   const original=owned(id);if(!original)continue;
   if((this.maintenanceAfter.get(id)||0)>Date.now())continue;
   const row=original.row,profileId=row.profileId;
   if(engine.active.has(profileId))continue;
   const lease=engine.leases.acquire(profileId,'supplier:'+id);if(!lease)continue;
   const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();engine.active.set(profileId,controller);
   const guard=()=>{if(controller.signal.aborted||engine.closing||engine.faulted||engine.active.get(profileId)!==controller||!engine.leases.snapshot().some(row=>row.profileId===profileId&&row.jobId===lease.jobId)||owned(id)?.signature!==original.signature)throw fail('STOPPED','货盘照片关联已停止');};
   try{guard();await this.outbox.run(engine,id,{signal:controller.signal,guard,allowDispatch:true});}
   catch(error){if(!controller.signal.aborted&&!engine.faulted)engine.event('warning','照片上架关联：'+String(error.message).slice(0,400));}
   finally{this.maintenanceAfter.set(id,Date.now()+60000);signal.removeEventListener('abort',abort);if(engine.active.get(profileId)===controller)engine.active.delete(profileId);engine.leases.release(lease);engine.emit();}
  }
 }
 // No synthetic events. Conversation and paid-order adapters remain disabled
 // until their live account/item/buyer identifiers have been verified.
 async poll(){return [];}
}
module.exports={VintedSalesRuntime};
