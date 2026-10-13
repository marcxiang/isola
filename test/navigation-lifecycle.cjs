'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {stopDraft,installUnloadGuard,closeContents}=require('../src/navigation-lifecycle.cjs');
function fixture({choice=0,automated=false,focused=false}={}){
 const contents=new EventEmitter();contents.dead=false;contents.isDestroyed=()=>contents.dead;contents.getURL=()=> 'https://example.test/draft';
 const tab={view:{webContents:contents},url:'https://example.test/new',error:''},window={isDestroyed:()=>false,isFocused:()=>focused};
 let asked=0,options;
 tab.unloadGuard=installUnloadGuard(window,tab,{showMessageBoxSync:(_,o)=>{asked++;options=o;return choice;},onState:()=>{},isAutomating:()=>automated});
 contents.attempt=()=>{let left=false;contents.emit('will-prevent-unload',{preventDefault(){left=true;}});return left;};
 contents.close=opts=>{assert.equal(opts.waitForBeforeUnload,true);if(contents.attempt()){contents.dead=true;contents.emit('destroyed');}};
 return {contents,tab,window,get asked(){return asked;},get options(){return options;}};
}
test('unload confirmation defaults to preserving the document and real URL',()=>{
 const f=fixture();f.tab.unloadGuard.begin('reload');assert.equal(f.contents.attempt(),false);assert.equal(f.asked,1);assert.equal(f.options.defaultId,0);assert.equal(f.options.cancelId,0);assert.equal(f.tab.url,'https://example.test/draft');assert.match(f.tab.error,/保留/);assert.equal(f.tab.unloadGuard.blocked,true);f.tab.unloadGuard.dispose();
});
test('only explicit leave decision permits unload and automated requests never prompt',()=>{
 const f=fixture({choice:1});f.tab.unloadGuard.begin('reload');assert.equal(f.contents.attempt(),true);assert.match(f.options.buttons[1],/重新加载/);f.tab.unloadGuard.dispose();
 const auto=fixture({choice:1,automated:true,focused:true});auto.tab.unloadGuard.begin('go');assert.equal(auto.contents.attempt(),false);assert.equal(auto.asked,0);assert.match(auto.tab.error,/自动操作未离开/);auto.tab.unloadGuard.dispose();
});
test('close only destroys contents after an explicit leave decision',async()=>{
 const stay=fixture();assert.equal(await closeContents(stay.tab),false);assert.equal(stay.contents.dead,false);assert.equal(stay.contents.listenerCount('destroyed'),1);stay.tab.unloadGuard.dispose();
 const leave=fixture({choice:1});assert.equal(await closeContents(leave.tab),true);assert.equal(leave.contents.dead,true);assert.equal(leave.contents.listenerCount('destroyed'),0);
});
test('unresponsive close times out without assuming the page was destroyed',async()=>{
 const f=fixture();f.contents.close=()=>{};assert.equal(await closeContents(f.tab,{timeoutMs:5}),false);assert.equal(f.contents.dead,false);assert.equal(f.contents.listenerCount('destroyed'),1);f.tab.unloadGuard.dispose();
});
test('draft cancellation awaits actual final cleanup, not merely abort notification',async()=>{
 const controller=new AbortController(),window={vintedDraftController:controller};let cleaned=false;
 controller.signal.addEventListener('abort',()=>setTimeout(()=>{cleaned=true;window.vintedDraftController=null;},15));
 await stopDraft(window,{pollMs:1,timeoutMs:100});assert.equal(controller.signal.aborted,true);assert.equal(cleaned,true);
});
test('draft cancellation timeout preserves controller ownership and prevents next action',async()=>{
 const controller=new AbortController(),window={vintedDraftController:controller};
 await assert.rejects(stopDraft(window,{pollMs:1,timeoutMs:5}),/仍在停止/);assert.equal(controller.signal.aborted,true);assert.equal(window.vintedDraftController,controller);
});
