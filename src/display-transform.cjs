'use strict';
const states=new WeakMap();
const controllers=new WeakMap();
const DEFAULT=Object.freeze({ready:true,version:0,scale:1,custom:false,configured:true,active:true,bounds:null});
const getDisplayState=contents=>states.get(contents)||DEFAULT;
function unavailable(){return Object.assign(Error('窗口显示比例正在更新或不可用，请稍后重新读取页面'),{code:'INPUT_SURFACE_UNAVAILABLE'});}
function assertDisplayVersion(contents,version){const state=getDisplayState(contents);if(!state.ready||version!==undefined&&state.version!==version)throw unavailable();return state;}
function mapPoint(contents,point,version){const state=assertDisplayVersion(contents,version);if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw unavailable();return {x:point.x*state.scale,y:point.y*state.scale};}
function mapRect(contents,rect,version){if(!rect)return null;const point=mapPoint(contents,rect,version),state=assertDisplayVersion(contents,version);if(!Number.isFinite(rect.width)||!Number.isFinite(rect.height))throw unavailable();return {...point,width:rect.width*state.scale,height:rect.height*state.scale};}
function beginInputGesture(contents,version){assertDisplayVersion(contents,version);return controllers.get(contents)?.hold()||(()=>{});}
function displayLayout({availableWidth,availableHeight,width,height,custom,top=104}){
  if(![availableWidth,availableHeight,width,height,top].every(Number.isFinite)||availableWidth<1||availableHeight<1||width<1||height<1)throw unavailable();
  if(!custom)return {scale:1,bounds:{x:0,y:top,width:Math.round(availableWidth),height:Math.round(availableHeight)}};
  const scale=Math.min(1,availableWidth/width,availableHeight/height),w=Math.min(Math.round(availableWidth),Math.max(1,Math.ceil(width*scale))),h=Math.min(Math.round(availableHeight),Math.max(1,Math.ceil(height*scale)));
  return {scale,bounds:{x:Math.floor((availableWidth-w)/2),y:top+Math.floor((availableHeight-h)/2),width:w,height:h}};
}
// Main owns the controller. Every change blocks input synchronously, while one
// asynchronous loop serializes CDP updates. Older acknowledgements cannot mark
// a newer layout ready. Page CSS coordinates remain unchanged throughout.
function createDisplayController(contents,{metrics=null,send,applyBounds=()=>{},onError=()=>{},onApplied=()=>{}}={}){
  let configured=false,desired=null,applied=null,boundsApplied=null,running=null,lastError=null,holds=0,holdWait=null,releaseHolds=null;
  states.set(contents,Object.freeze({...DEFAULT,ready:false,version:1,custom:!!metrics,configured:false,active:false}));
  function publish(patch){states.set(contents,Object.freeze({...getDisplayState(contents),...patch}));}
  function applyNativeBounds(update=desired){if(update&&boundsApplied!==update&&!holds){applyBounds(update.bounds);boundsApplied=update;}}
  function flush(){
    if(running)return running;
    if(holds)return holdWait.then(flush);
    applyNativeBounds();
    if(!configured||!desired?.active||applied===desired&&getDisplayState(contents).ready)return Promise.resolve();
    running=Promise.resolve().then(async()=>{
      while(configured&&desired?.active){
        const update=desired;
        try{
          applyNativeBounds(update);
          if(desired!==update)continue;
          if(metrics)await send({...metrics,scale:update.scale,dontSetVisibleSize:true});
          if(desired!==update)continue;
          if(contents.isDestroyed?.())throw unavailable();
          lastError=null;applied=update;publish({ready:true,configured:true});onApplied();return;
        }catch(error){
          if(desired!==update)continue;
          lastError=error;publish({ready:false});onError(error);throw error;
        }
      }
    }).finally(()=>{running=null;if(configured&&desired?.active&&applied!==desired&&!lastError)return flush();});
    return running;
  }
  function update({scale,bounds,active=true}){
    if(!Number.isFinite(scale)||scale<=0||scale>1)throw unavailable();
    const same=desired&&desired.scale===scale&&desired.active===active&&JSON.stringify(desired.bounds)===JSON.stringify(bounds);
    if(same&&!lastError)return flush();
    desired={scale,bounds:Object.freeze({...bounds}),active};lastError=null;
    publish({ready:false,version:getDisplayState(contents).version+1,scale,bounds:desired.bounds,active,configured});
    // Inactive tabs must move offscreen even when an earlier CDP command is
    // pending. A gesture lease is the sole reason to defer native geometry.
    applyNativeBounds();
    return flush();
  }
  const controller={update,configure(){configured=true;publish({configured:true});return flush();},whenReady(){return flush();},getState:()=>getDisplayState(contents),hold(){
    if(!holds)holdWait=new Promise(resolve=>{releaseHolds=resolve;});holds++;let released=false;
    return ()=>{if(released)return;released=true;holds--;if(!holds){const wake=releaseHolds;releaseHolds=null;wake();flush().catch(()=>{});}};
  }};
  controllers.set(contents,controller);return controller;
}
module.exports={displayLayout,createDisplayController,getDisplayState,assertDisplayVersion,mapPoint,mapRect,beginInputGesture};
