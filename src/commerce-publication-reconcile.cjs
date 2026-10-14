'use strict';

const {createHash}=require('node:crypto');
const {restorePublicationState}=require('./vinted-publication.cjs');
const {validateSupplierSyncRecord}=require('./commerce-supplier-outbox.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const withoutTime=value=>{const next={...value};delete next.observedAt;return next;};
function ensure(ok,message,code='PUBLICATION_PROJECTION_CONFLICT'){if(!ok)throw Object.assign(Error(message),{code});}
function one(rows,predicate,label){const found=rows.filter(predicate);ensure(found.length===1,label+'缺失或不唯一');return found[0];}
function validURL(value,id){try{const url=new URL(value);return url.origin==='https://www.vinted.fr'&&!url.username&&!url.password&&!url.search&&!url.hash&&new RegExp('^/items/'+id+'(?:-[^/]+)?/?$').test(url.pathname);}catch{return false;}}

// Main-process journal persistence projection. This is NOT a receipt validator
// or an IPC endpoint: only pass the next snapshot emitted by the owned journal
// after its real-page receipt validation. It stages one full engine snapshot;
// the caller must fsync that whole snapshot once before exposing success.
// No supplier request, browser action, timer, disk write or count increment runs.
function projectPublicationReconciliation(db,nextPublications,{now=Date.now(),activeLeases=[]}={}){
 ensure(db&&typeof db==='object'&&['plans','claims','jobs','marketAccounts'].every(key=>Array.isArray(db[key])),'运营数据库缺少刊登关联记录');
 ensure(Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000,'刊登关联时钟无效');
 // Validation is read-only here: do not apply startup recovery to an actively
 // preparing/dispatching journal snapshot.
 restorePublicationState(nextPublications,{now});
 const previous=db.publications||{version:1,submissions:[]};restorePublicationState(previous,{now});
 const staged=clone(db),next=clone(nextPublications),at=new Date(now).toISOString(),reconciledSubmissionIds=[],completedJobIds=[];
 staged.publications=next;
 if(staged.publicationSupplierSync===undefined)staged.publicationSupplierSync=[];
 ensure(Array.isArray(staged.publicationSupplierSync),'货盘上架关联记录无效');
 ensure(staged.publicationSupplierSync.every(row=>typeof row?.id==='string'&&row.id&&typeof row.claimId==='string'&&staged.claims.filter(claim=>claim.id===row.claimId).length===1)&&new Set(staged.publicationSupplierSync.map(row=>row.id)).size===staged.publicationSupplierSync.length,'货盘上架关联编号、照片领取或唯一性无效');
 for(const old of previous.submissions){
  const current=one(next.submissions,row=>row.id===old.id,'原刊登提交记录');
  ensure(current.proof.fingerprint===old.proof.fingerprint&&current.attemptCount>=old.attemptCount,'原刊登证据或提交次数被改变');
  if(old.receipt)ensure(current.state==='published'&&current.receipt&&same(withoutTime(current.receipt),withoutTime(old.receipt)),'原刊登回执不能删除或更换');
  if(old.closedSale)ensure(same(current.closedSale,old.closedSale),'原成交关闭记录不能被更换');
 }
 for(const record of next.submissions.filter(row=>row.state==='published')){
  const old=one(previous.submissions,row=>row.id===record.id,'原已提交记录'),facts=record.proof.facts,receipt=record.receipt;
  ensure(['dispatching','uncertain','published'].includes(old.state)&&old.attemptCount===1,'不能从未提交记录关联平台刊登');
  ensure(next.submissions.filter(row=>row.receipt?.listingId===receipt.listingId).length===1,'平台刊登编号关联了多个提交');
  const plan=one(staged.plans,row=>row.id===facts.planId,'销售计划'),account=one(staged.marketAccounts,row=>row.profileId===facts.profileId,'平台账号绑定'),claim=one(staged.claims,row=>row.id===facts.photos.claimId,'照片领取记录');
  ensure(plan.profileId===facts.profileId&&plan.productId===facts.productId&&plan.sku===facts.sku,'原计划的账号、商品或 SKU 已改变');
  ensure(account.memberId===facts.account.memberId&&account.profileURL===facts.account.profileURL,'原计划绑定的当前账号已改变');
  ensure(claim.profileId===facts.profileId&&claim.productId===facts.productId&&claim.setId===facts.photos.setId&&Array.isArray(claim.images)&&claim.images.length===facts.photos.count&&Array.isArray(claim.listings),'照片领取身份、套组或数量与原提交不一致');
  const links=staged.claims.flatMap(owner=>(Array.isArray(owner.listings)?owner.listings:[]).filter(link=>String(link.listingId)===receipt.listingId).map(link=>({owner,link})));
  ensure(links.length<=1&&links.every(({owner,link})=>owner===claim&&validURL(link.url,receipt.listingId)&&(!link.submissionId||link.submissionId===record.id)&&(!link.planId||link.planId===facts.planId)&&(link.cycle===undefined||link.cycle===facts.cycle)),'原刊登链接已关联其他照片、计划或周期');
  if(record.closedSale){
   // Sale closure requires its own full-engine transaction (sales, fulfillment
   // job and count). This publication-only projection cannot perform half of it.
   ensure(old.closedSale&&same(record.closedSale,old.closedSale)&&links.length===1,'成交关闭必须由独立的完整成交事务提交','PUBLICATION_SALE_PROJECTION_REQUIRED');
   continue;
  }
  ensure(plan.completedCount===facts.cycle&&Number.isSafeInteger(plan.targetCount)&&plan.targetCount>facts.cycle,'原刊登销售周期已经改变');
  ensure(plan.currency===facts.currency&&plan.listingPriceCents===facts.fields.priceCents,'原刊登币种或价格已经改变');
  for(const key of Object.keys(facts.fields).filter(key=>key!=='priceCents'))ensure(same(plan.listing?.[key],facts.fields[key]),'原刊登内容已经改变：'+key);
  ensure(!plan.activeListingId||plan.activeListingId===receipt.listingId,'原计划已有另一条在售刊登');
  ensure(staged.plans.every(other=>other===plan||other.activeListingId!==receipt.listingId),'原刊登已经被另一销售计划占用');
  if(!links.length)claim.listings.push({listingId:receipt.listingId,url:receipt.url,createdAt:receipt.observedAt,submissionId:record.id,planId:facts.planId,cycle:facts.cycle});
  const linked=claim.listings.find(link=>String(link.listingId)===receipt.listingId);
  if(!linked.submissionId)Object.assign(linked,{submissionId:record.id,planId:facts.planId,cycle:facts.cycle});
  if(plan.activeListingId!==receipt.listingId||plan.status!=='listed'){plan.activeListingId=receipt.listingId;plan.status='listed';plan.updatedAt=at;}
  // Keep enabled=false if paused: recording a real result never resumes a plan.
  const jobs=staged.jobs.filter(job=>job.type==='listing'&&job.planId===facts.planId&&job.payload?.cycle===facts.cycle);
  ensure(jobs.length<=1,'原刊登周期存在多个任务');
  for(const job of jobs){
   ensure(job.profileId===facts.profileId&&job.productId===facts.productId&&job.dedupeKey==='listing:'+facts.planId+':'+facts.cycle&&staged.jobs.filter(other=>other.id===job.id||other.dedupeKey===job.dedupeKey).length===1&&(!job.payload.claimId||job.payload.claimId===claim.id)&&(!job.accountMemberId||job.accountMemberId===facts.account.memberId),'原刊登任务身份不一致');
   ensure(job.operation==null&&job.mutationPending===false,'原刊登任务已有业务请求，需先核对，不能覆盖');
   const result={externalId:receipt.listingId,submissionId:record.id,verified:true,summary:'实际刊登回执已核对；货盘上架关联另行核对'};
   if(job.state==='completed'){ensure(job.step==='publication_reconciled'&&same(job.result,result),'原完成任务与本次刊登回执不同');continue;}
   const leased=job.state==='running'&&Array.isArray(activeLeases)&&activeLeases.filter(lease=>lease.profileId===facts.profileId&&lease.jobId===job.id).length===1;
   ensure((['queued','needs_review','cancelled','rejected'].includes(job.state)||leased)&&job.result==null,'原刊登任务状态不能自动覆盖');
   Object.assign(job,{state:'completed',step:'publication_reconciled',result,error:'',retryAt:null,updatedAt:at,accountMemberId:facts.account.memberId});completedJobIds.push(job.id);
  }
  // Existing engine.listing marks a claim only on its first listing. Do not
  // invent success or send another mark for a reused set. This outbox records
  // the initial request, or an explicit review when older history has no sync
  // receipt. A future worker must persist its request intent before any I/O.
  const syncs=staged.publicationSupplierSync.filter(row=>row.claimId===claim.id);
  const first=claim.listings[0],firstRecord=next.submissions.find(row=>row.receipt?.listingId===String(first.listingId)&&row.proof.facts.photos.claimId===claim.id);
  ensure(/^[1-9]\d{0,29}$/.test(String(first.listingId))&&validURL(first.url,String(first.listingId)),'照片领取的首次刊登地址无法核对');
  const payload={action:'published',platform:'Vinted',listingId:String(first.listingId),listingUrl:first.url};
  const id='mark-listed-'+createHash('sha256').update(JSON.stringify([claim.id,String(first.listingId)])).digest('hex');
  const initialSync=syncs.find(row=>row.id===id);
  if(initialSync){
   const sync=initialSync;ensure(sync.kind==='mark_listed'&&sync.submissionId===(firstRecord?.id||null)&&sync.profileId===facts.profileId&&sync.productId===facts.productId&&same(sync.payload,payload),'原货盘上架关联的身份或请求与原记录不同');
   try{validateSupplierSyncRecord(sync);}catch{ensure(false,'原货盘上架关联请求或结果尚需独立核对');}
   ensure(!sync.receipt||sync.receipt.setId===claim.setId,'货盘上架关联回执不属于原照片套组');
  }else{
   const pending=!!firstRecord&&!syncs.length;
   staged.publicationSupplierSync.push({id,kind:'mark_listed',claimId:claim.id,profileId:facts.profileId,productId:facts.productId,submissionId:firstRecord?.id||null,state:pending?'pending':'needs_review',attemptCount:0,operation:null,receipt:null,payload,createdAt:at,updatedAt:at,reason:pending?'平台刊登已核对；货盘上架关联尚未发送':'该照片领取已有其他刊登或关联历史，首次货盘关联状态需核对'});
  }
  reconciledSubmissionIds.push(record.id);
 }
 // Reused photos may carry older per-listing rows. Validate and retain those
 // rows independently; only the first listing above can create a new request.
 // This also covers fully closed publications, which skip active projection.
 const activeClaims=new Set();
 for(const sync of staged.publicationSupplierSync){
  try{validateSupplierSyncRecord(sync);}catch{ensure(false,'货盘上架关联历史的请求或回执无效');}
  const claim=one(staged.claims,row=>row.id===sync.claimId,'货盘关联的原照片领取');
  ensure(sync.profileId===claim.profileId&&sync.productId===claim.productId&&Array.isArray(claim.listings),'货盘上架关联历史不属于原环境或商品');
  const linked=one(claim.listings,row=>String(row.listingId)===sync.payload.listingId,'货盘关联的原刊登历史');
  ensure(linked.url===sync.payload.listingUrl,'货盘关联历史的原刊登链接不同');
  const records=next.submissions.filter(row=>row.receipt?.listingId===sync.payload.listingId&&row.proof.facts.photos.claimId===claim.id);
  ensure(records.length<=1&&sync.submissionId===(records[0]?.id||null)&&(!linked.submissionId||linked.submissionId===sync.submissionId),'货盘关联历史与原刊登提交不一致');
  ensure(!sync.receipt||sync.receipt.setId===claim.setId,'货盘关联历史的回执不属于原照片套组');
  if(['pending','dispatching','uncertain'].includes(sync.state)){ensure(!activeClaims.has(sync.claimId),'同一照片领取存在多个未完成的货盘关联请求');activeClaims.add(sync.claimId);}
 }
 return {db:staged,changed:!same(staged,db),reconciledSubmissionIds,completedJobIds,pendingSupplierSyncIds:staged.publicationSupplierSync.filter(row=>row.state!=='synced').map(row=>row.id)};
}

module.exports={projectPublicationReconciliation};
