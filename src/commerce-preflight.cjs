'use strict';
const {normalizeProduct,normalizeSet}=require('./commerce-engine.cjs');
const {normalizeListing,missingListingFields}=require('./listing-config.cjs');
const READ_TIMEOUT_MS=30000,FIELD_TIMEOUT_MS=120000;

function safeText(value,max=2000){return typeof value==='string'?value.trim().slice(0,max):'';}
function supplierFacts(raw){return {description:safeText(raw.description),variant:safeText(raw.variant,200),brand:safeText(raw.brand,100),condition:safeText(raw.condition,100)};}
function listingFor(plan,raw){const listing=normalizeListing(plan.listing);return {...listing,title:listing.title||safeText(raw.name,100),description:listing.description||safeText(raw.description),priceCents:plan.listingPriceCents};}
function failure(code,message){const error=Error(message);error.code=code;return error;}
function stopped(){return failure('STOPPED','操作已停止，未提交过期的刊登核对结果');}
function checkpoint(signal,guard){if(signal?.aborted)throw stopped();guard();}
function bounded(work,signal,{timeoutMs=READ_TIMEOUT_MS,code='READ_TIMEOUT',message='读取服务或页面超时，请稍后重新核对'}={}){
 if(signal?.aborted)return Promise.reject(stopped());
 const controller=new AbortController();
 return new Promise((resolve,reject)=>{
  let settled=false,timer;
  const finish=(callback,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);callback(value);};
  const onAbort=()=>{controller.abort();finish(reject,stopped());};
  signal?.addEventListener('abort',onAbort,{once:true});
  timer=setTimeout(()=>{controller.abort();finish(reject,failure(code,message));},timeoutMs);
  // Discard late results even when a transport or page adapter ignores cancellation.
  Promise.resolve().then(()=>{if(controller.signal.aborted)throw stopped();return work(controller.signal);}).then(value=>finish(resolve,value),error=>finish(reject,error));
 });
}
function validObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function reusableClaim(claim,plan,baseURL){
 if(!claim||claim.profileId!==plan.profileId||claim.productId!==plan.productId||!safeText(claim.id)||!safeText(claim.setId)||!Array.isArray(claim.listings)||plan.reuseOwnPhotos===false&&claim.listings.length>0)return false;
 if(!Array.isArray(claim.images)||claim.images.length<1||claim.images.length>20)return false;
 try{const base=new URL(baseURL);return claim.images.every(image=>{
  if(typeof image?.url!=='string'||!image.url.trim()||/[\\\x00-\x20\x7f]/.test(image.url)||image.url.startsWith('//')||/%(?:2e|2f|5c|25)/i.test(image.url.split(/[?#]/,1)[0]))return false;
  const value=/^https?:\/\//i.test(image.url)?new URL(image.url):image.url.startsWith(base.pathname.replace(/\/$/,'')+'/')?new URL(image.url,base.origin):new URL(image.url.replace(/^\//,''),base.href.replace(/\/$/,'')+'/');
  return value.origin===base.origin&&!value.username&&!value.password&&!value.hash&&value.pathname.startsWith(base.pathname.replace(/\/$/,'')+'/');
 });}catch{return false;}
}
async function collect(engine,planId,signal,guard){
 checkpoint(signal,guard);
 const plan=engine.plan(planId),local=plan.source==='local',sets=[];let raw,product,localPrepared=null;
 if(local){
  const photos=require('./commerce-local-products.cjs');product=photos.getLocalProduct(engine,plan);raw=product;localPrepared=photos.readLocalPreparedPhotos(engine,planId);
 }else{
  const client=await engine.client(signal);checkpoint(signal,guard);const response=await bounded(requestSignal=>client.product(plan.productId,{signal:requestSignal}),signal);checkpoint(signal,guard);
  if(!validObject(response))throw Error('货盘商品返回格式需要核对');
  raw=Object.hasOwn(response,'product')?response.product:response;
  if(!validObject(raw))throw Error('货盘商品详情返回格式需要核对');
  product=normalizeProduct(raw);
  if(product.id!==plan.productId||product.sku!==plan.sku)throw Error('货盘商品编号或 SKU 与计划不一致，不能填写页面');
  for(let page=1;page<=100;page++){const data=await bounded(requestSignal=>client.photoSets({productId:plan.productId,page,pageSize:100},{signal:requestSignal}),signal);checkpoint(signal,guard);if(!validObject(data)||!Array.isArray(data.sets))throw Error('图片套组返回格式需要核对');for(const s of data.sets){if(!validObject(s))throw Error('图片套组记录格式需要核对');const normalized=normalizeSet(s);if(!normalized.id||normalized.productId!==plan.productId)throw Error('图片套组所属商品与计划不一致');sets.push(normalized);}if(data.sets.length<100||Number.isSafeInteger(data.total)&&data.total>=0&&sets.length>=data.total)break;if(page===100)throw Error('图片套组超过本次核对上限');}
 }
 let page=null,pageError='',pageURL=null;
 try{
  const inspected=await bounded(requestSignal=>engine.adapter.inspect(plan.profileId,{signal:requestSignal}),signal);
  if(!validObject(inspected)||typeof inspected.url!=='string')throw Error('页面地址或检查结果格式无效，请重新读取页面');
  try{pageURL=new URL(inspected.url);}catch{throw Error('页面地址格式无效，请重新读取页面');}
  page=inspected;
 }catch(e){if(signal?.aborted||e?.code==='STOPPED')throw stopped();pageError=safeText(e?.message)||'读取刊登页面失败，请重新读取页面';}
 checkpoint(signal,guard);
 const listing=local?{...normalizeListing(plan.listing),priceCents:plan.listingPriceCents}:listingFor(plan,raw),availableCount=local?0:sets.filter(s=>s.claimStatus==='available').length;
 const localClaim=local&&localPrepared.manifest?engine.db.claims.find(claim=>claim.id===localPrepared.manifest.claimId):null;
 const ownCount=local?(localPrepared.summary?.ready&&localPrepared.manifest&&(plan.reuseOwnPhotos!==false||localClaim?.listings.length===0)?1:0):new Set(engine.db.claims.filter(c=>reusableClaim(c,plan,engine.db.settings.baseURL)).map(c=>c.id)).size;
 const checks=[],missing=[];const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});if(!ok)missing.push(detail);};
 check(local?'本地商品':'货盘商品',true,product.sku+' · '+product.name);
 check('库存',product.stock!==null&&product.stock>0,product.stock===null?'库存字段未知':product.stock>0?'库存 '+product.stock+' 件':'商品缺货');
 if(local)check('本地照片',ownCount>0,ownCount?'本环境已核对 '+localPrepared.manifest.count+' 张本地照片；未领取货盘图片':localPrepared.summary?.error||(plan.reuseOwnPhotos===false&&localClaim?.listings.length?'原照片已有刊登记录，计划禁止复用':product.localPhotoCount?'已导入 '+product.localPhotoCount+' 张本地照片；请先准备并核对本计划照片':'请先为本地商品导入照片'));
 else check('图片套组',availableCount+ownCount>0,availableCount+ownCount>0?'可领取 '+availableCount+' 套；本环境已领取 '+ownCount+' 套':'没有可领取或本环境已领取的图片套组');
 check('商品标题',!!listing.title,listing.title||'请填写准确的商品标题');
 check('商品描述',!!listing.description,listing.description||(local?'请在计划中填写真实商品描述':'货盘未提供描述，请在计划中填写真实商品描述'));
 check('Vinted 分类',listing.categoryPath.length>0,listing.categoryPath.join(' / ')||'请填写 Vinted 法语分类路径');
 check('成色',!!listing.condition,listing.condition||'请确认商品成色（例如 Très bon état）');
 check('品牌',!!listing.brand,listing.brand||'请确认商品品牌；没有品牌也需要明确选择');
 check('包裹规格',!!listing.parcel,listing.parcel||'请确认包裹规格 Petit / Moyen / Grand');
 const pageOK=!!pageURL&&pageURL.origin==='https://www.vinted.fr'&&!pageURL.username&&!pageURL.password&&pageURL.pathname==='/items/new'&&!pageURL.search&&!pageURL.hash;
 check('法国站刊登页',pageOK,pageError||(pageOK?'已打开法国站刊登表单':'请打开对应环境的 Vinted 刊登页面'));
 check('真实发布能力',false,'自动发布回执和订单步骤尚未验证；照片上传请查看独立的图片回执，本次仅核对或填写字段');
 checkpoint(signal,guard);
 if(!local){const index=engine.db.products.findIndex(p=>p.id===product.id);if(index>=0)engine.db.products[index]=product;engine.db.photoSets=engine.db.photoSets.filter(s=>s.productId!==product.id).concat(sets);engine.persist();engine.emit();}
 const fields=Array.isArray(page?.fields)?page.fields:Array.isArray(page?.controls)?page.controls:[];
 return {planId,checkedAt:new Date().toISOString(),product,photos:local?{source:'local',availableCount:0,ownCount,totalCount:product.localPhotoCount?1:0,importedCount:product.localPhotoCount,ready:ownCount>0}:{availableCount,ownCount,totalCount:sets.length},page:page?{url:page.url,title:page.title,fields,accountLabel:page.accountLabel||''}:null,checks,missing,readyForFields:!!pageOK&&!!listing.title&&!!listing.description&&product.stock>0,supplierFields:local?[]:Object.keys(raw).filter(k=>/^[A-Za-z0-9_]{1,80}$/.test(k)).slice(0,80),supplierFacts:local?{}:supplierFacts(raw),listing};
}
function preflight(engine,planId){return engine.configure((signal,guard)=>collect(engine,planId,signal,guard));}
// A manual form fill is reversible preparation of confirmed saved fields. It
// does not authenticate the supplier, refresh stock, acquire photos or authorize
// publication. The live preflight and publication service retain those checks.
async function collectSavedDraft(engine,planId,signal,guard){
 checkpoint(signal,guard);const plan=engine.plan(planId);
 const products=engine.db.products.filter(row=>row?.id===plan.productId),cached=products[0];
 if(engine.db.plans.filter(row=>row.id===planId).length!==1||plan.source!==undefined&&plan.source!=='supplier'||!safeText(plan.productId,256)||safeText(plan.productId,256)!==plan.productId||!safeText(plan.sku,256)||safeText(plan.sku,256)!==plan.sku||products.length!==1||!validObject(cached)||cached.source!==undefined&&cached.source!=='supplier'||cached.sku!==plan.sku||engine.db.products.filter(row=>row?.sku===plan.sku).length!==1||(engine.db.localProducts||[]).some(row=>row?.id===plan.productId||row?.sku===plan.sku))throw failure('PRODUCT_MISMATCH','保存的货盘商品编号或 SKU 缺失、重复或与计划不一致，请同步并核对原商品；未填写页面');
 if(engine.profiles().filter(row=>row.id===plan.profileId).length!==1)throw failure('PROFILE_MISSING','计划的固定环境不存在或不唯一，未填写页面');
 const planBefore=JSON.stringify(plan),productBefore=JSON.stringify(cached),check=()=>{
  checkpoint(signal,guard);
  if(engine.plan(planId)!==plan||JSON.stringify(plan)!==planBefore||engine.db.plans.filter(row=>row.id===planId).length!==1||engine.db.products.filter(row=>row?.id===plan.productId).length!==1||engine.db.products.find(row=>row?.id===plan.productId)!==cached||JSON.stringify(cached)!==productBefore||engine.db.products.filter(row=>row?.sku===plan.sku).length!==1||(engine.db.localProducts||[]).some(row=>row?.id===plan.productId||row?.sku===plan.sku)||engine.profiles().filter(row=>row.id===plan.profileId).length!==1)throw failure('PLAN_CHANGED','填写期间保存的计划、商品或环境已改变，已停止');
 };
 const listing={...normalizeListing(plan.listing),priceCents:plan.listingPriceCents},missingFields=missingListingFields(listing),product=normalizeProduct(cached),stockOK=Number.isSafeInteger(cached.stock)&&cached.stock>0;
 let page=null,pageURL=null,pageError='';
 try{const inspected=await bounded(requestSignal=>engine.adapter.inspect(plan.profileId,{signal:requestSignal}),signal);if(!validObject(inspected)||typeof inspected.url!=='string')throw Error('页面地址或检查结果格式无效，请重新读取页面');try{pageURL=new URL(inspected.url);}catch{throw Error('页面地址格式无效，请重新读取页面');}page=inspected;}
 catch(error){if(signal?.aborted||error?.code==='STOPPED')throw stopped();pageError=safeText(error?.message)||'读取刊登页面失败，请重新读取页面';}
 check();const checks=[],missing=[],add=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});if(!ok)missing.push(detail);},labels={title:'商品标题',description:'商品描述',categoryPath:'Vinted 分类',condition:'成色',brand:'品牌',color:'颜色',parcel:'包裹规格'};
 add('缓存商品身份',true,product.sku+' · '+product.name);
 add('缓存库存',stockOK,stockOK?'保存的库存为 '+cached.stock+' 件；未实时核对货盘':cached.stock===0?'保存的库存为零，请先同步并核对库存':'保存的库存未知或无效，请先同步并核对库存');
 for(const key of Object.keys(labels))add(labels[key],!missingFields.includes(key),missingFields.includes(key)?'请先在计划中明确确认'+labels[key]:key==='categoryPath'?listing.categoryPath.join(' / '):listing[key]);
 const priceOK=plan.currency==='EUR'&&Number.isSafeInteger(listing.priceCents)&&listing.priceCents>0&&listing.priceCents<=100000000,parcelOK=['Petit','Moyen','Grand'].includes(listing.parcel);
 add('售价',priceOK,priceOK?'使用计划中已确认的欧元售价':'售价必须为已保存的有效欧元金额');
 add('包裹选项',parcelOK,parcelOK?'使用计划中已确认的 '+listing.parcel+' 包裹':'请在计划中确认 Petit / Moyen / Grand 包裹规格');
 const pageOK=!!pageURL&&pageURL.origin==='https://www.vinted.fr'&&!pageURL.username&&!pageURL.password&&pageURL.pathname==='/items/new'&&!pageURL.search&&!pageURL.hash;
 add('法国站刊登页',pageOK,pageError||(pageOK?'已打开法国站刊登表单':'请打开对应环境的 Vinted 刊登页面'));
 const message='本次按已保存的计划资料离线准备页面，未读取货盘 API 密钥，未实时核对货盘库存或照片；商品尚未发布。发布前仍须通过实时商品、库存和照片检查。';
 checks.push({name:'货盘实时核对',ok:false,detail:'本次未执行；缓存库存不代表当前可售库存'},{name:'发布权限',ok:false,detail:'本次仅填写页面，不保存草稿或发布商品'});
 return {check,report:{planId,checkedAt:new Date().toISOString(),mode:'saved-plan',supplierVerified:false,stockVerified:false,readyForPublication:false,publicationEnabled:false,product,photos:{source:'not-checked',availableCount:null,ownCount:null,totalCount:null,ready:false},page:page?{url:page.url,title:page.title,fields:Array.isArray(page.fields)?page.fields:Array.isArray(page.controls)?page.controls:[],accountLabel:page.accountLabel||''}:null,checks,missing,readyForFields:missing.length===0,supplierFields:[],supplierFacts:{},listing,message}};
}
function prepareDraft(engine,planId,{beforeFields}={}){return engine.configure(async(signal,guard)=>{
 const saved=engine.plan(planId).source!=='local',preparation=saved?await collectSavedDraft(engine,planId,signal,guard):{report:await collect(engine,planId,signal,guard),check:()=>checkpoint(signal,guard)},report=preparation.report,check=preparation.check;check();
 if(!report.readyForFields)return {filled:[],missing:report.missing,unresolved:[],draftComplete:false,published:false,saved:false,preflight:report,...(saved?{message:report.message}:{})};
 const plan=engine.plan(planId);if(beforeFields)await beforeFields(plan);check();
 const result=await bounded(requestSignal=>engine.adapter.prepareFields(plan.profileId,report.listing,{signal:requestSignal}),signal,{timeoutMs:FIELD_TIMEOUT_MS,code:'FIELD_TIMEOUT',message:'填写页面字段超时，页面可能已变化，请重新读取并核对；未确认保存或发布'});check();
 if(!validObject(result)||!Array.isArray(result.filled)||result.published!==false||result.saved!==false)throw Error('字段填写结果格式无法核对，请重新读取页面');
 engine.event('info',plan.sku+'：已'+(saved?'按保存资料离线':'')+'填写 '+result.filled.length+' 项页面字段，未保存或发布'+(saved?'；未实时核对货盘库存':''));engine.persist();engine.emit();
 return {...result,draftComplete:false,published:false,saved:false,preflight:report,...(saved?{message:report.message+(safeText(result.message)?' '+safeText(result.message):'')}:{})};
});}
module.exports={preflight,prepareDraft,collect,listingFor,supplierFacts,READ_TIMEOUT_MS,FIELD_TIMEOUT_MS};
