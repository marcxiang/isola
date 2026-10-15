'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CommerceAccountService}=require('../src/commerce-account-service.cjs');
const {accountNeedsLoginReview}=require('../src/commerce-accounts.cjs');
const observed={verified:true,memberId:'123',username:'fixture_seller',profileURL:'https://www.vinted.fr/member/123',documentKey:'fixture-document'};
function fixture(){
 let account={id:'account-1',login:'fixture@example.invalid',profileId:'profile-1',hasPassword:true,identity:null,lastResult:{code:'SAVED'}},credentialReads=0,loginCalls=0,verifyCalls=0;
 const engine={db:{marketAccounts:[]},accountObservations:new Map(),configure:async work=>work(new AbortController().signal,()=>{}),emit(){},bindMarketAccount(profileId,value){assert.equal(value.verified,true);this.db.marketAccounts=[{...value,profileId}];account.identity={...value};account.lastResult={code:'LOGIN_VERIFIED'};account.status='logged_in';account.loginReviewPending=false;}};
 const store={get:id=>{if(id!==account.id)throw Error('missing');return structuredClone(account);},save:input=>{account={...account,...input};return structuredClone(account);},remove:()=>{},markResult:(_id,result)=>{account.loginReviewPending=accountNeedsLoginReview(account)||result.loginReviewPending===true||accountNeedsLoginReview({status:result.status,lastResult:result});account.status=result.status;account.lastResult={...result,message:'固定安全状态'};},withCredentials:async(_id,work)=>{credentialReads++;return work({login:account.login,password:'fixture-secret'});}};
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
 const out=await f.service.login('account-1');assert.equal(out.result.verified,false);assert.equal(out.result.submitted,false);assert.equal(out.result.loginReviewPending,true);assert.equal(out.result.code,'IDENTITY_UNVERIFIED');assert.equal(f.credentialReads,0);assert.equal(f.loginCalls,0);
});
test('corrupt saved mobile URLs or usernames are rejected before credential access',async()=>{
 for(const change of [{profileURL:'https://www.vinted.fr/member/456'},{username:'   '}]){const f=fixture();f.account.identity={memberId:'123',profileURL:'https://www.vinted.fr/member/123',username:'fixture_seller',...change};await assert.rejects(f.service.login('account-1'),{code:'ACCOUNT_CHANGED'});assert.equal(f.credentialReads,0);assert.equal(f.loginCalls,0);}
});
function candidateFixture(){
 const f=fixture(),calls=[],candidate={kind:'own-profile-candidate',verified:false,profileId:'profile-1',tabId:'review-tab',documentKey:'review-document',memberId:'123',profileURL:'https://www.vinted.fr/member/123',profileHref:'https://www.vinted.fr/member/123-fixture',expiresAt:Date.now()+30000,consistentReads:2};let verifies=0;
 f.service.openPage=async(profileId,input)=>{calls.push({name:'open',fresh:input.freshAccountReview===true,ownProfileURL:input.ownProfileURL,ownProfileHref:input.ownProfileHref});if(input.ownProfileURL){assert.equal(input.ownProfileHref,candidate.profileHref);await input.clickOwnProfile({signal:input.signal});}return {profileId,url:input.ownProfileURL||'https://www.vinted.fr/',actualURL:input.ownProfileHref,tabId:'review-tab'};};
 f.login.verify=async(_id,input)=>{calls.push({name:'verify',expectedMemberId:input.expectedMemberId,expectedAccount:input.expectedAccount,confirmCurrent:input.confirmCurrent,closeAccountMenu:input.closeAccountMenu,requireOwnProfileClick:input.requireOwnProfileClick,requireOwnProfileHeading:input.requireOwnProfileHeading});return ++verifies===1?{status:'awaiting_user',code:'ACCOUNT_UNVERIFIED'}:{status:'logged_in',verified:true,account:{...observed,usernameSource:'own-profile-heading'}};};
 f.login.inspectOwnProfileLink=async()=>{calls.push({name:'candidate'});return candidate;};f.login.clickOwnProfileLink=async(_id,value)=>{assert.equal(value,candidate);calls.push({name:'click'});return {profileId:'profile-1',tabId:'review-tab',url:candidate.profileHref};};return Object.assign(f,{calls,candidate});
}
test('explicit first mobile review navigates only a validated candidate then obtains a separate full profile identity',async()=>{
 const f=candidateFixture(),out=await f.service.verify('account-1',{confirmCurrent:true});assert.equal(out.result.verified,true);assert.equal(f.engine.db.marketAccounts[0].memberId,'123');assert.deepEqual(f.calls.map(row=>row.name),['open','verify','open','candidate','open','click','verify']);assert.equal(f.calls[2].fresh,true);assert.equal(f.calls[4].ownProfileURL,f.candidate.profileURL);const reads=f.calls.filter(row=>row.name==='verify');assert.ok(reads.every(row=>row.expectedMemberId===undefined&&row.expectedAccount===undefined&&row.confirmCurrent===true&&row.closeAccountMenu===true));assert.equal(reads[0].requireOwnProfileClick,true);assert.equal(reads[1].requireOwnProfileClick,undefined);assert.equal(reads[1].requireOwnProfileHeading,true);assert.equal(f.credentialReads,0);
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
test('bound phone checks also require confirmed native Profil navigation and reject another candidate before clicking',async()=>{
 for(const confirmed of [false,true]){
  const f=candidateFixture();f.account.identity={memberId:'123',username:observed.username,profileURL:observed.profileURL};f.engine.db.marketAccounts=[{profileId:'profile-1',...f.account.identity}];f.login.verify=async(_id,input)=>{assert.equal(input.expectedMemberId,'123');assert.equal(input.closeAccountMenu,true);return input.requireOwnProfileClick?{status:'awaiting_user',code:'PROFILE_REVIEW_REQUIRED',verified:false}:{status:'logged_in',verified:true,account:observed};};
  const out=await f.service.verify('account-1',{confirmCurrent:confirmed});assert.equal(out.result.verified,confirmed);assert.equal(f.calls.filter(row=>row.name==='click').length,confirmed?1:0);assert.equal(f.calls.some(row=>row.name==='candidate'),confirmed);assert.equal(f.credentialReads,0);
 }
 const changed=candidateFixture();changed.account.identity={memberId:'123',username:observed.username,profileURL:observed.profileURL};changed.candidate.memberId='456';changed.candidate.profileURL='https://www.vinted.fr/member/456';changed.candidate.profileHref=changed.candidate.profileURL;changed.login.verify=async()=>({status:'awaiting_user',code:'PROFILE_REVIEW_REQUIRED'});const out=await changed.service.verify('account-1',{confirmCurrent:true});assert.equal(out.result.verified,false);assert.equal(out.result.code,'ACCOUNT_CHANGED');assert.equal(changed.calls.some(row=>row.name==='click'),false);assert.equal(changed.account.identity.memberId,'123');
});
test('expired, changed or unvalidated profile candidates never navigate or bind another account',async()=>{
 for(const change of ['expired','validation','different-account']){
  const f=candidateFixture();if(change==='expired')f.candidate.expiresAt=Date.now()-1;if(change==='validation')f.login.clickOwnProfileLink=async()=>{throw Object.assign(Error('stale'),{code:'ACCOUNT_CHANGED'});};if(change==='different-account'){let reads=0;f.login.verify=async()=>++reads===1?{status:'awaiting_user',code:'ACCOUNT_UNVERIFIED'}:{status:'logged_in',verified:true,account:{...observed,memberId:'456',profileURL:'https://www.vinted.fr/member/456'}};}
  const out=await f.service.verify('account-1',{confirmCurrent:true});assert.equal(out.result.verified,false);assert.equal(f.engine.db.marketAccounts.length,0);if(change==='expired')assert.equal(f.calls.some(row=>row.ownProfileURL),false);assert.equal(f.credentialReads,0);
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
  await f.service.login('account-1');assert.equal(f.account.lastResult.code,'LOGIN_OUTCOME_UNKNOWN');const checked=await f.service.verify('account-1',{confirmCurrent:true});assert.equal(f.account.lastResult.code,'WINDOW_CLOSED');assert.equal(checked.result.submitted,false);assert.equal(checked.result.loginReviewPending,true);await f.service.login('account-1');assert.equal(loginCalls,1);assert.equal(f.credentialReads,1);
 }
});
test('initial account-window failures replace the stale interruption message while retaining the login review latch',async()=>{
 const f=fixture();f.account.lastResult={code:'LOGIN_OUTCOME_UNKNOWN'};f.service.openPage=async()=>{throw Object.assign(Error('private provider detail'),{code:'ACCOUNT_UNAVAILABLE'});};
 const out=await f.service.verify('account-1',{confirmCurrent:true});assert.equal(out.result.verified,false);assert.equal(out.result.code,'UNAVAILABLE');assert.equal(out.result.submitted,false);assert.equal(out.result.loginReviewPending,true);assert.equal(f.account.lastResult.code,'UNAVAILABLE');assert.equal(f.credentialReads,0);assert.equal(f.verifyCalls,0);assert.doesNotMatch(JSON.stringify(out),/private provider detail/);
 f.service.openPage=async()=>{};f.login.verify=async()=>({status:'awaiting_user',code:'STOPPED',submitted:false});const stopped=await f.service.login('account-1');assert.equal(stopped.result.code,'STOPPED');assert.equal(stopped.result.loginReviewPending,true);assert.equal(f.credentialReads,0);assert.equal(f.loginCalls,0);
});

test('ordinary account saves bypass the global scheduler configuration lock but keep same-account operation exclusion',async()=>{
 const f=fixture();let saves=0;const save=f.store.save;f.store.save=input=>{saves++;return save(input);};f.engine.running=true;f.engine.ticking=true;f.engine.configure=async()=>{throw Error('Global configuration must not run');};
 const result=await f.service.save({id:'account-1',label:'Editable while another environment runs',login:'changed-email@example.invalid'});assert.equal(result.account.login,'changed-email@example.invalid');assert.equal(saves,1);f.service.pending.add('another-account');await f.service.save({id:'account-1',label:'Other account is pending'});assert.equal(saves,2);f.service.pending.add('account-1');await assert.rejects(f.service.save({id:'account-1',label:'Cannot race own verification'}),{code:'ACCOUNT_BUSY'});assert.equal(saves,2);f.service.pending.delete('account-1');f.store.isBusy=()=>true;await assert.rejects(f.service.save({id:'account-1',password:'must-not-save'}),{code:'ACCOUNT_BUSY'});assert.equal(saves,2);assert.equal(f.credentialReads,0);assert.equal(f.loginCalls,0);
});

test('deleting local credentials preserves consistent complete operational identity and every original business row',async()=>{
 const f=fixture(),at=new Date().toISOString(),binding={profileId:'profile-1',platform:'vinted-fr',memberId:'123',username:observed.username,profileURL:observed.profileURL,verifiedAt:at};f.account.identity={memberId:binding.memberId,username:binding.username,profileURL:binding.profileURL,verifiedAt:at};
 Object.assign(f.engine.db,{marketAccounts:[binding],plans:[{id:'original-plan',profileId:'profile-1',enabled:true,activeListingId:'98765'}],jobs:[{id:'original-job',planId:'original-plan',state:'uncertain',mutationPending:true}],claims:[{id:'original-claim',profileId:'profile-1'}],publications:{submissions:[{id:'original-publication',state:'uncertain',proof:{facts:{profileId:'profile-1',planId:'original-plan'}}}]},sales:[],reservations:[{jobId:'original-job',cents:500}]});const original=structuredClone(f.engine.db);let removed=0;f.store.remove=id=>{assert.equal(id,'account-1');removed++;};f.engine.running=true;f.engine.configure=async()=>{throw Error('Global configuration must not run');};
 const result=await f.service.remove('account-1');assert.equal(removed,1);assert.match(result.message,/本机登录资料已删除.*运营账号绑定.*任务历史.*窗口登录保持/);assert.deepEqual(f.engine.db,original);assert.equal(f.credentialReads,0);assert.equal(f.loginCalls,0);
});

test('credential deletion refuses a missing or conflicting operational identity before touching the vault',async()=>{
 for(const kind of ['vault-only history','different member','incomplete binding','duplicate binding']){
  const f=fixture();let removed=0;f.store.remove=()=>{removed++;};f.engine.db.plans=[{id:'original-plan',profileId:'profile-1'}];const binding={profileId:'profile-1',platform:'vinted-fr',memberId:'123',username:observed.username,profileURL:observed.profileURL,verifiedAt:new Date().toISOString()};if(kind!=='unbound history')f.account.identity={...binding};if(!['vault-only history','unbound history'].includes(kind))f.engine.db.marketAccounts=[{...binding}];if(kind==='different member')f.account.identity={...binding,memberId:'456',profileURL:'https://www.vinted.fr/member/456'};if(kind==='incomplete binding')delete f.engine.db.marketAccounts[0].username;if(kind==='duplicate binding')f.engine.db.marketAccounts.push({...binding});const before=structuredClone(f.engine.db);
  await assert.rejects(f.service.remove('account-1'),{code:['vault-only history','unbound history'].includes(kind)?'ACCOUNT_BINDING_REQUIRED':'ACCOUNT_CHANGED'});assert.equal(removed,0);assert.deepEqual(f.engine.db,before);assert.equal(f.credentialReads,0);
 }
});

test('indirect business history protects a vault-only verified identity but never traps an unverified credential draft',async()=>{
 for(const identity of [null,{memberId:'123',username:observed.username,profileURL:observed.profileURL}])for(const key of ['sales','reservations','localPhotoPreparations','publicationSupplierSync','publications']){const f=fixture();f.account.identity=identity;let removed=0;f.store.remove=()=>{removed++;};if(key==='publications')f.engine.db.publications={submissions:[{proof:{facts:{profileId:'profile-1'}}}]};else f.engine.db[key]=[{profileId:'profile-1'}];const before=structuredClone(f.engine.db);if(identity)await assert.rejects(f.service.remove('account-1'),{code:'ACCOUNT_BINDING_REQUIRED'});else await f.service.remove('account-1');assert.equal(removed,identity?0:1);assert.deepEqual(f.engine.db,before);}
});

test('an unverified real vault account with an existing plan can remove local credentials without first completing verification',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{AccountsStore}=require('../src/commerce-accounts.cjs'),{CommerceEngine}=require('../src/commerce-engine.cjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isola-unverified-account-removal-')),profiles=[{id:'unverified-profile',name:'Fixture environment',status:'closed',windowType:'automation'}],options={dir,profiles:()=>profiles,seal:value=>'fixture:'+Buffer.from(value).toString('base64'),unseal:value=>Buffer.from(value.slice(8),'base64').toString('utf8')},store=new AccountsStore(options),account=store.save({label:'Unverified local credentials',login:'unverified@example.invalid',password:'fixture-only-password',profileId:profiles[0].id}),engineOptions={...options,accounts:store,adapter:{readiness:()=>({})},clientFactory:()=>{throw Error('No supplier call is authorized');}},engine=new CommerceEngine(engineOptions);
 t.after(async()=>{engine.running=false;await engine.close();const absolute=path.resolve(dir);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.ok(path.basename(absolute).startsWith('isola-unverified-account-removal-'));fs.rmSync(absolute,{recursive:true,force:true});});
 engine.db.products=[{id:'unverified-product',sku:'UNVERIFIED-SKU',name:'Fixture accessory',stock:1,priceCents:500,photoSetsAvailable:1}];const plan=engine.savePlan({profileId:profiles[0].id,productId:'unverified-product',listingPriceCents:500,minOfferCents:500,targetCount:1,enabled:false}),job=engine.enqueue('listing',plan,{cycle:0,listingRevision:0},'listing:'+plan.id+':0');Object.assign(job,{state:'needs_review',step:'check_catalog',error:'Original account has not been verified'});engine.persist();profiles[0].status='running';engine.running=true;
 const service=new CommerceAccountService({engine,store,openPage:async()=>{assert.fail('Deleting credentials must not open a page');},login:{verify:async()=>{assert.fail('Deleting unverified credentials must not demand a login verification');}}}),before=structuredClone(engine.db),disk=fs.readFileSync(engine.file,'utf8');assert.equal(store.get(account.id).identity,null);assert.deepEqual(engine.db.marketAccounts,[]);const result=await service.remove(account.id);assert.match(result.message,/本机登录资料已删除/);assert.deepEqual(store.list(),[]);assert.deepEqual(engine.db,before);assert.equal(fs.readFileSync(engine.file,'utf8'),disk);assert.equal(profiles[0].status,'running');assert.equal(engine.db.jobs[0].state,'needs_review');assert.equal(engine.db.jobs[0].id,job.id);assert.deepEqual(new AccountsStore(options).list(),[]);
 engine.running=false;await engine.close();const reopened=new CommerceEngine({...engineOptions,accounts:new AccountsStore(options)});try{assert.deepEqual(reopened.db.marketAccounts,[]);assert.equal(reopened.db.plans[0].id,plan.id);assert.equal(reopened.db.plans[0].enabled,false);assert.equal(reopened.db.jobs[0].id,job.id);assert.equal(reopened.db.jobs[0].state,'needs_review');assert.equal(reopened.running,false);}finally{await reopened.close();}
});

