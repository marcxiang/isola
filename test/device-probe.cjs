'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {read,compare,audio,analyze}=require('../src/device-probe.cjs');
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
