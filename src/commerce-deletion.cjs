'use strict';

// Empty drafts may be removed. Used plans are hidden by an independent archive
// marker; their original business rows, identities and dedupe keys remain live.
// External listings, supplier claims and private photo files are never deleted.
const {localProductDTO}=require('./commerce-local-products.cjs');
const {listingRevision,isPublicationOpen}=require('./vinted-publication.cjs');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const beforeSubmission=new Set(['pending','open_environment','check_catalog','prepare_photos','prepare_listing','upload_photos','draft_reply','check_offer','download_label','check_stock_price','wms_checkout']);
function fail(code,message){throw Object.assign(Error(message),{code});}
function identifier(value){if(typeof value!=='string'||!value||value.trim()!==value||value.length>256||/[\x00-\x1f\x7f]/.test(value))fail('DELETION_INVALID','删除记录编号无效');return value;}
function available(engine,{configured=false}={}){
 if(!engine||typeof engine.configure!=='function'||typeof engine.persist!=='function'||typeof engine.emit!=='function')fail('DELETION_INVALID','运营删除服务尚未就绪');
 if(engine.closing)fail('DELETION_CLOSED','运营正在关闭，请重新打开后删除草稿');
 if(engine.faulted||engine.storageFaulted?.())fail('DELETION_STORAGE','运营数据无法安全保存，请先修复存储后删除');
 if(engine.running||engine.ticking||engine.active?.size||engine.leases?.snapshot?.().length||engine.configPending>(configured?1:0))fail('DELETION_BUSY','请先停止调度，等待运行任务和配置操作结束，再删除草稿');
 const db=engine.db;
 if(!object(db)||!['plans','products','localProducts','productListings','jobs','claims','sales','reservations','photoPreparations','localPhotoPreparations','publicationSupplierSync','events'].every(key=>Array.isArray(db[key]))||!Array.isArray(db.publications?.submissions))fail('DELETION_RECORD_INVALID','运营关联记录不完整，原数据已保留，不能删除');
 return db;
}
function one(rows,id,label){const found=rows.filter(row=>row?.id===id);if(found.length!==1)fail('DELETION_MISSING',label+'不存在或编号重复，请刷新后核对');return found[0];}
function planBinding(plan,row){return !!row&&(row.planId===plan.id||row.profileId===plan.profileId&&row.productId===plan.productId);}
function claimUsesPlan(plan,claim){return planBinding(plan,claim)||Array.isArray(claim?.listings)&&claim.listings.some(link=>link?.planId===plan.id);}
function isPlanArchived(db,id){return (db.planArchives||[]).some(row=>row.planId===id);}
function archivedPlanError(){return Object.assign(Error('这个计划已删除并归档，请先在「已删除计划」中恢复原计划；恢复后仍需手动启用'),{code:'PLAN_ARCHIVED'});}
function closedListingJob(db,plan,job){
 if(job.type!=='listing'||job.state!=='cancelled'||job.operation!=null||job.result?.kind!=='listing_deleted'||!object(job.deletion))return false;
 const records=db.publications.submissions.filter(record=>record.id===job.result.submissionId),record=records[0],closure=record?.closedWithdrawal,facts=record?.proof?.facts;
 if(records.length!==1||!object(closure)||!facts||isPublicationOpen(record)||facts.planId!==plan.id||facts.profileId!==plan.profileId||facts.productId!==plan.productId||facts.sku!==plan.sku||facts.cycle!==job.payload?.cycle||listingRevision(facts.listingRevision)!==listingRevision(job.payload?.listingRevision)||job.result.externalId!==closure.listingId||job.deletion.submissionId!==record.id)return false;
 const keys=Object.keys(closure);return Object.keys(job.deletion).length===keys.length+1&&keys.every(key=>job.deletion[key]===closure[key]);
}
function archiveSafety(db,plan){
 if(!object(plan)||!['profileId','productId','sku'].every(key=>typeof plan[key]==='string'&&!!plan[key].trim()))fail('DELETION_RECORD_INVALID','计划的环境、商品或 SKU 记录不完整，不能归档');
 if(plan.activeListingId!==null&&plan.activeListingId!==undefined)fail('DELETION_ACTIVE_LISTING','计划仍有关联在售商品；请核对原刊登，不能删除计划');
 if(db.publications.submissions.some(record=>planBinding(plan,record?.proof?.facts)&&isPublicationOpen(record)))fail('DELETION_PUBLICATION_HISTORY','计划仍有未关闭的原刊登或结果未知的提交，请先核对原刊登再删除');
 const jobs=db.jobs.filter(row=>planBinding(plan,row)),ids=new Set(jobs.map(row=>row.id));
 for(const job of jobs){
  if(job.planId!==plan.id||job.profileId!==plan.profileId||job.productId!==plan.productId||typeof job.id!=='string'||!job.id||typeof job.dedupeKey!=='string'||!job.dedupeKey||db.jobs.filter(row=>row.id===job.id||row.dedupeKey===job.dedupeKey).length!==1)fail('DELETION_JOB_HISTORY','任务与原计划的身份或去重编号不一致，不能隐藏待核对记录');
  if(!['queued','needs_review','cancelled','rejected','completed'].includes(job.state)||job.mutationPending!==false||job.operation!=null&&(!object(job.operation)||!Object.hasOwn(job.operation,'receipt')&&job.operation.rejected!==true)||job.state!=='completed'&&(!beforeSubmission.has(job.step)||job.operation!=null||job.result!=null)&&!closedListingJob(db,plan,job))fail('DELETION_JOB_HISTORY','计划仍有运行中、结果未知或尚未核对的业务请求，请先核对原任务再删除');
 }
 const sales=db.sales.filter(row=>row.planId===plan.id||ids.has(row.jobId));
 if(!Number.isSafeInteger(plan.completedCount)||plan.completedCount<0||plan.completedCount!==sales.length||sales.some(row=>row.planId!==plan.id)||!require('./commerce-engine.cjs').saleCycleComplete(db,plan.id))fail('DELETION_SALE_HISTORY','计划仍有待确认成交、未完成履约或销量关联不一致，请先核对原成交');
 for(const record of db.photoPreparations.filter(row=>planBinding(plan,row))){
  if(record.planId!==plan.id||['claiming','uncertain'].includes(record.state)||record.firstAttemptAt&&(!record.receipt||!record.claimId||!db.claims.some(claim=>claim.id===record.claimId&&claim.profileId===plan.profileId&&claim.productId===plan.productId)))fail('DELETION_PHOTO_HISTORY','原照片领取结果尚未核对，不能归档隐藏；请先恢复核对原领取');
 }
 if(db.claims.some(claim=>claimUsesPlan(plan,claim)&&!planBinding(plan,claim)))fail('DELETION_PHOTO_HISTORY','照片使用历史与原计划的环境或商品不一致，请先核对原照片关联');
 if(db.publicationSupplierSync.some(row=>planBinding(plan,row)&&!['synced','cancelled'].includes(row.state)))fail('DELETION_SUPPLIER_HISTORY','货盘上架关联尚未完成或结果未知，请先核对原请求再删除计划');
 if(db.reservations.some(row=>(planBinding(plan,row)||ids.has(row.jobId))&&!jobs.some(job=>job.id===row.jobId&&job.state==='completed'&&job.result?.verified===true)))fail('DELETION_RESERVATION_HISTORY','计划仍有未完成的采购额度预留，请先核对原订单或履约任务');
 return jobs;
}
function restorePlanArchives(db){
 if(db.planArchives===undefined)db.planArchives=[];
 if(!Array.isArray(db.planArchives))fail('PLAN_ARCHIVE_INVALID','已删除计划记录格式无效，原文件已保留');
 const ids=new Set();
 for(const row of db.planArchives){
  if(!object(row)||Object.keys(row).length!==2||!Object.hasOwn(row,'planId')||!Object.hasOwn(row,'archivedAt')||typeof row.planId!=='string'||!row.planId||row.planId.trim()!==row.planId||row.planId.length>256||/[\x00-\x1f\x7f]/.test(row.planId)||ids.has(row.planId)||typeof row.archivedAt!=='string'||!Number.isFinite(Date.parse(row.archivedAt))||new Date(row.archivedAt).toISOString()!==row.archivedAt)fail('PLAN_ARCHIVE_INVALID','已删除计划记录包含重复编号或无效字段，原文件已保留');
  const plans=db.plans.filter(plan=>plan.id===row.planId),plan=plans[0];if(plans.length!==1||plan.enabled!==false||db.jobs.some(job=>job.planId===row.planId&&['queued','running','uncertain'].includes(job.state)))fail('PLAN_ARCHIVE_INVALID','已删除计划仍在启用、排队或执行，原文件已保留，不能自动运行');
  try{archiveSafety(db,plan);}catch{fail('PLAN_ARCHIVE_INVALID','已删除计划存在未完成的业务或关联冲突，原文件已保留');}ids.add(row.planId);
 }
 return db.planArchives;
}
function planWithoutHistory(db,plan){
 if(!object(plan)||!['profileId','productId','sku'].every(key=>typeof plan[key]==='string'&&!!plan[key].trim()))fail('DELETION_RECORD_INVALID','计划的环境、商品或 SKU 记录不完整，不能删除');
 if(plan.activeListingId!==null&&plan.activeListingId!==undefined)fail('DELETION_ACTIVE_LISTING','计划仍有关联在售商品；请核对原刊登，不能删除计划');
 if(plan.completedCount!==0||listingRevision(plan.listingRevision)!==0)fail('DELETION_PLAN_HISTORY','计划已有成交数量或重新刊登版本；请停用并保留原计划记录');
 if(db.publications.submissions.some(record=>planBinding(plan,record?.proof?.facts)))fail('DELETION_PUBLICATION_HISTORY','计划已有原刊登提交记录（包括结果未知、已关闭或已取消）；不能删除提交证据，请停用并保留记录');
 const jobs=db.jobs.filter(row=>planBinding(plan,row));
 if(jobs.length)fail('DELETION_JOB_HISTORY','计划已有任务记录（包括排队、失败或已取消）；不能删除原任务与去重记录，可先取消未提交任务或停用计划');
 if([...db.photoPreparations,...db.localPhotoPreparations].some(row=>planBinding(plan,row))||db.claims.some(claim=>claimUsesPlan(plan,claim)))fail('DELETION_PHOTO_HISTORY','计划已有照片领取或准备记录；原照片归属必须保留，不能删除计划');
 if(db.sales.some(row=>planBinding(plan,row)))fail('DELETION_SALE_HISTORY','计划已有成交记录，不能删除原销售关联');
 if(db.publicationSupplierSync.some(row=>planBinding(plan,row)))fail('DELETION_SUPPLIER_HISTORY','计划已有货盘上架关联记录，不能删除原请求或回执');
 if(db.reservations.some(row=>planBinding(plan,row)))fail('DELETION_RESERVATION_HISTORY','计划已有采购额度预留记录，不能删除原业务关联');
}
function productBinding(product,row){return !!row&&(row.productId===product.id||row.localProductId===product.id);}
function productWithoutHistory(db,product){
 if(db.plans.some(plan=>plan?.productId===product.id))fail('DELETION_PRODUCT_PLANS','商品仍被上架计划使用；请先删除无业务记录的草稿计划，已有业务计划应停用并保留');
 if(db.publications.submissions.some(record=>productBinding(product,record?.proof?.facts)))fail('DELETION_PUBLICATION_HISTORY','商品已有原刊登提交记录，不能删除刊登证据或商品关联');
 if(db.jobs.some(row=>productBinding(product,row)))fail('DELETION_JOB_HISTORY','商品已有任务记录（包括失败或已取消），不能删除原任务与商品关联');
 if([...db.photoPreparations,...db.localPhotoPreparations].some(row=>productBinding(product,row))||db.claims.some(row=>productBinding(product,row)))fail('DELETION_PHOTO_HISTORY','商品已有照片领取或准备记录，不能删除原照片归属或商品');
 if(db.sales.some(row=>productBinding(product,row)))fail('DELETION_SALE_HISTORY','商品已有成交记录，不能删除原销售关联');
 if(db.publicationSupplierSync.some(row=>productBinding(product,row)))fail('DELETION_SUPPLIER_HISTORY','商品已有货盘上架关联请求或回执，不能删除');
 if(db.reservations.some(row=>productBinding(product,row)))fail('DELETION_RESERVATION_HISTORY','商品已有采购额度预留记录，不能删除');
}
function commit(engine,patch,event){
 const db=engine.db,previous=Object.fromEntries([...Object.keys(patch),'events'].map(key=>[key,db[key]]));
 Object.assign(db,patch);db.events=[...db.events,{time:new Date().toISOString(),kind:'info',text:event.slice(0,500)}].slice(-300);
 try{engine.persist();}catch(error){Object.assign(db,previous);throw error;}
 engine.emit();
}
function run(engine,id,work){
 try{identifier(id);available(engine);}catch(error){return Promise.reject(error);}
 return engine.configure((signal,guard)=>{guard();if(signal.aborted)fail('DELETION_STOPPED','删除已停止，原记录已保留');const db=available(engine,{configured:true});return work(db,()=>{guard();available(engine,{configured:true});});});
}
function deletePlan(engine,id){return run(engine,id,(db,guard)=>{
 const plan=one(db.plans,id,'销售计划');let history=false;
 try{planWithoutHistory(db,plan);}catch(error){if(!['DELETION_PLAN_HISTORY','DELETION_PUBLICATION_HISTORY','DELETION_JOB_HISTORY','DELETION_PHOTO_HISTORY','DELETION_SALE_HISTORY','DELETION_SUPPLIER_HISTORY','DELETION_RESERVATION_HISTORY'].includes(error.code))throw error;history=true;}
 if(!history&&!isPlanArchived(db,id)){guard();commit(engine,{plans:db.plans.filter(row=>row!==plan)},'已删除无业务记录的销售计划：'+String(plan.name||plan.sku));return {deleted:true,id};}
 const jobs=archiveSafety(db,plan);guard();if(isPlanArchived(db,id))return {deleted:true,id,archived:true};
 const at=new Date().toISOString(),queued=new Set(jobs.filter(job=>job.state==='queued').map(job=>job.id));
 commit(engine,{plans:db.plans.map(row=>row===plan?{...row,enabled:false,status:'paused',updatedAt:at}:row),jobs:db.jobs.map(job=>queued.has(job.id)?{...job,state:'cancelled',retryAt:null,blockedReason:'PLAN_ARCHIVED',error:'计划已删除并归档，未提交任务已取消；原任务编号与去重记录保留',updatedAt:at}:job),planArchives:[...(db.planArchives||[]),{planId:id,archivedAt:at}]},'已删除并归档销售计划，原任务与照片历史保留：'+String(plan.name||plan.sku));return {deleted:true,id,archived:true};
});}
function restorePlan(engine,id){return run(engine,id,(db,guard)=>{
 const plan=one(db.plans,id,'销售计划');if(!isPlanArchived(db,id))fail('PLAN_NOT_ARCHIVED','这个计划不在已删除记录中，请刷新后核对');archiveSafety(db,plan);guard();
 commit(engine,{plans:db.plans.map(row=>row===plan?{...row,enabled:false,status:'paused',updatedAt:new Date().toISOString()}:row),planArchives:db.planArchives.filter(row=>row.planId!==id)},'已恢复销售计划，保持停用且未重新排队：'+String(plan.name||plan.sku));return {restored:true,id};
});}
function deleteLocalProduct(engine,id){return run(engine,id,(db,guard)=>{
 if(db.products.some(row=>row?.id===id))fail('DELETION_SUPPLIER_PRODUCT','货盘商品由货盘同步管理，不能在这里删除；这里只删除未使用的手动商品');
 const product=one(db.localProducts,id,'手动商品'),templates=db.productListings.filter(row=>row?.productId===id);localProductDTO(product);
 if(templates.length>1||templates.some(row=>row.sku!==product.sku))fail('DELETION_PRODUCT_MISMATCH','商品资料的 SKU 或唯一性已改变，请先核对原记录');
 productWithoutHistory(db,product);guard();
 commit(engine,{localProducts:db.localProducts.filter(row=>row!==product),productListings:db.productListings.filter(row=>row.productId!==id)},'已删除未使用的手动商品：'+product.name);return {deleted:true,id};
});}
module.exports={deletePlan,deleteLocalProduct,restorePlan,restorePlanArchives,isPlanArchived,archivedPlanError};
