'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const {normalizeListing,missingListingFields}=require('./listing-config.cjs');
const {normalizeBaseURL}=require('./sku-desk.cjs');
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',MAX_SOURCE_BYTES=20*1024*1024,MAX_BYTES=5*1024*1024,IMPORT_MS=10*60*1000;
const imports=new WeakMap(),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),copy=value=>JSON.parse(JSON.stringify(value)),stamp=()=>new Date().toISOString();
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value),id=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\x00-\x20\x7f]/.test(value);
const supplierId=value=>id(value)&&!['.','..'].includes(value)&&!/[\\/]/.test(value);
const named=(value,prefix)=>typeof value==='string'&&new RegExp('^'+prefix+UUID+'$').test(value);
const exact=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function ensure(ok,message,code='LOCAL_PRODUCT_INVALID'){if(!ok)throw Object.assign(Error(message),{code});}
function text(value,label){ensure(typeof value==='string'&&!!value.trim()&&value.trim()===value&&value.length<=200&&!/[\x00-\x1f\x7f]/.test(value),label+'无效');return value;}
function date(value){return typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;}
function guardEngine(engine){ensure(!engine.closing&&!engine.configPending&&!engine.storageFaulted?.()&&!engine.faulted,'运营正在更新或存储不可用，请稍后保存本地商品','LOCAL_PRODUCT_BUSY');}
function checkpoint(signal,guard=()=>{}){ensure(!signal?.aborted,'本地照片准备已停止','STOPPED');guard();}
function assetValid(asset,index){
 ensure(object(asset)&&asset.index===index&&/^[a-f0-9]{64}$/.test(asset.sha256||'')&&asset.imageId==='local-image-'+asset.sha256&&asset.fileName===String(index).padStart(2,'0')+'-'+asset.sha256+'.jpg'&&Number.isSafeInteger(asset.size)&&asset.size>0&&asset.size<=MAX_BYTES&&[asset.width,asset.height].every(value=>Number.isSafeInteger(value)&&value>0&&value<=1200),'本地照片清单无效');
 ensure(Object.keys(asset).every(key=>['index','imageId','sha256','size','width','height','fileName'].includes(key)),'本地照片清单包含未知字段');return asset;
}
function privateDir(directory,create=false){
 if(create&&!fs.existsSync(directory))fs.mkdirSync(directory,{mode:0o700});const info=fs.lstatSync(directory);ensure(info.isDirectory()&&!info.isSymbolicLink(),'本地照片目录无效','LOCAL_PHOTO_STORAGE');if(create)fs.chmodSync(directory,0o700);
 // macOS may expose the same parent through /var and /private/var. Return the
 // canonical owned directory so the upload capability keeps its exact-path
 // check; an owned directory or photo replaced by a symlink is still invalid.
 const canonical=fs.realpathSync(directory),resolved=fs.lstatSync(canonical);ensure(resolved.isDirectory()&&!resolved.isSymbolicLink()&&resolved.dev===info.dev&&resolved.ino===info.ino,'本地照片目录已改变','LOCAL_PHOTO_STORAGE');return canonical;
}
function directory(engine,setId,create=false){ensure(named(setId,'local-set-'),'本地照片套组编号无效');const root=privateDir(path.join(engine.dir,'local-product-photos'),create);return privateDir(path.join(root,setId),create);}
function readFile(engine,setId,asset,index){
 assetValid(asset,index);const file=path.join(directory(engine,setId),asset.fileName),before=fs.lstatSync(file);ensure(before.isFile()&&!before.isSymbolicLink(),'本地照片不是常规文件','LOCAL_PHOTO_STORAGE');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const info=fs.fstatSync(fd);ensure(info.isFile()&&info.ino===before.ino&&info.dev===before.dev&&info.size===asset.size&&(process.platform==='win32'||(info.mode&0o077)===0),'本地照片大小或权限已改变','LOCAL_PHOTO_STORAGE');const bytes=fs.readFileSync(fd);ensure(hash(bytes)===asset.sha256,'本地照片内容校验失败','LOCAL_PHOTO_STORAGE');const size=require('./commerce-photos.cjs').jpegSize(bytes);ensure(size.width===asset.width&&size.height===asset.height,'本地照片尺寸已改变','LOCAL_PHOTO_STORAGE');return file;}finally{fs.closeSync(fd);}
}
function supplierOrigin(origin){
 ensure(object(origin)&&Object.keys(origin).length===8&&Object.keys(origin).every(key=>['kind','baseURL','supplierAccountId','productId','setId','sku','status','importedAt'].includes(key))&&origin.kind==='supplier-reuse'&&id(origin.supplierAccountId)&&supplierId(origin.productId)&&supplierId(origin.setId)&&typeof origin.sku==='string'&&origin.sku.trim()===origin.sku&&origin.sku.length>0&&origin.sku.length<=256&&!/[\x00-\x1f\x7f]/.test(origin.sku)&&typeof origin.status==='string'&&origin.status.trim()===origin.status&&origin.status.length>0&&origin.status.length<=100&&!/[\x00-\x1f\x7f]/.test(origin.status)&&date(origin.importedAt),'货盘原图来源记录无效');
 ensure(typeof origin.baseURL==='string'&&normalizeBaseURL(origin.baseURL)===origin.baseURL,'货盘原图来源地址无效');return origin;
}
function originSummary(origin){if(!origin)return undefined;const {kind,productId,setId,sku,status,importedAt}=supplierOrigin(origin);return {kind,productId,setId,sku,status,importedAt};}
function productRow(row){
 ensure(object(row)&&named(row.id,'local-')&&row.source==='local'&&named(row.sku,'LOCAL-')&&typeof row.name==='string'&&row.name.trim()===row.name&&!!text(row.name,'商品名称')&&Number.isSafeInteger(row.stock)&&row.stock>=0&&row.stock<=100000000&&Number.isSafeInteger(row.revision)&&row.revision>=1&&date(row.createdAt)&&date(row.updatedAt)&&Date.parse(row.updatedAt)>=Date.parse(row.createdAt)&&Array.isArray(row.photos)&&row.photos.length<=20,'本地商品记录无效');
 ensure(row.photos.length?named(row.photoSetId,'local-set-'):row.photoSetId===null,'本地商品照片套组无效');row.photos.forEach(assetValid);ensure(new Set(row.photos.map(photo=>photo.sha256)).size===row.photos.length,'本地商品出现重复照片');
 if(row.origin!==undefined){supplierOrigin(row.origin);ensure(row.photos.length>0&&Date.parse(row.origin.importedAt)<=Date.parse(row.updatedAt),'货盘原图来源与本地照片不一致');}
 ensure(Object.keys(row).every(key=>['id','source','sku','name','stock','revision','photoSetId','photos','createdAt','updatedAt','origin'].includes(key)),'本地商品记录包含未知字段');return row;
}
function localProductDTO(row,template){productRow(row);return {id:row.id,source:'local',sku:row.sku,name:row.name,stock:row.stock,priceCents:template?.listingPriceCents??null,photoSetsAvailable:row.photos.length?1:0,revision:row.revision,localPhotoCount:row.photos.length,...(row.origin?{origin:originSummary(row.origin)}:{})};}
function localCatalog(db){return (db.localProducts||[]).map(row=>localProductDTO(row,(db.productListings||[]).find(template=>template.productId===row.id&&template.sku===row.sku)));}
function getLocalProduct(engine,plan){
 ensure(plan?.source==='local','计划不是已保存的本地商品来源');const rows=(engine.db.localProducts||[]).filter(row=>row.id===plan.productId),row=rows[0];ensure(rows.length===1&&row.sku===plan.sku,'本地商品或 SKU 与计划不一致','LOCAL_PRODUCT_MISMATCH');return localProductDTO(row,(engine.db.productListings||[]).find(template=>template.productId===row.id&&template.sku===row.sku));
}
function firstPhotosForDraftPlans(db,product,plans){
 const planIds=new Set(plans.map(plan=>plan.id)),related=row=>row&&(row.productId===product.id||row.localProductId===product.id||planIds.has(row.planId));
 if(product.photos.length||plans.some(plan=>plan.source!=='local'||plan.sku!==product.sku||plan.enabled!==false||plan.activeListingId||plan.completedCount!==0||plan.listingRevision!==0))return false;
 if(['jobs','sales','claims','photoPreparations','localPhotoPreparations','publicationSupplierSync','reservations'].some(key=>(db[key]||[]).some(related)))return false;
 return !(db.publications?.submissions||[]).some(record=>related(record.proof?.facts));
}
function prepBinding(record){return {source:record.source,id:record.id,planId:record.planId,profileId:record.profileId,productId:record.productId,sku:record.sku,setId:record.setId,claimId:record.claimId,assets:record.assets};}
function validatePreparation(db,record){
 ensure(object(record)&&record.source==='local'&&named(record.id,'local-preparation-')&&['planId','profileId','productId','sku'].every(key=>id(record[key]))&&named(record.setId,'local-set-')&&named(record.claimId,'local-claim-')&&record.state==='ready'&&record.error===''&&Array.isArray(record.assets)&&record.assets.length>0&&record.assets.length<=20&&date(record.createdAt)&&date(record.updatedAt)&&record.bindingHash===hash(JSON.stringify(prepBinding(record))),'本地照片准备记录无效');record.assets.forEach(assetValid);
 ensure(Object.keys(record).every(key=>['id','source','planId','profileId','productId','sku','setId','claimId','state','assets','createdAt','updatedAt','error','bindingHash'].includes(key)),'本地照片准备包含未知字段');
 const products=db.localProducts.filter(row=>row.id===record.productId),plans=db.plans.filter(plan=>plan.id===record.planId),plan=plans[0],product=products[0];ensure(products.length===1&&plans.length===1&&plan.source==='local'&&plan.profileId===record.profileId&&plan.productId===record.productId&&plan.sku===record.sku&&product.sku===record.sku&&product.photoSetId===record.setId&&exact(product.photos,record.assets),'本地照片准备与原商品、环境或计划不一致');
 const claims=db.claims.filter(claim=>claim.id===record.claimId||claim.preparationId===record.id),claim=claims[0];ensure(claims.length===1&&claim.source==='local'&&claim.preparationId===record.id&&claim.profileId===record.profileId&&claim.productId===record.productId&&claim.setId===record.setId&&claim.localProductId===product.id&&Object.keys(claim).every(key=>['id','source','profileId','productId','setId','images','listings','preparationId','localProductId'].includes(key))&&Array.isArray(claim.listings)&&exact(claim.images,record.assets.map(asset=>({id:asset.imageId,source:'local',sha256:asset.sha256}))),'本地照片关联记录无效');return {plan,product,claim};
}
function restoreLocalProducts(db){
 if(db.localProducts===undefined)db.localProducts=[];if(db.localPhotoPreparations===undefined)db.localPhotoPreparations=[];
 ensure(Array.isArray(db.localProducts)&&Array.isArray(db.localPhotoPreparations),'本地商品或照片历史格式无效');const ids=new Set(),skus=new Set(),sets=new Set();
 for(const row of db.localProducts){productRow(row);ensure(!ids.has(row.id)&&!skus.has(row.sku)&&(!row.photoSetId||!sets.has(row.photoSetId))&&!db.products.some(product=>product.id===row.id||product.sku===row.sku),'本地商品与货盘编号或 SKU 冲突');ids.add(row.id);skus.add(row.sku);if(row.photoSetId)sets.add(row.photoSetId);}
 const preparations=new Set(),plans=new Set(),claims=new Set();for(const record of db.localPhotoPreparations){validatePreparation(db,record);ensure(!preparations.has(record.id)&&!plans.has(record.planId)&&!claims.has(record.claimId),'本地照片准备记录重复');preparations.add(record.id);plans.add(record.planId);claims.add(record.claimId);}
 for(const claim of db.claims.filter(row=>row.source==='local'))ensure(claims.has(claim.id),'本地照片缺少原准备记录');
 ensure(!(db.publicationSupplierSync||[]).some(row=>claims.has(row.claimId)),'本地照片不能含有货盘关联历史');
}
function summarizeLocalPreparation(record){return {id:record.id,source:'local',planId:record.planId,profileId:record.profileId,productId:record.productId,sku:record.sku,setId:record.setId,claimId:record.claimId,state:'ready',count:record.assets.length,downloadedCount:record.assets.length,ready:true,error:'',createdAt:record.createdAt,updatedAt:record.updatedAt,permanentClaim:false};}
function readLocalPreparedPhotos(engine,planId){
 const plan=engine.plan(planId);getLocalProduct(engine,plan);const records=(engine.db.localPhotoPreparations||[]).filter(record=>record.planId===planId);ensure(records.length<=1,'本地照片准备记录重复');const record=records[0];if(!record)return {summary:null,manifest:null};validatePreparation(engine.db,record);
 const summary=summarizeLocalPreparation(record);
 try{const files=record.assets.map((asset,index)=>({path:readFile(engine,record.setId,asset,index),sha256:asset.sha256,width:asset.width,height:asset.height,size:asset.size,imageId:asset.imageId}));return {summary,manifest:{source:'local',preparationId:record.id,planId:record.planId,profileId:record.profileId,productId:record.productId,sku:record.sku,setId:record.setId,claimId:record.claimId,count:files.length,files}};}catch{return {summary:{...summary,state:'needs_review',ready:false,error:'本地照片文件缺失或校验失败，原图清单已保留；不会选择其他图片替换'},manifest:null};}
}
function prepareLocalPhotos(engine,planId,{signal,guard=()=>{}}={}){
 checkpoint(signal,guard);const plan=engine.plan(planId),product=getLocalProduct(engine,plan),row=engine.db.localProducts.find(item=>item.id===product.id);ensure(row.photos.length>0,'请先为本地商品导入照片','LOCAL_PHOTO_REQUIRED');
 const old=(engine.db.localPhotoPreparations||[]).find(record=>record.planId===planId);if(old){const result=readLocalPreparedPhotos(engine,planId);ensure(result.summary?.ready&&result.manifest,result.summary?.error||'本地照片尚未准备','LOCAL_PHOTO_STORAGE');if(plan.reuseOwnPhotos===false)ensure(!engine.db.claims.find(claim=>claim.id===old.claimId).listings.length,'原照片已有刊登记录，计划禁止复用','PHOTO_USED');return result;}
 row.photos.forEach((asset,index)=>readFile(engine,row.photoSetId,asset,index));checkpoint(signal,guard);
 const at=stamp(),record={id:'local-preparation-'+randomUUID(),source:'local',planId,profileId:plan.profileId,productId:plan.productId,sku:plan.sku,setId:row.photoSetId,claimId:'local-claim-'+randomUUID(),state:'ready',assets:copy(row.photos),createdAt:at,updatedAt:at,error:''};record.bindingHash=hash(JSON.stringify(prepBinding(record)));
 const claim={id:record.claimId,source:'local',profileId:plan.profileId,productId:plan.productId,setId:row.photoSetId,images:record.assets.map(asset=>({id:asset.imageId,source:'local',sha256:asset.sha256})),listings:[],preparationId:record.id,localProductId:row.id},previousPreparations=engine.db.localPhotoPreparations,previousClaims=engine.db.claims;
 engine.db.localPhotoPreparations=[...(previousPreparations||[]),record];engine.db.claims=[...previousClaims,claim];try{engine.persist();}catch(error){engine.db.localPhotoPreparations=previousPreparations;engine.db.claims=previousClaims;throw error;}checkpoint(signal,guard);engine.emit();return readLocalPreparedPhotos(engine,planId);
}
function localClaimBinding(db,plan,claim){
 ensure(plan.source==='local'&&claim?.source==='local','本地商品来源与照片来源不一致');const record=(db.localPhotoPreparations||[]).filter(row=>row.planId===plan.id&&row.claimId===claim.id);ensure(record.length===1,'本地照片准备与刊登无法唯一关联');const checked=validatePreparation(db,record[0]);ensure(checked.claim===claim,'本地照片领取引用已改变');return checked;
}
// Both native selection and explicitly requested supplier originals create the
// same one-use staging capability. Only main can supply the bytes or provenance.
async function stagePhotoImport(engine,{productId=null,inputs,readBytes,normalizeImage,signal,guard,origin}){
 ensure(Array.isArray(inputs)&&inputs.length>0&&inputs.length<=20,'请一次选择 1–20 张不同的图片');
 const setId='local-set-'+randomUUID(),dir=directory(engine,setId,true),assets=[];let total=0;
 for(let index=0;index<inputs.length;index++){
  checkpoint(signal,guard);const original=await readBytes(inputs[index]);checkpoint(signal,guard);ensure(Buffer.isBuffer(original)&&original.length>0&&original.length<=MAX_SOURCE_BYTES,'请选择不超过 20 MiB 的有效原图');total+=original.length;ensure(total<=100*1024*1024,'本次图片总大小不能超过 100 MiB');
  const converted=await normalizeImage(original);checkpoint(signal,guard);ensure(object(converted)&&Buffer.isBuffer(converted.bytes),'图片无法转换为受支持的 JPEG');const size=require('./commerce-photos.cjs').jpegSize(converted.bytes);ensure(size.width===converted.width&&size.height===converted.height,'图片解码尺寸不一致');const sha256=hash(converted.bytes);ensure(!assets.some(asset=>asset.sha256===sha256),'不能导入重复图片');
  const asset={index,imageId:'local-image-'+sha256,sha256,size:converted.bytes.length,...size,fileName:String(index).padStart(2,'0')+'-'+sha256+'.jpg'},output=path.join(dir,asset.fileName),handle=fs.openSync(output,'wx',0o600);try{fs.writeFileSync(handle,converted.bytes);fs.fsyncSync(handle);}finally{fs.closeSync(handle);}assets.push(asset);
 }
 checkpoint(signal,guard);if(origin)supplierOrigin(origin);let tokens=imports.get(engine);if(!tokens){tokens=new Map();imports.set(engine,tokens);}const photoToken=randomUUID();tokens.set(photoToken,{productId,setId,assets,expiresAt:Date.now()+IMPORT_MS,...(origin?{origin:copy(origin)}:{})});return {photoToken,count:assets.length,photos:assets.map(({index,width,height,size})=>({index,width,height,size}))};
}
function readNativePhoto(file){
 ensure(typeof file==='string'&&path.isAbsolute(file)&&!file.includes('\0'),'本机图片路径无效');const before=fs.lstatSync(file);ensure(before.isFile()&&!before.isSymbolicLink()&&before.size>0&&before.size<=MAX_SOURCE_BYTES,'请选择不超过 20 MiB 的普通图片文件');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const info=fs.fstatSync(fd);ensure(info.isFile()&&info.dev===before.dev&&info.ino===before.ino&&info.size===before.size,'选择后的原图片已经改变');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
function supplierOriginal(image,baseURL){
 const message='货盘未提供可读取的鉴权原图；缩略图不能作为原图导入',code='SUPPLIER_PHOTO_SOURCE';ensure(object(image)&&typeof image.url==='string'&&!!image.url&&!/[\\\x00-\x20\x7f]/.test(image.url)&&!image.url.startsWith('//')&&!/%(?:2e|2f|5c|25)/i.test(image.url.split(/[?#]/,1)[0])&&!/(?:^|\/)\.{1,2}(?:\/|$)/.test(image.url.split(/[?#]/,1)[0]),message,code);
 const base=new URL(baseURL);let url;try{url=/^https?:\/\//i.test(image.url)?new URL(image.url):image.url.startsWith(base.pathname+'/')?new URL(image.url,base.origin):new URL(image.url.replace(/^\//,''),base.href+'/');}catch{ensure(false,message,code);}
 const prefix=base.pathname+'/photos/images/';ensure(url.origin===base.origin&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname.startsWith(prefix),message,code);const part=url.pathname.slice(prefix.length);let imageId;try{imageId=decodeURIComponent(part);}catch{ensure(false,message,code);}ensure(id(imageId)&&!imageId.includes('/')&&part&&!part.includes('/')&&(image.id===undefined||String(image.id)===imageId),message,code);return {id:imageId,url:url.href};
}
function supplierRead(work,signal){
 checkpoint(signal);const controller=new AbortController();let timer,onAbort;
 const stopped=()=>Object.assign(Error('货盘原图导入已停止，未创建照片领取'),{code:'STOPPED'});
 const pending=new Promise((_,reject)=>{onAbort=()=>{controller.abort();reject(stopped());};signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('货盘原图读取超时，请稍后重新选择'),{code:'SUPPLIER_PHOTO_TIMEOUT'}));},30000);});
 return Promise.race([Promise.resolve().then(()=>{checkpoint(signal);return work(controller.signal);}),pending]).catch(error=>{if([401,403].includes(error?.status))ensure(false,'货盘未开放这套原图读取，请检查当前密钥权限','SUPPLIER_PHOTO_FORBIDDEN');throw error;}).finally(()=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);});
}
function createLocalProductService({selectFiles,normalizeImage}={}){
 ensure(typeof selectFiles==='function'&&typeof normalizeImage==='function','本地商品文件选择器或图片解码器未配置');
 return {
  importPhotos:(engine,options={})=>engine.configure(async(signal,guard)=>{
   ensure(object(options)&&Object.keys(options).every(key=>key==='productId'),'只能由本机文件选择器导入照片');const productId=options.productId??null;
   if(productId!==null)ensure((engine.db.localProducts||[]).filter(row=>row.id===productId).length===1,'本地商品不存在');checkpoint(signal,guard);
   const selected=await selectFiles();checkpoint(signal,guard);const paths=Array.isArray(selected)?selected:selected?.canceled?[]:selected?.filePaths;
   ensure(Array.isArray(paths),'本机文件选择结果无效');if(!paths.length)return {cancelled:true,photoToken:'',count:0,photos:[]};ensure(paths.length<=20&&new Set(paths).size===paths.length,'请一次选择 1–20 张不同的图片');
   return stagePhotoImport(engine,{productId,inputs:paths,readBytes:readNativePhoto,normalizeImage,signal,guard});
  }),
  importSupplierPhotos:(engine,input)=>engine.configure(async(signal,configGuard)=>{
   ensure(object(input)&&Object.keys(input).length===2&&Object.keys(input).every(key=>['productId','setId'].includes(key))&&supplierId(input.productId)&&supplierId(input.setId),'请选择货盘商品与图片套组');
   const {productId,setId}=input,products=engine.db.products.filter(row=>row.id===productId),cached=products[0];ensure(products.length===1&&typeof cached.sku==='string'&&cached.sku.trim(),'货盘商品尚未同步或 SKU 不明确','SUPPLIER_PHOTO_PRODUCT');
   const baseURL=normalizeBaseURL(engine.db.settings.baseURL),supplierAccountId=engine.db.supplierAccountId,sku=cached.sku;ensure(id(supplierAccountId)&&engine.db.settings.baseURL===baseURL,'请先连接并核对货盘账号','SUPPLIER_PHOTO_ACCOUNT');
   const guard=()=>{checkpoint(signal,configGuard);ensure(!engine.faulted&&!engine.storageFaulted?.()&&engine.db.settings.baseURL===baseURL&&engine.db.supplierAccountId===supplierAccountId&&engine.db.products.filter(row=>row.id===productId).length===1&&engine.db.products.find(row=>row.id===productId).sku===sku,'读取期间货盘账号或商品 SKU 已改变，未采用原图','SUPPLIER_PHOTO_CHANGED');};guard();
   const client=engine.client(),read=async work=>{guard();const result=await supplierRead(work,signal);guard();return result;},me=await read(s=>client.me({signal:s}));ensure(engine.accountIdentity(me)===supplierAccountId,'当前密钥不属于已连接的货盘账号','SUPPLIER_PHOTO_ACCOUNT');
   const response=await read(s=>client.product(productId,{signal:s})),product=response?.product??response;ensure(object(product)&&String(product.id)===productId&&product.sku===sku,'货盘商品编号或 SKU 已改变，未采用原图','SUPPLIER_PHOTO_PRODUCT');
   const detail=await read(s=>client.photoSet(setId,{signal:s})),set=detail?.set??detail;ensure(object(set)&&String(set.id)===setId&&(set.productId!==undefined||set.product_id!==undefined)&&[set.productId,set.product_id].filter(value=>value!==undefined).every(value=>String(value)===productId),'图片套组不属于当前货盘商品','SUPPLIER_PHOTO_SET');
   ensure(Array.isArray(set.images)&&set.images.length>0&&set.images.length<=20,'货盘未开放这套原图读取；请在货盘授权原图后重新选择','SUPPLIER_PHOTO_SOURCE');const images=set.images.map(image=>supplierOriginal(image,baseURL));ensure(new Set(images.map(image=>image.id)).size===images.length&&new Set(images.map(image=>image.url)).size===images.length&&[set.imageCount,set.image_count].filter(value=>value!==undefined).every(value=>value===images.length),'货盘原图编号、顺序或数量无法核对','SUPPLIER_PHOTO_SOURCE');
   const status=set.status??(set.claim?'claimed':'unknown'),origin={kind:'supplier-reuse',baseURL,supplierAccountId,productId,setId,sku,status,importedAt:stamp()};supplierOrigin(origin);
   const templates=engine.db.productListings.filter(row=>row.productId===productId);ensure(templates.length<=1&&templates.every(row=>row.sku===sku),'商品资料与货盘 SKU 已改变，请重新核对','SUPPLIER_PHOTO_PRODUCT');const template=copy(templates[0]||{}),stock=product.stock??product.stock_quantity,name=text(String(product.name||cached.name||sku).trim(),'货盘商品名称');
   const suggested={name,stock:Number.isSafeInteger(stock)&&stock>=0&&stock<=100000000?stock:null,sku,listing:normalizeListing(template.listing),listingPriceCents:template.listingPriceCents??null,minOfferCents:template.minOfferCents??null};
   const staged=await stagePhotoImport(engine,{inputs:images,readBytes:image=>read(s=>client.download(image.url,{signal:s,maxBytes:MAX_SOURCE_BYTES})),normalizeImage,signal,guard,origin});guard();return {...staged,product:suggested,source:{setId,status,productId,sku}};
  }),
  saveManualProduct:(engine,input)=>{
   guardEngine(engine);ensure(object(input)&&input.origin===undefined,'本地商品格式无效或包含非本机来源信息');const previous=input.id?(engine.db.localProducts||[]).find(row=>row.id===input.id):null;ensure(!input.id||previous,'本地商品不存在');
   ensure(typeof input.name==='string','商品名称必须是文字');const name=text(input.name.trim(),'商品名称'),stock=input.stock??previous?.stock??1;ensure(Number.isSafeInteger(stock)&&stock>=0&&stock<=100000000,'本地库存须为非负整数');
   if(input.sku!==undefined)ensure(previous&&input.sku===previous.sku,'本地 SKU 由系统保存，不能自行更换');
   const listing=normalizeListing(input.listing),price=value=>value===undefined||value===null||value===''?null:(ensure(Number.isSafeInteger(value)&&value>0&&value<=100000000,'本地商品价格须为正整数欧分'),value),listingPriceCents=price(input.listingPriceCents),minOfferCents=price(input.minOfferCents);ensure(minOfferCents===null||listingPriceCents!==null&&minOfferCents<=listingPriceCents,'最低接受价须有售价且不能高于售价');
   const pending=input.photoToken?imports.get(engine)?.get(input.photoToken):null;if(input.photoToken)ensure(pending&&pending.expiresAt>Date.now()&&pending.productId===(previous?.id||null),'照片选择已过期或不属于当前商品，请重新选择');
   if(pending&&previous){const plans=engine.db.plans.filter(plan=>plan.productId===previous.id);ensure(!plans.length||firstPhotosForDraftPlans(engine.db,previous,plans),'商品已有上架计划，不能替换原照片；仅无历史的停用草稿可首次补图，其他情况请新建商品');}
   const at=stamp(),origin=pending?pending.origin:previous?.origin,row={id:previous?.id||'local-'+randomUUID(),source:'local',sku:previous?.sku||'LOCAL-'+randomUUID(),name,stock,revision:(previous?.revision||0)+1,photoSetId:pending?.setId||previous?.photoSetId||null,photos:copy(pending?.assets||previous?.photos||[]),createdAt:previous?.createdAt||at,updatedAt:at,...(origin?{origin:copy(origin)}:{})};productRow(row);if(row.photos.length)row.photos.forEach((asset,index)=>readFile(engine,row.photoSetId,asset,index));
   const oldTemplate=(engine.db.productListings||[]).find(template=>template.productId===row.id),template={productId:row.id,sku:row.sku,listing,listingPriceCents,minOfferCents,createdAt:oldTemplate?.createdAt||at,updatedAt:at},oldProducts=engine.db.localProducts,oldTemplates=engine.db.productListings;
   engine.db.localProducts=previous?oldProducts.map(product=>product===previous?row:product):[...(oldProducts||[]),row];engine.db.productListings=oldTemplate?oldTemplates.map(item=>item===oldTemplate?template:item):[...(oldTemplates||[]),template];
   try{engine.persist();}catch(error){engine.db.localProducts=oldProducts;engine.db.productListings=oldTemplates;throw error;}if(input.photoToken)imports.get(engine).delete(input.photoToken);engine.emit();return {product:localProductDTO(row,template),listing:{...copy(template),missingFields:missingListingFields(listing)}};
  }
 };
}
module.exports={createLocalProductService,restoreLocalProducts,localProductDTO,localCatalog,getLocalProduct,prepareLocalPhotos,readLocalPreparedPhotos,summarizeLocalPreparation,localClaimBinding,MAX_SOURCE_BYTES};
