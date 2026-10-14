'use strict';
const ACCOUNT_OBSERVATION_MAX_AGE_MS=300000;
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
function profileManagerStatus({account=null,bound=null,observation=null,windowOpen=false,vintedPage=false,ai=null,activeCommerce=false,activeAborted=false,hasDraft=false,plans=[],jobs=[],schedulerRunning=false,unavailable=false,now=Date.now()}={}){
 const checkedAt=stamp(account?.identity?.verifiedAt)||stamp(bound?.verifiedAt),age=now-Date.parse(observation?.checkedAt),expected=bound?.memberId||account?.identity?.memberId;
 const login=(state,label,detail,extra={})=>({state,label,detail,checkedAt,stale:checkedAt!==null,...extra});
 let vintedStatus;
 if(unavailable)vintedStatus=login('unavailable','状态不可读取','运营记录暂不可读取，原文件已保留；请在账号与运营中检查。');
 else if(account?.identity&&bound&&account.identity.memberId!==bound.memberId)vintedStatus=login('error','账号需核对','账号身份记录不一致，请在账号中心核对原绑定。');
 else if(account?.status==='logging_in')vintedStatus=login('checking','正在登录核验','专用登录步骤正在执行，尚未确认当前登录身份。');
 else if(account?.lastResult?.code==='CHALLENGE_REQUIRED')vintedStatus=login('challenge','需要手动验证','网页要求验证码或其他验证，请在固定环境中手动接管。');
 else if(account?.status==='awaiting_user')vintedStatus=login('awaiting_user','需要核对登录','上次登录结果尚未确认，请在账号中心核对；不会自动重复提交。');
 else if(account?.status==='error')vintedStatus=login('error','登录未完成','上次登录核验未完成，请在固定环境中检查。');
 else if(account?.status==='saved')vintedStatus=login('saved','已保存 · 未核验','保存账号资料或密码不代表网页已登录，请打开账号中心核验。');
 else if(windowOpen&&vintedPage&&expected&&observation?.verified===true&&observation.memberId===expected&&typeof observation.documentKey==='string'&&observation.documentKey&&Number.isFinite(age)&&age>=0&&age<ACCOUNT_OBSERVATION_MAX_AGE_MS)vintedStatus=login('verified_recent','近期已核验','最近五分钟收到当前窗口的一致账号菜单证据；登录可能随后改变，执行任务前仍需核验。',{checkedAt:stamp(observation.checkedAt),stale:false});
 else if(checkedAt)vintedStatus=login('verified_history','曾核验 · 待复核','这是历史核验记录，不能据此认定当前网页仍已登录。');
 else if(account||bound)vintedStatus=login('saved','已保存 · 未核验','当前没有可用的网页身份核验记录，请在账号中心核对。');
 else vintedStatus=login('unbound','未绑定账号','此环境尚未保存或核验 Vinted 账号。');
 const run=(state,label,detail,source=null)=>({state,label,detail,source});let automationStatus;
 if(ai?.running===true){
  if(ai.status==='approval')automationStatus=run('approval','等待确认','AI 正在等待操作确认。','ai');
  else if(['paused','pausing'].includes(ai.status))automationStatus=run('paused',ai.status==='pausing'?'正在暂停':'AI 已暂停','AI 任务已保留，当前不继续执行页面操作。','ai');
  else if(ai.status==='stopping')automationStatus=run('stopping','正在停止','AI 正在取消当前步骤。','ai');
  else automationStatus=run('running','AI 运行中','此环境的 AI 任务正在运行。','ai');
 }else if(activeCommerce)automationStatus=run(activeAborted?'stopping':'running',activeAborted?'运营停止中':'运营任务执行中','此环境当前持有运营任务执行权。','commerce');
 else if(hasDraft)automationStatus=run('running','页面操作中','此环境正在执行专用页面操作。','browser');
 else if(jobs.some(job=>['uncertain','needs_review'].includes(job.state)))automationStatus=run('review_required','任务待核对','此环境有结果不明或需要人工检查的运营任务。','commerce');
 else if(ai?.status==='error'||ai?.status==='blocked'||ai?.status==='limit')automationStatus=run(ai.status==='error'?'error':'review_required',ai.status==='error'?'AI 执行出错':'AI 任务待核对','上次 AI 任务已结束，请在对应环境查看结果。','ai');
 else if(plans.some(plan=>plan.enabled===true))automationStatus=run(schedulerRunning?'waiting':'paused',schedulerRunning?'等待调度':'运营已暂停',schedulerRunning?'此环境有启用计划，当前尚未执行任务。':'此环境有启用计划，后台调度尚未运行。','commerce');
 else automationStatus=run(windowOpen?'idle':'closed',windowOpen?'未运行':'窗口未打开','此环境当前没有正在运行的自动化任务。');
 return {vintedStatus,automationStatus};
}
module.exports={profileManagerStatus,ACCOUNT_OBSERVATION_MAX_AGE_MS};
