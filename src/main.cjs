const { app, BrowserWindow, WebContentsView, ipcMain, session, safeStorage, Menu, net, dialog, nativeImage, powerSaveBlocker, powerMonitor } = require('electron');
const fs = require('node:fs'); const path = require('node:path'); const { randomUUID } = require('node:crypto');
const { validate, normalizeURL, publicProfile, exportProfiles, importProfiles } = require('./model.cjs');
const { createProxyRoute } = require('./proxy.cjs');
const {ProxyAuthGuard}=require('./proxy-auth.cjs');
const { BrowserAgent, publicSettings, saveSettings } = require('./ai.cjs');
const { createControlOverlay } = require('./control-overlay.cjs');
const { CommerceEngine } = require('./commerce-engine.cjs');
const { VintedAdapter } = require('./vinted-adapter.cjs');
const { VintedAccount } = require('./vinted-account.cjs');
const { AccountsStore } = require('./commerce-accounts.cjs');
const { VintedLogin, LOGIN_URL } = require('./vinted-login.cjs');
const { CommerceAccountService,accountError } = require('./commerce-account-service.cjs');
const commercePreparation = require('./commerce-preflight.cjs');
const {inspectPublication,submitPublication}=require('./commerce-publication-service.cjs');
const associationService=require('./commerce-association-service.cjs').createAssociationService();
const {createPhotoService}=require('./commerce-photo-service.cjs');
const { SKUDeskClient } = require('./sku-desk.cjs');
const { RequestGate } = require('./sku-transport.cjs');
const {stopDraft,installUnloadGuard,closeContents}=require('./navigation-lifecycle.cjs');
const {buildFingerprintConfig,FINGERPRINT_PRESETS,DEVICE_PRESETS}=require('./fingerprint-config.cjs');
app.setName('Isola');
app.commandLine.appendSwitch('disable-quic');
if (process.env.ISOLA_TEST_DATA) app.setPath('userData', process.env.ISOLA_TEST_DATA);
let manager, profiles = [], quitting = false, quitPending=false, quitApproved=false;
let commerceWindow, commerce, commerceAccounts, awakeId=null;
const accountTabs=new Map();
const skuGate=new RequestGate({maxConcurrent:3,maxPerMinute:100});
const windows = new Map(), locks = new Set(), routes = new Map();
const photoService=createPhotoService({nativeImage,focusProfile:id=>{const w=windows.get(id);if(w&&!w.isDestroyed()){if(w.isMinimized())w.restore();w.show();w.focus();}}});
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
app.on('second-instance', () => { if (manager && !manager.isDestroyed()) { if (manager.isMinimized()) manager.restore(); manager.show(); manager.focus(); } });
const dataFile = () => path.join(app.getPath('userData'), 'profiles.json');
const localFile = name => require('node:url').pathToFileURL(path.join(__dirname, name)).href;
function deadline(promise, ms, label) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + '超时，请重试')), ms); })]).finally(() => clearTimeout(timer)); }
function log(message) { try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); const f = path.join(app.getPath('userData'), 'diagnostic.log'); if (fs.existsSync(f) && fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, f + '.old'); fs.appendFileSync(f, new Date().toISOString() + ' ' + message + '\n'); } catch {} }
function save() {
  if (profiles.some(p => p.proxy.password) && !safeStorage.isEncryptionAvailable()) throw Error('系统密码加密不可用');
  const rows = profiles.map(p => ({ ...p, proxy: { ...p.proxy, password: p.proxy.password ? safeStorage.encryptString(p.proxy.password).toString('base64') : '', encrypted: true } }));
  fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
  if (fs.existsSync(dataFile())) fs.copyFileSync(dataFile(), dataFile() + '.backup');
  const tmp = dataFile() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 }); fs.renameSync(tmp, dataFile());
}
function list() { return profiles.map(p => publicProfile(p, locks.has(p.id) ? 'starting' : windows.has(p.id) ? 'running' : 'closed')); }
function notify() { if (manager && !manager.isDestroyed()) manager.webContents.send('profiles', list()); if(commerce)commerce.emit(); }
function commerceChanged(state){
  if(state.running&&awakeId===null)awakeId=powerSaveBlocker.start('prevent-app-suspension');
  if(!state.running&&awakeId!==null){powerSaveBlocker.stop(awakeId);awakeId=null;}
  if(commerceWindow&&!commerceWindow.isDestroyed())commerceWindow.webContents.send('commerce-state',state);
}
function ensureCommerce(){
 if(!commerce){
  const dir=path.join(app.getPath('userData'),'commerce');
  const seal=value=>{if(!safeStorage.isEncryptionAvailable()||process.platform==='linux'&&safeStorage.getSelectedStorageBackend?.()==='basic_text')throw Error('系统加密不可用，无法保存密钥');return safeStorage.encryptString(value).toString('base64');};
  const unseal=value=>safeStorage.decryptString(Buffer.from(value,'base64'));
  const accounts=new AccountsStore({dir,profiles:list,seal,unseal,assertMutable:assertAccountMutable,onChange:()=>commerce?.emit()});
  commerce=new CommerceEngine({dir,profiles:list,clientFactory:config=>new SKUDeskClient({...config,requestGate:skuGate}),adapter:new VintedAdapter({windows,isBusy:id=>commerce?.active.has(id)||!!windows.get(id)?.closingPromise||!!windows.get(id)?.navigationPending}),accounts,seal,unseal,onChange:commerceChanged});
  commerceAccounts=new CommerceAccountService({engine:commerce,store:accounts,openPage:openAccountPage,login:new VintedLogin(commerce.adapter)});
 }
 return commerce;
}
function assertAccountMutable({action,account,next}){
 if(!commerce)return;
 if(commerce.running||commerce.active.size||commerce.ticking||commerce.faulted||commerce.closing||account&&commerceAccounts?.isBusy(account.id))throw accountError('ACCOUNT_BUSY');
 const changingIdentity=['rebind','change-login','remove'].includes(action);
 if(changingIdentity&&account){
  const ids=new Set([account.profileId,next?.profileId].filter(Boolean));
  if(commerce.db.marketAccounts.some(row=>ids.has(row.profileId))||['plans','jobs','claims','photoPreparations','sales','reservations'].some(key=>commerce.db[key].some(row=>ids.has(row.profileId))))throw accountError('ACCOUNT_HISTORY');
 }
 if(['create','rebind','remove'].includes(action)&&[account?.profileId,next?.profileId].filter(Boolean).some(id=>windows.has(id)||locks.has(id)))throw accountError('PROFILE_OPEN');
}
async function openCommerce(){
  const engine=ensureCommerce();if(commerceWindow&&!commerceWindow.isDestroyed()){commerceWindow.show();commerceWindow.focus();engine.emit();return;}
  commerceWindow=new BrowserWindow({width:1360,height:940,minWidth:1050,minHeight:700,title:'Isola · 运营工作台',backgroundColor:'#f5f7fb',webPreferences:{preload:path.join(__dirname,'commerce-preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  commerceWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));commerceWindow.webContents.on('will-navigate',e=>e.preventDefault());
  commerceWindow.on('close',e=>{if(!quitting&&engine.db.settings.backgroundEnabled){e.preventDefault();commerceWindow.hide();}});
  await commerceWindow.loadFile(path.join(__dirname,'commerce.html'));engine.emit();
}
function profile(id) { const p = profiles.find(p => p.id === id); if (!p) throw Error('环境不存在'); return p; }
function requireClosed(id) { if (windows.has(id) || locks.has(id)) throw Error('请先关闭该环境'); }
function requireCommerceUnlinked(id) {
  const stored=path.join(app.getPath('userData'),'commerce','commerce-state.json');
  const engine=commerce||(fs.existsSync(stored)||fs.existsSync(path.join(path.dirname(stored),'commerce-accounts.json'))?ensureCommerce():null);
  if(engine?.accounts?.findByProfile(id))throw Error('该环境绑定了账号，请先在账号中心处理绑定，不能删除或清除登录数据。');
  if(engine&&(engine.active.has(id)||['plans','jobs','claims','photoPreparations'].some(key=>engine.db[key].some(row=>row.profileId===id))))throw Error('该环境关联了运营计划或历史记录，不能删除或清除登录数据；请保留此环境并新建其他环境。');
}
function sesFor(p) { return session.fromPartition('persist:environment-' + p.id); }
function fingerprintFor(p) {
  return buildFingerprintConfig(p, { platform: process.platform, arch: process.arch, osVersion: process.getSystemVersion(), chromeVersion: process.versions.chrome, userAgent: app.userAgentFallback.replace(/ Isola\/[^ ]+| Electron\/[^ ]+/g, '') });
}
function inputProfile(input) {
  const previous = profiles.find(p => p.id === input.id);
  const password = input.clearPassword ? '' : input.proxy?.password || previous?.proxy.password || '';
  return validate({ ...input, createdAt: previous?.createdAt || input.createdAt, proxy: { ...input.proxy, password } });
}
function saveProfile(input) { const p = inputProfile(input); requireClosed(p.id); const next = [...profiles]; const i = next.findIndex(x => x.id === p.id); if (i < 0) next.push(p); else next[i] = p; const previous = profiles; profiles = next; try { save(); } catch (e) { profiles = previous; throw e; } notify(); return publicProfile(p); }
async function clearProfile(id) { requireClosed(id); requireCommerceUnlinked(id); const s = sesFor(profile(id)); locks.add(id); notify(); try { await s.clearStorageData(); await s.clearCache(); await s.clearAuthCache(); await s.closeAllConnections(); } finally { locks.delete(id); notify(); } }
async function deleteProfile(id) { await clearProfile(id); const previous = profiles; profiles = profiles.filter(p => p.id !== id); try { save(); } catch (e) { profiles = previous; throw e; } notify(); }
function duplicateProfile(id) { const original = profile(id); return saveProfile({ ...original, id: randomUUID(), name: original.name + '（副本）', createdAt: new Date().toISOString() }); }
function sendState(w) {
  if (w.isDestroyed()) return;
  w.webContents.send('browser-state', { active: w.activeTab, profileName: w.profile.name, fingerprintMode:w.profile.fingerprintMode, proxy: w.profile.proxy.type, tabs: w.tabs.map(t => ({ id: t.id, title: t.title, url: t.url, error: t.error, notice: t.unloadGuard?.blocked?t.unloadGuard.reason:'', loading: t.loading })), width: w.profile.width, height: w.profile.height, aiPanelOpen: !!w.aiPanelOpen });
}
function resizeViews(w) {
  if (w.isDestroyed()) return;
  const [width, height] = w.getContentSize();
  const pageWidth = Math.max(320,width-(w.aiPanelOpen?350:0));
  for (const t of w.tabs) t.view.setBounds(t.id === w.activeTab ? { x: 0, y: 104, width: pageWidth, height: Math.max(1, height - 104) } : { x: -10000, y: 104, width: 1, height: 1 });
}
async function configure(contents, p) {
  // Navigate locally first: CDP commands can otherwise wait forever for a renderer.
  await deadline(contents.loadURL('about:blank'), 10000, '初始化页面');
  contents.setUserAgent(sesFor(p).getUserAgent()); contents.debugger.attach('1.3');
  const fingerprint=fingerprintFor(p);
  if(!fingerprint.enabled)return;
  const send = (method, args) => deadline(contents.debugger.sendCommand(method, args), 8000, '指纹配置');
  await send('Emulation.setTimezoneOverride', { timezoneId: fingerprint.timezone });
  await send('Emulation.setLocaleOverride', { locale: fingerprint.language });
  await send('Emulation.setDeviceMetricsOverride', fingerprint.deviceMetrics);
  await send('Emulation.setTouchEmulationEnabled', fingerprint.touchEmulation);
  await send('Emulation.setEmitTouchEventsForMouse', {enabled:!!(fingerprint.deviceMetrics.mobile&&fingerprint.touchEmulation.enabled),configuration:fingerprint.deviceMetrics.mobile?'mobile':'desktop'});
  await send('Emulation.setUserAgentOverride', fingerprint.userAgentOverride);
  if (fingerprint.hardwareConcurrency) await send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: fingerprint.hardwareConcurrency });
  // Chromium does not propagate every page override to dedicated workers or
  // out-of-process frames. Use child-target emulation before scripts start. Some
  // values (notably WorkerNavigator.platform) remain host values in Chromium;
  // the diagnostic page reports those differences without changing JS APIs.
  // Service Worker Emulation commands can wait for startup while startup waits
  // for the debugger. Resume them immediately and report actual data. Do not
  // filter them out: Chromium can still pause a filtered worker without emitting
  // the attached event, which would leave its registration waiting indefinitely.
  const autoAttach={autoAttach:true,waitForDebuggerOnStart:true,flatten:true};
  contents.debugger.on('message', (_event,method,params) => {
    if(method!=='Target.attachedToTarget')return;
    const childSession=params.sessionId;
    const childSend=(name,args)=>deadline(contents.debugger.sendCommand(name,args,childSession),8000,'子页面指纹配置');
    void (async()=>{
      try {
        if(params.targetInfo?.type==='service_worker')return;
        await childSend('Emulation.setUserAgentOverride',fingerprint.userAgentOverride);
        await childSend('Emulation.setTimezoneOverride',{timezoneId:fingerprint.timezone});
        if(fingerprint.hardwareConcurrency)await childSend('Emulation.setHardwareConcurrencyOverride',{hardwareConcurrency:fingerprint.hardwareConcurrency});
        // Locale is renderer-wide and inherited from the page. Reapplying it in
        // a worker can fail with "Another locale override is already in effect".
        await childSend('Target.setAutoAttach',autoAttach);
      } catch(error) {
        if(!contents.isDestroyed())log('child fingerprint configuration unavailable ('+params.targetInfo?.type+'): '+error.message);
      } finally {
        if(!contents.isDestroyed())await childSend('Runtime.runIfWaitingForDebugger',{}).catch(error=>log('child target resume failed: '+error.message));
      }
    })();
  });
  await send('Target.setAutoAttach',autoAttach);
}
async function stopPageAutomation(w) {
  w.vintedDraftController?.abort();w.aiAgent?.stop();
  await stopDraft(w);
  const until=Date.now()+15000;
  while(w.aiAgent?.state.running){if(Date.now()>=until)throw Error('AI 仍在停止，请等待当前步骤结束后重试。页面已保留。');await new Promise(resolve=>setTimeout(resolve,20));}
}
async function navigateTab(w, tab, url, userAction) {
  if(!tab||tab.view.webContents.isDestroyed())throw Error('当前页面已关闭');
  const c=tab.view.webContents,endIntent=userAction?tab.unloadGuard.begin(userAction):()=>{},navigationId=Symbol('navigation');
  tab.navigationId=navigationId;tab.error='';tab.url=url;sendState(w);
  try {await deadline(c.loadURL(url),30000,'页面加载');return true;}
  catch(e){
    if(c.isDestroyed()||tab.navigationId!==navigationId)return false;
    if(e.code==='ERR_ABORTED'||e.errno===-3||/ERR_ABORTED/.test(e.message)){
      tab.url=c.getURL();tab.loading=c.isLoading();tab.error=tab.unloadGuard.blocked?tab.unloadGuard.reason:'';sendState(w);return false;
    }
    c.stop();tab.error=e.message;sendState(w);return false;
  }finally{endIntent();}
}
function removeTab(w,tab) {
  const index=w.tabs.indexOf(tab);if(index<0)return;
  w.tabs.splice(index,1);if(w.activeTab===tab.id)w.activeTab=w.tabs[Math.min(index,w.tabs.length-1)]?.id||null;
  if(!w.isDestroyed()){w.contentView.removeChildView(tab.view);resizeViews(w);sendState(w);}
}
async function closeTab(w,tab) {
  const closed=await closeContents(tab);if(closed)removeTab(w,tab);return closed;
}
function closeBrowserWindow(w) {
  if(w.isDestroyed())return Promise.resolve(true);
  if(w.closingPromise)return w.closingPromise;
  w.closingPromise=(async()=>{
    await stopPageAutomation(w);commerce?.active.get(w.profile.id)?.abort();w.controlOverlay.clear();
    const ordered=[...w.tabs].sort((a,b)=>Number(b.id===w.activeTab)-Number(a.id===w.activeTab));
    for(const tab of ordered)if(!await closeTab(w,tab))return false;
    w.closeApproved=true;w.close();return true;
  })().finally(()=>{w.closingPromise=null;});
  return w.closingPromise;
}
async function openListingPage(engine,planId,{active=false}={}) {
  const plan=engine.plan(planId),profileId=plan.profileId,formURL=active?engine.listingURL(plan):'https://www.vinted.fr/items/new';
  if(!formURL)throw Error('没有可核对的在售商品回执地址，未打开网页。');
  if(engine.running||engine.ticking||engine.active.size)throw Error('请先停止运营调度，再打开刊登页。');
  if(!windows.has(profileId))await launch(profileId);
  const w=windows.get(profileId);if(!w||w.isDestroyed())throw Error('浏览器环境未能打开。');
  if(w.closingPromise||w.navigationPending)throw Error('该窗口正在切换或关闭页面，请稍后重试。');
  await stopPageAutomation(w);
  return engine.configure(async(_signal,guard)=>{
    guard();if(engine.plan(planId).profileId!==profileId||active&&engine.listingURL(engine.plan(planId))!==formURL)throw Error('计划所属环境或在售商品已改变，请重新核对。');
    if(w.isDestroyed()||w.closingPromise||w.navigationPending)throw Error('浏览器窗口状态已改变，请重试。');
    w.navigationPending=true;
    try{
      let tab=w.tabs.find(t=>!t.view.webContents.isDestroyed()&&t.view.webContents.getURL()===formURL);
      if(tab){w.activeTab=tab.id;resizeViews(w);sendState(w);}else tab=await addTab(w,formURL);
      guard();if(w.isDestroyed()||tab.view.webContents.isDestroyed())throw Error('刊登页面已关闭。');
      if(w.isMinimized())w.restore();w.show();w.focus();
      if(tab.error&&!tab.unloadGuard?.blocked)throw Error(tab.error);
      return {url:tab.view.webContents.getURL(),profileId};
    }finally{w.navigationPending=false;}
  });
}
async function openAccountPage(profileId,{signal,guard,freshLogin=false}){
 guard();if(signal.aborted)throw accountError('ACCOUNT_UNAVAILABLE');
 if(!windows.has(profileId))await launch(profileId);
 guard();const w=windows.get(profileId);
 if(!w||w.isDestroyed())throw accountError('ACCOUNT_UNAVAILABLE');
 if(w.closingPromise||w.navigationPending||w.aiAgent?.state?.running||w.vintedDraftController)throw accountError('ACCOUNT_BUSY');
 w.navigationPending=true;
 try{
  let tab=freshLogin?null:w.tabs.find(t=>t.id===accountTabs.get(profileId)&&!t.view.webContents.isDestroyed());
  const compatible=t=>{try{const u=new URL(t.view.webContents.getURL());return u.origin==='https://www.vinted.fr'&&!u.username&&!u.password&&(freshLogin?u.href===LOGIN_URL:['/','/member/login','/member/login/email','/login'].includes(u.pathname));}catch{return false;}};
  if(!tab)tab=w.tabs.find(t=>t.id===w.activeTab&&compatible(t))||w.tabs.find(t=>!t.view.webContents.isDestroyed()&&compatible(t));
  if(tab){w.activeTab=tab.id;resizeViews(w);sendState(w);}else tab=await addTab(w,LOGIN_URL||'https://www.vinted.fr/');
  guard();if(w.isDestroyed()||tab.view.webContents.isDestroyed())throw accountError('ACCOUNT_UNAVAILABLE');
  accountTabs.set(profileId,tab.id);if(w.isMinimized())w.restore();w.show();w.focus();tab.view.webContents.focus();
  if(tab.error&&!tab.unloadGuard?.blocked)throw accountError('ACCOUNT_UNAVAILABLE');
  return {profileId,url:tab.view.webContents.getURL()};
 }finally{w.navigationPending=false;}
}
async function addTab(w, target) {
  await stopDraft(w);
  if (w.tabs.length >= 20) throw Error('每个环境最多打开 20 个标签页');
  const view = new WebContentsView({ webPreferences: { session: sesFor(w.profile), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false } });
  const tab = { id: randomUUID(), view, title: '新标签页', url: '', error: '', loading: false };
  tab.isInputVisible=()=>!w.isDestroyed()&&w.isVisible()&&!w.isMinimized()&&w.activeTab===tab.id;
  tab.controlFeedback=event=>w.controlOverlay.show(tab,event);
  w.tabs.push(tab); w.activeTab = tab.id; w.contentView.addChildView(view); resizeViews(w); sendState(w);
  const c = view.webContents; c.setAudioMuted(false); c.setWebRTCIPHandlingPolicy(fingerprintFor(w.profile).webRTCPolicy);
  tab.unloadGuard=installUnloadGuard(w,tab,{showMessageBoxSync:(...args)=>dialog.showMessageBoxSync(...args),onState:()=>sendState(w),isAutomating:()=>!!w.aiAgent?.state.running||!!w.vintedDraftController||!!commerce?.active.has(w.profile.id)});
  c.once('destroyed',()=>{
    tab.proxyAuth?.dispose();
    removeTab(w,tab);
    if(!w.isDestroyed()&&!w.tabs.length&&!w.closingPromise){w.closeApproved=true;w.close();}
  });
  tab.proxyAuth=new ProxyAuthGuard(w.profile.proxy);
  c.on('did-start-navigation',(_event,_url,isInPlace,isMainFrame)=>{if(isMainFrame&&!isInPlace)tab.proxyAuth.beginNavigation();});
  c.on('login', (event, details, auth, callback) => { event.preventDefault();const credentials=tab.proxyAuth.credentials(details,auth);if(credentials)callback(credentials.username,credentials.password);else callback(); });
  c.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) addTab(w, url).catch(e => { tab.error = e.message; sendState(w); }); return { action: 'deny' }; });
  c.on('will-navigate', (e, url) => { if (!/^https?:\/\//.test(url)) e.preventDefault(); });
  c.on('page-title-updated', (_, title) => { tab.title = title; sendState(w); });
  c.on('did-navigate', () => { tab.aiContext = null; });
  for (const event of ['did-navigate', 'did-navigate-in-page']) c.on(event, () => { tab.url = c.getURL(); sendState(w); });
  c.on('did-start-loading', () => { tab.loading = true; sendState(w); });
  c.on('did-stop-loading', () => { tab.loading = false; sendState(w); });
  c.on('did-fail-load', (e, code, description, url, isMain) => { if (isMain && code !== -3) { tab.error = description; sendState(w); } });
  c.on('render-process-gone', () => { tab.error = '页面进程退出，请重新加载'; sendState(w); });
  c.debugger.on('detach', (_, reason) => { if (!quitting && !c.isDestroyed() && reason !== 'target closed') { tab.error = '指纹配置连接中断，请关闭并重新启动此环境'; c.stop(); view.setVisible(false); sendState(w); } });
  try { await configure(c, w.profile); await navigateTab(w, tab, target || localFile('check.html')); } catch (e) { tab.error = e.message; sendState(w); throw e; }
  return tab;
}
async function launch(id) {
  const p = profile(id); if (windows.has(id)) { windows.get(id).focus(); return; } if (locks.has(id)) throw Error('环境正在启动');
  locks.add(id); notify(); let w, route;
  try {
    const s = sesFor(p); route = await createProxyRoute(p.proxy); routes.set(id, route);
    await s.setProxy(route.config); await s.closeAllConnections();
    const fingerprint=fingerprintFor(p);
    const nativeLanguages=[...new Set([app.getLocale(),...app.getPreferredSystemLanguages()])].join(',');
    s.setUserAgent(fingerprint.userAgent, fingerprint.enabled?fingerprint.acceptLanguage:nativeLanguages);
    s.setPermissionRequestHandler((_, permission, callback) => callback(false)); s.setPermissionCheckHandler(() => false);
    if (!s._isolaDownloads) { s._isolaDownloads = true; s.on('will-download', (_, item) => item.setSaveDialogOptions({ title: '保存下载文件 · Isola' })); }
    w = new BrowserWindow({ width: Math.min(p.width + 20, 1600), height: Math.min(p.height + 145, 1050), minWidth: 720, minHeight: 480, title: p.name + ' · Isola', backgroundColor: '#edf1f6', webPreferences: { preload: path.join(__dirname, 'browser-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    w.profile = p; w.tabs = []; w.activeTab = null; w.controlOverlay=createControlOverlay(w,{isActive:tab=>tab.id===w.activeTab}); w.aiPanelOpen = false; w.aiAgent = new BrowserAgent(w,(tab,url)=>navigateTab(w,tab,url)); windows.set(id, w); w.on('resize', () => resizeViews(w));
    // One request observer per profile session; successful requests release only
    // their own authentication budget. Failed challenges cannot reset it.
    const authRequests=new Map();
    s.webRequest.onBeforeRequest((details,callback)=>{const tab=w.tabs.find(t=>!t.view.webContents.isDestroyed()&&t.view.webContents.id===details.webContentsId);if(tab?.proxyAuth)authRequests.set(details.id,{guard:tab.proxyAuth,generation:tab.proxyAuth.generation});callback({});});
    s.webRequest.onCompleted(details=>{const request=authRequests.get(details.id);authRequests.delete(details.id);request?.guard.completed({url:details.url,statusCode:details.statusCode,generation:request.generation});});
    s.webRequest.onErrorOccurred(details=>authRequests.delete(details.id));
    w.once('closed',()=>{authRequests.clear();s.webRequest.onBeforeRequest(null);s.webRequest.onCompleted(null);s.webRequest.onErrorOccurred(null);});
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); w.webContents.on('will-navigate', e => e.preventDefault());
    w.on('close',e=>{w.vintedDraftController?.abort();if(w.closeApproved)return;e.preventDefault();void closeBrowserWindow(w).catch(error=>{log('window close stopped: '+error.message);const tab=w.tabs.find(t=>t.id===w.activeTab);if(tab){tab.error=error.message;sendState(w);}});});
    w.on('closed', () => { w.vintedDraftController?.abort();w.aiAgent.stop();commerce?.active.get(id)?.abort(); for (const t of [...w.tabs]) { if (!t.view.webContents.isDestroyed()) t.view.webContents.close(); } windows.delete(id); routes.delete(id); s.closeAllConnections().finally(() => route.close()).catch(() => {}); notify(); });
    // The toolbar is usable even while a tab is starting or a proxy is unavailable.
    await w.loadFile(path.join(__dirname, 'browser.html')); await addTab(w, p.url); log('environment started');
  } catch (e) { log('environment startup failed: ' + e.message); if (w && !w.isDestroyed()) w.close(); else if (route) { await route.close(); routes.delete(id); } throw e; }
  finally { locks.delete(id); notify(); }
}
async function testProxy(input, endpoint = 'https://api.ipify.org?format=json') {
  const p = inputProfile(input); const s = session.fromPartition('probe-' + randomUUID()); const route = await createProxyRoute(p.proxy);
  try {
    await s.setProxy(route.config); const start = Date.now();
    const body = await new Promise((resolve, reject) => {
      const req = net.request({ url: endpoint, session: s, redirect: 'error', cache: 'no-store' });
      let attempts = 0; const timer = setTimeout(() => { req.abort(); reject(Error('代理检测超时（12 秒）')); }, 12000);
      const fail = e => { clearTimeout(timer); reject(e); };
      req.on('login', (auth, cb) => { if (auth.isProxy && auth.host === p.proxy.host && Number(auth.port) === p.proxy.port && attempts++ < 2) cb(p.proxy.username, p.proxy.password); else cb(); });
      req.on('error', fail); req.on('response', r => { let data = ''; r.on('data', chunk => { data += chunk; if (data.length > 4096) { req.abort(); fail(Error('检测响应过大')); } }); r.on('error', fail); r.on('end', () => { clearTimeout(timer); if (r.statusCode !== 200) reject(Error('检测服务返回 ' + r.statusCode)); else resolve(data); }); }); req.end();
    });
    const result = JSON.parse(body); if (!require('node:net').isIP(result.ip)) throw Error('检测服务未返回有效 IP');
    return { ip: result.ip, ms: Date.now() - start };
  } finally { await s.closeAllConnections(); await route.close(); }
}
function managerOnly(e) { if (!manager || e.sender !== manager.webContents) throw Error('无权访问环境管理'); }
function browserWindow(e) { const w = BrowserWindow.fromWebContents(e.sender); if (!w || !w.profile || e.sender !== w.webContents) throw Error('无权访问浏览器控制'); return w; }
function register() {
  const handle = (name, fn) => ipcMain.handle(name, (e, ...args) => { managerOnly(e); return fn(...args); });
  handle('list', list); handle('save', saveProfile); handle('launch', launch); handle('stop', id => windows.get(id)?.close()); handle('delete', deleteProfile); handle('clear', clearProfile); handle('duplicate', duplicateProfile); handle('proxy-test', input => testProxy(input));
  handle('batch', async (ids, action) => { if (!Array.isArray(ids) || ids.length > 100 || !['launch', 'stop'].includes(action)) throw Error('批量操作无效'); const failures = []; for (const id of new Set(ids)) { try { if (action === 'launch') await launch(id); else windows.get(id)?.close(); } catch (e) { failures.push({ name: profiles.find(p => p.id === id)?.name || id, error: e.message }); } } return failures; });
  handle('export', async ids => { const rows = ids?.length ? profiles.filter(p => ids.includes(p.id)) : profiles; const r = await dialog.showSaveDialog(manager, { defaultPath: 'Isola-profiles.json', filters: [{ name: 'JSON 配置', extensions: ['json'] }] }); if (r.canceled) return; fs.writeFileSync(r.filePath, JSON.stringify(exportProfiles(rows), null, 2), { mode: 0o600 }); return rows.length; });
  handle('import', async () => { const r = await dialog.showOpenDialog(manager, { filters: [{ name: 'JSON 配置', extensions: ['json'] }], properties: ['openFile'] }); if (r.canceled) return; if (fs.statSync(r.filePaths[0]).size > 2 * 1024 * 1024) throw Error('配置文件不能超过 2 MB'); const rows = importProfiles(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))); const before = profiles; profiles = [...profiles, ...rows]; try { save(); } catch (e) { profiles = before; throw e; } notify(); return rows.length; });
  handle('info', () => ({ version: app.getVersion(), chromium: process.versions.chrome, platform: process.platform, arch: process.arch, dataPath: app.getPath('userData') }));
  handle('fingerprint-preview', input => fingerprintFor(validate({...input,id:undefined,name:'配置预览',url:'https://example.com',proxy:{type:'direct'}})));
  handle('fingerprint-catalog', () => ({devices:DEVICE_PRESETS,systems:FINGERPRINT_PRESETS}));
  handle('commerce-open',openCommerce);
  const desk=(name,fn)=>ipcMain.handle(name,(e,...args)=>{if(!commerceWindow||commerceWindow.isDestroyed()||e.sender!==commerceWindow.webContents||e.senderFrame!==commerceWindow.webContents.mainFrame)throw Error('无权访问运营工作台');return fn(ensureCommerce(),...args);});
  desk('commerce-account-save',(_c,input)=>commerceAccounts.save(input));desk('commerce-account-delete',(_c,id)=>commerceAccounts.remove(id));
  desk('commerce-account-login',(_c,id)=>commerceAccounts.login(id));desk('commerce-account-open',(_c,id)=>commerceAccounts.open(id));desk('commerce-account-verify',(_c,id,options)=>commerceAccounts.verify(id,options));
  desk('commerce-publication-inspect',(c,id)=>inspectPublication(c,id));
  desk('commerce-published-inspect',(c,id)=>associationService.inspect(c,id));
  desk('commerce-published-associate',(c,id,token)=>associationService.associate(c,id,token));
  desk('commerce-publication-submit',(c,id)=>submitPublication(c,id,{beforeSubmit:plan=>{const w=windows.get(plan.profileId);if(w&&!w.isDestroyed()){if(w.isMinimized())w.restore();w.show();w.focus();}}}));
  desk('commerce-preflight',(c,id)=>commercePreparation.preflight(c,id));desk('commerce-prepare-draft',(c,id)=>commercePreparation.prepareDraft(c,id,{beforeFields:plan=>{const w=windows.get(plan.profileId);if(w&&!w.isDestroyed()){if(w.isMinimized())w.restore();w.show();w.focus();}}}));
  desk('commerce-account-inspect',(c,id)=>c.configure(async(signal,guard)=>{
    const plan=c.plan(id),w=windows.get(plan.profileId);if(w&&!w.isDestroyed()){if(w.isMinimized())w.restore();w.show();w.focus();}
    const result=await new VintedAccount(c.adapter).inspectAccount(plan.profileId,{signal});guard();
    const account=c.bindMarketAccount(plan.profileId,result);c.event('info','已核对 '+account.username+' 的 Vinted 账号');c.persist();c.emit();
    return {account,message:result.message};
  }));
  desk('commerce-open-listing',(c,id)=>openListingPage(c,id));desk('commerce-open-active-listing',(c,id)=>openListingPage(c,id,{active:true}));
  desk('commerce-photos-inspect',(c,id)=>photoService.inspect(c,id));desk('commerce-photos-prepare',(c,id)=>photoService.prepare(c,id));desk('commerce-photos-preview',(c,id)=>photoService.preview(c,id));desk('commerce-photos-upload',(c,id,recheckOnly=false)=>photoService.upload(c,id,{recheckOnly}));
  desk('commerce-state',c=>c.state());desk('commerce-settings-save',(c,input)=>c.saveSettings(input));desk('commerce-connect',c=>c.connect());desk('commerce-sync',c=>c.sync());desk('commerce-plan-save',(c,input)=>c.savePlan(input));desk('commerce-plan-enabled',(c,id,enabled)=>c.setPlanEnabled(id,enabled));desk('commerce-run-once',c=>c.runOnce());desk('commerce-running',(c,enabled)=>c.setRunning(enabled));desk('commerce-resolve',(c,id,action,data)=>c.resolve(id,action,data));
  ipcMain.handle('ai-panel', (e,open) => { const w=browserWindow(e);w.aiPanelOpen=!!open;resizeViews(w);sendState(w);return w.aiPanelOpen; });
  ipcMain.handle('ai-settings', e => { browserWindow(e);return publicSettings(); });
  ipcMain.handle('ai-save-settings', (e,input) => { browserWindow(e);return saveSettings(input); });
  ipcMain.handle('ai-state', e => { const w=browserWindow(e);return w.aiAgent.state; });
  ipcMain.handle('ai-start', async (e,goal) => {const w=browserWindow(e);if(w.closingPromise)throw Error('窗口正在关闭，请等待完成。');await stopDraft(w);if(w.isDestroyed())throw Error('窗口已关闭');return w.aiAgent.start(goal);});
  ipcMain.handle('ai-stop', e => { browserWindow(e).aiAgent.stop(); });
  ipcMain.handle('ai-pause', e => { browserWindow(e).aiAgent.pause(); });
  ipcMain.handle('ai-resume', e => { browserWindow(e).aiAgent.resume(); });
  ipcMain.handle('ai-approve', (e,id,accepted) => { browserWindow(e).aiAgent.decide(id,!!accepted); });
  ipcMain.handle('browser-state', e => { const w = browserWindow(e); sendState(w); });
  ipcMain.handle('navigate', async (e, action, value) => {
    const w=browserWindow(e);
    if(!['go','new','check','switch','close','back','forward','reload','stop'].includes(action))throw Error('浏览器操作无效');
    if(action==='stop'){
      if(w.navigationRequest)w.navigationRequest.cancelled=true;
      w.vintedDraftController?.abort();w.aiAgent?.stop();w.controlOverlay.clear();
      const tab=w.tabs.find(t=>t.id===w.activeTab),c=tab?.view.webContents;
      if(c&&!c.isDestroyed()){c.stop();tab.url=c.getURL();tab.loading=false;sendState(w);}
      return;
    }
    if(w.closingPromise)throw Error('窗口正在关闭，请等待完成。');
    if(w.navigationPending)throw Error('当前页面操作尚未完成，请稍后重试。');
    const request={cancelled:false};w.navigationRequest=request;w.navigationPending=true;
    try{
    await stopPageAutomation(w);if(w.isDestroyed()||request.cancelled)return;w.controlOverlay.clear();
    const tab=w.tabs.find(t=>t.id===w.activeTab),c=tab?.view.webContents;
    if (action === 'go') return await navigateTab(w, tab, normalizeURL(value),'go');
    if (action === 'new') return void await addTab(w);
    if (action === 'check') return void await addTab(w, localFile('check.html'));
    if (action === 'switch') { if (!w.tabs.some(t => t.id === value)) return; w.activeTab = value; resizeViews(w); sendState(w); return; }
    if (action === 'close') {const t=w.tabs.find(t=>t.id===value);if(!t)return;if(w.tabs.length===1)return await closeBrowserWindow(w);return await closeTab(w,t);}
    if (!c) return;
    if (action === 'back' && c.navigationHistory.canGoBack()) {tab.unloadGuard.begin('back');c.navigationHistory.goBack();}
    if (action === 'forward' && c.navigationHistory.canGoForward()) {tab.unloadGuard.begin('forward');c.navigationHistory.goForward();}
    if (action === 'reload') return await navigateTab(w,tab,c.getURL()||tab.url||w.profile.url,'reload');
    }finally{if(w.navigationRequest===request)w.navigationRequest=null;w.navigationPending=false;}
  });
}
async function createManager() {
  manager = new BrowserWindow({ width: 1360, height: 900, minWidth: 1080, minHeight: 720, title: 'Isola · 环境管理', backgroundColor: '#f5f7fb', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  manager.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); manager.webContents.on('will-navigate', e => e.preventDefault()); await manager.loadFile(path.join(__dirname, 'index.html'));
  manager.on('close',e=>{if(!quitting&&commerce?.db.settings.backgroundEnabled){e.preventDefault();manager.hide();}});
}
const ready = app.whenReady().then(async () => {
  if (!hasInstanceLock) return false;
  try {
    // The fallback also covers out-of-process subframes and their workers.
    app.userAgentFallback=app.userAgentFallback.replace(/ Isola\/[^ ]+| Electron\/[^ ]+/g, '');
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    if (fs.existsSync(dataFile())) profiles = JSON.parse(fs.readFileSync(dataFile(), 'utf8')).map(p => validate({ ...p, proxy: { ...p.proxy, password: p.proxy.password ? safeStorage.decryptString(Buffer.from(p.proxy.password, 'base64')) : '' } }));
    register(); Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Isola', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }, { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }, { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }]));
    powerMonitor.on('suspend',()=>{for(const w of windows.values()){w.vintedDraftController?.abort();w.aiAgent?.stop();w.controlOverlay.clear();}if(commerce){commerce.configController?.abort();if(commerce.running||commerce.ticking||commerce.active.size){commerce.setRunning(false);commerce.event('warning','系统进入睡眠，队列已暂停；唤醒后请核对任务再启动。');commerce.persist();commerce.emit();}}});
    await createManager(); return true;
  } catch (e) { log('startup failed: ' + e.message); dialog.showErrorBox('启动失败：配置文件已保留', e.message); app.quit(); throw e; }
});
app.on('before-quit',e=>{
  if(quitApproved){quitting=true;return;}
  e.preventDefault();if(quitPending)return;quitPending=true;quitting=true;
  void (async()=>{
    for(const w of windows.values()){w.vintedDraftController?.abort();w.aiAgent?.stop();}
    if(commerce){commerce.configController?.abort();if(commerce.running||commerce.ticking||commerce.active.size)commerce.setRunning(false);}
    for(const w of [...windows.values()])if(!await closeBrowserWindow(w)){quitting=false;return;}
    if(commerce)await commerce.close();
    if(awakeId!==null){powerSaveBlocker.stop(awakeId);awakeId=null;}
    quitApproved=true;app.quit();
  })().catch(error=>{quitting=false;log('quit stopped: '+error.message);}).finally(()=>{quitPending=false;});
});
app.on('window-all-closed', () => {if(quitting||!commerce?.db.settings.backgroundEnabled)app.quit();});
app.on('activate', () => { if (!manager || manager.isDestroyed()) createManager(); else { manager.show(); manager.focus(); } });
module.exports = { ready, saveProfile, duplicateProfile, deleteProfile, clearProfile, launch, testProxy, list, sesFor, windows, dataFile, getManager: () => manager, getProfiles: () => profiles,getCommerce:ensureCommerce,openCommerce,getCommerceWindow:()=>commerceWindow };
