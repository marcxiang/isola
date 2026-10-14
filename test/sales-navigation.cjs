'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {salesNavigationURL,loadSalesPage}=require('../src/sales-navigation.cjs');
const target='https://www.vinted.fr/member/123456',refresh='https://www.vinted.fr/session-refresh?ref_url=%2Fmember%2F123456';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){
 const contents=new EventEmitter(),controller=new AbortController();let url='about:blank',loading=false,dead=false,loadResolve,loadReject,monitor,error='',guardError;
 const loads=[];contents.isDestroyed=()=>dead;contents.getURL=()=>url;contents.isLoadingMainFrame=()=>loading;
 contents.loadURL=value=>{loads.push(value);loading=true;contents.emit('did-start-navigation',{},value,false,true);return new Promise((resolve,reject)=>{loadResolve=resolve;loadReject=reject;});};
 const begin=(value,main=true)=>{if(main)loading=true;contents.emit('did-start-navigation',{},value,false,main);};
 const commit=value=>{url=value;contents.emit('did-navigate',{},value);};
 const finish=()=>{loading=false;contents.emit('did-finish-load');contents.emit('did-stop-loading');};
 const start=options=>loadSalesPage({contents,target,signal:controller.signal,guard:()=>{if(guardError)throw guardError;},readError:()=>error,onMonitor:value=>{monitor=value;},timeoutMs:200,settleMs:10,pollMs:2,...options});
 return {contents,controller,start,loads,begin,commit,finish,resolve:()=>loadResolve(),abort:()=>loadReject(Object.assign(Error('ERR_ABORTED'),{code:'ERR_ABORTED',errno:-3})),reject:e=>loadReject(e),setError:e=>{error=e;},setGuardError:e=>{guardError=e;},get monitor(){return monitor;},destroy:()=>{dead=true;contents.emit('destroyed');}};
}
test('only the exact French target and session-refresh return URL are accepted',()=>{
 assert.equal(salesNavigationURL(target,target),'target');assert.equal(salesNavigationURL(refresh,target),'refresh');
 assert.equal(salesNavigationURL('https://www.vinted.fr/session-refresh?ref_url='+encodeURIComponent(target),target),'refresh');
 for(const value of ['https://vinted.fr/member/123456','https://www.vinted.fr/member/999','https://www.vinted.fr/member/123456#other','https://www.vinted.fr/member/login','https://www.vinted.fr/session-refresh?ref_url=%2Fmember%2F999','https://www.vinted.fr/session-refresh?ref_url=%2Fmember%2F123456&next=other','https://www.vinted.fr/session-refresh?ref_url=%2Fmember%2F123456&ref_url=%2Fmember%2F123456','https://www.vinted.fr/session-refresh?ref_url=https%3A%2F%2Fevil.invalid%2Fmember%2F123456','https://www.vinted.fr@evil.invalid/member/123456'])assert.equal(salesNavigationURL(value,target),null,value);
 assert.equal(salesNavigationURL('https://www.vinted.fr/items/new','https://www.vinted.fr/items/new'),'target');
 assert.equal(salesNavigationURL('https://www.vinted.fr/items/123456','https://www.vinted.fr/items/123456'),null,'published item receipt must not use initial navigation recovery');
});
test('normal target load waits for main-frame completion and settles without issuing another request',async()=>{
 const f=fixture();let completed=false;const result=f.start().then(value=>{completed=true;return value;});f.commit(target);f.resolve();await wait(15);assert.equal(completed,false);f.finish();
 assert.deepEqual(await result,{url:target,sessionRefreshed:false});assert.deepEqual(f.loads,[target]);assert.equal(f.monitor,null);assert.equal(f.contents.eventNames().length,0);
});
test('ERR_ABORTED followed by the exact session refresh converges to the original target',async()=>{
 const f=fixture(),result=f.start();f.begin(refresh);f.abort();f.commit(refresh);f.finish();await wait(15);f.begin(target);f.commit(target);f.finish();
 assert.deepEqual(await result,{url:target,sessionRefreshed:true});assert.deepEqual(f.loads,[target]);
});
test('a refresh beginning after loadURL resolved resets completion until the return page loads',async()=>{
 const f=fixture();let completed=false;const result=f.start().then(value=>{completed=true;return value;});f.commit(target);f.finish();f.resolve();await wait(3);f.begin(refresh);f.commit(refresh);f.finish();await wait(15);assert.equal(completed,false);f.begin(target);f.commit(target);f.finish();assert.equal((await result).sessionRefreshed,true);
});
test('a bare ERR_ABORTED cannot authorize the original or an old completed page',async()=>{
 const f=fixture(),result=f.start();f.commit(target);f.finish();f.abort();await assert.rejects(result,{code:'PAGE_CHANGED'});assert.equal(f.contents.eventNames().length,0);
});
test('same-document target updates retain load completion but transient different paths permanently fail',async()=>{
 const f=fixture(),result=f.start();f.commit(target);f.finish();f.resolve();f.contents.emit('did-start-navigation',{url:target,isMainFrame:true,isSameDocument:true});f.contents.emit('did-navigate-in-page',{},target,true,42,43);assert.equal((await result).url,target);
 for(const path of ['/member/login','/session-refresh?ref_url=%2Fmember%2F123456']){
  const changed=fixture(),other=changed.start();changed.commit(target);changed.finish();changed.resolve();changed.contents.emit('did-navigate-in-page',{},'https://www.vinted.fr'+path,true,42,43);changed.contents.emit('did-navigate-in-page',{},target,true,42,43);await assert.rejects(other,{code:'PAGE_CHANGED'});
 }
});
test('subframe refreshes and failed subresources cannot masquerade as a top-level refresh',async()=>{
 const f=fixture(),result=f.start();f.begin(refresh,false);f.contents.emit('did-fail-load',{},-105,'subresource failure','https://cdn.invalid',false);f.commit(target);f.finish();f.abort();await assert.rejects(result,/未观察到/);
});
test('server redirects accept exact refreshes but permanently reject outside and login destinations',async()=>{
 for(const url of ['https://evil.invalid/','https://www.vinted.fr/member/login','https://www.vinted.fr/challenge']){
  const f=fixture(),result=f.start();let prevented=false;f.contents.emit('will-redirect',{preventDefault(){prevented=true;}},url,false,true);f.commit(target);f.finish();f.resolve();await assert.rejects(result,{code:'PAGE_CHANGED'});assert.equal(prevented,true);
 }
 const f=fixture(),result=f.start();f.contents.emit('will-redirect',{url:refresh,isMainFrame:true});f.commit(refresh);f.contents.emit('did-redirect-navigation',{url:target,isMainFrame:true});f.commit(target);f.finish();f.resolve();assert.equal((await result).sessionRefreshed,true);
});
test('cancellation and ownership loss stop promptly and never retry the request',async()=>{
 const f=fixture(),result=f.start();f.controller.abort();await assert.rejects(result,{code:'STOPPED'});assert.deepEqual(f.loads,[target]);assert.equal(f.monitor,null);f.abort();
 const changed=fixture(),other=changed.start();changed.setGuardError(Object.assign(Error('different tab'),{code:'TAB_CHANGED'}));await assert.rejects(other,{code:'TAB_CHANGED'});assert.deepEqual(changed.loads,[target]);changed.abort();
});
test('an already stopped task creates no request',async()=>{
 const f=fixture();f.controller.abort();await assert.rejects(f.start(),{code:'STOPPED'});assert.deepEqual(f.loads,[]);
});
test('new-window requests during initial navigation are rejected without accepting the target',async()=>{
 const f=fixture(),result=f.start();f.monitor.rejectNewWindow();f.commit(target);f.finish();f.resolve();await assert.rejects(result,/其他标签/);assert.equal(f.monitor,null);
});
test('network, rendering, stored fingerprint errors and closed tabs are not swallowed',async()=>{
 for(const action of [f=>f.reject(Object.assign(Error('ERR_PROXY_CONNECTION_FAILED'),{code:'ERR_PROXY_CONNECTION_FAILED'})),f=>f.contents.emit('did-fail-load',{},-105,'ERR_NAME_NOT_RESOLVED',target,true),f=>f.contents.emit('render-process-gone'),f=>f.setError('fingerprint connection lost'),f=>f.destroy()]){
  const f=fixture(),result=f.start();action(f);await assert.rejects(result,{code:'PAGE_CHANGED'});assert.equal(f.contents.eventNames().length,0);f.resolve();
 }
});
test('refresh loops time out without loading again or treating the intermediate page as success',async()=>{
 const f=fixture(),result=f.start({timeoutMs:30});f.begin(refresh);f.commit(refresh);f.finish();f.resolve();await assert.rejects(result,{code:'PAGE_CHANGED'});assert.deepEqual(f.loads,[target]);assert.equal(f.contents.eventNames().length,0);
});
