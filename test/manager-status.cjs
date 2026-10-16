'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {profileManagerStatus,ACCOUNT_OBSERVATION_MAX_AGE_MS}=require('../src/manager-status.cjs');
const now=Date.parse('2026-10-14T12:00:00.000Z'),identity={memberId:'123',verifiedAt:new Date(now-1000).toISOString()},bound={...identity,username:'private-member',login:'private-login@example.test'},observation={memberId:'123',verified:true,documentKey:'private-document',checkedAt:identity.verifiedAt};
test('saved credentials and historical identity never imply a current login',()=>{
 for(const account of [{status:'saved',hasPassword:true,password:'private-secret'},{status:'saved',identity,hasPassword:true}]){const out=profileManagerStatus({account,bound,observation,windowOpen:true,vintedPage:true,now});assert.equal(out.vintedStatus.state,'saved');assert.notEqual(out.vintedStatus.state,'verified_recent');}
 assert.equal(profileManagerStatus({account:{status:'logged_in',identity},now}).vintedStatus.state,'verified_history');assert.equal(profileManagerStatus({now}).vintedStatus.state,'unbound');
});
test('recent verification requires matching live evidence and expires without extending its timestamp',()=>{
 const good={account:{status:'logged_in',identity},bound,observation,windowOpen:true,vintedPage:true,now};const out=profileManagerStatus(good);assert.equal(out.vintedStatus.state,'verified_recent');assert.equal(out.vintedStatus.stale,false);assert.equal(out.vintedStatus.checkedAt,observation.checkedAt);
 for(const change of [{windowOpen:false},{vintedPage:false},{observation:{...observation,memberId:'999'}},{observation:{...observation,documentKey:''}},{observation:{...observation,checkedAt:new Date(now+1).toISOString()}},{now:Date.parse(observation.checkedAt)+ACCOUNT_OBSERVATION_MAX_AGE_MS}]){const stale=profileManagerStatus({...good,...change});assert.equal(stale.vintedStatus.state,'verified_history');assert.equal(stale.vintedStatus.stale,true);}
});
test('challenge, unknown result, account conflict and unavailable storage override a historical verification',()=>{
 for(const [input,expected] of [[{account:{status:'awaiting_user',identity,lastResult:{code:'CHALLENGE_REQUIRED'}}},'challenge'],[{account:{status:'awaiting_user',identity}},'awaiting_user'],[{account:{status:'logging_in',identity}},'checking'],[{account:{status:'error',identity}},'error'],[{account:{status:'logged_in',identity:{...identity,memberId:'999'}}},'error'],[{unavailable:true},'unavailable']])assert.equal(profileManagerStatus({bound,observation,windowOpen:true,vintedPage:true,now,...input}).vintedStatus.state,expected);
});
test('automation running requires this profile actual ownership and does not copy another profile global activity',()=>{
 assert.equal(profileManagerStatus({schedulerRunning:true,windowOpen:true,now}).automationStatus.state,'idle');assert.equal(profileManagerStatus({schedulerRunning:true,plans:[{enabled:true}],windowOpen:true,now}).automationStatus.state,'waiting');assert.equal(profileManagerStatus({schedulerRunning:false,plans:[{enabled:true}],now}).automationStatus.state,'paused');
 assert.deepEqual(profileManagerStatus({activeCommerce:true,now}).automationStatus,{state:'running',label:'运营任务执行中',detail:'此环境当前持有运营任务执行权。',source:'commerce'});assert.equal(profileManagerStatus({activeCommerce:true,activeAborted:true,now}).automationStatus.state,'stopping');assert.equal(profileManagerStatus({hasDraft:true,now}).automationStatus.source,'browser');assert.equal(profileManagerStatus({jobs:[{state:'uncertain'}],now}).automationStatus.state,'review_required');
});
test('AI waiting, paused, stopping and ended results are projected without task content or approval payloads',()=>{
 for(const [status,expected] of [['reading','running'],['approval','approval'],['paused','paused'],['pausing','paused'],['stopping','stopping']]){const out=profileManagerStatus({ai:{running:true,status,goal:'private-ai-goal',approval:{message:'private-approval'},logs:['private-log']},now});assert.equal(out.automationStatus.state,expected);assert.equal(out.automationStatus.source,'ai');assert.doesNotMatch(JSON.stringify(out),/private-/);}
 assert.equal(profileManagerStatus({ai:{running:false,status:'complete'},windowOpen:true,now}).automationStatus.state,'idle');assert.equal(profileManagerStatus({ai:{running:false,status:'error'},now}).automationStatus.state,'error');
});
test('manager status DTO contains only fixed display fields, timestamps and enums',()=>{
 const out=profileManagerStatus({account:{status:'logged_in',identity,login:'private-login',password:'private-password',encryptedPassword:'private-ciphertext'},bound,observation,windowOpen:true,vintedPage:true,activeCommerce:true,jobs:[{state:'running',payload:{secret:'private-payload'}}],now});assert.doesNotMatch(JSON.stringify(out),/private-|memberId|login|password|documentKey|payload/);assert.deepEqual(Object.keys(out.vintedStatus),['state','label','detail','checkedAt','stale']);assert.deepEqual(Object.keys(out.automationStatus),['state','label','detail','source']);
});
