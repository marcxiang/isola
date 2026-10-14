const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {problem} = require('./commerce-engine.cjs');

const trusted = new WeakSet();
const FORM_URL = 'https://www.vinted.fr/items/new';
const MAX_COUNT = 20, MAX_BYTES = 20 * 1024 * 1024;
const stopped = () => problem('STOPPED','照片上传已停止');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function delay(ms,signal) {
  if(signal?.aborted)return Promise.reject(stopped());
  return new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);resolve();},cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(stopped());},timer=setTimeout(done,ms);signal?.addEventListener('abort',cancel,{once:true});});
}
function boundedIO(work,{signal,timeoutMs=10000,onTimeout}={}) {
  if(signal?.aborted)return Promise.reject(stopped());
  return new Promise((resolve,reject)=>{
    let settled=false,timer;
    const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);fn(value);};
    const cancel=()=>finish(reject,stopped());signal?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>{finish(reject,problem('PHOTO_CONTROL_TIMEOUT','照片页面控制超时，请检查页面和原上传结果'));onTimeout?.();},timeoutMs);
    Promise.resolve().then(()=>{if(signal?.aborted)throw stopped();return work();}).then(value=>finish(resolve,value),error=>finish(reject,error));
  });
}

async function verifyFile(file) {
  if (!file || typeof file.path !== 'string' || !path.isAbsolute(file.path) || file.path.includes('\0') || !/\.jpe?g$/i.test(file.path) || !/^[a-f0-9]{64}$/i.test(file.sha256 || '')) throw problem('PHOTO_MANIFEST_INVALID','照片清单必须包含绝对 JPEG 路径和 SHA-256');
  try {
  const stat = await fs.lstat(file.path);
  const realPath=process.platform==='win32'?fsSync.realpathSync(file.path):await fs.realpath(file.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 4 || stat.size > MAX_BYTES || realPath !== file.path) throw problem('PHOTO_MANIFEST_INVALID','照片文件类型、路径或大小无效');
  const bytes = await fs.readFile(file.path);
  if (bytes.length !== stat.size || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9 || createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase()) throw problem('PHOTO_HASH_MISMATCH','照片内容与已准备的 JPEG 清单不一致');
  return Object.freeze({path:file.path,sha256:file.sha256.toLowerCase(),bytes:bytes.length,...(Number.isSafeInteger(file.width)&&file.width>0?{width:file.width}:{}),...(Number.isSafeInteger(file.height)&&file.height>0?{height:file.height}:{})});
  }catch(error){if(['PHOTO_MANIFEST_INVALID','PHOTO_HASH_MISMATCH'].includes(error.code))throw error;throw problem('PHOTO_FILE_UNAVAILABLE','本地照片文件无法读取，请重新检查已准备照片');}
}

// Main-process code creates this capability after resolving a stored photo claim.
// A renderer-supplied object, even with identical fields, cannot pass the WeakSet check.
async function createTrustedPhotoManifest(input) {
  if (!input || typeof input.claimId !== 'string' || !input.claimId.trim() || input.claimId.length > 200 || typeof input.profileId !== 'string' || !input.profileId || !Array.isArray(input.files) || !Number.isInteger(input.count) || input.count < 1 || input.count > MAX_COUNT || input.files.length !== input.count) throw problem('PHOTO_MANIFEST_INVALID','照片清单的环境、认领编号或数量无效');
  if (new Set(input.files.map(file=>file?.path)).size !== input.count || new Set(input.files.map(file=>file?.sha256?.toLowerCase())).size !== input.count) throw problem('PHOTO_MANIFEST_INVALID','照片清单含有重复文件');
  const files=[];for(const file of input.files)files.push(await verifyFile(file));
  const manifest=Object.freeze({claimId:input.claimId,profileId:input.profileId,count:input.count,files:Object.freeze(files),...(input.productId!==undefined?{productId:input.productId}:{}),...(input.setId!==undefined?{setId:input.setId}:{})});trusted.add(manifest);return manifest;
}

