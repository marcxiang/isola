'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {VintedLogin,LOGIN_URL,probeLoginDOM}=require('../src/vinted-login.cjs');
const SECRET='private-test-password-不可输出';
function fixture(options={}){
  let url=options.url||LOGIN_URL,kind=options.kind||'form',focused='other',loginLength=options.prefilled?1:0,passwordLength=0,presses=0,reads=0;
  const commands=[],c=Object.assign(new EventEmitter(),{isDestroyed:()=>false,getURL:()=>url,isLoadingMainFrame:()=>false,capturePage:async()=>({})});
  const tab={id:'login-tab',aiContext:17,isInputVisible:()=>options.visible!==false,view:{webContents:c}},w={isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,tabs:[tab],activeTab:tab.id};
  const api={commands,tab,w,accountRequests:[],setKind(value){kind=value;},setURL(value){url=value;},presses:()=>presses};
  const current=(_id,{signal,tab:expected,controller}={})=>{
    if(signal?.aborted)throw Object.assign(Error('aborted'),{code:'STOPPED'});
    if(w.vintedDraftController&&w.vintedDraftController!==controller)throw Object.assign(Error('busy'),{code:'PAGE_BUSY'});
    if(w.activeTab!==tab.id||expected&&expected!==tab)throw Object.assign(Error('tab'),{code:'TAB_CHANGED'});
    return {w,tab};
  };
  c.debugger={sendCommand:async(method,args={})=>{
    // Record method and non-secret metadata only, as production logging must do.
    commands.push({method,...(method==='Input.insertText'?{length:args.text.length}:method==='Runtime.callFunctionOn'?{exactBooleanCheck:true}:args)});options.beforeCommand?.(api,method,args);
    if(options.commandError&&method==='Input.insertText')throw Error(SECRET);
    if(method==='Runtime.evaluate')return {result:{objectId:args.expression.endsWith('.password')?'password-node':args.expression.endsWith('.submit')?'submit-node':'username-node'}};
    if(method==='Runtime.callFunctionOn')return {result:{value:options.exactMatches!==false}};
    if(method==='DOM.focus')focused=args.objectId==='password-node'?'password':args.objectId==='submit-node'?'submit':'username';
    if(method==='Input.insertText'){if(focused==='password')passwordLength=args.text.length;else loginLength=args.text.length;}
    if(method==='Input.dispatchKeyEvent'&&args.type==='keyDown'){presses++;options.onPress?.(api);}
    if(method==='Input.dispatchKeyEvent'&&args.type==='keyUp'){if(options.resultKind)kind=options.resultKind;}
    return {};
  }};
  const adapter={current,control:{isolated:async()=>{
    reads++;options.beforeRead?.(api,reads);
    if(options.hang)return new Promise(()=>{});
    return {documentKey:'doc-1',url,kind,empty:!loginLength&&!passwordLength,focused,challenge:kind==='challenge',accountHint:kind==='account',mobileAccountHint:options.mobileAccountHint===true,submitPoint:{x:200,y:300},submitRect:{x:150,y:280,width:100,height:40},touch:!!options.touch};
  }}};
  const account={inspectAccount:async(_profileId,input)=>{api.accountRequests.push(input);options.beforeAccount?.(api,input);if(options.accountError)throw Object.assign(Error('Untrusted provider detail'),{code:options.accountError});return {verified:true,memberId:options.memberId||'123456',username:options.username||'fixture_seller',profileURL:'https://www.vinted.fr/member/'+(options.memberId||'123456'),evidence:{kind:'current-account-menu',consistentReads:2}};}};
  api.service=new VintedLogin(adapter,{account,timeoutMs:options.timeoutMs||100,resultWaitMs:0,pollIntervalMs:10});return api;
}
const credentials={login:'fixture_seller',password:SECRET};
test('observed email URL and one submit use dedicated CDP without a generic password action',async()=>{
  assert.equal(LOGIN_URL,'https://www.vinted.fr/member/login/email');const f=fixture({resultKind:'account'}),out=await f.service.login('p',credentials);
  assert.equal(out.status,'logged_in');assert.equal(out.verified,true);assert.equal(out.account.evidence.consistentReads,2);assert.equal(out.submitted,true);assert.equal(f.presses(),1);
  assert.deepEqual(f.commands.filter(c=>c.method==='Input.insertText').map(c=>c.length),[credentials.login.length,SECRET.length]);assert.equal(JSON.stringify(out).includes(SECRET),false);assert.equal(JSON.stringify(f.commands).includes(SECRET),false);assert.equal(f.w.vintedDraftController,null);assert.equal(f.tab.view.webContents.listenerCount('did-start-navigation'),0);
});
test('mobile form activates the same proven submit with one trusted keyboard gesture',async()=>{const f=fixture({touch:true,resultKind:'account'}),out=await f.service.login('p',credentials);assert.equal(out.status,'logged_in');assert.equal(f.presses(),1);assert.deepEqual(f.commands.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>c.type),['keyDown','keyUp']);assert.equal(f.commands.some(c=>c.method==='Input.dispatchMouseEvent'||c.method==='Input.dispatchTouchEvent'),false);});
test('an existing expected session is verified with no credential dispatch',async()=>{const f=fixture({kind:'account'}),out=await f.service.login('p',{...credentials,expectedMemberId:'123456'});assert.equal(out.status,'logged_in');assert.equal(out.submitted,false);assert.equal(f.commands.some(c=>c.method.startsWith('Input.')),false);});
test('operator verification can require strict menu closure while normal login leaves the existing menu behavior unchanged',async()=>{
  const login=fixture({kind:'account'});assert.equal((await login.service.login('p',credentials)).verified,true);assert.equal(Object.hasOwn(login.accountRequests[0],'closeMenu'),false);
  for(const closeAccountMenu of [true,false,'true']){const f=fixture({kind:'account'}),out=await f.service.verify('p',{expectedMemberId:'123456',closeAccountMenu});assert.equal(out.verified,true);assert.equal(f.accountRequests[0].closeMenu,closeAccountMenu===true?true:undefined);assert.equal(f.accountRequests[0].tab,f.tab);assert.equal(f.commands.some(command=>command.method.startsWith('Input.')),false);}
  const changed=fixture({kind:'account',accountError:'ACCOUNT_UNVERIFIED'}),rejected=await changed.service.verify('p',{expectedMemberId:'123456',closeAccountMenu:true});assert.equal(changed.accountRequests[0].closeMenu,true);assert.equal(rejected.verified,false);assert.equal(rejected.code,'ACCOUNT_UNVERIFIED');assert.equal(rejected.submitted,false);
});
test('mobile SVG labels only select the account-reader route, while challenges keep priority',()=>{
  for(const label of ['Menu ouvert','Menu fermé','Unrelated menu']){
    const button={isConnected:true,label,querySelectorAll:()=>[]},location={href:'https://www.vinted.fr/',origin:'https://www.vinted.fr',pathname:'/'},context={location,performance:{timeOrigin:1},globalThis:{__isolaDOM:{visible:()=>true,label:e=>e.label,safeText:()=>''}},document:{querySelector:()=>null,querySelectorAll:selector=>selector.startsWith('header button')?[button]:[]}};
    const state=vm.runInNewContext('('+probeLoginDOM.toString()+')(null)',context);assert.equal(state.kind,label==='Unrelated menu'?'unknown':'account');assert.equal(state.accountHint,label!=='Unrelated menu');
    context.document.querySelector=()=>({});assert.equal(vm.runInNewContext('('+probeLoginDOM.toString()+')(null)',context).kind,'challenge');
  }
});
test('explicit phone profile review routes before any account menu input while normal login and challenges retain their behavior',async()=>{
 const f=fixture({kind:'account',mobileAccountHint:true}),out=await f.service.verify('p',{requireOwnProfileClick:true,expectedMemberId:'123456'});assert.equal(out.code,'PROFILE_REVIEW_REQUIRED');assert.equal(out.verified,false);assert.equal(out.account,undefined);assert.equal(f.accountRequests.length,0);assert.equal(f.commands.some(command=>command.method.startsWith('Input.')||command.method==='DOM.focus'),false);
 const challenged=fixture({kind:'challenge',mobileAccountHint:true});assert.equal((await challenged.service.verify('p',{requireOwnProfileClick:true})).code,'LOGIN_CHALLENGE');assert.equal(challenged.accountRequests.length,0);
 const normal=fixture({kind:'account',mobileAccountHint:true});assert.equal((await normal.service.login('p',credentials)).verified,true);assert.equal(normal.accountRequests.length,1);
 const heading=fixture({kind:'account'});await heading.service.verify('p',{expectedMemberId:'123456',requireOwnProfileHeading:true});assert.equal(heading.accountRequests[0].requireOwnProfileHeading,true);
});
test('saved mobile identity reaches the existing account reader without entering credentials or authorizing a different member',async()=>{
  const binding={profileId:'p',memberId:'123456',profileURL:'https://www.vinted.fr/member/123456',username:'fixture_seller'};
  const f=fixture({kind:'account'}),out=await f.service.login('p',{...credentials,expectedAccount:binding});assert.equal(out.status,'logged_in');assert.equal(out.submitted,false);assert.deepEqual(f.accountRequests[0].expectedAccount,binding);assert.equal(Object.isFrozen(f.accountRequests[0].expectedAccount),true);assert.equal(f.accountRequests[0].tab,f.tab);assert.equal(f.commands.some(command=>command.method.startsWith('Input.')),false);
  const wrong=fixture({kind:'account',memberId:'999999'}),mismatch=await wrong.service.verify('p',{expectedAccount:binding});assert.equal(mismatch.code,'ACCOUNT_MISMATCH');assert.equal(mismatch.verified,false);
  const changed=fixture({kind:'account',accountError:'ACCOUNT_CHANGED'});assert.equal((await changed.service.verify('p',{expectedAccount:binding})).code,'ACCOUNT_MISMATCH');
  const missing=fixture({kind:'account',accountError:'ACCOUNT_UNVERIFIED'});assert.equal((await missing.service.verify('p',{login:'fixture@example.invalid',confirmCurrent:true})).code,'ACCOUNT_UNVERIFIED');assert.equal(Object.hasOwn(missing.accountRequests[0],'expectedAccount'),false);
});
test('malformed or cross-environment saved identities stop before any page read or credential dispatch',async()=>{
  const binding={profileId:'p',memberId:'123456',profileURL:'https://www.vinted.fr/member/123456',username:'fixture_seller'};
  for(const expectedAccount of [{...binding,profileId:'other'},{...binding,profileURL:'https://www.vinted.fr/member/999999'},{...binding,username:''},{...binding,memberId:'bad'},[]]){const f=fixture({kind:'account'});assert.equal((await f.service.login('p',{...credentials,expectedAccount})).code,'INVALID_CREDENTIALS');assert.equal(f.commands.length,0);assert.equal(f.accountRequests.length,0);}
  const f=fixture({kind:'account'});assert.equal((await f.service.verify('p',{expectedAccount:binding,expectedMemberId:'999999'})).code,'INVALID_CREDENTIALS');assert.equal(f.accountRequests.length,0);
});
test('a known member ID has priority over a changed username',async()=>{const f=fixture({kind:'account',username:'renamed_seller'}),out=await f.service.verify('p',{expectedMemberId:'123456',expectedUsername:'old_name'});assert.equal(out.status,'logged_in');});
test('another logged account is preserved without logout or input',async()=>{for(const options of [{expectedMemberId:'654321'},{expectedUsername:'other_seller'},{login:'other_seller'}]){const f=fixture({kind:'account'}),out=await f.service.verify('p',options);assert.equal(out.code,'ACCOUNT_MISMATCH');assert.equal(out.status,'error');assert.equal(f.commands.some(c=>c.method.startsWith('Input.')),false);}});
test('first email session requires explicit local confirmation and cannot override known member mismatch',async()=>{
  const f=fixture({kind:'account'});assert.equal((await f.service.verify('p',{login:'fixture@example.com'})).code,'ACCOUNT_CONFIRMATION_REQUIRED');assert.equal((await f.service.verify('p',{login:'fixture@example.com',confirmCurrent:true})).status,'logged_in');assert.equal((await f.service.verify('p',{login:'fixture@example.com',confirmCurrent:true,expectedMemberId:'654321'})).code,'ACCOUNT_MISMATCH');
});
test('email credential submission still needs identity confirmation when no member mapping exists',async()=>{const f=fixture({resultKind:'account'}),out=await f.service.login('p',{login:'fixture@example.com',password:SECRET});assert.equal(out.code,'ACCOUNT_CONFIRMATION_REQUIRED');assert.equal(out.submitted,true);assert.equal(out.verified,false);assert.equal(out.account.verified,true);});
test('unknown, embedded, challenge and prefilled states never receive credentials',async()=>{for(const options of [{kind:'unknown'},{kind:'challenge'},{prefilled:true}]){const f=fixture(options),out=await f.service.login('p',credentials);assert.equal(out.status,'awaiting_user');assert.equal(out.submitted,false);assert.equal(f.commands.some(c=>c.method==='Input.insertText'),false);assert.equal(f.presses(),0);}});
test('foreign top-level origins reject before credentials or account binding',async()=>{for(const url of ['http://www.vinted.fr/member/login/email','https://vinted.fr/member/login/email','https://www.vinted.fr.evil.test/member/login/email','https://user@www.vinted.fr/member/login/email']){const f=fixture({url}),out=await f.service.login('p',credentials);assert.equal(out.code,'WRONG_SITE');assert.equal(f.presses(),0);assert.equal(f.commands.some(c=>c.method==='Input.insertText'),false);}});
test('a hidden or inactive surface cannot receive even the username',async()=>{const f=fixture({visible:false}),out=await f.service.login('p',credentials);assert.equal(out.code,'INPUT_SURFACE_UNAVAILABLE');assert.equal(f.commands.some(c=>c.method==='DOM.focus'||c.method==='Input.insertText'),false);});
test('unknown result after a single submit is retained and never replayed',async()=>{const f=fixture(),out=await f.service.login('p',credentials);assert.equal(out.code,'LOGIN_RESULT_UNKNOWN');assert.equal(out.submitted,true);assert.equal(f.presses(),1);});
test('challenge after submit pauses for a human and never retries',async()=>{const f=fixture({resultKind:'challenge'}),out=await f.service.login('p',credentials);assert.equal(out.code,'LOGIN_CHALLENGE');assert.equal(out.submitted,true);assert.equal(f.presses(),1);});
test('cancellation at the final field read cannot dispatch a password or submit',async()=>{const stop=new AbortController(),f=fixture({beforeCommand:(api,method,args)=>{if(method==='DOM.focus'&&args.objectId==='password-node')stop.abort();}}),out=await f.service.login('p',{...credentials,signal:stop.signal});assert.equal(out.code,'STOPPED');assert.equal(f.commands.filter(c=>c.method==='Input.insertText').length,1);assert.equal(f.presses(),0);});
test('navigation or tab replacement during focus stops before input',async()=>{for(const operation of [api=>api.tab.view.webContents.emit('did-start-navigation',{},LOGIN_URL,false,true),api=>{api.w.activeTab='other';}]){const f=fixture({beforeCommand:(api,method)=>{if(method==='DOM.focus')operation(api);}}),out=await f.service.login('p',credentials);assert.equal(out.submitted,false);assert.equal(f.commands.some(c=>c.method==='Input.insertText'),false);assert.equal(f.presses(),0);}});
test('changed form during submit focus prevents the sole activation',async()=>{const f=fixture({beforeCommand:(api,method,args)=>{if(method==='DOM.focus'&&args.objectId==='submit-node')api.setKind('changed');}}),out=await f.service.login('p',credentials);assert.equal(out.code,'LOGIN_FORM_CHANGED');assert.equal(f.presses(),0);assert.equal(out.submitted,false);});
test('cancellation after submit focus sends neither Enter press nor release',async()=>{const stop=new AbortController(),f=fixture({beforeCommand:(_api,method,args)=>{if(method==='DOM.focus'&&args.objectId==='submit-node')stop.abort();}}),out=await f.service.login('p',{...credentials,signal:stop.signal});assert.equal(out.code,'STOPPED');assert.equal(out.submitted,false);assert.equal(f.commands.some(c=>c.method==='Input.dispatchKeyEvent'),false);assert.equal(f.presses(),0);});
test('equal-length credential mutations fail an exact boolean check before submission',async()=>{const f=fixture({exactMatches:false}),out=await f.service.login('p',credentials);assert.equal(out.code,'LOGIN_FORM_CHANGED');assert.equal(f.commands.some(c=>c.method==='Input.insertText'),false);assert.equal(f.presses(),0);});
test('cancellation during a started press still releases once and never presses again',async()=>{const stop=new AbortController(),f=fixture({onPress:()=>stop.abort()}),out=await f.service.login('p',{...credentials,signal:stop.signal});assert.equal(out.code,'STOPPED');assert.equal(out.submitted,true);assert.equal(f.presses(),1);assert.equal(f.commands.filter(c=>c.method==='Input.dispatchKeyEvent'&&c.type==='keyUp').length,1);});
test('raw transport errors and passwords are replaced by fixed safe outcomes',async()=>{const f=fixture({commandError:true}),out=await f.service.login('p',credentials);assert.equal(out.code,'LOGIN_UNAVAILABLE');assert.equal(JSON.stringify(out).includes(SECRET),false);assert.equal(out.stack,undefined);assert.equal(out.cause,undefined);});
test('invalid credentials and pre-cancellation do not touch the page',async()=>{for(const input of [{login:'',password:SECRET},{login:'fixture',password:''},{login:'fixture',password:SECRET,expectedMemberId:'not-an-id'}]){const f=fixture();assert.equal((await f.service.login('p',input)).code,'INVALID_CREDENTIALS');assert.equal(f.commands.length,0);}const stop=new AbortController();stop.abort();const f=fixture();assert.equal((await f.service.login('p',{...credentials,signal:stop.signal})).code,'STOPPED');assert.equal(f.commands.length,0);});
test('bounded stalled reads release the account lock and return no exception details',async()=>{const f=fixture({hang:true,timeoutMs:20}),out=await f.service.login('p',credentials);assert.equal(out.code,'LOGIN_UNAVAILABLE');assert.equal(f.w.vintedDraftController,null);assert.equal(f.presses(),0);});
