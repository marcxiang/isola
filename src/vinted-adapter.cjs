const defaultControl = require('./page-control.cjs');
const {randomUUID}=require('node:crypto');
const {problem} = require('./commerce-engine.cjs');
const {VintedPhotoUpload} = require('./vinted-photo-upload.cjs');
const {rememberCategoryTraversal}=require('./vinted-publication-evidence.cjs');
const {clearOptionalMaterial}=require('./vinted-optional-material.cjs');

const ORIGIN = 'https://www.vinted.fr';
const FORM_URL = ORIGIN + '/items/new';
const FIELD_SPECS = [
  {key:'title',label:'Titre',tags:['input'],labels:['Titre','Dis aux acheteurs ce que tu vends']},
  {key:'description',label:'Description',tags:['textarea'],labels:['Description','Ajoute des informations utiles']}
];
const EXTRA_SPECS = [
  {key:'categoryPath',label:'Catégorie',tags:['input'],labels:['Catégorie','Sélectionne une catégorie']},
  {key:'priceCents',label:'Prix',tags:['input'],labels:['Prix','0,00 €']},
  {key:'condition',label:'État',tags:['input'],labels:['État','Sélectionne un état']},
  {key:'brand',label:'Marque',tags:['input'],labels:['Marque','Sélectionne une marque']},
  {key:'size',label:'Taille',tags:['input'],labels:['Taille','Sélectionne une taille']},
  {key:'color',label:'Couleur',tags:['input'],labels:['Couleur','Sélectionne une couleur','Sélectionne 2 couleurs maximum']}
];
const ALL_SPECS = [...FIELD_SPECS,...EXTRA_SPECS];
const LATER_FIELDS = ['brand','size','color','parcel'];
const CATEGORY_SEARCH='Trouver une catégorie',BRAND_SEARCH='Rechercher une marque';
const normalized = value => String(value || '').replace(/\s+/g,' ').trim();
const matchesSpec=(element,spec)=>!!element&&spec.tags.includes(element.tag)&&(spec.labels.includes(normalized(element.label))||spec.labels.includes(normalized(element.placeholder)));
const euroCents = value => {const text=normalized(value).replace(/ ?€$/, '');return /^\d+(?:[,.]\d{1,2})?$/.test(text)?Math.round(Number(text.replace(',','.'))*100):null;};
const expectedValue = (key,listing,value) => key==='priceCents'?euroCents(value)===listing.priceCents:key==='categoryPath'?normalized(value)===listing.categoryPath?.at(-1):value===listing[key];
const stop = () => problem('STOPPED','页面准备已停止');
const supplied = value => value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);

function frenchPage(value, form = false) {
  let url;
  try { url = new URL(value); } catch { throw problem('WRONG_SITE','请在该窗口打开法国 Vinted 页面'); }
  if (url.origin !== ORIGIN || url.username || url.password) throw problem('WRONG_SITE','只能在 https://www.vinted.fr 上检查和准备商品');
  if (form && (url.pathname !== '/items/new' || url.search || url.hash)) throw problem('WRONG_PAGE','请先在该窗口打开 Vinted 的全新商品发布页，已有草稿页面不会自动跳转或覆盖');
  return url;
}
function validateListing(listing) {
  if (!listing || typeof listing !== 'object' || Array.isArray(listing)) throw problem('INVALID_LISTING','商品准备内容无效');
  const result = {...listing};
  for (const key of ['title','description']) {
    if (!supplied(result[key])) continue;
    const limit = key === 'title' ? 100 : 5000;
    if (typeof result[key] !== 'string' || !result[key].trim() || result[key].length > limit || result[key].includes('\0')) throw problem('INVALID_LISTING',key + ' 无效或过长');
    if (key === 'title' && /[\r\n]/.test(result[key])) throw problem('INVALID_LISTING','商品标题不能包含换行');
  }
  if (supplied(result.priceCents) && (!Number.isSafeInteger(result.priceCents) || result.priceCents < 1 || result.priceCents > 100000000)) throw problem('INVALID_LISTING','售价必须是正整数欧分');
  if (supplied(result.categoryPath) && (!Array.isArray(result.categoryPath) || result.categoryPath.length > 10 || result.categoryPath.some(label => typeof label !== 'string' || !label.trim() || label.length > 180))) throw problem('INVALID_LISTING','分类必须是网页上显示的完整标签路径');
  for (const key of ['condition','brand','size','color','parcel']) if (supplied(result[key]) && (typeof result[key] !== 'string' || !result[key].trim() || result[key].length > 180)) throw problem('INVALID_LISTING',key + ' 必须是网页上显示的选项标签');
  if(supplied(result.parcel)&&!['Petit','Moyen','Grand'].includes(result.parcel))throw problem('INVALID_LISTING','包裹规格必须明确为 Petit、Moyen 或 Grand');
  return result;
}

