(function(root){
 'use strict';
 // Keep read self-contained: it is also serialized into isolated Worker fixtures.
 async function read(scope=globalThis){
  const n=scope.navigator,s=scope.screen;let hints=null,uaData=null,webgl=null;
  try{if(n.userAgentData){uaData=typeof n.userAgentData.toJSON==='function'?n.userAgentData.toJSON():{brands:n.userAgentData.brands,mobile:n.userAgentData.mobile,platform:n.userAgentData.platform};hints=await n.userAgentData.getHighEntropyValues(['architecture','bitness','platformVersion','fullVersionList']);}}catch(e){hints={error:e.message};}
  try{const canvas=scope.document?scope.document.createElement('canvas'):typeof scope.OffscreenCanvas==='function'?new scope.OffscreenCanvas(1,1):null;const gl=canvas?.getContext('webgl');if(gl){const ext=gl.getExtension('WEBGL_debug_renderer_info');webgl={vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):null,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,version:gl.getParameter(gl.VERSION),maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE)};gl.getExtension('WEBGL_lose_context')?.loseContext();}}catch(e){webgl={error:e.message};}
  const media=query=>typeof scope.matchMedia==='function'?scope.matchMedia(query).matches:null;
  const descriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(n),'webdriver');
  return {ua:n.userAgent,platform:n.platform,language:n.language,languages:[...(n.languages||[])],timezone:scope.Intl.DateTimeFormat().resolvedOptions().timeZone,cpu:n.hardwareConcurrency,memory:n.deviceMemory??null,webdriver:n.webdriver??null,hints,uaData,maxTouchPoints:n.maxTouchPoints??null,
   input:{pointerCoarse:media('(pointer: coarse)'),pointerFine:media('(pointer: fine)'),hover:media('(hover: hover)'),anyPointerCoarse:media('(any-pointer: coarse)'),anyHover:media('(any-hover: hover)'),touchEvents:'ontouchstart' in scope},
   screen:s?{width:s.width,height:s.height,availWidth:s.availWidth,availHeight:s.availHeight,colorDepth:s.colorDepth,pixelDepth:s.pixelDepth,dpr:scope.devicePixelRatio,innerWidth:scope.innerWidth,innerHeight:scope.innerHeight,outerWidth:scope.outerWidth,outerHeight:scope.outerHeight,orientation:s.orientation?{type:s.orientation.type,angle:s.orientation.angle}:null,visualViewport:scope.visualViewport?{width:scope.visualViewport.width,height:scope.visualViewport.height,scale:scope.visualViewport.scale}:null}:null,
   automation:{webdriverPresent:'webdriver' in n,webdriverOwn:Object.prototype.hasOwnProperty.call(n,'webdriver'),webdriverGetter:descriptor?.get?.toString()||null,controlGlobals:['__isolaDOM','__isolaElements','__isolaKeyTarget','_selenium','callPhantom','domAutomation'].filter(key=>typeof scope[key]!=='undefined'),pluginCount:n.plugins?.length??null},
   features:{secureContext:scope.isSecureContext===true,webRTC:typeof scope.RTCPeerConnection==='function',webGPU:'gpu' in n,offscreenCanvas:typeof scope.OffscreenCanvas==='function',offlineAudio:typeof(scope.OfflineAudioContext||scope.webkitOfflineAudioContext)==='function',serviceWorker:'serviceWorker' in n,sharedWorker:typeof scope.SharedWorker==='function',mediaDevices:'mediaDevices' in n,geolocation:'geolocation' in n,permissions:'permissions' in n},webgl};
 }
 async function worker(){return new Promise(resolve=>{let w,url,finished=false;const done=value=>{if(finished)return;finished=true;clearTimeout(timer);w?.terminate();if(url)URL.revokeObjectURL(url);resolve(value);};const timer=setTimeout(()=>done({error:'Worker 检测超时'}),3000);try{url=URL.createObjectURL(new Blob(['const read='+read.toString()+';onmessage=async()=>{try{postMessage(await read())}catch(e){postMessage({error:e.message})}}'],{type:'text/javascript'}));w=new Worker(url);w.onmessage=e=>done(e.data);w.onerror=()=>done({error:'当前页面不允许 Worker 检测'});w.postMessage('read');}catch(e){done({error:e.message});}});}
 async function frame(){const f=document.createElement('iframe');f.hidden=true;f.src='about:blank';document.body.append(f);try{return await read(f.contentWindow);}catch(e){return {error:e.message};}finally{f.remove();}}
 function compare(main,other){
  if(!other||other.error)return {verified:false,error:other?.error||'没有读取结果'};
  const differences=[],fields=['ua','platform','language','languages','timezone','cpu','memory','hints','uaData'];
  // WorkerNavigator does not expose window-only touch/screen/WebDriver APIs.
  // Compare these only when both contexts actually provide them.
  if(main.maxTouchPoints!=null&&other.maxTouchPoints!=null)fields.push('maxTouchPoints');
  if(main.webdriver!=null&&other.webdriver!=null)fields.push('webdriver');
  if(main.webgl&&!main.webgl.error&&other.webgl&&!other.webgl.error)fields.push('webgl');
  for(const key of fields)if(JSON.stringify(main[key])!==JSON.stringify(other[key]))differences.push({field:key,page:main[key],other:other[key]});
  return {verified:true,consistent:!differences.length,differences,fields};
 }
 async function graphics(){
  const result={};
  try{
   const sample=()=>{const canvas=document.createElement('canvas');canvas.width=220;canvas.height=50;const c=canvas.getContext('2d');if(!c)throw Error('Canvas 2D 不可用');c.fillStyle='#345678';c.fillRect(0,0,220,50);c.font='17px Arial';c.fillStyle='#edcba9';c.fillText('Isola device check 123',5,30);let hash=2166136261;for(const x of c.getImageData(0,0,220,50).data)hash=Math.imul(hash^x,16777619);return {checksum:(hash>>>0).toString(16),context:c};};
   const first=sample(),second=sample(),c=first.context;result.canvasChecksum=first.checksum;result.canvasRepeatChecksum=second.checksum;result.canvasStable=first.checksum===second.checksum;
   const gl=document.createElement('canvas').getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');result.webgl=gl?{vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):null,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,version:gl.getParameter(gl.VERSION),maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE)}:null;gl?.getExtension('WEBGL_lose_context')?.loseContext();
   const text='mmmmmmmmmmWWiiii汉字';c.font='72px monospace';const mono=c.measureText(text).width;c.font='72px serif';const serif=c.measureText(text).width;
   result.fonts=['Arial','Helvetica','Times New Roman','Courier New','Menlo','PingFang SC','Roboto','Noto Sans'].filter(x=>{c.font='72px "'+x+'",monospace';const a=c.measureText(text).width;c.font='72px "'+x+'",serif';return a!==mono&&c.measureText(text).width!==serif;});
  }catch(e){result.error=e.message;}return result;
 }
 async function audio(scope=globalThis){
  const Context=scope.OfflineAudioContext||scope.webkitOfflineAudioContext;if(typeof Context!=='function')return {available:false,reason:'OfflineAudioContext 不可用'};
  let timer;try{
   const sample=async()=>{const context=new Context(1,4096,44100),oscillator=context.createOscillator(),compressor=context.createDynamicsCompressor();oscillator.type='triangle';oscillator.frequency.value=10000;oscillator.connect(compressor);compressor.connect(context.destination);oscillator.start(0);try{const buffer=await context.startRendering();const data=buffer.getChannelData(0).slice(1000,2000),value=data.reduce((sum,x)=>sum+Math.abs(x),0);return {sampleRate:buffer.sampleRate,length:buffer.length,channels:buffer.numberOfChannels,value,finite:data.every(Number.isFinite)};}finally{oscillator.disconnect();compressor.disconnect();}};
   return await Promise.race([(async()=>{const first=await sample(),second=await sample();return {available:true,...first,repeatValue:second.value,stable:first.value===second.value,finite:first.finite&&second.finite};})(),new Promise(resolve=>{timer=setTimeout(()=>resolve({available:false,reason:'离线音频读取超时'}),2500);})]);
  }catch(e){return {available:false,reason:e.message};}finally{clearTimeout(timer);}
 }
 function analyze(report){
  const page=report.page||{},input=page.input||{},screen=page.screen||{},findings=[];
  const add=(id,status,title,detail)=>findings.push({id,status,title,detail});
  const os=text=>/Android/i.test(text||'')?'Android':/iPhone|iPad|iPod|\biOS\b/i.test(text||'')?'iOS':/Windows|Win32|Win64/i.test(text||'')?'Windows':/Macintosh|MacIntel|Mac OS|macOS/i.test(text||'')?'macOS':/Linux/i.test(text||'')?'Linux':null;
  const uaOS=os(page.ua),platformOS=os(page.platform),hintOS=os(page.uaData?.platform||page.hints?.platform);
  const uaMobile=/iPhone|iPod|\bMobile\b/i.test(page.ua||''),hintMobile=page.uaData?.mobile??page.hints?.mobile;
  // Android tablets can legitimately omit Mobile and report UA-CH mobile=false.
  const mobile=/Android|iPhone|iPad|iPod/i.test(page.ua||'')||uaMobile||hintMobile===true;
  add('device-mode','observation',mobile?'手机模拟配置':'桌面设备参数',mobile?'页面包含移动端 UA 或 Client Hints。Isola 运行在桌面 Chromium；手机配置属于移动端模拟，不能证明来自真实手机。':'当前 UA 与 Client Hints 未报告移动设备；触摸屏电脑也可能提供触摸能力。');
  const osConflicts=[];
  if(uaOS&&hintOS&&uaOS!==hintOS)osConflicts.push('UA 报告 '+uaOS+'，Client Hints 报告 '+hintOS);
  if(uaOS&&platformOS&&uaOS!==platformOS&&!(uaOS==='Android'&&platformOS==='Linux')&&!(uaOS==='iOS'&&platformOS==='macOS'&&page.maxTouchPoints>1))osConflicts.push('UA 报告 '+uaOS+'，navigator.platform 报告 '+platformOS);
  add('os-consistency',osConflicts.length?'mismatch':'observation','操作系统信号',osConflicts.length?osConflicts.join('；'):'本次可读取的系统信号没有发现直接冲突：UA '+(uaOS||'未知')+' / platform '+(platformOS||'未知')+' / Client Hints '+(hintOS||'未提供')+'。');
  if(typeof hintMobile==='boolean')add('ua-mobile',hintMobile!==uaMobile?'mismatch':'observation','UA 与移动标志',hintMobile!==uaMobile?'UA 的移动设备描述与 Client Hints mobile='+hintMobile+' 不一致。':'UA 移动描述与 Client Hints mobile='+hintMobile+' 相符。');
  if(mobile){
   if(page.maxTouchPoints==null)add('touch','unavailable','手机触摸能力','没有读取到 maxTouchPoints。');else add('touch',page.maxTouchPoints>0?'observation':'mismatch','手机触摸能力','maxTouchPoints='+page.maxTouchPoints+'；数值只说明浏览器暴露的触摸能力。');
   if(input.pointerCoarse!=null)add('mobile-input',input.pointerCoarse&&!input.hover?'observation':'mismatch','手机指针与悬停','pointer: coarse='+input.pointerCoarse+'，hover: hover='+input.hover+'。普通手机主指针通常为粗指针且不支持悬停；外设和浏览器模式会影响结果。');
   if(Number.isFinite(screen.dpr))add('mobile-screen','observation','手机屏幕与像素比',screen.width+' × '+screen.height+' CSS px / DPR '+screen.dpr+'；视口与屏幕比值不能证明实际设备型号。');
   if(uaOS==='iOS')add('ios-engine','limited','iOS 浏览器引擎限制','更换 iPhone / iPad UA 不会把桌面 Chromium 变成 iOS 浏览器引擎；引擎 API、字体与图形栈仍可能不同。');
  }
  add('webdriver',page.webdriver===true?'observation':'limited','自动控制信号','实测 navigator.webdriver='+String(page.webdriver)+'。此单项数值不能确认是否存在自动化，也不能证明真人操作。');
  const globals=page.automation?.controlGlobals||[];if(globals.length)add('control-globals','observation','页面控制对象','当前页面可见：'+globals.join(', ')+'。');
  for(const key of ['worker','iframe']){const check=report.comparisons?.[key];add('context-'+key,!check?.verified?'unavailable':check.consistent?'observation':'mismatch',key==='worker'?'独立 Worker 一致性':'同源 iframe 一致性',!check?.verified?check?.error||'尚未读取':check.consistent?'本次读取的参数一致（'+(check.fields||[]).join(', ')+'）。':'本次读取存在差异：'+check.differences.map(x=>x.field).join(', ')+'。');}
  if(report.graphics?.canvasStable!=null)add('canvas',report.graphics.canvasStable?'observation':'mismatch','Canvas 重复读取',report.graphics.canvasStable?'两次相同绘制的校验值相同；这是本次稳定性观测。':'两次相同绘制的校验值不同；需要核对渲染状态。');
  const a=report.audio;if(a)add('audio',!a.available?'unavailable':!a.finite||!a.stable?'mismatch':'observation','离线音频重复读取',!a.available?a.reason:'采样率 '+a.sampleRate+' Hz；两次摘要 '+a.value+' / '+a.repeatValue+'；有限数值='+a.finite+'，相同='+a.stable+'。');
  add('host-stack','limited','底层图形与字体','WebGL、Canvas、音频与字体保留实际浏览器和宿主机行为。检测到的 GPU 或字体不能据此认证为某个手机型号。');
  return {mobile,reportedOS:uaOS,findings,counts:{mismatches:findings.filter(x=>x.status==='mismatch').length,unavailable:findings.filter(x=>x.status==='unavailable').length,limitations:findings.filter(x=>x.status==='limited').length}};
 }
 async function run(){const page=await read();const [w,f,g,a]=await Promise.all([worker(),frame(),graphics(),audio()]);const result={page,worker:w,iframe:f,graphics:g,audio:a,comparisons:{worker:compare(page,w),iframe:compare(page,f)},limitations:['仅检查当前页面、独立 Worker 和同源 iframe；跨域 iframe、共享 / Service Worker、TLS、DNS、出口 IP 与代理位置需要单独检测。','手机配置是桌面 Chromium 的移动端模拟；底层引擎、GPU、字体与音频不会变成真实手机。','一致性表示本次读取的参数相符，不代表网站一定认定为正常设备或真人操作。','不上传指纹，不申请摄像头、麦克风或定位权限，不读取这些设备列表。']};result.analysis=analyze(result);return result;}
 const api={read,worker,frame,compare,graphics,audio,analyze,run};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.IsolaDeviceProbe=api;
})(globalThis);
