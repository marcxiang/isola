'use strict';
const assert = require('node:assert/strict'), http = require('node:http');
const { DEVICE_PRESETS } = require('../src/fingerprint-config.cjs');
const {getDisplayState} = require('../src/display-transform.cjs');
const {snapshot,performAction} = require('../src/page-control.cjs');

// Run with: electron test/focused-electron.cjs --modules=fingerprint-resize-smoke
// Local fixture only. Phone outer metrics are measured and compared, desktop
// outer metrics are observations. No GPU, available-screen or iOS hints invented.
module.exports = async function fingerprintResize(api, check) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fixture = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixed device viewport</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font:16px sans-serif;background:linear-gradient(135deg,#eff4fb,#c8d8ee)}h1{position:absolute;left:24px;top:165px;font-size:24px;color:#243b57}button{position:absolute;width:160px;height:76px;background:white;border:2px solid #5388c7;border-radius:10px;color:#243b57;font:16px sans-serif}#near{left:24px;top:56px}#far{right:24px;bottom:48px}</style><h1>Fixed device viewport</h1><button id="near">Near target</button><button id="far">Far target</button><script>window.fixtureClicks=[];window.fixtureEvents=[];for(const type of ['pointerdown','pointerup','touchstart','touchend','mousedown','mouseup','click'])document.addEventListener(type,e=>{const value={type,target:e.target.id,trusted:e.isTrusted,x:e.clientX??e.changedTouches?.[0]?.clientX,y:e.clientY??e.changedTouches?.[0]?.clientY,pointerType:e.pointerType||null};fixtureEvents.push(value);if(type==='click')fixtureClicks.push(value);},{capture:true,passive:true});</script>`;
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let profile, window;
  const residents = [];
  const mobile = preset => ['android','ios'].includes(preset.operatingSystem);
  const options = () => ({signal:new AbortController().signal,allowedOrigins:new Set([origin]),approve:async()=>{throw Error('Unexpected approval');}});
  async function bounded(work, label, ms = 5000) {
    let timer;
    try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms); })]); }
    finally { clearTimeout(timer); }
  }
  const ui = expression => bounded(window.webContents.executeJavaScript(expression), 'Toolbar IPC: ' + expression, 10000);
  async function waitFor(predicate, label) {
    const until = Date.now() + 4000;
    while (Date.now() < until) { if (predicate()) return; await pause(40); }
    throw Error(label + ' did not settle');
  }
  async function focusInput(targetWindow=window,tab=targetWindow.tabs.find(row=>row.id===targetWindow.activeTab)) {
    // A macOS test app can remain inactive after resize even when its window is
    // visible. Establish the actual foreground precondition before checking a
    // foreground-only overlay; do not weaken the production focus boundary.
    if(process.platform==='darwin')require('electron').app.focus({steal:true});
    targetWindow.show();targetWindow.focus();
    await waitFor(()=>!targetWindow.isDestroyed()&&targetWindow.isFocused(),'Foreground input window');
    tab?.view.webContents.focus();
  }
  async function settle(targetWindow = window) {
    // Native bounds alone are insufficient: the newest CDP metrics must also be
    // acknowledged. Inactive views intentionally remain not-ready for input.
    let previous = '', repeated = 0;
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const active=targetWindow.tabs.find(tab=>tab.id===targetWindow.activeTab);
      if(active)await bounded(active.display.whenReady(),'Display ready',10000);
      const states=targetWindow.tabs.map(tab=>({actual:tab.view.getBounds(),display:getDisplayState(tab.view.webContents)}));
      for(const state of states)assert.deepEqual(state.actual,state.display.bounds,'Newest acknowledged display bounds must match the actual native view');
      if(active)assert.equal(getDisplayState(active.view.webContents).ready,true);
      const current = JSON.stringify({ content: targetWindow.getContentBounds(), states });
      repeated = current === previous ? repeated + 1 : 0;
      if (repeated >= 3) return;
      previous = current; await pause(60);
    }
    throw Error('External window/view layout did not settle');
  }
  async function read(tab, includeGraphics = false) {
    return bounded(tab.view.webContents.executeJavaScript(`(async()=>{
      let hints=null;
      if(navigator.userAgentData){
        const value=await navigator.userAgentData.getHighEntropyValues(['model','architecture','bitness','platformVersion','fullVersionList']);
        hints={brands:value.brands,mobile:value.mobile,platform:value.platform,model:value.model,architecture:value.architecture,bitness:value.bitness,platformVersion:value.platformVersion,fullVersionList:value.fullVersionList};
      }
      const v=visualViewport,round=n=>Math.round(n*10000)/10000;
      const identity={ua:navigator.userAgent,platform:navigator.platform,hints,
        screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,colorDepth:screen.colorDepth,pixelDepth:screen.pixelDepth,orientation:screen.orientation?{type:screen.orientation.type,angle:screen.orientation.angle}:null},
        dpr:devicePixelRatio,inner:{width:innerWidth,height:innerHeight},
        visualViewport:v?{width:round(v.width),height:round(v.height),scale:round(v.scale),offsetLeft:round(v.offsetLeft),offsetTop:round(v.offsetTop)}:null,
        touch:navigator.maxTouchPoints,pointer:{coarse:matchMedia('(pointer:coarse)').matches,hover:matchMedia('(hover:hover)').matches}};
      let graphics;
      if(${JSON.stringify(includeGraphics)}){const gl=document.createElement('canvas').getContext('webgl'),ext=gl?.getExtension('WEBGL_debug_renderer_info');graphics=ext?{vendor:gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),renderer:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}:null;gl?.getExtension('WEBGL_lose_context')?.loseContext();}
      return {identity,outer:{width:outerWidth,height:outerHeight},...(graphics!==undefined?{graphics}:{})};
    })()`), 'Phone measurement');
  }
  function expectedIdentity(value, preset) {
    const actual = value.identity;
    assert.deepEqual(actual.inner, { width: preset.width, height: preset.height });
    assert.equal(actual.screen.width, preset.screenWidth); assert.equal(actual.screen.height, preset.screenHeight);
    assert.equal(actual.dpr, preset.deviceScaleFactor); assert.equal(actual.touch, preset.maxTouchPoints);
    assert.deepEqual(actual.pointer, { coarse: mobile(preset), hover: !mobile(preset) });
    assert.ok(actual.visualViewport, 'Window visualViewport must be measured');
    assert.ok(Math.abs(actual.visualViewport.width - preset.width) < 0.01);
    assert.ok(Math.abs(actual.visualViewport.height - preset.height) < 0.01);
    assert.equal(actual.visualViewport.scale, 1);
    if (preset.operatingSystem === 'android') {
      assert.equal(actual.hints?.model, preset.deviceModel); assert.equal(actual.hints?.platform, 'Android'); assert.equal(actual.hints?.mobile, true);
    } else if(preset.operatingSystem==='ios') {
      assert.ok(!actual.hints?.platform, 'iOS compatibility preset must not expose the host UA-CH platform');
      assert.ok(!actual.hints?.brands?.length, 'iOS compatibility preset must not expose the host UA-CH brands');
    } else {assert.equal(actual.hints?.platform,'Windows');assert.equal(actual.hints?.mobile,false);}
    // setDeviceMetricsOverride has screenWidth/screenHeight, but no independent
    // availWidth/availHeight override. Preserve the actual baseline below rather
    // than claiming those available dimensions are a separately selected preset.
    for (const field of ['availWidth', 'availHeight']) assert.ok(Number.isFinite(actual.screen[field]), field);
  }
  async function measure(label, tab, baseline, preset) {
    await settle(); const value = await read(tab);
    expectedIdentity(value, preset);
    assert.deepEqual(value.identity, baseline.identity, preset.deviceModel + ': ' + label);
    if(mobile(preset))assert.deepEqual(value.outer,baseline.outer,'Phone outer viewport remains independent of the real outer window');
    return { stage: label, content: window.getContentBounds(), view: tab.view.getBounds(), display:getDisplayState(tab.view.webContents), ...value };
  }
  async function close(targetProfile = profile,targetWindow = window) {
    if (targetWindow && !targetWindow.isDestroyed()) {
      const closed = new Promise(resolve => targetWindow.once('closed', resolve)); targetWindow.close(); await bounded(closed, 'Fixture window close', 15000);
    }
    if (targetProfile && !api.windows.has(targetProfile.id)&&api.getProfiles().some(row=>row.id===targetProfile.id)) await api.deleteProfile(targetProfile.id);
    if(targetWindow===window){window = null; profile = null;}
  }
  async function point(tab,id){return tab.view.webContents.executeJavaScript('(()=>{const r=document.querySelector('+JSON.stringify('#'+id)+').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})()');}
  async function reset(tab){await tab.view.webContents.executeJavaScript('fixtureClicks=[];fixtureEvents=[];true');}
  async function receipt(tab,id,preset){
    await pause(100);const value=await tab.view.webContents.executeJavaScript('({clicks:fixtureClicks,events:fixtureEvents})');
    assert.equal(value.clicks.length,1,'Exactly one real DOM click: '+JSON.stringify({target:id,device:preset.deviceModel,...value}));assert.equal(value.clicks[0].target,id);assert.equal(value.clicks[0].trusted,true);
    assert.ok(value.events.every(event=>event.trusted),'All pointer events are trusted');
    for(const type of ['pointerdown','pointerup','click',...(mobile(preset)?['touchstart','touchend']:['mousedown','mouseup'])])assert.equal(value.events.filter(event=>event.type===type&&event.target===id).length,1,type+' on '+id);
    const expected=await point(tab,id),actual=value.clicks[0];assert.ok(actual.x>=expected.rect.x&&actual.x<=expected.rect.x+expected.rect.width&&actual.y>=expected.rect.y&&actual.y<=expected.rect.y+expected.rect.height,'Click coordinates remain inside the intended CSS target');
    return value;
  }
  async function find(tab,id){const state=await snapshot(tab),label=id==='near'?'Near target':'Far target',element=state.elements.find(row=>row.label===label);assert.ok(element,'Missing '+label);return element;}
  async function aiClick(tab,id,extra={}){const element=await find(tab,id);return performAction(tab,{action:'click',elementId:element.id},{...options(),...extra});}
  async function screenshot(targetWindow,name){
    try{
      await pause(180);const {desktopCapturer}=require('electron'),fs=require('node:fs'),path=require('node:path');
      const sources=await bounded(desktopCapturer.getSources({types:['window'],thumbnailSize:{width:1500,height:1100}}),'Window screenshot',5000),source=sources.find(row=>row.id===targetWindow.getMediaSourceId());
      if(!source||source.thumbnail.isEmpty())return {saved:false,reason:'Window thumbnail unavailable'};
      const file=path.join(__dirname,'../test-artifacts',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source.thumbnail.toPNG());return {saved:true,file};
    }catch(error){return {saved:false,reason:error.message};}
  }
  try {
    for (const presetId of ['pixel7', 'iphone13','windows-desktop']) {
      const preset = presetId==='windows-desktop'?{operatingSystem:'windows',deviceModel:'',width:1280,height:800,screenWidth:1280,screenHeight:800,deviceScaleFactor:1,maxTouchPoints:0}:DEVICE_PRESETS[presetId];
      profile = api.saveProfile({ ...preset, name: 'QA fixed viewport ' + presetId, fingerprintMode: 'custom', language: 'fr-FR', timezone: 'Europe/Paris', url: origin + '/' + presetId });
      await api.launch(profile.id); window = api.windows.get(profile.id); await focusInput();
      const first = window.tabs[0]; first.view.webContents.setBackgroundThrottling(false);
      await settle(); const baseline = await read(first, true); expectedIdentity(baseline, preset);
      const original = window.getBounds();
      await check(presetId + ' repeated real window resizing preserves the complete measured phone viewport', async () => {
        const stages = [];
        for (const [width, height] of [[1180, 940], [740, 560], [1360, 1000], [original.width, original.height]]) {
          window.setSize(width, height, false);
          stages.push(await measure('resize ' + width + 'x' + height, first, baseline, preset));
        }
        assert.ok(new Set(stages.map(stage => stage.content.width + 'x' + stage.content.height)).size > 1, 'The real outer window must actually resize');
        return { baseline, stages, availableScreen: 'Actual baseline preserved; no independent available-screen setting', outerWindow: mobile(preset)?'Measured phone outer metrics remain fixed':'Desktop outer metrics recorded separately' };
      });
      await check(presetId + ' maximize and restore preserve screen, DPR, visual viewport, touch and model', async () => {
        window.maximize(); await waitFor(() => window.isMaximized(), 'Maximize');
        const maximized = await measure('maximized', first, baseline, preset);
        window.unmaximize(); await waitFor(() => !window.isMaximized(), 'Restore');
        const restored = await measure('restored', first, baseline, preset);
        return { maximized, restored };
      });
      await check(presetId + ' AI panel open, close and resize leave phone geometry fixed', async () => {
        const stages = [];
        for (const open of [true, false, true]) {
          await ui('window.browser.aiPanel(' + JSON.stringify(open) + ')');
          assert.equal(window.aiPanelOpen, open);
          stages.push(await measure('AI panel ' + open, first, baseline, preset));
        }
        window.setSize(920, 680, false); stages.push(await measure('resize with AI panel', first, baseline, preset));
        await ui('window.browser.aiPanel(false)');
        stages.push(await measure('AI panel closed after resize', first, baseline, preset));
        return stages;
      });
      await check(presetId + ' tab switch and new-tab navigation preserve the selected phone parameters', async () => {
        const stages = [];
        await ui('window.browser.navigate("new")');
        await ui('window.browser.navigate("go",' + JSON.stringify(origin + '/' + presetId + '/second') + ')');
        const second = window.tabs.at(-1); second.view.webContents.setBackgroundThrottling(false);
        assert.notEqual(second.id, first.id); stages.push(await measure('new tab', second, baseline, preset));
        for (const tab of [first, second, first]) {
          await ui('window.browser.navigate("switch",' + JSON.stringify(tab.id) + ')');
          assert.equal(window.activeTab, tab.id); stages.push(await measure('switch to ' + (tab === first ? 'first' : 'second'), tab, baseline, preset));
        }
        const final = await read(first, true); assert.deepEqual(final.graphics, baseline.graphics, 'Resize must not replace the actual host graphics identity');
        return { stages, graphics: final.graphics, graphicsScope: 'Actual host WebGL observation, not a selected phone GPU', clientHintsScope: preset.operatingSystem === 'ios' ? 'iOS compatibility on Chromium; UA-CH deliberately absent' : 'Measured Chromium Android model hints' };
      });
      await check(presetId+' native mouse input hits near and far CSS targets through the scaled view',async()=>{
        window.setSize(820,620,false);await settle();await focusInput(window,first);
        const c=first.view.webContents;await bounded(c.capturePage({x:0,y:0,width:1,height:1}),'First input frame');const values=[];
        for(const id of ['near','far']){
          await reset(first);const css=await point(first,id),scale=getDisplayState(c).scale,p={x:Math.round(css.x*scale),y:Math.round(css.y*scale)};
          c.sendInputEvent({type:'mouseMove',...p});await pause(35);c.sendInputEvent({type:'mouseDown',...p,button:'left',clickCount:1});await pause(35);c.sendInputEvent({type:'mouseUp',...p,button:'left',clickCount:1});values.push({id,scale,...await receipt(first,id,preset)});
        }
        return {values,screenshot:presetId==='pixel7'?await screenshot(window,'resize-window.png'):null};
      });
      await check(presetId+' AI mouse or touch and its visible overlay use the same noncentral scale mapping',async()=>{
        const c=first.view.webContents,values=[];
        const lifecycle=[];
        const state=()=>{const surface=window.controlOverlay.getWindow();return {focused:window.isFocused(),visible:window.isVisible(),minimized:window.isMinimized(),activeTab:window.activeTab===first.id,display:getDisplayState(c),overlayExists:!!surface&&!surface.isDestroyed(),overlayVisible:!!surface&&!surface.isDestroyed()&&surface.isVisible()};};
        const listeners=['focus','blur','resize','show','hide','minimize'].map(name=>{const listener=()=>{lifecycle.push({event:name,time:Date.now(),...state()});if(lifecycle.length>40)lifecycle.shift();};window.on(name,listener);return [name,listener];});
        try{
        for(const [id,size] of [['near',[1180,940]],['far',[780,580]]]){
          window.setSize(...size,false);await settle();await focusInput(window,first);await reset(first);let shown,feedbackError;
          const before=state();
          await aiClick(first,id,{onProgress:async event=>{
            if(event.stage!=='preparing')return;
            try{
              const surface=window.controlOverlay.getWindow();
              shown=surface?{visible:surface.isVisible(),bounds:surface.getBounds(),parent:window.getContentBounds(),view:first.view.getBounds(),scale:getDisplayState(c).scale,event,atProgress:state(),render:await surface.webContents.executeJavaScript('({pointer:document.querySelector("#pointer").style.transform,rect:{x:parseFloat(document.querySelector("#target").style.left),y:parseFloat(document.querySelector("#target").style.top),width:parseFloat(document.querySelector("#target").style.width),height:parseFloat(document.querySelector("#target").style.height)}})')}:null;
            }catch(error){feedbackError=error;}
          }});
          const diagnostic=JSON.stringify({presetId,id,before,after:state(),shown,lifecycle,feedbackError:feedbackError?.stack});
          assert.ok(!feedbackError,'Overlay progress inspection failed: '+diagnostic);
          assert.ok(shown?.visible,'A real app overlay was displayed: '+diagnostic);
          const match=/translate\(([-.\d]+)px,\s*([-.\d]+)px\)/.exec(shown.render.pointer);assert.ok(match,'Rendered pointer coordinates');
          for(const [index,key] of [[1,'x'],[2,'y']])assert.ok(Math.abs(Number(match[index])-shown.event.point[key]*shown.scale)<0.1,'Overlay point '+key);
          for(const key of ['x','y','width','height'])assert.ok(Math.abs(shown.render.rect[key]-shown.event.rect[key]*shown.scale)<0.1,'Overlay rect '+key);
          assert.deepEqual(shown.bounds,{x:shown.parent.x+shown.view.x,y:shown.parent.y+shown.view.y,width:shown.view.width,height:shown.view.height});
          values.push({id,overlay:shown,...await receipt(first,id,preset)});await measure('after AI '+id,first,baseline,preset);
        }
        if(presetId==='pixel7'){window.setSize(1180,940,false);await settle();window.controlOverlay.clear();values.push({screenshot:await screenshot(window,'resize-window-large.png')});}
        return values;
        }finally{for(const [name,listener] of listeners)window.removeListener(name,listener);}
      });
      await check(presetId+' unavailable or changed display version sends no late pointer input',async()=>{
        const c=first.view.webContents,originalSend=c.debugger.sendCommand,commands=[];let release,entered=false;
        const gate=new Promise(resolve=>{release=resolve;});
        const element=await find(first,'near');await reset(first);
        c.debugger.sendCommand=async function(method,args,...rest){if(method.startsWith('Input.'))commands.push({method,args});if(method==='Emulation.setDeviceMetricsOverride'&&!entered){entered=true;await gate;}return originalSend.call(this,method,args,...rest);};
        try{
          window.setSize(940,720,false);await waitFor(()=>entered&&!getDisplayState(c).ready,'Blocked display update').catch(error=>{error.message+=' '+JSON.stringify({presetId,entered,windowSize:window.getSize(),active:window.activeTab===first.id,display:getDisplayState(c)});throw error;});
          await assert.rejects(performAction(first,{action:'click',elementId:element.id},options()),error=>error.code==='INPUT_SURFACE_UNAVAILABLE');
          assert.deepEqual(commands,[]);release();await settle();assert.equal((await c.executeJavaScript('fixtureClicks')).length,0);
          let changed=false;await assert.rejects(aiClick(first,'far',{onProgress:async event=>{if(event.stage==='acting'&&!changed){changed=true;window.setSize(1020,800,false);await settle();}}}),error=>error.code==='INPUT_SURFACE_UNAVAILABLE');
          assert.equal(changed,true);assert.deepEqual(commands,[]);await settle();assert.equal((await c.executeJavaScript('fixtureClicks')).length,0);
        }finally{release();await settle();c.debugger.sendCommand=originalSend;}
        return {commands,final:getDisplayState(c),...await measure('after rejected stale input',first,baseline,preset)};
      });
      await check(presetId+' resize after press finishes one leased gesture then applies the latest scale',async()=>{
        window.setSize(820,620,false);await settle();await reset(first);
        const c=first.view.webContents,before=getDisplayState(c),oldBounds=first.view.getBounds(),originalSend=c.debugger.sendCommand,commands=[];let during;
        c.debugger.sendCommand=async function(method,args,...rest){
          const result=await originalSend.call(this,method,args,...rest);if(method.startsWith('Input.'))commands.push({method,args});
          const press=method==='Input.dispatchTouchEvent'&&args.type==='touchStart'||method==='Input.dispatchMouseEvent'&&args.type==='mousePressed';
          if(press&&!during){window.setSize(1180,940,false);await waitFor(()=>getDisplayState(c).version>before.version,'Resize while gesture leased');during={state:getDisplayState(c),bounds:first.view.getBounds()};}
          return result;
        };
        try{await aiClick(first,'near');}finally{c.debugger.sendCommand=originalSend;}
        assert.ok(during,'Real press triggered a resize');assert.equal(during.state.ready,false);assert.deepEqual(during.bounds,oldBounds,'Old native geometry is held until release');
        const firstReceipt=await receipt(first,'near',preset).catch(error=>{error.message+=' '+JSON.stringify({commands,before,during,current:getDisplayState(c)});throw error;});await settle();const after=getDisplayState(c);assert.equal(after.ready,true);assert.ok(after.version>before.version);assert.notEqual(after.scale,before.scale);assert.deepEqual(first.view.getBounds(),after.bounds);
        const pressType=mobile(preset)?'touchStart':'mousePressed',releaseType=mobile(preset)?'touchEnd':'mouseReleased';assert.equal(commands.filter(row=>row.args.type===pressType).length,1);assert.equal(commands.filter(row=>row.args.type===releaseType).length,1);
        if(!mobile(preset)){const press=commands.find(row=>row.args.type===pressType),released=commands.find(row=>row.args.type===releaseType);assert.equal(press.args.x,released.args.x);assert.equal(press.args.y,released.args.y);}
        await reset(first);await aiClick(first,'far');const nextReceipt=await receipt(first,'far',preset);await measure('after leased resize and next action',first,baseline,preset);
        return {before,during,after,commands,firstReceipt,nextReceipt};
      });
      await close();
    }
    await check('resizing environment A preserves environment B identity, native view bounds, display scale and trusted input',async()=>{
      const a=api.saveProfile({...DEVICE_PRESETS.pixel7,name:'QA resize independent A',url:origin+'/independent-a'}),b=api.saveProfile({...DEVICE_PRESETS.iphone13,name:'QA resize independent B',url:origin+'/independent-b'});residents.push(a,b);
      await api.launch(a.id);await api.launch(b.id);const wa=api.windows.get(a.id),wb=api.windows.get(b.id),ta=wa.tabs[0],tb=wb.tabs[0];
      await settle(wa);await settle(wb);const before=await read(tb),bounds=tb.view.getBounds(),display=getDisplayState(tb.view.webContents);
      for(const [width,height] of [[740,560],[1320,1000],[900,680]]){wa.setSize(width,height,false);await settle(wa);assert.deepEqual((await read(tb)).identity,before.identity);assert.deepEqual((await read(tb)).outer,before.outer);assert.deepEqual(tb.view.getBounds(),bounds);assert.deepEqual(getDisplayState(tb.view.webContents),display);}
      await focusInput(wb,tb);await reset(tb);await aiClick(tb,'far');const clicked=await receipt(tb,'far',DEVICE_PRESETS.iphone13);assert.deepEqual(tb.view.getBounds(),bounds);assert.deepEqual(getDisplayState(tb.view.webContents),display);
      const result={bounds,display,identity:before.identity,clicked};await close(a,wa);await close(b,wb);return result;
    });
  } finally {
    try {await close();for(const item of residents)await close(item,api.windows.get(item.id));} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
};
