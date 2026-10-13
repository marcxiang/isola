'use strict';
const DEFAULTS={maxAttemptsPerChallenge:2,maxAttemptsPerNavigation:32,maxChallenges:128};
function host(value){return typeof value==='string'?value.replace(/^\[|\]$/g,'').toLowerCase():'';}
function requestURL(value){
 if(typeof value!=='string'||value.length>16384)return null;
 try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;url.hash='';return url.href;}catch{return null;}
}
// Electron 41 login supplies a URL, not a request id or firstAuthAttempt flag.
// Concurrent identical URL/realm challenges therefore deliberately share a cap.
class ProxyAuthGuard{
 #proxy;#limits;#attempts=new Map();#total=0;#generation=0;#disposed=false;
 constructor(proxy,limits={}){
  this.#limits={...DEFAULTS,...limits};for(const key of Object.keys(DEFAULTS))if(!Number.isInteger(this.#limits[key])||this.#limits[key]<1||this.#limits[key]>1024)throw Error('Proxy authentication limit is invalid');
  this.#proxy={type:proxy?.type,host:host(proxy?.host),port:Number(proxy?.port),username:typeof proxy?.username==='string'?proxy.username:'',password:typeof proxy?.password==='string'?proxy.password:''};
 }
 get generation(){return this.#generation;}
 beginNavigation(){if(this.#disposed)return this.#generation;this.#generation++;this.#attempts.clear();this.#total=0;return this.#generation;}
 credentials(details,auth){
  const proxy=this.#proxy,url=requestURL(details?.url);
  if(this.#disposed||!url||!['http','https'].includes(proxy.type)||!proxy.username||!proxy.host||!Number.isInteger(proxy.port)||proxy.port<1||proxy.port>65535||auth?.isProxy!==true||host(auth.host)!==proxy.host||Number(auth.port)!==proxy.port)return null;
  if(typeof auth.scheme!=='string'||!auth.scheme||auth.scheme.length>32||/[\x00-\x20\x7f]/.test(auth.scheme)||typeof auth.realm!=='string'||auth.realm.length>512||/[\x00-\x1f\x7f]/.test(auth.realm))return null;
  const key=JSON.stringify([url,auth.scheme.toLowerCase(),auth.realm]),previous=this.#attempts.get(key);
  if(this.#total>=this.#limits.maxAttemptsPerNavigation||(previous?.count||0)>=this.#limits.maxAttemptsPerChallenge||!previous&&this.#attempts.size>=this.#limits.maxChallenges)return null;
  this.#attempts.set(key,{url,count:(previous?.count||0)+1});this.#total++;
  return {username:proxy.username,password:proxy.password};
 }
 completed({url,statusCode,generation=this.#generation}={}){
  // Only the successful URL releases its outstanding attempts. This bounds a
  // stream of failed/rotating realms without exhausting long-lived healthy tabs.
  if(this.#disposed||generation!==this.#generation||!Number.isInteger(statusCode)||statusCode<200||statusCode>=400)return false;
  const normalized=requestURL(url);if(!normalized)return false;let cleared=false;
  for(const [key,attempt] of this.#attempts)if(attempt.url===normalized){this.#attempts.delete(key);this.#total-=attempt.count;cleared=true;}
  return cleared;
 }
 dispose(){this.#disposed=true;this.#attempts.clear();this.#proxy={};this.#total=0;}
}
module.exports={ProxyAuthGuard};
