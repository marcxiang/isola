'use strict';
const assert=require('node:assert/strict'),http=require('node:http');
const {app}=require('electron');
const {buildFingerprintConfig,DEVICE_PRESETS}=require('../src/fingerprint-config.cjs');

// Run with: electron test/focused-electron.cjs --modules=fingerprint-smoke
// The focused runner supplies a fresh ISOLA_TEST_DATA directory. This fixture
// never visits a public website or reads an existing environment's data.
module.exports=async function(api,check){
  const read=async()=>{
    const hints=navigator.userAgentData?await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','platformVersion','fullVersionList','model','wow64']):null;
    return {ua:navigator.userAgent,platform:navigator.platform,language:navigator.language,languages:[...navigator.languages],cpu:navigator.hardwareConcurrency,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,hints,
      ...(typeof screen==='object'?{screen:{width:screen.width,height:screen.height,dpr:devicePixelRatio},viewport:{width:innerWidth,height:innerHeight},touch:navigator.maxTouchPoints,pointer:{coarse:matchMedia('(pointer: coarse)').matches,hover:matchMedia('(hover: hover)').matches},webdriver:navigator.webdriver}:{})};
  };
  const readSource=read.toString();
  const requests=[];
  const server=http.createServer((req,res)=>{
    const headers={ua:req.headers['user-agent'],language:req.headers['accept-language'],platform:req.headers['sec-ch-ua-platform']??null,mobile:req.headers['sec-ch-ua-mobile']??null,architecture:req.headers['sec-ch-ua-arch']??null,model:req.headers['sec-ch-ua-model']??null,platformVersion:req.headers['sec-ch-ua-platform-version']??null};
    requests.push({url:req.url,headers});
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Accept-CH','Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Model, Sec-CH-UA-Bitness, Sec-CH-UA-Full-Version-List');
    if(req.url.includes('/headers')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(headers));return;}
    if(req.url.endsWith('/worker.js')||req.url.endsWith('/nested.js')){res.setHeader('Content-Type','application/javascript');res.end('const read='+readSource+';self.onmessage=async()=>postMessage(await read());');return;}
    if(req.url.endsWith('/shared.js')){res.setHeader('Content-Type','application/javascript');res.end('const read='+readSource+';self.onconnect=e=>{const port=e.ports[0];port.start();read().then(data=>port.postMessage(data))};');return;}
    if(req.url.endsWith('/sw.js')){res.setHeader('Content-Type','application/javascript');res.end('const read='+readSource+';self.addEventListener("install",e=>self.skipWaiting());self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));self.onmessage=e=>e.waitUntil(read().then(data=>e.ports[0].postMessage(data)));');return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Isola fingerprint local fixture</title><body><script>window.readFingerprint='+readSource+';'+(req.url.endsWith('/frame')?'readFingerprint().then(data=>parent.postMessage({kind:"fingerprint-fixture",data},"*"));':'')+'</script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const runtime={platform:process.platform,arch:process.arch,osVersion:process.getSystemVersion(),chromeVersion:process.versions.chrome,userAgent:app.userAgentFallback.replace(/ Isola\/[^ ]+| Electron\/[^ ]+/g,'')};
  const close=async p=>{const w=api.windows.get(p.id);if(w&&!w.isDestroyed()){const closed=new Promise(resolve=>w.once('closed',resolve));w.close();await closed;}await api.deleteProfile(p.id);};
  const differences=(page,other)=>['ua','platform','language','languages','cpu','timezone','hints'].filter(key=>JSON.stringify(page[key])!==JSON.stringify(other[key])).map(field=>({field,page:page[field],worker:other[field]}));
  function assertIdentity(actual,expected){
    assert.equal(actual.ua,expected.userAgent);
    assert.equal(actual.platform,expected.userAgentOverride.platform);
    assert.equal(actual.language,'fr-FR');assert.equal(actual.timezone,'Europe/Paris');if(expected.hardwareConcurrency)assert.equal(actual.cpu,expected.hardwareConcurrency);
    assert.deepEqual(actual.screen,{width:expected.deviceMetrics.screenWidth,height:expected.deviceMetrics.screenHeight,dpr:expected.deviceMetrics.deviceScaleFactor});
    assert.deepEqual(actual.viewport,{width:expected.deviceMetrics.width,height:expected.deviceMetrics.height});
    assert.equal(actual.touch,expected.touchEmulation.maxTouchPoints||0);
    const metadata=expected.userAgentOverride.userAgentMetadata;
    if(metadata){for(const key of ['platform','platformVersion','architecture','bitness','model','mobile','brands','fullVersionList'])assert.deepEqual(actual.hints[key],metadata[key],key);}
    else{assert.ok(!actual.hints?.platform,'metadata omission must not expose a host platform');assert.ok(!actual.hints?.brands?.length,'metadata omission must not expose host brands');}
    assert.equal(actual.webdriver,false);
  }
  let active;
  try{
    for(const operatingSystem of ['windows','macos','linux','android','ios']){
      const p=active=api.saveProfile({name:'QA selected '+operatingSystem,operatingSystem,language:'fr-FR',timezone:'Europe/Paris',hardwareConcurrency:4,url:origin+'/'+operatingSystem+'/page'});
      const expected=buildFingerprintConfig(p,runtime);let w,c,page;
      await check(operatingSystem+' selection applies UA, platform, UA-CH, screen, DPR, touch, CPU and locale',async()=>{
        await api.launch(p.id);w=api.windows.get(p.id);c=w.tabs[0].view.webContents;
        page=await c.executeJavaScript('readFingerprint()');assertIdentity(page,expected);
        assert.equal(api.sesFor(p).getUserAgent(),expected.userAgent);
        assert.equal(c.getWebRTCIPHandlingPolicy(),expected.webRTCPolicy);
        if(expected.summary.mobile){assert.equal(page.pointer.coarse,true);assert.equal(page.pointer.hover,false);}
        return page;
      });
      await check(operatingSystem+' initial navigation and subsequent network headers match selected identity',async()=>{
        const initial=requests.find(row=>row.url==='/'+operatingSystem+'/page');assert.equal(initial.headers.ua,page.ua);
        const headers=await c.executeJavaScript('fetch("/headers").then(r=>r.json())');assert.equal(headers.ua,page.ua);assert.ok(headers.language.startsWith(page.language),headers.language);
        const metadata=expected.userAgentOverride.userAgentMetadata;
        assert.equal(headers.platform,metadata?JSON.stringify(metadata.platform):null);assert.equal(headers.mobile,metadata?(metadata.mobile?'?1':'?0'):null);
        // Chromium can withhold high-entropy request hints on this local HTTP
        // fixture. When sent, they must agree with the generated metadata; the
        // JavaScript high-entropy values are independently asserted above.
        if(metadata){for(const key of ['architecture','platformVersion','model'])if(headers[key]!==null)assert.equal(headers[key],JSON.stringify(metadata[key]),key);}
        return {headers,highEntropyNetworkHintsSent:headers.architecture!==null};
      });
      await check(operatingSystem+' newly opened tab keeps the same selected identity',async()=>{
        await w.webContents.executeJavaScript('window.browser.navigate("new")');await w.webContents.executeJavaScript('window.browser.navigate("go",'+JSON.stringify(origin+'/'+operatingSystem+'/page2')+')');
        const second=w.tabs.at(-1).view.webContents;const value=await second.executeJavaScript('readFingerprint()');assertIdentity(value,expected);return {ua:value.ua,platform:value.platform,touch:value.touch};
      });
      if(operatingSystem==='android'){
        await check('Android dedicated Worker receives supported overrides and records remaining host differences',async()=>{
          const worker=await c.executeJavaScript(`new Promise((resolve,reject)=>{const worker=new Worker('/android/worker.js'),timer=setTimeout(()=>{worker.terminate();reject(Error('Worker timeout'))},6000);worker.onmessage=e=>{clearTimeout(timer);worker.terminate();resolve(e.data)};worker.onerror=()=>{clearTimeout(timer);worker.terminate();reject(Error('Worker error'))};worker.postMessage('read');})`);
          for(const key of ['ua','language','languages','cpu','timezone','hints'])assert.deepEqual(worker[key],page[key],key);
          return {page,worker,differences:differences(page,worker),coverage:'Chromium WorkerNavigator.platform can retain the host platform. This observation is not a normal-phone or undetectability guarantee.'};
        });
        await check('Android cross-origin iframe retains selected page identity',async()=>{
          const frameOrigin='http://localhost:'+server.address().port;
          const frame=await c.executeJavaScript(`new Promise((resolve,reject)=>{const f=document.createElement('iframe'),timer=setTimeout(()=>{f.remove();reject(Error('iframe timeout'))},6000);const listener=e=>{if(e.source!==f.contentWindow||e.origin!==${JSON.stringify(frameOrigin)}||e.data.kind!=='fingerprint-fixture')return;clearTimeout(timer);removeEventListener('message',listener);f.remove();resolve(e.data.data)};addEventListener('message',listener);f.src=${JSON.stringify(frameOrigin+'/android/frame')};document.body.append(f);})`);
          for(const key of ['ua','platform','language','languages','cpu','timezone','hints'])assert.deepEqual(frame[key],page[key],key);
          return {ua:frame.ua,platform:frame.platform,hints:frame.hints};
        });
        await check('Android Shared Worker and Service Worker record snapshots or bounded unavailability',async()=>{
          const shared=await c.executeJavaScript(`new Promise((resolve,reject)=>{const worker=new SharedWorker('/android/shared.js'),timer=setTimeout(()=>{worker.port.close();reject(Error('SharedWorker timeout'))},6000);worker.port.onmessage=e=>{clearTimeout(timer);worker.port.close();resolve(e.data)};worker.onerror=()=>{clearTimeout(timer);worker.port.close();reject(Error('SharedWorker error'))};worker.port.start();})`);
          const service=await c.executeJavaScript(`new Promise(async resolve=>{let reg,stage='register';const unavailable=error=>({error,stage,active:reg?.active?.state||null,waiting:reg?.waiting?.state||null,installing:reg?.installing?.state||null});const timer=setTimeout(()=>{const result=unavailable('Service Worker fixture did not return within 6 seconds');reg?.unregister();resolve(result)},6000);try{reg=await navigator.serviceWorker.register('/android/sw.js');stage='ready';await navigator.serviceWorker.ready;stage='message';const channel=new MessageChannel();channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();reg.unregister();resolve(e.data)};reg.active.postMessage('read',[channel.port2]);}catch(e){clearTimeout(timer);reg?.unregister();resolve(unavailable(e.message))}})`);
          assert.ok(shared.ua,'Shared Worker must return an actual navigator snapshot');assert.ok(service.ua||service.error,'Service Worker must return a snapshot or an explicit unavailable reason');
          return {shared,service,sharedDifferences:differences(page,shared),serviceDifferences:service.ua?differences(page,service):null,coverage:'Actual worker snapshots, every mismatch and unsupported probes are recorded; unsupported Chromium fields are not replaced with page JavaScript.'};
        });
      }
      await close(p);active=null;
    }
    for(const presetId of ['pixel7','galaxy-s23','iphone13','iphone14pro']){
      await check(presetId+' device preset applies its model, geometry, DPR, touch and CPU',async()=>{
        const p=active=api.saveProfile({...DEVICE_PRESETS[presetId],name:'QA device '+presetId,language:'fr-FR',timezone:'Europe/Paris',webRTCPolicy:'default_public_interface_only',url:origin+'/'+presetId+'/page'});
        const expected=buildFingerprintConfig(p,runtime);await api.launch(p.id);const c=api.windows.get(p.id).tabs[0].view.webContents;
        const value=await c.executeJavaScript('readFingerprint()');assertIdentity(value,expected);assert.equal(c.getWebRTCIPHandlingPolicy(),'default_public_interface_only');
        if(p.operatingSystem==='android'){assert.ok(value.ua.includes(p.deviceModel));assert.equal(value.hints.model,p.deviceModel);}
        assert.equal(value.pointer.coarse,true);assert.equal(value.pointer.hover,false);
        await close(p);active=null;return {deviceModel:p.deviceModel,ua:value.ua,hints:value.hints,screen:value.screen,touch:value.touch,cpu:value.cpu};
      });
    }
    await check('mobile mouse input and direct touch each produce one trusted finger click',async()=>{
      const p=active=api.saveProfile({...DEVICE_PRESETS.pixel7,name:'QA mobile manual input',url:origin+'/manual/page'});await api.launch(p.id);
      const w=api.windows.get(p.id),c=w.tabs[0].view.webContents;w.show();w.focus();c.focus();c.setBackgroundThrottling(false);
      await c.executeJavaScript(`document.body.innerHTML='<button id="finger" style="display:block;margin:24px 16px;width:320px;height:160px">Phone input</button>';window.fingerEvents=[];window.fingerClicks=0;for(const type of ['pointerdown','pointerup','touchstart','touchend','click'])document.addEventListener(type,e=>fingerEvents.push({type:e.type,target:e.target.id,trusted:e.isTrusted,pointerType:e.pointerType||null}),{capture:true,passive:true});document.querySelector('#finger').onclick=()=>fingerClicks++;true`);
      await c.executeJavaScript('new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Phone fixture did not paint")),1500);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true)}));})');
      const point=await c.executeJavaScript('(()=>{const r=document.querySelector("#finger").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
      const receipts=[];
      for(const kind of ['mouse','touch']){
        await c.executeJavaScript('fingerEvents=[];fingerClicks=0;true');
        if(kind==='mouse'){c.sendInputEvent({type:'mouseMove',...point});await new Promise(resolve=>setTimeout(resolve,40));c.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});await new Promise(resolve=>setTimeout(resolve,40));c.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});}
        else{await c.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await c.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
        await new Promise(resolve=>setTimeout(resolve,650));const receipt=await c.executeJavaScript('({clicks:fingerClicks,events:fingerEvents})');assert.equal(receipt.clicks,1,kind);assert.ok(receipt.events.every(event=>event.trusted));for(const type of ['touchstart','touchend','pointerdown','pointerup','click'])assert.equal(receipt.events.filter(event=>event.type===type&&event.target==='finger').length,1,kind+' '+type);assert.ok(receipt.events.filter(event=>event.type.startsWith('pointer')||event.type==='click').every(event=>event.pointerType==='touch'));receipts.push({kind,...receipt});
      }
      await close(p);active=null;return receipts;
    });
    await check('unrecognized custom UA suppresses host client hints and keeps an explicit coherent platform',async()=>{
      const p=active=api.saveProfile({name:'QA custom UA',operatingSystem:'windows',ua:'IsolaLocalFixture/1',language:'fr-FR',timezone:'Europe/Paris',hardwareConcurrency:4,url:origin+'/custom/page'});
      const expected=buildFingerprintConfig(p,runtime);await api.launch(p.id);const c=api.windows.get(p.id).tabs[0].view.webContents;
      const value=await c.executeJavaScript('readFingerprint()');assertIdentity(value,expected);const headers=await c.executeJavaScript('fetch("/headers").then(r=>r.json())');assert.equal(headers.ua,p.ua);assert.equal(headers.platform,null);assert.equal(headers.mobile,null);
      await close(p);active=null;return {ua:value.ua,platform:value.platform,hints:value.hints,headers};
    });
    await check('native mode preserves host identity and ignores selected mobile fingerprint fields',async()=>{
      const p=active=api.saveProfile({name:'QA native ignores mobile',fingerprintMode:'native',operatingSystem:'android',ua:'Ignored-UA',language:'ja-JP',timezone:'Asia/Tokyo',hardwareConcurrency:2,url:origin+'/native/page'});
      await api.launch(p.id);const c=api.windows.get(p.id).tabs[0].view.webContents;const value=await c.executeJavaScript('readFingerprint()');
      assert.equal(value.ua,runtime.userAgent);assert.equal(value.platform,{win32:'Win32',darwin:'MacIntel',linux:process.arch==='arm64'?'Linux aarch64':'Linux x86_64'}[process.platform]);
      const host=await api.getManager().webContents.executeJavaScript('('+readSource+')()');
      assert.ok(!value.ua.includes('Ignored-UA'));for(const key of ['cpu','timezone','language','touch'])assert.equal(value[key],host[key],key);
      return {ua:value.ua,platform:value.platform,cpu:value.cpu,timezone:value.timezone,language:value.language,touch:value.touch};
    });
    await close(active);active=null;
  }finally{if(active)await close(active);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
};