test('verification opens the current page for review and preserves each safe readiness reason without losing the prior login latch',async()=>{
 const {ACCOUNT_RESULT_CODES}=require('../src/commerce-accounts.cjs');for(const code of ['PAGE_NOT_READY','INPUT_SURFACE_UNAVAILABLE','PAGE_BUSY','WINDOW_CLOSED'])for(const phase of ['open','reader-result','reader-error']){
  const f=fixture(),opens=[];f.account.identity={memberId:'123',username:observed.username,profileURL:observed.profileURL};f.account.lastResult={code:'LOGIN_OUTCOME_UNKNOWN'};f.account.loginReviewPending=true;f.engine.db.marketAccounts=[{profileId:'profile-1',...f.account.identity}];const binding=structuredClone(f.engine.db.marketAccounts);
  f.service.openPage=async(profileId,input)=>{opens.push(input);assert.equal(profileId,'profile-1');assert.equal(input.reviewCurrent,true);assert.equal(input.freshLogin,undefined);assert.ok(input.signal instanceof AbortSignal);assert.equal(typeof input.guard,'function');if(phase==='open')throw Object.assign(Error('private upstream readiness details'),{code});};f.login.verify=async(_id,input)=>{assert.equal(input.expectedMemberId,'123');if(phase==='reader-error')throw Object.assign(Error('private upstream readiness details'),{code});return {status:'awaiting_user',verified:false,submitted:false,code};};
  const result=await f.service.verify('account-1',{confirmCurrent:true,reviewCurrent:false});assert.equal(opens.length,1);assert.equal(result.result.code,code);assert.equal(result.result.verified,false);assert.equal(result.result.submitted,false);assert.equal(result.result.loginReviewPending,true);assert.equal(f.account.lastResult.code,code);assert.deepEqual(f.engine.db.marketAccounts,binding);assert.equal(f.credentialReads,0);assert.equal(f.loginCalls,0);assert.doesNotMatch(JSON.stringify(result),/private upstream/);assert.equal(ACCOUNT_RESULT_CODES[code].length>0,true);
 }
});

