'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {read,compare,audio,analyze,browserIdentity,webgpu,clientRects,voices,detectionScope}=require('../src/device-probe.cjs');
function fixture(overrides={}){
 const page={ua:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/144.0.0.0 Mobile Safari/537.36',platform:'Linux armv8l',language:'fr-FR',languages:['fr-FR','fr'],timezone:'Europe/Paris',cpu:8,memory:8,webdriver:false,uaData:{brands:[{brand:'Chromium',version:'144'}],mobile:true,platform:'Android'},hints:{mobile:true,platform:'Android'},maxTouchPoints:5,input:{pointerCoarse:true,hover:false},screen:{width:412,height:915,dpr:2.625},automation:{controlGlobals:[]},...overrides};
 return {page,comparisons:{worker:{verified:true,consistent:true,differences:[],fields:['ua','platform']},iframe:{verified:true,consistent:true,differences:[],fields:['ua','platform','maxTouchPoints']}},graphics:{canvasStable:true},audio:{available:true,sampleRate:44100,value:124.04,repeatValue:124.04,stable:true,finite:true}};
}
const finding=(result,id)=>result.findings.find(x=>x.id===id);

test('coherent Android signals remain observations and explicitly identify mobile emulation',()=>{
 const report=analyze(fixture());assert.equal(report.mobile,true);assert.equal(report.reportedOS,'Android');assert.equal(report.counts.mismatches,0);assert.equal(finding(report,'touch').status,'observation');assert.match(finding(report,'device-mode').detail,/模拟/);assert.match(finding(report,'host-stack').detail,/宿主机/);assert.ok(report.counts.limitations>0);assert.equal(Object.hasOwn(report,'passed'),false);
});
test('mobile UA conflicting with Windows hints, platform and desktop input is exposed',()=>{
 const report=analyze(fixture({platform:'Win32',uaData:{platform:'Windows',mobile:false},maxTouchPoints:0,input:{pointerCoarse:false,hover:true}}));
 assert.equal(finding(report,'os-consistency').status,'mismatch');assert.match(finding(report,'os-consistency').detail,/Windows/);assert.equal(finding(report,'ua-mobile').status,'mismatch');assert.equal(finding(report,'touch').status,'mismatch');assert.equal(finding(report,'mobile-input').status,'mismatch');
});
test('iOS reports its engine limit while accepting an iPad-style touch Mac platform',()=>{
 const report=analyze(fixture({ua:'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',platform:'MacIntel',uaData:null,hints:null,maxTouchPoints:5}));
 assert.equal(report.reportedOS,'iOS');assert.equal(finding(report,'os-consistency').status,'observation');assert.equal(finding(report,'ios-engine').status,'limited');assert.match(finding(report,'ios-engine').detail,/Chromium/);
});
test('desktop with touch hardware is not classified as a phone',()=>{
 const report=analyze(fixture({ua:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36',platform:'Win32',uaData:{platform:'Windows',mobile:false},hints:{platform:'Windows',mobile:false},maxTouchPoints:10}));
 assert.equal(report.mobile,false);assert.equal(report.reportedOS,'Windows');assert.equal(finding(report,'touch'),undefined);assert.match(finding(report,'webdriver').detail,/不能/);
});
test('Android tablet UA and mobile=false are not a contradictory Client Hints pair',()=>{
 const report=analyze(fixture({ua:'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36',uaData:{platform:'Android',mobile:false},hints:{platform:'Android',mobile:false}}));
 assert.equal(report.mobile,true);assert.equal(finding(report,'ua-mobile').status,'observation');assert.equal(finding(report,'os-consistency').status,'observation');
});
test('failed contexts and unavailable audio remain unverified instead of consistent',()=>{
 const data=fixture();data.comparisons.worker={verified:false,error:'Worker blocked'};data.audio={available:false,reason:'not supported'};data.graphics={};
 const report=analyze(data);assert.equal(finding(report,'context-worker').status,'unavailable');assert.equal(finding(report,'audio').status,'unavailable');assert.equal(report.counts.unavailable,2);assert.match(finding(report,'context-worker').detail,/blocked/);
});
test('actual context differences and unstable rendering are surfaced',()=>{
 const data=fixture();data.comparisons.worker={verified:true,consistent:false,differences:[{field:'uaData',page:{mobile:true},other:{mobile:false}}]};data.graphics.canvasStable=false;data.audio.stable=false;
 const report=analyze(data);assert.equal(finding(report,'context-worker').status,'mismatch');assert.match(finding(report,'context-worker').detail,/uaData/);assert.equal(finding(report,'canvas').status,'mismatch');assert.equal(finding(report,'audio').status,'mismatch');
});
test('common identity fields and actual GPU differences are compared without false missing Worker API differences',()=>{
 const page={ua:'ua',platform:'Linux armv8l',language:'fr',languages:['fr'],timezone:'Europe/Paris',cpu:8,memory:8,hints:{mobile:true},uaData:{mobile:true},maxTouchPoints:5,webdriver:false,webgl:{vendor:'actual',renderer:'GPU A'}};
 const worker={...page,maxTouchPoints:null,webdriver:null};let result=compare(page,worker);assert.equal(result.consistent,true);assert.equal(result.fields.includes('maxTouchPoints'),false);assert.equal(result.fields.includes('webdriver'),false);
 result=compare(page,{...worker,webgl:{vendor:'actual',renderer:'GPU B'}});assert.equal(result.consistent,false);assert.deepEqual(result.differences.map(x=>x.field),['webgl']);
 result=compare(page,{...page,maxTouchPoints:0});assert.equal(result.consistent,false);assert.deepEqual(result.differences.map(x=>x.field),['maxTouchPoints']);
 assert.deepEqual(compare(page,{error:'blocked'}),{verified:false,error:'blocked'});assert.equal(compare(page,null).verified,false);
});
test('self-contained probe captures measured touch/media/orientation and never requests sensitive permissions',async()=>{
 let queried=0;const navigator={userAgent:'Android Mobile',platform:'Linux armv8l',language:'fr',languages:['fr'],hardwareConcurrency:8,deviceMemory:8,webdriver:false,maxTouchPoints:5,plugins:[],userAgentData:{toJSON:()=>({mobile:true,platform:'Android'}),getHighEntropyValues:async()=>({mobile:true,platform:'Android',architecture:'arm'})}};
 for(const key of ['permissions','mediaDevices','geolocation'])Object.defineProperty(navigator,key,{get(){queried++;throw Error('Sensitive API was accessed');}});
 const scope={navigator,Intl,devicePixelRatio:3,screen:{width:390,height:844,orientation:{type:'portrait-primary',angle:0}},matchMedia:query=>({matches:query==='(pointer: coarse)'}),visualViewport:{width:390,height:844,scale:1},isSecureContext:true};
 // String serialization mirrors the actual Blob Worker path.
 const probe=vm.runInNewContext('('+read.toString()+')',{globalThis:scope});const result=await probe(scope);
 assert.equal(result.maxTouchPoints,5);assert.equal(result.input.pointerCoarse,true);assert.equal(result.input.hover,false);assert.equal(result.screen.orientation.type,'portrait-primary');assert.equal(result.screen.dpr,3);assert.equal(result.uaData.mobile,true);assert.equal(result.features.permissions,true);assert.equal(result.features.mediaDevices,true);assert.equal(queried,0);
});
test('Worker-style scope reads without window-only APIs',async()=>{
 const result=await read({navigator:{userAgent:'Worker UA',platform:'Linux',language:'en',languages:['en'],hardwareConcurrency:4},Intl});
 assert.equal(result.screen,null);assert.equal(result.maxTouchPoints,null);assert.equal(result.webdriver,null);assert.equal(result.input.pointerCoarse,null);assert.equal(result.webgl,null);assert.equal(result.automation.pluginCount,null);
});
test('audio reports actual repeated offline samples without opening media devices',async()=>{
 let renders=0,disconnected=0;
 class OfflineAudioContext{constructor(channels,length,sampleRate){this.channels=channels;this.length=length;this.sampleRate=sampleRate;this.destination={};}createOscillator(){return {frequency:{value:0},connect(){},start(){},disconnect(){disconnected++;}};}createDynamicsCompressor(){return {connect(){},disconnect(){disconnected++;}};}async startRendering(){renders++;return {sampleRate:this.sampleRate,length:this.length,numberOfChannels:this.channels,getChannelData:()=>new Float32Array(4096).fill(0.5)};}}
 const result=await audio({OfflineAudioContext});assert.equal(result.available,true);assert.equal(result.value,500);assert.equal(result.stable,true);assert.equal(result.finite,true);assert.equal(result.sampleRate,44100);assert.equal(renders,2);assert.equal(disconnected,4);
 assert.deepEqual(await audio({}),{available:false,reason:'OfflineAudioContext 不可用'});
});
test('empty analyzer input preserves uncertainty and never invents mobile capability',()=>{
 const report=analyze({});assert.equal(report.mobile,false);assert.equal(report.reportedOS,null);assert.equal(report.counts.unavailable,2);assert.equal(finding(report,'touch'),undefined);assert.match(finding(report,'os-consistency').detail,/未知/);
});

test('high entropy model and form factors are measured without converting the Chromium brand to Google Chrome',async()=>{
 const requested=[],scope={navigator:{userAgent:'Mozilla/5.0 Chrome/152.0.1234.9',platform:'Win32',languages:['en'],userAgentData:{brands:[{brand:'Chromium',version:'152'}],mobile:false,platform:'Windows',getHighEntropyValues:async keys=>{requested.push(keys);return {model:'Pixel 7',formFactors:['Mobile'],fullVersionList:[{brand:'Chromium',version:'152.0.1234.9'}]};}}},Intl};
 const page=await read(scope),identity=browserIdentity(page);assert.equal(requested.length,1);assert.ok(requested[0].includes('model'));assert.ok(requested[0].includes('formFactors'));assert.equal(page.hintsStatus,'measured');assert.equal(identity.model,'Pixel 7');assert.deepEqual(identity.formFactors,['Mobile']);assert.equal(identity.uaCompatibility,'Chrome 兼容声明');assert.equal(identity.uaVersion,'152.0.1234.9');assert.deepEqual(identity.reportedBrands,[{brand:'Chromium',version:'152'}]);assert.deepEqual(identity.fullVersionList,[{brand:'Chromium',version:'152.0.1234.9'}]);assert.match(identity.explanation,/不将 Chromium 改名为 Google Chrome/);
 const ios=browserIdentity({ua:'Mozilla/5.0 CriOS/152.0.0.0 Mobile'});assert.equal(ios.uaCompatibility,'CriOS 兼容声明');assert.equal(ios.model,null);assert.equal(ios.formFactors,null);assert.deepEqual(ios.reportedBrands,[]);
});

test('older Client Hints implementations retain measurable fields when formFactors is rejected',async()=>{
 const calls=[],navigator={userAgent:'ua',languages:[],userAgentData:{brands:[],getHighEntropyValues:async keys=>{calls.push(keys);if(keys.includes('formFactors'))throw Error('unsupported hint');return {model:'Measured model',architecture:'arm'};}}};
 const result=await read({navigator,Intl});assert.equal(calls.length,2);assert.equal(result.hints.model,'Measured model');assert.equal(result.hints.architecture,'arm');assert.equal(browserIdentity(result).formFactors,null);
});

test('WebGPU requests an actual adapter and reports its own metadata and limits without creating a device',async()=>{
 let adapters=0,devices=0;const result=await webgpu({navigator:{gpu:{requestAdapter:async()=>{adapters++;return {info:{vendor:'measured vendor',architecture:'measured arch',device:'measured device',description:'measured description',subgroupMinSize:4},limits:{maxTextureDimension2D:8192,maxBindGroups:4,maxBufferSize:268435456},features:new Set(['texture-compression-bc']),requestDevice:()=>{devices++;throw Error('must not request device');}};}}}});
 assert.equal(result.status,'measured');assert.equal(result.adapterAvailable,true);assert.equal(result.info.vendor,'measured vendor');assert.equal(result.limits.maxTextureDimension2D,8192);assert.equal(result.limits.maxBufferSize,268435456);assert.deepEqual(result.features,['texture-compression-bc']);assert.equal(adapters,1);assert.equal(devices,0);
});

test('WebGPU API existence, absent adapters and redacted identities never imply fully available hardware',async()=>{
 assert.equal((await webgpu({navigator:{}})).status,'unavailable');
 const missing=await webgpu({navigator:{gpu:{requestAdapter:async()=>null}}});assert.equal(missing.apiPresent,true);assert.equal(missing.adapterAvailable,false);assert.equal(missing.status,'unavailable');
 const redacted=await webgpu({navigator:{gpu:{requestAdapter:async()=>({info:{vendor:'',architecture:'',device:'',description:''},limits:{maxBindGroups:4}})}}});assert.equal(redacted.status,'measured');assert.equal(redacted.identityStatus,'limited');assert.equal(redacted.info.vendor,'');assert.match(redacted.reason,/未据此猜测/);
 const denied=await webgpu({navigator:{gpu:{requestAdapter:async()=>{throw Error('GPU disabled');}}}});assert.equal(denied.status,'limited');assert.equal(denied.adapterAvailable,false);
 const infoDenied=await webgpu({navigator:{gpu:{requestAdapter:async()=>({get info(){throw Error('adapter identity restricted');}})}}});assert.equal(infoDenied.status,'limited');assert.equal(infoDenied.adapterAvailable,true);
});

test('WebGPU timeout returns an unconfirmed state and does not start extra reads on a late adapter',async()=>{
 let resolveAdapter,infoReads=0;const task=webgpu({navigator:{gpu:{requestAdapter:()=>new Promise(resolve=>{resolveAdapter=resolve;})}}},{timeoutMs:15});
 const result=await task;assert.equal(result.status,'timeout');assert.equal(result.adapterAvailable,false);resolveAdapter({get info(){infoReads++;return {vendor:'too late'};}});await new Promise(setImmediate);assert.equal(infoReads,0);
});

function layoutScope(samples){
 let reads=0,removed=0,appended=0;const scope={document:{body:{append(){appended++;}},createElement(tag){return tag==='div'?{style:{},setAttribute(){},append(){},remove(){removed++;}}:{set textContent(value){},getClientRects(){const sample=samples[Math.min(reads++,samples.length-1)];if(sample instanceof Error)throw sample;return sample;}};}}};
 return {scope,counts:()=>({reads,removed,appended})};
}
const rect={x:0.125,y:2,width:40,height:18,top:2,right:40.125,bottom:20,left:0.125};

test('ClientRects measures repeated finite geometry and removes its local sample on success or restriction',()=>{
 const stable=layoutScope([[rect],[rect]]),result=clientRects(stable.scope);assert.equal(result.status,'measured');assert.equal(result.finite,true);assert.equal(result.stable,true);assert.equal(result.sample[0].x,0.125);assert.deepEqual(stable.counts(),{reads:2,removed:1,appended:1});
 const changed=layoutScope([[rect],[{...rect,width:41}]]);assert.equal(clientRects(changed.scope).stable,false);
 const bad=layoutScope([Error('layout unavailable')]);assert.equal(clientRects(bad.scope).status,'limited');assert.equal(bad.counts().removed,1);
 assert.equal(clientRects({}).status,'unavailable');assert.equal(clientRects(layoutScope([[],[]]).scope).status,'unavailable');
});

function voiceScope(initial=[]){
 const listeners=new Set();let current=initial,speechCalls=0;
 return {scope:{speechSynthesis:{getVoices:()=>current,addEventListener:(type,handler)=>{assert.equal(type,'voiceschanged');listeners.add(handler);},removeEventListener:(_type,handler)=>listeners.delete(handler),speak:()=>{speechCalls++;throw Error('must never speak');}}},set(value){current=value;for(const listener of [...listeners])listener();},counts:()=>({listeners:listeners.size,speechCalls})};
}
test('voices waits for a local catalog, lists local metadata only and never speaks',async()=>{
 const f=voiceScope([{name:'Remote service',lang:'en-US',localService:false}]),promise=voices(f.scope,{timeoutMs:100});
 f.set([{name:'Local French',lang:'fr-FR',localService:true,default:true},{name:'Remote service',lang:'en-US',localService:false},{name:'Unknown locality',lang:'en-US'}]);
 const result=await promise;assert.equal(result.status,'measured');assert.equal(result.count,1);assert.equal(result.unlistedCount,2);assert.deepEqual(result.voices,[{name:'Local French',lang:'fr-FR',default:true,localService:true}]);assert.deepEqual(f.counts(),{listeners:0,speechCalls:0});
});

test('voices missing, restricted and timed-out catalogs remain unavailable or limited and always remove listeners',async()=>{
 assert.equal((await voices({})).status,'unavailable');
 const empty=voiceScope(),result=await voices(empty.scope,{timeoutMs:10});assert.equal(result.status,'timeout');assert.equal(result.count,0);assert.match(result.reason,/不能据此认定/);assert.equal(empty.counts().listeners,0);
 const remote=voiceScope([{name:'Remote',localService:false}]);assert.equal((await voices(remote.scope,{timeoutMs:10})).status,'limited');assert.deepEqual(remote.counts(),{listeners:0,speechCalls:0});
 const denied=await voices({speechSynthesis:{getVoices(){throw Error('blocked');}}});assert.equal(denied.status,'limited');
});

test('new diagnostics expose uncertainty in analysis and scope instead of claiming device authenticity or storage isolation',()=>{
 const data=fixture();data.webgpu={status:'unavailable',apiPresent:true,adapterAvailable:false,reason:'No adapter'};data.clientRects={status:'measured',finite:true,stable:false,count:2};data.voices={status:'timeout',reason:'Not loaded'};
 const report=analyze(data);assert.equal(finding(report,'webgpu').status,'unavailable');assert.equal(finding(report,'clientrects').status,'mismatch');assert.equal(finding(report,'voices').status,'unavailable');assert.equal(finding(report,'browser-identity').status,'limited');
 const scope=detectionScope(data);for(const id of ['storage-isolation','public-ip','webrtc-leak','tls-dns','other-contexts','sensitive-devices'])assert.equal(scope.find(row=>row.id===id).status,'not-tested');assert.equal(scope.find(row=>row.id==='identity').status,'not-verifiable');assert.match(scope.find(row=>row.id==='storage-isolation').detail,/主进程/);assert.match(scope.find(row=>row.id==='identity').detail,/不保证/);
});
