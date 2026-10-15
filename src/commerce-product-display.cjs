'use strict';
const {normalizeBaseURL}=require('./sku-desk.cjs');

const MAX_BYTES=2*1024*1024,MAX_DIMENSION=640,MAX_SOURCE_SIDE=8192,MAX_SOURCE_PIXELS=32*1024*1024,CACHE_SIZE=60,CACHE_MS=5*60*1000;
const COVER_FIELDS=['displayImageUrl','thumbnailUrl','thumbnail_url','coverImageUrl','cover_image_url','coverUrl','cover_url','imageUrl','image_url'];
const MIME=new Set(['image/jpeg','image/png','image/webp']);
function failure(code='PRODUCT_DISPLAY_UNAVAILABLE'){
 const messages={PRODUCT_DISPLAY_UNAVAILABLE:'商品展示图暂不可用。',PRODUCT_DISPLAY_DECODE_FAILED:'商品展示图解码失败，请重试展示图。',PRODUCT_DISPLAY_CHANGED:'商品或货盘来源已改变，请刷新商品后重试。',PRODUCT_DISPLAY_BUSY:'展示图读取繁忙，请稍后重试。',PRODUCT_DISPLAY_TIMEOUT:'展示图读取超时，请稍后重试。'};
 return Object.assign(Error(messages[code]||messages.PRODUCT_DISPLAY_UNAVAILABLE),{code});
}
function ensure(value,code){if(!value)throw failure(code);}
function safeSource(value){
 if(typeof value!=='string'||!value||value.length>4096||value!==value.trim()||/[\\\x00-\x20\x7f]/.test(value)||/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)||value.startsWith('//'))return null;
 const rawPath=value.split(/[?#]/,1)[0];if(/(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)||/%(?:2e|2f|5c|25)/i.test(rawPath))return null;
 try{if(value.startsWith('/')){const url=new URL(value,'https://display.invalid');return url.origin==='https://display.invalid'&&!url.hash?value:null;}if(!/^https:\/\//i.test(value))return null;const url=new URL(value);return url.protocol==='https:'&&!!url.hostname&&!url.username&&!url.password&&!url.hash?url.href:null;}catch{return null;}
}
function productCoverSource(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const nested=value=>{if(typeof value==='string')return safeSource(value);if(!value||typeof value!=='object'||Array.isArray(value))return null;for(const key of ['url','src',...COVER_FIELDS]){const source=safeSource(value[key]);if(source)return source;}return null;};
 for(const key of COVER_FIELDS){const source=safeSource(raw[key]);if(source)return source;}
 for(const key of ['image','cover','thumbnail']){const source=nested(raw[key]);if(source)return source;}
 return Array.isArray(raw.images)&&raw.images.length?nested(raw.images[0]):null;
}
function authenticatedImageRoute(url,base,productId){
 const parts=url.pathname.slice(base.pathname.length).split('/').slice(1),component=value=>{try{const decoded=decodeURIComponent(value);return decoded&&decoded.length<=256&&decoded!=='.'&&decoded!=='..'&&!/[\\/\x00-\x1f\x7f]/.test(decoded)?decoded:null;}catch{return null;}};
 if(parts[0]==='products'&&component(parts[1])===productId){
  if(parts.length===3&&['cover','image','thumbnail'].includes(parts[2]))return true;
  if(parts.length===4&&parts[2]==='images'&&component(parts[3]))return true;
 }
 return parts.length===3&&parts[0]==='photos'&&['images','thumbnails'].includes(parts[1])&&!!component(parts[2]);
}
function imageInfo(bytes){
 ensure(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX_BYTES);let width,height,type;
 if(bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
  ensure(bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.toString('ascii',bytes.length-8,bytes.length-4)==='IEND');width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);type='image/png';
 }else if(bytes.length>=12&&bytes[0]===255&&bytes[1]===216&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217){
  let offset=2;while(offset<bytes.length-2){if(bytes[offset++]!==255)break;while(bytes[offset]===255)offset++;const marker=bytes[offset++];if(marker===0xda||marker===0xd9)break;if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;if(offset+2>bytes.length)break;const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){if(length<8)break;height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);type='image/jpeg';break;}offset+=length;}
 }else if(bytes.length>=25&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'){
  ensure(bytes.readUInt32LE(4)+8===bytes.length);const format=bytes.toString('ascii',12,16),length=bytes.readUInt32LE(16);ensure(length>0&&20+length<=bytes.length);
  if(format==='VP8X'&&length===10&&bytes.length>=30){ensure(!(bytes[20]&2));width=bytes.readUIntLE(24,3)+1;height=bytes.readUIntLE(27,3)+1;}
  else if(format==='VP8L'&&length>=5&&bytes[20]===0x2f){const bits=bytes.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
  else if(format==='VP8 '&&length>=10&&bytes.length>=30&&!(bytes[20]&1)&&bytes.subarray(23,26).equals(Buffer.from([0x9d,1,0x2a]))){width=bytes.readUInt16LE(26)&0x3fff;height=bytes.readUInt16LE(28)&0x3fff;}
  type='image/webp';
 }
 ensure(MIME.has(type)&&Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&width<=MAX_SOURCE_SIDE&&height<=MAX_SOURCE_SIDE&&width*height<=MAX_SOURCE_PIXELS);return {width,height,type};
}
function normalizedPreview(value){
 ensure(value&&typeof value==='object'&&!Array.isArray(value)&&Number.isSafeInteger(value.width)&&Number.isSafeInteger(value.height)&&value.width>0&&value.height>0&&value.width<=MAX_DIMENSION&&value.height<=MAX_DIMENSION&&typeof value.dataURL==='string'&&value.dataURL.length<=Math.ceil(MAX_BYTES/3)*4+64);
 const match=/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.dataURL);ensure(match);const bytes=Buffer.from(match[2],'base64');ensure(bytes.toString('base64')===match[2]);const actual=imageInfo(bytes);ensure(actual.type===match[1]&&actual.width===value.width&&actual.height===value.height);return {dataURL:value.dataURL,width:value.width,height:value.height};
}
async function readPublic(response,url,signal){
 ensure(response&&response.ok===true&&!response.redirected&&(!response.url||response.url===url)&&MIME.has(String(response.headers?.get('content-type')||'').split(';',1)[0].trim().toLowerCase()));
 const length=response.headers?.get('content-length');ensure(!length||/^\d+$/.test(length)&&Number(length)<=MAX_BYTES);ensure(response.body&&typeof response.body.getReader==='function');const reader=response.body.getReader(),chunks=[],onAbort=()=>{void reader.cancel().catch(()=>{});};let total=0,done=false;
 signal.addEventListener('abort',onAbort,{once:true});try{while(true){ensure(!signal.aborted,'PRODUCT_DISPLAY_TIMEOUT');const next=await reader.read();if(next.done){done=true;break;}ensure(next.value instanceof Uint8Array);total+=next.value.byteLength;ensure(total<=MAX_BYTES);chunks.push(Buffer.from(next.value));}return Buffer.concat(chunks,total);}finally{signal.removeEventListener('abort',onAbort);if(!done)await reader.cancel().catch(()=>{});reader.releaseLock?.();}
}
function createProductDisplayService({normalizeImage,fetchImpl=globalThis.fetch,timeoutMs=10000,now=Date.now}={}){
 if(typeof normalizeImage!=='function'||typeof fetchImpl!=='function'||typeof now!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw failure();
 const cache=new Map(),inflight=new Map(),waiters=[];let active=0;
 function snapshot(engine,productId){
  ensure(typeof productId==='string'&&productId.length>0&&productId.length<=256&&!/[\x00-\x1f\x7f]/.test(productId)&&engine?.db&&Array.isArray(engine.db.products));
  const rows=engine.db.products.filter(row=>row?.id===productId),locals=(engine.db.localProducts||[]).filter(row=>row?.id===productId);ensure(rows.length<=1&&locals.length<=1&&!(rows.length&&locals.length));
  if(!rows.length){ensure(locals.length===1);return {productId,local:true};}const row=rows[0];if(row.source==='local')return {productId,local:true};
  const source=safeSource(row.displayImageUrl);if(!source)return {productId,empty:true};const baseURL=normalizeBaseURL(engine.db.settings?.baseURL);ensure(baseURL===engine.db.settings.baseURL);const account=engine.db.supplierAccountId??null;ensure(account===null||typeof account==='string'&&account.length<=256);
  const key=JSON.stringify([baseURL,account,productId,row.revision??null,row.sku??null,source]);return {productId,source,baseURL,account,key};
 }
 function guard(engine,original,signal){ensure(!signal?.aborted,'PRODUCT_DISPLAY_TIMEOUT');ensure(!engine.closing,'PRODUCT_DISPLAY_CHANGED');let current;try{current=snapshot(engine,original.productId);}catch{throw failure('PRODUCT_DISPLAY_CHANGED');}ensure(current.key===original.key,'PRODUCT_DISPLAY_CHANGED');}
 async function schedule(work){
  ensure(waiters.length<CACHE_SIZE,'PRODUCT_DISPLAY_BUSY');await new Promise(resolve=>{if(active<3){active++;resolve();}else waiters.push(resolve);});
  try{return await work();}finally{const next=waiters.shift();if(next)next();else active--;}
 }
 async function bounded(work){
  const controller=new AbortController();let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure('PRODUCT_DISPLAY_TIMEOUT'));},timeoutMs);});
  try{return await Promise.race([Promise.resolve().then(()=>work(controller.signal)),timeout]);}finally{clearTimeout(timer);}
 }
 async function load(engine,original){
  return schedule(()=>bounded(async signal=>{
   guard(engine,original,signal);const base=new URL(original.baseURL),url=new URL(original.source,base),api=url.origin===base.origin&&(url.pathname===base.pathname||url.pathname.startsWith(base.pathname+'/'));let bytes;
   if(api){ensure(authenticatedImageRoute(url,base,original.productId));const client=await engine.client(signal);guard(engine,original,signal);ensure(client&&typeof client.download==='function');bytes=await client.download(url.href,{signal,maxBytes:MAX_BYTES});}
   else{ensure(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash);const response=await fetchImpl(url.href,{method:'GET',headers:{},credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal});try{bytes=await readPublic(response,url.href,signal);}catch(error){await response?.body?.cancel?.().catch(()=>{});throw error;}}
   guard(engine,original,signal);imageInfo(bytes);let converted;
   try{converted=await normalizeImage(bytes,{maxDimension:MAX_DIMENSION,signal});}catch{guard(engine,original,signal);throw failure('PRODUCT_DISPLAY_DECODE_FAILED');}
   guard(engine,original,signal);try{return {productId:original.productId,...normalizedPreview(converted)};}catch{throw failure('PRODUCT_DISPLAY_DECODE_FAILED');}
  }));
 }
 return {async preview(engine,productId){
  try{
   const original=snapshot(engine,productId);if(original.local||original.empty)return {productId,dataURL:null};guard(engine,original);
   const stamp=now();for(const [key,entry] of cache)if(entry.expiresAt<=stamp)cache.delete(key);const cached=cache.get(original.key);if(cached){cache.delete(original.key);cache.set(original.key,cached);return {...cached.value};}
   let pending=inflight.get(original.key);if(!pending){pending=load(engine,original).then(value=>{guard(engine,original);cache.set(original.key,{value,expiresAt:now()+CACHE_MS});while(cache.size>CACHE_SIZE)cache.delete(cache.keys().next().value);return value;});inflight.set(original.key,pending);pending.finally(()=>{if(inflight.get(original.key)===pending)inflight.delete(original.key);}).catch(()=>{});}
   const result=await pending;guard(engine,original);return {...result};
  }catch(error){if(['PRODUCT_DISPLAY_CHANGED','PRODUCT_DISPLAY_BUSY','PRODUCT_DISPLAY_TIMEOUT','PRODUCT_DISPLAY_DECODE_FAILED'].includes(error?.code))throw failure(error.code);throw failure();}
 }};
}
module.exports={productCoverSource,createProductDisplayService};