// The form preparation capability is separate from publication and transaction evidence.
// A successfully filled text box cannot unlock publishing, replies, offers or procurement.
class VintedAdapter {
  constructor({windows,control=defaultControl,isBusy=()=>false,menuWaitMs=3000,pollIntervalMs=100}) {
    this.windows=windows; this.control=control; this.isBusy=isBusy; this.drafts=new Map();this.menuWaitMs=Math.min(3000,Math.max(0,Number(menuWaitMs)||0));this.pollIntervalMs=Math.min(200,Math.max(10,Number(pollIntervalMs)||100));this.photos=new VintedPhotoUpload(this);
  }
  readiness() {
    return {vinted:'unverified',capabilities:{inspect:true,prepareTextFields:true,prepareCategory:true,prepareBrand:true,prepareColor:true,prepareParcel:true,preparePrice:true,inspectPhotos:true,uploadPhotos:true,verifyPhotoReceipt:true,publish:false,messages:false,offers:false,shippingLabel:false,procurement:false},message:'可准备法国站商品字段，检查照片区域，并上传已领取、下载和校验的照片；通过网页完成文案、已加载图片和状态逐项核对回执。其余必填项仍需核对；自动刊登、消息、报价、运单和真实采购尚未启用。'};
  }
  current(profileId,{signal,tab,controller,form=false}={}) {
    try {
    if (signal?.aborted) throw stop();
    const w=this.windows.get(profileId);
    if (!w || w.isDestroyed()) throw problem('WINDOW_CLOSED','请先打开对应浏览器环境');
    if (w.aiAgent?.state?.running || this.isBusy(profileId,w)) throw problem('PAGE_BUSY','该窗口已有 AI 或运营任务，请先停止并等待当前步骤结束');
    if (w.vintedDraftController && w.vintedDraftController !== controller) throw problem('PAGE_BUSY','该窗口正在准备商品，请等待完成');
    const current=w.tabs.find(t=>t.id===w.activeTab);
    if (!current || current.view.webContents.isDestroyed()) throw problem('WINDOW_CLOSED','当前浏览器标签已关闭');
    if (tab && current !== tab) throw problem('TAB_CHANGED','当前标签已切换，商品准备已停止');
    frenchPage(current.view.webContents.getURL(),form);
    return {w,tab:current};
    } catch(error) {controller?.abort(error);throw error;}
  }
  options(signal,guard) {
    return {signal,allowedOrigins:new Set([ORIGIN]),approve:async()=>{throw problem('UNEXPECTED_ACTION','此步骤需要额外确认，自动页面准备已停止');},onProgress:async()=>guard()};
  }
  async read(profileId,{signal,tab,controller,form=false}={}) {
    const context={signal,tab,controller,form},selected=this.current(profileId,context);
    const page=await this.control.checkedSnapshot(selected.tab,this.options(signal,()=>this.current(profileId,context)));
    this.current(profileId,context);frenchPage(page.url,form);
    if(new URL(page.url).pathname==='/items/new'){
      const ids=page.elements.filter(e=>['input','textarea'].includes(e.tag)&&!e.sensitive&&!['password','file','hidden'].includes(e.type)).map(e=>e.id);
      const fields=await this.control.isolated(selected.tab,`(() => {const ids=${JSON.stringify(ids)},fields=[];for(const id of ids){const e=globalThis.__isolaElements?.get(id);if(e?.isConnected&&!['password','file','hidden'].includes(e.type)&&!/password|cc-|one-time-code/.test(e.autocomplete||''))fields.push({id,placeholder:String(e.getAttribute('placeholder')||'').slice(0,180)});}return fields;})()`);
      this.current(profileId,context);
      if(!Array.isArray(fields))throw problem('ELEMENT_STALE','商品字段已改变，请重新读取');
      page.elements=page.elements.map(e=>({...e,placeholder:fields.find(f=>f.id===e.id)?.placeholder||''}));
    }
    return page;
  }
  async inspect(profileId,{signal}={}) {
    const {tab}=this.current(profileId,{signal}),page=await this.read(profileId,{signal,tab});
    let fields=[];
    if(new URL(page.url).pathname==='/items/new'){const state=await this.values(tab,page);this.current(profileId,{signal,tab});fields=ALL_SPECS.flatMap(spec=>{const match=this.field(page,spec,{readOnly:true});if(!match.element)return [];return [{field:spec.key,label:spec.label,value:state.values.find(v=>v.id===match.element.id)?.value??null,readOnly:!!match.element.readOnly}];});}
    const profileLinks=page.elements.filter(e=>e.tag==='a' && /^(?:Profil|Mon profil|Voir mon profil)$/.test(e.label||'')).flatMap(e=>{
      try { const url=frenchPage(e.href);return /^\/member\/\d+(?:-[^/]*)?\/?$/.test(url.pathname)?[{label:e.label,url:url.href}]:[]; } catch { return []; }
    });
    return {url:page.url,title:page.title,pageType:new URL(page.url).pathname==='/items/new'?'new_listing':'other',controls:page.elements.map(e=>({tag:e.tag,role:e.role,label:e.label,disabled:e.disabled,readOnly:e.readOnly,required:e.required,invalid:e.invalid})),fields,account:{verified:false,profileLinks},verified:false,capabilities:this.readiness().capabilities};
  }
  async inspectPhotoControls(profileId,options={}) {return this.photos.inspect(profileId,options);}
  async uploadPhotos(profileId,manifest,options={}) {
    const receipt=await this.photos.upload(profileId,manifest,options);
    if(receipt.verified!==true||options.recheckOnly===true||!this.drafts.has(profileId))return receipt;
    try{return {...receipt,optionalMaterial:await this.clearOptionalMaterial(profileId,{...options,settleEmptyMs:5000})};}
    catch(error){
      if(options.signal?.aborted||error?.code==='STOPPED')throw error;
      const materialFields={title:'标题',description:'描述',categoryPath:'分类',priceCents:'价格',condition:'成色',brand:'品牌',size:'尺码',color:'颜色',unknown:'未识别字段'},knownErrors={PAGE_CHANGED:'商品页已重新加载，未清空可选材质',PAGE_BUSY:'商品页正在被其他操作使用，未清空可选材质',EXISTING_DRAFT:'商品字段或包裹规格与本次准备记录不一致，未清空可选材质'};
      const message=error?.code==='OPTIONAL_MATERIAL_UNVERIFIED'?error.message:error?.code==='EXISTING_DRAFT'&&Object.hasOwn(materialFields,error.materialReason)?'商品'+materialFields[error.materialReason]+'与本次准备记录不一致，未清空可选材质':knownErrors[error?.code]||'可选材质未能完成清空核对，请查看当前页面';
      return {...receipt,optionalMaterial:{verified:false,code:error?.code||'OPTIONAL_MATERIAL_UNVERIFIED',message},message:'照片已上传；可选材质清空未核对：'+message};
    }
  }
  async clearOptionalMaterial(profileId,options={}) {return clearOptionalMaterial(this,profileId,options);}
  field(page,spec,{readOnly=false}={}) {
    const matches=page.elements.filter(e=>matchesSpec(e,spec));
    if (matches.length!==1) return {error:matches.length?'页面出现多个同名控件，请人工核对':'未找到已核对的输入控件'};
    const element=matches[0];
    if (element.disabled || !readOnly && element.readOnly || element.sensitive) return {error:'控件不可编辑'};
    return {element};
  }
  async values(tab,page) {
    // A header's default language/search controls are not existing listing data.
    // Scope the check to the form (or bounded shared content ancestor) of the
    // already observed listing controls, and retain unknown form fields.
    const ids=page.elements.filter(e=>['input','textarea','select'].includes(e.tag) && !e.sensitive && !['password','file','hidden','checkbox','radio','submit','button','reset','search'].includes(e.type)&&![CATEGORY_SEARCH,BRAND_SEARCH].includes(normalized(e.label))).map(e=>e.id);
    const anchorIds=page.elements.filter(e=>ALL_SPECS.some(spec=>matchesSpec(e,spec))&&!e.sensitive).map(e=>e.id);
    const result=await this.control.isolated(tab,`(() => {
      const ids=${JSON.stringify(ids)},anchorIds=${JSON.stringify(anchorIds)},values=[],d=globalThis.__isolaDOM;
      const outside=e=>!!d.closest(e,'header,nav,[role=navigation],[role=search],[role=tablist]');
      const anchors=anchorIds.map(id=>globalThis.__isolaElements?.get(id)).filter(e=>e?.isConnected&&!outside(e));
      const forms=[...new Set(anchors.map(e=>e.form||d.closest(e,'form')).filter(Boolean))];
      let scope=forms.length===1&&anchors.every(e=>e.form===forms[0]||forms[0].contains(e))?forms[0]:null;
      if(!scope&&anchors.length>1)scope=d.parents(anchors[0]).find(p=>!['BODY','HTML'].includes(p.tagName)&&anchors.every(e=>p.contains(e)));
      for(const id of ids){const e=globalThis.__isolaElements?.get(id);if(!e?.isConnected)return {stale:true};if(outside(e)||scope&&!scope.contains(e)&&e.form!==scope||${JSON.stringify([CATEGORY_SEARCH,BRAND_SEARCH])}.includes(e.getAttribute?.('placeholder')))continue;if(['password','file','hidden'].includes(e.type)||/password|cc-|one-time-code/.test(e.autocomplete||''))return {stale:true};values.push({id,value:String(e.value||'')});}
      return {documentKey:String(performance.timeOrigin),values};
    })()`);
    if (!result || result.stale || !Array.isArray(result.values) || typeof result.documentKey!=='string') throw problem('ELEMENT_STALE','商品表单已改变，请重新检查');
    return result;
  }
  async prepareFields(profileId,input,{signal}={}) {
    const listing=validateListing(input),controller=new AbortController(),cancel=()=>controller.abort();
    if (signal?.aborted) throw stop();
    signal?.addEventListener('abort',cancel,{once:true});
    let w,tab,contents,initialNavigation=false;
    const onNavigation=(_event,url,_isInPlace,isMainFrame)=>{if(isMainFrame===false)return;if(!initialNavigation||url!==FORM_URL)controller.abort();};
    const onDestroyed=()=>controller.abort();
    const context={signal:controller.signal,controller,form:true};
    try {
      // An empty tab is the only page that can be replaced automatically.
      w=this.windows.get(profileId);
      if (!w || w.isDestroyed()) throw problem('WINDOW_CLOSED','请先打开对应浏览器环境');
      if (w.aiAgent?.state?.running || w.vintedDraftController || this.isBusy(profileId,w)) throw problem('PAGE_BUSY','该窗口已有 AI 或运营任务，请先停止并等待当前步骤结束');
      tab=w.tabs.find(t=>t.id===w.activeTab);
      if (!tab || tab.view.webContents.isDestroyed()) throw problem('WINDOW_CLOSED','当前浏览器标签已关闭');
      w.vintedDraftController=controller;context.tab=tab;contents=tab.view.webContents;
      contents.on?.('did-start-navigation',onNavigation);contents.on?.('render-process-gone',onDestroyed);contents.on?.('destroyed',onDestroyed);
      if (tab.view.webContents.getURL()==='about:blank') {
        const guardBlank=()=>{try{if(controller.signal.aborted)throw stop();if(w.isDestroyed()||w.tabs.find(t=>t.id===w.activeTab)!==tab||w.aiAgent?.state?.running||this.isBusy(profileId,w))throw problem('PAGE_BUSY','窗口状态已改变，商品准备已停止');const url=contents.getURL();if(url!=='about:blank')frenchPage(url,true);}catch(error){controller.abort();throw error;}};
        initialNavigation=true;
        try{await this.control.performAction(tab,{action:'navigate',url:FORM_URL},{signal:controller.signal,approve:async()=>{controller.abort();throw problem('WRONG_SITE','商品准备不允许跳转到其他网站');},onProgress:guardBlank,navigate:async url=>{guardBlank();if(url!==FORM_URL)throw problem('WRONG_SITE','商品地址无效');await this.navigateEmptyTab(contents,controller,FORM_URL);guardBlank();}});}finally{initialNavigation=false;}
      }
      const guard=()=>this.current(profileId,context),options=this.options(controller.signal,guard);
      guard();
      let page=await this.read(profileId,context),state=await this.values(tab,page);guard();
      let ownership=this.drafts.get(profileId);
      if (!ownership || ownership.tab!==tab || ownership.documentKey!==state.documentKey) ownership=null;
      const existing=state.values.filter(e=>e.value.trim());
      if (existing.some(e=>{
        const descriptor=page.elements.find(d=>d.id===e.id),spec=ALL_SPECS.find(s=>matchesSpec(descriptor,s));
        return !spec || !(ownership?.fields[spec.key]===e.value || supplied(listing[spec.key])&&expectedValue(spec.key,listing,e.value));
      })) throw problem('EXISTING_DRAFT','页面已有填写内容且不属于本次准备，已保留原内容；请使用新的空白商品页');
      ownership=ownership||{tab,documentKey:state.documentKey,fields:{}};this.drafts.set(profileId,ownership);
      const filled=[],missing=[],unresolved=[];let halted=false;
      for(const e of existing){const descriptor=page.elements.find(d=>d.id===e.id),spec=ALL_SPECS.find(s=>matchesSpec(descriptor,s));if(spec)ownership.fields[spec.key]=e.value;}
      for (const spec of FIELD_SPECS) {
        if (!supplied(listing[spec.key])) {missing.push({field:spec.key,label:spec.label,reason:'未提供商品内容'});continue;}
        page=await this.read(profileId,context);
        const match=this.field(page,spec);
        if (match.error) {unresolved.push({field:spec.key,label:spec.label,reason:match.error});continue;}
        state=await this.values(tab,page);guard();
        if (state.documentKey!==ownership.documentKey) throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
        const value=state.values.find(e=>e.id===match.element.id)?.value;
        if (typeof value!=='string') throw problem('ELEMENT_STALE','目标输入框已改变');
        if (value && value!==ownership.fields[spec.key]) throw problem('EXISTING_DRAFT','商品内容被其他操作修改，已停止以保留原内容');
        if (value===listing[spec.key]) {filled.push({field:spec.key,label:spec.label,verified:true,unchanged:true});continue;}
        const after=await this.control.performAction(tab,{action:'type',elementId:match.element.id,text:listing[spec.key]},options);guard();frenchPage(after.url,true);
        if (after.observation?.inputMatched!==true) {unresolved.push({field:spec.key,label:spec.label,reason:'输入后没有得到内容一致的确认，已停止后续填写'});halted=true;break;}
        const verifiedState=await this.values(tab,after);guard();
        if(verifiedState.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
        ownership.fields[spec.key]=listing[spec.key];
        filled.push({field:spec.key,label:spec.label,verified:true});
      }
      for (const key of ['categoryPath','brand','condition','color','priceCents']) {
        const spec=EXTRA_SPECS.find(s=>s.key===key);
        if(!supplied(listing[key])){if(['brand','color'].includes(key))continue;missing.push({field:key,label:spec.label,reason:'未提供明确内容'});continue;}
        if(halted){unresolved.push({field:key,label:spec.label,reason:'前一步无法确认，未继续操作'});continue;}
        const result=await this.prepareChoiceOrPrice(profileId,context,ownership,spec,listing);
        (result.verified?filled:unresolved).push({field:key,label:spec.label,...result});
        if(result.halted)halted=true;
      }
      if(supplied(listing.parcel)){
        const result=halted?{reason:'前一步无法确认，未继续操作',halted:true}:await this.prepareParcel(profileId,context,ownership,listing.parcel);
        (result.verified?filled:unresolved).push({field:'parcel',label:'包裹规格',...result});if(result.halted)halted=true;
      }
      for(const spec of FIELD_SPECS)if(supplied(listing[spec.key])&&!filled.some(f=>f.field===spec.key)&&!unresolved.some(f=>f.field===spec.key))unresolved.push({field:spec.key,label:spec.label,reason:'前一步无法确认，未继续操作'});
      const finalPage=await this.read(profileId,context);
      for (const field of LATER_FIELDS) {
        if(filled.some(f=>f.field===field)||unresolved.some(f=>f.field===field))continue;
        const spec=EXTRA_SPECS.find(s=>s.key===field),observed=spec&&finalPage.elements.some(e=>matchesSpec(e,spec));
        if(supplied(listing[field]))unresolved.push({field,reason:'此控件尚未验证，未尝试猜测或填写'});
        else if(field==='parcel'||observed)missing.push({field,reason:field==='parcel'?'包裹规格尚需核对':'网页显示此选项，是否必填需按当前分类核对'});
      }
      unresolved.push({field:'photos',reason:'照片需通过独立上传流程核对；本步骤未上传、保存草稿或发布商品'});
      return {url:FORM_URL,filled,missing,unresolved,draftComplete:false,published:false,saved:false,message:'已准备能逐项确认的商品字段；仍需核对图片和其余必填信息，商品没有发布或保存。'};
    } finally {
      signal?.removeEventListener('abort',cancel);
      contents?.removeListener?.('did-start-navigation',onNavigation);contents?.removeListener?.('render-process-gone',onDestroyed);contents?.removeListener?.('destroyed',onDestroyed);
      if(w?.vintedDraftController===controller)w.vintedDraftController=null;
    }
  }

  async navigateEmptyTab(contents,controller,url) {
    const signal=controller.signal;
    if(signal.aborted)throw stop();
    let timer,onAbort;
    const aborted=new Promise((_,reject)=>{onAbort=()=>{try{if(!contents.isDestroyed())contents.stop?.();}catch{}reject(stop());};signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>{controller.abort();},20000);});
    try{await Promise.race([contents.loadURL(url),aborted]);}
    finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
  }

