'use strict';

const fail=(code,message)=>Object.assign(Error(message),{code});
const validId=value=>typeof value==='string'&&/^[1-9]\d{0,24}$/.test(value);
const {isEnvironmentSessionAccount}=require('./commerce-session-authority.cjs');

// Credentials and profile names are never identity evidence. These records
// originate in earlier native owner reads or the original business journal.
function accountExpectation(engine,profileId){
 const db=engine.db,market=(db.marketAccounts||[]).filter(row=>row.profileId===profileId),vault=engine.accounts?.list?.()||[],saved=vault.filter(row=>row.profileId===profileId&&row.identity),identities=[];
 if(market.length>1||saved.length>1)throw fail('ACCOUNT_CONFLICT','该环境存在多个账号绑定，已保留原记录');
 const add=value=>{
  if(!value||!validId(value.memberId)||value.profileURL!==undefined&&value.profileURL!=='https://www.vinted.fr/member/'+value.memberId)throw fail('ACCOUNT_CONFLICT','原账号身份记录不完整或冲突，不能自动换绑');
  identities.push(value);
 };
 for(const row of market)add(row);for(const row of saved)add(row.identity);
 const plans=(db.plans||[]).filter(row=>row.profileId===profileId),planIds=new Set(plans.map(row=>row.id)),jobs=(db.jobs||[]).filter(row=>row.profileId===profileId||planIds.has(row.planId));
 for(const job of jobs){if(job.accountMemberId!==undefined)add({memberId:job.accountMemberId});if(['message','offer','fulfillment','sale_confirmation'].includes(job.type)&&job.payload?.verified===true&&job.payload.memberId!==undefined)add({memberId:job.payload.memberId});}
 const publications=(db.publications?.submissions||[]).filter(row=>row.proof?.facts?.profileId===profileId);
 const sessionPlans=new Set(publications.filter(row=>isEnvironmentSessionAccount(row.proof.facts.account,profileId)).map(row=>row.proof.facts.planId));
 for(const row of publications)if(!isEnvironmentSessionAccount(row.proof.facts.account,profileId))add(row.proof.facts.account);
 const sales=(db.sales||[]).filter(row=>row.profileId===profileId||planIds.has(row.planId)||jobs.some(job=>job.id===row.jobId));
 for(const sale of sales)if(sale.memberId!==undefined)add({memberId:sale.memberId});
 const ids=new Set(identities.map(row=>row.memberId));if(ids.size>1)throw fail('ACCOUNT_CHANGED','该环境原任务与账号身份不一致，不能自动更换原账号');
 const memberId=identities[0]?.memberId||null;
 if(memberId&&((db.marketAccounts||[]).some(row=>row.profileId!==profileId&&row.memberId===memberId)||vault.some(row=>row.profileId!==profileId&&row.identity?.memberId===memberId)))throw fail('ACCOUNT_CONFLICT','该 Vinted 账号已绑定其他环境，请使用原来的固定环境');
 const usedClaims=(db.claims||[]).some(row=>(row.profileId===profileId||row.listings?.some(link=>planIds.has(link.planId)))&&Array.isArray(row.listings)&&row.listings.some(link=>!sessionPlans.has(link.planId)));
 const businessHistory=publications.some(row=>!isEnvironmentSessionAccount(row.proof.facts.account,profileId))||sales.length>0||usedClaims||plans.some(plan=>!sessionPlans.has(plan.id)&&(!!plan.activeListingId||plan.completedCount>0))||jobs.some(job=>!(job.type==='listing'&&(sessionPlans.has(job.planId)||isEnvironmentSessionAccount(job.publicationAccount,profileId)))&&(job.state==='completed'||job.operation!=null||job.result!=null||job.mutationPending!==false));
 if(!memberId&&businessHistory)throw fail('ACCOUNT_HISTORY_UNBOUND','原业务记录缺少可核对的账号身份，已保留原记录；请恢复原账号绑定后继续');
 const named=identities.find(row=>typeof row.username==='string'&&row.username.trim()===row.username&&row.username.length>0&&row.username.length<=100&&!/[\x00-\x1f\x7f]/.test(row.username));
 return {memberId,account:memberId&&named?{memberId,profileURL:'https://www.vinted.fr/member/'+memberId,username:named.username}:null};
}
module.exports={accountExpectation};
