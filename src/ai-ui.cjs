(() => {
  const $ = selector => document.querySelector(selector);
  const api = window.browser;
  const settingsDialog = $('#ai-settings-dialog'), settingsForm = $('#ai-settings-form');
  const labels = {idle:'准备就绪',reading:'正在读取页面',thinking:'模型正在判断下一步',running:'正在操作页面',preparing:'正在定位目标',acting:'正在操作页面',verifying:'正在检查操作结果',pausing:'当前操作结束后暂停',paused:'已暂停，等待你继续',approval:'等待你确认',stopping:'正在停止',stopped:'任务已停止',complete:'任务完成',limit:'已达步数上限',error:'任务出错',blocked:'目标暂不可操作'};
  const actionLabels = {inspect:'查看页面',click:'点击控件',type:'填写内容',key:'使用按键',scroll:'滚动页面',navigate:'打开页面',wait:'等待页面更新'};
  const actionSymbols = {inspect:'◎',click:'↗',type:'T',key:'⌘',scroll:'↕',navigate:'↗',wait:'◷'};
  const kindLabels = {status:'进度',task:'任务',action:'操作',info:'进度',error:'需要注意',result:'结果',observation:'页面变化',approval:'等待确认',warning:'提示',recovery:'重新判断',thought:'下一步',model:'模型'};
  let panel = false, approval = null, latest = {status:'idle',running:false,logs:[]};
  let settings = {}, finishedAt = null, logSignature = '', lastTaskStart = null, pendingCommand = false, startPending = false;
  const cleanError = e => String(e?.message || e || '操作失败').replace(/^Error invoking remote method '[^']+': Error: /,'');
  function error(e) { const result=$('#ai-result'); result.hidden=false; result.dataset.kind='error'; result.textContent=cleanError(e); }
  function privacy(s) {
    settings = {model:s.model??settings.model,visionEnabled:s.visionEnabled??settings.visionEnabled};
    $('#ai-privacy-summary').textContent = `当前标签控制 · ${settings.visionEnabled?'文字 + 视觉模式':'文字模式'}`;
    $('#ai-privacy-text').textContent = settings.visionEnabled
      ? '任务会将页面文字、控件信息和截图发送到你配置的模型服务。输入区域会遮盖；其他可见内容仍会发送。'
      : '任务会将当前页文字和控件信息发送到你配置的模型服务；不读取输入框已有值。';
    if(!latest.progress?.model) $('#ai-model').textContent = settings.model || '选择模型后即可开始';
  }
  async function openSettings() {
    try {
      const s=await api.aiSettings(); privacy(s); settingsForm.reset();
      for(const key of ['baseURL','protocol','model','maxSteps']) if(s[key]!=null) settingsForm.elements[key].value=s[key];
      settingsForm.elements.visionEnabled.checked=Boolean(s.visionEnabled);
      settingsForm.elements.apiKey.placeholder=s.hasKey?'已保存，留空保持不变':'填写 API Key（本地服务可留空）';
      $('#ai-settings-error').textContent='';
      if(!settingsDialog.open) settingsDialog.showModal();
    } catch(e) { error(e); }
  }
  function asTime(value) {
    if(typeof value==='number') return value;
    const time=Date.parse(value); return Number.isFinite(time)?time:null;
  }
  function updateElapsed() {
    const started=asTime(latest.progress?.startedAt);
    if(started==null) { $('#ai-elapsed').textContent=''; return; }
    const seconds=Math.max(0,Math.floor(((latest.running?Date.now():finishedAt??Date.now())-started)/1000));
    const minutes=Math.floor(seconds/60);
    $('#ai-elapsed').textContent=minutes?`${minutes} 分 ${String(seconds%60).padStart(2,'0')} 秒`:`${seconds} 秒`;
  }
  function updateButtons() {
    const active=Boolean(latest.running), paused=latest.status==='paused';
    $('#ai-run').hidden=active; $('#ai-run').disabled=active||pendingCommand||startPending;
    $('#ai-goal').disabled=active;
    $('#ai-settings-button').disabled=active||pendingCommand||startPending;
    $('#ai-stop').disabled=!active||latest.status==='stopping'||pendingCommand;
    $('#ai-stop-top').hidden=!active; $('#ai-stop-top').disabled=latest.status==='stopping'||pendingCommand;
    $('#ai-pause').hidden=!active;
    $('#ai-pause').textContent=paused?'继续':latest.status==='pausing'?'正在暂停…':'暂停';
    $('#ai-pause').disabled=!active||['approval','pausing','stopping'].includes(latest.status)||pendingCommand;
    $('#ai-toggle').textContent=active?(latest.approval?'✦ 待确认':paused?'✦ AI 已暂停':'✦ AI 运行中'):'✦ AI 控制';
    $('.ai-shortcut').hidden=active;
  }
  function renderLogs(logs) {
    const root=$('#ai-logs');
    const signature=JSON.stringify(logs);
    if(signature===logSignature) return;
    const following=root.scrollHeight-root.scrollTop-root.clientHeight<28;
    const previousScroll=root.scrollTop;
    logSignature=signature;
    root.replaceChildren();
    if(!logs.length) {
      const empty=document.createElement('div'); empty.className='ai-log-empty';
      empty.textContent='任务开始后，这里会保留操作与页面变化。'; root.append(empty);
    }
    for(const item of logs) {
      const row=document.createElement('div'); row.className='ai-log';
      if(/^[a-z-]+$/.test(item.kind)) row.classList.add(item.kind);
      const icon=document.createElement('span'); icon.className='ai-log-icon'; icon.setAttribute('aria-hidden','true');
      icon.textContent=item.kind==='error'?'!':item.kind==='action'?'↗':['observation','result'].includes(item.kind)?'✓':'·';
      const body=document.createElement('div'); body.className='ai-log-body';
      const meta=document.createElement('div'); meta.className='ai-log-meta';
      const kind=document.createElement('span'); kind.textContent=kindLabels[item.kind]||'记录'; meta.append(kind);
      if(Number.isFinite(item.step)&&item.step>0) { const step=document.createElement('span'); step.textContent=`第 ${item.step} 步`; meta.append(step); }
      const stamp=asTime(item.time);
      if(stamp!=null) { const time=document.createElement('time'); time.dateTime=new Date(stamp).toISOString(); time.textContent=new Date(stamp).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}); meta.append(time); }
      const text=document.createElement('div'); text.className='ai-log-text'; text.textContent=String(item.text||'');
      body.append(meta,text); row.append(icon,body); root.append(row);
    }
    $('#ai-log-count').textContent=logs.length?`${logs.length} 条`:'';
    if(following||!logs.length) { root.scrollTop=root.scrollHeight; $('#ai-new-events').hidden=true; }
    else { root.scrollTop=previousScroll; $('#ai-new-events').hidden=false; }
  }
  function renderAction(s) {
    const current=s.currentAction||{}, idle=s.status==='idle', stage=current.stage||s.status;
    let label=current.label||actionLabels[current.action]||'';
    let description=current.description||'';
    if(idle) { label='把要做的事告诉我'; description='我会显示正在操作的控件和每一步结果。你可以暂停后亲自操作，再继续任务。'; }
    else if(s.status==='paused') { label='操作已暂停'; description=current.label?`刚才的目标：${current.label}`:'等待你调整页面或继续任务。'; }
    else if(s.status==='thinking') { label='正在判断下一步'; description=current.label?`参考刚才的操作：${current.label}`:'结合任务目标和当前页面，选择下一步操作。'; }
    else if(s.status==='reading') { label='正在查看当前页面'; description='读取可操作控件和页面内容。'; }
    else if(s.status==='complete') { label='本次任务已结束'; description='操作记录和结果保留在下方，可开始新的任务。'; }
    else if(s.status==='stopping') { label='正在停止任务'; description='正在取消模型请求或结束当前操作。'; }
    else if(s.status==='stopped') { label='任务已停止'; description='你可以修改目标后重新开始。'; }
    else if(s.status==='limit') { label='已用完本次操作步数'; description='请查看结果，必要时缩小任务范围后继续。'; }
    else if(s.status==='error') { label='本次任务遇到问题'; description='查看下方错误信息，调整后可重新开始。'; }
    else if(s.status==='blocked') { label='需要调整页面或任务'; description='连续操作未能继续，请查看记录中的具体原因。'; }
    $('#ai-stage').textContent=idle?'等待任务':labels[stage]||labels[s.status]||'正在处理';
    $('#ai-current-symbol').textContent=s.status==='paused'?'Ⅱ':s.status==='complete'?'✓':actionSymbols[current.action]||'✦';
    $('#ai-current-label').textContent=label||labels[s.status]||'正在处理任务';
    $('#ai-current-description').textContent=description;
    $('#ai-current-description').hidden=!description;
    const target=$('#ai-current-target'), point=current.point;
    const showPoint=s.running&&['preparing','acting','verifying'].includes(s.status)&&Number.isFinite(point?.x)&&Number.isFinite(point?.y);
    target.hidden=!showPoint;
    target.textContent=showPoint?`页面位置 ${Math.round(point.x)}, ${Math.round(point.y)}`:'';
    $('#ai-pause-hint').hidden=s.status!=='paused';
    $('#ai-examples').hidden=!idle;
  }
  function state(s) {
    s={...s,logs:Array.isArray(s.logs)?s.logs:[]};
    const taskStart=s.progress?.startedAt??null;
    if(taskStart!==lastTaskStart) { lastTaskStart=taskStart; finishedAt=null; logSignature=''; $('#ai-logs').scrollTop=$('#ai-logs').scrollHeight; }
    if(latest.running&&!s.running) finishedAt=asTime(s.progress?.finishedAt)||Date.now();
    if(!s.running&&finishedAt==null&&taskStart!=null) finishedAt=asTime(s.progress?.finishedAt)||Date.now();
    latest=s;
    $('#ai-status').textContent=labels[s.status]||s.status;
    $('#ai-progress').dataset.active=String(Boolean(s.running)); $('#ai-progress').dataset.status=s.status;
    const progress=s.progress||{}, step=Number(progress.step)||0, max=Number(progress.maxSteps)||0;
    $('#ai-step').textContent=max?`${step} / ${max} 步`:'';
    $('#ai-progress-fill').style.width=max?`${Math.min(100,Math.max(0,step/max*100))}%`:'0%';
    $('#ai-model').textContent=progress.model||settings.model||'选择模型后即可开始';
    $('#ai-model').title=progress.model||settings.model||'';
    updateButtons(); updateElapsed(); renderAction(s); renderLogs(s.logs);
    $('#ai-result').textContent=s.result||''; $('#ai-result').hidden=!s.result;
    $('#ai-result').dataset.kind=['error','blocked'].includes(s.status)?'error':'result';
    approval=s.approval; $('#ai-approval').hidden=!approval; $('#ai-approval-text').textContent=approval?.message||'';
  }
  async function command(fn) {
    if(pendingCommand) return;
    pendingCommand=true; updateButtons();
    try { await fn(); } catch(e) { error(e); } finally { pendingCommand=false; updateButtons(); }
  }
  $('#ai-toggle').onclick=async()=>{try{await api.aiPanel(!panel);}catch(e){error(e);}};
  api.onState(s=>{panel=Boolean(s.aiPanelOpen);$('#ai-panel').hidden=!panel;$('#ai-toggle').classList.toggle('active',panel);$('#ai-toggle').setAttribute('aria-expanded',String(panel));if(!panel&&settingsDialog.open)settingsDialog.close();});
  api.onAIState(state); api.aiState().then(state).catch(error); api.aiSettings().then(privacy).catch(()=>{});
  setInterval(updateElapsed,1000);
  $('#ai-settings-button').onclick=openSettings; $('#ai-settings-cancel').onclick=()=>settingsDialog.close();
  settingsDialog.addEventListener('close',()=>{settingsForm.elements.apiKey.value='';});
  settingsForm.onsubmit=async event=>{
    event.preventDefault(); const button=settingsForm.querySelector('[type=submit]'); button.disabled=true;
    try {
      const d=Object.fromEntries(new FormData(settingsForm));
      const updated={...d,clearKey:settingsForm.elements.clearKey.checked,visionEnabled:settingsForm.elements.visionEnabled.checked};
      await api.aiSaveSettings(updated); privacy(updated); settingsDialog.close();
      $('#ai-result').hidden=false; $('#ai-result').dataset.kind='result'; $('#ai-result').textContent='模型设置已保存。';
    } catch(e) { $('#ai-settings-error').textContent=cleanError(e); } finally { button.disabled=false; }
  };
  $('#ai-run').onclick=async()=>{
    if(startPending||latest.running||pendingCommand) return;
    startPending=true; updateButtons();
    try {
    const goal=$('#ai-goal').value.trim(); if(!goal) { $('#ai-goal').focus(); error(new Error('请先告诉我需要完成的任务。')); return; }
    const s=await api.aiSettings(); privacy(s);
    if(!s.model||(!s.hasKey&&!['localhost','127.0.0.1','[::1]'].includes(new URL(s.baseURL).hostname))) { await openSettings(); return; }
    await api.aiStart(goal);
    } catch(e) { error(e); } finally { startPending=false; updateButtons(); }
  };
  $('#ai-goal').addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&!latest.running){event.preventDefault();$('#ai-run').click();}});
  $('#ai-pause').onclick=()=>command(()=>latest.status==='paused'?api.aiResume():api.aiPause());
  for(const id of ['ai-stop','ai-stop-top']) $('#'+id).onclick=()=>command(()=>api.aiStop());
  for(const button of document.querySelectorAll('[data-example]')) button.onclick=()=>{$('#ai-goal').value=button.dataset.example;$('#ai-goal').focus();};
  $('#ai-accept').onclick=()=>{if(approval)command(()=>api.aiApprove(approval.id,true));};
  $('#ai-reject').onclick=()=>{if(approval)command(()=>api.aiApprove(approval.id,false));};
  $('#ai-new-events').onclick=()=>{$('#ai-logs').scrollTop=$('#ai-logs').scrollHeight;$('#ai-new-events').hidden=true;};
  $('#ai-logs').addEventListener('scroll',()=>{const root=$('#ai-logs');if(root.scrollHeight-root.scrollTop-root.clientHeight<28)$('#ai-new-events').hidden=true;},{passive:true});
})();
