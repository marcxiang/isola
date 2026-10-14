const { normalizeURL } = require('./model.cjs');
const { parseKeys,dispatchKey } = require('./keys.cjs');
const { installDOMHelpers } = require('./dom-control.cjs');
const {getDisplayState,assertDisplayVersion,mapPoint,beginInputGesture}=require('./display-transform.cjs');
const HELPER_SOURCE='('+installDOMHelpers.toString()+')()';
function controlError(code,message,label){const e=new Error(message);e.code=code;e.targetLabel=label||'';return e;}
function abort(signal) { if (signal?.aborted) throw Error('任务已停止'); }
function inputVisible(tab,signal,version) { abort(signal);assertDisplayVersion(tab.view.webContents,version);if(tab.isInputVisible?.()===false)throw controlError('INPUT_SURFACE_UNAVAILABLE','请先显示该环境并切换到当前标签页，再继续页面操作'); }
async function isolated(tab, expression) {
  const c = tab.view.webContents;
  if (c.isDestroyed() || !c.debugger.isAttached()) throw Error('页面控制连接已断开');
  if (!tab.aiContext) {
    const tree = await c.debugger.sendCommand('Page.getFrameTree');
    const world = await c.debugger.sendCommand('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'IsolaPageControl', grantUniveralAccess: false });
    tab.aiContext = world.executionContextId;
    await c.debugger.sendCommand('Runtime.evaluate',{expression:HELPER_SOURCE,contextId:tab.aiContext});
  }
  try {
    const result = await c.debugger.sendCommand('Runtime.evaluate', { expression, contextId: tab.aiContext, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } catch (e) { if (/context|destroyed|Cannot find/i.test(e.message)) tab.aiContext = null; throw e; }
}
async function snapshot(tab) {
  const result=await isolated(tab, `(() => {
    const d=globalThis.__isolaDOM;
    const version=(globalThis.__isolaVersion||0)+1;globalThis.__isolaVersion=version;globalThis.__isolaElements=new Map();
    const candidates=d.collect().map((e,i)=>{const r=e.getBoundingClientRect(),inViewport=r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth,popup=d.closest(e,'[role=listbox],[role=menu],[role=tree],[role=dialog],[aria-modal=true],dialog[open],[data-testid*=dropdown]');return {e,i,score:(popup?1000:0)+(inViewport?200:0)-(d.disabled(e)?2000:0)};}).sort((a,b)=>b.score-a.score||a.i-b.i).slice(0,350);
    const measured=candidates.map(x=>({...x,hit:d.probe(x.e)})).sort((a,b)=>(b.score+(b.hit.point?100:0))-(a.score+(a.hit.point?100:0))||a.i-b.i).slice(0,160);
    const elements=measured.map(({e,hit},i)=>{
      const id='e'+version+'-'+i;globalThis.__isolaElements.set(id,e);
      const scroller=d.scrollContainer(e);
      return {id,tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||'',type:e.type||'',label:d.label(e),context:d.context(e),rect:d.rect(e),focused:e===d.active(),checked:e.hasAttribute('aria-checked')?e.getAttribute('aria-checked'):(['checkbox','radio'].includes(e.type)?!!e.checked:null),required:!!e.required||e.getAttribute('aria-required')==='true',invalid:e.getAttribute('aria-invalid')||((e.willValidate&&!e.validity.valid)?'true':'false'),disabled:d.disabled(e),readOnly:!!e.readOnly,expanded:e.getAttribute('aria-expanded'),selected:e.getAttribute('aria-selected'),clickable:!!hit.point&&!d.disabled(e),covered:hit.inViewport&&!hit.point,blockedBy:hit.blocker,inViewport:hit.inViewport,sensitive:e.type==='password'||e.type==='file'||/password|cc-|one-time-code/.test(e.autocomplete||''),...(scroller&&scroller!==document.scrollingElement?{scroll:d.scrollState(scroller)}:{}),...(e.tagName==='A'?{href:e.href.slice(0,1200)}:{}),...(e.tagName==='SELECT'?{options:[...e.options].slice(0,30).map(o=>({label:o.text.slice(0,80),selected:o.selected,disabled:o.disabled}))}:{})};
    });
    const alerts=[...document.querySelectorAll('[role=alert],[role=status],[aria-live=polite],[aria-live=assertive]')].filter(d.visible).slice(0,12).map(e=>({role:e.getAttribute('role')||'live',text:d.safeText(e,500)}));
    const dialogs=[...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].filter(d.visible).slice(0,8).map(e=>({label:d.label(e),modal:e.getAttribute('aria-modal')==='true'||e.matches('dialog[open]'),text:d.safeText(e,800)}));
    return {url:location.href,title:document.title,text:d.safeText(document.body,6500),elements,alerts,dialogs,scroll:d.scrollState(),busy:d.stability().busy,iframeCount:document.querySelectorAll('iframe').length,viewport:{width:innerWidth,height:innerHeight},automation:{webdriver:navigator.webdriver,remoteDebuggingPortExposed:false}};
  })()`);
  tab.aiSnapshot=result;return result;
}
async function target(tab, id, signal, {scroll=true}={}) {
  if (typeof id !== 'string' || !/^e\d+-\d+$/.test(id)) throw controlError('ELEMENT_STALE','控件标识无效，已自动更新页面状态');
  const start=Date.now();let result;
  do {
    abort(signal);
    result=await isolated(tab, `(async () => {
      const e=globalThis.__isolaElements?.get(${JSON.stringify(id)}),d=globalThis.__isolaDOM;if(!e?.isConnected)return {stale:true};
      if(${scroll?'true':'false'}){e.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'});await new Promise(r=>{const timer=setTimeout(r,150);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);r();}));});}
      const hit=d.probe(e),label=d.label(e),disabled=d.disabled(e);
      return {...hit,touchInput:navigator.maxTouchPoints>0&&matchMedia('(pointer:coarse)').matches,rect:d.rect(e),label,tag:e.tagName,type:e.type||'',autocomplete:e.autocomplete||'',editable:!e.readOnly&&(e.isContentEditable||e.tagName==='TEXTAREA'||(e.tagName==='INPUT'&&['text','search','email','url','tel','number',''].includes(e.type))),readOnly:!!e.readOnly,disabled,href:d.closest(e,'a[href]')?.href||''};
    })()`);
    if(result.stale)throw controlError('ELEMENT_STALE','控件已被页面重新渲染，已自动更新控件列表');
    if(result.disabled)throw controlError('ELEMENT_DISABLED','控件“'+result.label+'”当前不可用，请先完成其前置条件',result.label);
    if(result.point)return {...result,...result.point};
    if(Date.now()-start<1000)await new Promise(r=>setTimeout(r,100));
  }while(Date.now()-start<1000);
  const blocker=result.blocker?.label||result.blocker?.role||result.blocker?.tag;
  throw controlError(result.inViewport?'ELEMENT_OCCLUDED':'ELEMENT_NOT_VISIBLE',result.inViewport?'控件“'+result.label+'”被'+(blocker?'“'+blocker+'”':'另一层页面')+'遮挡，请先选择当前菜单或关闭弹层':'控件“'+result.label+'”未进入可点击区域',result.label);
}
function sensitiveAction(label) { return /购买|支付|下单|转账|删除|发送|提交|发布|签署|同意协议|purchase|checkout|\bpay\b|\bdelete\b|\bsend\b|\bsubmit\b|\bpublish\b|\btransfer\b|\bagree\b|\b(?:acheter|payer|commander|supprimer|envoyer|soumettre|publier|signer|accepter)\b|mettre en ligne/i.test(label); }
function protectedField(t){return t.type==='password'||t.type==='file'||/password|cc-|one-time-code/.test(t.autocomplete||'');}
async function checkOrigin(tab, {allowedOrigins,approve,signal}={}) {
  abort(signal);const url=tab.view.webContents.getURL();
  if(allowedOrigins){if(!/^https?:/.test(url))throw controlError('PAGE_UNAVAILABLE','当前页面不可供 AI 读取，请打开 HTTP / HTTPS 网页');const origin=new URL(url).origin;if(!allowedOrigins.has(origin)){await approve('页面已跳转到新的站点，是否允许 AI 读取并继续控制：'+origin+'\n'+url);abort(signal);allowedOrigins.add(origin);}}
}
async function checkedSnapshot(tab, options) {await checkOrigin(tab,options);return snapshot(tab);}
async function delay(ms,signal){abort(signal);await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stopped);resolve();},stopped=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stopped);reject(Error('任务已停止'));},timer=setTimeout(done,ms);signal?.addEventListener('abort',stopped,{once:true});});abort(signal);}
async function settle(tab, signal, options) {
  const start=Date.now();const c=tab.view.webContents;
  while(!c.isDestroyed()&&c.isLoadingMainFrame()&&Date.now()-start<5000)await delay(80,signal);
  await checkOrigin(tab,options);const domStart=Date.now();
  while(Date.now()-domStart<1600){await checkOrigin(tab,options);let state;try{state=await isolated(tab,'globalThis.__isolaDOM.stability()');}catch(e){if(c.isLoadingMainFrame()){await delay(80,signal);continue;}throw e;}
    if(Date.now()-domStart>=450&&state.quietFor>=180&&!state.busy&&!c.isLoadingMainFrame())return {pending:false};await delay(60,signal);
  }
  return {pending:true};
}
function observation(before,after,pending){if(!before||before.url!==after.url&&before.url?.startsWith('about:'))return {summary:'已读取当前页面；没有可比较的操作前状态。',changed:null,pending};const changes=[];if(before.url!==after.url)changes.push('页面地址改变');if(before.title!==after.title)changes.push('页面标题改变');if(before.text!==after.text)changes.push('可见文字改变');if(JSON.stringify(before.scroll)!==JSON.stringify(after.scroll))changes.push('页面滚动位置改变');const state=s=>s.elements?.map(e=>({label:e.label,role:e.role,disabled:e.disabled,expanded:e.expanded,selected:e.selected,checked:e.checked,invalid:e.invalid,scroll:e.scroll,options:e.options}));if(JSON.stringify(state(before))!==JSON.stringify(state(after)))changes.push('控件或选择状态改变');const focused=s=>s.elements?.find(e=>e.focused)?.label||'';if(focused(before)!==focused(after))changes.push('焦点改变');if(JSON.stringify(before.alerts)!==JSON.stringify(after.alerts))changes.push('页面提示改变');return {summary:(changes.length?changes.join('；'):'暂未观察到页面内容或控件状态变化')+(pending?'；页面仍在更新，请等待后再次核对。':'。'),changed:changes.length>0,pending};}
async function highlight(c,rect){if(!rect||rect.width<=0||rect.height<=0)return;try{await c.debugger.sendCommand('DOM.enable');await c.debugger.sendCommand('Overlay.enable');await c.debugger.sendCommand('Overlay.highlightRect',{x:rect.x,y:rect.y,width:rect.width,height:rect.height,color:{r:49,g:137,b:255,a:0.10},outlineColor:{r:49,g:137,b:255,a:0.95}});}catch{/* Visual feedback must never prevent a valid page action. */}}
async function clearHighlight(c){try{if(!c.isDestroyed()&&c.debugger.isAttached())await c.debugger.sendCommand('Overlay.hideHighlight');}catch{/* The page may have navigated or closed. */}}
async function inputSurface(tab,signal) {
  const c=tab.view.webContents,until=Date.now()+2000;
  // A loaded DOM can precede the embedded view's first compositor frame on
  // Windows. Wait for a real frame before sending input; only this harmless
  // one-pixel read is retried, never a click or key. Nothing is saved or sent.
  while(true){
    abort(signal);if(c.isDestroyed())throw controlError('PAGE_UNAVAILABLE','当前页面已关闭');
    let timer;
    try{
      const frame=await Promise.race([c.capturePage({x:0,y:0,width:1,height:1},{stayHidden:false}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('frame timeout')),Math.max(1,until-Date.now()));})]);
      abort(signal);if(!frame.isEmpty())return;
    }catch(error){abort(signal);if(Date.now()>=until){const unavailable=controlError('INPUT_SURFACE_UNAVAILABLE','页面画面尚未就绪，请稍后重试');unavailable.cause=error;throw unavailable;}}
    finally{clearTimeout(timer);}
    if(Date.now()>=until)throw controlError('INPUT_SURFACE_UNAVAILABLE','页面画面尚未就绪，请稍后重试');
    await delay(30,signal);
  }
}
async function click(tab,x,y,signal,touch=false,verify,displayVersion) {
  const c=tab.view.webContents,point={x:Math.round(x),y:Math.round(y)};
  inputVisible(tab,signal,displayVersion);
  // Address the inspected page directly. Native window input can be dropped or
  // routed elsewhere when several Windows environments and feedback surfaces
  // are open. CDP acknowledges each event without raising background windows.
  c.focus();
  const displayPoint=mapPoint(c,point,displayVersion);
  if(!touch){await c.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...displayPoint,button:'none',buttons:0});abort(signal);}
  if(verify)await verify(point);
  inputVisible(tab,signal,displayVersion);
  let pressed=false,releaseDisplay;
  try {
    abort(signal);releaseDisplay=beginInputGesture(c,displayVersion);pressed=true;
    if(touch)await c.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[displayPoint]});
    else await c.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...displayPoint,button:'left',buttons:1,clickCount:1});
  } finally {
    // Finish a started gesture even if cancellation arrives after the press.
    // Cancellation before the press never dispatches an actionable event.
    try{if(pressed&&!c.isDestroyed()&&c.debugger.isAttached()){
        if(touch)await c.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        else await c.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...displayPoint,button:'left',buttons:0,clickCount:1});
    }}finally{releaseDisplay?.();}
  }
  abort(signal);
}
async function performAction(tab, args, {signal, approve, allowedOrigins, navigate,onProgress} = {}) {
  abort(signal); if (!args || typeof args.action !== 'string') throw Error('AI 操作格式无效');
  const c=tab.view.webContents,displayVersion=getDisplayState(c).version;
  const backgroundThrottling=c.getBackgroundThrottling();c.setBackgroundThrottling(false);
  async function allowURL(value) { const url=normalizeURL(value),origin=new URL(url).origin;if(allowedOrigins&&!allowedOrigins.has(origin)){await approve('即将访问新的站点：'+origin+'\n'+url);abort(signal);allowedOrigins.add(origin);}return url; }
  const options={allowedOrigins,approve,signal},before=tab.aiSnapshot;
  let completed=false,current={action:args.action,label:args.action==='navigate'?String(args.url||''):args.action==='scroll'?'滚动页面':args.action==='wait'?'等待页面更新':'读取页面',elementId:args.elementId||null};
  async function feedback(stage,t){if(t)current={...current,label:t.label||current.label,rect:t.rect,point:t.point,...(t.scroll?{scroll:t.scroll}:{})};try{await tab.controlFeedback?.({stage,...current});}catch{/* A closed or unavailable overlay never prevents a page action. */}}
  async function progress(stage,t){await feedback(stage,t);try{if(onProgress)await onProgress({stage,...current});}catch{/* Feedback rendering is optional. */}abort(signal);}
  async function prepare(t){await progress('preparing',t);await highlight(c,t?.rect);await delay(160,signal);await progress('acting');if(['click','type','key','scroll'].includes(args.action))inputVisible(tab,signal,displayVersion);if(['click','type','key'].includes(args.action))await inputSurface(tab,signal);}
  function verifyPointer(id,expected,url){
    const context=tab.aiContext;
    return async point=>{
      const stale=()=>controlError('ELEMENT_STALE','鼠标移入后页面或控件已改变，请重新读取页面',expected.label);
      inputVisible(tab,signal,displayVersion);
      if(c.isDestroyed()||c.getURL()!==url||c.isLoadingMainFrame()||tab.aiContext!==context)throw stale();
      let valid;
      try{valid=await isolated(tab,`(() => {
        const e=globalThis.__isolaElements?.get(${JSON.stringify(id)}),d=globalThis.__isolaDOM;
        if(!e?.isConnected)return false;
        let hit=document.elementFromPoint(${point.x},${point.y}),next;while(hit?.shadowRoot&&(next=hit.shadowRoot.elementFromPoint(${point.x},${point.y}))&&next!==hit)hit=next;
        const editable=!e.readOnly&&(e.isContentEditable||e.tagName==='TEXTAREA'||(e.tagName==='INPUT'&&['text','search','email','url','tel','number',''].includes(e.type)));
        // CDP can reorder object keys; geometry equality compares named values.
        const rect=d.rect(e),expectedRect=${JSON.stringify(expected.rect)};
        return (hit===e||!!hit&&d.parents(hit).includes(e)||hit?.control===e)&&!d.disabled(e)&&d.label(e)===${JSON.stringify(expected.label)}&&(d.closest(e,'a[href]')?.href||'')===${JSON.stringify(expected.href)}&&e.tagName===${JSON.stringify(expected.tag)}&&(e.type||'')===${JSON.stringify(expected.type)}&&(e.autocomplete||'')===${JSON.stringify(expected.autocomplete)}&&!!e.readOnly===${expected.readOnly}&&editable===${expected.editable}&&['x','y','width','height'].every(key=>rect[key]===expectedRect[key]);
      })()`);}catch(error){abort(signal);throw stale();}
      inputVisible(tab,signal,displayVersion);
      if(!valid||c.isDestroyed()||c.getURL()!==url||c.isLoadingMainFrame()||tab.aiContext!==context)throw stale();
    };
  }
  try{
  await checkOrigin(tab,options);
  if(['click','type','key','scroll'].includes(args.action))inputVisible(tab,signal,displayVersion);
  if(args.action==='inspect'){await progress('verifying');return checkedSnapshot(tab,options);}
  if(args.action==='navigate') { const url=await allowURL(args.url);await progress('preparing');await progress('acting');await navigate(url);tab.aiContext=null; }
  else if(args.action==='click'||args.action==='type') {
    const inputURL=c.getURL();
    let t=await target(tab,args.elementId,signal);abort(signal);
    if(protectedField(t))throw controlError('PROTECTED_FIELD','该控件需要你手动处理，AI 不读取或填写密码、支付凭据、验证码或上传文件',t.label);
    if(args.action==='click') {
      if(sensitiveAction(t.label))await approve('AI 准备点击：'+t.label);
      if(t.href)await allowURL(t.href);
      abort(signal);const previous=t;t=await target(tab,args.elementId,signal,{scroll:false});if(protectedField(t))throw controlError('PROTECTED_FIELD','控件已变为受保护输入，请手动处理',t.label);if(t.label!==previous.label&&sensitiveAction(t.label))throw controlError('ELEMENT_STALE','确认期间控件用途改变，请重新读取页面',t.label);if(t.href&&t.href!==previous.href)await allowURL(t.href);await prepare(t);t=await target(tab,args.elementId,signal,{scroll:false});if(protectedField(t)||t.label!==previous.label||t.href!==previous.href)throw controlError('ELEMENT_STALE','提示期间控件改变，请重新读取页面',t.label);await click(tab,t.x,t.y,signal,t.touchInput,verifyPointer(args.elementId,t,inputURL),displayVersion);await feedback('performed',t);
    } else {
      if(!t.editable)throw controlError(t.readOnly?'ELEMENT_READONLY':'ELEMENT_NOT_EDITABLE',t.readOnly?'这是只读选择器，请点击展开后选择菜单选项，或使用方向键和 Enter':'该控件不能输入文字，请选择输入框',t.label);
      if(typeof args.text!=='string'||args.text.length>5000)throw Error('输入文字无效或过长');
      await prepare(t);t=await target(tab,args.elementId,signal,{scroll:false});if(protectedField(t)||!t.editable)throw controlError('ELEMENT_STALE','提示期间输入控件改变，请重新读取页面',t.label);await click(tab,t.x,t.y,signal,t.touchInput,verifyPointer(args.elementId,t,inputURL),displayVersion);await feedback('performed',t);await delay(40,signal);
      const focused=await isolated(tab,`(() => {const e=globalThis.__isolaElements?.get(${JSON.stringify(args.elementId)});let active=document.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;return {matches:!!e&&globalThis.__isolaDOM.parents(active).includes(e),type:active?.type||'',autocomplete:active?.autocomplete||'',readOnly:!!active?.readOnly};})()`);abort(signal);if(!focused.matches)throw Error('输入控件未获得焦点，请重试');if(protectedField(focused))throw controlError('PROTECTED_FIELD','当前焦点已变为受保护输入，请手动处理');if(focused.readOnly)throw controlError('ELEMENT_READONLY','当前输入框已变为只读');
      const selectionKey={key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:process.platform==='darwin'?4:2};
      inputVisible(tab,signal,displayVersion);
      await c.debugger.sendCommand('Input.dispatchKeyEvent',{type:'rawKeyDown',...selectionKey,commands:['selectAll']});
      await c.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...selectionKey});abort(signal);
      // A site's key handler may move focus or change the control. Recheck the
      // protected-field boundary and full selection before inserting text; only
      // booleans leave the isolated world, never the existing field contents.
      const editFocus=await isolated(tab,`(() => {const e=globalThis.__isolaElements?.get(${JSON.stringify(args.elementId)}),d=globalThis.__isolaDOM,active=d.active();return {matches:!!e?.isConnected&&d.parents(active).includes(e),type:active?.type||'',autocomplete:active?.autocomplete||'',readOnly:!!active?.readOnly,disabled:d.disabled(active),selected:typeof active?.selectionStart==='number'?active.selectionStart===0&&active.selectionEnd===active.value.length:null};})()`);abort(signal);
      if(protectedField(editFocus))throw controlError('PROTECTED_FIELD','当前焦点是受保护输入，请手动处理');
      if(!editFocus.matches)throw controlError('FOCUS_CHANGED','输入焦点已改变，请重新读取页面');
      if(editFocus.readOnly)throw controlError('ELEMENT_READONLY','当前输入框已变为只读');
      if(editFocus.disabled)throw controlError('ELEMENT_DISABLED','当前输入框已变为不可用');
      if(editFocus.selected===false)throw controlError('INPUT_SELECTION_FAILED','未能选择完整输入内容，请重新核对');
      inputVisible(tab,signal,displayVersion);
      await c.debugger.sendCommand('Input.insertText',{text:args.text});
    }
  } else if(args.action==='key') {
    let sequence;try{sequence=parseKeys(args.key??args.keys??args.text);}catch(e){throw controlError('UNSUPPORTED_KEY',e.message);}
    for(const spec of sequence){
      abort(signal);
      const focus=await isolated(tab,`(() => {const d=globalThis.__isolaDOM;let e=d.active();globalThis.__isolaKeyTarget=e;return {tag:e?.tagName||'',opaque:!!e?.localName?.includes('-')&&!e?.shadowRoot,type:e?.type||'',autocomplete:e?.autocomplete||'',label:['BODY','HTML'].includes(e?.tagName)?'当前页面':d.label(e),rect:e?d.rect(e):null,readOnly:!!e?.readOnly,disabled:d.disabled(e),href:d.closest(e,'a[href]')?.href||'',menu:!!d.closest(e,'[role=listbox],[role=menu],[role=tree]')||['combobox','option','menuitem','treeitem'].includes(e?.getAttribute('role')),form:!!e?.form,search:/search|^q$|搜索/i.test([e?.type,e?.name,e?.getAttribute('aria-label'),e?.getAttribute('placeholder')].join(' '))};})()`);
      if((focus.tag==='IFRAME'||focus.opaque)&&!['Tab','Escape'].includes(spec.key))throw controlError('UNSUPPORTED_CONTEXT','当前焦点位于 iframe 或不可读取的组件，请手动处理或用 Tab 移开焦点');
      if(protectedField(focus)&&!['Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(spec.key))throw controlError('PROTECTED_FIELD','当前焦点是密码、支付凭据、验证码或上传控件，请手动处理或用 Tab 移开焦点',focus.label);
      const editing=!!spec.command&&['cut','paste','undo','redo'].includes(spec.command)||['Backspace','Delete'].includes(spec.key)||!spec.modifiers.length&&(spec.key.length===1||spec.key==='Space');
      if(focus.readOnly&&editing)throw controlError('ELEMENT_READONLY','当前控件只读，请展开选择菜单选项',focus.label);
      if(focus.disabled)throw controlError('ELEMENT_DISABLED','当前焦点控件不可用',focus.label);
      if(spec.command==='paste')await approve('AI 准备将系统剪贴板粘贴到当前网页，是否继续？');
      if(['Enter','Space'].includes(spec.key)){
        if(sensitiveAction(focus.label))await approve('AI 准备通过按键激活：'+focus.label);
        else if(spec.key==='Enter'&&focus.form&&!focus.menu&&!focus.search)await approve('AI 准备按回车，可能提交当前表单');
        if(spec.key==='Enter'&&focus.href)await allowURL(focus.href);
      }
      await prepare({...focus,label:'按键 '+spec.key+' · '+focus.label});const unchanged=await isolated(tab,`(() => {const d=globalThis.__isolaDOM,e=d.active();return e===globalThis.__isolaKeyTarget&&e?.isConnected&&(e.type||'')===${JSON.stringify(focus.type)}&&(e.autocomplete||'')===${JSON.stringify(focus.autocomplete)}&&!!e.readOnly===${focus.readOnly}&&d.disabled(e)===${focus.disabled}&&(d.closest(e,'a[href]')?.href||'')===${JSON.stringify(focus.href)}&&(['BODY','HTML'].includes(e?.tagName)?'当前页面':d.label(e))===${JSON.stringify(focus.label)};})()`);abort(signal);if(!unchanged)throw controlError('FOCUS_CHANGED','页面焦点或控件用途已改变，请重新读取后再操作');
      inputVisible(tab,signal,displayVersion);await dispatchKey(c,spec);await settle(tab,signal,options);await checkOrigin(tab,options);
    }
  } else if(args.action==='scroll') {
    const amount=Math.min(1500,Math.max(100,Number(args.amount)||600));if(!['up','down'].includes(args.direction))throw Error('滚动方向无效');
    if(args.elementId!=null&&(typeof args.elementId!=='string'||!/^e\d+-\d+$/.test(args.elementId)))throw controlError('ELEMENT_STALE','控件标识无效，已自动更新页面状态');
    const scrollTarget=await isolated(tab,`(() => {const d=globalThis.__isolaDOM,e=${args.elementId?`globalThis.__isolaElements?.get(${JSON.stringify(args.elementId)})`:'document.scrollingElement'};if(!e?.isConnected)return {stale:true};const container=d.scrollContainer(e),rect=container===document.scrollingElement?null:d.rect(container);globalThis.__isolaScrollTarget=container;globalThis.__isolaScrollStart=container.scrollTop;const start=container.scrollTop,end=Math.max(0,Math.min(container.scrollHeight-container.clientHeight,start+${args.direction==='up'?-amount:amount}));return {label:'滚动 '+d.scrollState(container).container,rect,point:rect?{x:Math.max(20,Math.min(innerWidth-24,rect.x+rect.width/2)),y:Math.max(40,Math.min(innerHeight-40,rect.y+rect.height/2))}:{x:innerWidth/2,y:innerHeight/2},scroll:{direction:${JSON.stringify(args.direction)},amount:Math.abs(end-start),from:start,to:end}};})()`);
    if(scrollTarget.stale)throw controlError('ELEMENT_STALE','滚动目标已改变，请重新读取页面');await prepare(scrollTarget);
    // Short, bounded steps make scrolling visible even when the website enables smooth scrolling.
    // Timers live in the main process so background page timer throttling cannot stall an action.
    for(let step=1;step<=6;step++){inputVisible(tab,signal,displayVersion);const fraction=1-Math.pow(1-step/6,3),next=scrollTarget.scroll.from+(scrollTarget.scroll.to-scrollTarget.scroll.from)*fraction;const scrolled=await isolated(tab,`(() => {const e=globalThis.__isolaScrollTarget;if(!e?.isConnected)return false;e.scrollTo({top:${next},behavior:'instant'});return true;})()`);if(!scrolled)throw controlError('ELEMENT_STALE','滚动容器已改变，请重新读取页面');await inputSurface(tab,signal);if(step<6)await delay(40,signal);}await feedback('performed',scrollTarget);
  } else if(args.action==='wait') {
    await progress('acting');await delay(Math.min(3000,Math.max(100,Number(args.amount)||600)),signal);
  } else throw Error('未知 AI 操作');
  await progress('verifying');const settled=await settle(tab,signal,options);let inputMatched;
  if(args.action==='type')inputMatched=await isolated(tab,`(() => {const e=globalThis.__isolaElements?.get(${JSON.stringify(args.elementId)});if(!e?.isConnected||e.type==='password'||e.type==='file'||/password|cc-|one-time-code/.test(e.autocomplete||''))return null;return (e.isContentEditable?e.innerText:e.value)===${JSON.stringify(args.text)};})()`);
  const after=await checkedSnapshot(tab,options),receipt=observation(before,after,settled.pending);if(args.action==='type'){receipt.inputMatched=inputMatched;receipt.summary=(inputMatched===true?'输入框内容与本次输入一致。':inputMatched===false?'输入框内容与本次输入不一致，需要重新核对。':'输入框已重新渲染，无法核对本次输入。')+receipt.summary;}completed=true;return {...after,observation:receipt};
  }finally{await clearHighlight(c);if(!completed)await feedback('clear');if(!c.isDestroyed())c.setBackgroundThrottling(backgroundThrottling);}
}
module.exports={snapshot,checkedSnapshot,performAction,sensitiveAction,isolated,target};
