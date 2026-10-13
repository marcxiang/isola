'use strict';
const {readPreparedPhotos}=require('./commerce-photos.cjs');
const {VintedPublicationEvidence}=require('./vinted-publication-evidence.cjs');

// Only a plan ID crosses IPC. Page proofs, supplier claims and private file
// manifests are assembled here and never accepted from the renderer.
async function publicationInput(engine,id,signal,guard){
 if(typeof id!=='string'||!id||id.length>256)throw Error('刊登计划编号无效');
 if(engine.faulted)throw Error('运营存储不可用，已停止刊登核对');
 const plan=engine.plan(id),expectedAccount=engine.db.marketAccounts.find(account=>account.profileId===plan.profileId);
 if(!expectedAccount)throw Error('请先核对该环境的 Vinted 账号');
 const prepared=await readPreparedPhotos(engine,id);guard();
 if(!prepared.summary?.ready||!prepared.manifest)throw Error('请先准备本计划的照片，并完成当前页面上传');
 const manifest=prepared.manifest,claims=engine.db.claims.filter(claim=>claim.id===manifest.claimId&&claim.profileId===plan.profileId&&claim.productId===plan.productId);
 if(claims.length!==1)throw Error('照片领取与当前计划无法唯一关联，已停止刊登核对');
 const product=await engine.product(plan,engine.client(),signal);guard();
 return {plan,product,claim:claims[0],expectedAccount,manifest};
}
function inspectPublication(engine,id){
 return engine.configure(async(signal,guard)=>{
  let report;
  try{const input=await publicationInput(engine,id,signal,guard);guard();report=await new VintedPublicationEvidence(engine.adapter).inspect(input,{signal});guard();}
  catch(error){guard();report={planId:id,checkedAt:new Date().toISOString(),checks:[{name:'发布准备',ok:false,detail:String(error.message||'无法核对').slice(0,700)}],blockers:[String(error.message||'无法核对').slice(0,700)],readyForPublication:false,publicationEnabled:false,message:'发布前核对未通过；没有保存草稿或发布商品。'};}
  return {...report,published:false,saved:false};
 });
}
module.exports={inspectPublication,publicationInput};