test('a submitted readiness failure remains an unknown login outcome rather than becoming permission to resubmit',async()=>{
 for(const code of ['PAGE_NOT_READY','INPUT_SURFACE_UNAVAILABLE','PAGE_BUSY','WINDOW_CLOSED']){const f=fixture();f.login.login=async()=>({status:'awaiting_user',code,submitted:true,verified:false});const result=await f.service.login('account-1');assert.equal(result.result.code,'LOGIN_OUTCOME_UNKNOWN');assert.equal(result.result.loginReviewPending,true);f.login.verify=async()=>({status:'awaiting_user',code,submitted:false,verified:false});await f.service.login('account-1');assert.equal(f.credentialReads,1);assert.equal(f.account.loginReviewPending,true);assert.equal(f.account.lastResult.code,code);}
});

test('local credential mutations preserve fixed busy, storage and closing reasons without raw exception text',async()=>{
 for(const kind of ['own pending','vault busy','vault fault','engine fault','closing']){const f=fixture();let writes=0;f.store.save=()=>{writes++;};f.store.remove=()=>{writes++;};if(kind==='own pending')f.service.pending.add('account-1');if(kind==='vault busy')f.store.isBusy=()=>true;if(kind==='vault fault')f.store.faulted=true;if(kind==='engine fault')f.engine.storageFaulted=()=>true;if(kind==='closing')f.engine.closing=true;const code=kind==='closing'?'ACCOUNT_CLOSED':kind.includes('fault')?'ACCOUNT_STORAGE_UNAVAILABLE':'ACCOUNT_BUSY';await assert.rejects(f.service.save({id:'account-1',label:'Uncommitted'}),{code});await assert.rejects(f.service.remove('account-1'),{code});assert.equal(writes,0);}
 const f=fixture();f.store.save=()=>{throw Object.assign(Error('fixture-secret'),{code:'ACCOUNT_HISTORY'});};await assert.rejects(f.service.save({id:'account-1'}),error=>error.code==='ACCOUNT_HISTORY'&&!error.message.includes('fixture-secret'));
});
