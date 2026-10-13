const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {problem} = require('./commerce-engine.cjs');

const trusted = new WeakSet();
const FORM_URL = 'https://www.vinted.fr/items/new';
const MAX_COUNT = 20, MAX_BYTES = 20 * 1024 * 1024;
const stopped = () => problem('STOPPED','照片上传已停止');

async function verifyFile(file) {
  if (!file || typeof file.path !== 'string' || !path.isAbsolute(file.path) || file.path.includes('\0') || !/\.jpe?g$/i.test(file.path) || !/^[a-f0-9]{64}$/i.test(file.sha256 || '')) throw problem('PHOTO_MANIFEST_INVALID','照片清单必须包含绝对 JPEG 路径和 SHA-256');
  const stat = await fs.lstat(file.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 4 || stat.size > MAX_BYTES || await fs.realpath(file.path) !== file.path) throw problem('PHOTO_MANIFEST_INVALID','照片文件类型、路径或大小无效');
  const bytes = await fs.readFile(file.path);
  if (bytes.length !== stat.size || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9 || createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase()) throw problem('PHOTO_HASH_MISMATCH','照片内容与已准备的 JPEG 清单不一致');
  return Object.freeze({path:file.path,sha256:file.sha256.toLowerCase(),bytes:bytes.length,...(Number.isSafeInteger(file.width)&&file.width>0?{width:file.width}:{}),...(Number.isSafeInteger(file.height)&&file.height>0?{height:file.height}:{})});
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
function inspectPhotoDOM() {
  const d=globalThis.__isolaDOM,normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
  const safe=e=>normalize(d.safeText(e,500)),outside=e=>!!d.closest(e,'header,nav,[role=navigation],[role=tablist]');
  const fileInputs=[...document.querySelectorAll('input[type=file]')].filter(e=>!outside(e));
  const attrs=e=>({tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||'',testId:(e.getAttribute('data-testid')||'').slice(0,120),label:d.label(e).slice(0,180),visible:d.visible(e)});
  const anchors=scope=>[...scope.querySelectorAll('button,[role=button],label')].filter(e=>d.visible(e)&&normalize(d.label(e))==='Ajoute des photos');
  const images=scope=>[...scope.querySelectorAll('img')].filter(d.visible).map(e=>({alt:(e.getAttribute('alt')||'').slice(0,160),testId:(e.getAttribute('data-testid')||'').slice(0,120),loaded:e.complete&&e.naturalWidth>0,width:e.naturalWidth||0,height:e.naturalHeight||0,sourceKind:/^blob:/.test(e.currentSrc||e.src)?'blob':/^data:/.test(e.currentSrc||e.src)?'data':/^https?:/.test(e.currentSrc||e.src)?'http':'other'}));
  const controls=scope=>[...scope.querySelectorAll('button,[role=button]')].filter(d.visible).slice(0,30).map(attrs);
  const statuses=scope=>[...scope.querySelectorAll('[role=alert],[role=status],[aria-live],[aria-busy=true],progress,[role=progressbar]')].filter(d.visible).slice(0,12).map(e=>({role:e.getAttribute('role')||e.tagName.toLowerCase(),text:safe(e),busy:e.getAttribute('aria-busy')==='true'||e.tagName==='PROGRESS'||e.getAttribute('role')==='progressbar'}));
  const candidates=fileInputs.slice(0,8).map((input,index)=>{
    const ancestors=[];let scope=null,scopeLevel=null;
    for(const [level,parent] of d.parents(input).entries()){
      if(['BODY','HTML','MAIN','FORM'].includes(parent.tagName))break;
      if(level>7)break;
      const otherFields=[...parent.querySelectorAll('input:not([type=file]):not([type=hidden]),textarea,select')].filter(e=>!['button','submit'].includes(e.type));
      const count=parent.querySelectorAll('input[type=file]').length,buttons=anchors(parent),thumbnails=images(parent);
      ancestors.push({...attrs(parent),level,fileInputs:count,otherFields:otherFields.length,uploadButtons:buttons.length,images:thumbnails,controls:controls(parent),statuses:statuses(parent)});
      if(!scope&&count===1&&buttons.length===1&&otherFields.length===0){scope=parent;scopeLevel=level;}
    }
    return {index,accept:input.accept||'',multiple:!!input.multiple,disabled:d.disabled(input),required:!!input.required,visible:d.visible(input),label:d.label(input).slice(0,180),selectedFileCount:input.files?.length||0,scopeLevel,ancestors,scope:scope?{...attrs(scope),images:images(scope),controls:controls(scope),statuses:statuses(scope),busy:scope.getAttribute('aria-busy')==='true'}:null};
  });
  const challenge=[...document.querySelectorAll('iframe')].some(e=>d.visible(e)&&/captcha|challenges\.cloudflare|challenge-platform/i.test((e.getAttribute('src')||'')+' '+(e.getAttribute('title')||'')));
  return {url:location.href,documentKey:String(performance.timeOrigin),fileInputCount:fileInputs.length,candidates,challenge};
}

class VintedPhotoUpload {
  constructor(adapter,{uploadWaitMs=30000,pollIntervalMs=250}={}) {this.adapter=adapter;this.claims=new Map();this.uploadWaitMs=Math.min(60000,Math.max(0,uploadWaitMs));this.pollIntervalMs=Math.min(1000,Math.max(10,pollIntervalMs));}
  async read(profileId,context) {
    await this.adapter.read(profileId,context);
    const state=await this.adapter.control.isolated(context.tab,'('+inspectPhotoDOM.toString()+')()');
    this.adapter.current(profileId,context);
    if(!state||state.url!==FORM_URL||typeof state.documentKey!=='string'||!Array.isArray(state.candidates))throw problem('PHOTO_INSPECTION_FAILED','照片控件检查无效或页面已改变');
    return state;
  }
  async inspect(profileId,{signal}={}) {
    const {tab}=this.adapter.current(profileId,{signal,form:true}),state=await this.read(profileId,{signal,tab,form:true});
    return {...state,canUpload:false,verified:false,message:'只读照片控件诊断；上传控件及缩略图回执仍需按真实页面核对，未选择或上传任何文件。'};
  }
  async upload(profileId,manifest,{signal}={}) {
    if(!trusted.has(manifest)||manifest.profileId!==profileId)throw problem('PHOTO_MANIFEST_UNTRUSTED','仅接受 main 从已准备图片认领生成的照片清单');
    if(signal?.aborted)throw stopped();
    throw problem('PHOTO_UPLOAD_UNVERIFIED','照片上传控件与页面回执尚在联调，请先读取照片诊断');
  }
}

module.exports={VintedPhotoUpload,createTrustedPhotoManifest,inspectPhotoDOM};
