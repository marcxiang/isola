'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const api = window.commerce;
  const settingsForm = $('#settings-form');
  const planForm = $('#plan-form');
  const planDialog = $('#plan-dialog');
  const jobDialog = $('#job-dialog');
  const preflightDialog = $('#preflight-dialog');
  const reviewStates = new Set(['needs_review', 'pending_review', 'waiting_review', 'review', 'unknown', 'uncertain', 'blocked', 'failed', 'error']);
  const completedStates = new Set(['completed', 'complete', 'done', 'succeeded']);
  const cancelledStates = new Set(['cancelled', 'canceled', 'rejected']);
  const stateNames = {queued:'待执行', pending:'待执行', running:'执行中', waiting:'等待条件', awaiting_result:'等待结果', retry_wait:'等待检查', needs_review:'需要核对', pending_review:'需要核对', waiting_review:'需要核对', review:'需要核对', unknown:'结果未知', uncertain:'结果未知', blocked:'已暂停', failed:'执行失败', error:'执行失败', completed:'已完成', complete:'已完成', done:'已完成', succeeded:'已完成', cancelled:'已取消', canceled:'已取消', rejected:'已拒绝', paused:'已暂停', disabled:'未启用', enabled:'已启用', ready:'待执行', active:'在售中', listed:'在售中', fulfilling:'履约中', target_reached:'销售目标已达成', waiting_sale:'等待成交', awaiting_sale:'等待成交', draft:'草稿', unverified:'待验证'};
  const jobNames = {listing:'商品上架', list:'商品上架', publish:'商品上架', reply:'回复消息', message:'回复消息', messages:'检查消息', offer:'处理报价', offers:'检查报价', accept_offer:'接受报价', label:'获取运单', shipping_label:'获取运单', shipment:'获取运单', fulfillment:'面单与货盘履约', procurement:'货盘采购', purchase:'货盘采购', order:'货盘采购', reconcile:'核对结果', sync:'同步货盘'};
  const stepNames = {pending:'检查执行条件',claim_photos:'领取商品图片',prepare_listing:'准备刊登草稿',publish_listing:'提交刊登',record_listing:'记录刊登回执',draft_reply:'准备商品回复',send_reply:'发送回复',check_offer:'核对报价',accept_offer:'接受报价',download_label:'下载并核对运单',check_stock_price:'核对库存与采购价',wms_checkout:'核对可用仓库',create_supplier_order:'提交货盘订单',verified:'核对完成'};
  const pageDetails = {overview:['运营概览','从商品、上架到订单，每一步都有记录。'],plans:['上架计划','为每个环境设置商品、销售目标与价格规则。'],inventory:['货盘与图片','核对商品库存，区分自己的图片与他人占用的套装。'],jobs:['任务记录','检查每一步的执行状态与外部平台回执。'],settings:['连接与规则','连接货盘，并为后台执行设置明确的范围。']};
  let state = {settings:{},connection:{status:'not_configured'},profiles:[],products:[],photoSets:[],plans:[],jobs:[],events:[],running:false,readiness:{vinted:'unverified'}};
  let currentPage = 'overview', settingsDirty = false, photoProductId = '', selectedJobId = '', selectedPlanId = '', toastTimer;
  let pageReport = null, reportKind = 'preflight', reportError = '';
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
    pending.add(key); renderControls(); if(key.startsWith('plan-'))renderPlans();
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
  function isConnected() { return ['connected','ok','ready','authenticated','success'].includes(state.connection.status); }
  function changePage(page) { currentPage = page in pageDetails ? page : 'overview'; document.querySelectorAll('.page-section').forEach(section => { section.hidden = section.id !== `page-${currentPage}`; }); document.querySelectorAll('[data-page]').forEach(button => { const active=button.dataset.page===currentPage; button.classList.toggle('active',active); if(active)button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); }); $('#page-title').textContent=pageDetails[currentPage][0]; $('#page-description').textContent=pageDetails[currentPage][1]; }

  function applyState(incoming) {
    if (!incoming || typeof incoming !== 'object') return;
    state = {...state,...incoming,settings:{...state.settings,...incoming.settings},connection:{...state.connection,...incoming.connection},readiness:{...state.readiness,...incoming.readiness}};
    for (const key of ['profiles','products','photoSets','plans','jobs','events']) if (!Array.isArray(state[key])) state[key]=[];
    $('#load-error').hidden = !state.faulted;
    if (state.faulted) $('#load-error').textContent = '运营数据无法安全写入，外部操作已停止。请检查本机存储后重新打开应用。';
    renderSummary(); renderPlans(); renderInventory(); renderJobs(); renderEvents(); renderConnection(); renderControls();
    if (!settingsDirty) fillSettings();
    if (jobDialog.open && selectedJobId) renderJobDetail();
  }
  function renderControls() {
    const active = !!state.running;
    $('#runner-status').classList.toggle('running',active);
    $('#runner-status').replaceChildren(el('i'),document.createTextNode(active ? ' 调度中' : ' 已暂停'));
    $('#runner-toggle').textContent = pending.has('running') ? '正在更新…' : active ? '暂停调度' : '启动调度';
    $('#runner-toggle').disabled = pending.has('running') || (!active && (!state.settings.backgroundEnabled || state.faulted));
    $('#runner-toggle').title = !active && !state.settings.backgroundEnabled ? '先在「连接与规则」中保存后台持续调度设置。' : '';
    $('#run-once').disabled = pending.has('once') || !!state.faulted; $('#run-once').textContent = pending.has('once') ? '正在检查…' : '检查一次';
    $('#sync').disabled = pending.has('sync') || pending.has('connect'); $('#sync').textContent = pending.has('sync') ? '正在同步…' : '同步货盘';
    $('#connect').disabled = pending.has('connect') || pending.has('settings'); $('#connect').textContent = pending.has('connect') ? '正在连接…' : '检查已保存的连接';
    settingsForm.querySelector('[type=submit]').disabled = pending.has('settings');
    planForm.querySelector('[type=submit]').disabled = pending.has('plan');
    $('#reconcile-form [type=submit]').disabled = pending.has('resolve');
    $('#retry-form [type=submit]').disabled = pending.has('resolve') || !!state.running;
    const checking = pending.has(`plan-preflight-${selectedPlanId}`) || pending.has(`plan-draft-${selectedPlanId}`);
    $('#preflight-fill').disabled = checking || !!state.faulted || !selectedPlanId || reportKind==='preflight'&&pageReport?.readyForFields!==true;
    $('#preflight-edit').disabled = checking || !selectedPlanId;
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
    const list=$('#overview-plans'); list.replaceChildren();
    if (!state.plans.length) list.append(empty('还没有上架计划。先连接货盘，再选择环境和商品。',true));
    for (const plan of state.plans.slice(0,5)) {
      const row=el('div','compact-row'), initial=el('div','initial',profileName(plan.profileId).slice(0,1)), content=el('div','compact-main');
      content.append(el('b','',plan.name || productName(plan.productId)),el('small','',`${profileName(plan.profileId)} · ${number(plan.completedCount)} / ${number(plan.targetCount)} 件成交`));
      row.append(initial,content,badge(plan.enabled?'已启用':'未启用',plan.enabled?'good':'neutral'));list.append(row);
    }
  }
  function renderPlans() {
    const query=$('#plan-search').value.trim().toLowerCase(), rows=state.plans.filter(plan=>`${plan.name || ''} ${plan.sku || ''} ${productName(plan.productId)} ${profileName(plan.profileId)}`.toLowerCase().includes(query)), list=$('#plans');
    list.replaceChildren();
    if (!rows.length) { list.append(empty(state.plans.length?'没有匹配的计划，试试其他商品或环境名称。':'还没有计划。新建一个计划，设置累计销售目标与价格。')); return; }
    for (const plan of rows) {
      const card=el('article','plan-card'), head=el('div','plan-head'), heading=el('div'), actions=el('div','plan-actions');
      heading.append(el('div','plan-name',plan.name || productName(plan.productId)),el('div','plan-meta',`${profileName(plan.profileId)} · SKU ${plan.sku || find(state.products,plan.productId)?.sku || '—'} · 法国站 / EUR`));
      const checking=pending.has(`plan-preflight-${plan.id}`)||pending.has(`plan-draft-${plan.id}`)||pending.has(`plan-open-${plan.id}`);
      const toggle=makeButton(plan.enabled?'停用':'启用',()=>request(`plan-${plan.id}`,()=>api.setPlanEnabled(plan.id,!plan.enabled),plan.enabled?'计划已停用':'计划已启用'));toggle.disabled=pending.has(`plan-${plan.id}`)||checking;
      const edit=makeButton('编辑',()=>editPlan(plan));edit.disabled=checking;
      const open=makeButton('打开刊登页',()=>request(`plan-open-${plan.id}`,()=>api.openListing(plan.id),'已打开对应环境的刊登页面'));open.disabled=checking||!!state.faulted;
      const check=makeButton('核对资料',()=>inspectPlan(plan.id,'preflight')), fill=makeButton('填写页面',()=>inspectPlan(plan.id,'draft'));
      check.disabled=fill.disabled=!!state.faulted||checking;fill.title='只填写可以核对的字段，不会点击发布。';
      actions.append(badge(plan.enabled?'已启用':'未启用',plan.enabled?'good':'neutral'),edit,open,check,fill,toggle);head.append(heading,actions);
      const metrics=el('div','plan-metrics');
      for (const [name,value] of [['累计成交 / 目标',`${number(plan.completedCount)} / ${number(plan.targetCount)}`],['上架价格',currency(plan.listingPriceCents)],['最低接受价格',currency(plan.minOfferCents)],['当前商品',plan.activeListingId?'在售中':'暂无在售记录']]) { const metric=el('div');metric.append(el('span','',name),el('b','',value));metrics.append(metric); }
      const footer=el('div','plan-footer');footer.append(badge('每个 SKU 最多一个在售商品'),badge(plan.reuseOwnPhotos?'可复用自己的图片':'每次使用新图片'),badge(plan.autoReply?'自动回复规则已保存':'消息待人工处理'),badge(plan.autoAcceptOffers?'底价接受规则已保存':'报价待人工处理'));if(plan.status)footer.append(statusBadge(plan.status));
      card.append(head,metrics,footer);list.append(card);
    }
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
    const filter=$('#job-filter').value, rows=[...state.jobs].filter(job=>!filter || filter==='attention'&&reviewStates.has(job.state) || filter==='complete'&&completedStates.has(job.state) || filter==='active'&&!reviewStates.has(job.state)&&!completedStates.has(job.state)&&!cancelledStates.has(job.state)).sort((a,b)=>String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
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
      for(const [key,name] of [['externalId','货盘订单编号'],['listingId','刊登编号'],['orderId','订单编号'],['wmsStatus','仓库状态'],['status','回执状态'],['message','说明']])if(typeof job.result[key]==='string'||typeof job.result[key]==='number')receipt.append(el('dt','',name),el('dd','',job.result[key]));
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
    const detail=$('#preflight-detail');detail.replaceChildren();$('#preflight-title').textContent=reportKind==='draft'?'填写页面结果':'核对刊登资料';
    const plan=find(state.plans,selectedPlanId);detail.append(el('p','report-plan',`${plan?.name||'上架计划'} · ${profileName(plan?.profileId)}`));
    if(reportError){detail.append(el('div','form-error',reportError));return;}
    if(!pageReport){detail.append(el('p','report-loading',reportKind==='draft'?'正在核对并填写页面…':'正在读取商品、图片与当前网页…'));return;}
    const report=pageReport;
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
    if(pending.has(`plan-preflight-${id}`)||pending.has(`plan-draft-${id}`))return;
    selectedPlanId=String(id);reportKind=kind;pageReport=null;reportError='';renderPageReport();
    if(!preflightDialog.open)preflightDialog.showModal();
    try{const result=await request(key,()=>kind==='draft'?api.prepareDraft(id):api.preflight(id));if(result&&selectedPlanId===String(id)&&reportKind===kind)pageReport=result;}
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
  $('#new-plan').addEventListener('click',()=>editPlan());$('#overview-new-plan').addEventListener('click',()=>editPlan());
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
