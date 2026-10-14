(function(root){
 'use strict';
 // Keep read self-contained: it is also serialized into isolated Worker fixtures.
 async function read(scope=globalThis){
  const n=scope.navigator,s=scope.screen;let hints=null,uaData=null,webgl=null,hintsStatus='unavailable';
  try{if(n.userAgentData){
   uaData=typeof n.userAgentData.toJSON==='function'?n.userAgentData.toJSON():{brands:n.userAgentData.brands,mobile:n.userAgentData.mobile,platform:n.userAgentData.platform};
   const schedule=typeof scope.setTimeout==='function'?scope.setTimeout.bind(scope):typeof setTimeout==='function'?setTimeout:null,cancel=typeof scope.clearTimeout==='function'?scope.clearTimeout.bind(scope):typeof clearTimeout==='function'?clearTimeout:null,until=Date.now()+1200;
   const request=async keys=>{let timer;try{const work=Promise.resolve().then(()=>n.userAgentData.getHighEntropyValues(keys));return schedule?await Promise.race([work,new Promise((_,reject)=>{timer=schedule(()=>reject(Error('Client Hints 读取超时')),Math.max(1,until-Date.now()));})]):await work;}finally{if(timer&&cancel)cancel(timer);}};
   try{hints=await request(['architecture','bitness','platformVersion','fullVersionList','model','formFactors']);}catch(error){if(Date.now()>=until)throw error;hints=await request(['architecture','bitness','platformVersion','fullVersionList','model']);}
   hintsStatus=hints&&typeof hints==='object'?'measured':'limited';
  }}catch(e){hints={error:e.message};hintsStatus='limited';}
  try{const canvas=scope.document?scope.document.createElement('canvas'):typeof scope.OffscreenCanvas==='function'?new scope.OffscreenCanvas(1,1):null;const gl=canvas?.getContext('webgl');if(gl){const ext=gl.getExtension('WEBGL_debug_renderer_info');webgl={vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):null,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,version:gl.getParameter(gl.VERSION),maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE)};gl.getExtension('WEBGL_lose_context')?.loseContext();}}catch(e){webgl={error:e.message};}
  const media=query=>typeof scope.matchMedia==='function'?scope.matchMedia(query).matches:null;
  const descriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(n),'webdriver');
  return {ua:n.userAgent,platform:n.platform,language:n.language,languages:[...(n.languages||[])],timezone:scope.Intl.DateTimeFormat().resolvedOptions().timeZone,cpu:n.hardwareConcurrency,memory:n.deviceMemory??null,webdriver:n.webdriver??null,hints,uaData,hintsStatus,maxTouchPoints:n.maxTouchPoints??null,
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
 function browserIdentity(page={}){
  const ua=String(page.ua||''),match=ua.match(/\b(Chrome|CriOS)\/(\d+(?:\.\d+){0,3})/),brands=value=>Array.isArray(value)?value.filter(x=>x&&typeof x.brand==='string'&&typeof x.version==='string').map(x=>({brand:x.brand,version:x.version})):[];
  const reportedBrands=brands(page.uaData?.brands),fullVersionList=brands(page.hints?.fullVersionList);
  return {uaCompatibility:match?(match[1]==='CriOS'?'CriOS 兼容声明':'Chrome 兼容声明'):'未读取到 Chrome / CriOS 兼容标记',uaVersion:match?.[2]||null,reportedBrands,fullVersionList,model:typeof page.hints?.model==='string'?page.hints.model:null,formFactors:Array.isArray(page.hints?.formFactors)?page.hints.formFactors.filter(x=>typeof x==='string'):null,
   explanation:'UA 中的 Chrome / CriOS 标记用于兼容性声明；UA-CH 品牌按本次实际返回值显示。Isola 使用 Electron / Chromium，不将 Chromium 改名为 Google Chrome，也不以 UA 认证安装产品。'};
 }
 async function webgpu(scope=globalThis,{timeoutMs=1800}={}){
  const budget=Math.max(1,Math.min(5000,Number(timeoutMs)||1800));let timer,expired=false,adapterAvailable=false;
  try{
   const gpu=scope.navigator?.gpu;
   if(!gpu||typeof gpu.requestAdapter!=='function')return {status:'unavailable',apiPresent:false,adapterAvailable:false,reason:'未提供 WebGPU API（可能受上下文或浏览器限制）'};
   return await Promise.race([(async()=>{
    const adapter=await gpu.requestAdapter();if(expired)return null;
    if(!adapter)return {status:'unavailable',apiPresent:true,adapterAvailable:false,reason:'WebGPU API 存在，但未提供可用适配器'};
    adapterAvailable=true;
    // Read adapter metadata only. No GPUDevice, shader, workload, or spoofed
    // vendor is created, and redacted identity fields remain redacted.
    const source=adapter.info||(typeof adapter.requestAdapterInfo==='function'?await adapter.requestAdapterInfo():null);if(expired)return null;
    const info={};if(source){for(const key of ['vendor','architecture','device','description'])if(typeof source[key]==='string')info[key]=source[key];for(const key of ['subgroupMinSize','subgroupMaxSize'])if(Number.isFinite(source[key]))info[key]=source[key];if(typeof source.isFallbackAdapter==='boolean')info.isFallbackAdapter=source.isFallbackAdapter;}
    const limits={};for(const key of ['maxTextureDimension1D','maxTextureDimension2D','maxTextureDimension3D','maxTextureArrayLayers','maxBindGroups','maxBindingsPerBindGroup','maxBufferSize','maxUniformBufferBindingSize','maxStorageBufferBindingSize','maxVertexBuffers','maxVertexAttributes','maxComputeInvocationsPerWorkgroup','maxComputeWorkgroupSizeX','maxComputeWorkgroupSizeY','maxComputeWorkgroupSizeZ','maxComputeWorkgroupsPerDimension']){try{if(Number.isFinite(adapter.limits?.[key]))limits[key]=adapter.limits[key];}catch{}}
    const identityProvided=['vendor','architecture','device','description'].some(key=>!!info[key]);
    return {status:'measured',apiPresent:true,adapterAvailable:true,info:Object.keys(info).length?info:null,identityStatus:identityProvided?'provided':'limited',limits,features:adapter.features?[...adapter.features].filter(x=>typeof x==='string').sort():[],reason:identityProvided?'已读取实际适配器信息与上限；未创建 GPUDevice 或执行工作负载':'已取得适配器；身份字段未提供或已受限，未据此猜测 GPU'};
   })(),new Promise(resolve=>{timer=setTimeout(()=>{expired=true;resolve({status:'timeout',apiPresent:true,adapterAvailable,reason:adapterAvailable?'适配器已取得，但 WebGPU 信息读取超时':'WebGPU 适配器读取超时，能力未确认'});},budget);})]);
  }catch(e){return {status:'limited',apiPresent:true,adapterAvailable,reason:'WebGPU 读取受限：'+String(e?.message||e)};}finally{clearTimeout(timer);}
 }
 function clientRects(scope=globalThis){
  const document=scope.document;let box;
  if(!document?.body||typeof document.createElement!=='function')return {status:'unavailable',reason:'当前上下文没有可读取布局的文档'};
  try{
   box=document.createElement('div');box.setAttribute('data-isola-diagnostic','clientrects');box.style.cssText='position:fixed;left:-10000px;top:0;width:319.5px;visibility:hidden;pointer-events:none;contain:layout style paint;font:16px/19.25px Arial,sans-serif;letter-spacing:0.015px;';
   const text=document.createElement('span');text.textContent='Isola layout sample 123 汉字 WWW iii — repeated local geometry measurement.';box.append(text);document.body.append(box);
   const sample=()=>[...text.getClientRects()].slice(0,20).map(rect=>Object.fromEntries(['x','y','width','height','top','right','bottom','left'].map(key=>[key,rect[key]])));
   const first=sample(),second=sample(),finite=[...first,...second].every(rect=>Object.values(rect).every(Number.isFinite));
   if(!first.length||!second.length)return {status:'unavailable',reason:'固定布局样本未提供 ClientRects'};
   return {status:'measured',sample:first,repeatSample:second,count:first.length,finite,stable:finite&&JSON.stringify(first)===JSON.stringify(second),reason:'固定本地文本的连续两次布局读取；不读取网站内容，也不认证设备型号'};
  }catch(e){return {status:'limited',reason:'ClientRects 读取受限：'+String(e?.message||e)};}finally{box?.remove();}
 }
 async function voices(scope=globalThis,{timeoutMs=900}={}){
  let synthesis;try{synthesis=scope.speechSynthesis;}catch{return {status:'limited',apiPresent:false,voices:[],count:0,reason:'当前上下文无法读取语音清单'};}
  if(!synthesis||typeof synthesis.getVoices!=='function')return {status:'unavailable',apiPresent:false,voices:[],count:0,reason:'未提供 SpeechSynthesis API'};
  return new Promise(resolve=>{
   let timer,finished=false,unlistedCount=0;const start=Date.now(),finish=result=>{if(finished)return;finished=true;clearTimeout(timer);try{synthesis.removeEventListener?.('voiceschanged',observe);}catch{}resolve({...result,apiPresent:true,waitedMs:Date.now()-start});};
   const observe=()=>{try{const all=[...synthesis.getVoices()],local=all.filter(voice=>voice.localService===true);unlistedCount=all.length-local.length;if(local.length)finish({status:'measured',voices:local.slice(0,100).map(voice=>({name:String(voice.name||'').slice(0,200),lang:String(voice.lang||'').slice(0,80),default:voice.default===true,localService:true})),count:local.length,truncated:local.length>100,unlistedCount,reason:'仅读取本机语音元数据；未发音，远程或来源不明条目不列出'});}catch(e){finish({status:'limited',voices:[],count:0,reason:'语音清单读取受限：'+String(e?.message||e)});}};
   try{synthesis.addEventListener?.('voiceschanged',observe);timer=setTimeout(()=>finish({status:unlistedCount?'limited':'timeout',voices:[],count:0,unlistedCount,reason:unlistedCount?'本次仅返回远程或来源不明语音，未列入本机清单':'限定等待内未提供本机语音；不能据此认定系统没有语音'}),Math.max(1,Math.min(3000,Number(timeoutMs)||900)));observe();}catch{finish({status:'limited',voices:[],count:0,reason:'语音清单读取受限'});}
  });
 }
 function detectionScope(report={}){
  return [
   {id:'page-contexts',label:'页面 / 独立 Worker / 同源 iframe',status:report.page&&report.comparisons?.worker?.verified&&report.comparisons?.iframe?.verified?'measured':report.page?'limited':'not-tested',detail:'仅核对本次可读取的参数，未读取的上下文单独标记；窗口专属 API 不与 Worker 缺失值强行比较'},
   {id:'storage-isolation',label:'Cookie / LocalStorage / IndexedDB / 缓存隔离',status:'not-tested',detail:'本页无法验证环境之间的存储隔离；需主进程以两个独立会话的本地 fixture 读写验证'},
   {id:'public-ip',label:'公网出口 IP / IP 位置',status:'not-tested',detail:'此本地自检未连接外部 IP 服务；环境管理器的出口 IP 测试属于另一步骤'},
   {id:'webrtc-leak',label:'WebRTC ICE / STUN / IP 泄漏',status:'not-tested',detail:'只记录 API 存在，不创建对等连接或发起 STUN；网络策略不等于泄漏实测'},
   {id:'tls-dns',label:'TLS 握手 / DNS 路由',status:'not-tested',detail:'需网络或服务端专项观测；本页没有执行这些检测'},
   {id:'other-contexts',label:'跨域 iframe / SharedWorker / ServiceWorker',status:'not-tested',detail:'本页未检测这些上下文；其参数仍可能保留宿主身份'},
   {id:'sensitive-devices',label:'摄像头 / 麦克风 / 定位 / 媒体设备列表',status:'not-tested',detail:'未申请权限、未枚举设备、未播放或合成语音'},
   {id:'identity',label:'真人、设备真实性与账号关联',status:'not-verifiable',detail:'参数一致或重复稳定不保证真人、真实手机、不被网站关联或任何第三方检测结论'}
  ];
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
  const browser=browserIdentity(page);add('browser-identity','limited','浏览器兼容声明与品牌',browser.uaCompatibility+(browser.uaVersion?' '+browser.uaVersion:'')+'；UA-CH：'+(browser.reportedBrands.map(x=>x.brand+' '+x.version).join(', ')||'未提供')+'。'+browser.explanation);
  if(report.webgpu){const gpu=report.webgpu;add('webgpu',gpu.status==='measured'?'observation':gpu.status==='limited'?'limited':'unavailable','WebGPU 实际适配器',gpu.reason||'尚未读取');}
  if(report.clientRects){const rects=report.clientRects;add('clientrects',rects.status==='measured'?rects.finite&&rects.stable?'observation':'mismatch':rects.status==='limited'?'limited':'unavailable','ClientRects 重复读取',rects.status==='measured'?'两次固定样本 '+rects.count+' 个矩形；有限数值='+rects.finite+'，相同='+rects.stable+'。这是当前布局稳定性观测。':rects.reason||'尚未读取');}
  if(report.voices){const v=report.voices;add('voices',v.status==='measured'?'observation':v.status==='limited'?'limited':'unavailable','本机语音清单',v.status==='measured'?'读取 '+v.count+' 个本机语音条目；未发音，不列出远程或来源不明语音。':v.reason||'尚未读取');}
  add('host-stack','limited','底层图形与字体','WebGL、Canvas、音频与字体保留实际浏览器和宿主机行为。检测到的 GPU 或字体不能据此认证为某个手机型号。');
  return {mobile,reportedOS:uaOS,findings,counts:{mismatches:findings.filter(x=>x.status==='mismatch').length,unavailable:findings.filter(x=>x.status==='unavailable').length,limitations:findings.filter(x=>x.status==='limited').length}};
 }
 async function run(){const page=await read();const [w,f,g,a,gpu,v]=await Promise.all([worker(),frame(),graphics(),audio(),webgpu(),voices()]);const result={page,worker:w,iframe:f,graphics:g,audio:a,webgpu:gpu,voices:v,clientRects:clientRects(),browserIdentity:browserIdentity(page),comparisons:{worker:compare(page,w),iframe:compare(page,f)},limitations:['仅检查当前页面、独立 Worker 和同源 iframe；跨域 iframe、共享 / Service Worker、TLS、DNS、出口 IP 与代理位置需要单独检测。','手机配置是桌面 Chromium 的移动端模拟；底层引擎、GPU、字体与音频不会变成真实手机。','一致性表示本次读取的参数相符，不代表网站一定认定为正常设备或真人操作。','不上传指纹，不申请摄像头、麦克风或定位权限，不读取这些设备列表。']};result.scope=detectionScope(result);result.analysis=analyze(result);return result;}
 const api={read,worker,frame,compare,graphics,audio,browserIdentity,webgpu,clientRects,voices,detectionScope,analyze,run};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.IsolaDeviceProbe=api;
})(globalThis);
