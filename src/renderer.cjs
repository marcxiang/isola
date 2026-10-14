const $ = s => document.querySelector(s), form = $('#form'), dialog = $('#editor');
$('#commerce-open').onclick=()=>run(()=>window.isola.openCommerce());
let profiles = [], selected = new Set(), runtimeInfo = {}, currentWindowType = 'normal';
const profileWindowType=p=>p.windowType==='automation'?'automation':'normal';
function toast(t) { $('#toast').textContent = t; $('#toast').style.display = 'block'; clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => $('#toast').style.display = 'none', 6500); }
async function run(fn) { try { await fn(); } catch (e) { toast(e.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); } }
function button(text, fn, cls) { const b = document.createElement('button'); b.textContent = text; if (cls) b.className = cls; b.onclick = () => run(async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } }); return b; }
function matches() {const query=$('#search').value.trim().toLowerCase();return profiles.filter(p=>profileWindowType(p)===currentWindowType&&[p.name,p.id,p.isolationId,p.group,p.notes].join(' ').toLowerCase().includes(query)&&(!$('#group-filter').value||p.group===$('#group-filter').value)&&(!$('#status-filter').value||p.status===$('#status-filter').value));}
function selection(){const visible=matches();$('#selection').textContent='已选 '+selected.size+' 个';$('#select-all').checked=!!visible.length&&visible.every(p=>selected.has(p.id));$('#select-all').indeterminate=!$('#select-all').checked&&visible.some(p=>selected.has(p.id));}
function node(tag,cls,value){const element=document.createElement(tag);if(cls)element.className=cls;if(value!==undefined&&value!==null)element.textContent=String(value);return element;}
function dateLabel(value){const date=new Date(value||'');return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'尚未打开';}
function hasProxyCheck(profile){const check=profile.proxyCheck;return typeof check?.ip==='string'&&/^[0-9a-f:.]{2,64}$/i.test(check.ip)&&Number.isFinite(new Date(check.checkedAt||'').getTime());}
function menuPosition(details,menu){if(!details.open)return;for(const other of document.querySelectorAll('.more[open]'))if(other!==details)other.open=false;const rect=details.getBoundingClientRect();menu.style.left=Math.max(10,Math.min(innerWidth-186,rect.right-176))+'px';menu.style.top=Math.max(10,Math.min(rect.bottom+6,innerHeight-menu.offsetHeight-12))+'px';}
function render(){
 const rows=$('#rows');rows.replaceChildren();$('#total').textContent=profiles.length;$('#running').textContent=profiles.filter(p=>p.status==='running'||p.running&&p.status!=='starting').length;$('#proxied').textContent=profiles.filter(p=>p.proxy?.type&&p.proxy.type!=='direct').length;
 for(const type of ['normal','automation']){const tab=$('#window-type-'+type),active=type===currentWindowType;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;$('#'+type+'-count').textContent=profiles.filter(p=>profileWindowType(p)===type).length;}$('#environment-list').setAttribute('aria-labelledby','window-type-'+currentWindowType);
 const group=$('#group-filter'),previous=group.value;group.replaceChildren(new Option('全部分组',''));for(const name of [...new Set(profiles.map(p=>p.group).filter(Boolean))].sort())group.add(new Option(name,name));group.value=previous;
 const visible=matches(),visibleIds=new Set(visible.map(p=>p.id)),categoryCount=profiles.filter(p=>profileWindowType(p)===currentWindowType).length;selected=new Set([...selected].filter(id=>visibleIds.has(id)));$('#visible-count').textContent=visible.length+' / '+categoryCount+' 个'+(currentWindowType==='automation'?'自动化窗口':'正常窗口');
 const checkedIPs=new Map();for(const profile of profiles)if(hasProxyCheck(profile)){const ip=profile.proxyCheck.ip.toLowerCase();checkedIPs.set(ip,(checkedIPs.get(ip)||0)+1);}
 if(!visible.length){const row=node('tr','empty-row'),cell=node('td'),message=node('div','empty',categoryCount?'没有找到匹配环境。试试调整搜索或筛选条件。':'这个分类还没有环境。点击「新建环境」，选择窗口用途并创建独立会话。');cell.colSpan=9;cell.append(message);row.append(cell);rows.append(row);}
 for(const p of visible){
  const running=p.status==='running'||p.running===true,starting=p.status==='starting',proxy=p.proxy||{type:'direct'},row=node('tr','row'+(selected.has(p.id)?' selected':''));
  row.dataset.profileId=String(p.id);row.dataset.isolationId=String(p.isolationId||p.id);row.dataset.state=p.status||(running?'running':'closed');row.dataset.fingerprintMode=p.fingerprintMode||'custom';row.dataset.operatingSystem=p.operatingSystem||'native';row.dataset.windowType=profileWindowType(p);
  const checkCell=node('td','check-cell'),box=document.createElement('input');box.type='checkbox';box.checked=selected.has(p.id);box.setAttribute('aria-label','选择 '+p.name);box.onchange=()=>{box.checked?selected.add(p.id):selected.delete(p.id);row.classList.toggle('selected',box.checked);selection();};checkCell.append(box);
  const idCell=node('td','id-cell'),id=node('code','environment-id',String(p.isolationId||p.id).slice(0,8));id.title='独立环境 ID：'+String(p.isolationId||p.id);idCell.append(id);
  const detail=node('td','details'),badge=node('span','badge'+(running&&!starting?' live':''),starting?'启动中':running?'已打开':'已关闭');detail.append(node('b','',p.name),badge,node('span','window-type-badge',profileWindowType(p)==='automation'?'自动化':'正常'));
  const groupCell=node('td','group-label',p.group||'未分组'),device=node('td','device-cell');
  device.append(node('span','device-title',p.fingerprintMode==='native'?'本机原生':(osNames[p.operatingSystem]||'当前电脑')+(p.deviceModel?' / '+p.deviceModel:'')),node('div','meta',p.width+' × '+p.height+(p.fingerprintMode==='native'?' · 宿主设备':(p.deviceScaleFactor?' / '+p.deviceScaleFactor+'×':'')+' · '+(p.language||'')+' · '+(p.timezone||''))));
  const proxyCell=node('td','proxy-cell'),endpoint=proxy.type==='direct'?'直连':String(proxy.type||'').toUpperCase()+' · '+(proxy.host||'')+':'+(proxy.port||'');proxyCell.append(node('span','proxy-endpoint',endpoint));if(proxy.type==='direct')proxyCell.append(node('span','proxy-check-time','使用系统网络'));
  const checked=p.proxyCheck,hasCheck=hasProxyCheck(p);row.dataset.proxyChecked=String(hasCheck);
  if(hasCheck){proxyCell.append(node('span','proxy-ip',checked.ip),node('span','proxy-check-time','上次检测 '+dateLabel(checked.checkedAt)+(Number.isFinite(checked.ms)?' · '+Math.round(checked.ms)+' ms':'')));}else proxyCell.append(node('span','proxy-check-time','出口未检测'));
  if(hasCheck&&checkedIPs.get(checked.ip.toLowerCase())>1)proxyCell.append(node('span','proxy-shared-note','上次检测出口与其他环境相同 · '+dateLabel(checked.checkedAt)));
  const opened=node('td','last-opened',dateLabel(p.lastOpenedAt));if(p.lastOpenedAt)opened.title=String(p.lastOpenedAt);const notesCell=node('td'),notes=node('div','notes',p.notes||'—');notes.title=p.notes||'';notesCell.append(notes);
  const actionCell=node('td','actions-cell'),actions=node('div','actions'),open=button(running?'关闭':'打开',()=>running?window.isola.stop(p.id):window.isola.launch(p.id),running?'':'primary');open.disabled=starting;
  const editButton=button('编辑',()=>{if(running||starting)throw Error('请先关闭环境');edit(p);});editButton.disabled=running||starting;actions.append(open,editButton);
  const more=node('details','more'),summary=node('summary','','更多'),menu=node('div');summary.setAttribute('aria-label',p.name+' 更多操作');
  const duplicate=button('复制配置',async()=>{more.open=false;await window.isola.duplicate(p.id);toast('已复制配置，浏览数据不会复制');});
  const test=button('检测出口 IP',async()=>{more.open=false;toast('正在检测出口 IP…');const result=await window.isola.test(p);profiles=await window.isola.list();render();toast(p.name+' · '+result.ip+' · '+result.ms+' ms');});
  const clear=button('清理浏览数据',async()=>{more.open=false;if(running||starting)throw Error('请先关闭环境');if(confirm('清理「'+p.name+'」的 Cookie、站点存储和缓存？此操作无法撤销，环境配置会保留。')){await window.isola.clear(p.id);toast('浏览数据已清理');}});
  const remove=button('删除环境',async()=>{more.open=false;if(running||starting)throw Error('请先关闭环境');if(confirm('删除「'+p.name+'」及其 Cookie、站点存储和缓存？此操作无法撤销。'))await window.isola.delete(p.id);},'danger-action');
  clear.disabled=remove.disabled=running||starting;clear.title=remove.title=running||starting?'请先关闭环境窗口。':'';
  menu.append(duplicate,test,clear,remove);more.append(summary,menu);more.addEventListener('toggle',()=>menuPosition(more,menu));actions.append(more);actionCell.append(actions);row.append(checkCell,idCell,detail,groupCell,device,proxyCell,opened,notesCell,actionCell);rows.append(row);
 }
 selection();
}
const osNames={native:'当前电脑',windows:'Windows',macos:'macOS',linux:'Linux',android:'Android 手机',ios:'iOS 兼容模拟'};
const osDefaults={native:{osVersion:'',architecture:'x86'},windows:{osVersion:'11',architecture:'x86'},macos:{osVersion:'14.0',architecture:'arm'},linux:{osVersion:'6.8.0',architecture:'x86'},android:{osVersion:'14',architecture:'arm'},ios:{osVersion:'17.0',architecture:'arm'}};
const osVersions={native:[],windows:['11','10'],macos:['15.0','14.0','13.0'],linux:['6.8.0','6.1.0'],android:['15','14','13'],ios:['18.0','17.0','16.0']};
const fingerprintFields=['deviceModel','operatingSystem','osVersion','architecture','width','height','screenWidth','screenHeight','deviceScaleFactor','maxTouchPoints','hardwareConcurrency','language','timezone','ua','webRTCPolicy','fingerprintMode'];
let previewSerial=0,previewTimer,deviceCatalog={};
function previewRow(label,value){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=String(value??'跟随系统');$('#fingerprint-preview').append(dt,dd);}
function renderFingerprintPreview(result,error){
 const mode=form.elements.fingerprintMode.value,os=form.elements.operatingSystem.value,summary=result?.summary||{};
 $('#fingerprint-device-title').textContent=mode==='native'?'当前电脑 · 原生':osNames[os]||os;
 $('#fingerprint-preview').replaceChildren();
 if(runtimeInfo.chromium)previewRow('实际内核','Chromium '+runtimeInfo.chromium);
 if(runtimeInfo.platform)previewRow('宿主',({darwin:'macOS',win32:'Windows',linux:'Linux'}[runtimeInfo.platform]||runtimeInfo.platform)+(runtimeInfo.arch?' / '+runtimeInfo.arch:''));
 previewRow('系统',mode==='native'?'跟随当前电脑':(osNames[os]||os)+' '+form.elements.osVersion.value);
 if(mode!=='native'&&form.elements.deviceModel.value)previewRow('型号',form.elements.deviceModel.value);
 previewRow('视口',form.elements.width.value+' × '+form.elements.height.value);
 previewRow('屏幕',mode==='native'?'宿主真实屏幕':form.elements.screenWidth.value+' × '+form.elements.screenHeight.value+' / '+form.elements.deviceScaleFactor.value+'×');
 previewRow('触摸',mode==='native'?'宿主真实能力':form.elements.maxTouchPoints.value+' 点');
 previewRow('语言/时区',mode==='native'?'宿主真实设置':form.elements.language.value+' / '+form.elements.timezone.value);
 if(result?.userAgent)previewRow('User-Agent',result.userAgent);
 if(result?.userAgentOverride?.platform)previewRow('平台标识',result.userAgentOverride.platform);
 const limits=$('#fingerprint-limitations');limits.replaceChildren();for(const message of result?.summary?.limitations||['设备模拟仍使用当前电脑的 Chromium、GPU、字体、Canvas 与音频能力。']){const p=document.createElement('p');p.textContent=message;limits.append(p);}
 const warnings=$('#fingerprint-warnings');warnings.replaceChildren();
 const messages=[...(result?.warnings||summary.warnings||[])];
 if(mode!=='native'&&['android','ios'].includes(os))messages.push(os==='ios'?'iOS 选项是 Chromium 浏览兼容模拟，不是 iOS WebKit。':'手机参数模拟仍使用当前电脑的 Chromium、GPU 与字体。');
 if(mode!=='native')messages.push('页面与 Worker 的可模拟范围可能不同，请启动后运行环境自检。');
 if(error){
  messages.push(error);
  // The main process owns OS/version/architecture validation. If dormant
  // settings are invalid, keep them editable so native mode is recoverable.
  if(mode==='native')for(const key of ['deviceModel','ua','language','timezone','hardwareConcurrency','screenWidth','screenHeight','deviceScaleFactor','maxTouchPoints','osVersion','architecture'])form.elements.namedItem(key).disabled=false;
 }
 for(const message of [...new Set(messages.map(value=>typeof value==='string'?value:value?.message||value?.detail||''))].filter(Boolean)){const p=document.createElement('p');p.textContent=message;warnings.append(p);}
 $('#fingerprint-preview-status').textContent=error?'配置需要调整':mode==='native'?'使用本机真实设备参数':result?'配置已校验 · 启动后查看实测结果':'浏览器按目标系统生成默认 UA';
}
function scheduleFingerprintPreview(){
 clearTimeout(previewTimer);const serial=++previewSerial;renderFingerprintPreview();
 previewTimer=setTimeout(async()=>{if(!dialog.open||typeof window.isola.fingerprintPreview!=='function')return;try{const result=await window.isola.fingerprintPreview(input());if(serial===previewSerial&&dialog.open)renderFingerprintPreview(result);}catch(error){if(serial===previewSerial&&dialog.open)renderFingerprintPreview(null,error.message.replace(/^Error invoking remote method '[^']+': Error: /,''));}},180);
}
function updateVersionList(){const os=form.elements.operatingSystem.value;$('#os-versions').replaceChildren(...(osVersions[os]||[]).map(value=>new Option(value,value)));form.elements.osVersion.placeholder=os==='native'?'跟随当前电脑':'例如 '+(osDefaults[os]?.osVersion||'14');}
function modeChanged(){
 const native=form.elements.fingerprintMode.value==='native';
 for(const key of ['deviceModel','ua','language','timezone','hardwareConcurrency','screenWidth','screenHeight','deviceScaleFactor','maxTouchPoints']){const field=form.elements.namedItem(key);field.disabled=false;const valid=field.checkValidity()&&(key!=='deviceModel'||!/[;()\x00-\x1f\x7f]/.test(field.value));field.disabled=native&&valid;}
 const version=form.elements.osVersion.value,versionOK=/^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(version)||!version;form.elements.osVersion.disabled=(native||form.elements.operatingSystem.value==='native')&&versionOK;form.elements.architecture.disabled=native||form.elements.operatingSystem.value==='native';
 $('#mode-hint').textContent=native?'使用当前电脑的真实系统、语言、时区、CPU、屏幕与 GPU；视口尺寸用于初始窗口大小。':'按所选设备模拟可配置参数。GPU、字体、音频与内核仍由宿主提供；查看右侧生效范围和环境自检。';
 updateVersionList();scheduleFingerprintPreview();
}
function applyDevicePreset(value){
 if(value==='keep')return;
 if(deviceCatalog[value]){const preset=deviceCatalog[value];form.elements.fingerprintMode.value=preset.operatingSystem==='native'?'native':'custom';for(const key of fingerprintFields)if(preset[key]!==undefined)form.elements.namedItem(key).value=preset[key];form.elements.ua.value='';modeChanged();return;}
 form.elements.deviceModel.value='';
 const os=value==='android-wide'?'android':value,desktop=!['android','ios'].includes(os),sizes={native:[1280,800,1],windows:[1920,1080,1],macos:[1440,900,2],linux:[1366,768,1],android:[390,844,3],'android-wide':[412,915,2.625],ios:[390,844,3]},size=sizes[value];
 form.elements.fingerprintMode.value=os==='native'?'native':'custom';form.elements.operatingSystem.value=os;
 const defaults=osDefaults[os];for(const [key,value] of Object.entries(defaults))form.elements.namedItem(key).value=value;
 for(const [key,value] of Object.entries({width:size[0],height:size[1],screenWidth:size[0],screenHeight:size[1],deviceScaleFactor:size[2],maxTouchPoints:desktop?0:5,hardwareConcurrency:desktop?0:os==='ios'?6:8,ua:''}))form.elements.namedItem(key).value=value;
 modeChanged();
}
form.elements.fingerprintMode.onchange=()=>{$('#device-preset').value='keep';modeChanged();};
form.elements.operatingSystem.onchange=()=>{
 const os=form.elements.operatingSystem.value;$('#device-preset').value='keep';if(os!=='native')form.elements.fingerprintMode.value='custom';
 for(const [key,value] of Object.entries(osDefaults[os]||{}))form.elements.namedItem(key).value=value;
 if(['android','ios'].includes(os))applyDevicePreset(os);else{form.elements.deviceModel.value='';for(const [key,value] of Object.entries({width:1280,height:800,screenWidth:1280,screenHeight:800,deviceScaleFactor:1,maxTouchPoints:0,hardwareConcurrency:0,ua:''}))form.elements.namedItem(key).value=value;modeChanged();}
};
$('#device-preset').onchange=e=>applyDevicePreset(e.target.value);
for(const key of fingerprintFields.filter(key=>!['fingerprintMode','operatingSystem'].includes(key)))form.elements.namedItem(key).addEventListener('input',()=>{$('#device-preset').value='keep';scheduleFingerprintPreview();});
function edit(p) {
 form.reset();form.elements.id.value='';for(const [k,v] of Object.entries(p||{}))if(k!=='proxy'&&form.elements.namedItem(k)){const field=form.elements.namedItem(k);if(field.tagName==='SELECT'&&![...field.options].some(option=>option.value===String(v)))field.add(new Option(String(v),String(v)));field.value=v;}
 form.elements.windowType.value=p?profileWindowType(p):currentWindowType;
 for(const [k,v] of Object.entries(p?.proxy||{}))if(k!=='password'&&form.elements.namedItem(k))form.elements.namedItem(k).value=k==='port'&&!v?'':v;
 if(p&&!p.fingerprintMode)form.elements.fingerprintMode.value='custom';if(p&&!p.screenWidth)form.elements.screenWidth.value=p.width;if(p&&!p.screenHeight)form.elements.screenHeight.value=p.height;
 form.elements.password.placeholder=p?.proxy.hasPassword?'已保存，留空保持不变':'未设置';$('#heading').textContent=p?'编辑环境':'新建环境';$('#test-result').textContent='';$('#device-preset').value='keep';modeChanged();dialog.showModal();scheduleFingerprintPreview();
}
function input(){const d=Object.fromEntries(new FormData(form));for(const key of fingerprintFields)d[key]=form.elements.namedItem(key).value;return {...d,clearPassword:form.elements.clearPassword.checked,proxy:{type:d.type,host:d.host,port:d.port,username:d.username,password:d.password}};}
function selectWindowType(type){if(!['normal','automation'].includes(type))return;currentWindowType=type;selected.clear();render();}
for(const type of ['normal','automation']){const tab=$('#window-type-'+type);tab.onclick=()=>selectWindowType(type);tab.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?'normal':e.key==='End'?'automation':type==='normal'?'automation':'normal';selectWindowType(next);$('#window-type-'+next).focus();};}
$('#new').onclick = () => edit(); $('#cancel').onclick = () => dialog.close(); $('#search').oninput = render; $('#group-filter').onchange = render; $('#status-filter').onchange = render;
$('#select-all').onchange = e => { for (const p of matches()) e.target.checked ? selected.add(p.id) : selected.delete(p.id); render(); };
form.onsubmit = e => { e.preventDefault(); run(async () => { const submit = form.querySelector('[type=submit]'); submit.disabled = true; try { const value=input();await window.isola.save(value);selectWindowType(value.windowType);dialog.close();toast('环境已保存'); } finally { submit.disabled = false; } }); };
$('#test').onclick = () => run(async () => { $('#test').disabled = true; $('#test-result').textContent = '检测中…'; try { const r = await window.isola.test(input()); $('#test-result').textContent = `出口 IP：${r.ip} · ${r.ms} ms`; } catch (e) { $('#test-result').textContent = '检测失败：' + e.message; } finally { $('#test').disabled = false; } });
for (const [id, action] of [['batch-launch', 'launch'], ['batch-stop', 'stop']]) $("#" + id).onclick = () => run(async () => { const ids=matches().filter(p=>selected.has(p.id)).map(p=>p.id);if (!ids.length) throw Error('请先选择当前列表中的环境'); $("#" + id).disabled = true; try { const failures = await window.isola.batch(ids, action); toast(failures.length ? failures.map(f => f.name + '：' + f.error).join('；') : '批量操作完成'); } finally { $("#" + id).disabled = false; } });
$('#export').onclick = () => run(async () => { const n = await window.isola.export([...selected]); if (n !== undefined) toast(`已导出 ${n} 个环境配置，不包含凭据和浏览数据`); });
$('#import').onclick = () => run(async () => { const n = await window.isola.import(); if (n !== undefined) toast(`已导入 ${n} 个环境，请重新填写代理凭据`); });
window.isola.onChange(p => { profiles = p; render(); });
async function loadDeviceCatalog(){if(typeof window.isola.fingerprintCatalog!=='function')return;const catalog=await window.isola.fingerprintCatalog();deviceCatalog=catalog.devices||{};const group=document.createElement('optgroup');group.label='手机型号预设';for(const key of ['pixel7','galaxy-s23','iphone13','iphone14pro']){const preset=deviceCatalog[key];if(preset)group.append(new Option(preset.label,key));}$('#device-preset').append(group);}
run(async () => { profiles = await window.isola.list(); render(); const info = await window.isola.info();runtimeInfo=info;$('#runtime-engine').textContent='Chromium '+info.chromium;render();if(dialog.open)scheduleFingerprintPreview(); await loadDeviceCatalog(); $('#app-version').textContent = `v${info.version} / ${{darwin:'macOS',win32:'Windows',linux:'Linux'}[info.platform]||info.platform}`; $('#app-info').textContent = `Isola ${info.version} · Chromium ${info.chromium} · ${info.platform} · 本地数据：${info.dataPath}`; });
