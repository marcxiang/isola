'use strict';
const {normalizeProduct,normalizeSet}=require('./commerce-engine.cjs');
const {normalizeListing}=require('./listing-config.cjs');
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
 const plan=engine.plan(planId),client=engine.client();
 const response=await bounded(requestSignal=>client.product(plan.productId,{signal:requestSignal}),signal);checkpoint(signal,guard);
 if(!validObject(response))throw Error('货盘商品返回格式需要核对');
 const raw=Object.hasOwn(response,'product')?response.product:response;
 if(!validObject(raw))throw Error('货盘商品详情返回格式需要核对');
 const product=normalizeProduct(raw);
 if(product.id!==plan.productId||product.sku!==plan.sku)throw Error('货盘商品编号或 SKU 与计划不一致，不能填写页面');
 const sets=[];for(let page=1;page<=100;page++){const data=await bounded(requestSignal=>client.photoSets({productId:plan.productId,page,pageSize:100},{signal:requestSignal}),signal);checkpoint(signal,guard);if(!validObject(data)||!Array.isArray(data.sets))throw Error('图片套组返回格式需要核对');for(const s of data.sets){if(!validObject(s))throw Error('图片套组记录格式需要核对');const normalized=normalizeSet(s);if(!normalized.id||normalized.productId!==plan.productId)throw Error('图片套组所属商品与计划不一致');sets.push(normalized);}if(data.sets.length<100||Number.isSafeInteger(data.total)&&data.total>=0&&sets.length>=data.total)break;if(page===100)throw Error('图片套组超过本次核对上限');}
 let page=null,pageError='',pageURL=null;
 try{
  const inspected=await bounded(requestSignal=>engine.adapter.inspect(plan.profileId,{signal:requestSignal}),signal);
  if(!validObject(inspected)||typeof inspected.url!=='string')throw Error('页面地址或检查结果格式无效，请重新读取页面');
  try{pageURL=new URL(inspected.url);}catch{throw Error('页面地址格式无效，请重新读取页面');}
  page=inspected;
 }catch(e){if(signal?.aborted||e?.code==='STOPPED')throw stopped();pageError=safeText(e?.message)||'读取刊登页面失败，请重新读取页面';}
 checkpoint(signal,guard);
 const listing=listingFor(plan,raw),availableCount=sets.filter(s=>s.claimStatus==='available').length,ownCount=new Set(engine.db.claims.filter(c=>reusableClaim(c,plan,engine.db.settings.baseURL)).map(c=>c.id)).size;
 const checks=[],missing=[];const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});if(!ok)missing.push(detail);};
 check('货盘商品',true,product.sku+' · '+product.name);
 check('库存',product.stock!==null&&product.stock>0,product.stock===null?'库存字段未知':product.stock>0?'库存 '+product.stock+' 件':'商品缺货');
 check('图片套组',availableCount+ownCount>0,availableCount+ownCount>0?'可领取 '+availableCount+' 套；本环境已领取 '+ownCount+' 套':'没有可领取或本环境已领取的图片套组');
 check('商品标题',!!listing.title,listing.title||'请填写准确的商品标题');
 check('商品描述',!!listing.description,listing.description||'货盘未提供描述，请在计划中填写真实商品描述');
 check('Vinted 分类',listing.categoryPath.length>0,listing.categoryPath.join(' / ')||'请填写 Vinted 法语分类路径');
 check('成色',!!listing.condition,listing.condition||'请确认商品成色（例如 Très bon état）');
 check('品牌',!!listing.brand,listing.brand||'请确认商品品牌；没有品牌也需要明确选择');
 check('包裹规格',!!listing.parcel,listing.parcel||'请确认包裹规格 Petit / Moyen / Grand');
 const pageOK=!!pageURL&&pageURL.origin==='https://www.vinted.fr'&&!pageURL.username&&!pageURL.password&&pageURL.pathname==='/items/new'&&!pageURL.search&&!pageURL.hash;
 check('法国站刊登页',pageOK,pageError||(pageOK?'已打开法国站刊登表单':'请打开对应环境的 Vinted 刊登页面'));
 check('真实发布能力',false,'照片上传、发布回执和订单步骤尚未验证；本次仅核对或填写字段');
 checkpoint(signal,guard);
 const index=engine.db.products.findIndex(p=>p.id===product.id);if(index>=0)engine.db.products[index]=product;
 engine.db.photoSets=engine.db.photoSets.filter(s=>s.productId!==product.id).concat(sets);engine.persist();engine.emit();
 const fields=Array.isArray(page?.fields)?page.fields:Array.isArray(page?.controls)?page.controls:[];
 return {planId,checkedAt:new Date().toISOString(),product,photos:{availableCount,ownCount,totalCount:sets.length},page:page?{url:page.url,title:page.title,fields,accountLabel:page.accountLabel||''}:null,checks,missing,readyForFields:!!pageOK&&!!listing.title&&!!listing.description&&product.stock>0,supplierFields:Object.keys(raw).filter(k=>/^[A-Za-z0-9_]{1,80}$/.test(k)).slice(0,80),supplierFacts:supplierFacts(raw),listing};
}
function preflight(engine,planId){return engine.configure((signal,guard)=>collect(engine,planId,signal,guard));}
function prepareDraft(engine,planId,{beforeFields}={}){return engine.configure(async(signal,guard)=>{const report=await collect(engine,planId,signal,guard);checkpoint(signal,guard);if(!report.readyForFields)return {filled:[],missing:report.missing,unresolved:[],draftComplete:false,published:false,saved:false,preflight:report};const plan=engine.plan(planId);if(beforeFields)await beforeFields(plan);checkpoint(signal,guard);const result=await bounded(requestSignal=>engine.adapter.prepareFields(plan.profileId,report.listing,{signal:requestSignal}),signal,{timeoutMs:FIELD_TIMEOUT_MS,code:'FIELD_TIMEOUT',message:'填写页面字段超时，页面可能已变化，请重新读取并核对；未确认保存或发布'});checkpoint(signal,guard);if(!validObject(result)||!Array.isArray(result.filled)||result.published!==false||result.saved!==false)throw Error('字段填写结果格式无法核对，请重新读取页面');engine.event('info',plan.sku+'：已填写 '+result.filled.length+' 项页面字段，未保存或发布');engine.persist();engine.emit();return {...result,draftComplete:false,published:false,saved:false,preflight:report};});}
module.exports={preflight,prepareDraft,collect,listingFor,supplierFacts,READ_TIMEOUT_MS,FIELD_TIMEOUT_MS};
