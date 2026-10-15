'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');

module.exports=async function workspaceShellSmoke(api,check){
 const {BrowserWindow,WebContentsView}=require('electron');assert.ok(process.env.ISOLA_TEST_DATA,'Workspace smoke requires isolated app data');
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),until=async(predicate,label)=>{const stop=Date.now()+8000;while(Date.now()<stop){if(await predicate())return;await sleep(25);}throw Error('Timed out: '+label);};
 const engine=api.getCommerce(),originalBackground=engine.db.settings.backgroundEnabled;
 const fixtureDir=path.join(process.env.ISOLA_TEST_DATA,'workspace-shell-fixture');fs.mkdirSync(fixtureDir,{recursive:true});
 const preload=path.join(fixtureDir,'untrusted-preload.cjs');fs.writeFileSync(preload,"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('untrusted',{invoke:(...args)=>ipcRenderer.invoke(...args)});");
 const server=http.createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Independent browser environment</title><input id="fixture" value="independent">');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let manager=api.getManager(),view,wrong,p,browser;const originalBounds=manager.getBounds();
 const homeJS=code=>api.getManager().webContents.executeJavaScript(code),deskJS=code=>api.getCommerceView().webContents.executeJavaScript(code);
 try{
  await api.showEnvironmentManager();
  await check('environment manager and operations share one real BrowserWindow and one sandboxed commerce view',async()=>{
   const before=BrowserWindow.getAllWindows().map(w=>w.id).sort();await Promise.all([api.openCommerce(),api.openCommerce(),api.openCommerce()]);view=api.getCommerceView();
   assert.ok(view instanceof WebContentsView);assert.equal(api.getManager(),manager);assert.deepEqual(BrowserWindow.getAllWindows().map(w=>w.id).sort(),before);assert.ok(manager.contentView.children.includes(view));assert.equal(view.getVisible(),true);assert.equal(api.getWorkspacePage(),'commerce');
   const prefs=view.webContents.getLastWebPreferences();assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
   assert.deepEqual(await deskJS('({node:typeof require,manager:typeof window.isola,commerce:typeof window.commerce.state})'),{node:'undefined',manager:'undefined',commerce:'function'});
   assert.deepEqual(await homeJS('({node:typeof require,manager:typeof window.isola.list,commerce:typeof window.commerce})'),{node:'undefined',manager:'function',commerce:'undefined'});
   return {sameBrowserWindow:true,oneCommerceView:true,sandbox:true};
  });
  await check('both directions use the sidebar while keeping environment filters and an unsaved operations form',async()=>{
   await deskJS(`document.querySelector('#workspace-environments').click();true`);await until(()=>api.getWorkspacePage()==='environments','home sidebar switch');
   await homeJS(`document.querySelector('#search').value='shell retained search';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#commerce-open').click();document.querySelector('[data-commerce-page="overview"]').click();true`);await until(()=>api.getWorkspacePage()==='commerce','operations sidebar switch');
   await deskJS(`document.querySelector('[data-page="settings"]').click();const form=document.querySelector('#settings-form');form.elements.baseURL.value='http://127.0.0.1:9/unsaved-shell';form.dispatchEvent(new Event('input',{bubbles:true}));true`);
   await deskJS('window.commerce.showEnvironments()');assert.equal(view.getVisible(),false);assert.equal(view.webContents.isDestroyed(),false);assert.equal(await homeJS('document.querySelector("#search").value'),'shell retained search');
   await homeJS('window.isola.openCommerce()');assert.equal(api.getCommerceView(),view);assert.equal(await deskJS('document.querySelector("#settings-form").elements.baseURL.value'),'http://127.0.0.1:9/unsaved-shell');assert.equal(await deskJS('document.querySelector("#page-settings").hidden'),false);
   return {homeFilterPreserved:true,unsavedFormPreserved:true,noReload:true};
  });
  await check('workspace page navigation accepts only stored routes and preserves hidden environment drafts',async()=>{
   const before=BrowserWindow.getAllWindows().length;
   await api.showEnvironmentManager();await homeJS(`document.querySelector('#new').click();document.querySelector('#form').elements.name.value='unsaved workspace environment';true`);
   for(const page of ['accounts','overview','inventory','plans','jobs','settings']){const visiblePage=page==='accounts'?'plans':page;await homeJS(`window.isola.openCommerce(${JSON.stringify(page)})`);await until(()=>deskJS(`document.querySelector('#page-${visiblePage}').hidden===false`),'route '+page);if(page==='accounts')assert.equal(await deskJS('document.querySelector("#automation-environment-detail").hidden'),true);assert.equal(api.getCommerceView(),view);}
   const menuRoutes=await deskJS('Array.from(document.querySelectorAll("#workspace-commerce-menu [data-page]"),button=>button.dataset.page)');assert.equal(menuRoutes.length,5);assert.deepEqual(new Set(menuRoutes),new Set(['overview','inventory','plans','jobs','settings']));
   await deskJS(`document.querySelector('#workspace-commerce-toggle').click();true`);assert.equal(await deskJS(`document.querySelector('#workspace-commerce-menu').hidden`),true);await homeJS(`window.isola.openCommerce('accounts')`);await until(()=>deskJS(`document.querySelector('#page-plans').hidden===false&&document.querySelector('#automation-environment-detail').hidden===true`),'legacy account route opens environment list');assert.equal(await deskJS(`document.querySelector('#workspace-commerce-menu').hidden`),false);
   for(const page of ['',null,{},'../index.html','__proto__','https://outside.invalid/'])await assert.rejects(homeJS(`window.isola.openCommerce(${JSON.stringify(page)})`),/运营页面无效/);
   assert.equal(api.getCommerceView(),view);assert.equal(BrowserWindow.getAllWindows().length,before);await api.showEnvironmentManager();assert.equal(await homeJS(`document.querySelector('#editor').hidden`),false);assert.equal(await homeJS(`document.querySelector('#form').elements.name.value`),'unsaved workspace environment');await homeJS(`document.querySelector('#cancel').click();true`);
   return {allowedRoutes:6,visibleMenuRoutes:5,legacyAccountRoute:'plans',invalidRoutesRejected:true,environmentDraftPreserved:true};
  });
  await check('operations content resizes with the manager and latest sidebar switch wins',async()=>{
   manager.setContentSize(1180,780);await until(()=>{const [width,height]=manager.getContentSize(),bounds=view.getBounds();return bounds.x===0&&bounds.y===0&&bounds.width===width&&bounds.height===height;},'full content view bounds');
   await Promise.all([api.openCommerce(),api.showEnvironmentManager()]);assert.equal(api.getWorkspacePage(),'environments');assert.equal(view.getVisible(),false);await api.openCommerce();assert.equal(api.getCommerceView(),view);
   return {fillsHostContent:true,latestSwitchWins:true};
  });
  await check('workspace IPC rejects other contents and rejects a trusted view after a non-app navigation',async()=>{
   wrong=new BrowserWindow({show:false,width:300,height:200,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false}});await wrong.loadURL('about:blank');
   for(const channel of ['list','commerce-open','commerce-state','commerce-home','commerce-run-once','browser-state'])await assert.rejects(wrong.webContents.executeJavaScript(`window.untrusted.invoke(${JSON.stringify(channel)})`),/无权访问/);
   wrong.destroy();wrong=null;
   await view.webContents.loadURL('about:blank');await assert.rejects(deskJS('window.commerce.state()'),/无权访问运营工作台/);await assert.rejects(deskJS('window.commerce.showEnvironments()'),/无权访问运营工作台/);
   await view.webContents.loadFile(path.resolve(__dirname,'../src/commerce.html'));await api.openCommerce();assert.equal(api.getCommerceView(),view);assert.equal(engine.running,false);
   return {otherRendererDenied:true,unexpectedTopPageDenied:true,externalActions:0};
  });
  await check('an independent profile window keeps its page and window identity across workspace switches',async()=>{
   p=api.saveProfile({name:'QA workspace independent browser',url:'http://127.0.0.1:'+server.address().port,fingerprintMode:'native'});const count=BrowserWindow.getAllWindows().length;await api.launch(p.id);browser=api.windows.get(p.id);
   assert.ok(browser instanceof BrowserWindow);assert.notEqual(browser,manager);assert.equal(BrowserWindow.getAllWindows().length,count+1);const contents=browser.tabs[0].view.webContents;await contents.executeJavaScript('window.workspaceIndependentMarker="kept"');
   await api.showEnvironmentManager();await api.openCommerce();assert.equal(api.windows.get(p.id),browser);assert.equal(await contents.executeJavaScript('window.workspaceIndependentMarker'),'kept');assert.equal(browser.tabs.length,1);
   return {separateProfileWindow:true,independentPagePreserved:true};
  });
  await check('closing a background-enabled workspace hides the same host and preserves its view for reopening',async()=>{
   engine.db.settings.backgroundEnabled=true;manager.close();assert.equal(manager.isDestroyed(),false);assert.equal(manager.isVisible(),false);assert.equal(api.getCommerceView(),view);assert.equal(view.webContents.isDestroyed(),false);
   await api.openCommerce();assert.equal(api.getManager(),manager);assert.equal(api.getCommerceView(),view);assert.equal(manager.isVisible(),true);engine.db.settings.backgroundEnabled=originalBackground;
   return {backgroundHidePreservesView:true,noDuplicateHost:true};
  });
  await check('closed operations contents return to the homepage and reopening creates exactly one usable replacement',async()=>{
   const old=view,oldContents=old.webContents;oldContents.close({waitForBeforeUnload:false});await until(()=>oldContents.isDestroyed()&&!api.getCommerceView(),'operations contents cleanup');
   assert.equal(api.getWorkspacePage(),'environments');assert.equal(manager.contentView.children.includes(old),false);const before=BrowserWindow.getAllWindows().length;await Promise.all([api.openCommerce(),api.openCommerce()]);view=api.getCommerceView();assert.notEqual(view,old);assert.equal(BrowserWindow.getAllWindows().length,before);assert.equal(await deskJS('typeof window.commerce.state'),'function');
   return {destroyedViewDetached:true,replacementCount:1};
  });
  await check('destroying the main workspace closes its child contents while a profile window remains independently alive',async()=>{
   engine.db.settings.backgroundEnabled=false;const previousManager=manager,previousView=view,previousContents=view.webContents,count=BrowserWindow.getAllWindows().length;previousManager.destroy();await until(()=>previousContents.isDestroyed(),'commerce contents destroyed with host');assert.equal(api.getCommerceView(),null);assert.equal(browser.isDestroyed(),false);assert.equal(api.windows.get(p.id),browser);
   await api.showEnvironmentManager();manager=api.getManager();assert.notEqual(manager,previousManager);assert.equal(api.getWorkspacePage(),'environments');await api.openCommerce();view=api.getCommerceView();assert.notEqual(view,previousView);assert.equal(view.getVisible(),true);assert.equal(BrowserWindow.getAllWindows().length,count);assert.equal(await deskJS('typeof window.commerce.state'),'function');
   browser.close();await until(()=>!api.windows.has(p.id),'independent browser close');assert.equal(manager.isDestroyed(),false);assert.equal(view.webContents.isDestroyed(),false);
   return {childContentsClosed:true,profileUnaffected:true,reopenedWithoutDuplicate:true};
  });
 }finally{
  wrong?.destroy();engine.db.settings.backgroundEnabled=originalBackground;
  if(browser&&!browser.isDestroyed()){browser.close();await until(()=>!api.windows.has(p.id),'fixture browser cleanup');}
  if(p&&!api.windows.has(p.id))await api.deleteProfile(p.id);
  if(api.getManager()&&!api.getManager().isDestroyed()){await api.showEnvironmentManager();api.getManager().setBounds(originalBounds);await homeJS('document.querySelector("#search").value="";document.querySelector("#search").dispatchEvent(new Event("input",{bubbles:true}));true');}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
};
