'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {saveSettings,publicSettings}=require('../src/ai.cjs');
const {settingsPath}=require('../src/ai-settings-store.cjs');
const until=async predicate=>{const end=Date.now()+6000;while(!predicate()){if(Date.now()>end)throw Error('AI isolation fixture timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
module.exports=async function aiProfiles(api,check){
 let a,b,wa,wb,holdB=true,pendingB=[],requests=[];
 const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'){const who=new URL(req.url,'http://fixture.local').searchParams.get('who')||'none';res.setHeader('content-type','text/html');res.end('<!doctype html><title>Scoped fixture '+who+'</title><h1>Page marker '+who+'</h1>');return;}
  let raw='';try{for await(const chunk of req)raw+=chunk;}catch{return;}
  const who=req.url.startsWith('/a/')?'a':'b';requests.push({who,raw,authorization:req.headers.authorization});
  const answer=()=>{if(res.destroyed)return;res.setHeader('content-type','application/json');res.end(JSON.stringify({output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'已读取当前页面标记 '+who+'。'}]}]}));};
  if(who==='a')return;if(holdB)pendingB.push(answer);else answer();
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const config=(who,key)=>({baseURL:origin+'/'+who+'/v1',protocol:'responses',model:'fixture-model-'+who,apiKey:key,maxSteps:4,visionEnabled:false});
 const flushB=()=>{holdB=false;for(const fn of pendingB.splice(0))fn();};
 try{
  // This is the previous application-wide configuration, migrated as an
  // independent encrypted snapshot on each environment's first use.
  saveSettings(config('legacy','legacy-fixture-key'));
  a=api.saveProfile({name:'QA AI isolated A',url:origin+'/?who=a',fingerprintMode:'native'});b=api.saveProfile({name:'QA AI isolated B',url:origin+'/?who=b',fingerprintMode:'native'});
  await api.launch(a.id);await api.launch(b.id);wa=api.windows.get(a.id);wb=api.windows.get(b.id);
  const settings=w=>w.webContents.executeJavaScript('window.browser.aiSettings()');
  const save=(w,value)=>w.webContents.executeJavaScript('window.browser.aiSaveSettings('+JSON.stringify(value)+')');
  await check('model settings migrate once and window IPC can change only its own environment settings',async()=>{
   const beforeA=await settings(wa),beforeB=await settings(wb);assert.equal(beforeA.model,'fixture-model-legacy');assert.equal(beforeB.model,'fixture-model-legacy');assert.equal(beforeA.apiKey,undefined);assert.equal(beforeA.encryptedKey,undefined);
   await save(wa,config('a','fixture-key-a'));assert.equal((await settings(wa)).model,'fixture-model-a');assert.equal((await settings(wb)).model,'fixture-model-legacy');assert.equal(publicSettings().model,'fixture-model-legacy');
   await save(wb,config('b','fixture-key-b'));assert.equal((await settings(wa)).model,'fixture-model-a');assert.equal((await settings(wb)).model,'fixture-model-b');assert.equal((await settings(wa)).scope,'environment');
   for(const [p,key]of [[a,'fixture-key-a'],[b,'fixture-key-b']])assert.ok(!fs.readFileSync(settingsPath(path.dirname(api.dataFile()),p.id),'utf8').includes(key));
   await save(wa,{...config('a',''),clearKey:true});assert.equal((await settings(wa)).hasKey,false);assert.equal((await settings(wb)).hasKey,true);await save(wa,config('a','fixture-key-a'));
   return {perEnvironment:true,keysEncrypted:true,otherWindowUnchanged:true};
  });
  await check('browser toolbar sessions are separate from websites and from other environment toolbars',async()=>{
   assert.notEqual(wa.webContents.session,wb.webContents.session);assert.notEqual(wa.webContents.session,api.sesFor(a));await wa.webContents.executeJavaScript('localStorage.setItem("isolation-toolbar","a")');assert.equal(await wb.webContents.executeJavaScript('localStorage.getItem("isolation-toolbar")'),null);
  });
  await check('concurrent model histories, bearer keys, pause and stop remain scoped to their own window',async()=>{
   const ta=wa.aiAgent.start('Read the alpha-only goal marker'),tb=wb.aiAgent.start('Read the beta-only goal marker');await until(()=>requests.some(row=>row.who==='a')&&requests.some(row=>row.who==='b'));
   wa.aiAgent.pause();await until(()=>wa.aiAgent.state.status==='paused');assert.equal(wb.aiAgent.state.running,true);assert.equal(wb.aiAgent.pauseRequested,false);assert.equal(wb.aiAgent.controller.signal.aborted,false);
   wa.aiAgent.stop();await ta;assert.equal(wb.aiAgent.state.running,true);flushB();const result=await tb;assert.equal(result.status,'complete');
   const aRequests=requests.filter(row=>row.who==='a'),bRequests=requests.filter(row=>row.who==='b');assert.ok(aRequests.every(row=>row.authorization==='Bearer fixture-key-a'&&!row.raw.includes('beta-only')));assert.ok(bRequests.every(row=>row.authorization==='Bearer fixture-key-b'&&!row.raw.includes('alpha-only')));assert.ok(bRequests.every(row=>JSON.parse(row.raw).model==='fixture-model-b'));
   return {separateHistories:true,separateKeys:true,pauseAndStopLocal:true};
  });
  await check('closing one environment cannot cancel another environment model request',async()=>{
   holdB=true;requests=[];const task=wb.aiAgent.start('Read beta after another window closes');await until(()=>pendingB.length>0);wa.close();await until(()=>!api.windows.has(a.id));assert.equal(wb.isDestroyed(),false);assert.equal(wb.aiAgent.state.running,true);assert.equal(wb.aiAgent.controller.signal.aborted,false);flushB();assert.equal((await task).status,'complete');
  });
  await check('deleting an environment removes its private model key before an identifier can be reused',async()=>{
   const dir=path.dirname(api.dataFile());await api.deleteProfile(a.id);assert.equal(fs.existsSync(settingsPath(dir,a.id)),false);assert.equal((await settings(wb)).model,'fixture-model-b');const replacement=api.saveProfile({id:a.id,name:'QA fresh reused identifier',url:origin,fingerprintMode:'native'});assert.equal(publicSettings(replacement.id).model,'fixture-model-legacy');assert.equal(publicSettings(replacement.id).hasKey,true);
  });
 }finally{
  wa?.aiAgent?.stop();wb?.aiAgent?.stop();flushB();for(const w of [wa,wb])if(w&&!w.isDestroyed())w.close();await new Promise(r=>setTimeout(r,250));for(const p of [a,b])if(p&&!api.windows.has(p.id))await api.deleteProfile(p.id);server.closeAllConnections();await new Promise(r=>server.close(r));
 }
};
