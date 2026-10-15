'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const api = window.commerce;
  const settingsForm = $('#settings-form');
  const planForm = $('#plan-form');
  const planDialog = $('#plan-dialog');
  const productListingForm = $('#product-listing-form'), productListingDialog = $('#product-listing-dialog');
  const jobDialog = $('#job-dialog');
  const preflightDialog = $('#preflight-dialog');
  const photoDialog = $('#plan-photos-dialog');
  const associationDialog = $('#publication-association-dialog');
  const withdrawalDialog = $('#publication-withdrawal-dialog');
  const accountForm = $('#account-form'), accountDialog = $('#account-dialog'), accountVerifyDialog = $('#account-verify-dialog'), accountDeleteDialog = $('#account-delete-dialog');
  const reviewStates = new Set(['needs_review', 'pending_review', 'waiting_review', 'review', 'unknown', 'uncertain', 'blocked', 'failed', 'error']);
  const completedStates = new Set(['completed', 'complete', 'done', 'succeeded']);
  const cancelledStates = new Set(['cancelled', 'canceled', 'rejected']);
  const stateNames = {queued:'待执行', pending:'待执行', running:'执行中', waiting:'等待条件', awaiting_result:'等待结果', retry_wait:'等待检查', needs_review:'需要核对', pending_review:'需要核对', waiting_review:'需要核对', review:'需要核对', unknown:'结果未知', uncertain:'结果未知', blocked:'已暂停', failed:'执行失败', error:'执行失败', completed:'已完成', complete:'已完成', done:'已完成', succeeded:'已完成', cancelled:'已取消', canceled:'已取消', rejected:'已拒绝', paused:'已暂停', disabled:'未启用', enabled:'已启用', ready:'待执行', active:'在售中', listed:'在售中', fulfilling:'履约中', target_reached:'销售目标已达成', waiting_sale:'等待成交', awaiting_sale:'等待成交', draft:'草稿', unverified:'待验证'};
  const jobNames = {listing:'商品上架', list:'商品上架', publish:'商品上架', reply:'回复消息', message:'回复消息', messages:'检查消息', offer:'处理报价', offers:'检查报价', accept_offer:'接受报价', sale_confirmation:'确认成交', label:'获取运单', shipping_label:'获取运单', shipment:'获取运单', fulfillment:'面单与货盘履约', procurement:'货盘采购', purchase:'货盘采购', order:'货盘采购', reconcile:'核对结果', sync:'同步货盘'};
  const stepNames = {pending:'检查执行条件',claim_photos:'领取商品图片',prepare_listing:'准备刊登草稿',publish_listing:'提交刊登',record_listing:'记录刊登回执',draft_reply:'准备商品回复',send_reply:'发送回复',check_offer:'核对报价',accept_offer:'接受报价',download_label:'下载并核对运单',check_stock_price:'核对库存与采购价',wms_checkout:'核对可用仓库',create_supplier_order:'提交货盘订单',verified:'核对完成'};
  Object.assign(stateNames,{sale_pending_confirmation:'成交待确认'});
  Object.assign(stepNames,{open_environment:'自动打开账号环境',check_catalog:'核对当前账号衣橱',prepare_photos:'准备并校验原照片',upload_photos:'上传并核对照片',verify_listing:'核对实际刊登结果',publication_reconciled:'已关联原刊登',listing_deleted:'原商品已删除，已安排重新上架',confirm_sale:'核对原成交',sale_confirmed:'成交已核对',sale_confirmation:'核对原成交'});
  const pageDetails = {overview:['商品运营','查看每个商品在哪个环境销售，以及接下来需要做什么。'],accounts:['账号中心','固定设备环境，管理登录与需要接管的账号。'],plans:['上架计划','为每个环境设置商品、销售目标与价格规则。'],inventory:['商品与图片','自己添加商品和照片，或同步货盘商品。'],jobs:['任务记录','检查每一步的执行状态与外部平台回执。'],settings:['连接与规则','连接货盘，并为后台执行设置明确的范围。']};
  let state = {settings:{},connection:{status:'not_configured'},profiles:[],accounts:[],products:[],productListings:[],photoSets:[],photoPreparations:[],plans:[],jobs:[],events:[],publications:[],running:false,readiness:{vinted:'unverified'}};
  let currentPage = 'overview', settingsDirty = false, photoProductId = '', selectedJobId = '', selectedPlanId = '', toastTimer;
  let pageReport = null, reportKind = 'preflight', reportError = '';
  let selectedPhotoPlanId = '';
  let jobPlanFilter = '', distributionLimit = 100;
  const photoReports = new Map();
  const publicationAttempts = new Map();
  const planAccountReports = new Map();
  let accountVerifyPlanId='',manualPhotoToken='',manualPhotoCount=0;
  let publicationReviewedPlan = '';
  let associationPlanId = '', associationReport = null, associationReviewToken = '', associationError = '', associationResult = null;
  let withdrawalReview = null, withdrawalError = '', withdrawalResult = '', withdrawalTimer;
  let accountVerifyId = '', accountDeleteId = '', accountProfileLocked = false;
  const listingFields = {title:'listingTitle',description:'listingDescription',categoryPath:'listingCategoryPath',condition:'listingCondition',brand:'listingBrand',size:'listingSize',color:'listingColor',parcel:'listingParcel'};
  const listingNames = {title:'商品标题',description:'商品描述',categoryPath:'分类路径',condition:'成色',brand:'品牌',size:'尺码',color:'颜色',parcel:'包裹规格',price:'价格',photos:'图片'};
  const pending = new Set();

  function el(tag, cls, value) { const node = document.createElement(tag); if (cls) node.className = cls; if (value !== undefined && value !== null) node.textContent = String(value); return node; }
  function same(a,b) { return String(a) === String(b); }
  function find(rows,id) { return rows.find(row => same(row.id,id)); }
  function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
  function currency(cents) { return typeof cents === 'number' && Number.isSafeInteger(cents) ? new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(cents / 100) : '—'; }
  function moneyInput(cents) { return Number.isSafeInteger(cents) && cents >= 0 ? (cents / 100).toFixed(2) : ''; }
  function cents(value, label, positive = false) {
    const text = String(value).trim();
    if (!/^(?:0|[1-9]\d{0,8})(?:[.,]\d{1,2})?$/.test(text)) throw Error(`${label}请填写有效金额，最多两位小数。`);
    const [whole, fraction = ''] = text.replace(',', '.').split('.');
    const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(amount) || amount > 100000000) throw Error(`${label}不能超过 1,000,000.00 €。`);
    if (positive && amount <= 0) throw Error(`${label}必须大于 0。`);
    return amount;
  }
  function integer(value, min, max, label) { if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value)<min || Number(value)>max) throw Error(`${label}须为 ${min}–${max} 之间的整数。`); return Number(value); }
  function when(value, compact = false) { if (!value) return '—'; const date = new Date(value); if (!Number.isFinite(date.getTime())) return '—'; return date.toLocaleString('zh-CN', compact ? {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false} : {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}); }
  function cleanError(error) { return String(error?.message || error || '操作失败').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
  function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 7000); }
  async function refresh() { applyState(await api.state()); }
  async function request(key, work, success) {
    if (pending.has(key)) return;
    pending.add(key); renderControls(); if(key.startsWith('plan-'))renderPlans(); if(key.startsWith('plan-photo-')&&photoDialog.open)renderPhotoReport();
    try { const result = await work(); await refresh(); if (success) toast(typeof success === 'function' ? success(result) : success); return result; }
    catch (error) { toast(cleanError(error)); throw error; }
    finally { pending.delete(key); renderControls(); if (key.startsWith('plan-')) renderPlans(); }
  }
  function act(button, key, work, success) { button.addEventListener('click', () => { void request(key,work,success).catch(() => {}); }); }
  function makeButton(label, fn, cls = '') { const button = el('button',cls,label); button.type = 'button'; button.addEventListener('click', () => { Promise.resolve().then(fn).catch(error => toast(cleanError(error))); }); return button; }
  function empty(text, small = false) { return el('div',small ? 'empty-small' : 'empty',text); }
  function badge(label, tone = 'neutral') { return el('span',`pill ${tone}`,label); }
  function statusBadge(value) { return badge(stateNames[value] || String(value || '待执行'),completedStates.has(value) ? 'good' : reviewStates.has(value) ? 'warn' : value === 'running' ? 'good' : 'neutral'); }
  function profileName(id) { return find(state.profiles,id)?.name || '环境不可用'; }
  function productName(id) { return find(state.products,id)?.name || '商品不可用'; }
  function pageActionPending() { return [...pending].some(key=>/^plan-(?:preflight|draft|open|photo|publication)-/.test(key)); }
  function photoActionPending() { return [...pending].some(key=>key.startsWith('plan-photo-')); }
  function photoSummary(id) {
    const saved=state.photoPreparations.find(item=>same(item.planId,id)), latest=photoReports.get(String(id))?.summary;
    return latest&&(!saved||String(latest.updatedAt||'')>=String(saved.updatedAt||''))?latest:saved;
  }
  function photoPreparationStatus(id) {
    const summary=photoSummary(id);
    if(pending.has(`plan-photo-prepare-${id}`))return {label:'正在准备图片',tone:'neutral'};
    if(summary?.ready===true&&summary.state==='ready')return {label:'本机图片已准备',tone:'good'};
    if(summary&&['uncertain','needs_review','claiming','downloading','receipt_saved'].includes(summary.state))return {label:'图片准备待核对',tone:'warn'};
    return {label:summary?'图片尚未准备完成':'尚未准备图片',tone:'neutral'};
  }
  function photoUploadStatus(id) {
    const report=photoReports.get(String(id));
    if(pending.has(`plan-photo-upload-${id}`))return {label:report?.checkingUpload?'正在核对上传':'正在上传并核对',tone:'neutral'};
    if(report?.upload?.verified===true&&report.upload.uncertain!==true&&!report.uploadError)return {label:'最近上传回执已验证',tone:'good'};
    if(report?.upload?.uncertain===true||report?.uploadError)return {label:'上传结果待核对',tone:'warn'};
    return {label:'当前页上传待核对',tone:'neutral'};
  }
  function canCheckPhotos(id) { const report=photoReports.get(String(id));return report?.upload?.canCheck===true||report?.page?.canCheck===true; }
  function canUploadPhotos(id) { const report=photoReports.get(String(id));return photoSummary(id)?.ready===true&&(canCheckPhotos(id)||!report?.uploadError&&report?.page?.canUpload===true); }
  function photoDiagnostic(value,depth=0) {
    if(depth>12)return null;
    if(typeof value==='string')return value.slice(0,2000);
    if(typeof value==='number')return Number.isFinite(value)?value:null;
    if(typeof value==='boolean'||value===null)return value;
    if(Array.isArray(value))return value.slice(0,100).map(item=>photoDiagnostic(item,depth+1));
    if(!value||typeof value!=='object')return null;
    const allowed=new Set(['fileInputCount','candidates','index','accept','multiple','disabled','required','visible','label','selectedFileCount','scopeLevel','ancestors','scope','tag','role','testId','level','fileInputs','otherFields','uploadButtons','images','alt','loaded','width','height','sourceKind','controls','statuses','text','busy','challenge','canUpload','canCheck','previousClaimState','documentKey','message']);
    return Object.fromEntries(Object.entries(value).filter(([key])=>allowed.has(key)).map(([key,item])=>[key,photoDiagnostic(item,depth+1)]));
  }
  function isConnected() { return ['connected','ok','ready','authenticated','success'].includes(state.connection.status); }
  function productEditorBusy() { return pending.has('product-listing')||pending.has('manual-photos'); }
  function supplierRequired() { return state.plans.some(plan=>plan.enabled&&plan.source!=='local'&&find(state.products,plan.productId)?.source!=='local')||!state.products.length&&!!state.settings.hasToken; }
  function listingMissing(value) { return value?.missingFields || ['title','description','condition','brand','color','parcel','categoryPath'].filter(key=>key==='categoryPath'?!Array.isArray(value?.listing?.[key])||!value.listing[key].length:!value?.listing?.[key]?.trim()); }
  function productListing(product) { return product&&state.productListings.find(row=>same(row.productId,product.id)&&row.sku===product.sku); }
  function formListing(form) { return Object.fromEntries(Object.entries(listingFields).map(([key,field])=>[key,form.elements[field].value.trim()])); }
  function fillListing(form,listing={}) { for(const [key,field] of Object.entries(listingFields))form.elements[field].value=key==='categoryPath'?(listing[key]||[]).join(' / '):listing[key]||''; }
  function formListingMissing(form) { const listing=formListing(form);listing.categoryPath=listing.categoryPath.split('/').map(value=>value.trim()).filter(Boolean);return listingMissing({listing}); }
  function renderListingHint(form,node) { const missing=formListingMissing(form);node.textContent=missing.length?`自动上架前还需填写：${missing.map(key=>listingNames[key]).join('、')}。`:'基本商品资料已填齐；执行时还会核对分类所需尺码、页面选项与实际图片。'; }
  function hasBoundAccount(profileId) { return !!find(state.profiles,profileId)?.marketAccount||state.accounts.some(account=>same(account.profileId,profileId)&&account.identity?.memberId); }
  function setupNext() {
    if(supplierRequired()&&(!state.settings.hasToken||!isConnected()))return {page:'settings',label:state.settings.hasToken?'检查货盘连接':'配置货盘连接'};
    if(!state.products.length)return {page:'inventory',label:state.settings.hasToken?'同步或添加商品':'自己添加商品'};
    if(!state.plans.length&&!state.products.some(product=>{const saved=productListing(product);return saved&&!listingMissing(saved).length;}))return {page:'inventory',label:'填写商品资料'};
    if(!state.plans.length)return {page:'plans',label:'创建上架计划'};
    const enabled=state.plans.filter(plan=>plan.enabled),pending=enabled.filter(plan=>!plan.activeListingId&&number(plan.completedCount)<number(plan.targetCount));
    if(pending.some(plan=>!hasBoundAccount(plan.profileId)))return {page:'accounts',label:'绑定并核对账号'};
    if(!enabled.length||pending.some(plan=>listingMissing(plan).length))return {page:'plans',label:'完善并启用计划'};
    if(!state.settings.backgroundEnabled)return {page:'settings',label:'允许后台调度'};
    return {page:state.running?'jobs':'overview',label:state.running?'查看执行进度':'查看上架流程'};
  }
  function renderListingWorkflow() {
    const products=state.products,templates=products.filter(product=>{const saved=productListing(product);return saved&&!listingMissing(saved).length;}),enabled=state.plans.filter(plan=>plan.enabled),ready=enabled.filter(plan=>!listingMissing(plan).length&&hasBoundAccount(plan.profileId)),review=state.jobs.filter(job=>reviewStates.has(job.state));
    const rows=[
      {id:'connection',title:'执行规则',complete:!!state.settings.backgroundEnabled&&(!supplierRequired()||isConnected()),text:!state.settings.backgroundEnabled?'先允许后台执行并保存。手动商品无需货盘。':supplierRequired()&&!isConnected()?'使用货盘的计划还需检查连接。':'已允许执行；只有货盘商品需要货盘连接。',label:'设置执行规则',page:'settings'},
      {id:'products',title:'商品信息',complete:templates.length>0,text:!products.length?'自己添加商品和本地照片，也可连接并同步货盘。':`${products.length} 个商品 · ${templates.length} 份基本资料已齐。先保存资料，再分配计划。`,label:products.length?'编辑商品资料':'添加商品',page:'inventory'},
      {id:'plans',title:'上架计划',complete:ready.length>0,text:`${enabled.length} 个启用计划 · ${ready.length} 个资料齐备且账号已绑定。执行时重新核对登录。`,label:'配置计划',page:'plans'},
      {id:'execution',title:'自动上架',complete:state.jobs.some(job=>job.type==='listing'&&completedStates.has(job.state)),text:state.running?'按已开始的计划自动开窗、核对衣橱、上传照片、填写并提交，最后读取商品回执。':review.length?`${review.length} 个任务需核对原记录；其他计划按各自条件执行。`:'点击计划中的“启用并开始”即可执行；发布结果以商品回执为准。',label:state.running||review.length?'查看任务':'查看执行条件',page:state.running||review.length?'jobs':'plans'}
    ];
    const list=$('#listing-workflow-steps');list.replaceChildren();for(const row of rows){const item=el('li');item.dataset.step=row.id;item.dataset.complete=String(row.complete);item.append(el('h3','',row.title),badge(row.complete?'已配置':'待处理',row.complete?'good':'neutral'),el('p','',row.text),makeButton(row.label,()=>changePage(row.page)));list.append(item);}
    $('#listing-workflow-status').textContent=state.running?'正在调度':review.length?'有任务需要核对':ready.length&&(!supplierRequired()||isConnected())&&state.settings.backgroundEnabled?'可开始上架':'继续完善配置';
  }
  function editProductListing(product) {
    if(productEditorBusy())return;
    if(product.source==='local'){editManualProduct(product);return;}
    productListingForm.dataset.mode='supplier';setManualProductMode(false);
    productListingForm.reset();const saved=productListing(product),fields=productListingForm.elements;fields.productId.value=product.id;productListingForm.dataset.sku=product.sku;fillListing(productListingForm,saved?.listing);fields.listingPrice.value=moneyInput(saved?.listingPriceCents);fields.minOffer.value=moneyInput(saved?.minOfferCents);$('#product-listing-title').textContent=product.name||'商品上架资料';$('#product-listing-source').textContent=`SKU ${product.sku} · 库存 ${product.stock??'待核对'} · 可用图片 ${product.photoSetsAvailable??'待核对'} 套`;$('#product-listing-error').hidden=true;renderListingHint(productListingForm,$('#product-listing-readiness'));productListingDialog.showModal();
  }
  function setManualProductMode(manual) { document.querySelector('[data-manual-product-only]').hidden=!manual;productListingForm.elements.manualName.required=manual;productListingForm.elements.manualStock.required=manual; }
  function editManualProduct(product) {
    if(productEditorBusy()||typeof api.saveManualProduct!=='function')return;
    productListingForm.reset();productListingForm.dataset.mode='local';productListingForm.dataset.sku=product?.sku||'';setManualProductMode(true);manualPhotoToken='';manualPhotoCount=product?.localPhotoCount||0;
    const fields=productListingForm.elements,saved=productListing(product);fields.productId.value=product?.id||'';fields.manualName.value=product?.name||'';fields.manualStock.value=product?.stock??1;fillListing(productListingForm,saved?.listing);fields.listingPrice.value=moneyInput(saved?.listingPriceCents);fields.minOffer.value=moneyInput(saved?.minOfferCents);
    $('#product-listing-title').textContent=product?'编辑手动商品':'自己添加商品';$('#product-listing-source').textContent=product?`手动商品 · ${product.sku}`:'手动商品无需货盘；编号由系统生成。';$('#manual-photo-count').textContent=manualPhotoCount?`已保存 ${manualPhotoCount} 张本地照片`:'尚未选择照片，可先保存草稿';$('#product-listing-error').hidden=true;renderListingHint(productListingForm,$('#product-listing-readiness'));renderControls();productListingDialog.showModal();
  }
  function salesOnly() { return state.readiness.salesOnly===true; }
  function automaticListing() { const caps=state.readiness.capabilities||{};return Object.hasOwn(caps,'listingPublish')?caps.listingPublish===true:caps.publish===true; }
  function automaticCapabilities() { const caps=state.readiness.capabilities||{};return [
    ['自动刊登',automaticListing()],['消息回复',caps.messages===true],['报价接受',caps.offers===true],
    ...(salesOnly()?[['成交确认',caps.saleConfirmation===true],['卖出后补上',caps.saleConfirmation===true&&automaticListing()]]:[['运单与采购',caps.shippingLabel===true&&caps.procurement===true]])
  ]; }
  function remainingSalesText() { const pending=automaticCapabilities().filter(([,ready])=>!ready).map(([name])=>name);return pending.length?`${pending.join('、')}仍待验证。`:'各项已接通，仍需逐项核对当前账号、商品和页面回执。'; }
  function purchaseJob(job) { return ['fulfillment','procurement','purchase','order','label','shipping_label','shipment'].includes(job?.type); }
  function renderSalesScope() {
    const only=salesOnly();
    document.querySelectorAll('[data-purchase-control]').forEach(node=>{node.hidden=only;node.querySelectorAll('input,select').forEach(field=>{field.disabled=only;});});
    $('#execution-rules-title').textContent=only?'后台售卖规则':'执行与采购规则';
    $('#execution-rules-description').textContent=only?'按计划推进上架与售卖；每一步以当前功能状态和核对回执为准。':'先限定执行范围，再启动持续调度。';
    $('#execution-stop-note').textContent=only?'缺货、图片冲突、页面变化、账号验证或提交结果不明确时，保留原记录并停止该任务，等待核对。':'缺货、图片冲突、页面变化、账户验证、金额不匹配或订单提交结果未知时，保留任务记录并等待核对。';
    $('#association-scope-note').textContent=only?'请在对应环境中打开这次提交的商品详情页。本次检查只读取当前活动页面；确认关联保存已核对的刊登，不会再次发布。':'请在对应环境中打开这次提交的商品详情页。本次检查只读取当前活动页面；确认关联仅保存本机记录，不会再次发布或提交采购。';
    $('#plan-automation-note').textContent=`勾选后保存本计划的规则；${remainingSalesText()}提交结果不明确时停止核对。`;
  }
  function changePage(page) { currentPage = page in pageDetails ? page : 'overview'; document.querySelectorAll('.page-section').forEach(section => { section.hidden = section.id !== `page-${currentPage}`; }); document.querySelectorAll('[data-page]').forEach(button => { const active=button.dataset.page===currentPage; button.classList.toggle('active',active); if(active)button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); }); $('#page-title').textContent=pageDetails[currentPage][0]; $('#page-description').textContent=pageDetails[currentPage][1]; $('#readiness').hidden=currentPage==='accounts';$('.header-actions').hidden=currentPage==='accounts'; }

  function applyState(incoming) {
    if (!incoming || typeof incoming !== 'object') return;
    state = {...state,...incoming,settings:{...state.settings,...incoming.settings},connection:{...state.connection,...incoming.connection},readiness:incoming.readiness?{...incoming.readiness}:state.readiness};
    for (const key of ['profiles','accounts','products','productListings','photoSets','photoPreparations','plans','jobs','events','publications']) if (!Array.isArray(state[key])) state[key]=[];
    reconcilePublicationAttempts();
    if(associationReport){const record=openPublication(associationPlanId);if(!record||record.id!==associationReport.submissionId||record.state!=='uncertain'||record.attemptCount!==1)associationReviewToken='';}
    if(withdrawalReview&&!withdrawalReview.sent&&(!withdrawalEligible(withdrawalReview.planId)||withdrawalSignature(withdrawalReview.planId)!==withdrawalReview.signature||withdrawalBusy()))invalidateWithdrawal('计划、账号或原提交状态已改变。请关闭后重新核对。');
    $('#load-error').hidden = !state.faulted;
    if (state.faulted) $('#load-error').textContent = '运营数据无法安全写入，外部操作已停止。请检查本机存储后重新打开应用。';
    renderSalesScope(); renderSummary(); renderListingWorkflow(); renderPlans(); renderInventory(); renderJobs(); renderEvents(); renderConnection(); renderControls();
    if (!settingsDirty) fillSettings();
    if (jobDialog.open && selectedJobId) renderJobDetail();
    if (photoDialog.open && selectedPhotoPlanId) renderPhotoReport();
    if (preflightDialog.open && reportKind==='publication') renderPageReport();
    if (associationDialog.open) renderAssociationReport();
  }
  function renderControls() {
    const active = !!state.running;
    $('#runner-status').classList.toggle('running',active);
    $('#runner-status').replaceChildren(el('i'),document.createTextNode(active ? ' 调度中' : ' 已暂停'));
    $('#runner-toggle').textContent = pending.has('running') ? '正在更新…' : active ? '暂停调度' : state.settings.backgroundEnabled ? '启动调度' : '配置启动';
    $('#runner-toggle').disabled = pending.has('running') || (!active && (state.faulted || state.configBusy || photoActionPending()));
    $('#runner-toggle').title = !active && !state.settings.backgroundEnabled ? '先在「连接与规则」中保存后台持续调度设置。' : '';
    $('#run-once').disabled = pending.has('once') || !!state.faulted || !!state.configBusy || photoActionPending(); $('#run-once').textContent = pending.has('once') ? '正在执行…' : '执行一轮';
    $('#sync').disabled = pending.has('sync') || pending.has('connect') || photoActionPending(); $('#sync').textContent = pending.has('sync') ? '正在同步…' : '同步货盘';
    $('#connect').disabled = pending.has('connect') || pending.has('settings') || photoActionPending(); $('#connect').textContent = pending.has('connect') ? '正在连接…' : '检查已保存的连接';
    settingsForm.querySelector('[type=submit]').disabled = pending.has('settings') || photoActionPending();
    planForm.querySelector('[type=submit]').disabled = pending.has('plan') || photoActionPending();
    $('#product-listing-save').disabled=productEditorBusy()||!!state.faulted||!!state.configBusy;
    $('#new-manual-product').disabled=productEditorBusy()||typeof api.saveManualProduct!=='function'||!!state.faulted||!!state.configBusy;
    $('#manual-photo-import').disabled=productEditorBusy()||typeof api.importProductPhotos!=='function'||!!state.faulted||!!state.configBusy;
    document.querySelectorAll('[data-product-listing-id]').forEach(button=>{const product=find(state.products,button.dataset.productListingId);button.disabled=productEditorBusy()||typeof api[product?.source==='local'?'saveManualProduct':'saveProductListing']!=='function'||!!state.faulted||!!state.configBusy;});
    $('#new-plan').disabled=$('#overview-new-plan').disabled=photoActionPending();
    $('#reconcile-form [type=submit]').disabled = pending.has('resolve');
    $('#retry-form [type=submit]').disabled = pending.has('resolve') || !!state.running;
    const checking = pageActionPending();
    $('#preflight-fill').hidden=reportKind==='publication';
    const publicationVisible=reportKind==='publication'&&typeof api.submitPublication==='function';
    $('#publication-submit').hidden=!publicationVisible;
    $('#publication-submit').disabled=!publicationVisible||!canSubmitPublication(selectedPlanId)||checking;
    $('#publication-submit').textContent=pending.has(`plan-publication-${selectedPlanId}`)?'正在提交并核对…':'发布商品';
    renderPublicationResult();
    renderAssociationControls();
    renderWithdrawalControls();
    $('#preflight-fill').disabled = checking || !!state.faulted || !selectedPlanId || reportKind==='preflight'&&pageReport?.readyForFields!==true;
    $('#preflight-edit').disabled = checking || !selectedPlanId;
    renderPhotoControls();
    renderDistribution();
    renderAccountControls();renderAccounts();
  }

  function accountsAvailable(){return ['saveAccount','deleteAccount','loginAccount','openAccount','verifyAccount'].every(key=>typeof api[key]==='function');}
  function accountMutationPending(){return [...pending].some(key=>/^account-(?:save|login|delete|verify)/.test(key));}
  function accountBusy(account){return account?.status==='logging_in'||[...pending].some(key=>key.startsWith('account-')&&key.endsWith('-'+account?.id));}
  function accountHasHistory(account){return !!account&&['plans','jobs','photoPreparations','publications'].some(key=>state[key].some(row=>same(row.profileId,account.profileId)));}
  function accountStatus(account){
    if(pending.has('account-login-'+account.id)||account.status==='logging_in')return {key:'logging_in',label:'正在登录',tone:'neutral'};
    if(['logged_in','authenticated','verified'].includes(account.status))return {key:'logged_in',label:'最近登录已核验',tone:'good'};
    if(['awaiting_user','awaiting_result','submitted','manual_required','needs_manual','challenge','uncertain'].includes(account.status))return {key:'attention',label:'需要手动接管',tone:'warn'};
    if(['error','failed','blocked'].includes(account.status))return {key:'attention',label:'登录需要处理',tone:'warn'};
    return {key:'saved',label:'待登录',tone:'neutral'};
  }
  function accountResultText(account){
    const result=account.lastResult;if(!result||result.status==='saved')return account.hasPassword?'登录密码已保存，打开环境后可尝试登录。':'尚未保存密码；可编辑补充，或打开环境手动登录。';
    if(['logged_in','authenticated','verified'].includes(result.status))return '最近一次账号菜单读取已完成；当前会话仍以实际窗口为准。';
    if(['awaiting_user','awaiting_result','submitted','manual_required','needs_manual','challenge','uncertain'].includes(result.status)||/SUBMIT|UNCERTAIN|CHALLENGE|CAPTCHA|MANUAL|AWAIT|MFA|TWO_FACTOR/i.test(result.code||''))return '请手动接管当前窗口，完成登录或验证后点击“核对登录”；不要重复提交结果未明的登录。';
    if(['error','failed','blocked'].includes(result.status))return '最近登录未完成，请检查账号资料并打开窗口处理；遇到验证请手动接管。';
    return '已有登录操作记录，请打开固定环境核对当前页面。';
  }
  function accountProfileText(profile){const os={windows:'Windows',macos:'macOS',linux:'Linux',android:'Android 模拟',ios:'iOS 兼容模拟'};return profile?profile.name+(profile.deviceModel?' · '+profile.deviceModel:profile.operatingSystem&&os[profile.operatingSystem]?' · '+os[profile.operatingSystem]:''):'环境不可用';}
  function accountNotice(result,fallback){return typeof result?.message==='string'&&result.message.length<=300?result.message:fallback;}
  async function accountRequest(key,work,success,failure){
    if(pending.has(key))return {ok:false};pending.add(key);renderControls();
    try{const result=await work();await refresh();toast(accountNotice(result,success));return {ok:true,result};}
    catch(error){const message=failure||'账号操作未完成，请检查固定环境和登录资料后重试。';toast(message);return {ok:false,message};}
    finally{pending.delete(key);renderControls();}
  }
  function renderAccountControls(){
    const available=accountsAvailable(),busy=accountMutationPending(),blocked=!!state.running||!!state.configBusy||!!state.faulted;
    $('#new-account').disabled=!available||busy||blocked;
    $('#account-service-note').textContent=!available?'当前连接尚未提供账号管理接口。':state.faulted?'本机运营存储异常，账号操作已停止。':state.running?'请先暂停运营调度，再添加账号或处理登录。':state.configBusy?'正在处理运营操作，请完成后再管理登录。':!state.profiles.length?'还没有设备环境，请先在浏览器环境管理中创建。':'';
    const saving=pending.has('account-save');for(const field of accountForm.elements)if(field.name)field.disabled=saving;
    accountForm.elements.profileId.disabled=saving||accountProfileLocked;
    $('#account-save').disabled=!available||saving||blocked;$('#account-save').textContent=saving?'正在保存…':'保存账号';
    $('#account-verify-confirm').disabled=!available||busy||blocked||!find(state.accounts,accountVerifyId);
    $('#account-delete-confirm').disabled=!available||busy||blocked||!find(state.accounts,accountDeleteId);
  }
  function renderAccounts(){
    const root=$('#accounts-list'),query=$('#account-search').value.trim().toLowerCase(),filter=$('#account-status').value;root.replaceChildren();
    const accounts=state.accounts.filter(account=>(!query||[account.label,account.login,account.identity?.username,profileName(account.profileId)].join(' ').toLowerCase().includes(query))&&(!filter||accountStatus(account).key===filter));
    $('#account-count').textContent=accounts.length+' / '+state.accounts.length+' 个账号';$('#nav-account-count').textContent=state.accounts.length;$('#nav-account-count').hidden=!state.accounts.length;
    if(!accounts.length){root.append(empty(state.accounts.length?'没有符合筛选条件的账号。':'添加 Vinted 账号，并为它选择一个固定设备环境。'));return;}
    for(const account of accounts){
      const profile=find(state.profiles,account.profileId),status=accountStatus(account),card=el('article','account-card'),heading=el('div','account-card-heading'),title=el('div','account-title'),metrics=el('dl','account-metrics');card.dataset.accountId=String(account.id);
      title.append(el('h3','',account.label||'Vinted 账号'),el('p','account-login-name',account.login));heading.append(title,badge(status.label,status.tone));card.append(heading);
      const identity=account.identity;for(const [name,value] of [['固定环境',accountProfileText(profile)],['环境状态',profile?{closed:'已关闭',running:'运行中',starting:'正在启动'}[profile.status]||'待确认':'环境不可用'],['保存密码',account.hasPassword?'已保存':'未保存'],['上次登录',when(account.lastLoginAt)],['最近核验',identity?identity.username+' · '+when(identity.verifiedAt):'尚未核验']])metrics.append(el('dt','',name),el('dd','',value));card.append(metrics);
      card.append(el('p','account-result '+(status.key==='attention'?'needs-attention':''),accountResultText(account)));
      if(accountHasHistory(account))card.append(el('p','account-history-note','这个环境已有运营记录，账号与原环境的历史关联将保留。'));
      const actions=el('div','account-actions'),blocked=!accountsAvailable()||!!state.faulted||!!state.running||!!state.configBusy,busy=accountBusy(account);
      const login=makeButton(pending.has('account-login-'+account.id)?'正在登录…':'打开并登录',()=>accountRequest('account-login-'+account.id,()=>api.loginAccount(account.id),'已打开固定环境，请查看登录结果。'),'primary');login.disabled=blocked||!profile||busy||accountMutationPending();
      const open=makeButton('手动接管',()=>accountRequest('account-open-'+account.id,()=>api.openAccount(account.id),'已打开固定环境，请手动处理当前页面。'));open.disabled=typeof api.openAccount!=='function'||!profile||pending.has('account-open-'+account.id)||!!state.faulted;
      const verify=makeButton('核对登录',()=>confirmAccount(account,'verify'));verify.disabled=blocked||!profile||busy||accountMutationPending();
      const edit=makeButton('编辑',()=>editAccount(account));edit.disabled=blocked||busy||accountMutationPending();
      const remove=makeButton('删除',()=>confirmAccount(account,'delete'));remove.disabled=blocked||busy||accountMutationPending()||profile&&profile.status!=='closed'||accountHasHistory(account);remove.title=accountHasHistory(account)?'关联运营历史的账号需要保留。':profile&&profile.status!=='closed'?'请先关闭固定环境窗口。':'';
      actions.append(login,open,verify,edit,remove);card.append(actions);root.append(card);
    }
  }
  function editAccount(account){
    accountForm.reset();const fields=accountForm.elements;fields.id.value=account?.id||'';fields.label.value=account?.label||'';fields.login.value=account?.login||'';fields.password.value='';fields.password.placeholder=account?.hasPassword?'已保存，留空保留原密码':'可选：保存后用于登录';
    fields.profileId.replaceChildren(new Option('选择已有浏览器环境',''));for(const profile of state.profiles){const used=state.accounts.some(other=>!same(other.id,account?.id)&&same(other.profileId,profile.id)),option=new Option(accountProfileText(profile)+(used?' · 已关联其他账号':profile.status!=='closed'?' · 请先关闭窗口':''),String(profile.id));option.disabled=used||profile.status!=='closed'&&!same(profile.id,account?.profileId);fields.profileId.add(option);}fields.profileId.value=account?.profileId||'';
    if(!account&&state.profiles.length===1&&!fields.profileId.options[1]?.disabled)fields.profileId.value=String(state.profiles[0].id);
    accountProfileLocked=!!account&&(accountHasHistory(account)||find(state.profiles,account.profileId)?.status!=='closed');
    $('#account-title').textContent=account?'编辑账号':'添加账号';$('#account-password-hint').textContent=account?.hasPassword?'密码已经保存，留空会保留原密码；输入新密码会替换。密码不会回显。':'可以暂不保存密码，使用已有会话或手动登录；自动填写密码前需在这里补充。';
    $('#account-profile-hint').textContent=accountProfileLocked?'当前窗口仍在运行或已有运营历史，固定环境暂不能更换。':'请选择未关联其他账号的已关闭环境。设备方案在浏览器环境管理中配置。';$('#account-error').hidden=true;renderAccountControls();accountDialog.showModal();
  }
  function accountConfirmationSummary(root,account){root.replaceChildren();const grid=el('dl','detail-grid');for(const [label,value] of [['账号名称',account.label],['登录名',account.login],['固定环境',accountProfileText(find(state.profiles,account.profileId))]])grid.append(el('dt','',label),el('dd','',value));root.append(grid);}
  function confirmAccount(account,action,planId=''){if(action==='verify'){accountVerifyId=String(account.id);accountVerifyPlanId=String(planId);$('#account-verify-feedback').hidden=true;accountConfirmationSummary($('#account-verify-summary'),account);renderAccountControls();accountVerifyDialog.showModal();}else{accountDeleteId=String(account.id);accountConfirmationSummary($('#account-delete-summary'),account);renderAccountControls();accountDeleteDialog.showModal();}}
  function setPlanAccountReport(id,status,message){if(!id)return;planAccountReports.set(String(id),{status,message});renderPlans();renderDistribution();}
  async function inspectPlanAccount(id){
    const plan=find(state.plans,id);if(!plan||pageActionPending()||accountMutationPending())return;
    const saved=state.accounts.find(account=>same(account.profileId,plan.profileId));
    if(!hasBoundAccount(plan.profileId)&&saved&&typeof api.verifyAccount==='function'){confirmAccount(saved,'verify',id);return;}
    setPlanAccountReport(id,'checking','正在读取当前环境的登录账号…');
    try{const result=await request(`plan-preflight-account-${id}`,()=>api.inspectAccount(id));if(!result?.account?.memberId||!result.account.username)throw Error('没有读取到可核验的账号身份，请在账号中心核对登录。');setPlanAccountReport(id,'verified',`已核对账号：${result.account.username} · ID ${result.account.memberId}${result.usernameSource==='saved-binding'?'（用户名沿用已验证绑定）':''}`);}
    catch(error){setPlanAccountReport(id,'failed',cleanError(error));}
  }
  function renderSummary() {
    const active=state.plans.filter(plan=>plan.enabled), attention=state.jobs.filter(job=>reviewStates.has(job.state));
    $('#stat-plans').textContent=active.length; $('#stat-profiles').textContent=`覆盖 ${new Set(active.map(plan=>plan.profileId)).size} 个环境`;
    $('#stat-products').textContent=state.products.length; $('#stat-photo-sets').textContent=`${state.photoSets.length} 套图片`;
    $('#stat-complete').textContent=state.jobs.filter(job=>completedStates.has(job.state)).length; $('#stat-review').textContent=attention.length;
    $('#nav-review-count').textContent=attention.length; $('#nav-review-count').hidden=!attention.length;
    const capabilities=state.readiness.capabilities||{}, automatic=automaticCapabilities(), available=automatic.filter(([,ready])=>ready), allReady=automatic.length>0&&available.length===automatic.length;
    const manualPublish=typeof api.inspectPublication==='function'&&typeof api.submitPublication==='function';
    const association=typeof api.inspectPublishedListing==='function'&&typeof api.associatePublishedListing==='function';
    $('#readiness').classList.toggle('ready',allReady);
    $('#readiness-title').textContent=available.length?(allReady?`${salesOnly()?'后台售卖':'后台业务'}流程可用`:'后台部分流程可用'):`${manualPublish?'手动上架可用':'资料准备可用'} · 后台业务待验证`;
    $('#readiness-message').textContent=available.length?`后台可按计划执行${available.map(([name])=>name).join('、')}。${automaticListing()&&capabilities.autoOpenProfile===true?'上架时会自动打开已绑定的账号环境，无需逐个手动打开。':''}每个步骤核对账号、商品和回执；提交结果不明确时停止并保留原记录。`:manualPublish?'可准备资料和照片，逐项核对后手动发布一次。启动调度不会启用下方仍待验证的业务。':'可连接货盘、保存计划并准备资料和照片；当前版本尚未提供手动发布入口。';
    const capabilityList=$('#readiness-capabilities');capabilityList.replaceChildren();
    for(const [name,available,detail] of [
      ['资料与照片',capabilities.inspect!==false&&typeof api.prepareDraft==='function'&&typeof api.uploadPhotos==='function','可准备'],
      ['手动发布',manualPublish,'核对后可用'],
      ['原刊登关联',association,'核对后可用'],
      ...automatic.map(([name,ready])=>[name,ready,'可用'])
    ]){const item=el('li');item.append(el('span','',name),badge(available?detail:name==='手动发布'||name==='原刊登关联'?'未接通':'待验证',available?'good':'neutral'));capabilityList.append(item);}
    const unresolved=state.plans.filter(plan=>(openPublication(plan.id)&&!publishedPublication(plan.id))||publicationAttempts.has(String(plan.id))), inspectable=unresolved.filter(plan=>canInspectAssociation(plan.id)).length;
    $('#readiness-next').hidden=!unresolved.length;
    $('#readiness-next').textContent=unresolved.length?`${unresolved.length} 个计划的发布结果待核对。${inspectable?`${inspectable} 个可在对应环境打开原商品页后，点击「核对原刊登」。`:''}${inspectable<unresolved.length?`${inspectable?'其余计划':'请'}查看「任务记录」与原页面，保留原提交等待人工核对。`:''}不要重复发布。`:'';
    $('#workflow-status').textContent=allReady?'各项流程可用':available.length?'部分流程可用':'后台业务待验证'; $('#workflow-status').className=`pill ${allReady?'good':'neutral'}`;
    $('#operations-runner-title').textContent=state.faulted?'运营存储异常，执行已停止':state.running?'后台调度已启动':state.configBusy?'正在处理连接或照片配置':state.settings.backgroundEnabled?'后台已暂停':'后台持续调度未开启';
    const running=state.jobs.filter(job=>job.state==='running').length, queued=state.jobs.filter(job=>['queued','pending','retry_wait'].includes(job.state)).length;
    $('#operations-runner-summary').textContent=`${new Set(active.map(plan=>plan.profileId)).size} 个已配置环境 · 最多并行 ${number(state.settings.maxConcurrent)||1} 个环境 · ${running} 个任务执行中`;
    $('#operations-runner-detail').replaceChildren(badge(`${queued} 个任务等待处理`),badge(`${attention.length} 个任务需要核对`,attention.length?'warn':'neutral'),...(!available.length?[badge('自动业务尚未启用','warn')]:[]),...automatic.map(([name,ready])=>badge(`${name}：${ready?'可用':'待验证'}`,ready?'good':'neutral')));
  }
  function sortedPlanJobs(id) {
    return state.jobs.filter(job=>same(job.planId,id)).sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')));
  }
  function operationState(plan) {
    const jobs=sortedPlanJobs(plan.id), review=jobs.find(job=>reviewStates.has(job.state)), running=jobs.find(job=>job.state==='running'), waiting=jobs.find(job=>!completedStates.has(job.state)&&!cancelledStates.has(job.state)), job=review||running||waiting||jobs[0];
    const error=typeof review?.error==='string'?review.error:typeof review?.error?.message==='string'?review.error.message:'';
    if(state.faulted)return {key:'attention',label:'执行已停止',tone:'warn',next:'修复本机运营存储，再核对原任务记录。',job};
    if(!find(state.profiles,plan.profileId))return {key:'attention',label:'环境不可用',tone:'warn',next:'核对计划关联的浏览器环境。',job};
    if(openPublication(plan.id)&&!publishedPublication(plan.id)||publicationAttempts.has(String(plan.id)))return {key:'attention',label:'发布结果待核对',tone:'warn',next:'已有一次发布调用或提交记录，请核对原刊登页面，不要重复点击发布。',job};
    if(review)return {key:'attention',label:stateNames[review.state]||'需要核对',tone:'warn',next:error||'打开任务记录，核对当前页面和原回执。',job};
    if(running)return {key:'running',label:'执行中',tone:'good',next:`${jobNames[running.type]||running.type} · ${stepNames[running.step]||running.step||'正在执行'}`,job};
    if(waiting?.scheduling&&['waiting','blocked','paused'].includes(waiting.scheduling.state))return {key:'pending',label:waiting.scheduling.state==='blocked'?'等待核对':waiting.scheduling.state==='paused'?'已暂停':'等待条件',tone:waiting.scheduling.state==='blocked'?'warn':'neutral',next:[waiting.scheduling.reason,waiting.scheduling.nextAction].filter(Boolean).join(' '),job};
    if(waiting?.scheduling?.state==='ready'&&waiting.scheduling.reasonCode==='PROFILE_AUTO_OPEN')return {key:'pending',label:'等待自动打开',tone:'neutral',next:[state.running?'': '启动调度后执行。',waiting.scheduling.reason,waiting.scheduling.nextAction].filter(Boolean).join(' '),job};
    if(plan.activeListingId){const caps=state.readiness.capabilities||{},enabled=[...(plan.autoReply&&caps.messages===true?['回复消息']:[]),...(plan.autoAcceptOffers&&caps.offers===true?['接受符合底价的报价']:[]),...(caps.saleConfirmation===true?['确认成交']:[])];return {key:'listed',label:'已有在售记录',tone:'good',next:!plan.enabled?'计划已停用；已保存的刊登记录仍保留。':`${enabled.length?`${state.running?'按计划':'启动调度后可'}${enabled.join('、')}。`:'刊登记录已保存。'}${remainingSalesText()}`,job};}
    if(waiting&&waiting.type!=='listing')return {key:plan.enabled?'pending':'paused',label:plan.enabled?'待执行':'计划未启用',tone:'neutral',next:`${jobNames[waiting.type]||waiting.type} · ${stepNames[waiting.step]||waiting.step||'等待执行条件'}`,job};
    if(number(plan.targetCount)>0&&number(plan.completedCount)>=number(plan.targetCount))return {key:'target_reached',label:'目标已达成',tone:'good',next:'累计销售目标已完成，不再补充上架。',job};
    if(!plan.enabled)return {key:'paused',label:'计划未启用',tone:'neutral',next:'尚无在售回执；核对资料后启用计划。',job};
    if(!automaticListing())return {key:'pending',label:'待发布',tone:'neutral',next:typeof api.submitPublication==='function'?'准备资料与照片，点击「核对发布条件」。全部通过后可手动发布；后台自动刊登尚未启用。':'准备资料与照片，核对当前页面。此版本尚未提供手动发布入口。',job};
    return {key:'pending',label:'待发布',tone:'neutral',next:state.running?'等待同一环境的前序任务结束，再检查上架条件。':'启动调度后检查库存、图片与刊登资料。',job};
  }
  function listingReceiptURL(plan) {
    if(!/^\d+$/.test(String(plan.activeListingId||''))||typeof plan.activeListingUrl!=='string')return '';
    try{
      const url=new URL(plan.activeListingUrl), id=url.pathname.match(/^\/items\/(\d+)(?:-[^/]*)?\/?$/)?.[1];
      return url.protocol==='https:'&&url.hostname==='www.vinted.fr'&&!url.port&&!url.username&&!url.password&&id===String(plan.activeListingId)&&!url.search&&!url.hash?url.href:'';
    }catch{return '';}
  }
  function openPublications(id) { return state.publications.filter(record=>same(record.planId,id)&&record.closedSale!==true&&record.closedWithdrawal!==true&&record.state!=='cancelled'); }
  function openPublication(id) { return openPublications(id)[0]; }
  function publishedPublication(id) { const record=openPublication(id);return record?.state==='published'&&find(state.plans,id)?.activeListingId?record:null; }
  function publicationOccupied(plan) { return !!plan.activeListingId||!!openPublication(plan.id)||publicationAttempts.has(String(plan.id)); }
  function reconcilePublicationAttempts() {
    for(const [planId,attempt] of publicationAttempts){
      if(attempt.submissionId&&state.publications.some(record=>same(record.planId,planId)&&record.id===attempt.submissionId&&(record.state==='published'||record.closedWithdrawal===true)))publicationAttempts.delete(planId);
    }
  }
  function publicationPlanSignature(id) {
    const plan=find(state.plans,id),account=find(state.profiles,plan?.profileId)?.marketAccount,photos=photoSummary(id);
    return plan?JSON.stringify({id:plan.id,profileId:plan.profileId,productId:plan.productId,sku:plan.sku,enabled:plan.enabled,activeListingId:plan.activeListingId||null,listingRevision:plan.listingRevision||0,targetCount:plan.targetCount,completedCount:plan.completedCount,currency:plan.currency,price:plan.listingPriceCents,listing:plan.listing,account:account?.memberId,claimId:photos?.claimId,photoState:photos?.state}):'';
  }
  function canSubmitPublication(id) {
    const plan=find(state.plans,id),account=find(state.profiles,plan?.profileId)?.marketAccount;
    return !!plan&&plan.enabled===true&&!plan.activeListingId&&account?.platform==='vinted-fr'&&!!account.username&&!!account.verifiedAt&&photoSummary(id)?.ready===true&&reportKind==='publication'&&selectedPlanId===String(id)&&pageReport?.readyForPublication===true&&pageReport.manualPublicationEnabled!==false&&publicationReviewedPlan===publicationPlanSignature(id)&&!openPublication(id)&&!publicationAttempts.has(String(id))&&!state.running&&!state.configBusy&&!state.faulted;
  }
  function renderPublicationResult() {
    const result=$('#publication-submission-result');result.replaceChildren();result.hidden=reportKind!=='publication';if(result.hidden)return;
    const record=openPublication(selectedPlanId),attempt=publicationAttempts.get(String(selectedPlanId));
    if(publishedPublication(selectedPlanId)&&!attempt){
      result.append(el('div','report-status good','已核对发布成功，刊登回执已保存。'),el('p','field-hint',`提交记录：${record.id}`),el('p','field-hint',`在售商品编号：${find(state.plans,selectedPlanId).activeListingId}`),el('p','field-hint',`已有在售商品，不能重复发布。${remainingSalesText()}`));appendWithdrawalAction(result,selectedPlanId);return;
    }
    if(record||attempt){
      const message=attempt?.pending?'正在发送一次发布请求并核对页面，请保持当前环境打开。':attempt?.message||record?.reason||'原发布提交记录尚未完成核对，请查看原刊登页面。';
      result.append(el('div','report-status warn',attempt?.pending?'正在提交，尚未确认发布结果。':'发布结果待核对，请勿重复点击发布。'),el('p','field-hint',message));
      const id=attempt?.submissionId||record?.id;if(id)result.append(el('p','field-hint',`提交记录：${id}`));
      if(attempt?.clickIssued===true)result.append(el('p','field-hint','已发送一次页面点击；目前没有已验证的发布成功回执。'));
      if(canInspectAssociation(selectedPlanId)){const inspect=makeButton('核对原刊登',()=>openAssociation(selectedPlanId));inspect.disabled=pageActionPending()||!!state.running||!!state.configBusy||!!state.faulted;result.append(inspect);}
      appendWithdrawalAction(result,selectedPlanId);
      return;
    }
    if(pageReport?.readyForPublication===true)result.append(el('p','publication-submit-note',pageReport.manualPublicationEnabled===false?'当前版本尚未启用手动发布。':canSubmitPublication(selectedPlanId)?'点击「发布商品」会将本计划商品刊登到当前已核对的 Vinted 账号。提交后需核对真实刊登回执。':'发布前请确认计划已启用、账号和本机照片已核对，并暂停后台调度。资料变更后须重新核对发布条件。'));
  }
  async function submitPublication() {
    const id=selectedPlanId;if(pageActionPending()||typeof api.submitPublication!=='function'||!canSubmitPublication(id))return;
    // Retain an uncertain local marker even when IPC rejects or state refresh
    // fails. Only the main process can establish whether a click was issued.
    publicationAttempts.set(id,{pending:true});
    try{
      const result=await request(`plan-publication-${id}`,()=>api.submitPublication(id));
      publicationAttempts.set(id,{pending:false,submissionId:typeof result?.submissionId==='string'?result.submissionId:'',clickIssued:result?.clickIssued===true,message:typeof result?.message==='string'?result.message:'本次提交需要核对原网页和提交记录，请勿重复点击。'});
    }catch(error){publicationAttempts.set(id,{pending:false,message:`${cleanError(error)} 请核对原网页和提交记录，不要重复点击发布。`});}
    finally{reconcilePublicationAttempts();renderSummary();renderPageReport();renderControls();renderPlans();renderDistribution();}
  }
  function canInspectAssociation(id) {
    const record=openPublication(id);return !!record&&record.state==='uncertain'&&record.attemptCount===1&&typeof api.inspectPublishedListing==='function';
  }
  function canAssociateListing() {
    const record=openPublication(associationPlanId);
    return associationDialog.open&&canInspectAssociation(associationPlanId)&&typeof api.associatePublishedListing==='function'&&associationReport?.readyForAssociation===true&&associationReport.photoSignatureMatched===true&&associationReport.planId===associationPlanId&&associationReport.submissionId===record.id&&associationReviewToken.length>0&&associationReviewToken.length<=4096&&!associationResult&&!associationError&&!pageActionPending()&&!state.running&&!state.configBusy&&!state.faulted;
  }
  function renderAssociationControls() {
    const blocked=pageActionPending()||!!state.running||!!state.configBusy||!!state.faulted;
    $('#publication-association-inspect').disabled=blocked||!canInspectAssociation(associationPlanId)||!!associationResult;
    $('#publication-association-inspect').textContent=pending.has(`plan-publication-inspect-${associationPlanId}`)?'正在读取…':'重新读取当前商品';
    $('#publication-association-confirm').disabled=!canAssociateListing();
    $('#publication-association-confirm').textContent=pending.has(`plan-publication-associate-${associationPlanId}`)?'正在保存关联…':'关联已核对刊登';
    $('#publication-association-confirmation').hidden=!canAssociateListing();
  }
  function renderAssociationReport() {
    const detail=$('#publication-association-detail'),plan=find(state.plans,associationPlanId),record=openPublication(associationPlanId);detail.replaceChildren();
    detail.append(el('p','report-plan',`${plan?.name||productName(plan?.productId)} · ${profileName(plan?.profileId)}`));
    if(record)detail.append(el('p','field-hint',`原提交记录：${record.id}`));
    if(associationResult){detail.append(el('div','report-status good','已保存本机关联。'),el('p','field-hint',`在售商品编号：${associationResult.listingId}`),el('p','field-hint',salesOnly()?'本次记录已核对的原刊登，没有重新发布。':'本次仅记录已核对的刊登，没有重新发布或提交采购。'));renderAssociationControls();return;}
    if(associationError)detail.append(el('div','form-error',associationError));
    if(!associationReport){if(!associationError)detail.append(el('p','report-loading','正在读取对应环境的当前商品页…'));renderAssociationControls();return;}
    const report=associationReport,grid=el('dl','detail-grid');
    if(typeof report.listingId==='string')grid.append(el('dt','','当前商品编号'),el('dd','',report.listingId));
    const url=listingReceiptURL({activeListingId:report.listingId,activeListingUrl:report.url});if(url)grid.append(el('dt','','当前商品地址'),el('dd','',url));
    grid.append(el('dt','','照片自动对应'),el('dd','',report.photoSignatureMatched===true?'图片回执匹配':'尚未自动确认，当前不能关联刊登'));detail.append(grid);
    if(Array.isArray(report.checks)){const checks=el('div','report-checks');for(const item of report.checks.slice(0,60)){const row=el('div','report-check'),body=el('div');body.append(el('b','',typeof item.name==='string'?item.name:'检查项'));if(typeof item.detail==='string')body.append(el('p','',item.detail));row.append(badge(item.ok===true?'已通过':'待核对',item.ok===true?'good':'warn'),body);checks.append(row);}detail.append(checks);}
    reportList(detail,'仍需处理',report.blockers,'warning');if(typeof report.message==='string')detail.append(el('p','field-hint',report.message));
    if(!record||record.id!==report.submissionId||record.state!=='uncertain')detail.append(el('p','photo-result-warning','原提交记录状态已改变，不能使用这次检查关联。'));
    renderAssociationControls();
  }
  async function openAssociation(id) {
    if(pageActionPending()||!canInspectAssociation(id)||state.running||state.configBusy||state.faulted)return;
    associationPlanId=String(id);associationReport=null;associationReviewToken='';associationError='';associationResult=null;
    if(preflightDialog.open)preflightDialog.close();renderAssociationReport();if(!associationDialog.open)associationDialog.showModal();await inspectAssociation();
  }
  async function inspectAssociation() {
    const id=associationPlanId;if(pageActionPending()||!canInspectAssociation(id)||state.running||state.configBusy||state.faulted)return;
    associationReport=null;associationReviewToken='';associationError='';associationResult=null;renderAssociationReport();
    try{const report=await request(`plan-publication-inspect-${id}`,()=>api.inspectPublishedListing(id));if(associationPlanId===id){if(report?.planId!==id||report?.submissionId!==openPublication(id)?.id)throw Error('检查结果与原提交记录不匹配，请重新读取当前商品。');const {reviewToken,...details}=report;associationReport=details;associationReviewToken=associationDialog.open&&typeof reviewToken==='string'?reviewToken:'';}}
    catch(error){if(associationPlanId===id)associationError=cleanError(error);}
    finally{if(associationPlanId===id)renderAssociationReport();renderControls();}
  }
  async function associateListing() {
    if(!canAssociateListing())return;
    const id=associationPlanId,token=associationReviewToken,listingId=associationReport.listingId;associationReviewToken='';
    try{const result=await request(`plan-publication-associate-${id}`,()=>api.associatePublishedListing(id,token));if(associationPlanId===id){if(result?.associated!==true||String(result.listingId)!==String(listingId))throw Error('本机关联返回结果需要核对，请重新读取状态。');associationResult={listingId:String(result.listingId)};}}
    catch(error){if(associationPlanId===id)associationError=`${cleanError(error)} 请核对原记录；本页面不会重新发布商品。`;}
    finally{if(associationPlanId===id)renderAssociationReport();renderControls();renderDistribution();}
  }
  function withdrawalBusy() {
    return !!state.running||!!state.configBusy||!!state.faulted||pending.size>0||state.jobs.some(job=>job.state==='running')||(state.queue?.profiles||[]).some(profile=>profile.state==='running');
  }
  function withdrawalEligible(id) {
    const plan=find(state.plans,id),records=openPublications(id),record=records[0],profile=find(state.profiles,plan?.profileId),account=profile?.marketAccount;
    return typeof api.confirmDeletedListing==='function'&&!!plan&&records.length===1&&['uncertain','published'].includes(record.state)&&record.attemptCount===1&&same(record.profileId,plan.profileId)&&same(record.productId,plan.productId)&&account?.platform==='vinted-fr'&&!!account.memberId&&!!account.username&&!!account.verifiedAt;
  }
  function withdrawalSignature(id) {
    const plan=find(state.plans,id),profile=find(state.profiles,plan?.profileId);
    return JSON.stringify({plan,records:openPublications(id),profile:profile?{id:profile.id,status:profile.status,account:profile.marketAccount}:null,jobs:state.jobs.filter(job=>same(job.planId,id)).map(job=>({id:job.id,state:job.state,step:job.step,updatedAt:job.updatedAt,mutationPending:job.mutationPending}))});
  }
  function withdrawalURL(value) {
    try{const url=new URL(String(value||'').trim()),id=url.pathname.match(/^\/items\/([1-9]\d*)(?:-[^/]*)?\/?$/)?.[1];return url.protocol==='https:'&&url.hostname==='www.vinted.fr'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&id?{url:url.href,id}:null;}catch{return null;}
  }
  function invalidateWithdrawal(message) {
    if(!withdrawalReview||withdrawalReview.sent)return;
    withdrawalReview.invalid=true;withdrawalError=message;$('#publication-withdrawal-confirmed').checked=false;
  }
  function appendWithdrawalAction(container,id) {
    if(!withdrawalEligible(id))return;
    const button=makeButton('已删除，重新上架',()=>openWithdrawal(id));button.disabled=withdrawalBusy();button.title=state.running?'请先暂停调度并等待当前步骤结束，再确认删除。':'仅在原商品已从 Vinted 删除且未售出时使用。';container.append(button);
  }
  function renderWithdrawalControls() {
    const review=withdrawalReview;
    if(review&&!review.sent&&!review.invalid&&(Date.now()>=review.expiresAt||withdrawalBusy()||!withdrawalEligible(review.planId)||withdrawalSignature(review.planId)!==review.signature))invalidateWithdrawal(Date.now()>=review.expiresAt?'确认已过期。请关闭后重新核对原商品。':'计划、账号或原提交状态已改变。请关闭后重新核对。');
    const supplied=withdrawalURL($('#publication-withdrawal-url').value),original=review&&withdrawalURL(review.originalURL),valid=!!review&&!review.sent&&!review.invalid&&!withdrawalError&&withdrawalDialog.open&&!withdrawalBusy()&&!!supplied&&(!original||original.id===supplied.id)&&$('#publication-withdrawal-confirmed').checked;
    $('#publication-withdrawal-submit').disabled=!valid;
    $('#publication-withdrawal-submit').textContent=review?.sent&&!withdrawalResult&&!withdrawalError?'正在保存…':'确认并重新排队';
    $('#publication-withdrawal-url').disabled=$('#publication-withdrawal-confirmed').disabled=!review||review.sent||review.invalid||!!withdrawalResult;
    $('#publication-withdrawal-error').hidden=!withdrawalError;$('#publication-withdrawal-error').textContent=withdrawalError;
    $('#publication-withdrawal-result').hidden=!withdrawalResult;$('#publication-withdrawal-result').textContent=withdrawalResult;
  }
  function openWithdrawal(id) {
    if(withdrawalBusy()||!withdrawalEligible(id))return;
    const plan=find(state.plans,id),record=openPublication(id),account=find(state.profiles,plan.profileId)?.marketAccount;
    clearTimeout(withdrawalTimer);withdrawalError='';withdrawalResult='';
    withdrawalReview={planId:String(id),submissionId:record.id,signature:withdrawalSignature(id),originalURL:typeof record.listingUrl==='string'?record.listingUrl:'',completedCount:plan.completedCount,expiresAt:Date.now()+180000,sent:false,invalid:false};
    const summary=$('#publication-withdrawal-summary');summary.replaceChildren(el('p','',`${plan.name||productName(plan.productId)} · ${profileName(plan.profileId)}`),el('p','',`账号：${account.username} · 原提交：${record.id}`),el('p','',`累计成交：${number(plan.completedCount)} / ${number(plan.targetCount)}（此次删除不计销量）`));
    $('#publication-withdrawal-url').value=withdrawalReview.originalURL;$('#publication-withdrawal-confirmed').checked=false;
    if(preflightDialog.open)preflightDialog.close();if(associationDialog.open)associationDialog.close();if(!withdrawalDialog.open)withdrawalDialog.showModal();renderWithdrawalControls();
    withdrawalTimer=setTimeout(()=>{invalidateWithdrawal('确认已过期。请关闭后重新核对原商品。');renderWithdrawalControls();},180000);
  }
  async function confirmWithdrawal() {
    renderWithdrawalControls();if($('#publication-withdrawal-submit').disabled)return;
    const review=withdrawalReview,url=withdrawalURL($('#publication-withdrawal-url').value);review.sent=true;clearTimeout(withdrawalTimer);renderWithdrawalControls();
    try{
      await request(`plan-publication-withdrawal-${review.planId}`,()=>api.confirmDeletedListing(review.planId,{submissionId:review.submissionId,listingURL:url.url,confirmed:true}));
      const record=state.publications.find(item=>item.id===review.submissionId&&same(item.planId,review.planId)),plan=find(state.plans,review.planId);
      if(record?.closedWithdrawal!==true||!plan||plan.completedCount!==review.completedCount)throw Error('返回记录需要重新核对，请查看任务记录；不要再次确认。');
      publicationAttempts.delete(review.planId);publicationReviewedPlan='';
      if(withdrawalReview===review){withdrawalResult='已记录原商品删除并重新排队，累计销量保持不变。启动调度后将重新核对并上架。';withdrawalError='';}
      toast('原商品已记为删除，重新上架任务已排队。');
    }catch(error){if(withdrawalReview===review)withdrawalError=`${cleanError(error)} 请关闭后重新读取状态；本次不会自动再次提交。`;}
    finally{renderWithdrawalControls();renderSummary();renderPlans();renderDistribution();renderControls();}
  }
  function showPlanJobs(id) {
    jobPlanFilter=String(id);$('#job-filter').value='';renderJobs();changePage('jobs');
  }
  function renderDistribution() {
    const select=$('#distribution-profile'), selected=select.value;
    const profiles=[...state.profiles];
    for(const plan of state.plans)if(!profiles.some(profile=>same(profile.id,plan.profileId)))profiles.push({id:plan.profileId,name:'环境不可用'});
    populateSelect(select,profiles,'全部环境',selected);
    const query=$('#distribution-search').value.trim().toLowerCase(), profileId=select.value, status=$('#distribution-status').value, groups=new Map();
    for(const product of state.products)groups.set(String(product.id),{product,plans:[]});
    for(const plan of state.plans){const id=String(plan.productId);if(!groups.has(id))groups.set(id,{product:{id:plan.productId,name:plan.name||'货盘中暂无此商品',sku:plan.sku},plans:[]});groups.get(id).plans.push(plan);}
    const rows=[];
    for(const group of groups.values()){
      if(!`${group.product.name||''} ${group.product.sku||''}`.toLowerCase().includes(query))continue;
      if(!group.plans.length){if(!profileId&&(!status||status==='unassigned'))rows.push({...group,operations:[]});continue;}
      const operations=group.plans.map(plan=>({plan,operation:operationState(plan)})).filter(({plan,operation})=>(!profileId||same(plan.profileId,profileId))&&(!status||operation.key===status));
      if(operations.length)rows.push({...group,operations});
    }
    const list=$('#distribution-list');list.replaceChildren();
    $('#distribution-count').textContent=`${rows.length} 件商品 · ${rows.reduce((total,group)=>total+group.operations.length,0)} 个环境计划${rows.length>distributionLimit?` · 当前显示前 ${distributionLimit} 件`:''}`;
    $('#distribution-more').hidden=rows.length<=distributionLimit;
    if(!rows.length){list.append(empty(groups.size?'没有符合筛选条件的商品。':'同步货盘后，在这里为商品分配销售环境。'));return;}
    const checking=pageActionPending(), disabled=checking||!!state.faulted||!!state.configBusy;
    for(const group of rows.slice(0,distributionLimit)){
      const card=el('article','distribution-product');card.dataset.productId=String(group.product.id);
      const head=el('div','distribution-product-head'), title=el('div');title.append(el('h3','',group.product.name||'未命名商品'),el('p','',`SKU ${group.product.sku||'—'} · ${group.plans.length} 个环境计划`));
      const add=makeButton(group.plans.length?'添加销售环境':'分配销售环境',()=>editPlan(null,group.product.id));add.disabled=disabled||!find(state.products,group.product.id);head.append(title,add);card.append(head);
      if(!group.operations.length)card.append(el('p','distribution-unassigned','尚未分配到销售环境。设置售价、底价和累计目标后保存计划。'));
      for(const {plan,operation} of group.operations){
        const row=el('section','distribution-row');row.dataset.planId=String(plan.id);row.dataset.operation=operation.key;
        const heading=el('div','distribution-row-heading'), name=el('div','distribution-environment'), account=find(state.profiles,plan.profileId)?.marketAccount;
        name.append(el('b','',profileName(plan.profileId)),el('small','','Vinted · 法国站 / EUR'),el('small','distribution-account',account?.platform==='vinted-fr'&&typeof account.username==='string'&&account.username&&account.verifiedAt?`绑定账号：${account.username}（历史核对）`:'账号未核对'));
        const states=el('div','distribution-badges');states.append(badge(operation.label,operation.tone),badge(plan.enabled?'计划已启用':'计划未启用'));heading.append(name,states);
        const metrics=el('dl','distribution-metrics');for(const [label,value] of [['上架价格',currency(plan.listingPriceCents)],['最低接受价格',currency(plan.minOfferCents)],['累计成交 / 目标',`${number(plan.completedCount)} / ${number(plan.targetCount)}`],['实际在售编号',plan.activeListingId?String(plan.activeListingId):publicationOccupied(plan)?'原发布结果待核对':'待发布 · 暂无回执']]){const metric=el('div','distribution-metric');metric.append(el('dt','',label),el('dd','',value));metrics.append(metric);}
        const next=el('div',`distribution-next ${operation.tone==='warn'?'warn':''}`);next.append(el('b','','下一步'),el('span','',operation.next));
        const actions=el('div','distribution-actions'), edit=makeButton('编辑计划',()=>editPlan(plan)), open=makeButton('打开刊登页',()=>request(`plan-open-${plan.id}`,()=>api.openListing(plan.id),'已打开对应环境的刊登页面')), photos=makeButton('照片与上传',()=>openPhotoPlan(plan.id)), records=makeButton('任务记录',()=>showPlanJobs(plan.id));
        edit.disabled=disabled;open.disabled=disabled||publicationOccupied(plan)||!find(state.profiles,plan.profileId);open.title=publicationOccupied(plan)?'已有在售或原提交记录，请核对原刊登。':'';photos.disabled=checking||!!state.faulted;actions.append(edit,open,photos,records);
        if(typeof api.inspectAccount==='function'){const accountCheck=makeButton('核对账号',()=>inspectPlanAccount(plan.id));accountCheck.disabled=disabled||!!state.running;actions.append(accountCheck);}
        if(typeof api.inspectPublication==='function'){const publication=makeButton('核对发布条件',()=>inspectPlan(plan.id,'publication'));publication.disabled=disabled||!!state.running;actions.append(publication);}
        if(canInspectAssociation(plan.id)){const original=makeButton('核对原刊登',()=>openAssociation(plan.id));original.disabled=disabled||!!state.running;actions.append(original);}
        appendWithdrawalAction(actions,plan.id);
        if(operation.job)actions.append(el('small','distribution-updated',`最近任务：${jobNames[operation.job.type]||operation.job.type} · ${when(operation.job.updatedAt||operation.job.createdAt,true)}`));
        row.append(heading,metrics,next);
        const url=listingReceiptURL(plan);if(url){const receipt=el('p','distribution-receipt');receipt.append(el('span','','刊登回执地址：'),el('code','',url));row.append(receipt);if(typeof api.openActiveListing==='function'){const view=makeButton('查看在售商品',()=>request(`plan-open-${plan.id}`,()=>api.openActiveListing(plan.id),'已在对应环境打开在售商品'));view.disabled=disabled;actions.prepend(view);}}
        row.append(actions);card.append(row);
      }
      list.append(card);
    }
  }
  function renderPlans() {
    const query=$('#plan-search').value.trim().toLowerCase(), rows=state.plans.filter(plan=>`${plan.name || ''} ${plan.sku || ''} ${productName(plan.productId)} ${profileName(plan.profileId)}`.toLowerCase().includes(query)), list=$('#plans');
    list.replaceChildren();
    if (!rows.length) { list.append(empty(state.plans.length?'没有匹配的计划，试试其他商品或环境名称。':'还没有计划。新建一个计划，设置累计销售目标与价格。')); return; }
    for (const plan of rows) {
      const card=el('article','plan-card'), head=el('div','plan-head'), heading=el('div'), actions=el('div','plan-actions'), operation=operationState(plan), occupied=publicationOccupied(plan);
      card.dataset.listingPlanId=String(plan.id);
      heading.append(el('div','plan-name',plan.name || productName(plan.productId)),el('div','plan-meta',`${profileName(plan.profileId)} · SKU ${plan.sku || find(state.products,plan.productId)?.sku || '—'} · 法国站 / EUR`));
      const checking=pageActionPending();
      const toggle=makeButton(plan.enabled?'停用':'启用并开始',()=>request(`plan-${plan.id}`,()=>plan.enabled?api.setPlanEnabled(plan.id,false):api.startPlan(plan.id),plan.enabled?'计划已停用':'计划已启用并开始执行'));toggle.disabled=pending.has(`plan-${plan.id}`)||checking||!plan.enabled&&typeof api.startPlan!=='function';
      const started=state.running&&(state.runningPlanIds==null||state.runningPlanIds.some(id=>same(id,plan.id))),start=makeButton(started?'此计划已开始':'开始上架',()=>request(`plan-${plan.id}`,()=>api.startPlan(plan.id),'该计划已开始执行'),'primary');start.disabled=started||pending.has(`plan-${plan.id}`)||checking||typeof api.startPlan!=='function'||!!state.faulted||!!state.configBusy;
      const edit=makeButton('编辑',()=>editPlan(plan));edit.disabled=checking;
      const open=makeButton('打开刊登页',()=>request(`plan-open-${plan.id}`,()=>api.openListing(plan.id),'已打开对应环境的刊登页面'));open.disabled=checking||!!state.faulted||!!state.running||!!state.configBusy||occupied;open.title=occupied?'已有在售或原提交记录，请核对原刊登。':'';
      const check=makeButton('核对资料',()=>inspectPlan(plan.id,'preflight')), fill=makeButton('填写页面',()=>inspectPlan(plan.id,'draft'));
      check.disabled=!!state.faulted||checking||!!state.running||!!state.configBusy;fill.disabled=check.disabled||occupied;fill.title=occupied?'已有在售或原提交记录，请先核对原刊登。':'只填写可以核对的字段，不会点击发布。';
      actions.append(badge(plan.enabled?'已启用':'未启用',plan.enabled?'good':'neutral'),start,edit,open,check,fill,toggle);head.append(heading,actions);
      const metrics=el('div','plan-metrics');
      for (const [name,value] of [['累计成交 / 目标',`${number(plan.completedCount)} / ${number(plan.targetCount)}`],['上架价格',currency(plan.listingPriceCents)],['最低接受价格',currency(plan.minOfferCents)],['当前商品',plan.activeListingId?'已有在售记录':occupied?'发布结果待核对':'暂无在售记录']]) { const metric=el('div');metric.append(el('span','',name),el('b','',value));metrics.append(metric); }
      const footer=el('div','plan-footer');footer.append(badge('每个 SKU 最多一个在售商品'),badge(plan.reuseOwnPhotos?'可复用自己的图片':'每次使用新图片'),badge(plan.autoReply?'自动回复规则已保存':'消息待人工处理'),badge(plan.autoAcceptOffers?'底价接受规则已保存':'报价待人工处理'));if(plan.status)footer.append(statusBadge(plan.status));
      const config=el('section','listing-config-note'),missing=listingMissing(plan);config.append(badge(missing.length?'商品资料待补充':'基本商品资料已齐',missing.length?'warn':'good'),el('p','',missing.length?`还缺：${missing.map(key=>listingNames[key]).join('、')}。编辑计划补齐后再执行。`:'计划保留创建时的商品资料；执行时按当前网页逐项核对。'));if(!hasBoundAccount(plan.profileId))config.append(el('p','form-error','请先在账号中心为该环境绑定并核对 Vinted 账号。'));if(automaticListing())config.append(el('p','field-hint','点击“启用并开始”或“开始上架”后，自动打开原环境、核对衣橱、准备和上传照片、填写并发布；条件不足会显示原因。下方按钮用于手动检查或恢复。'));
      card.append(head,metrics,config,renderPlanPublicationActions(plan,operation),renderPlanPhotoActions(plan),footer);list.append(card);
    }
  }
  function renderPlanPublicationActions(plan,operation) {
    const section=el('section','plan-publication-section'), heading=el('div','plan-photo-heading'), actions=el('div','photo-actions');
    heading.append(el('b','','刊登与回执'),badge(operation.label,operation.tone));section.append(heading,el('p','field-hint',operation.next));
    const accountReport=planAccountReports.get(String(plan.id));if(accountReport){const note=el('div','account-check-feedback');note.setAttribute('role','status');note.dataset.accountCheck=accountReport.status;note.append(badge(accountReport.status==='verified'?'最近账号核对成功':accountReport.status==='checking'?'正在核对账号':'账号核对未完成',accountReport.status==='verified'?'good':accountReport.status==='checking'?'neutral':'warn'),el('p','',accountReport.message));section.append(note);}
    const blocked=pageActionPending()||!!state.running||!!state.faulted||!!state.configBusy;
    if(canInspectAssociation(plan.id)){const original=makeButton('核对原刊登',()=>openAssociation(plan.id),'primary');original.disabled=blocked;actions.append(original);}
    appendWithdrawalAction(actions,plan.id);
    if(listingReceiptURL(plan)&&typeof api.openActiveListing==='function'){const view=makeButton('查看在售商品',()=>request(`plan-open-${plan.id}`,()=>api.openActiveListing(plan.id),'已在对应环境打开在售商品'));view.disabled=blocked;actions.append(view);}
    if(typeof api.inspectAccount==='function'){const account=makeButton('核对账号',()=>inspectPlanAccount(plan.id));account.disabled=blocked;actions.append(account);}
    if(typeof api.inspectPublication==='function'){const inspect=makeButton('核对发布条件',()=>inspectPlan(plan.id,'publication'));inspect.disabled=blocked||publicationOccupied(plan);inspect.title=publicationOccupied(plan)?'已有原提交或在售记录，请核对原刊登。':'只读取并核对当前页面，不会点击发布。';actions.append(inspect);}
    actions.append(makeButton('任务记录',()=>showPlanJobs(plan.id)));section.append(actions);return section;
  }
  function renderPlanPhotoActions(plan) {
    const section=el('section','plan-photo-section'), heading=el('div','plan-photo-heading'), statuses=el('div','photo-statuses');
    heading.append(el('b','','刊登照片'));
    for(const status of [photoPreparationStatus(plan.id),photoUploadStatus(plan.id)])statuses.append(badge(status.label,status.tone));
    heading.append(statuses);section.append(heading);
    const summary=photoSummary(plan.id), progress=summary?`已下载 ${number(summary.downloadedCount)} / ${number(summary.count)} 张 · `:'';
    section.append(el('p','photo-claim-note',`${progress}领取免费，但会永久占用该套图片。重试继续原领取，不另占新套组。`));
    const actions=el('div','photo-actions'), locked=pageActionPending()||!!state.running||!!state.faulted||!!state.configBusy;
    const inspect=makeButton('检查照片控件',()=>openPhotoPlan(plan.id,'inspect'));
    const prepare=makeButton(summary?'继续准备原图片':'领取并准备图片',()=>openPhotoPlan(plan.id,'prepare'));
    const upload=makeButton(canCheckPhotos(plan.id)?'重新核对上传':'上传并核对',()=>openPhotoPlan(plan.id,'upload'));
    const detail=makeButton('照片详情',()=>openPhotoPlan(plan.id));
    inspect.disabled=prepare.disabled=locked;upload.disabled=locked||!canUploadPhotos(plan.id);
    upload.title=canUploadPhotos(plan.id)?'只处理当前刊登页的照片，不保存或发布商品。':'先准备本机图片，再检查当前刊登页的照片控件。';
    actions.append(inspect,prepare,upload,detail);section.append(actions);
    if(state.running)section.append(el('p','field-hint photo-action-hint','先暂停调度，再手动准备或上传照片。'));
    return section;
  }
  function renderPhotoControls() {
    const id=selectedPhotoPlanId, report=photoReports.get(id), summary=photoSummary(id), busy=pageActionPending(), blocked=!id||busy||!!state.running||!!state.faulted||!!state.configBusy;
    $('#photo-inspect').disabled=blocked;
    $('#photo-prepare').disabled=blocked;
    $('#photo-upload').disabled=blocked||!canUploadPhotos(id);
    $('#photo-preview').disabled=!id||busy||!!state.faulted||summary?.ready!==true;
    $('#photo-inspect').textContent=pending.has(`plan-photo-inspect-${id}`)?'正在检查…':'检查照片控件';
    $('#photo-prepare').textContent=pending.has(`plan-photo-prepare-${id}`)?'正在准备…':summary?'继续准备原图片':'领取并准备图片';
    $('#photo-upload').textContent=pending.has(`plan-photo-upload-${id}`)?report?.checkingUpload?'正在核对…':'正在上传并核对…':canCheckPhotos(id)?'重新核对上传':'上传并核对';
    $('#photo-preview').textContent=pending.has(`plan-photo-preview-${id}`)?'正在读取…':'预览已准备图片';
    $('#photo-action-hint').textContent=state.running?'请先暂停调度，再执行照片操作。':state.faulted?'运营数据无法安全保存，照片操作已停止。':busy?'正在执行页面或照片操作，请等待结果。':!summary?.ready?'先领取并准备图片，再检查照片控件。图片保存在本机后，仍须单独上传并核对。':canCheckPhotos(id)?'已有上传记录，再次操作会核对原回执；结果不明确时不会重复选择文件。':report?.uploadError?'上次上传未能确认结果，请先重新检查照片控件，不要重复提交文件。':report?.page?.canUpload===true?'可以尝试上传并核对当前页；图片上传不等于商品发布。':report?.page?'当前照片控件尚未满足上传条件，请查看检查结果。':'本机图片已准备，请检查当前刊登页的照片控件。';
  }
  function renderPhotoReport() {
    const detail=$('#plan-photos-detail'), id=selectedPhotoPlanId, plan=find(state.plans,id), report=photoReports.get(id)||{}, summary=photoSummary(id);
    detail.replaceChildren();
    detail.append(el('p','report-plan',`${plan?.name||'上架计划'} · ${profileName(plan?.profileId)} · SKU ${plan?.sku||'—'}`));
    const statuses=el('div','photo-statuses photo-report-statuses');
    for(const status of [photoPreparationStatus(id),photoUploadStatus(id)])statuses.append(badge(status.label,status.tone));
    detail.append(statuses);
    if(report.error)detail.append(el('div','form-error',report.error));
    if(summary){
      const grid=el('dl','detail-grid');
      for(const [label,value] of [['图片套组',summary.setId],['领取编号',summary.claimId||'尚未取得回执'],['本机准备进度',`${number(summary.downloadedCount)} / ${number(summary.count)} 张`],['准备记录更新',when(summary.updatedAt)]])if(value!==undefined&&value!==null)grid.append(el('dt','',label),el('dd','',value));
      detail.append(grid);
      if(summary.error)detail.append(el('p','photo-result-warning',summary.error));
    }else detail.append(el('p','field-hint','这个计划尚无照片准备记录。准备完成后，可预览主进程已验证的图片。'));
    const page=report.page;
    if(page){
      detail.append(el('h3','','最近一次照片控件检查'));
      if(typeof page.message==='string')detail.append(el('p','photo-result-message',page.message));
      if(page.challenge===true)detail.append(el('p','photo-result-warning','页面存在账号或人机验证，请先在浏览器中处理。'));
      const grid=el('dl','detail-grid');
      for(const [label,value] of [['照片输入控件',Number.isSafeInteger(page.fileInputCount)?page.fileInputCount:'未确认'],['可首次上传',page.canUpload===true?'当前检查满足条件':'尚未满足条件'],['原上传可核对',page.canCheck===true?'可以':'尚无可核对记录']])grid.append(el('dt','',label),el('dd','',value));
      detail.append(grid);
      if(Array.isArray(page.candidates)&&page.candidates.length){
        const list=el('ul','report-list');
        for(const [index,item] of page.candidates.slice(0,8).entries()){
          const thumbnails=Array.isArray(item.scope?.images)?item.scope.images:[], parts=[`照片控件 ${index+1}`,item.disabled?'当前禁用':'未禁用',item.multiple?'支持多张':'单张选择'];
          if(Number.isSafeInteger(item.selectedFileCount))parts.push(`已选 ${item.selectedFileCount} 个文件`);
          if(item.scope)parts.push(`显示 ${thumbnails.length} 张缩略图`,item.scope.busy?'页面处理中':'未报告忙碌');
          list.append(el('li','',parts.join(' · ')));
        }
        detail.append(list);
      }
      const diagnostic=el('details','report-fields photo-diagnostic');
      const diagnosticText=el('pre','receipt-data');
      for(const line of JSON.stringify(photoDiagnostic(page),null,2).split('\n'))diagnosticText.append(el('div','diagnostic-line',line));
      diagnostic.append(el('summary','','照片控件诊断（可选中文字复制）'),diagnosticText);
      detail.append(diagnostic);
    }
    const upload=report.upload;
    if(upload){
      detail.append(el('h3','','最近一次上传核对'));
      const verified=upload.verified===true&&upload.uncertain!==true&&!report.uploadError;
      detail.append(el('div',`report-status ${verified?'good':'warn'}`,verified?'已核对这次上传的页面回执。商品尚未保存或发布。':upload.uncertain?'上传结果尚不明确，请核对原回执。':'未确认上传完成，请处理下方说明后再核对。'));
      if(typeof upload.message==='string')detail.append(el('p','photo-result-message',upload.message));
      if(upload.unchanged===true)detail.append(el('p','field-hint','本次只核对原上传记录，没有再次选择文件。'));
      const grid=el('dl','detail-grid');
      for(const [label,value] of [['领取编号',upload.claimId],['本次图片数量',upload.count],['页面缩略图',upload.receipt?.thumbnailCount],['已保存图片回执',upload.receipt?.serverStoredCount],['页面错误数',upload.receipt?.errorCount]])if(typeof value==='string'||Number.isSafeInteger(value))grid.append(el('dt','',label),el('dd','',value));
      detail.append(grid,el('p','field-hint','回执对应检查时的页面；切换或重载网页后须重新检查照片控件。'));
    }
    if(Array.isArray(report.images)){
      detail.append(el('h3','',`本机已验证图片（${report.images.length} 张）`));
      const grid=el('div','photo-preview-grid');
      for(const [index,item] of report.images.entries()){
        const figure=el('figure','photo-preview-item'), img=el('img');img.src=item.dataURL;img.alt=`本计划已准备图片 ${index+1}`;img.loading='lazy';
        figure.append(img,el('figcaption','',`${index+1} · ${item.width} × ${item.height}`));grid.append(figure);
      }
      detail.append(grid);
    }
    renderPhotoControls();
  }
  async function openPhotoPlan(id,action) {
    selectedPhotoPlanId=String(id);renderPhotoReport();if(!photoDialog.open)photoDialog.showModal();
    if(action)await runPhotoAction(id,action);
  }
  async function runPhotoAction(id,action) {
    if(pageActionPending())return;
    if(state.faulted)throw Error('运营数据无法安全保存，照片操作已停止。');
    if(action!=='preview'&&(state.running||state.configBusy))throw Error('请先暂停调度并等待当前配置操作结束。');
    const key=String(id), report=photoReports.get(key)||{};photoReports.set(key,report);report.error='';
    if(action==='upload'&&!canUploadPhotos(id)){report.error='先准备图片并检查当前刊登页的照片控件，再执行上传。';renderPhotoReport();return;}
    if(action==='upload'){report.checkingUpload=canCheckPhotos(id);report.uploadError=false;}
    if(action==='inspect')report.page=null;
    if(action==='prepare'){report.summary=null;report.images=undefined;}
    const methods={inspect:'inspectPhotos',prepare:'preparePhotos',upload:'uploadPhotos',preview:'photoPreview'};
    try{
      const result=await request(`plan-photo-${action}-${id}`,async()=>{
        if(typeof api[methods[action]]!=='function')throw Error('当前应用尚未提供此照片操作，请重新打开更新后的应用。');
        return action==='upload'?api.uploadPhotos(id,report.checkingUpload===true):api[methods[action]](id);
      });
      if(result?.summary)report.summary=result.summary;
      if(result?.page){
        report.page=result.page;
        if(report.upload?.receipt?.documentKey&&result.page.documentKey!==report.upload.receipt.documentKey){report.upload=null;report.uploadError=false;}
        if(result.page.canUpload===true&&result.page.canCheck!==true){report.upload=null;report.uploadError=false;}
      }
      if(action==='upload'&&result){report.upload=result;report.uploadError=result.uncertain===true;}
      if(action==='preview'){
        if(!Array.isArray(result?.images)||!result.images.length||result.images.length>20||result.images.some(item=>!Number.isSafeInteger(item?.width)||item.width<1||!Number.isSafeInteger(item.height)||item.height<1||typeof item.dataURL!=='string'||item.dataURL.length>8*1024*1024||!/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(item.dataURL)))throw Error('主进程没有返回可显示的已验证图片。');
        report.images=result.images.map(({dataURL,width,height})=>({dataURL,width,height}));
      }
    }catch(error){
      report.error=cleanError(error);if(action==='upload')report.uploadError=true;
    }finally{renderPlans();if(selectedPhotoPlanId===key)renderPhotoReport();renderControls();}
  }
  function renderInventory() {
    const query=$('#product-search').value.trim().toLowerCase(), products=state.products.filter(product=>`${product.name || ''} ${product.sku || ''}`.toLowerCase().includes(query));
    $('#inventory-count').textContent=`${products.length} 件商品`;const tbody=$('#products');tbody.replaceChildren();
    $('#inventory-empty').hidden=!!products.length;$('#inventory-empty').textContent=state.products.length?'没有找到匹配商品。':'点击“自己添加商品”填写资料并选择本地照片；也可连接并同步货盘。';
    for (const product of products) {
      const row=el('tr'), name=el('td');name.append(el('b','',product.name || '未命名商品'),el('small','',`${product.source==='local'?'手动商品':'货盘商品'} · SKU ${product.sku || '—'}`));
      const saved=productListing(product),missing=saved?listingMissing(saved):null;name.append(el('span','product-listing-status',saved?missing.length?`资料草稿 · 缺 ${missing.length} 项`:'基本上架资料已齐':'尚未保存上架资料'));
      const actions=el('td'), group=el('div','table-actions'),details=makeButton('商品资料',()=>editProductListing(product));details.dataset.productListingId=String(product.id);details.disabled=productEditorBusy()||typeof api[product.source==='local'?'saveManualProduct':'saveProductListing']!=='function'||!!state.faulted||!!state.configBusy;const pictures=makeButton(product.source==='local'?`本地照片 ${product.localPhotoCount??0} 张`:'图片',()=>{if(product.source==='local'){editManualProduct(product);return;}photoProductId=String(product.id);renderPhotos();$('#photos-heading').scrollIntoView({behavior:'smooth',block:'center'});});pictures.disabled=product.source==='local'&&details.disabled;group.append(details,pictures,makeButton('建计划',()=>editPlan(null,product.id)));
      actions.append(group);row.append(name,el('td','',product.stock===null||product.stock===undefined?'待核对':product.stock),el('td','',currency(product.priceCents)),el('td','',product.photoSetsAvailable ?? '—'),actions);tbody.append(row);
    }
    renderPhotos();
  }
  function renderPhotos() {
    const rows=state.photoSets.filter(set=>!photoProductId || same(set.productId,photoProductId)), list=$('#photo-sets');list.replaceChildren();
    $('#photos-heading').textContent=photoProductId?`${productName(photoProductId)} · 图片套装`:'图片套装';$('#clear-photo-filter').hidden=!photoProductId;
    if (!rows.length) { list.append(empty('手动商品的本地照片在商品资料中管理；货盘套装同步后在这里查看。',true));return; }
    for (const set of rows.slice(0,180)) {
      const card=el('article','photo-set');let label='使用状态未知',tone='neutral';
      if(set.claimedByMe){label='已被你领取';tone='good';}else if(['available','unclaimed','free'].includes(set.claimStatus)){label='可领取';tone='good';}else if(['claimed','used','claimed_by_other','occupied'].includes(set.claimStatus)){label='已被他人使用';tone='warn';}
      card.append(el('div','photo-icon','▧'),el('b','',set.name || `图片套装 ${set.id}`),el('p','',`${productName(set.productId)} · ${number(set.imageCount)} 张图片`),badge(label,tone));list.append(card);
    }
    if(rows.length>180)list.append(empty(`当前展示前 180 套，共 ${rows.length} 套。选择商品可缩小范围。`,true));
  }
  function renderJobs() {
    const filter=$('#job-filter').value, rows=[...state.jobs].filter(job=>(!jobPlanFilter||same(job.planId,jobPlanFilter))&&(!filter || filter==='attention'&&reviewStates.has(job.state) || filter==='complete'&&completedStates.has(job.state) || filter==='active'&&!reviewStates.has(job.state)&&!completedStates.has(job.state)&&!cancelledStates.has(job.state))).sort((a,b)=>String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    const selected=find(state.plans,jobPlanFilter);$('#job-plan-context').hidden=$('#clear-job-plan').hidden=!jobPlanFilter;$('#job-plan-context').textContent=jobPlanFilter?`${selected?.name||productName(selected?.productId)} · ${profileName(selected?.profileId)}`:'';
    const tbody=$('#jobs');tbody.replaceChildren();$('#job-count').textContent=`${rows.length} 个任务`;$('#jobs-empty').hidden=!!rows.length;$('#jobs-empty').textContent=state.jobs.length?'这个筛选条件下暂无任务。':'暂无执行记录。计划启用并检查后，任务会显示在这里。';
    for(const job of rows.slice(0,200)) {const row=el('tr'), title=el('td'), status=el('td'), actions=el('td');title.append(el('b','',jobNames[job.type] || job.type || '任务'),el('small','',productName(job.productId)));status.append(statusBadge(job.state));actions.append(makeButton('查看',()=>{selectedJobId=String(job.id);$('#reconcile-form').reset();renderJobDetail();jobDialog.showModal();}));row.append(title,el('td','',profileName(job.profileId)),status,el('td','',stepNames[job.step] || job.step || '—'),el('td','',when(job.updatedAt || job.createdAt,true)),actions);tbody.append(row);}
  }
  function renderJobDetail() {
    const job=find(state.jobs,selectedJobId), detail=$('#job-detail');detail.replaceChildren();
    if(!job){detail.append(empty('该任务记录不可用。'));$('#reconcile-form').hidden=true;$('#retry-form').hidden=true;return;}
    const grid=el('dl','detail-grid');for(const [name,value] of [['任务编号',job.id],['任务类型',jobNames[job.type] || job.type],['浏览器环境',profileName(job.profileId)],['商品',productName(job.productId)],['状态',stateNames[job.state] || job.state],['当前步骤',stepNames[job.step] || job.step || '—'],['创建时间',when(job.createdAt)],['更新时间',when(job.updatedAt)]])grid.append(el('dt','',name),el('dd','',value));detail.append(grid);
    if(job.scheduling&&['waiting','blocked','paused'].includes(job.scheduling.state)){detail.append(el('h3','','当前等待条件'),el('p','',job.scheduling.reason||'等待执行条件'),el('p','field-hint',job.scheduling.nextAction||''));}
    if(job.scheduling?.state==='ready'&&job.scheduling.reasonCode==='PROFILE_AUTO_OPEN'){detail.append(el('h3','','下一步：自动打开环境'),el('p','',job.scheduling.reason),el('p','field-hint',job.scheduling.nextAction));}
    if(job.error){detail.append(el('h3','','需要核对的问题'),el('div','form-error',typeof job.error==='string'?job.error:typeof job.error.message==='string'?job.error.message:'请核对真实页面和原请求记录。'));}
    if(job.result&&typeof job.result==='object'){
      const receipt=el('dl','detail-grid');
      for(const [key,name] of [['externalId',job.type==='listing'?'刊登编号':job.type==='fulfillment'?'货盘订单编号':'外部回执编号'],['listingId','刊登编号'],['orderId','订单编号'],['wmsStatus','仓库状态'],['status','回执状态'],['message','说明']])if(typeof job.result[key]==='string'||typeof job.result[key]==='number')receipt.append(el('dt','',name),el('dd','',job.result[key]));
      if(receipt.childElementCount)detail.append(el('h3','','执行回执'),receipt);
    }
    const canReconcile=!salesOnly()&&reviewStates.has(job.state)&&job.type==='fulfillment'&&!!job.result?.externalId;
    $('#reconcile-form').hidden=!canReconcile;
    const canRetry=job.canRetry===true&&!(salesOnly()&&purchaseJob(job));$('#retry-form').hidden=!canRetry;
    if(salesOnly()&&purchaseJob(job))detail.append(el('p','field-hint','这是旧版的历史任务，售卖模式保留原记录，相关操作已停用。'));
    else if(reviewStates.has(job.state)&&!canReconcile&&!canRetry)detail.append(el('p','field-hint','此任务需要核对真实页面或原请求回执。当前版本不会仅凭手工填写编号重新执行，记录会继续保留。'));
  }

  function reportList(parent,title,items,tone='') {
    if(!Array.isArray(items)||!items.length)return;
    parent.append(el('h3','',title));const list=el('ul',`report-list ${tone}`);
    for(const item of items.slice(0,80)){
      if(typeof item==='string')list.append(el('li','',listingNames[item]||item));
      else if(item&&typeof item==='object'){
        const label=typeof item.label==='string'?item.label:typeof item.field==='string'?listingNames[item.field]||item.field:typeof item.name==='string'?item.name:'字段';
        const note=typeof item.detail==='string'?item.detail:typeof item.reason==='string'?item.reason:typeof item.message==='string'?item.message:'';
        list.append(el('li','',`${label}${note?'：'+note:''}`));
      }
    }
    if(list.childElementCount)parent.append(list);
  }
  function renderPageReport() {
    const detail=$('#preflight-detail');detail.replaceChildren();$('#preflight-title').textContent=reportKind==='draft'?'填写页面结果':reportKind==='publication'?'核对发布条件':'核对刊登资料';
    $('#preflight-dialog .preflight-note b').textContent=reportKind==='publication'?'只读取并核对发布条件':'填写页面只准备表单';
    $('#preflight-dialog .preflight-note p').textContent=reportKind==='publication'?'逐项核对账号、商品资料、价格和上传照片；本次检查不会点击发布或保存草稿。':salesOnly()?'按计划准备商品表单，缺少的内容会列出。资料、图片与网页选项仍需逐项核对，填写完成后不会直接发布。':'按计划填写能够核对的字段，缺少的内容会列出；不会点击发布、发送消息、接受报价或提交采购。图片与网页选项仍需逐项核对。';
    const plan=find(state.plans,selectedPlanId);detail.append(el('p','report-plan',`${plan?.name||'上架计划'} · ${profileName(plan?.profileId)}`));
    if(reportError){detail.append(el('div','form-error',reportError));return;}
    if(!pageReport){detail.append(el('p','report-loading',reportKind==='draft'?'正在核对并填写页面…':'正在读取商品、图片与当前网页…'));return;}
    const report=pageReport;
    if(reportKind==='publication'){
      const submitted=!!openPublication(selectedPlanId)||publicationAttempts.has(String(selectedPlanId)),published=!!publishedPublication(selectedPlanId)&&!publicationAttempts.has(String(selectedPlanId));
      detail.append(el('div',`report-status ${published||report.readyForPublication&&!submitted?'good':'warn'}`,published?'刊登回执已验证并保存，以下为此前的发布条件检查。':submitted?'以下为提交前的检查记录；当前发布结果仍需核对。':report.readyForPublication?pageReport.manualPublicationEnabled===false?'当前发布条件已核对；手动发布尚未启用。':'当前发布条件已核对，可手动发布一次。':'发布条件仍有待核对项目，本次检查未执行发布。'));
      if(Array.isArray(report.checks)&&report.checks.length){const checks=el('div','report-checks');for(const item of report.checks.slice(0,60)){const row=el('div','report-check'),body=el('div');body.append(el('b','',typeof item.name==='string'?item.name:'检查项'));if(typeof item.detail==='string')body.append(el('p','',item.detail));row.append(badge(item.ok===true?'已通过':'待核对',item.ok===true?'good':'warn'),body);checks.append(row);}detail.append(checks);}
      reportList(detail,'仍需处理',report.blockers,'warning');if(typeof report.message==='string'&&!submitted)detail.append(el('p','field-hint',report.message));detail.append(el('p','field-hint',`这里执行当前商品的单次发布。${remainingSalesText()}`));return;
    }
    if(reportKind==='draft'){
      detail.append(el('div','report-status','仅填写页面，尚未发布商品。'));
      reportList(detail,'已填写',report.filled,'success');
      if(!Array.isArray(report.filled)||!report.filled.length)detail.append(el('p','field-hint','本次没有可确认已填写的字段。'));
      reportList(detail,'缺少资料',report.missing,'warning');reportList(detail,'仍需核对',report.unresolved,'warning');
      if(typeof report.message==='string')detail.append(el('p','field-hint',report.message));
      return;
    }
    detail.append(el('div',`report-status ${report.readyForFields?'good':'warn'}`,report.readyForFields?'可以尝试填写已核对的字段；商品尚未发布。':'仍有待核对项目，请补充资料或处理当前页面。'));
    const grid=el('dl','detail-grid');
    for(const [name,value] of [['检查时间',when(report.checkedAt)],['SKU',report.product?.sku],['商品名称',report.product?.name],['货盘描述',report.supplierFacts?.description],['货盘品牌',report.supplierFacts?.brand],['货盘成色',report.supplierFacts?.condition],['库存',report.product?.stock??'待核对'],[salesOnly()?'货盘价格':'采购价',currency(report.product?.priceCents)],['可领取图片套数',report.photos?.availableCount??'待核对'],['自己的图片套数',report.photos?.ownCount??'待核对'],['图片总套数',report.photos?.totalCount??'待核对'],['网页标题',report.page?.title],['网页地址',report.page?.url],['当前账号',report.page?.accountLabel]])if(value!==undefined&&value!==null&&value!=='')grid.append(el('dt','',name),el('dd','',value));
    detail.append(grid);
    if(Array.isArray(report.checks)&&report.checks.length){detail.append(el('h3','','逐项核对'));const checks=el('div','report-checks');for(const item of report.checks.slice(0,60)){const row=el('div','report-check'),body=el('div');body.append(el('b','',typeof item.name==='string'?item.name:'检查项'));if(typeof item.detail==='string')body.append(el('p','',item.detail));row.append(badge(item.ok===true?'已通过':'待核对',item.ok===true?'good':'warn'),body);checks.append(row);}detail.append(checks);}
    reportList(detail,'缺少资料',report.missing,'warning');
    if(Array.isArray(report.page?.fields)&&report.page.fields.length){const block=el('details','report-fields');block.append(el('summary','',`查看当前页面识别到的字段（${report.page.fields.length}）`));const list=el('ul','report-list');for(const field of report.page.fields.slice(0,100))list.append(el('li','',`${field.label||'未标注字段'}${field.required?' · 必填':''}${field.disabled?' · 当前不可用':''}`));block.append(list);detail.append(block);}
  }
  async function inspectPlan(id,kind) {
    const key=`plan-${kind==='draft'?'draft':'preflight'}-${id}`;
    if(pageActionPending())return;
    selectedPlanId=String(id);reportKind=kind;pageReport=null;reportError='';publicationReviewedPlan='';renderPageReport();
    if(!preflightDialog.open)preflightDialog.showModal();
    try{const result=await request(key,()=>kind==='draft'?api.prepareDraft(id):kind==='publication'?api.inspectPublication(id):api.preflight(id));if(result&&selectedPlanId===String(id)&&reportKind===kind){pageReport=result;if(kind==='publication'&&result.readyForPublication===true)publicationReviewedPlan=publicationPlanSignature(id);}}
    catch(error){if(selectedPlanId===String(id)&&reportKind===kind)reportError=cleanError(error);}
    renderPageReport();renderControls();
  }
  function renderEvents() { const list=$('#events');list.replaceChildren();const rows=state.events.slice(-8).reverse();if(!rows.length)list.append(empty('还没有执行动态。连接货盘后开始准备计划。',true));for(const item of rows){const row=el('div',`event ${item.kind==='warning'?'warn':['warn','error'].includes(item.kind)?item.kind:''}`),content=el('div');content.append(el('p','',item.text || ''),el('time','',when(item.time)));row.append(el('i'),content);list.append(row);} }
  function renderConnection() {
    const connected=isConnected(), configured=!!state.settings.hasToken, failed=!!state.connection.error || ['error','failed','disconnected'].includes(state.connection.status), title=connected?'已连接':failed?'连接异常':configured?'待检查连接':'未配置';
    $('#readiness-settings').textContent=setupNext().label;
    $('#connection-badge').textContent=title;$('#connection-badge').className=`pill ${connected?'good':failed?'bad':'neutral'}`;$('#sidebar-connection').textContent=connected?'货盘连接正常':failed?'货盘连接异常':configured?'货盘配置已保存 · 待检查连接':'货盘尚未配置';$('#sidebar-dot').className=connected?'connected':failed?'failed':'';
    const detail=$('#connection-detail');detail.replaceChildren();if(state.connection.account)detail.append(el('p','',`账号：${typeof state.connection.account==='string'?state.connection.account:state.connection.account.name || state.connection.account.id || '已认证'}`));if(Array.isArray(state.connection.scopes)&&state.connection.scopes.length)detail.append(el('p','',`已授权：${state.connection.scopes.join('、')}`));if(state.connection.checkedAt)detail.append(el('p','',`最近检查：${when(state.connection.checkedAt)}`));if(state.connection.error)detail.append(el('p','connection-error',state.connection.error));
    settingsForm.elements.token.placeholder=state.settings.hasToken?'已保存，留空保留原 Token':'填写货盘提供的 Token';$('#token-hint').textContent=state.settings.hasToken?'Token 已保存，留空会保留。更换货盘地址后请重新填写凭据。':'Token 不会显示在页面上。填写后保存，再检查连接。';
  }
  function fillSettings() { const fields=settingsForm.elements, value=state.settings;fields.baseURL.value=value.baseURL || '';fields.backgroundEnabled.checked=!!value.backgroundEnabled;fields.maxConcurrent.value=value.maxConcurrent ?? 1;fields.perOrderLimit.value=moneyInput(value.perOrderLimitCents ?? 0);fields.dailyLimit.value=moneyInput(value.dailyLimitCents ?? 0);fields.fulfillmentMethod.value=value.fulfillmentMethod==='self'?'self':'wms'; }
  function populateSelect(select,rows,label,value) { select.replaceChildren(new Option(label,''));for(const row of rows)select.add(new Option(row.name || row.sku || String(row.id),String(row.id)));select.value=value===undefined||value===null?'':String(value); }
  function editPlan(plan, productId) {
    planForm.reset();$('#plan-error').hidden=true;$('#plan-title').textContent=plan?'编辑上架计划':'新建上架计划';
    const fields=planForm.elements;fields.id.value=plan?.id || '';populateSelect(fields.profileId,state.profiles,'选择浏览器环境',plan?.profileId);populateSelect(fields.productId,state.products,'选择商品',plan?.productId ?? productId);fields.targetCount.value=plan?.targetCount ?? 1;fields.listingPrice.value=moneyInput(plan?.listingPriceCents);fields.minOffer.value=moneyInput(plan?.minOfferCents);fields.reuseOwnPhotos.checked=plan?.reuseOwnPhotos!==false;fields.autoReply.checked=!!plan?.autoReply;fields.autoAcceptOffers.checked=!!plan?.autoAcceptOffers;fields.enabled.checked=!!plan?.enabled;fields.replyPolicy.value=plan?.replyPolicy || '';
    fillListing(planForm,plan?.listing);
    planForm.dataset.sku=plan?.sku||find(state.products,fields.productId.value)?.sku||'';
    if(!plan&&state.profiles.length===1)fields.profileId.value=String(state.profiles[0].id);
    updateProductInfo(!plan);renderListingHint(planForm,$('#plan-listing-readiness'));planDialog.showModal();
  }
  function updateProductInfo(resetPrice=false) {const product=find(state.products,planForm.elements.productId.value),saved=productListing(product),fields=planForm.elements;$('#plan-product-info').textContent=product?product.source==='local'?`手动商品 · 库存 ${product.stock ?? '待核对'} · 本地照片 ${product.localPhotoCount??0} 张`:`SKU ${product.sku || '—'} · 库存 ${product.stock ?? '待核对'} · ${salesOnly()?'货盘价格':'采购价'} ${currency(product.priceCents)} · 可用图片 ${product.photoSetsAvailable ?? '待核对'} 套`:'选择商品后查看库存和图片。';if(resetPrice){planForm.dataset.sku=product?.sku||'';fields.listingPrice.value=moneyInput(saved?.listingPriceCents);fields.minOffer.value=moneyInput(saved?.minOfferCents);fillListing(planForm,saved?.listing);}$('#plan-template-info').textContent=fields.id.value?'这是该计划自己的资料；修改商品资料不会覆盖本计划。':saved?'已带入商品资料与建议价格，可在本计划单独调整。':'尚无商品资料；可以先在「商品与图片」保存，也可在这里填写。';renderListingHint(planForm,$('#plan-listing-readiness')); }

  document.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>changePage(button.dataset.page)));
  const workspaceMenu=$('#workspace-commerce-menu'),workspaceToggle=$('#workspace-commerce-toggle');
  workspaceToggle?.addEventListener('click',()=>{workspaceMenu.hidden=!workspaceMenu.hidden;workspaceToggle.setAttribute('aria-expanded',String(!workspaceMenu.hidden));});
  api.onPage?.(page=>{if(workspaceMenu)workspaceMenu.hidden=false;workspaceToggle?.setAttribute('aria-expanded','true');changePage(page);});
  $('#workspace-environments').addEventListener('click',()=>{void api.showEnvironments().catch(error=>toast(cleanError(error)));});
  document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>document.getElementById(button.dataset.close).close()));
  $('#new-account').addEventListener('click',()=>editAccount());
  $('#account-search').addEventListener('input',renderAccounts);$('#account-status').addEventListener('change',renderAccounts);
  accountDialog.addEventListener('close',()=>{accountForm.elements.password.value='';});
  accountVerifyDialog.addEventListener('close',()=>{if(!accountVerifyDialog.open){accountVerifyId='';accountVerifyPlanId='';}});accountDeleteDialog.addEventListener('close',()=>{if(!accountDeleteDialog.open)accountDeleteId='';});
  accountForm.addEventListener('submit',event=>{
    event.preventDefault();if(pending.has('account-save'))return;$('#account-error').hidden=true;
    const fields=accountForm.elements,input={platform:'vinted',label:fields.label.value.trim(),login:fields.login.value.trim(),profileId:fields.profileId.value};if(fields.id.value)input.id=fields.id.value;if(fields.password.value!=='')input.password=fields.password.value;fields.password.value='';
    if(!input.label||!input.login||!find(state.profiles,input.profileId)){delete input.password;$('#account-error').textContent='请填写账号名称、登录邮箱或用户名，并选择可用的固定环境。';$('#account-error').hidden=false;return;}
    if(input.password&&/[\x00-\x1f\x7f]/.test(input.password)){delete input.password;$('#account-error').textContent='密码不能包含换行或控制字符，请重新输入。';$('#account-error').hidden=false;return;}
    void (async()=>{try{const saved=await accountRequest('account-save',()=>api.saveAccount(input),'账号已保存。','账号未保存，请检查资料、固定环境状态与本机凭据存储后重试。');if(saved.ok)accountDialog.close();else if(accountDialog.open){$('#account-error').textContent=saved.message||'正在保存，请稍候。';$('#account-error').hidden=false;}}finally{delete input.password;fields.password.value='';}})();
  });
  $('#account-verify-confirm').addEventListener('click',()=>{
    if($('#account-verify-confirm').disabled||!accountVerifyId)return;
    const id=accountVerifyId,planId=accountVerifyPlanId,feedback=$('#account-verify-feedback');feedback.hidden=false;feedback.textContent='正在核对当前环境；首次绑定可能打开独立的本人主页核验标签。';setPlanAccountReport(planId,'checking',feedback.textContent);
    void accountRequest('account-verify-'+id,()=>api.verifyAccount(id,{confirmCurrent:true}),'账号核对已返回。','未能核对当前账号，请打开固定环境确认登录与账号归属后重试。').then(response=>{
      const result=response.result,verified=response.ok&&result?.result?.verified===true,message=verified?'已核对当前 Vinted 登录身份。':result?.message||response.message||'账号核对未完成，请检查固定环境的登录、验证提示与本人主页。';
      setPlanAccountReport(planId,verified?'verified':'failed',message);toast(message);
      if(accountVerifyId===id&&accountVerifyDialog.open){feedback.hidden=false;feedback.textContent=message;if(verified)accountVerifyDialog.close();}
    });
  });
  $('#account-delete-confirm').addEventListener('click',()=>{if($('#account-delete-confirm').disabled||!accountDeleteId)return;const id=accountDeleteId;void accountRequest('account-delete-'+id,()=>api.deleteAccount(id),'本机账号记录已删除。','账号未删除，请先关闭对应环境；关联运营历史的账号需保留。').then(result=>{if(result.ok)accountDeleteDialog.close();});});
  $('#readiness-settings').addEventListener('click',()=>changePage(setupNext().page));
  $('#preflight-edit').addEventListener('click',()=>{const plan=find(state.plans,selectedPlanId);if(plan){preflightDialog.close();editPlan(plan);}});
  $('#preflight-fill').addEventListener('click',()=>{if(selectedPlanId)void inspectPlan(selectedPlanId,'draft');});
  $('#publication-submit').addEventListener('click',()=>{void submitPublication();});
  $('#publication-association-inspect').addEventListener('click',()=>{void inspectAssociation();});
  $('#publication-association-confirm').addEventListener('click',()=>{void associateListing();});
  associationDialog.addEventListener('close',()=>{if(!associationDialog.open)associationReviewToken='';});
  $('#publication-withdrawal-form').addEventListener('submit',event=>{event.preventDefault();void confirmWithdrawal();});
  for(const id of ['publication-withdrawal-url','publication-withdrawal-confirmed'])$('#'+id).addEventListener('input',renderWithdrawalControls);
  withdrawalDialog.addEventListener('close',()=>{if(!withdrawalDialog.open){clearTimeout(withdrawalTimer);withdrawalReview=null;withdrawalError='';withdrawalResult='';}});
  for(const action of ['inspect','prepare','upload','preview'])$('#photo-'+action).addEventListener('click',()=>{if(selectedPhotoPlanId)void runPhotoAction(selectedPhotoPlanId,action).catch(error=>toast(cleanError(error)));});
  $('#new-plan').addEventListener('click',()=>editPlan());$('#overview-new-plan').addEventListener('click',()=>editPlan());
  planForm.addEventListener('input',()=>renderListingHint(planForm,$('#plan-listing-readiness')));
  productListingForm.addEventListener('input',()=>renderListingHint(productListingForm,$('#product-listing-readiness')));
  $('#new-manual-product').addEventListener('click',()=>editManualProduct());
  $('#manual-photo-import').addEventListener('click',()=>{
    if(productEditorBusy()||productListingForm.dataset.mode!=='local')return;
    const id=productListingForm.elements.productId.value;$('#product-listing-error').hidden=true;
    void request('manual-photos',()=>api.importProductPhotos(id?{productId:id}:{})).then(result=>{
      if(!result||result.cancelled)return;
      if(typeof result.photoToken!=='string'||!result.photoToken||!Number.isInteger(result.count)||result.count<1||result.count>20)throw Error('未收到有效的本地照片，请重新选择。');
      manualPhotoToken=result.photoToken;manualPhotoCount=result.count;$('#manual-photo-count').textContent='已选择 '+manualPhotoCount+' 张照片，保存商品后生效';
    }).catch(error=>{$('#product-listing-error').textContent=cleanError(error);$('#product-listing-error').hidden=false;});
  });
  productListingForm.addEventListener('submit',event=>{
    event.preventDefault();if(productEditorBusy())return;$('#product-listing-error').hidden=true;
    void request('product-listing',async()=>{
      const fields=productListingForm.elements,product=find(state.products,fields.productId.value),manual=productListingForm.dataset.mode==='local';
      if((!manual||fields.productId.value)&&(!product||product.sku!==productListingForm.dataset.sku||manual&&product.source!=='local'))throw Error('商品或 SKU 已改变，请关闭后重新打开资料。');
      const listingPriceCents=fields.listingPrice.value.trim()?cents(fields.listingPrice.value,'建议上架价格',true):null,minOfferCents=fields.minOffer.value.trim()?cents(fields.minOffer.value,'最低接受价格',true):null;
      if(minOfferCents!==null&&(listingPriceCents===null||minOfferCents>listingPriceCents))throw Error('最低接受价格需要已填写的售价，且不能高于售价。');
      if(manual){const name=fields.manualName.value.trim();if(!name)throw Error('请填写商品名称。');const input={name,stock:integer(fields.manualStock.value,0,1000000,'商品库存'),listing:formListing(productListingForm),listingPriceCents,minOfferCents};if(product)input.id=product.id;if(manualPhotoToken)input.photoToken=manualPhotoToken;await api.saveManualProduct(input);manualPhotoToken='';}
      else await api.saveProductListing({productId:product.id,sku:product.sku,listing:formListing(productListingForm),listingPriceCents,minOfferCents});
      productListingDialog.close();
    },'商品资料已保存，新计划可直接带入').catch(error=>{$('#product-listing-error').textContent=cleanError(error);$('#product-listing-error').hidden=false;});
  });
  for(const [id,event] of [['distribution-search','input'],['distribution-profile','change'],['distribution-status','change']])$('#'+id).addEventListener(event,()=>{distributionLimit=100;renderDistribution();});
  $('#distribution-reset').addEventListener('click',()=>{for(const id of ['distribution-search','distribution-profile','distribution-status'])$('#'+id).value='';distributionLimit=100;renderDistribution();});
  $('#distribution-more').addEventListener('click',()=>{distributionLimit+=100;renderDistribution();});
  $('#clear-job-plan').addEventListener('click',()=>{jobPlanFilter='';renderJobs();});
  $('#plan-search').addEventListener('input',renderPlans);$('#product-search').addEventListener('input',renderInventory);$('#job-filter').addEventListener('change',renderJobs);$('#clear-photo-filter').addEventListener('click',()=>{photoProductId='';renderPhotos();});planForm.elements.productId.addEventListener('change',()=>updateProductInfo(true));
  settingsForm.addEventListener('input',()=>{settingsDirty=true;});settingsForm.addEventListener('change',()=>{settingsDirty=true;});
  $('#runner-toggle').addEventListener('click',()=>{
    if($('#runner-toggle').disabled)return;
    if(!state.running&&!state.settings.backgroundEnabled){changePage('settings');$('#background-setup-guidance').hidden=false;settingsForm.elements.backgroundEnabled.focus();settingsForm.elements.backgroundEnabled.scrollIntoView({block:'center'});return;}
    void request('running',()=>api.setRunning(!state.running),()=>state.running?'持续调度已启动':'调度已暂停，当前外部操作仍以任务回执为准').catch(()=>{});
  });
  act($('#run-once'),'once',()=>api.runOnce(),'本轮执行完成，请查看任务记录与发布回执');
  act($('#sync'),'sync',()=>api.sync(),'货盘已同步');
  act($('#connect'),'connect',()=>api.connect(),()=>isConnected()?'货盘连接成功':'已完成连接检查，请查看结果');
  settingsForm.addEventListener('submit',event=>{event.preventDefault();void request('settings',async()=>{const fields=settingsForm.elements, baseURL=fields.baseURL.value.trim();if(baseURL){const url=new URL(baseURL);if(!['https:','http:'].includes(url.protocol))throw Error('API 地址必须使用 HTTP 或 HTTPS。');}const input={baseURL,token:fields.token.value,clearToken:fields.clearToken.checked,backgroundEnabled:fields.backgroundEnabled.checked,maxConcurrent:integer(fields.maxConcurrent.value,1,3,'并行环境数'),perOrderLimitCents:salesOnly()?0:cents(fields.perOrderLimit.value,'单笔采购上限'),dailyLimitCents:salesOnly()?0:cents(fields.dailyLimit.value,'每日采购上限'),fulfillmentMethod:salesOnly()?(state.settings.fulfillmentMethod||'wms'):fields.fulfillmentMethod.value,accountType:'personal',market:'FR'};if(input.dailyLimitCents&&input.perOrderLimitCents>input.dailyLimitCents)throw Error('单笔采购上限不能高于每日采购上限。');await api.saveSettings(input);fields.token.value='';fields.clearToken.checked=false;settingsDirty=false;},'设置已保存').catch(()=>{});});
  planForm.addEventListener('submit',event=>{event.preventDefault();$('#plan-error').hidden=true;void request('plan',async()=>{const fields=planForm.elements,product=find(state.products,fields.productId.value);if(!find(state.profiles,fields.profileId.value))throw Error('请选择可用的浏览器环境。');if(!product)throw Error('请选择商品。');if(product.sku!==planForm.dataset.sku)throw Error('商品 SKU 已改变，请重新选择商品并核对资料。');const listingPriceCents=cents(fields.listingPrice.value,'上架价格',true),minOfferCents=fields.minOffer.value.trim()?cents(fields.minOffer.value,'最低接受价格',true):fields.autoAcceptOffers.checked?cents('', '最低接受价格',true):listingPriceCents;if(minOfferCents>listingPriceCents)throw Error('最低接受价格不能高于上架价格。');const input={profileId:fields.profileId.value,productId:fields.productId.value,sku:product.sku || '',name:product.name || product.sku || '',targetCount:integer(fields.targetCount.value,1,1000,'累计销售目标'),listingPriceCents,minOfferCents,currency:'EUR',enabled:fields.enabled.checked,autoReply:fields.autoReply.checked,autoAcceptOffers:fields.autoAcceptOffers.checked,reuseOwnPhotos:fields.reuseOwnPhotos.checked,replyPolicy:fields.replyPolicy.value.trim(),listing:Object.fromEntries(Object.entries(listingFields).map(([key,field])=>[key,fields[field].value.trim()]))};if(fields.id.value)input.id=fields.id.value;let result;if(input.enabled){if(typeof api.saveAndStartPlan!=='function')throw Error('当前版本尚未提供启用并开始接口，请更新应用。');result=await api.saveAndStartPlan(input);}else result=await api.savePlan(input);planDialog.close();return result;},result=>result?.started?'计划已启用，已开始执行；请查看任务记录。':'计划已保存').catch(error=>{$('#plan-error').textContent=cleanError(error);$('#plan-error').hidden=false;});});
  $('#reconcile-form').addEventListener('submit',event=>{event.preventDefault();if(salesOnly())return;void request('resolve',()=>api.resolve(selectedJobId,'reconcile',{}),'原订单检查完成，请查看任务状态').catch(()=>{});});
  $('#retry-form').addEventListener('submit',event=>{event.preventDefault();const job=find(state.jobs,selectedJobId);if(job?.canRetry!==true||salesOnly()&&purchaseJob(job))return;void request('resolve',()=>api.resolve(selectedJobId,'retry',{}),'任务已重新排队，尚未执行').catch(()=>{});});
  api.onState(applyState);
  void refresh().catch(error=>{$('#load-error').textContent=`无法读取工作台状态：${cleanError(error)}`;$('#load-error').hidden=false;});
})();
