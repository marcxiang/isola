const {problem}=require('./commerce-engine.cjs');
const ORIGIN='https://www.vinted.fr';
const MENU_LABELS=['Mon profil','Paramètres','Mes commandes','Se déconnecter'];
const norm=value=>String(value||'').replace(/\s+/g,' ').trim();
const stopped=()=>problem('STOPPED','账号核验已停止');

function memberURL(value){
  let url;try{url=new URL(value);}catch{throw problem('ACCOUNT_UNVERIFIED','账号菜单的个人主页地址无效');}
  const match=/^\/member\/([1-9]\d*)(?:-[^/]+)?\/?$/.exec(url.pathname);
  if(url.origin!==ORIGIN||url.username||url.password||url.search||url.hash||!match)throw problem('ACCOUNT_UNVERIFIED','账号菜单的个人主页地址不属于法国 Vinted');
  return {memberId:match[1],profileURL:ORIGIN+'/member/'+match[1]};
}

// Read only nodes from the current trusted snapshot, plus their descendants and
// ancestors. A random profile link elsewhere in the document proves no account.
function probeAccountDOM(buttonIds,menuIds){
  const d=globalThis.__isolaDOM,map=globalThis.__isolaElements,clean=v=>String(v||'').replace(/\s+/g,' ').trim();
  const visible=e=>!!e?.isConnected&&d.visible(e);
  const broad=e=>!e||['HTML','BODY','HEADER','NAV','MAIN','FORM'].includes(e.tagName)||['navigation','main'].includes(e.getAttribute?.('role'));
  const nodes=menuIds.map(item=>({...item,node:map?.get(item.id)})).filter(item=>visible(item.node)&&clean(d.label(item.node))===item.label);
  const buttons=[];
  for(const id of buttonIds){
    const e=map?.get(id);if(!visible(e)||e.tagName!=='BUTTON'||d.disabled(e)||d.closest(e,'a[href],form')||!d.closest(e,'header,nav,[role=navigation]'))continue;
    const r=e.getBoundingClientRect();if(r.top<0||r.top>Math.min(300,innerHeight*0.45)||r.bottom>innerHeight||r.right<=0||r.left>=innerWidth)continue;
    if(clean(e.getAttribute('aria-label'))||clean(d.safeText(e,180)))continue;
    const imgs=[...e.querySelectorAll('img')].filter(visible),usernames=imgs.map(img=>clean(img.getAttribute('alt')));
    if(imgs.length!==1||!usernames[0]||usernames[0].length>100||/[\u0000-\u001f\u007f]/.test(usernames[0]))continue;
    buttons.push({id,node:e,username:usernames[0],expanded:e.getAttribute('aria-expanded')});
  }
  const summaries=buttons.map(({id,username,expanded})=>({id,username,expanded}));
  if(buttons.length!==1)return {documentKey:String(performance.timeOrigin),buttons:summaries,menus:[],visibleMenuParts:nodes.length};
  const button=buttons[0],menus=[];
  for(const profile of nodes.filter(item=>item.label==='Mon profil')){
    const roots=d.parents(profile.node).filter(root=>!broad(root)&&visible(root));
    const root=roots.find(root=>['Mon profil','Paramètres','Mes commandes','Se déconnecter'].every(label=>nodes.some(item=>item.label===label&&root.contains(item.node))));
    if(!root)continue;
    const rows=nodes.filter(item=>root.contains(item.node));
    if(['Mon profil','Paramètres','Mes commandes','Se déconnecter'].some(label=>rows.filter(item=>item.label===label).length!==1)){menus.push({valid:false,reason:'ambiguous-menu'});continue;}
    if(profile.node.tagName!=='A'||!profile.node.href){menus.push({valid:false,reason:'invalid-profile-link'});continue;}
    const controls=clean(button.node.getAttribute('aria-controls')).split(' '),labels=clean(root.getAttribute('aria-labelledby')).split(' ');
    const explicitlyOwned=!!root.id&&controls.includes(root.id)||!!button.node.id&&labels.includes(button.node.id);
    const common=d.parents(root).find(p=>!broad(p)&&p.contains(button.node)&&d.closest(p,'header,nav,[role=navigation]'));
    const locallyOwned=!!common&&buttons.filter(item=>common.contains(item.node)).length===1&&!common.querySelector('input,textarea,select,form,main')&&[...common.querySelectorAll('button,a[href]')].every(e=>e===button.node||root.contains(e));
    const owned=(explicitlyOwned||locallyOwned)&&button.expanded!=='false';
    menus.push({valid:owned,reason:owned?'':'unrelated-menu',href:String(profile.node.href),association:explicitlyOwned?'aria':'local-header-container'});
  }
  return {documentKey:String(performance.timeOrigin),buttons:summaries,menus,visibleMenuParts:nodes.length};
}

