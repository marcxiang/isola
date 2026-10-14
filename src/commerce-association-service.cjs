'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {VintedListingReceipt}=require('./vinted-listing-receipt.cjs');
const {operatorReviewedEvidence,isPublicationOpen,listingRevision}=require('./vinted-publication.cjs');
const {publicationJournal}=require('./vinted-publish-submit.cjs');
const TTL=120000;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
function ensure(ok,message){if(!ok)throw Error(message);}
// Capabilities live only in this main process. They expire on restart, are
// consumed before I/O, and never contain renderer-supplied page assertions.
function createAssociationService({readerFactory=adapter=>new VintedListingReceipt(adapter),now=Date.now}={}){
 const reviews=new WeakMap();
 function input(engine,id){
  ensure(typeof id==='string'&&id.length>0&&id.length<=256,'刊登计划编号无效');
  ensure(!engine.faulted&&!engine.closing,'运营存储不可用');
  const plan=engine.plan(id),records=engine.db.publications.submissions.filter(row=>row.proof.facts.planId===id&&isPublicationOpen(row));
  ensure(records.length===1&&records[0].state==='uncertain'&&records[0].attemptCount===1,'仅能关联原先已提交且结果待核对的刊登');
  const expectedAccount=engine.db.marketAccounts.find(row=>row.profileId===plan.profileId);
  ensure(expectedAccount&&plan.profileId===records[0].proof.facts.profileId&&plan.completedCount===records[0].proof.facts.cycle&&listingRevision(plan.listingRevision)===listingRevision(records[0].proof.facts.listingRevision),'原计划与账号绑定不一致');
  return {plan,record:records[0],expectedAccount};
 }
 function fingerprint(value){return hash({plan:value.plan,record:value.record,account:value.expectedAccount});}
 function pageFingerprint(result){const {observedAt,...evidence}=result.evidence;return hash({evidence,binding:result.binding});}
 return {
  inspect(engine,id){return engine.configure(async(signal,guard)=>{
   reviews.delete(engine);const current=input(engine,id),saved=clone(current),signature=fingerprint(saved);
   const result=await readerFactory(engine.adapter).collect(saved,{signal});guard();
   ensure(fingerprint(input(engine,id))===signature,'读取期间原计划或提交已改变，请重新核对');
   const report={...result.summary,planId:id,submissionId:saved.record.id,readyForAssociation:false};
   if(result.evidence&&result.summary.verified&&result.summary.photoSignatureMatched&&result.binding?.documentKey&&result.binding?.tabId){
    const token=randomUUID(),expiresAt=now()+TTL;
    reviews.set(engine,{token,expiresAt,signature,page:pageFingerprint(result),submissionId:saved.record.id});
    Object.assign(report,{reviewToken:token,expiresAt:new Date(expiresAt).toISOString(),readyForAssociation:true,message:'请确认这是原提交的商品。确认时将重新读取并保存操作员核对来源。'});
   }
   return report;
  });},
  associate(engine,id,token){return engine.configure(async(signal,guard)=>{
   const review=reviews.get(engine);reviews.delete(engine);
   ensure(typeof token==='string'&&token.length<=256&&review&&token===review.token&&now()<review.expiresAt,'核对凭证无效或已过期，请重新读取商品');
   const current=input(engine,id);ensure(fingerprint(current)===review.signature&&current.record.id===review.submissionId,'计划、账号或原提交已改变，请重新核对');
   let associated;
   const result=await readerFactory(engine.adapter).collect(clone(current),{signal,withEvidence:async(fresh,pageGuard)=>{
    const finalGuard=()=>{guard();pageGuard();ensure(now()<review.expiresAt,'核对凭证已过期');ensure(fingerprint(input(engine,id))===review.signature,'保存前原计划或提交已改变');};
    finalGuard();ensure(fresh.summary.verified&&fresh.summary.photoSignatureMatched&&pageFingerprint(fresh)===review.page,'商品、账号、照片或页面已改变，请重新读取');
    const evidence=operatorReviewedEvidence(current.record,fresh.evidence,{reviewId:review.token,...fresh.binding},now());
    // Reader retains the tab/controller lock until the journal and full engine
    // snapshot have durably committed. Nothing is published or sent here.
    const record=await publicationJournal(engine).reconcile(current.record.id,evidence,{guard:finalGuard});
    associated={associated:true,listingId:record.receipt.listingId,url:record.receipt.url,submissionId:record.id};
    return fresh;
   }});
   ensure(associated,result?.summary?.blockers?.join('；')||'详情核对或关联保存失败，请重新读取原记录');
   return associated;
  });}
 };
}
module.exports={createAssociationService};
