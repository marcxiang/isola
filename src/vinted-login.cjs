'use strict';
const {VintedAccount}=require('./vinted-account.cjs');
const ORIGIN='https://www.vinted.fr';
const LOGIN_URL=ORIGIN+'/member/login/email';

// Public French SSR inspected 2026-10-14: POST form, username/password inputs,
// auth_modal_title=Se connecter, Continuer submit, forgot-password-link.
// https://www.vinted.fr/member/login/email
// https://www.vinted.fr/help/104-je-ne-parviens-pas-a-me-connecter-a-mon-compte
// This recognizer is deliberately narrower than a general password controller.
// A real credential submission has not been validated against production Vinted.
// Unknown layouts, embedded login, OAuth, recovery and challenges need a human.
const MESSAGES={
  LOGGED_IN:'已通过当前窗口的账号菜单核对登录账号。',
  ACCOUNT_CONFIRMATION_REQUIRED:'已读取当前登录账号，请人工确认它属于保存的账号，再完成绑定。',
  ACCOUNT_MISMATCH:'当前窗口登录的是另一个账号，已停止；不会自动退出或覆盖。',
  LOGIN_FORM_REQUIRED:'请在法国 Vinted 打开邮箱登录表单；当前页面结构无法安全自动填写。',
  LOGIN_FIELDS_NOT_EMPTY:'登录字段已有内容，已保留；请在页面人工检查后继续。',
  LOGIN_CHALLENGE:'页面需要验证码、二次验证或账号检查，请在窗口内完成。',
  LOGIN_RESULT_UNKNOWN:'已单次提交登录，但尚未取得可核对的账号回执；请在窗口检查，不会自动重试。',
  LOGIN_FORM_CHANGED:'登录页面或表单已改变，已停止自动填写和提交。',
  INPUT_SURFACE_UNAVAILABLE:'请先显示该环境并切换到登录标签页，再继续。',
  INVALID_CREDENTIALS:'登录凭据或预期账号标识无效。',
  WRONG_SITE:'只能在 https://www.vinted.fr 的登录页面输入凭据。',
  PAGE_BUSY:'该环境已有其他任务，请先停止并等待当前步骤结束。',
  WINDOW_CLOSED:'对应环境或标签页已关闭。',
  TAB_CHANGED:'当前标签页已切换，登录操作已停止。',
  STOPPED:'登录操作已停止；如已经提交，请在页面检查结果。',
  LOGIN_UNAVAILABLE:'登录页面控制未能完成，请在窗口人工接管。',
  ACCOUNT_UNVERIFIED:'尚未取得可核对的当前账号回执，请在窗口人工检查。'
};
const failure=code=>Object.assign(new Error(MESSAGES[code]||MESSAGES.LOGIN_UNAVAILABLE),{code:MESSAGES[code]?code:'LOGIN_UNAVAILABLE'});
const output=(status,code,submitted=false,account)=>({status,code,verified:status==='logged_in',submitted:!!submitted,message:MESSAGES[code]||MESSAGES.LOGIN_UNAVAILABLE,...(account?{account}:{})});
const normal=value=>String(value||'').trim().toLowerCase();
function frenchURL(value){let url;try{url=new URL(value);}catch{throw failure('WRONG_SITE');}if(url.origin!==ORIGIN||url.username||url.password)throw failure('WRONG_SITE');return url;}
async function cleanup(contents,method,params){let timer;try{await Promise.race([contents.debugger.sendCommand(method,params),new Promise(resolve=>{timer=setTimeout(resolve,250);timer.unref?.();})]);}catch{}finally{clearTimeout(timer);}}

