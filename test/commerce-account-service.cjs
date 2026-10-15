'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CommerceAccountService}=require('../src/commerce-account-service.cjs');
const observed={verified:true,memberId:'123',username:'fixture_seller',profileURL:'https://www.vinted.fr/member/123',documentKey:'fixture-document'};
function fixture(){
 let account={id:'account-1',login:'fixture@example.invalid',profileId:'profile-1',hasPassword:true,identity:null,lastResult:{code:'SAVED'}},credentialReads=0,loginCalls=0,verifyCalls=0;
 const engine={db:{marketAccounts:[]},accountObservations:new Map(),configure:async work=>work(new AbortController().signal,()=>{}),emit(){},bindMarketAccount(profileId,value){assert.equal(value.verified,true);this.db.marketAccounts=[{...value,profileId}];account.identity={...value};account.lastResult={code:'LOGIN_VERIFIED'};}};
 const store={get:id=>{if(id!==account.id)throw Error('missing');return structuredClone(account);},save:input=>{account={...account,...input};return structuredClone(account);},remove:()=>{},markResult:(_id,result)=>{account.status=result.status;account.lastResult={...result,message:'固定安全状态'};},withCredentials:async(_id,work)=>{credentialReads++;return work({login:account.login,password:'fixture-secret'});}};
 const login={login:async(_id,input)=>{loginCalls++;assert.equal(input.password,'fixture-secret');return {status:'logged_in',verified:true,account:observed,submitted:true};},verify:async()=>{verifyCalls++;return {status:'logged_in',verified:true,account:observed,submitted:false};}};
 const service=new CommerceAccountService({engine,store,openPage:async()=>{},login});
 return {service,engine,store,login,get account(){return account;},get credentialReads(){return credentialReads;},get loginCalls(){return loginCalls;},get verifyCalls(){return verifyCalls;}};
}
test('account login decrypts only inside trusted callback and commits observed identity without returning secrets',async()=>{
 const f=fixture(),out=await f.service.login('account-1');assert.equal(f.credentialReads,1);assert.equal(f.loginCalls,1);assert.equal(out.result.verified,true);assert.equal(out.result.submitted,true);assert.equal(f.engine.db.marketAccounts[0].memberId,'123');assert.doesNotMatch(JSON.stringify(out),/fixture-secret|password/);
});
test('an unknown submission is persisted and the next click verifies rather than submitting again',async()=>{
 const f=fixture();f.login.login=async()=>{throw Error('fixture-secret upstream error');};const out=await f.service.login('account-1');assert.equal(out.result.code,'LOGIN_OUTCOME_UNKNOWN');assert.doesNotMatch(JSON.stringify(out),/fixture-secret|upstream/);assert.equal(f.credentialReads,1);
 await f.service.login('account-1');assert.equal(f.credentialReads,1);assert.equal(f.verifyCalls,1);
});
test('challenge responses never become verified or unlock account observations',async()=>{
 const f=fixture();f.engine.accountObservations.set('profile-1',observed);f.login.login=async()=>({status:'awaiting_user',code:'CHALLENGE_REQUIRED',submitted:true,message:'fixture-secret'});
 const out=await f.service.login('account-1');assert.equal(out.result.verified,false);assert.equal(out.account.lastResult.code,'CHALLENGE_REQUIRED');assert.equal(f.engine.db.marketAccounts.length,0);assert.equal(f.engine.accountObservations.size,0);assert.doesNotMatch(JSON.stringify(out),/fixture-secret/);
});
test('account lock rejects duplicate login clicks while preserving one credential operation',async()=>{
 const f=fixture();let release;f.login.login=async()=>{await new Promise(resolve=>release=resolve);return {status:'logged_in',verified:true,account:observed};};const first=f.service.login('account-1');await new Promise(setImmediate);
 await assert.rejects(f.service.login('account-1'),{code:'ACCOUNT_BUSY'});release();await first;assert.equal(f.credentialReads,1);assert.equal(f.service.isBusy('account-1'),false);
});
test('manual verification uses explicit confirmation without decrypting any password',async()=>{
 const f=fixture();f.login.verify=async(_id,input)=>{assert.equal(input.confirmCurrent,true);assert.equal(input.login,'fixture@example.invalid');assert.equal(Object.hasOwn(input,'password'),false);return {status:'logged_in',verified:true,account:observed};};await f.service.verify('account-1',{confirmCurrent:true});assert.equal(f.credentialReads,0);assert.equal(f.engine.db.marketAccounts[0].memberId,'123');
});
test('previous account identity is passed to the login service and contradictory bindings block before decryption',async()=>{
 const f=fixture();f.engine.db.marketAccounts=[{profileId:'profile-1',memberId:'456'}];f.account.identity={memberId:'123'};await assert.rejects(f.service.login('account-1'),{code:'ACCOUNT_CHANGED'});assert.equal(f.credentialReads,0);
});
test('only a complete stored account or engine binding supplies the mobile expected-account context',async()=>{
 for(const source of ['account','engine','partial-account']){
  const f=fixture(),binding={memberId:'123',profileURL:'https://www.vinted.fr/member/123',username:'fixture_seller'};
  if(source==='account')f.account.identity={...binding};else f.engine.db.marketAccounts=[{profileId:'profile-1',...binding}];if(source==='partial-account')f.account.identity={memberId:'123'};
  let reads=0;f.login.verify=async(_id,input)=>{reads++;assert.equal(input.expectedMemberId,'123');assert.deepEqual(input.expectedAccount,{profileId:'profile-1',...binding});assert.equal(Object.isFrozen(input.expectedAccount),true);assert.equal(input.login,'fixture@example.invalid');assert.equal(Object.hasOwn(input,'password'),false);return {status:'logged_in',verified:true,account:observed};};
  await f.service.verify('account-1');assert.equal(reads,1);assert.equal(f.credentialReads,0);
 }
 const first=fixture();first.login.verify=async(_id,input)=>{assert.equal(Object.hasOwn(input,'expectedAccount'),false);assert.equal(input.expectedMemberId,undefined);assert.equal(input.confirmCurrent,true);return {status:'awaiting_user',code:'ACCOUNT_UNVERIFIED'};};const out=await first.service.verify('account-1',{confirmCurrent:true});assert.equal(out.result.verified,false);assert.equal(first.account.identity,null);
});
test('pending mobile verification forwards its prior binding without decrypting or repeating the unknown submission',async()=>{
 const f=fixture(),binding={memberId:'123',profileURL:'https://www.vinted.fr/member/123',username:'fixture_seller'};f.account.identity={...binding};f.account.lastResult={code:'LOGIN_OUTCOME_UNKNOWN'};
 f.login.verify=async(_id,input)=>{assert.deepEqual(input.expectedAccount,{profileId:'profile-1',...binding});return {status:'awaiting_user',code:'ACCOUNT_UNVERIFIED',submitted:false};};
 const out=await f.service.login('account-1');assert.equal(out.result.verified,false);assert.equal(out.result.submitted,true);assert.equal(out.result.code,'IDENTITY_UNVERIFIED');assert.equal(f.credentialReads,0);assert.equal(f.loginCalls,0);
});
test('corrupt saved mobile URLs or usernames are rejected before credential access',async()=>{
 for(const change of [{profileURL:'https://www.vinted.fr/member/456'},{username:'   '}]){const f=fixture();f.account.identity={memberId:'123',profileURL:'https://www.vinted.fr/member/123',username:'fixture_seller',...change};await assert.rejects(f.service.login('account-1'),{code:'ACCOUNT_CHANGED'});assert.equal(f.credentialReads,0);assert.equal(f.loginCalls,0);}
});
function candidateFixture(){
 const f=fixture(),calls=[],candidate={kind:'own-profile-candidate',verified:false,profileId:'profile-1',tabId:'review-tab',documentKey:'review-document',memberId:'123',profileURL:'https://www.vinted.fr/member/123',expiresAt:Date.now()+30000,consistentReads:2};let verifies=0;
 f.service.openPage=async(profileId,input)=>{calls.push({name:'open',fresh:input.freshAccountReview===true,ownProfileURL:input.ownProfileURL});return {profileId,url:input.ownProfileURL||'https://www.vinted.fr/',tabId:'review-tab'};};
 f.login.verify=async(_id,input)=>{calls.push({name:'verify',expectedMemberId:input.expectedMemberId,expectedAccount:input.expectedAccount,confirmCurrent:input.confirmCurrent,closeAccountMenu:input.closeAccountMenu});return ++verifies===1?{status:'awaiting_user',code:'ACCOUNT_UNVERIFIED'}:{status:'logged_in',verified:true,account:{...observed,usernameSource:'own-profile-heading'}};};
 f.login.inspectOwnProfileLink=async()=>{calls.push({name:'candidate'});return candidate;};f.login.validateOwnProfileLink=async(_id,value)=>{assert.equal(value,candidate);calls.push({name:'validate'});return true;};return Object.assign(f,{calls,candidate});
}
test('explicit first mobile review navigates only a validated candidate then obtains a separate full profile identity',async()=>{
 const f=candidateFixture(),out=await f.service.verify('account-1',{confirmCurrent:true});assert.equal(out.result.verified,true);assert.equal(f.engine.db.marketAccounts[0].memberId,'123');assert.deepEqual(f.calls.map(row=>row.name),['open','verify','open','candidate','validate','open','verify']);assert.equal(f.calls[2].fresh,true);assert.equal(f.calls[5].ownProfileURL,f.candidate.profileURL);assert.ok(f.calls.filter(row=>row.name==='verify').every(row=>row.expectedMemberId===undefined&&row.expectedAccount===undefined&&row.confirmCurrent===true&&row.closeAccountMenu===true));assert.equal(f.credentialReads,0);
});
test('repeated operator checks require menu closure each time and an unclosed result cannot replace the last trusted binding',async()=>{
 const f=fixture(),requests=[];f.account.identity={memberId:'123',profileURL:observed.profileURL,username:observed.username};f.engine.db.marketAccounts=[{profileId:'profile-1',...f.account.identity}];
 f.login.verify=async(_id,input)=>{requests.push(input);assert.equal(input.closeAccountMenu,true);assert.equal(input.expectedAccount.memberId,'123');return requests.length===2?{status:'awaiting_user',code:'ACCOUNT_UNVERIFIED',verified:false}:{status:'logged_in',verified:true,account:observed};};
 const first=await f.service.verify('account-1',{confirmCurrent:true,closeAccountMenu:false});assert.equal(first.result.verified,true);
 const failed=await f.service.verify('account-1',{confirmCurrent:true});assert.equal(failed.result.verified,false);assert.equal(failed.result.code,'IDENTITY_UNVERIFIED');assert.equal(f.engine.db.marketAccounts[0].memberId,'123');assert.equal(f.account.identity.memberId,'123');assert.equal(f.engine.accountObservations.size,0);
 const third=await f.service.verify('account-1',{confirmCurrent:true});assert.equal(third.result.verified,true);assert.equal(requests.length,3);assert.equal(f.credentialReads,0);assert.equal(f.loginCalls,0);
});
test('a profile candidate cannot replace first confirmation or an existing trusted member binding',async()=>{
 const first=candidateFixture(),out=await first.service.verify('account-1',{confirmCurrent:false});assert.equal(out.result.verified,false);assert.equal(first.calls.some(row=>row.name==='candidate'),false);
 const bound=candidateFixture();bound.engine.db.marketAccounts=[{profileId:'profile-1',memberId:'123',profileURL:observed.profileURL,username:observed.username}];await bound.service.verify('account-1',{confirmCurrent:true});assert.equal(bound.calls.some(row=>row.name==='candidate'),false);
});
test('expired, changed or unvalidated profile candidates never navigate or bind another account',async()=>{
 for(const change of ['expired','validation','different-account']){
  const f=candidateFixture();if(change==='expired')f.candidate.expiresAt=Date.now()-1;if(change==='validation')f.login.validateOwnProfileLink=async()=>{throw Object.assign(Error('stale'),{code:'ACCOUNT_CHANGED'});};if(change==='different-account'){let reads=0;f.login.verify=async()=>++reads===1?{status:'awaiting_user',code:'ACCOUNT_UNVERIFIED'}:{status:'logged_in',verified:true,account:{...observed,memberId:'456',profileURL:'https://www.vinted.fr/member/456'}};}
  const out=await f.service.verify('account-1',{confirmCurrent:true});assert.equal(out.result.verified,false);assert.equal(f.engine.db.marketAccounts.length,0);if(change!=='different-account')assert.equal(f.calls.some(row=>row.ownProfileURL),false);assert.equal(f.credentialReads,0);
 }
});
test('raw provider failures and unknown codes never reach IPC results',async()=>{
 const f=fixture();f.login.verify=async()=>{const e=Error('fixture-secret');e.code='fixture-secret';throw e;};const out=await f.service.verify('account-1');assert.equal(out.result.code,'UNAVAILABLE');assert.doesNotMatch(JSON.stringify(out),/fixture-secret/);
 f.engine.configure=async()=>{throw Error('fixture-secret');};await assert.rejects(f.service.open('account-1'),error=>error.code==='ACCOUNT_UNAVAILABLE'&&!error.message.includes('fixture-secret'));
});
test('a readable account receipt does not override email confirmation or an identity mismatch',async()=>{
 for(const code of ['ACCOUNT_CONFIRMATION_REQUIRED','ACCOUNT_MISMATCH']){const f=fixture();f.login.login=async()=>({status:code==='ACCOUNT_MISMATCH'?'error':'awaiting_user',verified:false,code,account:observed});const out=await f.service.login('account-1');assert.equal(out.result.verified,false);assert.equal(f.engine.db.marketAccounts.length,0);assert.equal(f.account.identity,null);assert.equal(out.result.code,code==='ACCOUNT_MISMATCH'?'ACCOUNT_CHANGED':code);}
});
test('every unverified submitted result retains a read-before-retry latch even with generic or stopped codes',async()=>{
 for(const code of ['UNAVAILABLE','STOPPED','INVALID_CREDENTIALS','LOGIN_FAILED','ACCOUNT_MISMATCH','UNKNOWN_PROVIDER_CODE']){const f=fixture();f.login.login=async()=>({status:'error',verified:false,code,submitted:true});const out=await f.service.login('account-1');assert.equal(out.result.code,'LOGIN_OUTCOME_UNKNOWN');await f.service.login('account-1');assert.equal(f.credentialReads,1);assert.equal(f.verifyCalls,1);}
});
test('anonymous homepage gets one official email-form navigation before any submission, while missing passwords use verification only',async()=>{
 const f=fixture(),opens=[];f.service.openPage=async(_id,options)=>{opens.push(options.freshLogin===true);return {url:options.freshLogin?'https://www.vinted.fr/member/login/email':'https://www.vinted.fr/'};};let calls=0;f.login.login=async()=>++calls===1?{status:'awaiting_user',code:'LOGIN_FORM_REQUIRED',submitted:false}:{status:'logged_in',verified:true,account:observed,submitted:true};
 await f.service.login('account-1');assert.deepEqual(opens,[false,true]);assert.equal(calls,2);assert.equal(f.credentialReads,1);
 const noPassword=fixture();noPassword.account.hasPassword=false;await noPassword.service.login('account-1');assert.equal(noPassword.credentialReads,0);assert.equal(noPassword.verifyCalls,1);
});
test('a failed manual verification cannot erase the previous unknown submission latch',async()=>{
 for(const reject of [false,true]){const f=fixture();let loginCalls=0;f.login.login=async()=>{loginCalls++;return {status:'awaiting_user',code:'LOGIN_RESULT_UNKNOWN',submitted:true};};f.login.verify=async()=>{if(reject){const e=Error('provider detail');e.code='WINDOW_CLOSED';throw e;}return {status:'error',code:'WINDOW_CLOSED',submitted:false,verified:false};};
  await f.service.login('account-1');assert.equal(f.account.lastResult.code,'LOGIN_OUTCOME_UNKNOWN');await f.service.verify('account-1',{confirmCurrent:true});assert.equal(f.account.lastResult.code,'LOGIN_OUTCOME_UNKNOWN');await f.service.login('account-1');assert.equal(loginCalls,1);assert.equal(f.credentialReads,1);
 }
});
