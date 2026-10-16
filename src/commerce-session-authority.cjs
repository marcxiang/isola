'use strict';

const issued=new WeakSet();
const KIND='environment-session';
// This is a main-process capability, never an IPC option. It authorizes the
// selected isolated environment's current session, not a verified member ID.
function isEnvironmentSessionAccount(value,profileId=value?.profileId){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===2&&value.kind===KIND&&typeof value.profileId==='string'&&value.profileId.trim()===value.profileId&&value.profileId.length>0&&value.profileId.length<=256&&!/[\x00-\x1f\x7f]/.test(value.profileId)&&value.profileId===profileId;
}
function createEnvironmentSessionAuthority(profileId){
 const authority=Object.freeze({kind:KIND,profileId});
 if(!isEnvironmentSessionAccount(authority,profileId))throw Object.assign(Error('自动化环境编号无效'),{code:'PUBLICATION_SESSION_INVALID'});
 issued.add(authority);return authority;
}
function assertEnvironmentSessionAuthority(value,profileId){
 if(!isEnvironmentSessionAccount(value,profileId)||!issued.has(value))throw Object.assign(Error('刊登会话授权必须来自当前主进程的固定自动化环境'),{code:'PUBLICATION_SESSION_UNTRUSTED'});
 return value;
}
module.exports={isEnvironmentSessionAccount,createEnvironmentSessionAuthority,assertEnvironmentSessionAuthority};
