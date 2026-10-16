'use strict';
const {listingRevision}=require('./vinted-publication.cjs');
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const MAX_IMAGE_BYTES=5*1024*1024,READ_TIMEOUT_MS=30000;
const STATES=new Set(['prepared','claiming','uncertain','receipt_saved','downloading','ready','needs_review']);
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const hash=value=>createHash('sha256').update(value).digest('hex');
const stamp=()=>new Date().toISOString();
function failure(code,message){const error=Error(message);error.code=code;return error;}
function object(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function identifier(value){return typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x20\x7f]/.test(value);}
function stopped(){return failure('STOPPED','照片准备已停止；原领取和下载记录已保留');}
function bounded(work,signal,{saveReceipt}={}){
 if(signal.aborted)return Promise.reject(stopped());
 const controller=new AbortController();
 return new Promise((resolve,reject)=>{
  let settled=false,timer;const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);fn(value);};
  // A sent mutation may succeed while being cancelled. Keep its bounded slot
  // until the transport settles, and durably retain a returned receipt first.
  const abort=()=>{controller.abort();if(!saveReceipt)finish(reject,stopped());};signal.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>{controller.abort();finish(reject,failure('PHOTO_TIMEOUT','照片请求超时，已保留原请求编号，不能重新领取其他套组'));},READ_TIMEOUT_MS);
  Promise.resolve().then(()=>{if(controller.signal.aborted)throw stopped();return work(controller.signal);}).then(value=>{if(settled)return;try{saveReceipt?.(value);finish(signal.aborted?reject:resolve,signal.aborted?stopped():value);}catch(error){finish(reject,error);}},error=>finish(reject,signal.aborted?stopped():error));
 });
}
function binding(record){return {planId:record.planId,profileId:record.profileId,productId:record.productId,sku:record.sku,baseURL:record.baseURL,supplierAccountId:record.supplierAccountId,setId:record.setId,payload:record.payload,idempotencyKey:record.idempotencyKey};}
function validRecord(record){
 const invalid=()=>{throw failure('PHOTO_RECORD','原照片准备记录不完整或身份已改变，禁止重新领取');};
 if(!object(record)||!STATES.has(record.state)||!new RegExp('^'+UUID+'$').test(record.id||'')||!['planId','profileId','productId','supplierAccountId','setId'].every(k=>identifier(record[k]))||typeof record.sku!=='string'||!record.sku.trim()||record.sku.length>256||/[\0\r\n]/.test(record.sku)||!object(record.payload)||record.payload.productId!==record.productId||record.payload.setId!==record.setId||Object.keys(record.payload).length!==2||!new RegExp('^isola-photo-'+UUID+'$').test(record.idempotencyKey||'')||!Array.isArray(record.assets)||record.assets.length>20||record.bindingHash!==hash(JSON.stringify(binding(record))))invalid();
 let base;try{base=new URL(record.baseURL);}catch{invalid();}const local=['localhost','127.0.0.1','[::1]'].includes(base.hostname);if(base.protocol!=='https:'&&!(base.protocol==='http:'&&local)||base.username||base.password||base.search||base.hash||base.href!==record.baseURL||!base.pathname.endsWith('/api/v1'))invalid();
 if(!['createdAt','updatedAt'].every(key=>typeof record[key]==='string'&&Number.isFinite(Date.parse(record[key])))||typeof record.error!=='string'||record.error.length>500)invalid();
 const attempted=Number.isSafeInteger(record.attempts)&&record.attempts>0&&typeof record.firstAttemptAt==='string'&&Number.isFinite(Date.parse(record.firstAttemptAt)),hasReceipt=Object.hasOwn(record,'receipt');
 if(record.state==='prepared'?(record.attempts!==undefined||record.firstAttemptAt!==undefined||hasReceipt):!attempted)invalid();
 if(hasReceipt&&(!object(record.receipt)||record.receiptHash!==hash(JSON.stringify(record.receipt))))invalid();
 if(['claiming','uncertain'].includes(record.state)&&hasReceipt||['receipt_saved','downloading','ready'].includes(record.state)&&!hasReceipt)invalid();
 if(record.claimId!==undefined&&!identifier(record.claimId))invalid();
 if(record.images!==undefined){if(!Array.isArray(record.images)||record.images.length<1||record.images.length>20||!record.claimId||!hasReceipt)invalid();receiptImages(record);}
 if(record.assets.length&&(!record.images||record.assets.length>record.images.length))invalid();
 record.assets.forEach((asset,index)=>{assetPath('',asset,index);if(typeof asset.ready!=='boolean'||asset.imageId!==record.images[index].id)invalid();});
 if(record.state==='ready'&&(!record.images||record.images.length!==record.assets.length||record.assets.some(asset=>!asset.ready)))invalid();
}
function restorePhotoPreparations(db){
 if(db.photoPreparations===undefined)db.photoPreparations=[];
 if(!Array.isArray(db.photoPreparations))throw failure('PHOTO_RECORD','照片准备历史格式无效，原文件已保留');
 const ids=new Set(),plans=new Set(),sets=new Set();
 for(const record of db.photoPreparations){
  validRecord(record);const plan=db.plans.find(plan=>plan.id===record.planId),set=JSON.stringify([record.baseURL,record.supplierAccountId,record.setId]);
  if(!plan||plan.profileId!==record.profileId||plan.productId!==record.productId||plan.sku!==record.sku||record.baseURL!==db.settings.baseURL||record.supplierAccountId!==db.supplierAccountId||ids.has(record.id)||plans.has(record.planId)||sets.has(set))throw failure('PHOTO_RECORD','照片准备历史的计划、账号或套组身份冲突，原文件已保留');
  ids.add(record.id);plans.add(record.planId);sets.add(set);
 }
 // Validate all history before changing interruption states; never discard it.
 for(const record of db.photoPreparations){if(record.state==='claiming'){record.state='uncertain';record.error='上次领取尚未核对，只能恢复原套组与请求编号';record.updatedAt=stamp();}else if(record.state==='downloading'){record.state='receipt_saved';record.error='原领取回执已保存，可继续下载同一套照片';record.updatedAt=stamp();}}
}
function summarizePreparation(record){return {id:record.id,planId:record.planId,profileId:record.profileId,productId:record.productId,sku:record.sku,setId:record.setId,claimId:record.claimId||null,state:record.state,count:Array.isArray(record.images)?record.images.length:0,downloadedCount:Array.isArray(record.assets)?record.assets.filter(a=>a?.ready===true).length:0,ready:record.state==='ready',error:record.error||'',createdAt:record.createdAt,updatedAt:record.updatedAt,permanentClaim:true};}
function findRecord(engine,plan){
 const found=engine.db.photoPreparations.filter(r=>r.planId===plan.id||r.profileId===plan.profileId&&r.productId===plan.productId);
 if(found.length>1)throw failure('PHOTO_CONFLICT','该环境商品存在多条照片准备记录，需要先核对原领取');
 const record=found[0];if(!record)return null;validRecord(record);
 if(record.planId!==plan.id||record.profileId!==plan.profileId||record.productId!==plan.productId||record.sku!==plan.sku||record.baseURL!==engine.db.settings.baseURL||record.supplierAccountId!==engine.db.supplierAccountId)throw failure('PHOTO_IDENTITY','照片绑定的计划、环境、商品或货盘账号已改变');
 if(plan.reuseOwnPhotos===false&&engine.db.claims.some(c=>c.id===record.claimId&&c.listings?.length))throw failure('PHOTO_USED','本套照片已有上架记录，计划禁止重复使用；不会另行领取');
 return record;
}
function imageURL(value,baseURL){
 if(typeof value!=='string'||!value||/[\\\x00-\x20\x7f]/.test(value)||value.startsWith('//')||/%(?:2e|2f|5c|25)/i.test(value.split(/[?#]/,1)[0]))throw failure('PHOTO_URL','照片地址不符合原图下载契约');
 let url;const base=new URL(baseURL),prefix=base.pathname.replace(/\/$/,'')+'/photos/images/';
 try{url=/^https?:\/\//i.test(value)?new URL(value):value.startsWith(base.pathname+'/')?new URL(value,base.origin):new URL(value.replace(/^\//,''),base.href+'/');}catch{throw failure('PHOTO_URL','照片地址格式无效');}
 if(url.origin!==base.origin||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(prefix)||!url.pathname.slice(prefix.length)||url.pathname.slice(prefix.length).includes('/'))throw failure('PHOTO_URL','仅允许同一货盘的鉴权 JPEG 原图，不接受预览或其他地址');
 let id;try{id=decodeURIComponent(url.pathname.slice(prefix.length));}catch{throw failure('PHOTO_URL','照片编号编码无效');}if(!identifier(id))throw failure('PHOTO_URL','照片编号无效');
 return {url:url.href,id};
}
function receiptImages(record){
 const result=record.receipt,set=result?.set,claimId=result?.claimId??result?.claim?.id??set?.claim?.id;
 if(!identifier(claimId)||!object(set)||String(set.id)!==record.setId||set.productId!==undefined&&String(set.productId)!==record.productId||set.product_id!==undefined&&String(set.product_id)!==record.productId||!Array.isArray(set.images)||set.images.length<1||set.images.length>20)throw failure('PHOTO_RECEIPT','领取回执的商品、套组、领取编号或图片数量无法核对，原回执已保留');
 if(record.claimId&&claimId!==record.claimId)throw failure('PHOTO_RECEIPT','原领取编号发生变化');
 const images=set.images.map(image=>{if(!object(image))throw failure('PHOTO_RECEIPT','照片回执格式无效');const parsed=imageURL(image.url,record.baseURL);if(image.id!==undefined&&String(image.id)!==parsed.id)throw failure('PHOTO_RECEIPT','照片编号与下载地址不一致');return parsed;});
 if(new Set(images.map(i=>i.id)).size!==images.length)throw failure('PHOTO_RECEIPT','套组出现重复照片编号');
 if(record.images&&JSON.stringify(images)!==JSON.stringify(record.images))throw failure('PHOTO_RECEIPT','原领取照片顺序或地址发生变化，未替换本地照片');
 return {claimId,images};
}
function matchingClaim(engine,record,{required=false}={}){
 const related=engine.db.claims.filter(c=>c.id===record.claimId||c.setId===record.setId);
 if(required&&related.length!==1||related.length>1||related.some(c=>c.id!==record.claimId||c.setId!==record.setId||c.profileId!==record.profileId||c.productId!==record.productId||c.supplierAccountId!==undefined&&c.supplierAccountId!==record.supplierAccountId||!Array.isArray(c.listings)||!Array.isArray(c.images)||JSON.stringify(c.images.map(i=>imageURL(i.url,record.baseURL)))!==JSON.stringify(record.images)))throw failure('PHOTO_CONFLICT','本套照片的本地领取记录、环境或商品不一致，已停止');
 return related[0];
}
function privateDirectory(directory,create){
 if(create&&!fs.existsSync(directory))fs.mkdirSync(directory,{mode:0o700});
 const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw failure('PHOTO_STORAGE','照片目录不是私有常规目录');if(create)fs.chmodSync(directory,0o700);
 // Keep upload manifests canonical even when a macOS parent is exposed through
 // /var rather than /private/var; owned cache directories must still be real.
 const canonical=fs.realpathSync(directory),resolved=fs.lstatSync(canonical);if(!resolved.isDirectory()||resolved.isSymbolicLink()||resolved.dev!==stat.dev||resolved.ino!==stat.ino)throw failure('PHOTO_STORAGE','照片目录已改变');return canonical;
}
function cacheDirectory(engine,record,create=false){
 const root=privateDirectory(path.join(engine.dir,'prepared-photos'),create);
 return privateDirectory(path.join(root,record.id),create);
}
// Windows cannot FlushFileBuffers on a directory handle. The file itself is
// still fsynced before rename; POSIX additionally flushes the parent directory.
function syncDirectory(directory){if(process.platform==='win32')return;const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function assetPath(dir,asset,index){if(!object(asset)||asset.index!==index||!/^[a-f0-9]{64}$/.test(asset.sha256||'')||asset.fileName!==String(index).padStart(2,'0')+'-'+asset.sha256+'.jpg'||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>MAX_IMAGE_BYTES||![asset.width,asset.height].every(n=>Number.isInteger(n)&&n>0&&n<=1200))throw failure('PHOTO_STORAGE','照片文件清单无效');return path.join(dir,asset.fileName);}
function readAsset(dir,asset,index){
 const name=assetPath(dir,asset,index),before=fs.lstatSync(name);
 if(!before.isFile()||before.isSymbolicLink())throw failure('PHOTO_STORAGE','照片文件不是常规文件');
 const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.dev!==before.dev||stat.ino!==before.ino||stat.size!==asset.size||(process.platform!=='win32'&&(stat.mode&0o077)!==0))throw failure('PHOTO_STORAGE','照片文件大小或私有权限已改变');const bytes=fs.readFileSync(fd);if(hash(bytes)!==asset.sha256)throw failure('PHOTO_STORAGE','本地照片内容校验失败');const size=jpegSize(bytes);if(size.width!==asset.width||size.height!==asset.height)throw failure('PHOTO_STORAGE','照片尺寸与清单不一致');return name;}finally{fs.closeSync(fd);}
}
function writeAsset(dir,asset,index,bytes){
 const target=assetPath(dir,asset,index),tmp=path.join(dir,'.'+randomUUID()+'.tmp');let fd;
 try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,target);syncDirectory(dir);}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
function jpegSize(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<12||bytes.length>MAX_IMAGE_BYTES||bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217)throw failure('PHOTO_IMAGE','图片必须为完整 JPEG，大小不超过 5 MiB');
 let offset=2;while(offset<bytes.length-2){if(bytes[offset++]!==255)break;while(bytes[offset]===255)offset++;const marker=bytes[offset++];if(marker===0xda||marker===0xd9)break;if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;if(offset+2>bytes.length)break;const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){if(length<8)break;const height=bytes.readUInt16BE(offset+3),width=bytes.readUInt16BE(offset+5);if(!width||!height||width>1200||height>1200)break;return {width,height};}offset+=length;}
 throw failure('PHOTO_IMAGE','JPEG 尺寸或内容无效，最长边须不超过 1200 像素');
}
async function validateBytes(bytes,validateImage,signal){const size=jpegSize(bytes),decoded=await bounded(()=>validateImage(bytes),signal);if(!decoded||decoded.width!==size.width||decoded.height!==size.height)throw failure('PHOTO_IMAGE','JPEG 无法完整解码或尺寸不一致');return {...size,size:bytes.length,sha256:hash(bytes)};}
function readPreparedPhotos(engine,planId){
 if(engine.plan(planId).source==='local')return require('./commerce-local-products.cjs').readLocalPreparedPhotos(engine,planId);
 const record=findRecord(engine,engine.plan(planId));if(!record)return {summary:null,manifest:null};
 const summary=summarizePreparation(record);if(record.state!=='ready')return {summary,manifest:null};
 try{
  const validated=receiptImages(record);if(record.claimId!==validated.claimId||record.assets.length!==validated.images.length)throw failure('PHOTO_STORAGE','本地照片数量与原领取不一致');
  matchingClaim(engine,record,{required:true});
  const dir=cacheDirectory(engine,record),files=record.assets.map((asset,index)=>{if(!asset.ready||asset.imageId!==validated.images[index].id)throw failure('PHOTO_STORAGE','本地照片尚未完整保存');return {path:readAsset(dir,asset,index),sha256:asset.sha256,width:asset.width,height:asset.height,size:asset.size,imageId:asset.imageId};});
  return {summary,manifest:{preparationId:record.id,planId:record.planId,profileId:record.profileId,productId:record.productId,sku:record.sku,setId:record.setId,claimId:record.claimId,count:files.length,files}};
 }catch{return {summary:{...summary,ready:false,state:'needs_review',error:'本地照片文件缺失或校验失败，请重新准备以恢复原领取'},manifest:null};}
}
async function chooseSet(client,plan,setId,signal,guard,reserved){
 if(setId!==undefined&&!identifier(setId))throw failure('PHOTO_SET','照片套组编号无效');
 if(setId&&reserved.has(setId))throw failure('PHOTO_CONFLICT','指定照片套组已绑定本地其他环境，未重新领取');
 if(!setId){const available=[];for(let page=1;page<=100;page++){
  const response=await bounded(s=>client.photoSets({productId:plan.productId,page,pageSize:100},{signal:s}),signal);guard();
  if(!object(response)||!Array.isArray(response.sets))throw failure('PHOTO_SET','照片套组分页格式无效');
  for(const set of response.sets){if(!object(set)||!identifier(String(set.id||''))||String(set.productId??set.product_id)!==plan.productId)throw failure('PHOTO_SET','照片套组所属商品不一致');if(set.status==='available'&&!set.claim&&!set.claimId&&!set.claim_id&&!reserved.has(String(set.id)))available.push(String(set.id));}
  if(response.sets.length<100||Number.isSafeInteger(response.total)&&response.total>=0&&page*100>=response.total)break;if(page===100)throw failure('PHOTO_SET','照片套组超过本次核对上限');
 }setId=[...new Set(available)].sort()[0];if(!setId)throw failure('PHOTO_EMPTY','没有可领取的照片套组；其他环境领取的照片不会转用');}
 const response=await bounded(s=>client.photoSet(setId,{signal:s}),signal);guard();const set=response?.set??response;
 if(!object(set)||String(set.id)!==setId||String(set.productId??set.product_id)!==plan.productId||set.status!=='available'||set.claim||set.claimId||set.claim_id)throw failure('PHOTO_SET','指定套组的商品或可领取状态无法确认，未领取');
 const count=set.imageCount??set.image_count??set.images?.length;if(!Number.isSafeInteger(count)||count<1||count>20)throw failure('PHOTO_SET','指定套组的照片数量无效');return setId;
}
async function preparePhotos(engine,planId,{setId,signal:callerSignal,validateImage}={}){
 if(typeof validateImage!=='function')throw failure('PHOTO_DECODER','照片解码校验器未配置，未领取照片');
 return engine.configure((configSignal,configGuard)=>preparePhotoWork(engine,planId,{setId,callerSignal,validateImage},configSignal,configGuard));
}
// Main-process job entry. A renderer cannot manufacture the active controller
// or profile lease. Manual preparation still uses the configuration lock.
async function preparePhotosForJob(engine,job,{signal,validateImage}={}){
 if(typeof validateImage!=='function')throw failure('PHOTO_DECODER','照片解码校验器未配置，未领取照片');
 const identity={id:job?.id,planId:job?.planId,profileId:job?.profileId,productId:job?.productId,cycle:job?.payload?.cycle,listingRevision:listingRevision(job?.payload?.listingRevision)};
 const guard=()=>{
  const rows=engine.db.jobs.filter(row=>row.id===identity.id),current=rows[0],plan=engine.db.plans.find(row=>row.id===identity.planId);
  if(!signal||signal.aborted||engine.active.get(identity.profileId)?.signal!==signal||!engine.leases.snapshot().some(row=>row.profileId===identity.profileId&&row.jobId===identity.id)||rows.length!==1||current.state!=='running'||current.type!=='listing'||current.planId!==identity.planId||current.profileId!==identity.profileId||current.productId!==identity.productId||current.payload?.cycle!==identity.cycle||listingRevision(current.payload?.listingRevision)!==identity.listingRevision||listingRevision(plan?.listingRevision)!==identity.listingRevision||!plan?.enabled||plan.profileId!==identity.profileId||plan.productId!==identity.productId||plan.completedCount!==identity.cycle||engine.closing||engine.configPending)throw stopped();
 };
 guard();return preparePhotoWork(engine,identity.planId,{validateImage},signal,guard);
}
async function preparePhotoWork(engine,planId,{setId,callerSignal,validateImage},configSignal,configGuard){
  const controller=new AbortController(),abort=()=>controller.abort();for(const signal of [configSignal,callerSignal]){signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();}
  const signal=controller.signal,guard=()=>{if(signal.aborted)throw stopped();configGuard();if(engine.faulted)throw failure('PHOTO_STORAGE','运营存储不可用，照片准备已停止');};
  let record,started=false;
  const save=()=>{record.updatedAt=stamp();engine.persist();engine.emit();};
  try{
   guard();const plan=engine.plan(planId);if(!engine.profiles().some(p=>p.id===plan.profileId))throw failure('PHOTO_PROFILE','照片计划的环境不存在');
   if(plan.source==='local'){
    if(setId!==undefined)throw failure('PHOTO_SET','本地商品仅使用已导入的原照片，不领取货盘套组');
    return require('./commerce-local-products.cjs').prepareLocalPhotos(engine,planId,{signal,guard});
   }
   record=findRecord(engine,plan);if(record&&setId!==undefined&&setId!==record.setId)throw failure('PHOTO_CONFLICT','原照片任务已固定套组，不能改成另一套重新领取');
   const client=await engine.client(signal);guard();const me=await bounded(s=>client.me({signal:s}),signal);guard();const accountId=engine.accountIdentity(me);
   if(!accountId||!engine.db.supplierAccountId||accountId!==engine.db.supplierAccountId||record&&accountId!==record.supplierAccountId)throw failure('PHOTO_IDENTITY','货盘账号与原连接或照片记录不一致');
   const response=await bounded(s=>client.product(plan.productId,{signal:s}),signal);guard();const product=response?.product??response;
   if(!object(product)||String(product.id)!==plan.productId||product.sku!==plan.sku)throw failure('PHOTO_PRODUCT','货盘商品编号或 SKU 与照片计划不一致');
   if(!record){
    if(engine.db.claims.some(c=>c.profileId===plan.profileId&&c.productId===plan.productId))throw failure('PHOTO_LEGACY','本环境已有领取记录，需要先迁移核对，禁止再次领取');
    const reserved=new Set([...engine.db.photoPreparations.map(r=>r.setId),...engine.db.claims.map(c=>c.setId)].filter(Boolean));
    const chosen=await chooseSet(client,plan,setId,signal,guard,reserved);guard();
    record={id:randomUUID(),planId:plan.id,profileId:plan.profileId,productId:plan.productId,sku:plan.sku,baseURL:engine.db.settings.baseURL,supplierAccountId:accountId,setId:chosen,payload:{productId:plan.productId,setId:chosen},idempotencyKey:'isola-photo-'+randomUUID(),state:'prepared',assets:[],createdAt:stamp(),updatedAt:stamp(),error:''};record.bindingHash=hash(JSON.stringify(binding(record)));engine.db.photoPreparations.push(record);save();
   }
   guard();started=true;const dir=cacheDirectory(engine,record,true);syncDirectory(path.dirname(dir));syncDirectory(engine.dir);
   if(!Object.hasOwn(record,'receipt')){
    // The supplied v1.8.0 contract specifies same-key/body replay, but no 24h
    // expiry. Always fixing setId also prevents allocation of a different set.
    record.state='claiming';record.error='';record.firstAttemptAt=record.firstAttemptAt||stamp();record.attempts=(record.attempts||0)+1;save();guard();
    await bounded(s=>client.claimPhotos({...record.payload},{idempotencyKey:record.idempotencyKey,signal:s}),signal,{saveReceipt:receipt=>{
     record.receipt=object(receipt)?JSON.parse(JSON.stringify(receipt)):{invalidReceipt:true};record.receiptHash=hash(JSON.stringify(record.receipt));record.state='receipt_saved';save();
    }});guard();
   }
   const validated=receiptImages(record);record.claimId=validated.claimId;record.images=validated.images;
   if(!matchingClaim(engine,record))engine.db.claims.push({id:record.claimId,profileId:record.profileId,productId:record.productId,setId:record.setId,images:record.images.map(i=>({...i})),listings:[],preparationId:record.id,supplierAccountId:record.supplierAccountId});
   record.state='downloading';record.error='';save();guard();
   for(let index=0;index<record.images.length;index++){
    guard();const image=record.images[index];let asset=record.assets[index];
    if(asset){if(asset.imageId!==image.id)throw failure('PHOTO_STORAGE','本地照片顺序与原领取不一致');try{readAsset(dir,asset,index);asset.ready=true;save();continue;}catch(error){if(error.code!=='ENOENT')throw failure('PHOTO_STORAGE','已保存照片校验失败，未用新内容覆盖');}}
    const bytes=await bounded(s=>client.download(image.url,{signal:s,maxBytes:MAX_IMAGE_BYTES}),signal);guard();const metadata=await validateBytes(bytes,validateImage,signal);guard();
    if(asset&&['sha256','size','width','height'].some(key=>asset[key]!==metadata[key]))throw failure('PHOTO_IMAGE','原图片下载内容发生变化，未覆盖已登记照片');
    asset={index,imageId:image.id,...metadata,fileName:String(index).padStart(2,'0')+'-'+metadata.sha256+'.jpg',ready:false};record.assets[index]=asset;save();guard();writeAsset(dir,asset,index,bytes);asset.ready=true;save();
   }
   guard();record.state='ready';record.error='';save();return readPreparedPhotos(engine,planId);
  }catch(error){
   if(started&&record&&!engine.faulted){record.state=Object.hasOwn(record,'receipt')?'needs_review':record.firstAttemptAt?'uncertain':'prepared';record.error=error?.code==='STOPPED'?'照片准备已停止，原领取与文件记录已保留':error?.code==='PHOTO_TIMEOUT'?'请求超时，保留原编号与套组等待恢复':'照片准备未完成，请核对原领取与本地照片后重试';save();}
   throw error;
  }finally{for(const signal of [configSignal,callerSignal])signal?.removeEventListener('abort',abort);}
}
module.exports={preparePhotos,preparePhotosForJob,readPreparedPhotos,summarizePreparation,restorePhotoPreparations,jpegSize,MAX_IMAGE_BYTES,READ_TIMEOUT_MS};
