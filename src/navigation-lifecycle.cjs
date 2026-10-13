'use strict';

async function stopDraft(window, {timeoutMs=15000,pollMs=20}={}) {
  const until=Date.now()+timeoutMs;
  while(window.vintedDraftController) {
    window.vintedDraftController.abort();
    if(Date.now()>=until)throw Error('商品填写仍在停止，请等待当前步骤结束后重试。页面已保留。');
    await new Promise(resolve=>setTimeout(resolve,pollMs));
  }
}

function installUnloadGuard(window,tab,{showMessageBoxSync,onState,isAutomating}) {
  const contents=tab.view.webContents;
  let intent=null,expiry=null,cancelClose=null;
  const guard={blocked:false,reason:'',
    begin(action){clearTimeout(expiry);const request={action};intent=request;guard.blocked=false;guard.reason='';expiry=setTimeout(()=>{if(intent===request)intent=null;},30000);expiry.unref?.();return ()=>{if(intent===request){intent=null;clearTimeout(expiry);}};},
    onCloseCancelled(fn){cancelClose=fn;return ()=>{if(cancelClose===fn)cancelClose=null;};},
    dispose(){clearTimeout(expiry);intent=null;cancelClose=null;}
  };
  contents.on('will-prevent-unload',event=>{
    const action=intent?.action;intent=null;clearTimeout(expiry);
    const automated=isAutomating();
    // Electron requires this decision synchronously. preventDefault means DISCARD.
    const canAsk=!window.isDestroyed()&&!automated&&(!!action||window.isFocused());
    let leave=false;
    if(canAsk){
      const verb=action==='reload'?'重新加载':action==='close'?'关闭页面':'离开页面';
      try{
        const answer=showMessageBoxSync(window,{type:'warning',title:'保留尚未保存的内容？',message:`${verb}可能丢失当前页面尚未保存的内容。`,detail:'选择“保留当前页面”可继续检查或保存商品。只有选择右侧按钮才会放弃本页内容。',buttons:['保留当前页面',`${verb}并放弃未保存内容`],defaultId:0,cancelId:0,noLink:true});
        leave=answer===1;
      }catch{leave=false;}
    }
    if(leave){guard.blocked=false;guard.reason='';event.preventDefault();return;}
    guard.blocked=true;
    guard.reason=automated?'页面有未保存内容，自动操作未离开当前页面。请手动保存，或通过工具栏确认离开。':'已保留当前页面和未保存内容。';
    tab.url=contents.getURL();tab.error=guard.reason;tab.loading=false;onState();cancelClose?.();
  });
  contents.on('did-navigate',()=>{intent=null;clearTimeout(expiry);guard.blocked=false;guard.reason='';});
  contents.once('destroyed',()=>guard.dispose());
  return guard;
}

function closeContents(tab,{timeoutMs=15000}={}) {
  const contents=tab.view.webContents;
  if(contents.isDestroyed())return Promise.resolve(true);
  return new Promise((resolve,reject)=>{
    let timer,settled=false,removeCancel=()=>{},endIntent=()=>{};
    const done=(value,error)=>{if(settled)return;settled=true;clearTimeout(timer);removeCancel();endIntent();contents.removeListener('destroyed',destroyed);if(error)reject(error);else resolve(value);};
    const destroyed=()=>done(true);
    contents.once('destroyed',destroyed);
    removeCancel=tab.unloadGuard.onCloseCancelled(()=>done(false));
    endIntent=tab.unloadGuard.begin('close');
    timer=setTimeout(()=>done(false),timeoutMs);
    try{contents.close({waitForBeforeUnload:true});}catch(error){done(false,error);}
  });
}

module.exports={stopDraft,installUnloadGuard,closeContents};