// Read-only DOM inspection. The isolated-world registry holds node references,
// never credential values. Only classifications, geometry and booleans leave it.
function probeLoginDOM(expected){
  const d=globalThis.__isolaDOM,visible=e=>!!e?.isConnected&&d.visible(e),clean=s=>String(s||'').replace(/\s+/g,' ').trim();
  const documentKey=String(performance.timeOrigin),url=location.href;
  const headings=[...document.querySelectorAll('h1,h2,[role=alert]')].filter(visible).map(e=>clean(d.safeText(e,300)));
  const challenge=!!document.querySelector('input[autocomplete="one-time-code"]')||[...document.querySelectorAll('iframe')].some(e=>visible(e)&&/captcha|challenge|verification/i.test(e.src||e.title||''))||headings.some(t=>/captcha|vérifi(?:e|er|cation)|verification|two.factor|code de sécurité|security code|compte (?:bloqué|suspendu)|account (?:blocked|suspended)/i.test(t));
  // A mobile SVG menu is only a route to the existing identity reader. Its
  // label alone never establishes a logged-in account or authorizes input.
  const accountHint=[...document.querySelectorAll('header button,nav button,[role=navigation] button')].some(e=>visible(e)&&(['Menu ouvert','Menu fermé'].includes(clean(d.label(e)))||[...e.querySelectorAll('img[alt]')].some(img=>visible(img)&&clean(img.getAttribute('alt')))));
  const base={documentKey,url,challenge,accountHint};
  if(challenge||accountHint)return {...base,kind:challenge?'challenge':'account'};
  if(location.origin!=='https://www.vinted.fr'||location.pathname!=='/member/login/email'||location.username||location.password)return {...base,kind:'unknown'};
  if([...document.querySelectorAll('iframe')].some(visible))return {...base,kind:'unknown'};
  const passwords=[...document.querySelectorAll('input[type=password]')].filter(visible);
  if(passwords.length!==1)return {...base,kind:'unknown'};
  const password=passwords[0],form=password.form;
  if(!visible(form)||form.tagName!=='FORM'||form.method.toLowerCase()!=='post'||!['','_self'].includes(form.target.toLowerCase()))return {...base,kind:'unknown'};
  const actionOK=value=>{try{const u=new URL(value,location.href);return u.origin==='https://www.vinted.fr'&&!u.username&&!u.password&&u.pathname==='/member/login/email'&&!u.search&&!u.hash;}catch{return false;}};
  if(!actionOK(form.action))return {...base,kind:'unknown'};
  const usernames=[...form.querySelectorAll('input#username[name=username]')].filter(visible),buttons=[...form.querySelectorAll('button[type=submit],input[type=submit]')].filter(visible);
  const heading=form.querySelector('#auth_modal_title');
  if(usernames.length!==1||buttons.length!==1||!visible(heading)||clean(d.safeText(heading,80))!=='Se connecter')return {...base,kind:'unknown'};
  const username=usernames[0],submit=buttons[0];
  if(username.form!==form||password.id!=='password'||password.name!=='password'||password.form!==form||submit.form!==form||!['text','email'].includes(username.type)||password.autocomplete==='new-password'||!['Continuer','Se connecter'].includes(clean(d.safeText(submit,80))))return {...base,kind:'unknown'};
  if(submit.hasAttribute('formaction')&&!actionOK(submit.formAction)||submit.hasAttribute('formmethod')&&submit.formMethod.toLowerCase()!=='post')return {...base,kind:'unknown'};
  if(submit.hasAttribute('formtarget')&&!['','_self'].includes(submit.formTarget.toLowerCase()))return {...base,kind:'unknown'};
  if([...form.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=true]')].some(e=>visible(e)&&e!==username&&e!==password))return {...base,kind:'unknown'};
  if([username,password,submit].some(e=>d.disabled(e))||username.readOnly||password.readOnly)return {...base,kind:'unknown'};
  const hits=[username,password,submit].map(e=>d.probe(e));
  if(hits.some(h=>!h.point))return {...base,kind:'unknown'};
  const prior=globalThis.__isolaLoginNodes;
  if(expected&&(!prior||expected.documentKey!==documentKey||expected.url!==url||prior.form!==form||prior.username!==username||prior.password!==password||prior.submit!==submit))return {...base,kind:'changed'};
  if(!expected)globalThis.__isolaLoginNodes={form,username,password,submit};
  const lengthsOK=!expected||(username.value.length===expected.loginLength&&password.value.length===expected.passwordLength);
  return {...base,kind:lengthsOK?'form':'changed',empty:username.value.length===0&&password.value.length===0,focused:d.active()===username?'username':d.active()===password?'password':d.active()===submit?'submit':'other',submitPoint:hits[2].point,submitRect:d.rect(submit),touch:navigator.maxTouchPoints>0&&matchMedia('(pointer:coarse)').matches};
}

class VintedLogin {
  constructor(adapter,{account=new VintedAccount(adapter),timeoutMs=5000,resultWaitMs=4000,pollIntervalMs=100}={}){
    if(!adapter?.current||!adapter?.control?.isolated)throw new TypeError('VintedAdapter is required');
    this.adapter=adapter;this.account=account;this.timeoutMs=Math.max(20,Math.min(10000,timeoutMs));this.resultWaitMs=Math.max(0,Math.min(10000,resultWaitMs));this.pollIntervalMs=Math.max(10,Math.min(250,pollIntervalMs));
  }
  guard(context,{input=false}={}){
    if(context.signal.aborted)throw failure('STOPPED');
    const selected=this.adapter.current(context.profileId,context);frenchURL(selected.tab.view.webContents.getURL());
    if(input&&(typeof selected.tab.isInputVisible==='function'?selected.tab.isInputVisible()===false:!selected.w.isVisible?.()||selected.w.isMinimized?.()))throw failure('INPUT_SURFACE_UNAVAILABLE');
    if(input&&(context.epoch!==context.startEpoch||selected.tab.view.webContents.isLoadingMainFrame?.()))throw failure('LOGIN_FORM_CHANGED');
    return selected;
  }
  async bounded(context,task){
    this.guard(context);let timer,onAbort;
    const stop=new Promise((_,reject)=>{onAbort=()=>reject(failure('STOPPED'));context.signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>{reject(failure('LOGIN_UNAVAILABLE'));context.controller.abort();},this.timeoutMs);});
    try{return await Promise.race([Promise.resolve().then(()=>{this.guard(context);return task();}),stop]);}finally{clearTimeout(timer);context.signal.removeEventListener('abort',onAbort);}
  }
  async read(context,expected){
    const state=await this.bounded(context,()=>this.adapter.control.isolated(context.tab,'('+probeLoginDOM.toString()+')('+JSON.stringify(expected||null)+')'));
    this.guard(context);if(!state||typeof state.documentKey!=='string'||typeof state.url!=='string')throw failure('LOGIN_FORM_CHANGED');
    frenchURL(state.url);if(state.url!==context.tab.view.webContents.getURL())throw failure('LOGIN_FORM_CHANGED');return state;
  }
  async requireForm(context,expected,{focused}={}){
    this.guard(context,{input:true});const state=await this.read(context,expected);this.guard(context,{input:true});
    if(state.kind==='challenge')throw failure('LOGIN_CHALLENGE');
    if(state.kind!=='form')throw failure(expected?'LOGIN_FORM_CHANGED':'LOGIN_FORM_REQUIRED');
    if(expected){
      // Pass credentials as protocol arguments, never JavaScript source. Only an
      // exact-match boolean leaves the isolated world; equal-length mutations
      // cannot silently change the account or password we are about to submit.
      const checked=await this.command(context,'Runtime.callFunctionOn',{
        functionDeclaration:'function(username,password,focused){const state=('+probeLoginDOM.toString()+')('+JSON.stringify(expected)+');const nodes=globalThis.__isolaLoginNodes;return state.kind==="form"&&!!nodes&&nodes.username.value===username&&nodes.password.value===password&&(!focused||globalThis.__isolaDOM.active()===nodes[focused]);}',
        executionContextId:context.tab.aiContext,arguments:[{value:context.values.username},{value:context.values.password},{value:focused||''}],returnByValue:true
      });
      this.guard(context,{input:true});if(checked.exceptionDetails||checked.result?.value!==true)throw failure('LOGIN_FORM_CHANGED');
    }
    return state;
  }
  async command(context,method,params,{input=true}={}){
    this.guard(context,{input});return this.bounded(context,()=>{this.guard(context,{input});return context.tab.view.webContents.debugger.sendCommand(method,params);});
  }
  async insert(context,field,value,expected){
    await this.requireForm(context,expected);
    // Node identity is retained in the isolated world; no CSS query is repeated
    // after accepting a target. Credentials only enter the dedicated CDP call.
    const result=await this.command(context,'Runtime.evaluate',{expression:'globalThis.__isolaLoginNodes.'+field,contextId:context.tab.aiContext,objectGroup:'IsolaVintedLogin',returnByValue:false});
    if(result.exceptionDetails||!result.result?.objectId)throw failure('LOGIN_FORM_CHANGED');
    try{
      await this.command(context,'DOM.focus',{objectId:result.result.objectId});
      this.guard(context,{input:true});context.tab.view.webContents.focus?.();
      const focused=await this.requireForm(context,expected,{focused:field});if(focused.focused!==field)throw failure('LOGIN_FORM_CHANGED');
      this.guard(context,{input:true});await this.command(context,'Input.insertText',{text:value});
    }finally{await cleanup(context.tab.view.webContents,'Runtime.releaseObject',{objectId:result.result.objectId});}
    context.values[field]=value;
    const next={...expected,[field==='username'?'loginLength':'passwordLength']:value.length};
    await this.requireForm(context,next);return next;
  }
  async prepareEmptySurface(context,expected){
    await this.requireForm(context,expected);this.guard(context,{input:true});
    const c=context.tab.view.webContents;
    // Electron on Windows can acknowledge keyboard input before the first
    // embedded view frame is routable. Read one corner pixel only while both
    // fields are empty and before either credential has reached the page. The
    // pixel is discarded locally; no image is stored, returned or sent to AI.
    if(typeof c.capturePage!=='function')throw failure('LOGIN_UNAVAILABLE');
    c.invalidate?.();await this.bounded(context,()=>{this.guard(context,{input:true});return c.capturePage({x:0,y:0,width:1,height:1},{stayHidden:false});});
    await this.requireForm(context,expected);
  }
  async submit(context,expected){
    await this.requireForm(context,expected);
    const c=context.tab.view.webContents,result=await this.command(context,'Runtime.evaluate',{expression:'globalThis.__isolaLoginNodes.submit',contextId:context.tab.aiContext,objectGroup:'IsolaVintedLogin',returnByValue:false});
    if(result.exceptionDetails||!result.result?.objectId)throw failure('LOGIN_FORM_CHANGED');
    let pressStarted=false;const key={key:'Enter',code:'Enter',windowsVirtualKeyCode:13};
    try{
      // Focus the exact proven submit node, then activate it with one trusted
      // keyboard gesture. This avoids Windows pointer hit-test startup stalls
      // without taking a screenshot of a page containing credentials.
      await this.command(context,'DOM.focus',{objectId:result.result.objectId});
      this.guard(context,{input:true});c.focus?.();
      const focused=await this.requireForm(context,expected,{focused:'submit'});if(focused.focused!=='submit')throw failure('LOGIN_FORM_CHANGED');
      await this.bounded(context,()=>{this.guard(context,{input:true});
        // Mark at the actual dispatch boundary. An uncertain transport result
        // must never cause replay; pre-dispatch cancellation starts no gesture.
        context.submitted=true;pressStarted=true;
        return c.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',...key,text:'\r',unmodifiedText:'\r'});});
    }finally{
      // Once a press started, release it even if cancellation or navigation won.
      if(pressStarted)await cleanup(c,'Input.dispatchKeyEvent',{type:'keyUp',...key});
      await cleanup(c,'Runtime.releaseObject',{objectId:result.result.objectId});
    }
  }
  identity(account,options){
    if(account?.verified!==true||!account.memberId)throw failure('ACCOUNT_UNVERIFIED');
    const memberId=options.expectedMemberId||options.expectedAccount?.memberId;
    if(memberId){if(account.memberId!==String(memberId))return 'ACCOUNT_MISMATCH';return 'LOGGED_IN';}
    const expected=options.expectedUsername||(!options.login?.includes('@')?options.login:'');
    if(expected)return normal(account.username)===normal(expected)?'LOGGED_IN':'ACCOUNT_MISMATCH';
    return options.confirmCurrent===true?'LOGGED_IN':'ACCOUNT_CONFIRMATION_REQUIRED';
  }
  validate(options,needsPassword,profileId){
    if(!options||typeof options!=='object'||options.expectedMemberId!==undefined&&!/^[1-9]\d{0,29}$/.test(String(options.expectedMemberId))||options.expectedUsername!==undefined&&(typeof options.expectedUsername!=='string'||!options.expectedUsername.trim()||options.expectedUsername.length>100||/[\u0000-\u001f\u007f]/.test(options.expectedUsername)))throw failure('INVALID_CREDENTIALS');
    const binding=options.expectedAccount;
    if(binding!==undefined&&(!binding||typeof binding!=='object'||Array.isArray(binding)||binding.profileId!==profileId||typeof binding.memberId!=='string'||!/^[1-9]\d{0,29}$/.test(binding.memberId)||binding.profileURL!==ORIGIN+'/member/'+binding.memberId||typeof binding.username!=='string'||!binding.username||binding.username.trim()!==binding.username||binding.username.length>100||/[\u0000-\u001f\u007f]/.test(binding.username)||options.expectedMemberId!==undefined&&String(options.expectedMemberId)!==binding.memberId))throw failure('INVALID_CREDENTIALS');
    if(needsPassword&&(typeof options.login!=='string'||!options.login.trim()||options.login.length>254||/[\u0000-\u001f\u007f]/.test(options.login)||typeof options.password!=='string'||!options.password||options.password.length>1024||/[\u0000\r\n]/.test(options.password)))throw failure('INVALID_CREDENTIALS');
    if(options.login!==undefined&&(typeof options.login!=='string'||!options.login.trim()||options.login.length>254||/[\u0000-\u001f\u007f]/.test(options.login)))throw failure('INVALID_CREDENTIALS');
  }
  async accountResult(context,options){
    this.guard(context);let observed;
    try{observed=await this.account.inspectAccount(context.profileId,{signal:context.signal,controller:context.controller,tab:context.tab,...(options.expectedAccount?{expectedAccount:options.expectedAccount}:{}),...(options.closeAccountMenu===true?{closeMenu:true}:{})});}
    catch(error){if(error?.code==='ACCOUNT_CHANGED'&&options.expectedAccount)throw failure('ACCOUNT_MISMATCH');throw error;}
    this.guard(context);
    const code=this.identity(observed,options);return output(code==='LOGGED_IN'?'logged_in':code==='ACCOUNT_MISMATCH'?'error':'awaiting_user',code,context.submitted,observed);
  }
  async run(profileId,options,login){
    let context,w,contents,onNavigate,onDestroyed,onAbort,throttling;
    try{
      this.validate(options,login,profileId);if(options.signal?.aborted)throw failure('STOPPED');
      if(options.expectedAccount)options={...options,expectedAccount:Object.freeze({...options.expectedAccount})};
      const controller=new AbortController();context={profileId,controller,signal:controller.signal,submitted:false,epoch:0,startEpoch:0,values:{username:'',password:''}};
      const selected=this.guard(context);w=selected.w;context.tab=selected.tab;contents=selected.tab.view.webContents;
      w.vintedDraftController=controller;
      onAbort=()=>controller.abort();options.signal?.addEventListener('abort',onAbort,{once:true});
      onNavigate=(_event,_url,_inPlace,mainFrame)=>{if(mainFrame!==false){context.epoch++;if(!context.submitted)controller.abort();}};
      onDestroyed=()=>controller.abort();contents.on?.('did-start-navigation',onNavigate);contents.on?.('destroyed',onDestroyed);contents.on?.('render-process-gone',onDestroyed);
      const initial=await this.read(context);
      if(initial.kind==='account')return await this.accountResult(context,options);
      if(initial.kind==='challenge')return output('awaiting_user','LOGIN_CHALLENGE');
      if(!login)return output('awaiting_user','ACCOUNT_UNVERIFIED');
      if(initial.kind!=='form')return output('awaiting_user','LOGIN_FORM_REQUIRED');
      if(!initial.empty)return output('awaiting_user','LOGIN_FIELDS_NOT_EMPTY');
      let expected={documentKey:initial.documentKey,url:initial.url,loginLength:0,passwordLength:0};
      if(contents.getBackgroundThrottling&&contents.setBackgroundThrottling){throttling=contents.getBackgroundThrottling();contents.setBackgroundThrottling(false);}
      await this.prepareEmptySurface(context,expected);
      expected=await this.insert(context,'username',options.login.trim(),expected);
      expected=await this.insert(context,'password',options.password,expected);
      await this.submit(context,expected);
      const until=Date.now()+this.resultWaitMs;
      do{
        this.guard(context);if(!contents.isLoadingMainFrame?.()){
          const next=await this.read(context);if(next.kind==='account')return await this.accountResult(context,options);if(next.kind==='challenge')return output('awaiting_user','LOGIN_CHALLENGE',true);
        }
        if(Date.now()>=until)break;
        await this.bounded(context,()=>new Promise(resolve=>setTimeout(resolve,this.pollIntervalMs)));
      }while(true);
      return output('awaiting_user','LOGIN_RESULT_UNKNOWN',true);
    }catch(error){
      // Never return a CDP exception, website text, cause, stack or credential.
      const code=MESSAGES[error?.code]?error.code:'LOGIN_UNAVAILABLE';
      const awaiting=['LOGIN_CHALLENGE','LOGIN_FORM_REQUIRED','LOGIN_FIELDS_NOT_EMPTY','LOGIN_RESULT_UNKNOWN','LOGIN_FORM_CHANGED','ACCOUNT_UNVERIFIED','LOGIN_UNAVAILABLE'].includes(code);
      return output(awaiting?'awaiting_user':'error',code,context?.submitted);
    }finally{
      options?.signal?.removeEventListener('abort',onAbort);contents?.removeListener?.('did-start-navigation',onNavigate);contents?.removeListener?.('destroyed',onDestroyed);contents?.removeListener?.('render-process-gone',onDestroyed);
      if(w&&w.vintedDraftController===context?.controller)w.vintedDraftController=null;
      if(throttling!==undefined&&!contents?.isDestroyed?.())try{contents.setBackgroundThrottling(throttling);}catch{}
      if(context)delete context.values;
      if(context?.tab)await cleanup(contents,'Runtime.releaseObjectGroup',{objectGroup:'IsolaVintedLogin'});
    }
  }
  login(profileId,options){return this.run(profileId,options,true);}
  verify(profileId,options={}){return this.run(profileId,options,false);}
  inspectOwnProfileLink(profileId,options={}){return this.account.inspectOwnProfileLink(profileId,options);}
  validateOwnProfileLink(profileId,candidate,options={}){return this.account.validateOwnProfileLink(profileId,candidate,options);}
}
module.exports={VintedLogin,LOGIN_URL,probeLoginDOM};
