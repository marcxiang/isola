'use strict';
const assert=require('node:assert/strict'),http=require('node:http');
module.exports=async function metadata(api,check){
 let p,copy,held;const server=http.createServer((req,res)=>{
  if(req.url==='/hold'){held=res;return;}if(req.url==='/ip'){res.setHeader('content-type','application/json');res.end('{"ip":"203.0.113.55"}');return;}res.setHeader('content-type','text/html');res.end('<!doctype html><title>Local metadata fixture</title><h1>Metadata fixture</h1>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const close=async id=>{api.windows.get(id)?.close();for(let i=0;i<100&&api.windows.has(id);i++)await new Promise(r=>setTimeout(r,20));};
 try{
  await check('only actual opening and proxy checks can create environment runtime metadata',async()=>{
   p=api.saveProfile({name:'QA runtime metadata',url:origin,fingerprintMode:'native',lastOpenedAt:'2000-01-01T00:00:00.000Z',proxyCheck:{ip:'192.0.2.1',ms:1,checkedAt:'2000-01-01T00:00:00.000Z'}});assert.equal(p.lastOpenedAt,null);assert.equal(p.proxyCheck,null);
   const before=Date.now();await api.launch(p.id);assert.ok(Date.parse(api.list().find(row=>row.id===p.id).lastOpenedAt)>=before);await close(p.id);
   const measured=await api.testProxy(p,origin+'/ip'),stored=api.list().find(row=>row.id===p.id);assert.equal(measured.ip,'203.0.113.55');assert.deepEqual(stored.proxyCheck,measured);assert.ok(stored.lastOpenedAt);assert.ok(measured.checkedAt);
   const edit=api.saveProfile({...stored,name:'QA metadata edited',lastOpenedAt:'2000-01-01T00:00:00.000Z',proxyCheck:{ip:'192.0.2.2',ms:1,checkedAt:'2000-01-01T00:00:00.000Z'}});assert.equal(edit.lastOpenedAt,stored.lastOpenedAt);assert.deepEqual(edit.proxyCheck,stored.proxyCheck);
   return {networkProbe:'local synthetic IP fixture',metadataNotRendererControlled:true};
  });
  await check('a system-clock rollback cannot persist an invalid proxy latency or prevent profile reload',async()=>{
   const wallClock=Date.now,request=api.testProxy(api.list().find(row=>row.id===p.id),origin+'/hold');
   try{for(let i=0;i<100&&!held;i++)await new Promise(r=>setTimeout(r,20));assert.ok(held);Date.now=()=>wallClock()-9000;held.end('{"ip":"203.0.113.55"}');held=null;const result=await request;assert.ok(result.ms>=0&&result.ms<=120000);const stored=api.list().find(row=>row.id===p.id);assert.deepEqual(stored.proxyCheck,result);assert.doesNotThrow(()=>require('../src/model.cjs').validate(stored));}finally{Date.now=wallClock;}
  });
  await check('proxy edits and copied environments invalidate inherited exit-IP checks',async()=>{
   let current=api.list().find(row=>row.id===p.id);copy=api.duplicateProfile(p.id);assert.equal(copy.proxyCheck,null);assert.equal(copy.lastOpenedAt,null);
   current=api.saveProfile({...current,proxy:{type:'http',host:'127.0.0.1',port:9}});assert.equal(current.proxyCheck,null);assert.ok(current.lastOpenedAt);api.saveProfile({...current,proxy:{type:'direct'}});
  });
  await check('an in-flight probe cannot overwrite a profile edited while it was waiting',async()=>{
   const original=api.list().find(row=>row.id===p.id),request=api.testProxy(original,origin+'/hold');for(let i=0;i<100&&!held;i++)await new Promise(r=>setTimeout(r,20));assert.ok(held);api.saveProfile({...original,name:'QA changed during probe'});held.end('{"ip":"203.0.113.99"}');held=null;await request;assert.equal(api.list().find(row=>row.id===p.id).proxyCheck,null);
  });
 }finally{held?.end('{}');for(const item of [p,copy])if(item){await close(item.id);await api.deleteProfile(item.id);}server.closeAllConnections();await new Promise(r=>server.close(r));}
};
