'use strict';

const failure=(code,message)=>Object.assign(Error(message),{code});
function salesNavigationURL(value,target){
 try{
  const goal=new URL(target),url=new URL(value);
  if(goal.origin!=='https://www.vinted.fr'||goal.username||goal.password||goal.search||goal.hash||!/^\/(?:member\/[1-9]\d*|items\/new)$/.test(goal.pathname))return null;
  if(url.origin!==goal.origin||url.username||url.password||url.hash)return null;
  if(value===target)return 'target';
  if(url.pathname!=='/session-refresh'||[...url.searchParams.keys()].length!==1||url.searchParams.getAll('ref_url').length!==1)return null;
  const ref=url.searchParams.get('ref_url');
  return ref===goal.pathname||ref===target?'refresh':null;
 }catch{return null;}
}
const aborted=error=>error?.code==='ERR_ABORTED'||error?.errno===-3;

// This is only for a newly created, owned preflight tab. It never reloads a
// document, retries a submission, or treats an arbitrary ERR_ABORTED as success.
function loadSalesPage({contents,target,signal,guard,readError=()=>'',onMonitor=()=>{},timeoutMs=30000,settleMs=600,pollMs=40}){
 if(salesNavigationURL(target,target)!=='target')return Promise.reject(failure('PAGE_CHANGED','后台页面地址不受支持'));
 return new Promise((resolve,reject)=>{
  let done=false,timer,deadline,stableAt=0,finished=false,loadSettled=false,loadAborted=false,abortAt=0,sawRefresh=false,started=false;
  const listeners=[];
  const finish=error=>{
   if(done)return;done=true;clearTimeout(timer);clearTimeout(deadline);
   for(const [name,fn] of listeners)contents.removeListener(name,fn);
   signal?.removeEventListener('abort',cancel);onMonitor(null);
   if(error)reject(error);else resolve({url:target,sessionRefreshed:sawRefresh});
  };
  const valid=()=>{
   guard();if(signal?.aborted)throw failure('STOPPED','后台开页已停止');
   if(contents.isDestroyed())throw failure('PAGE_CHANGED','后台标签页已关闭');
   const error=readError();if(error)throw failure('PAGE_CHANGED','后台页面加载失败：'+error);
  };
  const cancel=()=>finish(failure('STOPPED','后台开页已停止'));
  const listen=(name,fn)=>{contents.on(name,fn);listeners.push([name,fn]);};
  const check=()=>{
   if(done)return;clearTimeout(timer);
   try{
    valid();const url=contents.getURL(),kind=salesNavigationURL(url,target),loading=contents.isLoadingMainFrame();
    if(!kind&&!(url===''||url==='about:blank'))throw failure('PAGE_CHANGED','后台页面转到了登录或非预期地址，请核对当前页面');
    if(loadAborted&&!sawRefresh&&Date.now()-abortAt>=settleMs)throw failure('PAGE_CHANGED','后台页面导航被中止，未观察到返回原页面的会话刷新');
    if(started&&loadSettled&&(!loadAborted||sawRefresh)&&finished&&kind==='target'&&!loading){
     if(!stableAt)stableAt=Date.now();
     if(Date.now()-stableAt>=settleMs){valid();return finish();}
    }else stableAt=0;
    timer=setTimeout(check,pollMs);
   }catch(error){finish(error);}
  };
  const navigation=(event,url,inPlace,isMain)=>{
   if((event?.isMainFrame??isMain)!==true)return;
   try{
    valid();const kind=salesNavigationURL(event?.url??url,target),sameDocument=event?.isSameDocument??inPlace;
    if(!kind||sameDocument&&kind!=='target'){event?.preventDefault?.();throw failure('PAGE_CHANGED','后台页面转到了登录或非预期地址，请核对当前页面');}
    if(kind==='refresh')sawRefresh=true;
    started=true;if(!sameDocument)finished=false;stableAt=0;
   }catch(error){finish(error);}
  };
  const committed=(event,url)=>navigation({...event,isMainFrame:true},event?.url??url,false,true);
  const failed=(_event,code,description,_url,isMain)=>{
   if(isMain!==true||code===-3)return;
   finish(failure('PAGE_CHANGED','后台页面加载失败：'+description));
  };
  try{
   valid();
   listen('did-start-navigation',navigation);listen('will-redirect',navigation);listen('did-redirect-navigation',navigation);
   listen('did-navigate',committed);listen('did-navigate-in-page',(event,url,isMain)=>navigation({...event,isSameDocument:true},url,true,isMain));
   listen('did-finish-load',()=>{finished=contents.getURL()===target;stableAt=0;check();});
   listen('did-fail-load',failed);listen('did-stop-loading',check);
   listen('destroyed',()=>finish(failure('PAGE_CHANGED','后台标签页已关闭')));
   listen('render-process-gone',()=>finish(failure('PAGE_CHANGED','后台页面进程退出，请重新打开环境')));
   signal?.addEventListener('abort',cancel,{once:true});
   onMonitor({rejectNewWindow:()=>finish(failure('PAGE_CHANGED','后台开页期间请求打开其他标签，已暂停'))});
   deadline=setTimeout(()=>finish(failure('PAGE_CHANGED','后台页面未在 30 秒内返回并完成加载，请检查登录状态和网络')),timeoutMs);
   Promise.resolve(contents.loadURL(target)).then(()=>{loadSettled=true;check();},error=>{
    if(done)return;
    if(!aborted(error))return finish(failure('PAGE_CHANGED','后台页面加载失败：'+error.message));
    loadSettled=true;loadAborted=true;abortAt=Date.now();check();
   });
   check();
  }catch(error){finish(error);}
 });
}

module.exports={salesNavigationURL,loadSalesPage};
