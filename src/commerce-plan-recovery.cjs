'use strict';
const {listingJobKey,listingRevision,isPublicationOpen}=require('./vinted-publication.cjs');
const retryStates=new Set(['needs_review','cancelled','rejected']);
const beforeSubmission=new Set(['pending','open_environment','check_catalog','prepare_photos','prepare_listing','upload_photos','draft_reply','check_offer','download_label','check_stock_price','wms_checkout']);
const types=new Set(['listing','message','offer','fulfillment','sale_confirmation']);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

function noCurrentPublication(plan,db){
 if(!object(db.publications)||db.publications.version!==1||!Array.isArray(db.publications.submissions))return false;
 const seen=new Set();let revision;try{revision=listingRevision(plan.listingRevision);}catch{return false;}
 for(const row of db.publications.submissions){
  const facts=row?.proof?.facts;
  if(!object(row)||typeof row.id!=='string'||!row.id||seen.has(row.id)||!object(facts)||typeof facts.planId!=='string'||!facts.planId)return false;seen.add(row.id);
  if(facts.planId!==plan.id)continue;
  // An omitted revision is the journal's canonical legacy revision zero.
  // Missing/invalid cycles and invalid revisions are never evidence of absence.
  if(!Number.isSafeInteger(facts.cycle)||facts.cycle<0||facts.cycle>=1000)return false;
  let originalRevision;try{originalRevision=listingRevision(facts.listingRevision);}catch{return false;}
  if(facts.cycle>plan.completedCount||originalRevision>revision)return false;
  if(facts.cycle===plan.completedCount&&originalRevision===revision)return false;
 }
 return true;
}

function latePreSubmit(job,plan,db,{sessionListing}){
 if(job.type!=='listing'||!noCurrentPublication(plan,db))return false;
 if(job.step==='check_optional_fields')return true;
 // This error may also occur after journal preparation or dispatch. Only a
 // session driver with no record at all for this cycle/revision can resume it;
 // cancelled/closed/zero-attempt records still forbid this exception.
 return job.step==='publish_listing'&&sessionListing===true&&job.state==='needs_review'&&job.blockedReason==='PUBLICATION_EVIDENCE_BLOCKED';
}

// Reuse the original job only. Absence of a result is insufficient once a job
// reached a publish/send/order step, or when its persisted binding is ambiguous.
function recoverableJob(job,plan,db,{allowQueued=false,sessionListing=false}={}){
 if(!object(job)||!object(plan)||!types.has(job.type)||!(retryStates.has(job.state)||allowQueued&&job.state==='queued')||!(beforeSubmission.has(job.step)||latePreSubmit(job,plan,db,{sessionListing}))||job.operation!=null||job.mutationPending!==false||job.result!=null)return false;
 if(typeof job.id!=='string'||!job.id||typeof job.dedupeKey!=='string'||!job.dedupeKey||!object(job.payload)||job.planId!==plan.id||job.profileId!==plan.profileId||job.productId!==plan.productId)return false;
 if(!Array.isArray(db.jobs)||db.jobs.filter(row=>row.id===job.id||row.dedupeKey===job.dedupeKey).length!==1||!Array.isArray(db.plans)||db.plans.filter(row=>row.id===plan.id).length!==1||(db.planArchives||[]).some(row=>row.planId===plan.id))return false;
 if(job.sku!==undefined&&job.sku!==plan.sku||job.source!==undefined&&job.source!==(plan.source||'supplier')||job.payload.sku!==undefined&&job.payload.sku!==plan.sku||job.payload.profileId!==undefined&&job.payload.profileId!==plan.profileId||job.payload.productId!==undefined&&job.payload.productId!==plan.productId)return false;
 if(job.accountMemberId!==undefined&&!(sessionListing===true&&job.type==='listing')){const accounts=(db.marketAccounts||[]).filter(row=>row.profileId===plan.profileId);if(accounts.length!==1||job.accountMemberId!==accounts[0].memberId)return false;}
 if(job.payload.claimId!==undefined){const claims=(db.claims||[]).filter(row=>row.id===job.payload.claimId);if(claims.length!==1||claims[0].profileId!==plan.profileId||claims[0].productId!==plan.productId||(plan.source==='local')!==(claims[0].source==='local'))return false;}
 if(job.type==='listing'){
  if(plan.activeListingId||!Number.isSafeInteger(plan.completedCount)||plan.completedCount<0||plan.completedCount>=plan.targetCount||job.payload.cycle!==plan.completedCount||(db.publications?.submissions||[]).some(row=>row.proof?.facts?.planId===plan.id&&isPublicationOpen(row)))return false;
  try{if(listingRevision(job.payload.listingRevision)!==listingRevision(plan.listingRevision)||job.dedupeKey!==listingJobKey(plan.id,plan.completedCount,plan.listingRevision))return false;}catch{return false;}
 }
 return true;
}
function retryPatch(){return {state:'queued',step:'pending',error:'',attempts:0,retryAt:null,blockedReason:null,updatedAt:new Date().toISOString()};}
function restoreRow(row,before){for(const key of Object.keys(row))if(!Object.hasOwn(before,key))delete row[key];Object.assign(row,before);}
module.exports={recoverableJob,retryPatch,restoreRow};