class VintedAccount {
  constructor(adapter,{timeoutMs=10000,menuWaitMs=3000,pollIntervalMs=100}={}){
    if(!adapter?.current||!adapter?.read||!adapter?.control)throw new TypeError('VintedAdapter is required');
    this.adapter=adapter;this.timeoutMs=Math.max(20,Math.min(10000,timeoutMs));this.menuWaitMs=Math.max(0,Math.min(3000,menuWaitMs));this.pollIntervalMs=Math.max(10,Math.min(200,pollIntervalMs));
  }
  async bounded(task,context){
    if(context.signal.aborted)throw stopped();
    let timer,onAbort;
    const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(stopped());context.signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>{reject(problem('ACCOUNT_TIMEOUT','账号页面没有及时响应，已停止核验'));context.controller.abort();},this.timeoutMs);});
    try{return await Promise.race([Promise.resolve().then(task),cancelled]);}finally{clearTimeout(timer);context.signal.removeEventListener('abort',onAbort);}
  }
  async state(profileId,context,expected){
    const page=await this.bounded(()=>this.adapter.read(profileId,context),context);this.adapter.current(profileId,context);
    const buttons=page.elements.filter(e=>e.tag==='button'&&!e.disabled&&!e.sensitive).map(e=>e.id);
    const menus=page.elements.filter(e=>['a','button'].includes(e.tag)&&!e.sensitive&&MENU_LABELS.includes(norm(e.label))).map(e=>({id:e.id,label:norm(e.label)}));
    const state=await this.bounded(()=>this.adapter.control.isolated(context.tab,'('+probeAccountDOM.toString()+')('+JSON.stringify(buttons)+','+JSON.stringify(menus)+')'),context);this.adapter.current(profileId,context);
    if(!state||typeof state.documentKey!=='string'||!state.documentKey||!Array.isArray(state.buttons)||!Array.isArray(state.menus))throw problem('ACCOUNT_UNVERIFIED','账号页面结构无法核对');
    if(expected&&state.documentKey!==expected.documentKey)throw problem('PAGE_CHANGED','账号页面已重新加载，核验已停止');
    if(state.buttons.length!==1)throw problem('ACCOUNT_UNVERIFIED',state.buttons.length?'页面存在多个头像按钮，无法确定当前账号':'未找到唯一的顶部账号头像按钮');
    if(expected&&state.buttons[0].username!==expected.username)throw problem('ACCOUNT_CHANGED','核验过程中账号头像已改变');
    const button=state.buttons[0];state.button=button;state.clickable=page.elements.find(e=>e.id===button.id)?.clickable!==false;
    if(state.menus.length){
      if(state.menus.length!==1||!state.menus[0].valid)throw problem('ACCOUNT_UNVERIFIED','个人主页链接无法唯一关联当前账号菜单');
      state.account={...memberURL(state.menus[0].href),username:button.username,association:state.menus[0].association};
    }
    return state;
  }
  async inspectAccount(profileId,{signal,controller:providedController,tab:providedTab}={}){
    const controller=providedController||new AbortController();
    if(!controller?.signal||typeof controller.abort!=='function')throw new TypeError('AbortController is required');
    const cancel=()=>controller.abort();if(signal?.aborted)throw stopped();signal?.addEventListener('abort',cancel,{once:true});
    const context={signal:controller.signal,controller,tab:providedTab};
    let w,contents,ownsLock=false,menuOpened=false,menuOpenAttempted=false;
    const changed=()=>controller.abort(),navigated=(_event,_url,_inPlace,mainFrame)=>{if(mainFrame!==false)changed();};
    try{
      const selected=this.adapter.current(profileId,context);w=selected.w;context.tab=selected.tab;contents=selected.tab.view.webContents;
      ownsLock=w.vintedDraftController!==controller;if(ownsLock)w.vintedDraftController=controller;
      contents.on?.('did-start-navigation',navigated);contents.on?.('destroyed',changed);contents.on?.('render-process-gone',changed);
      const guard=()=>this.adapter.current(profileId,context);
      let state=await this.state(profileId,context),expected={documentKey:state.documentKey,username:state.button.username};
      if(!state.account){
        if(state.visibleMenuParts||state.button.expanded==='true')throw problem('ACCOUNT_UNVERIFIED','已有菜单无法核对，未再次点击账号按钮');
        if(!state.clickable)throw problem('ACCOUNT_UNVERIFIED','账号头像按钮不可点击，请先关闭遮挡');
        guard();menuOpenAttempted=true;
        await this.bounded(()=>this.adapter.control.performAction(context.tab,{action:'click',elementId:state.button.id},this.adapter.options(context.signal,guard)),context);guard();
        const until=Date.now()+this.menuWaitMs;
        do{
          state=await this.state(profileId,context,expected);if(state.account){menuOpened=true;break;}
          if(Date.now()>=until)throw problem('ACCOUNT_UNVERIFIED','打开账号菜单后没有取得唯一个人主页回执');
          await this.bounded(()=>new Promise(resolve=>setTimeout(resolve,this.pollIntervalMs)),context);
        }while(true);
      }
      const confirmed=await this.state(profileId,context,expected);
      if(!confirmed.account||confirmed.account.memberId!==state.account.memberId||confirmed.account.profileURL!==state.account.profileURL)throw problem('ACCOUNT_CHANGED','两次读取的账号回执不一致');
      guard();
      return {verified:true,site:ORIGIN,memberId:confirmed.account.memberId,username:confirmed.account.username,profileURL:confirmed.account.profileURL,documentKey:expected.documentKey,menuOpened,menuClosed:false,evidence:{kind:'current-account-menu',association:confirmed.account.association,consistentReads:2},message:'已核对当前窗口的账号菜单；菜单保持展开，未打开个人主页或改动商品表单。'};
    }catch(error){error.accountMenuOpened=menuOpened?true:menuOpenAttempted?null:false;error.accountMenuOpenAttempted=menuOpenAttempted;error.accountMenuClosed=false;throw error;}
    finally{
      signal?.removeEventListener('abort',cancel);contents?.removeListener?.('did-start-navigation',navigated);contents?.removeListener?.('destroyed',changed);contents?.removeListener?.('render-process-gone',changed);
      if(ownsLock&&w?.vintedDraftController===controller)w.vintedDraftController=null;
    }
  }
}
module.exports={VintedAccount,memberURL};
