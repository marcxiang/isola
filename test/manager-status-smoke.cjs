'use strict';
const assert=require('node:assert/strict');
const {ACCOUNT_OBSERVATION_MAX_AGE_MS}=require('../src/manager-status.cjs');
module.exports=async function managerStatusSmoke(api,check){
 assert.ok(process.env.ISOLA_TEST_DATA);const engine=api.getCommerce();assert.equal(engine.running,false);assert.equal(engine.active.size,0);
 const originalDB=JSON.parse(JSON.stringify(engine.db)),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),until=async(predicate,label)=>{const stop=Date.now()+6000;while(Date.now()<stop){if(await predicate())return;await sleep(20);}throw Error('Timed out: '+label);};
 let p,q,account,w,s,fixtureRequests=0;const manager=api.getManager(),js=code=>manager.webContents.executeJavaScript(code),row=id=>js(`window.isola.list().then(rows=>rows.find(row=>row.id===${JSON.stringify(id)}))`);
 const bound={platform:'vinted-fr',memberId:'918273645',username:'private-manager-fixture-member',profileURL:'https://www.vinted.fr/member/918273645'};
 try{
  p=api.saveProfile({name:'QA manager status automation',windowType:'automation',url:'https://www.vinted.fr/',fingerprintMode:'native'});q=api.saveProfile({name:'QA manager status separate',windowType:'automation',url:'https://example.com/',fingerprintMode:'native'});
  await js(`window.__statusTarget=${JSON.stringify(p.id)};window.__statusEvents=[];window.isola.onChange(rows=>{const row=rows.find(item=>item.id===window.__statusTarget);if(row){window.__statusEvents.push({vinted:row.vintedStatus.state,automation:row.automationStatus.state});if(window.__statusEvents.length>80)window.__statusEvents.shift();}});true`);
  await check('manager IPC marks encrypted saved account credentials unverified and returns no account identity or AI payload',async()=>{
   account=engine.accounts.save({label:'Private fixture account',login:'private-manager-fixture-login',password:'private-manager-fixture-password',profileId:p.id});const actual=await row(p.id);assert.equal(actual.vintedStatus.state,'saved');assert.equal(actual.automationStatus.state,'closed');assert.doesNotMatch(JSON.stringify(actual),/private-manager-fixture|918273645|memberId|encryptedPassword|approval/);assert.equal((await row(q.id)).vintedStatus.state,'unbound');
   return {savedPasswordIsNotLogin:true,privateAccountDataReturned:false};
  });
  await check('manager reflects trusted account results as history and only a matching live observation as recent',async()=>{
   engine.bindMarketAccount(p.id,{...bound,verified:true,documentKey:'closed-fixture-document'});assert.equal((await row(p.id)).vintedStatus.state,'verified_history');
   s=api.sesFor(p);s.protocol.handle('https',()=>{fixtureRequests++;return new Response('<!doctype html><title>Manager status local fixture</title><p>Local fixture only</p>',{headers:{'content-type':'text/html'}});});await api.launch(p.id);w=api.windows.get(p.id);const c=w.tabs[0].view.webContents,documentKey=await c.executeJavaScript('String(performance.timeOrigin)');
   engine.bindMarketAccount(p.id,{...bound,verified:true,documentKey});assert.equal((await row(p.id)).vintedStatus.state,'verified_recent');assert.equal((await row(p.id)).vintedStatus.stale,false);
   engine.accounts.markResult(account.id,{status:'awaiting_user',code:'CHALLENGE_REQUIRED'});assert.equal((await row(p.id)).vintedStatus.state,'challenge');engine.bindMarketAccount(p.id,{...bound,verified:true,documentKey});assert.equal((await row(p.id)).vintedStatus.state,'verified_recent');
   return {historyIsStale:true,liveReceiptRequired:true,challengeVisible:true,liveVinted:false};
  });
  await check('a local expiry notification removes the recent verification badge without a new page request',async()=>{
   const requestsBefore=fixtureRequests,observed=engine.accountObservations.get(p.id),checkedAt=new Date(Date.now()-ACCOUNT_OBSERVATION_MAX_AGE_MS+1000).toISOString();engine.accountObservations.set(p.id,{...observed,checkedAt});engine.emit();assert.equal((await row(p.id)).vintedStatus.state,'verified_recent');await js('window.__statusEvents.length=0;true');
   await until(()=>js(`window.__statusEvents.some(event=>event.vinted==='verified_history')`),'verification expiry push');assert.equal((await row(p.id)).vintedStatus.state,'verified_history');assert.equal(engine.accountObservations.get(p.id).checkedAt,checkedAt);assert.equal(fixtureRequests,requestsBefore);return {timerNotification:true,timestampNotExtended:true,pageRequests:0};
  });
  await check('AI start, pause, approval and final completion emit fresh manager status for only the owning environment',async()=>{
   const agent=w.aiAgent,previous=agent.state;
   try{for(const [status,running,expected] of [['reading',true,'running'],['paused',true,'paused'],['approval',true,'approval'],['stopping',true,'stopping'],['complete',false,'idle']]){await js('window.__statusEvents.length=0;true');agent.state={...previous,running,status,goal:'private-manager-fixture-goal',approval:running?{message:'private-manager-fixture-approval'}:null};agent.emit();await until(()=>js(`window.__statusEvents.some(event=>event.automation===${JSON.stringify(expected)})`),'AI manager notification '+status);assert.equal((await row(p.id)).automationStatus.state,expected);assert.equal((await row(q.id)).automationStatus.state,'closed');assert.doesNotMatch(JSON.stringify(await row(p.id)),/private-manager-fixture|918273645|memberId|"approval":/);}}
   finally{agent.state=previous;agent.emit();}
   return {actualManagerNotifications:5,crossProfileActivity:false,taskContentReturned:false};
  });
  await check('global scheduling means waiting only for an enabled profile plan and active ownership alone means running',async()=>{
   engine.db.plans.push({id:'manager-status-local-plan',profileId:p.id,productId:'local-status-product',enabled:true});engine.running=true;engine.emit();assert.equal((await row(p.id)).automationStatus.state,'waiting');assert.equal((await row(q.id)).automationStatus.state,'closed');const controller=new AbortController();engine.active.set(p.id,controller);engine.emit();assert.equal((await row(p.id)).automationStatus.state,'running');assert.equal((await row(q.id)).automationStatus.state,'closed');controller.abort();engine.emit();assert.equal((await row(p.id)).automationStatus.state,'stopping');engine.active.delete(p.id);engine.running=false;engine.db.plans=originalDB.plans.slice();engine.emit();
   return {perProfileOwnership:true,globalRunningDoesNotMarkEveryProfileRunning:true};
  });
  await check('navigation, window close and browser-data clear invalidate live observations while retaining truthful history',async()=>{
   const tab=w.tabs.find(item=>item.id===w.activeTab),c=tab.view.webContents;engine.bindMarketAccount(p.id,{...bound,verified:true,documentKey:await c.executeJavaScript('String(performance.timeOrigin)')});assert.equal((await row(p.id)).vintedStatus.state,'verified_recent');await c.loadURL('https://www.vinted.fr/member/login/email');assert.equal(engine.accountObservations.has(p.id),false);assert.equal((await row(p.id)).vintedStatus.state,'verified_history');
   engine.bindMarketAccount(p.id,{...bound,verified:true,documentKey:await c.executeJavaScript('String(performance.timeOrigin)')});w.close();await until(()=>!api.windows.has(p.id),'profile close');assert.equal(engine.accountObservations.has(p.id),false);assert.equal((await row(p.id)).vintedStatus.state,'verified_history');
   engine.db=JSON.parse(JSON.stringify(originalDB));engine.accounts.remove(account.id);account=null;engine.db.marketAccounts.push({...bound,profileId:p.id,verifiedAt:new Date().toISOString()});engine.accountObservations.set(p.id,{profileId:p.id,memberId:bound.memberId,verified:true,documentKey:'old-closed-document',checkedAt:new Date().toISOString()});await s.cookies.set({url:'https://www.vinted.fr/',name:'manager-status-local-cookie',value:'local-only'});await api.clearProfile(p.id);assert.equal(engine.accountObservations.has(p.id),false);assert.equal((await s.cookies.get({name:'manager-status-local-cookie'})).length,0);assert.equal((await row(p.id)).vintedStatus.state,'verified_history');
   return {navigationInvalidates:true,closeInvalidates:true,clearInvalidates:true,historyNeverRealtime:true};
  });
 }finally{
  engine.running=false;engine.active.delete(p?.id);if(w&&!w.isDestroyed()){w.aiAgent.state.running=false;w.close();await until(()=>!api.windows.has(p.id),'status fixture browser cleanup');}
  engine.db=originalDB;engine.accountObservations.delete(p?.id);engine.accountObservations.delete(q?.id);if(account)engine.accounts.remove(account.id);s?.protocol.unhandle('https');engine.persist();engine.emit();
  for(const profile of [p,q])if(profile&&!api.windows.has(profile.id))await api.deleteProfile(profile.id);await js('window.__statusTarget=null;window.__statusEvents=[];true');
 }
};