// Read-only DOM inspection. No page-world property, input value, local filename,
// file contents, image URL, cookie or private application state is returned.
async function inspectPhotoDOM() {
  const d=globalThis.__isolaDOM,normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
  const safe=e=>normalize(d.safeText(e,500)),outside=e=>!!d.closest(e,'header,nav,[role=navigation],[role=tablist]');
  const fileInputs=[...document.querySelectorAll('input[type=file]')].filter(e=>!outside(e));
  const attrs=e=>({tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||'',testId:(e.getAttribute('data-testid')||'').slice(0,120),label:d.label(e).slice(0,180),visible:d.visible(e)});
  const anchors=scope=>[...scope.querySelectorAll('button,[role=button],label')].filter(e=>d.visible(e)&&normalize(d.label(e))==='Ajoute des photos');
  const imageCache=new Map(),images=async scope=>Promise.all([...scope.querySelectorAll('img')].filter(d.visible).map(e=>{
    if(!imageCache.has(e))imageCache.set(e,(async()=>{const source=e.currentSrc||e.src||'';let sourceFingerprint='';try{sourceFingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}catch{}
      return {alt:(e.getAttribute('alt')||'').slice(0,160),testId:(e.getAttribute('data-testid')||'').slice(0,120),loaded:e.complete&&e.naturalWidth>0,width:e.naturalWidth||0,height:e.naturalHeight||0,sourceKind:/^blob:/.test(source)?'blob':/^data:/.test(source)?'data':/^https?:/.test(source)?'http':'other',sourceFingerprint};})());return imageCache.get(e);
  }));
  const controls=scope=>[...scope.querySelectorAll('button,[role=button]')].filter(d.visible).slice(0,30).map(attrs);
  const statuses=scope=>[...scope.querySelectorAll('[role=alert],[role=status],[aria-live],[aria-busy=true],progress,[role=progressbar]')].filter(d.visible).slice(0,12).map(e=>({role:e.getAttribute('role')||e.tagName.toLowerCase(),text:safe(e),busy:e.getAttribute('aria-busy')==='true'||e.tagName==='PROGRESS'||e.getAttribute('role')==='progressbar'}));
  const candidates=await Promise.all(fileInputs.slice(0,8).map(async(input,index)=>{
    const ancestors=[];let scope=null,scopeLevel=null,knownScope=null,knownLevel=null;
    for(const [level,parent] of d.parents(input).entries()){
      if(['BODY','HTML','MAIN','FORM'].includes(parent.tagName))break;
      if(level>7)break;
      const otherFields=[...parent.querySelectorAll('input:not([type=file]):not([type=hidden]),textarea,select')].filter(e=>!['button','submit'].includes(e.type));
      const count=parent.querySelectorAll('input[type=file]').length,buttons=anchors(parent),thumbnails=await images(parent);
      ancestors.push({...attrs(parent),level,fileInputs:count,otherFields:otherFields.length,uploadButtons:buttons.length,images:thumbnails,controls:controls(parent),statuses:statuses(parent)});
      if(!scope&&count===1&&buttons.length===1&&otherFields.length===0){scope=parent;scopeLevel=level;}
      // Observed on the live French form: this exact hidden input and upload div.
      if(input.getAttribute('data-testid')==='add-photos-input'&&parent.tagName==='DIV'&&parent.getAttribute('data-testid')==='media-upload'&&count===1&&otherFields.length===0&&d.visible(parent)&&document.querySelectorAll('div[data-testid="media-upload"]').length===1){knownScope=parent;knownLevel=level;}
    }
    if(knownScope){scope=knownScope;scopeLevel=knownLevel;}
    const state=scope?{...attrs(scope),images:await images(scope),controls:controls(scope),statuses:statuses(scope),busy:scope.getAttribute('aria-busy')==='true'}:null;
    if(knownScope){
      state.contract='vinted-fr-photos-v1';state.selectionVerified=anchors(scope).length===1;
      const captions=state.images.map(image=>normalize(image.alt).match(/^Photo ([1-9]\d*) sur ([1-9]\d*) mise en ligne Pour réorganiser les photos, appuie sur la barre d['’]espace$/));
      const count=state.images.length,completeSet=count>0&&captions.every(Boolean)&&captions.every(caption=>Number(caption[2])===count&&Number(caption[1])<=count)&&new Set(captions.filter(Boolean).map(caption=>Number(caption[1]))).size===count;
      const remove=state.controls.filter(control=>control.label==='Supprimer la photo sélectionnée'),edit=state.controls.filter(control=>/^Modifier la photo [1-9]\d*$/.test(control.label)&&Number(control.label.match(/\d+$/)[0])<=count);
      state.receiptVerified=completeSet&&remove.length===1&&edit.length>=1;
      state.thumbnails=state.images.flatMap((image,index)=>captions[index]?[{index:Number(captions[index][1]),total:Number(captions[index][2]),key:image.sourceFingerprint,loaded:image.loaded,serverStored:image.loaded&&image.sourceKind==='http'}]:[]).sort((a,b)=>a.index-b.index);
      state.errors=state.statuses.filter(status=>status.text&&(status.role==='alert'||/erreur|échou|échec|impossible|réessayer|error|failed/i.test(status.text))).map(status=>status.text);
      // The observed completed upload has empty live statuses. Unknown nonempty
      // status text remains pending until its meaning is verified on the page.
      state.busy=state.busy||state.statuses.some(status=>status.busy||status.text);
    }
    return {index,testId:input.getAttribute('data-testid')||'',accept:input.accept||'',multiple:!!input.multiple,disabled:d.disabled(input),required:!!input.required,visible:d.visible(input),label:d.label(input).slice(0,180),selectedFileCount:input.files?.length||0,scopeLevel,ancestors,scope:state};
  }));
  const challenge=[...document.querySelectorAll('iframe')].some(e=>d.visible(e)&&/captcha|challenges\.cloudflare|challenge-platform/i.test((e.getAttribute('src')||'')+' '+(e.getAttribute('title')||'')))||[...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].some(e=>d.visible(e)&&/captcha|vérifi.{0,30}humain|vérification de sécurité|pas un robot/i.test(safe(e)));
  return {url:location.href,documentKey:String(performance.timeOrigin),fileInputCount:fileInputs.length,candidates,challenge};
}

class VintedPhotoUpload {
  constructor(adapter,{uploadWaitMs=30000,pollIntervalMs=250,ioTimeoutMs=10000,releaseTimeoutMs=1000}={}) {this.adapter=adapter;this.claims=new Map();this.uploadWaitMs=Math.min(60000,Math.max(0,uploadWaitMs));this.pollIntervalMs=Math.min(1000,Math.max(10,pollIntervalMs));this.ioTimeoutMs=Math.min(10000,Math.max(1,ioTimeoutMs));this.releaseTimeoutMs=Math.min(1000,Math.max(1,releaseTimeoutMs));}
  io(work,context) {return boundedIO(work,{signal:context.signal,timeoutMs:this.ioTimeoutMs,onTimeout:()=>context.controller?.abort()});}
  command(context,method,args) {return this.io(()=>context.tab.view.webContents.debugger.sendCommand(method,args),context);}
  async read(profileId,context) {
    const controller=new AbortController(),cancel=()=>controller.abort(),scoped={...context,signal:controller.signal};
    if(context.signal?.aborted)throw stopped();context.signal?.addEventListener('abort',cancel,{once:true});
    const readIO=work=>boundedIO(work,{signal:controller.signal,timeoutMs:this.ioTimeoutMs,onTimeout:()=>{controller.abort();context.controller?.abort();}});
    try{
      await readIO(()=>this.adapter.read(profileId,scoped));
      const state=await readIO(()=>this.adapter.control.isolated(context.tab,'('+inspectPhotoDOM.toString()+')()'));
      this.adapter.current(profileId,scoped);
      if(!state||state.url!==FORM_URL||typeof state.documentKey!=='string'||!Array.isArray(state.candidates))throw problem('PHOTO_INSPECTION_FAILED','照片控件检查无效或页面已改变');
      return state;
    }finally{context.signal?.removeEventListener('abort',cancel);}
  }
  async inspect(profileId,{signal}={}) {
    const {tab}=this.adapter.current(profileId,{signal,form:true}),state=await this.read(profileId,{signal,tab,form:true});
    const record=this.claims.get(profileId+'\0'+tab.id+'\0'+state.documentKey);
    let reason=null;try{const candidate=this.selection(state,{allowDisabled:!!record});if(candidate.selectedFileCount>0||(candidate.scope.images||[]).length>0||(candidate.scope.thumbnails||[]).length>0)reason='页面已有照片或文件，需核对原上传回执';else if(candidate.scope.busy||(candidate.scope.errors||[]).length)reason='照片区域仍在处理或显示错误，请先核对';}catch(error){reason=error.message;}
    return {...state,canUpload:reason===null&&!record,canCheck:!!record,previousClaimState:record?{claimId:record.claimId,phase:record.phase}:null,verified:false,message:reason||'已找到唯一照片控件；本次只读诊断没有选择或上传文件。'};
  }
  selection(state,{allowDisabled=false}={}) {
    if(state.challenge)throw problem('PHOTO_CHALLENGE','网页显示安全验证，请人工处理后重新检查');
    if(state.fileInputCount!==1||state.candidates.length!==1)throw problem('PHOTO_INPUT_AMBIGUOUS','未找到唯一照片文件控件，未选择文件');
    const candidate=state.candidates[0],accepted=String(candidate.accept||'').toLowerCase().split(',').map(value=>value.trim());
    if(candidate.disabled&&!allowDisabled||!accepted.some(value=>['image/*','image/jpeg','.jpg','.jpeg'].includes(value)))throw problem('PHOTO_INPUT_INVALID','照片文件控件不可用或未明确接受 JPEG');
    if(candidate.scope?.contract!=='vinted-fr-photos-v1')throw problem('PHOTO_UPLOAD_UNVERIFIED','照片区域和完成回执结构尚未按真实网页验证，请先读取照片诊断');
    if(!allowDisabled&&candidate.scope.selectionVerified!==true)throw problem('PHOTO_UPLOAD_UNVERIFIED','未找到已核对的唯一「Ajoute des photos」控件，未选择文件');
    return candidate;
  }
  receipt(state,count) {
    const candidate=this.selection(state,{allowDisabled:true}),scope=candidate.scope;
    if((scope.errors||[]).length)throw problem('PHOTO_UPLOAD_ERROR','照片区域显示上传错误：'+scope.errors.slice(0,3).map(value=>String(value).slice(0,160)).join('；'),true);
    const thumbnails=scope.thumbnails||[];
    if(thumbnails.length>count)throw problem('PHOTO_RECEIPT_CONFLICT','照片数量超过本次清单，需人工核对，未再次上传',true);
    if(scope.receiptVerified!==true||scope.busy||thumbnails.length!==count||thumbnails.some(photo=>photo.loaded!==true||photo.serverStored!==true||typeof photo.key!=='string'||!photo.key)||new Set(thumbnails.map(photo=>photo.key)).size!==count)return null;
    return {count,signature:digest(thumbnails.map(photo=>photo.key))};
  }
  async fileInputObject(context,before) {
    const contents=context.tab.view.webContents,candidate=this.selection(before);
    if(!contents.debugger?.isAttached()||!context.tab.aiContext)throw problem('PHOTO_CONTROL_UNAVAILABLE','照片页面控制连接不可用');
    const expression=`(() => {if(location.href!==${JSON.stringify(FORM_URL)}||String(performance.timeOrigin)!==${JSON.stringify(before.documentKey)})return null;const d=globalThis.__isolaDOM,inputs=[...document.querySelectorAll('input[type=file]')].filter(e=>!d.closest(e,'header,nav,[role=navigation],[role=tablist]'));if(inputs.length!==1)return null;const input=inputs[0];if(!input.isConnected||d.disabled(input)||input.accept!==${JSON.stringify(candidate.accept)}||input.multiple!==${JSON.stringify(candidate.multiple)})return null;return input;})()`;
    const result=await this.command(context,'Runtime.evaluate',{expression,contextId:context.tab.aiContext,returnByValue:false,awaitPromise:false});
    if(result.exceptionDetails||result.result?.subtype!=='node'||!result.result.objectId)throw problem('PHOTO_INPUT_CHANGED','照片控件已改变，未选择文件');
    return result.result.objectId;
  }
  async verifyInputObject(context,objectId,before) {
    const result=await this.command(context,'Runtime.callFunctionOn',{objectId,functionDeclaration:`function(){const d=globalThis.__isolaDOM,inputs=[...document.querySelectorAll('input[type=file]')].filter(e=>!d.closest(e,'header,nav,[role=navigation],[role=tablist]'));return location.href===${JSON.stringify(FORM_URL)}&&String(performance.timeOrigin)===${JSON.stringify(before.documentKey)}&&inputs.length===1&&inputs[0]===this&&this.isConnected&&!d.disabled(this)&&(!this.files||this.files.length===0);}`,returnByValue:true});
    if(result.exceptionDetails||result.result?.value!==true)throw problem('PHOTO_INPUT_CHANGED','照片控件或已有文件发生变化，未选择文件');
  }
  async awaitReceipt(profileId,context,manifest,record,{unchanged=false}={}) {
    const deadline=Date.now()+this.uploadWaitMs;let signature=null,stable=0;
    while(true){
      const state=await this.read(profileId,context);
      if(state.documentKey!==record.documentKey)throw problem('PAGE_CHANGED','照片上传期间页面已重新加载，请人工核对结果',true);
      const receipt=this.receipt(state,manifest.count),candidate=state.candidates[0],scope=candidate.scope;
      const summary={thumbnailCount:(scope.thumbnails||[]).length,serverStoredCount:(scope.thumbnails||[]).filter(photo=>photo.serverStored&&photo.loaded).length,errorCount:(scope.errors||[]).length,busy:!!scope.busy,documentKey:state.documentKey};
      const shared={claimId:manifest.claimId,count:manifest.count,unchanged,canUpload:false,canCheck:true,receipt:summary,published:false,saved:false,draftComplete:false};
      if(receipt){if(record.signature&&record.signature!==receipt.signature)throw problem('PHOTO_RECEIPT_CONFLICT','原上传照片已被页面上的其他操作改变，未再次上传',true);stable=signature===receipt.signature?stable+1:1;signature=receipt.signature;if(stable>=2){record.phase='verified';record.signature=receipt.signature;return {...shared,verified:true,uncertain:false,uploaded:true,message:'页面已显示本次上传的完整照片回执；未保存草稿或发布。'};}}
      else{stable=0;signature=null;}
      if(Date.now()>=deadline){record.phase='uncertain';return {...shared,verified:false,uncertain:true,uploaded:false,message:'文件选择已发送，但未能确认完整上传回执。请核对页面；再次检查只会读取结果，不会重复上传。'};}
      await delay(Math.min(this.pollIntervalMs,Math.max(1,deadline-Date.now())),context.signal);
    }
  }
  async upload(profileId,manifest,{signal,recheckOnly=false}={}) {
    if(!trusted.has(manifest)||manifest.profileId!==profileId)throw problem('PHOTO_MANIFEST_UNTRUSTED','仅接受 main 从已准备图片认领生成的照片清单');
    if(typeof recheckOnly!=='boolean')throw problem('PHOTO_OPTIONS_INVALID','照片核对选项无效');
    if(signal?.aborted)throw stopped();
    const controller=new AbortController(),cancel=()=>controller.abort(),context={signal:controller.signal,controller,form:true};let w,contents,objectId,record;
    const onNavigation=(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame!==false)controller.abort();},onDestroyed=()=>controller.abort();
    signal?.addEventListener('abort',cancel,{once:true});
    try{
      const selected=this.adapter.current(profileId,{signal,form:true});w=selected.w;context.tab=selected.tab;contents=context.tab.view.webContents;w.vintedDraftController=controller;
      contents.on?.('did-start-navigation',onNavigation);contents.on?.('render-process-gone',onDestroyed);contents.on?.('destroyed',onDestroyed);
      const guard=()=>this.adapter.current(profileId,context);guard();
      const before=await this.read(profileId,context),manifestKey=digest({claimId:manifest.claimId,files:manifest.files.map(file=>file.sha256),count:manifest.count});
      const key=profileId+'\0'+context.tab.id+'\0'+before.documentKey,previous=this.claims.get(key);
      if(recheckOnly&&(!previous||previous.claimId!==manifest.claimId||previous.manifestKey!==manifestKey))throw problem('NO_UPLOAD_TO_CHECK','当前页面没有与本次照片清单对应的原上传记录，只读核对不会选择文件');
      if(previous){if(previous.claimId!==manifest.claimId||previous.manifestKey!==manifestKey)throw problem('PHOTO_CLAIM_CONFLICT','此页面已开始上传另一份照片清单，未再次选择文件');record=previous;return await this.awaitReceipt(profileId,context,manifest,record,{unchanged:true});}
      const candidate=this.selection(before);
      if(candidate.selectedFileCount>0||(candidate.scope.thumbnails||[]).length>0||(candidate.scope.images||[]).length>0)throw problem('PHOTO_EXISTING','页面已有未关联本次认领的照片或文件，已保留原内容');
      if(candidate.scope.busy||(candidate.scope.errors||[]).length)throw problem('PHOTO_PAGE_BUSY','照片区域仍在处理或显示错误，请先人工核对');
      if(manifest.count>1&&!candidate.multiple)throw problem('PHOTO_INPUT_INVALID','当前照片控件不允许本次多图选择');
      for(const file of manifest.files){await this.io(()=>verifyFile(file),context);guard();}
      objectId=await this.fileInputObject(context,before);guard();
      const final=await this.read(profileId,context);guard();const finalCandidate=this.selection(final);
      if(final.documentKey!==before.documentKey||finalCandidate.selectedFileCount>0||(finalCandidate.scope.thumbnails||[]).length>0||(finalCandidate.scope.images||[]).length>0||finalCandidate.scope.busy||(finalCandidate.scope.errors||[]).length)throw problem('PHOTO_INPUT_CHANGED','选择文件前照片页面发生变化，未上传');
      await this.verifyInputObject(context,objectId,before);guard();
      await this.io(()=>context.tab.controlFeedback?.({stage:'acting',action:'uploadPhotos',label:'上传已核对的 '+manifest.count+' 张商品照片'}),context);guard();
      // Any interrupted setter is uncertain. Same-document retries reconcile only.
      record={claimId:manifest.claimId,manifestKey,documentKey:before.documentKey,phase:'dispatching'};this.claims.set(key,record);
      await this.command(context,'DOM.setFileInputFiles',{files:manifest.files.map(file=>file.path),objectId});guard();record.phase='submitted';
      return await this.awaitReceipt(profileId,context,manifest,record);
    }catch(error){if(record){record.phase='uncertain';error.ambiguous=true;error.claimId=record.claimId;error.uploadMayHaveStarted=true;}throw error;}
    finally{
      signal?.removeEventListener('abort',cancel);contents?.removeListener?.('did-start-navigation',onNavigation);contents?.removeListener?.('render-process-gone',onDestroyed);contents?.removeListener?.('destroyed',onDestroyed);
      if(objectId&&contents?.debugger?.isAttached()&&!contents.isDestroyed())try{await boundedIO(()=>contents.debugger.sendCommand('Runtime.releaseObject',{objectId}),{timeoutMs:this.releaseTimeoutMs});}catch{}
      if(w?.vintedDraftController===controller)w.vintedDraftController=null;
    }
  }
}

module.exports={VintedPhotoUpload,createTrustedPhotoManifest,inspectPhotoDOM};
