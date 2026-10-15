'use strict';

// These operations remove unused local metadata only. External listings,
// supplier claims and the private photo files are never deleted here.
const {localProductDTO}=require('./commerce-local-products.cjs');
const {listingRevision}=require('./vinted-publication.cjs');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
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
 const plan=one(db.plans,id,'销售计划');planWithoutHistory(db,plan);guard();
 commit(engine,{plans:db.plans.filter(row=>row!==plan)},'已删除无业务记录的销售计划：'+String(plan.name||plan.sku));return {deleted:true,id};
});}
function deleteLocalProduct(engine,id){return run(engine,id,(db,guard)=>{
 if(db.products.some(row=>row?.id===id))fail('DELETION_SUPPLIER_PRODUCT','货盘商品由货盘同步管理，不能在这里删除；这里只删除未使用的手动商品');
 const product=one(db.localProducts,id,'手动商品'),templates=db.productListings.filter(row=>row?.productId===id);localProductDTO(product);
 if(templates.length>1||templates.some(row=>row.sku!==product.sku))fail('DELETION_PRODUCT_MISMATCH','商品资料的 SKU 或唯一性已改变，请先核对原记录');
 productWithoutHistory(db,product);guard();
 commit(engine,{localProducts:db.localProducts.filter(row=>row!==product),productListings:db.productListings.filter(row=>row.productId!==id)},'已删除未使用的手动商品：'+product.name);return {deleted:true,id};
});}
module.exports={deletePlan,deleteLocalProduct};
