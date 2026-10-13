'use strict';
const assert=require('node:assert/strict');
module.exports=async function navigationSmoke(api,check){
 const {dialog,powerMonitor}=require('electron');
 assert.ok(process.env.ISOLA_TEST_DATA,'Requires isolated QA data');
 const url='https://navigation-fixture.invalid/draft',html=`<!doctype html><title>Navigation fixture</title><input id="draft" aria-label="Draft" style="margin:20px;width:300px;height:40px"><script>window.dirty=false;addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});</script>`;
 let profile,w,session,choice=0,asked=0,options,engine,originalPlans,holdNext=false,slowStarted=false,releaseSlow=null;
 const originalDialog=dialog.showMessageBoxSync;
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(fn)=>{const end=Date.now()+8000;while(!fn()){if(Date.now()>end)throw Error('Navigation fixture timed out');await wait(20);}};
 const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Stop did not finish within 2 seconds')),2000);})]);}finally{clearTimeout(timer);}};
 const invoke=(action,value)=>w.webContents.executeJavaScript(`window.browser.navigate(${JSON.stringify(action)},${JSON.stringify(value)})`);
 const dirty=async c=>{c.focus();c.sendInputEvent({type:'mouseDown',x:50,y:40,button:'left',clickCount:1});c.sendInputEvent({type:'mouseUp',x:50,y:40,button:'left',clickCount:1});await c.executeJavaScript(`dirty=true;document.querySelector('#draft').value='keep this draft'`,true);};
 try{
  dialog.showMessageBoxSync=(_,input)=>{asked++;options=input;return choice;};
  profile=api.saveProfile({name:'QA navigation safety',url,fingerprintMode:'native'});session=api.sesFor(profile);
  session.protocol.handle('https',()=>{const response=()=>new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}});if(holdNext){holdNext=false;slowStarted=true;return new Promise(resolve=>{releaseSlow=()=>resolve(response());});}return response();});
  await api.launch(profile.id);w=api.windows.get(profile.id);w.show();w.focus();let tab=w.tabs[0],c=tab.view.webContents;
  for(const action of ['go','reload'])await check(`navigation Stop cancels pending ${action} without waiting for slow response`,async()=>{
   holdNext=true;slowStarted=false;const navigation=invoke(action,action==='go'?url+'?slow=1':undefined);
   try{await until(()=>slowStarted);assert.equal(w.navigationPending,true);await bounded(invoke('stop'));await bounded(navigation);assert.equal(w.navigationPending,false);assert.equal(c.isLoading(),false);assert.equal(c.getURL(),url);assert.equal(tab.url,url);assert.doesNotMatch(tab.error,/ERR_ABORTED|超时/);}
   finally{releaseSlow?.();releaseSlow=null;holdNext=false;await navigation.catch(()=>{});}
  });
  await check('navigation Stop also cancels a request waiting for draft cleanup',async()=>{
   const controller=new AbortController();w.vintedDraftController=controller;let cleaned=false;
   controller.signal.addEventListener('abort',()=>setTimeout(()=>{cleaned=true;w.vintedDraftController=null;},70));
   const navigation=invoke('go',url+'?must-not-load=1');await until(()=>w.navigationPending);await bounded(invoke('stop'));await bounded(navigation);assert.equal(cleaned,true);assert.equal(c.getURL(),url);assert.equal(w.navigationPending,false);
  });
  await check('navigation reload Keep preserves beforeunload draft without ERR_ABORTED error',async()=>{
   await dirty(c);choice=0;const before=asked;await invoke('reload');assert.equal(asked,before+1);assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);assert.equal(c.getURL(),url);assert.equal(tab.url,url);assert.equal(await c.executeJavaScript(`document.querySelector('#draft').value`),'keep this draft');assert.doesNotMatch(tab.error,/ERR_ABORTED/);assert.match(tab.error,/保留/);
  });
  await check('navigation reload explicit Leave permits unload in WebContentsView',async()=>{
   choice=1;await invoke('reload');assert.equal(await c.executeJavaScript(`document.querySelector('#draft').value`),'');assert.equal(tab.error,'');assert.equal(c.getURL(),url);
  });
  await check('automated navigation cannot discard dirty draft or accept native dialog',async()=>{
   await dirty(c);choice=1;const before=asked;w.aiAgent.state.running=true;
   try{await assert.rejects(c.loadURL(url+'?other=1'));assert.equal(asked,before);assert.equal(c.getURL(),url);assert.equal(await c.executeJavaScript(`document.querySelector('#draft').value`),'keep this draft');}finally{w.aiAgent.state.running=false;}
  });
  await check('AI start awaits draft cancellation cleanup before beginning a new action',async()=>{
   const controller=new AbortController();w.vintedDraftController=controller;let cleaned=false;const originalStart=w.aiAgent.start;
   controller.signal.addEventListener('abort',()=>setTimeout(()=>{cleaned=true;w.vintedDraftController=null;},50));
   w.aiAgent.start=async()=>{assert.equal(cleaned,true);assert.equal(w.vintedDraftController,null);return 'fixture AI start';};
   try{assert.equal(await w.webContents.executeJavaScript(`window.browser.aiStart('fixture')`),'fixture AI start');assert.equal(controller.signal.aborted,true);}finally{w.aiAgent.start=originalStart;w.vintedDraftController=null;}
  });
  await check('tab switching waits for draft cancellation while retaining original content',async()=>{
   await invoke('new');const second=w.activeTab;await invoke('switch',tab.id);
   const controller=new AbortController();w.vintedDraftController=controller;let cleaned=false;
   controller.signal.addEventListener('abort',()=>setTimeout(()=>{cleaned=true;w.vintedDraftController=null;},50));
   await invoke('switch',second);assert.equal(cleaned,true);assert.equal(w.activeTab,second);assert.equal(await c.executeJavaScript(`document.querySelector('#draft').value`),'keep this draft');await invoke('switch',tab.id);
  });
  await check('tab close Keep retains WebContentsView and Leave removes it after unload',async()=>{
   choice=0;await invoke('close',tab.id);assert.equal(c.isDestroyed(),false);assert.ok(w.tabs.includes(tab));choice=1;await invoke('close',tab.id);assert.equal(c.isDestroyed(),true);assert.equal(w.tabs.includes(tab),false);assert.equal(w.tabs.length,1);
   tab=w.tabs[0];c=tab.view.webContents;await invoke('go',url);
  });
  await check('late WebContents destruction after close timeout removes stale tab and selects live neighbor',async()=>{
   await invoke('new');const late=w.tabs.find(t=>t.id===w.activeTab),lateContents=late.view.webContents,originalClose=lateContents.close,originalTimeout=global.setTimeout;let called=false;
   lateContents.close=()=>{called=true;};
   global.setTimeout=(fn,ms,...args)=>originalTimeout(fn,ms===15000?60:ms,...args);
   try{await invoke('close',late.id);assert.equal(called,true);assert.equal(lateContents.isDestroyed(),false);assert.ok(w.tabs.includes(late));}
   finally{global.setTimeout=originalTimeout;lateContents.close=originalClose;}
   originalClose.call(lateContents,{waitForBeforeUnload:true});await until(()=>!w.tabs.includes(late));assert.equal(lateContents.isDestroyed(),true);assert.equal(w.activeTab,tab.id);assert.equal(c.isDestroyed(),false);assert.equal(w.isDestroyed(),false);
  });
  await check('sleep aborts draft ownership before any later input',async()=>{
   const controller=new AbortController();w.vintedDraftController=controller;controller.signal.addEventListener('abort',()=>{w.vintedDraftController=null;});powerMonitor.emit('suspend');assert.equal(controller.signal.aborted,true);assert.equal(w.vintedDraftController,null);
  });
  await check('open listing IPC keeps existing page and reuses exact form tab without reload',async()=>{
   engine=api.getCommerce();originalPlans=engine.db.plans.slice();engine.db.plans.push({id:'qa-navigation-plan',profileId:profile.id,productId:'qa-nav',sku:'QA-NAV'});
   await api.openCommerce();const desk=api.getCommerceWindow().webContents;
   const open=()=>desk.executeJavaScript(`window.commerce.openListing('qa-navigation-plan')`);
   const oldTab=tab,oldCount=w.tabs.length;let result=await open();assert.equal(result.profileId,profile.id);assert.equal(result.url,'https://www.vinted.fr/items/new');assert.equal(w.tabs.length,oldCount+1);assert.ok(w.tabs.includes(oldTab));const form=w.tabs.find(t=>t.id===w.activeTab);await form.view.webContents.executeJavaScript(`window.marker='preserved'`);result=await open();assert.equal(w.tabs.length,oldCount+1);assert.equal(await form.view.webContents.executeJavaScript('window.marker'),'preserved');
   engine.db.plans=originalPlans;originalPlans=null;
  });
  await check('active listing IPC opens only a matching stored receipt in its profile and preserves other tabs',async()=>{
   engine=api.getCommerce();const plans=engine.db.plans.slice(),claims=engine.db.claims.slice();
   const plan={id:'qa-active-listing',profileId:profile.id,productId:'qa-nav',sku:'QA-NAV',activeListingId:'123456'},receipt={listingId:'123456',url:'https://www.vinted.fr/items/123456-fixture'};
   engine.db.plans.push(plan);engine.db.claims.push({id:'qa-nav-claim',profileId:profile.id,productId:plan.productId,listings:[receipt]});
   try{await api.openCommerce();const desk=api.getCommerceWindow().webContents,open=()=>desk.executeJavaScript(`window.commerce.openActiveListing('qa-active-listing')`),before=w.tabs.slice();
    const result=await open();assert.equal(result.profileId,profile.id);assert.equal(result.url,receipt.url);assert.equal(w.tabs.length,before.length+1);assert.ok(before.every(tab=>w.tabs.includes(tab)));
    const current=w.tabs.find(tab=>tab.id===w.activeTab);await current.view.webContents.executeJavaScript(`window.listingMarker='preserved'`);await open();assert.equal(w.tabs.length,before.length+1);assert.equal(await current.view.webContents.executeJavaScript('window.listingMarker'),'preserved');
    receipt.url='https://outside-fixture.invalid/items/123456';await assert.rejects(open(),/没有可核对/);assert.equal(w.tabs.length,before.length+1);
   }finally{engine.db.plans=plans;engine.db.claims=claims;}
  });
  await check('window close Keep preserves draft and close completion waits for actual destruction',async()=>{
   const active=w.tabs.find(t=>t.id===w.activeTab);await dirty(active.view.webContents);choice=0;w.close();await until(()=>!w.closingPromise);assert.equal(w.isDestroyed(),false);assert.ok(api.windows.has(profile.id));choice=1;w.close();await until(()=>w.isDestroyed());assert.equal(api.windows.has(profile.id),false);
  });
 }finally{
  releaseSlow?.();releaseSlow=null;holdNext=false;
  if(engine&&originalPlans)engine.db.plans=originalPlans;
  choice=1;if(w&&!w.isDestroyed()){w.vintedDraftController=null;w.aiAgent.state.running=false;w.close();await until(()=>w.isDestroyed());}
  dialog.showMessageBoxSync=originalDialog;
  if(session)session.protocol.unhandle('https');
  if(profile&&!api.windows.has(profile.id))await api.deleteProfile(profile.id);
 }
};
