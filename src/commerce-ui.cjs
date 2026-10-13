'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const api = window.commerce;
  const settingsForm = $('#settings-form');
  const planForm = $('#plan-form');
  const planDialog = $('#plan-dialog');
  const jobDialog = $('#job-dialog');
  const preflightDialog = $('#preflight-dialog');
  const photoDialog = $('#plan-photos-dialog');
  const reviewStates = new Set(['needs_review', 'pending_review', 'waiting_review', 'review', 'unknown', 'uncertain', 'blocked', 'failed', 'error']);
  const completedStates = new Set(['completed', 'complete', 'done', 'succeeded']);
  const cancelledStates = new Set(['cancelled', 'canceled', 'rejected']);
  const stateNames = {queued:'待执行', pending:'待执行', running:'执行中', waiting:'等待条件', awaiting_result:'等待结果', retry_wait:'等待检查', needs_review:'需要核对', pending_review:'需要核对', waiting_review:'需要核对', review:'需要核对', unknown:'结果未知', uncertain:'结果未知', blocked:'已暂停', failed:'执行失败', error:'执行失败', completed:'已完成', complete:'已完成', done:'已完成', succeeded:'已完成', cancelled:'已取消', canceled:'已取消', rejected:'已拒绝', paused:'已暂停', disabled:'未启用', enabled:'已启用', ready:'待执行', active:'在售中', listed:'在售中', fulfilling:'履约中', target_reached:'销售目标已达成', waiting_sale:'等待成交', awaiting_sale:'等待成交', draft:'草稿', unverified:'待验证'};
  const jobNames = {listing:'商品上架', list:'商品上架', publish:'商品上架', reply:'回复消息', message:'回复消息', messages:'检查消息', offer:'处理报价', offers:'检查报价', accept_offer:'接受报价', label:'获取运单', shipping_label:'获取运单', shipment:'获取运单', fulfillment:'面单与货盘履约', procurement:'货盘采购', purchase:'货盘采购', order:'货盘采购', reconcile:'核对结果', sync:'同步货盘'};
  const stepNames = {pending:'检查执行条件',claim_photos:'领取商品图片',prepare_listing:'准备刊登草稿',publish_listing:'提交刊登',record_listing:'记录刊登回执',draft_reply:'准备商品回复',send_reply:'发送回复',check_offer:'核对报价',accept_offer:'接受报价',download_label:'下载并核对运单',check_stock_price:'核对库存与采购价',wms_checkout:'核对可用仓库',create_supplier_order:'提交货盘订单',verified:'核对完成'};
  const pageDetails = {overview:['商品运营','查看每个商品在哪个环境销售，以及接下来需要做什么。'],plans:['上架计划','为每个环境设置商品、销售目标与价格规则。'],inventory:['货盘与图片','核对商品库存，区分自己的图片与他人占用的套装。'],jobs:['任务记录','检查每一步的执行状态与外部平台回执。'],settings:['连接与规则','连接货盘，并为后台执行设置明确的范围。']};
  let state = {settings:{},connection:{status:'not_configured'},profiles:[],products:[],photoSets:[],photoPreparations:[],plans:[],jobs:[],events:[],publications:[],running:false,readiness:{vinted:'unverified'}};
  let currentPage = 'overview', settingsDirty = false, photoProductId = '', selectedJobId = '', selectedPlanId = '', toastTimer;
  let pageReport = null, reportKind = 'preflight', reportError = '';
  let selectedPhotoPlanId = '';
  let jobPlanFilter = '', distributionLimit = 100;
  const photoReports = new Map();
  const publicationAttempts = new Map();
  let publicationReviewedPlan = '';
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
  function changePage(page) { currentPage = page in pageDetails ? page : 'overview'; document.querySelectorAll('.page-section').forEach(section => { section.hidden = section.id !== `page-${currentPage}`; }); document.querySelectorAll('[data-page]').forEach(button => { const active=button.dataset.page===currentPage; button.classList.toggle('active',active); if(active)button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); }); $('#page-title').textContent=pageDetails[currentPage][0]; $('#page-description').textContent=pageDetails[currentPage][1]; }

  function applyState(incoming) {
    if (!incoming || typeof incoming !== 'object') return;
    state = {...state,...incoming,settings:{...state.settings,...incoming.settings},connection:{...state.connection,...incoming.connection},readiness:{...state.readiness,...incoming.readiness}};
    for (const key of ['profiles','products','photoSets','photoPreparations','plans','jobs','events','publications']) if (!Array.isArray(state[key])) state[key]=[];
    reconcilePublicationAttempts();
    $('#load-error').hidden = !state.faulted;
    if (state.faulted) $('#load-error').textContent = '运营数据无法安全写入，外部操作已停止。请检查本机存储后重新打开应用。';
    renderSummary(); renderPlans(); renderInventory(); renderJobs(); renderEvents(); renderConnection(); renderControls();
    if (!settingsDirty) fillSettings();
    if (jobDialog.open && selectedJobId) renderJobDetail();
    if (photoDialog.open && selectedPhotoPlanId) renderPhotoReport();
    if (preflightDialog.open && reportKind==='publication') renderPageReport();
  }
  function renderControls() {
    const active = !!state.running;
    $('#runner-status').classList.toggle('running',active);
    $('#runner-status').replaceChildren(el('i'),document.createTextNode(active ? ' 调度中' : ' 已暂停'));
    $('#runner-toggle').textContent = pending.has('running') ? '正在更新…' : active ? '暂停调度' : '启动调度';
    $('#runner-toggle').disabled = pending.has('running') || (!active && (!state.settings.backgroundEnabled || state.faulted || state.configBusy || photoActionPending()));
    $('#runner-toggle').title = !active && !state.settings.backgroundEnabled ? '先在「连接与规则」中保存后台持续调度设置。' : '';
    $('#run-once').disabled = pending.has('once') || !!state.faulted || !!state.configBusy || photoActionPending(); $('#run-once').textContent = pending.has('once') ? '正在检查…' : '检查一次';
    $('#sync').disabled = pending.has('sync') || pending.has('connect') || photoActionPending(); $('#sync').textContent = pending.has('sync') ? '正在同步…' : '同步货盘';
    $('#connect').disabled = pending.has('connect') || pending.has('settings') || photoActionPending(); $('#connect').textContent = pending.has('connect') ? '正在连接…' : '检查已保存的连接';
    settingsForm.querySelector('[type=submit]').disabled = pending.has('settings') || photoActionPending();
    planForm.querySelector('[type=submit]').disabled = pending.has('plan') || photoActionPending();
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
    $('#preflight-fill').disabled = checking || !!state.faulted || !selectedPlanId || reportKind==='preflight'&&pageReport?.readyForFields!==true;
    $('#preflight-edit').disabled = checking || !selectedPlanId;
    renderPhotoControls();
    renderDistribution();
  }
  function renderSummary() {
    const active=state.plans.filter(plan=>plan.enabled), attention=state.jobs.filter(job=>reviewStates.has(job.state));
    $('#stat-plans').textContent=active.length; $('#stat-profiles').textContent=`覆盖 ${new Set(active.map(plan=>plan.profileId)).size} 个环境`;
    $('#stat-products').textContent=state.products.length; $('#stat-photo-sets').textContent=`${state.photoSets.length} 套图片`;
    $('#stat-complete').textContent=state.jobs.filter(job=>completedStates.has(job.state)).length; $('#stat-review').textContent=attention.length;
    $('#nav-review-count').textContent=attention.length; $('#nav-review-count').hidden=!attention.length;
    const verified=state.readiness.vinted==='verified';
    $('#readiness').classList.toggle('ready',verified);
    $('#readiness-title').textContent=verified ? '网页执行流程已验证' : '联调准备 · Vinted 网页流程待验证';
    $('#readiness-message').textContent=state.readiness.message || (verified ? '任务将按当前规则执行，结果不明确时暂停并保留记录。' : '可以连接货盘和准备计划。真实上架、消息、报价、面单与采购流程完成验证前，不会被标记为可无人值守运行。');
    $('#workflow-status').textContent=verified?'流程已验证':'联调准备'; $('#workflow-status').className=`pill ${verified?'good':'neutral'}`;
    $('#operations-runner-title').textContent=state.faulted?'运营存储异常，执行已停止':state.running?'后台调度已启动':state.configBusy?'正在处理连接或照片配置':state.settings.backgroundEnabled?'后台已暂停':'后台持续调度未开启';
    const running=state.jobs.filter(job=>job.state==='running').length, queued=state.jobs.filter(job=>['queued','pending','retry_wait'].includes(job.state)).length;
    $('#operations-runner-summary').textContent=`${new Set(active.map(plan=>plan.profileId)).size} 个已配置环境 · 最多并行 ${number(state.settings.maxConcurrent)||1} 个环境 · ${running} 个任务执行中`;
    $('#operations-runner-detail').replaceChildren(badge(`${queued} 个任务等待处理`),badge(`${attention.length} 个任务需要核对`,attention.length?'warn':'neutral'),badge(verified?'网页流程已验证':'网页流程尚未全部验证',verified?'good':'warn'));
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
    if(plan.activeListingId)return {key:'listed',label:'已有在售记录',tone:'good',next:!plan.enabled?'计划已停用；已保存的刊登记录仍保留。':state.readiness.vinted!=='verified'?'刊登记录已保存；消息、报价与成交监测仍待流程验证。':state.running?'等待成交，检查消息与报价。':'启动调度后检查消息、报价与成交。',job};
    if(waiting&&waiting.type!=='listing')return {key:plan.enabled?'pending':'paused',label:plan.enabled?'待执行':'计划未启用',tone:'neutral',next:`${jobNames[waiting.type]||waiting.type} · ${stepNames[waiting.step]||waiting.step||'等待执行条件'}`,job};
    if(number(plan.targetCount)>0&&number(plan.completedCount)>=number(plan.targetCount))return {key:'target_reached',label:'目标已达成',tone:'good',next:'累计销售目标已完成，不再补充上架。',job};
    if(!plan.enabled)return {key:'paused',label:'计划未启用',tone:'neutral',next:'尚无在售回执；核对资料后启用计划。',job};
    if(state.readiness.vinted!=='verified')return {key:'pending',label:'待发布',tone:'neutral',next:'准备图片和刊登资料，完成网页发布流程验证。',job};
    return {key:'pending',label:'待发布',tone:'neutral',next:state.running?'等待同一环境的前序任务结束，再检查上架条件。':'启动调度后检查库存、图片与刊登资料。',job};
  }
  function listingReceiptURL(plan) {
    if(!/^\d+$/.test(String(plan.activeListingId||''))||typeof plan.activeListingUrl!=='string')return '';
    try{
      const url=new URL(plan.activeListingUrl), id=url.pathname.match(/^\/items\/(\d+)(?:-[^/]*)?\/?$/)?.[1];
      return url.protocol==='https:'&&url.hostname==='www.vinted.fr'&&!url.port&&!url.username&&!url.password&&id===String(plan.activeListingId)&&!url.search&&!url.hash?url.href:'';
    }catch{return '';}
  }
  function openPublication(id) { return state.publications.find(record=>same(record.planId,id)&&record.closedSale!==true&&record.state!=='cancelled'); }
  function publishedPublication(id) { const record=openPublication(id);return record?.state==='published'&&find(state.plans,id)?.activeListingId?record:null; }
  function reconcilePublicationAttempts() {
    for(const [planId,attempt] of publicationAttempts){
      if(attempt.submissionId&&state.publications.some(record=>same(record.planId,planId)&&record.id===attempt.submissionId&&record.state==='published'))publicationAttempts.delete(planId);
    }
  }
  function publicationPlanSignature(id) {
    const plan=find(state.plans,id),account=find(state.profiles,plan?.profileId)?.marketAccount,photos=photoSummary(id);
    return plan?JSON.stringify({id:plan.id,profileId:plan.profileId,productId:plan.productId,sku:plan.sku,enabled:plan.enabled,activeListingId:plan.activeListingId||null,targetCount:plan.targetCount,completedCount:plan.completedCount,currency:plan.currency,price:plan.listingPriceCents,listing:plan.listing,account:account?.memberId,claimId:photos?.claimId,photoState:photos?.state}):'';
  }
  function canSubmitPublication(id) {
    const plan=find(state.plans,id),account=find(state.profiles,plan?.profileId)?.marketAccount;
    return !!plan&&plan.enabled===true&&!plan.activeListingId&&account?.platform==='vinted-fr'&&!!account.username&&!!account.verifiedAt&&photoSummary(id)?.ready===true&&reportKind==='publication'&&selectedPlanId===String(id)&&pageReport?.readyForPublication===true&&pageReport.manualPublicationEnabled!==false&&publicationReviewedPlan===publicationPlanSignature(id)&&!openPublication(id)&&!publicationAttempts.has(String(id))&&!state.running&&!state.configBusy&&!state.faulted;
  }
  function renderPublicationResult() {
    const result=$('#publication-submission-result');result.replaceChildren();result.hidden=reportKind!=='publication';if(result.hidden)return;
    const record=openPublication(selectedPlanId),attempt=publicationAttempts.get(String(selectedPlanId));
    if(publishedPublication(selectedPlanId)&&!attempt){
      result.append(el('div','report-status good','已核对发布成功，刊登回执已保存。'),el('p','field-hint',`提交记录：${record.id}`),el('p','field-hint',`在售商品编号：${find(state.plans,selectedPlanId).activeListingId}`),el('p','field-hint','已有在售商品，不能重复发布。消息、报价、运单及采购仍按各自的流程验证状态运行。'));return;
    }
    if(record||attempt){
      const message=attempt?.pending?'正在发送一次发布请求并核对页面，请保持当前环境打开。':attempt?.message||record?.reason||'原发布提交记录尚未完成核对，请查看原刊登页面。';
      result.append(el('div','report-status warn',attempt?.pending?'正在提交，尚未确认发布结果。':'发布结果待核对，请勿重复点击发布。'),el('p','field-hint',message));
      const id=attempt?.submissionId||record?.id;if(id)result.append(el('p','field-hint',`提交记录：${id}`));
      if(attempt?.clickIssued===true)result.append(el('p','field-hint','已发送一次页面点击；目前没有已验证的发布成功回执。'));
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
    finally{reconcilePublicationAttempts();renderPageReport();renderControls();renderPlans();renderDistribution();}
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
        name.append(el('b','',profileName(plan.profileId)),el('small','','Vinted · 法国站 / EUR'),el('small','distribution-account',account?.platform==='vinted-fr'&&typeof account.username==='string'&&account.username&&account.verifiedAt?`已核对账号：${account.username}`:'账号未核对'));
        const states=el('div','distribution-badges');states.append(badge(operation.label,operation.tone),badge(plan.enabled?'计划已启用':'计划未启用'));heading.append(name,states);
        const metrics=el('dl','distribution-metrics');for(const [label,value] of [['上架价格',currency(plan.listingPriceCents)],['最低接受价格',currency(plan.minOfferCents)],['累计成交 / 目标',`${number(plan.completedCount)} / ${number(plan.targetCount)}`],['实际在售编号',plan.activeListingId?String(plan.activeListingId):'待发布 · 暂无回执']]){const metric=el('div','distribution-metric');metric.append(el('dt','',label),el('dd','',value));metrics.append(metric);}
        const next=el('div',`distribution-next ${operation.tone==='warn'?'warn':''}`);next.append(el('b','','下一步'),el('span','',operation.next));
        const actions=el('div','distribution-actions'), edit=makeButton('编辑计划',()=>editPlan(plan)), open=makeButton('打开刊登页',()=>request(`plan-open-${plan.id}`,()=>api.openListing(plan.id),'已打开对应环境的刊登页面')), photos=makeButton('照片与上传',()=>openPhotoPlan(plan.id)), records=makeButton('任务记录',()=>showPlanJobs(plan.id));
        edit.disabled=disabled;open.disabled=disabled||!find(state.profiles,plan.profileId);photos.disabled=checking||!!state.faulted;actions.append(edit,open,photos,records);
        if(typeof api.inspectAccount==='function'){const accountCheck=makeButton('核对账号',()=>request(`plan-preflight-account-${plan.id}`,()=>api.inspectAccount(plan.id),result=>result?.account?.username?`已核对账号：${result.account.username}`:'账号核对完成，请查看环境记录'));accountCheck.disabled=disabled||!!state.running;actions.append(accountCheck);}
        if(typeof api.inspectPublication==='function'){const publication=makeButton('核对发布条件',()=>inspectPlan(plan.id,'publication'));publication.disabled=disabled||!!state.running;actions.append(publication);}
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
      const card=el('article','plan-card'), head=el('div','plan-head'), heading=el('div'), actions=el('div','plan-actions');
      heading.append(el('div','plan-name',plan.name || productName(plan.productId)),el('div','plan-meta',`${profileName(plan.profileId)} · SKU ${plan.sku || find(state.products,plan.productId)?.sku || '—'} · 法国站 / EUR`));
      const checking=pageActionPending();
      const toggle=makeButton(plan.enabled?'停用':'启用',()=>request(`plan-${plan.id}`,()=>api.setPlanEnabled(plan.id,!plan.enabled),plan.enabled?'计划已停用':'计划已启用'));toggle.disabled=pending.has(`plan-${plan.id}`)||checking;
      const edit=makeButton('编辑',()=>editPlan(plan));edit.disabled=checking;
      const open=makeButton('打开刊登页',()=>request(`plan-open-${plan.id}`,()=>api.openListing(plan.id),'已打开对应环境的刊登页面'));open.disabled=checking||!!state.faulted;
      const check=makeButton('核对资料',()=>inspectPlan(plan.id,'preflight')), fill=makeButton('填写页面',()=>inspectPlan(plan.id,'draft'));
      check.disabled=fill.disabled=!!state.faulted||checking;fill.title='只填写可以核对的字段，不会点击发布。';
      actions.append(badge(plan.enabled?'已启用':'未启用',plan.enabled?'good':'neutral'),edit,open,check,fill,toggle);head.append(heading,actions);
      const metrics=el('div','plan-metrics');
      for (const [name,value] of [['累计成交 / 目标',`${number(plan.completedCount)} / ${number(plan.targetCount)}`],['上架价格',currency(plan.listingPriceCents)],['最低接受价格',currency(plan.minOfferCents)],['当前商品',plan.activeListingId?'在售中':'暂无在售记录']]) { const metric=el('div');metric.append(el('span','',name),el('b','',value));metrics.append(metric); }
      const footer=el('div','plan-footer');footer.append(badge('每个 SKU 最多一个在售商品'),badge(plan.reuseOwnPhotos?'可复用自己的图片':'每次使用新图片'),badge(plan.autoReply?'自动回复规则已保存':'消息待人工处理'),badge(plan.autoAcceptOffers?'底价接受规则已保存':'报价待人工处理'));if(plan.status)footer.append(statusBadge(plan.status));
      card.append(head,metrics,renderPlanPhotoActions(plan),footer);list.append(card);
    }
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
    $('#inventory-empty').hidden=!!products.length;$('#inventory-empty').textContent=state.products.length?'没有找到匹配商品。':isConnected()?'货盘暂无商品；同步后会显示可用商品。':'先保存 API 设置并检查连接，再同步货盘。';
    for (const product of products) {
      const row=el('tr'), name=el('td');name.append(el('b','',product.name || '未命名商品'),el('small','',`SKU ${product.sku || '—'}`));
      const actions=el('td'), group=el('div','table-actions');group.append(makeButton('图片',()=>{photoProductId=String(product.id);renderPhotos();$('#photos-heading').scrollIntoView({behavior:'smooth',block:'center'});}),makeButton('建计划',()=>editPlan(null,product.id)));
      actions.append(group);row.append(name,el('td','',product.stock===null||product.stock===undefined?'待核对':product.stock),el('td','',currency(product.priceCents)),el('td','',product.photoSetsAvailable ?? '—'),actions);tbody.append(row);
    }
    renderPhotos();
  }
  function renderPhotos() {
    const rows=state.photoSets.filter(set=>!photoProductId || same(set.productId,photoProductId)), list=$('#photo-sets');list.replaceChildren();
    $('#photos-heading').textContent=photoProductId?`${productName(photoProductId)} · 图片套装`:'图片套装';$('#clear-photo-filter').hidden=!photoProductId;
    if (!rows.length) { list.append(empty('暂无图片套装。同步货盘后查看可用性与占用状态。',true));return; }
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
    if(job.error){detail.append(el('h3','','需要核对的问题'),el('div','form-error',typeof job.error==='string'?job.error:typeof job.error.message==='string'?job.error.message:'请核对真实页面和原请求记录。'));}
    if(job.result&&typeof job.result==='object'){
      const receipt=el('dl','detail-grid');
      for(const [key,name] of [['externalId',job.type==='listing'?'刊登编号':job.type==='fulfillment'?'货盘订单编号':'外部回执编号'],['listingId','刊登编号'],['orderId','订单编号'],['wmsStatus','仓库状态'],['status','回执状态'],['message','说明']])if(typeof job.result[key]==='string'||typeof job.result[key]==='number')receipt.append(el('dt','',name),el('dd','',job.result[key]));
      if(receipt.childElementCount)detail.append(el('h3','','执行回执'),receipt);
    }
    const canReconcile=reviewStates.has(job.state)&&job.type==='fulfillment'&&!!job.result?.externalId;
    $('#reconcile-form').hidden=!canReconcile;
    $('#retry-form').hidden=job.canRetry!==true;
    if(reviewStates.has(job.state)&&!canReconcile&&job.canRetry!==true)detail.append(el('p','field-hint','此任务需要核对真实页面或原请求回执。当前版本不会仅凭手工填写编号重新执行，记录会继续保留。'));
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
    $('#preflight-dialog .preflight-note p').textContent=reportKind==='publication'?'逐项核对账号、商品资料、价格和上传照片；本次检查不会点击发布或保存草稿。':'按计划填写能够核对的字段，缺少的内容会列出；不会点击发布、发送消息、接受报价或提交采购。图片与网页选项仍需逐项核对。';
    const plan=find(state.plans,selectedPlanId);detail.append(el('p','report-plan',`${plan?.name||'上架计划'} · ${profileName(plan?.profileId)}`));
    if(reportError){detail.append(el('div','form-error',reportError));return;}
    if(!pageReport){detail.append(el('p','report-loading',reportKind==='draft'?'正在核对并填写页面…':'正在读取商品、图片与当前网页…'));return;}
    const report=pageReport;
    if(reportKind==='publication'){
      const submitted=!!openPublication(selectedPlanId)||publicationAttempts.has(String(selectedPlanId)),published=!!publishedPublication(selectedPlanId)&&!publicationAttempts.has(String(selectedPlanId));
      detail.append(el('div',`report-status ${published||report.readyForPublication&&!submitted?'good':'warn'}`,published?'刊登回执已验证并保存，以下为此前的发布条件检查。':submitted?'以下为提交前的检查记录；当前发布结果仍需核对。':report.readyForPublication?pageReport.manualPublicationEnabled===false?'当前发布条件已核对；手动发布尚未启用。':'当前发布条件已核对，可手动发布一次。':'发布条件仍有待核对项目，本次检查未执行发布。'));
      if(Array.isArray(report.checks)&&report.checks.length){const checks=el('div','report-checks');for(const item of report.checks.slice(0,60)){const row=el('div','report-check'),body=el('div');body.append(el('b','',typeof item.name==='string'?item.name:'检查项'));if(typeof item.detail==='string')body.append(el('p','',item.detail));row.append(badge(item.ok===true?'已通过':'待核对',item.ok===true?'good':'warn'),body);checks.append(row);}detail.append(checks);}
      reportList(detail,'仍需处理',report.blockers,'warning');if(typeof report.message==='string'&&!submitted)detail.append(el('p','field-hint',report.message));detail.append(el('p','field-hint','这里仅执行当前商品的单次发布；消息、报价、运单和采购仍按各自的流程验证状态运行。'));return;
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
    for(const [name,value] of [['检查时间',when(report.checkedAt)],['SKU',report.product?.sku],['商品名称',report.product?.name],['货盘描述',report.supplierFacts?.description],['货盘品牌',report.supplierFacts?.brand],['货盘成色',report.supplierFacts?.condition],['库存',report.product?.stock??'待核对'],['采购价',currency(report.product?.priceCents)],['可领取图片套数',report.photos?.availableCount??'待核对'],['自己的图片套数',report.photos?.ownCount??'待核对'],['图片总套数',report.photos?.totalCount??'待核对'],['网页标题',report.page?.title],['网页地址',report.page?.url],['当前账号',report.page?.accountLabel]])if(value!==undefined&&value!==null&&value!=='')grid.append(el('dt','',name),el('dd','',value));
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
    $('#readiness-settings').textContent=connected||configured?'核对上架计划':'配置连接';
    $('#connection-badge').textContent=title;$('#connection-badge').className=`pill ${connected?'good':failed?'bad':'neutral'}`;$('#sidebar-connection').textContent=connected?'货盘连接正常':failed?'货盘连接异常':configured?'货盘配置已保存 · 待检查连接':'货盘尚未配置';$('#sidebar-dot').className=connected?'connected':failed?'failed':'';
    const detail=$('#connection-detail');detail.replaceChildren();if(state.connection.account)detail.append(el('p','',`账号：${typeof state.connection.account==='string'?state.connection.account:state.connection.account.name || state.connection.account.id || '已认证'}`));if(Array.isArray(state.connection.scopes)&&state.connection.scopes.length)detail.append(el('p','',`已授权：${state.connection.scopes.join('、')}`));if(state.connection.checkedAt)detail.append(el('p','',`最近检查：${when(state.connection.checkedAt)}`));if(state.connection.error)detail.append(el('p','connection-error',state.connection.error));
    settingsForm.elements.token.placeholder=state.settings.hasToken?'已保存，留空保留原 Token':'填写货盘提供的 Token';$('#token-hint').textContent=state.settings.hasToken?'Token 已保存，留空会保留。更换货盘地址后请重新填写凭据。':'Token 不会显示在页面上。填写后保存，再检查连接。';
  }
  function fillSettings() { const fields=settingsForm.elements, value=state.settings;fields.baseURL.value=value.baseURL || '';fields.backgroundEnabled.checked=!!value.backgroundEnabled;fields.maxConcurrent.value=value.maxConcurrent ?? 1;fields.perOrderLimit.value=moneyInput(value.perOrderLimitCents ?? 0);fields.dailyLimit.value=moneyInput(value.dailyLimitCents ?? 0);fields.fulfillmentMethod.value=value.fulfillmentMethod==='self'?'self':'wms'; }
  function populateSelect(select,rows,label,value) { select.replaceChildren(new Option(label,''));for(const row of rows)select.add(new Option(row.name || row.sku || String(row.id),String(row.id)));select.value=value===undefined||value===null?'':String(value); }
  function editPlan(plan, productId) {
    planForm.reset();$('#plan-error').hidden=true;$('#plan-title').textContent=plan?'编辑上架计划':'新建上架计划';
    const fields=planForm.elements;fields.id.value=plan?.id || '';populateSelect(fields.profileId,state.profiles,'选择浏览器环境',plan?.profileId);populateSelect(fields.productId,state.products,'选择货盘商品',plan?.productId ?? productId);fields.targetCount.value=plan?.targetCount ?? 1;fields.listingPrice.value=moneyInput(plan?.listingPriceCents);fields.minOffer.value=moneyInput(plan?.minOfferCents);fields.reuseOwnPhotos.checked=plan?.reuseOwnPhotos!==false;fields.autoReply.checked=!!plan?.autoReply;fields.autoAcceptOffers.checked=!!plan?.autoAcceptOffers;fields.enabled.checked=!!plan?.enabled;fields.replyPolicy.value=plan?.replyPolicy || '';
    for(const [key,field] of Object.entries(listingFields))fields[field].value=key==='categoryPath'?(plan?.listing?.[key]||[]).join(' / '):plan?.listing?.[key]||'';
    if(!plan&&state.profiles.length===1)fields.profileId.value=String(state.profiles[0].id);
    updateProductInfo(!plan);planDialog.showModal();
  }
  function updateProductInfo(resetPrice=false) {const product=find(state.products,planForm.elements.productId.value);$('#plan-product-info').textContent=product?`SKU ${product.sku || '—'} · 库存 ${product.stock ?? '待核对'} · 采购价 ${currency(product.priceCents)} · 可用图片 ${product.photoSetsAvailable ?? '待核对'} 套`:'选择货盘商品后查看库存和图片。';if(resetPrice){planForm.elements.listingPrice.value='';planForm.elements.minOffer.value='';for(const field of Object.values(listingFields))planForm.elements[field].value='';} }

  document.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>changePage(button.dataset.page)));
  document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>document.getElementById(button.dataset.close).close()));
  $('#readiness-settings').addEventListener('click',()=>changePage(isConnected()||state.settings.hasToken?'plans':'settings'));
  $('#preflight-edit').addEventListener('click',()=>{const plan=find(state.plans,selectedPlanId);if(plan){preflightDialog.close();editPlan(plan);}});
  $('#preflight-fill').addEventListener('click',()=>{if(selectedPlanId)void inspectPlan(selectedPlanId,'draft');});
  $('#publication-submit').addEventListener('click',()=>{void submitPublication();});
  for(const action of ['inspect','prepare','upload','preview'])$('#photo-'+action).addEventListener('click',()=>{if(selectedPhotoPlanId)void runPhotoAction(selectedPhotoPlanId,action).catch(error=>toast(cleanError(error)));});
  $('#new-plan').addEventListener('click',()=>editPlan());$('#overview-new-plan').addEventListener('click',()=>editPlan());
  for(const [id,event] of [['distribution-search','input'],['distribution-profile','change'],['distribution-status','change']])$('#'+id).addEventListener(event,()=>{distributionLimit=100;renderDistribution();});
  $('#distribution-reset').addEventListener('click',()=>{for(const id of ['distribution-search','distribution-profile','distribution-status'])$('#'+id).value='';distributionLimit=100;renderDistribution();});
  $('#distribution-more').addEventListener('click',()=>{distributionLimit+=100;renderDistribution();});
  $('#clear-job-plan').addEventListener('click',()=>{jobPlanFilter='';renderJobs();});
  $('#plan-search').addEventListener('input',renderPlans);$('#product-search').addEventListener('input',renderInventory);$('#job-filter').addEventListener('change',renderJobs);$('#clear-photo-filter').addEventListener('click',()=>{photoProductId='';renderPhotos();});planForm.elements.productId.addEventListener('change',()=>updateProductInfo(true));
  settingsForm.addEventListener('input',()=>{settingsDirty=true;});settingsForm.addEventListener('change',()=>{settingsDirty=true;});
  act($('#runner-toggle'),'running',()=>api.setRunning(!state.running),()=>state.running?'持续调度已启动':'调度已暂停，当前外部操作仍以任务回执为准');
  act($('#run-once'),'once',()=>api.runOnce(),'检查完成，请查看任务记录');
  act($('#sync'),'sync',()=>api.sync(),'货盘已同步');
  act($('#connect'),'connect',()=>api.connect(),()=>isConnected()?'货盘连接成功':'已完成连接检查，请查看结果');
  settingsForm.addEventListener('submit',event=>{event.preventDefault();void request('settings',async()=>{const fields=settingsForm.elements, baseURL=fields.baseURL.value.trim();if(baseURL){const url=new URL(baseURL);if(!['https:','http:'].includes(url.protocol))throw Error('API 地址必须使用 HTTP 或 HTTPS。');}const input={baseURL,token:fields.token.value,clearToken:fields.clearToken.checked,backgroundEnabled:fields.backgroundEnabled.checked,maxConcurrent:integer(fields.maxConcurrent.value,1,3,'并行环境数'),perOrderLimitCents:cents(fields.perOrderLimit.value,'单笔采购上限'),dailyLimitCents:cents(fields.dailyLimit.value,'每日采购上限'),fulfillmentMethod:fields.fulfillmentMethod.value,accountType:'personal',market:'FR'};if(input.dailyLimitCents&&input.perOrderLimitCents>input.dailyLimitCents)throw Error('单笔采购上限不能高于每日采购上限。');await api.saveSettings(input);fields.token.value='';fields.clearToken.checked=false;settingsDirty=false;},'设置已保存').catch(()=>{});});
  planForm.addEventListener('submit',event=>{event.preventDefault();$('#plan-error').hidden=true;void request('plan',async()=>{const fields=planForm.elements,product=find(state.products,fields.productId.value);if(!find(state.profiles,fields.profileId.value))throw Error('请选择可用的浏览器环境。');if(!product)throw Error('请选择货盘商品。');const listingPriceCents=cents(fields.listingPrice.value,'上架价格',true),minOfferCents=cents(fields.minOffer.value,'最低接受价格',true);if(minOfferCents>listingPriceCents)throw Error('最低接受价格不能高于上架价格。');const input={profileId:fields.profileId.value,productId:fields.productId.value,sku:product.sku || '',name:product.name || product.sku || '',targetCount:integer(fields.targetCount.value,1,1000,'累计销售目标'),listingPriceCents,minOfferCents,currency:'EUR',enabled:fields.enabled.checked,autoReply:fields.autoReply.checked,autoAcceptOffers:fields.autoAcceptOffers.checked,reuseOwnPhotos:fields.reuseOwnPhotos.checked,replyPolicy:fields.replyPolicy.value.trim(),listing:Object.fromEntries(Object.entries(listingFields).map(([key,field])=>[key,fields[field].value.trim()]))};if(fields.id.value)input.id=fields.id.value;await api.savePlan(input);planDialog.close();},'计划已保存').catch(error=>{$('#plan-error').textContent=cleanError(error);$('#plan-error').hidden=false;});});
  $('#reconcile-form').addEventListener('submit',event=>{event.preventDefault();void request('resolve',()=>api.resolve(selectedJobId,'reconcile',{}),'原订单检查完成，请查看任务状态').catch(()=>{});});
  $('#retry-form').addEventListener('submit',event=>{event.preventDefault();if(find(state.jobs,selectedJobId)?.canRetry!==true)return;void request('resolve',()=>api.resolve(selectedJobId,'retry',{}),'任务已重新排队，尚未执行').catch(()=>{});});
  api.onState(applyState);
  void refresh().catch(error=>{$('#load-error').textContent=`无法读取工作台状态：${cleanError(error)}`;$('#load-error').hidden=false;});
})();