  async waitForMenu(profileId,context,read,ready) {
    const deadline=Date.now()+this.menuWaitMs;
    while(true){
      this.current(profileId,context);const value=await read();this.current(profileId,context);
      if(ready(value)||Date.now()>=deadline)return value;
      await new Promise((resolve,reject)=>{const signal=context.signal,cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);},cancel=()=>{cleanup();reject(stop());},timer=setTimeout(()=>{cleanup();resolve();},Math.min(this.pollIntervalMs,Math.max(1,deadline-Date.now())));signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();});
    }
  }
  async brandOptionSummary(profileId,context,page,options) {
    const search=page.elements.filter(e=>e.tag==='input'&&(normalized(e.label)===BRAND_SEARCH||normalized(e.placeholder)===BRAND_SEARCH));
    const otherFields=page.elements.filter(e=>ALL_SPECS.some(spec=>spec.key!=='brand'&&matchesSpec(e,spec))).map(e=>e.id);
    const inside=await this.control.isolated(context.tab,`(() => {
      const ids=${JSON.stringify(options.map(e=>e.id))},searchIds=${JSON.stringify(search.map(e=>e.id))},otherIds=${JSON.stringify(otherFields)},contextIds=${JSON.stringify(options.filter(e=>normalized(e.context)==='Marque').map(e=>e.id))},d=globalThis.__isolaDOM;
      const searches=searchIds.map(id=>globalThis.__isolaElements?.get(id)).filter(e=>e?.isConnected),others=otherIds.map(id=>globalThis.__isolaElements?.get(id)).filter(e=>e?.isConnected);
      return ids.filter(id=>{const e=globalThis.__isolaElements?.get(id);if(!e?.isConnected)return false;if(contextIds.includes(id))return true;return searches.some(search=>(d.parents?.(search)||[]).some(p=>!['BODY','HTML','MAIN','FORM'].includes(p.tagName)&&p.contains?.(e)&&others.every(other=>!p.contains(other))));});
    })()`);
    this.current(profileId,context);
    return Array.isArray(inside)?options.filter(e=>inside.includes(e.id)).slice(0,8).map(e=>({role:e.role||e.type||e.tag,label:normalized(e.label).slice(0,120)})):[];
  }

  async categorySearch(profileId,context) {return this.searchControl(profileId,context,CATEGORY_SEARCH);}
  async searchControl(profileId,context,searchLabel) {
    const page=await this.read(profileId,context);
    const candidates=page.elements.filter(e=>e.tag==='input'&&!e.disabled&&!e.readOnly&&!e.sensitive&&!['password','file','hidden'].includes(e.type));
    const labeled=candidates.filter(e=>normalized(e.label)===searchLabel).map(e=>e.id);
    const result=await this.control.isolated(context.tab,`(() => {
      const ids=${JSON.stringify(candidates.map(e=>e.id))},labeled=${JSON.stringify(labeled)},d=globalThis.__isolaDOM,matches=[];
      for(const id of ids){const e=globalThis.__isolaElements?.get(id);if(!e?.isConnected)continue;if(d.closest(e,'header,nav,[role=navigation],[role=tablist]'))continue;if(!labeled.includes(id)&&e.getAttribute?.('placeholder')!==${JSON.stringify(searchLabel)})continue;if(e.readOnly||e.disabled||['password','file','hidden'].includes(e.type)||/password|cc-|one-time-code/.test(e.autocomplete||''))return {stale:true};matches.push({id,value:String(e.value||'')});}
      return {documentKey:String(performance.timeOrigin),matches};
    })()`);
    this.current(profileId,context);
    if(!result||result.stale||!Array.isArray(result.matches))throw problem('ELEMENT_STALE','分类搜索控件已改变');
    return result;
  }
  async clearCategorySearch(profileId,context,ownership) {
    const before=await this.categorySearch(profileId,context);
    if(before.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
    if(before.matches.length>1)return {reason:'分类搜索出现多个同名控件，未猜测目标',halted:true};
    if(!before.matches.length||before.matches[0].value==='')return {verified:true};
    const guard=()=>this.current(profileId,context);
    const receipt=await this.control.performAction(context.tab,{action:'type',elementId:before.matches[0].id,text:''},this.options(context.signal,guard));guard();frenchPage(receipt.url,true);
    if(receipt.observation?.inputMatched!==true)return {reason:'未能确认分类搜索已清空，已停止分类选择',halted:true};
    const after=await this.categorySearch(profileId,context);
    if(after.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
    if(after.matches.length!==1||after.matches[0].value!=='')return {reason:'分类搜索仍有内容或控件已改变，未继续选择分类',halted:true};
    return {verified:true};
  }

  async finishChoiceSelection(profileId,context,ownership,spec,label) {
    const searchLabel=spec.key==='categoryPath'?CATEGORY_SEARCH:spec.key==='brand'?BRAND_SEARCH:null;
    const choiceMatches=e=>spec.key==='condition'?(normalized(e.label)===label||normalized(e.label).startsWith(label+' ')):normalized(e.label)===label;
    // Mobile category/brand choosers and condition/color dialogs commit through
    // their own Fait. Desktop pickers without that button keep the existing path.
    const page=await this.read(profileId,context),searches=page.elements.filter(e=>e.tag==='input'&&!e.disabled&&!e.sensitive&&(normalized(e.label)===searchLabel||normalized(e.placeholder)===searchLabel));
    const colorSelection=spec.key==='color'?await this.colorOptions(profileId,context,page,label):null;
    if(colorSelection?.error)return {reason:colorSelection.error,halted:true};
    const radios=colorSelection?colorSelection.matches:page.elements.filter(e=>!e.disabled&&!e.sensitive&&(e.role==='radio'||e.tag==='input'&&e.type==='radio')&&choiceMatches(e));
    const buttons=page.elements.filter(e=>!e.sensitive&&(e.role==='button'||e.tag==='button'&&!e.role)&&normalized(e.label)==='Fait');
    if(!buttons.length)return {verified:true,unchanged:true};
    const fields=page.elements.filter(e=>ALL_SPECS.some(spec=>matchesSpec(e,spec))).map(e=>e.id);
    const confirmationToken=randomUUID();
    const state=await this.control.isolated(context.tab,`(() => {
      const d=globalThis.__isolaDOM,get=id=>globalThis.__isolaElements?.get(id),normalize=value=>String(value||'').replace(/\\s+/g,' ').trim();
      const allowed=e=>!!e?.isConnected&&d.visible(e)&&!d.closest(e,'header,nav,[role=navigation],[role=tablist]');
      const searches=${JSON.stringify(searches.map(e=>e.id))}.map(get).filter(allowed),radios=${JSON.stringify(radios.map(e=>e.id))}.map(get).filter(allowed),mirrors=${JSON.stringify((colorSelection?.mirrors||[]).map(e=>e.id))}.map(get).filter(allowed),buttons=${JSON.stringify(buttons.map(e=>e.id))}.map(id=>({id,node:get(id)})).filter(item=>allowed(item.node));
      const result={documentKey:String(performance.timeOrigin),open:${!!searchLabel}?searches.length>0:radios.length>0};if(!result.open)return result;
      if(${!!searchLabel}&&searches.length!==1||radios.length!==1)return {...result,error:${JSON.stringify(spec.label)}+'选择器或叶子选项无法唯一核对，未点击确认'};
      const radio=radios[0],search=${!!searchLabel}?searches[0]:radio,checked=e=>e.checked===true||e.getAttribute?.('aria-checked')==='true';
      if(!checked(radio))return {...result,error:${JSON.stringify(spec.label)}+'叶子尚未选中，未点击确认'};
      const fields=${JSON.stringify(fields)}.map(get).filter(e=>e?.isConnected);
      const title=p=>{
        if(normalize(p.getAttribute?.('aria-label'))===${JSON.stringify(spec.label)})return true;
        // A modal header can wrap its title and a separate close button. Read
        // the independent text title inside it, never the aggregate wrapper.
        const matches=[...p.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],span,p,div')].filter(node=>d.visible(node)&&!node.querySelectorAll('input,textarea,button,[role=button],[role=radio],[role=checkbox]').length&&normalize(d.safeText(node,180))===${JSON.stringify(spec.label)});
        return matches.filter(node=>!matches.some(other=>node!==other&&node.contains(other))).length===1;
      };
      const scopes=d.parents(search).filter(p=>!['BODY','HTML','MAIN','FORM'].includes(p.tagName)&&p.contains(radio)&&fields.every(field=>!p.contains(field))&&(${!!searchLabel}||title(p)));
      const scope=scopes.find(p=>buttons.some(item=>p.contains(item.node)));
      if(!scope)return {...result,error:'未找到'+${JSON.stringify(spec.label)}+'选择器自身的 Fait 确认按钮'};
      const matches=buttons.filter(item=>scope.contains(item.node));
      const selected=[...scope.querySelectorAll(${JSON.stringify(spec.key==='color'?'input[type=checkbox],[role=checkbox]':'input[type=radio],[role=radio]')})].filter(e=>allowed(e)&&checked(e));
      // The known Suggestions group may mirror the same color. It cannot
      // supply the target or excuse another color or an unknown duplicate.
      if(matches.length!==1||!selected.includes(radio)||selected.some(e=>e!==radio&&!mirrors.includes(e))||mirrors.some(e=>!scope.contains(e)))return {...result,error:${JSON.stringify(spec.label)}+'确认按钮或已选叶子不唯一，未继续'};
      const button=matches[0].node;
      if(button.tagName!=='BUTTON'||d.disabled(button)||button.getAttribute?.('href')||button.form&&button.type==='submit'||normalize(d.label(button))!=='Fait')return {...result,error:${JSON.stringify(spec.label)}+'确认控件用途无法核对，未继续'};
      const outsideDone=new Set([...document.querySelectorAll('button,[role=button]')].filter(e=>allowed(e)&&normalize(d.label(e))==='Fait'&&!scope.contains(e)));
      globalThis.__isolaChoiceConfirmation={token:${JSON.stringify(confirmationToken)},scope,outsideDone};
      return {...result,buttonId:matches[0].id};
    })()`);
    this.current(profileId,context);
    if(!state||state.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
    if(state.error)return {reason:state.error,halted:true};
    if(!state.open)return {verified:true,unchanged:true};
    if(!state.buttonId)return {reason:spec.label+'选择器尚未确认，已停止',halted:true};
    const receipt=await this.control.performAction(context.tab,{action:'click',elementId:state.buttonId},this.options(context.signal,()=>this.current(profileId,context)));
    this.current(profileId,context);frenchPage(receipt.url,true);
    const readOpen=()=>this.control.isolated(context.tab,`(() => {
      const guard=globalThis.__isolaChoiceConfirmation,d=globalThis.__isolaDOM,result={documentKey:String(performance.timeOrigin)};
      if(!guard||guard.token!==${JSON.stringify(confirmationToken)})return {...result,error:true};
      const scope=guard.scope,remaining=!!scope?.isConnected&&d.visible(scope)&&([...scope.querySelectorAll('input,textarea,select,button,[role=button],[role=radio],[role=checkbox]')].some(e=>e.isConnected&&d.visible(e))||!!d.safeText(scope,180).trim());
      // Unmounting the old node is insufficient if a replacement picker still
      // offers Fait. Preserve only the unrelated buttons observed beforehand.
      const replaced=[...document.querySelectorAll('button,[role=button]')].some(e=>e.isConnected&&d.visible(e)&&String(d.label(e)).replace(/\\s+/g,' ').trim()==='Fait'&&!scope.contains(e)&&!guard.outsideDone.has(e));
      const open=remaining||replaced;
      return {...result,open};
    })()`);
    const closed=await this.waitForMenu(profileId,context,readOpen,value=>value.documentKey!==ownership.documentKey||value.error||value.open===false);
    if(closed.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
    return closed.error||closed.open!==false?{reason:'点击'+spec.label+' Fait 后选择器仍未关闭，已停止',halted:true}:{verified:true};
  }

  async nonNavigationCandidates(profileId,context,candidates) {
    const allowed=await this.control.isolated(context.tab,`(() => {const ids=${JSON.stringify(candidates.map(e=>e.id))},d=globalThis.__isolaDOM;return ids.filter(id=>{const e=globalThis.__isolaElements?.get(id);return !!e?.isConnected&&!d.closest(e,'header,nav,[role=navigation],[role=tablist]');});})()`);
    this.current(profileId,context);
    if(!Array.isArray(allowed))throw problem('ELEMENT_STALE','选项范围已改变');
    return candidates.filter(e=>allowed.includes(e.id));
  }
  async colorOptions(profileId,context,page,label) {
    const options=await this.nonNavigationCandidates(profileId,context,page.elements.filter(e=>!e.sensitive&&(e.role==='checkbox'||e.tag==='input'&&e.type==='checkbox')));
    const scoped=await this.control.isolated(context.tab,`(() => {
      const ids=${JSON.stringify(options.map(e=>e.id))},d=globalThis.__isolaDOM,normalize=value=>String(value||'').replace(/\\s+/g,' ').trim();
      const entries=ids.map(id=>({id,node:globalThis.__isolaElements?.get(id)}));if(entries.some(item=>!item.node?.isConnected))return {stale:true};
      const title=(node,label)=>normalize(d.label(node))===label||Array.from(node.children||[]).some(child=>d.visible(child)&&!child.querySelectorAll('input[type=checkbox],[role=checkbox]').length&&normalize(d.safeText(child,180))===label);
      const nearest=(node,label)=>{for(const parent of d.parents(node)){if(['BODY','HTML','MAIN','FORM'].includes(parent.tagName))break;if(!['INPUT','LABEL'].includes(parent.tagName)&&title(parent,label))return parent;}return null;};
      const groups=[...new Set(entries.map(item=>nearest(item.node,'Toutes les couleurs')).filter(Boolean))],suggestionGroups=[...new Set(entries.map(item=>nearest(item.node,'Suggestions')).filter(Boolean))],suggestions=suggestionGroups.length>0;
      if(groups.length>1)return {error:'页面出现多个 Toutes les couleurs 区域，未猜测颜色范围'};
      if(!groups.length&&suggestions)return {error:'页面只有颜色建议，未找到唯一 Toutes les couleurs 区域'};
      if(suggestionGroups.length>1)return {error:'页面出现多个 Suggestions 区域，未猜测颜色范围'};
      const canonical=groups.length?entries.filter(item=>groups[0].contains(item.node)):entries;
      const matches=entries.filter(item=>normalize(d.label(item.node))===${JSON.stringify(label)}),mirrors=groups.length&&suggestionGroups.length?matches.filter(item=>suggestionGroups[0].contains(item.node)&&!groups[0].contains(item.node)):[];
      if(mirrors.length>1||matches.some(item=>!canonical.includes(item)&&!mirrors.includes(item)))return {error:'颜色同名选项位于未知或重复分组，未猜测确认目标'};
      return {ids:canonical.map(item=>item.id),mirrorIds:mirrors.map(item=>item.id)};
    })()`);
    this.current(profileId,context);
    if(!scoped||scoped.stale)throw problem('ELEMENT_STALE','颜色分组选项已改变');
    if(scoped.error)return {options,matches:[],error:scoped.error};
    if(!Array.isArray(scoped.ids))throw problem('ELEMENT_STALE','颜色选项范围无效');
    return {options,matches:options.filter(e=>scoped.ids.includes(e.id)&&!e.disabled&&normalized(e.label)===label),mirrors:options.filter(e=>(scoped.mirrorIds||[]).includes(e.id))};
  }
  async readChoiceValue(profileId,context,ownership,spec) {
    const page=await this.read(profileId,context),match=this.field(page,spec,{readOnly:true});
    if(match.error)return {error:match.error};
    const state=await this.values(context.tab,page);this.current(profileId,context);
    if(state.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
    return {page,value:state.values.find(e=>e.id===match.element.id)?.value};
  }
  async closeChoiceMenu(profileId,context,spec,label) {
    const visible=async()=>{
      if(spec.key==='brand')return (await this.searchControl(profileId,context,BRAND_SEARCH)).matches.length>0;
      const page=await this.read(profileId,context);
      return (await this.nonNavigationCandidates(profileId,context,page.elements.filter(e=>(e.role==='checkbox'||e.tag==='input'&&e.type==='checkbox')&&normalized(e.label)===label))).length>0;
    };
    if(!await visible())return {verified:true};
    const guard=()=>this.current(profileId,context);
    await this.control.performAction(context.tab,{action:'key',key:'Escape'},this.options(context.signal,guard));guard();
    if(await visible())return {reason:'选项菜单尚未关闭，未继续点击其他字段',halted:true};
    return {verified:true};
  }
  async prepareBrandOrColor(profileId,context,ownership,spec,listing,value) {
    const guard=()=>this.current(profileId,context),options=this.options(context.signal,guard),label=listing[spec.key],unchanged=value===label;
    if(value&&!unchanged)return {reason:'已有品牌或颜色选项，未自动替换；请先人工核对',halted:true};
    if(unchanged){const closed=await this.closeChoiceMenu(profileId,context,spec,label);if(closed.halted)return closed;const final=await this.readChoiceValue(profileId,context,ownership,spec);if(final.error||final.value!==label)return {reason:'菜单关闭后选项发生变化，未继续操作',halted:true};return {verified:true,unchanged:true};}
    const checkbox=e=>e.role==='checkbox'||e.tag==='input'&&e.type==='checkbox';
    let page=await this.read(profileId,context),menuOpen;
    if(spec.key==='brand'){const search=await this.searchControl(profileId,context,BRAND_SEARCH);if(search.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');menuOpen=search.matches.length>0;}
    else menuOpen=(await this.nonNavigationCandidates(profileId,context,page.elements.filter(e=>checkbox(e)&&normalized(e.label)===label))).length>0;
    if(!menuOpen){
      const settled=await this.control.performAction(context.tab,{action:'wait',amount:300},options);guard();
      if(settled.observation?.pending)return {reason:'商品选项区域仍在更新，未点击不稳定的字段',halted:true};
      page=await this.read(profileId,context);const match=this.field(page,spec,{readOnly:true});if(match.error)return {reason:match.error,halted:true};
      const triggerState=await this.values(context.tab,page);guard();
      if(triggerState.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
      if(triggerState.values.find(e=>e.id===match.element.id)?.value!=='')return {reason:'等待期间商品选项已改变，未覆盖或重新点击',halted:true};
      await this.control.performAction(context.tab,{action:'click',elementId:match.element.id},options);guard();
    }
    if(spec.key==='brand'){
      let search=await this.waitForMenu(profileId,context,()=>this.searchControl(profileId,context,BRAND_SEARCH),state=>state.matches.length>0);
      if(search.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
      if(search.matches.length!==1)return {reason:'未找到唯一的品牌搜索框，未猜测品牌',halted:true};
      if(search.matches[0].value!==label){
        const result=await this.control.performAction(context.tab,{action:'type',elementId:search.matches[0].id,text:label},options);guard();
        if(result.observation?.inputMatched!==true)return {reason:'品牌搜索输入未能核对，未选择品牌',halted:true};
        search=await this.searchControl(profileId,context,BRAND_SEARCH);
        if(search.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
        if(search.matches.length!==1||search.matches[0].value!==label)return {reason:'品牌搜索与指定标签不一致',halted:true};
      }
    }
    const readOptions=async()=>{const page=await this.read(profileId,context);if(spec.key==='color')return {page,...await this.colorOptions(profileId,context,page,label)};const options=await this.nonNavigationCandidates(profileId,context,page.elements.filter(e=>!e.disabled&&!e.sensitive&&(e.role==='radio'||e.tag==='input'&&e.type==='radio')));return {page,options,matches:options.filter(e=>normalized(e.label)===label)};};
    const found=spec.key==='brand'?await this.waitForMenu(profileId,context,readOptions,value=>value.matches.length>0):await readOptions();
    page=found.page;const optionsOnPage=found.options,matches=found.matches;
    if(found.error)return {reason:found.error,halted:true};
    if(matches.length!==1){const observedOptions=spec.key==='brand'?await this.brandOptionSummary(profileId,context,page,optionsOnPage):[];return {reason:'未找到唯一的明确'+spec.label+'选项：'+label+(spec.key==='brand'?(observedOptions.length?'；品牌菜单：'+observedOptions.map(e=>e.role+' '+e.label).join(' / '):'；品牌菜单尚无可核对的单选项'):''),observedOptions,halted:true};}
    const checked=e=>e.checked===true||e.checked==='true';
    if(spec.key==='color'&&optionsOnPage.some(e=>normalized(e.label)!==label&&checked(e)))return {reason:'页面还选中了其他颜色，未自动取消或叠加颜色',halted:true};
    if(spec.key==='brand'||!checked(matches[0])){await this.control.performAction(context.tab,{action:'click',elementId:matches[0].id},options);guard();}
    if(spec.key==='color'){
      const confirmed=await this.colorOptions(profileId,context,await this.read(profileId,context),label);
      if(confirmed.error||confirmed.matches.length!==1||!checked(confirmed.matches[0]))return {reason:confirmed.error||'颜色复选框没有确认选中，未继续操作',halted:true};
      if(confirmed.options.some(e=>normalized(e.label)!==label&&checked(e)))return {reason:'选择后页面还选中了其他颜色，未继续操作',halted:true};
    }
    const finished=await this.finishChoiceSelection(profileId,context,ownership,spec,label);if(finished.halted)return finished;
    const selected=await this.readChoiceValue(profileId,context,ownership,spec);
    if(selected.error||selected.value!==label)return {reason:selected.error||'选择后的'+spec.label+'与指定标签不一致',halted:true};
    ownership.fields[spec.key]=selected.value;
    const closed=await this.closeChoiceMenu(profileId,context,spec,label);if(closed.halted)return closed;
    const final=await this.readChoiceValue(profileId,context,ownership,spec);
    if(final.error||final.value!==label)return {reason:'菜单关闭后选项发生变化，未继续操作',halted:true};
    return {verified:true};
  }

  async parcelOptions(profileId,context) {
    const page=await this.read(profileId,context);
    const observed=page.elements.filter(e=>!e.sensitive&&(e.tag==='button'||e.tag==='label'||e.role==='button'||e.role==='radio'||e.tag==='input'&&e.type==='radio')).map(({id,label,role,context,tag,type})=>({id,label,role,context,tag,type}));
    const otherIds=page.elements.filter(e=>ALL_SPECS.some(spec=>matchesSpec(e,spec))).map(e=>e.id);
    const phrases={Petit:'Petit Convient pour un article qui tient dans une grande enveloppe.',Moyen:'Moyen Convient pour un article qui tient dans une boîte à chaussures.',Grand:'Grand Convient pour un article qui tient dans un carton de déménagement.'};
    const result=await this.control.isolated(context.tab,`(() => {
      const observed=${JSON.stringify(observed)},otherIds=${JSON.stringify(otherIds)},phrases=${JSON.stringify(phrases)},d=globalThis.__isolaDOM;
      const normalize=value=>String(value||'').replace(/\\s+/g,' ').trim(),names=text=>Object.keys(phrases).filter(name=>normalize(text).includes(phrases[name]));
      const entries=observed.map(item=>({...item,node:globalThis.__isolaElements?.get(item.id)})).filter(item=>item.node?.isConnected&&!d.closest(item.node,'header,nav,[role=navigation],[role=tablist]'));
      const others=otherIds.map(id=>globalThis.__isolaElements?.get(id)).filter(e=>e?.isConnected);
      const radios=scope=>{const native=[...scope.querySelectorAll('input[type=radio]')];return native.length?native:[...scope.querySelectorAll('[role=radio]')];};
      const nearestText=node=>{const texts=[d.label(node),...Array.from(node.labels||[]).map(label=>d.safeText(label,500))];for(const p of d.parents(node)){if(['BODY','HTML','MAIN','FORM'].includes(p.tagName))break;const peers=radios(p);if(peers.length===1||p===node)texts.push(d.safeText(p,500));}return texts.join(' ');};
      const anchors=entries.filter(item=>names(nearestText(item.node)).length===1);
      const diagnostics=[...anchors.map(item=>({role:item.role||item.type||item.tag,label:normalize(nearestText(item.node)).slice(0,160),context:item.context||''})),...entries.filter(item=>item.role==='radio'||item.type==='radio').map(item=>({role:item.role||item.type,label:String(item.label||'').slice(0,120),context:item.context||''}))].slice(0,8);
      const groups=[];
      for(const anchor of anchors){for(const p of d.parents(anchor.node)){if(['BODY','HTML','MAIN','FORM'].includes(p.tagName))continue;if(others.some(e=>p.contains(e)))continue;if(names(d.safeText(p,1800)).length===3&&radios(p).length>=3){if(!groups.includes(p))groups.push(p);break;}}}
      if(groups.length!==1)return {error:'未能唯一确认三个明确运输说明所在的包裹区域',diagnostics};
      const scope=groups[0],controls=radios(scope),options=[];
      for(const radio of controls){
        const texts=[d.label(radio),...Array.from(radio.labels||[]).map(label=>d.safeText(label,500))];
        for(const p of d.parents(radio)){if(!scope.contains(p)&&p!==scope)break;if(controls.filter(e=>p===e||p.contains(e)).length===1)texts.push(d.safeText(p,500));if(p===scope)break;}
        const found=names(texts.join(' '));if(found.length!==1)continue;const name=found[0];
        const visible=entries.filter(item=>scope.contains(item.node)&&d.visible(item.node)&&!d.disabled(item.node)&&(item.node===radio||item.node.contains(radio)||item.node.control===radio)&&controls.filter(e=>item.node===e||item.node.contains(e)||item.node.control===e).length===1);
        const direct=visible.filter(item=>item.node===radio),actions=direct.length?direct:visible.filter(item=>names(nearestText(item.node)).length===1&&names(nearestText(item.node))[0]===name);
        options.push({name,checked:radio.tagName==='INPUT'?radio.checked===true:radio.getAttribute('aria-checked')==='true',disabled:d.disabled(radio),id:actions.length===1?actions[0].id:null,actionAmbiguous:actions.length>1});
      }
      if(Object.keys(phrases).some(name=>options.filter(option=>option.name===name).length!==1))return {error:'运输区的原生单选规格不完整或存在重复项',diagnostics};
      return {documentKey:String(performance.timeOrigin),options,diagnostics};
    })()`);
    this.current(profileId,context);
    if(!result||!Array.isArray(result.options)&&!result.error)return {error:'运输选项回读格式无效'};
    if(result.error){const summary=(result.diagnostics||[]).map(item=>(item.role||'控件')+' '+item.label+(item.context?' ['+item.context+']':'')).join(' / ');return {error:result.error+(summary?'；可见控件：'+summary:''),observedOptions:result.diagnostics||[]};}
    return result;
  }
  async prepareParcel(profileId,context,ownership,name) {
    const before=await this.parcelOptions(profileId,context);if(before.error)return {reason:before.error,observedOptions:before.observedOptions,halted:true};
    if(before.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
    const checked=e=>e.checked===true||e.checked==='true',selected=before.options.filter(checked),target=before.options.find(e=>e.name===name);
    if(selected.length>1)return {reason:'运输区同时显示多个已选规格，未继续操作',halted:true};
    const unchanged=selected.length===1&&selected[0].name===name;
    if(!unchanged){if(target.disabled||!target.id)return {reason:'指定运输规格没有唯一可见的可操作控件，未点击隐藏单选框',halted:true};const guard=()=>this.current(profileId,context);await this.control.performAction(context.tab,{action:'click',elementId:target.id},this.options(context.signal,guard));guard();}
    const after=await this.parcelOptions(profileId,context);if(after.error)return {reason:after.error,observedOptions:after.observedOptions,halted:true};
    if(after.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
    const confirmed=after.options.filter(checked);
    if(confirmed.length!==1||confirmed[0].name!==name)return {reason:'运输规格选择结果与要求不一致，未继续操作',halted:true};
    ownership.fields.parcel=name;return {verified:true,unchanged,selected:name};
  }

  async prepareChoiceOrPrice(profileId,context,ownership,spec,listing) {
    const guard=()=>this.current(profileId,context),options=this.options(context.signal,guard);
    let page=await this.read(profileId,context),match=this.field(page,spec,{readOnly:spec.key!=='priceCents'});
    if(match.error)return {reason:match.error};
    const state=await this.values(context.tab,page);guard();
    if(state.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
    const value=state.values.find(e=>e.id===match.element.id)?.value;
    if(typeof value!=='string')throw problem('ELEMENT_STALE','目标控件已改变');
    if(value&&value!==ownership.fields[spec.key])throw problem('EXISTING_DRAFT','商品选项被其他操作修改，已停止以保留原内容');
    if(['brand','color'].includes(spec.key))return this.prepareBrandOrColor(profileId,context,ownership,spec,listing,value);
    if(expectedValue(spec.key,listing,value))return {verified:true,unchanged:true};
    if(spec.key==='priceCents'){
      const text=(listing.priceCents/100).toFixed(2).replace('.',',');
      const after=await this.control.performAction(context.tab,{action:'type',elementId:match.element.id,text},options);guard();frenchPage(after.url,true);
      // The site may normalize the French comma to a decimal point. Verify the
      // fresh unique price control in this document by exact EUR cents instead
      // of treating the action's literal-text comparison as the final receipt.
      page=await this.read(profileId,context);match=this.field(page,spec);if(match.error)return {reason:match.error,halted:true};
      const next=await this.values(context.tab,page);guard();const rendered=next.values.find(v=>v.id===match.element.id)?.value;
      if(next.documentKey!==ownership.documentKey||!expectedValue(spec.key,listing,rendered))return {reason:'网页价格与指定欧元金额不一致',halted:true};
      ownership.fields[spec.key]=rendered;return {verified:true};
    }
    if(value)return {reason:'已有分类或成色选项，未自动替换；请在新的商品表单重新准备'};
    if(spec.key==='categoryPath'){
      const menu=await this.categorySearch(profileId,context);
      if(menu.documentKey!==ownership.documentKey)throw problem('PAGE_CHANGED','商品页已重新加载，准备已停止');
      if(menu.matches.length>1)return {reason:'分类搜索出现多个同名控件，未猜测目标',halted:true};
      if(!menu.matches.length){page=await this.read(profileId,context);match=this.field(page,spec,{readOnly:true});if(match.error)return {reason:match.error,halted:true};await this.control.performAction(context.tab,{action:'click',elementId:match.element.id},options);guard();}
      const reset=await this.clearCategorySearch(profileId,context,ownership);if(reset.halted)return reset;
    }else{await this.control.performAction(context.tab,{action:'click',elementId:match.element.id},options);guard();}
    const labels=spec.key==='categoryPath'?listing.categoryPath:[listing.condition],steps=[];
    for(const [index,label] of labels.entries()){
      page=await this.read(profileId,context);
      const final=index===labels.length-1;
      const candidates=page.elements.filter(e=>{
        if(e.disabled||e.sensitive)return false;
        const radio=e.role==='radio'||e.tag==='input'&&e.type==='radio';
        const button=e.role==='button'||e.tag==='button'&&!e.role;
        if(spec.key==='condition')return radio&&(normalized(e.label)===label||normalized(e.label).startsWith(label+' '));
        return normalized(e.label)===label&&(final?radio:button);
      });
      const allowed=await this.control.isolated(context.tab,`(() => {const ids=${JSON.stringify(candidates.map(e=>e.id))},d=globalThis.__isolaDOM;return ids.filter(id=>{const e=globalThis.__isolaElements?.get(id);return !!e?.isConnected&&!d.closest(e,'header,nav,[role=navigation],[role=tablist]');});})()`);guard();
      if(!Array.isArray(allowed))return {reason:'选项范围无法核对，未选择',halted:true};
      const matches=candidates.filter(e=>allowed.includes(e.id));
      if(matches.length!==1)return {reason:matches.length?'选项出现多个同名控件，未猜测目标':candidates.length?'目标属于导航或已改变，未选择':'未找到唯一且角色匹配的明确选项：'+label,halted:true};
      await this.control.performAction(context.tab,{action:'click',elementId:matches[0].id},options);guard();
      if(spec.key==='categoryPath')steps.push({label,elementId:matches[0].id,role:final?'radio':'button',documentKey:ownership.documentKey,unique:true});
    }
    const finished=await this.finishChoiceSelection(profileId,context,ownership,spec,labels.at(-1));if(finished.halted)return finished;
    page=await this.read(profileId,context);match=this.field(page,spec,{readOnly:true});
    if(match.error)return {reason:match.error,halted:true};
    const next=await this.values(context.tab,page);guard();const selected=next.values.find(e=>e.id===match.element.id)?.value;
    if(next.documentKey!==ownership.documentKey||!expectedValue(spec.key,listing,selected))return {reason:'选择后的控件值与要求不一致，已停止',halted:true};
    ownership.fields[spec.key]=selected;
    if(spec.key==='categoryPath')rememberCategoryTraversal(ownership,{tab:context.tab,documentKey:ownership.documentKey,path:labels,selectedValue:selected,steps});
    return {verified:true};
  }
  async requireReady(){throw problem('VINTED_UNVERIFIED','真实 Vinted 业务流程尚未验证，任务已保留；文字字段准备不会启用刊登、消息或下单');}
  async poll(){return [];}
}
module.exports={VintedAdapter};
