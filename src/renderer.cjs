const $ = s => document.querySelector(s), form = $('#form'), dialog = $('#editor');
$('#commerce-open').onclick=()=>run(()=>window.isola.openCommerce());
let profiles = [], selected = new Set();
function toast(t) { $('#toast').textContent = t; $('#toast').style.display = 'block'; clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => $('#toast').style.display = 'none', 6500); }
async function run(fn) { try { await fn(); } catch (e) { toast(e.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); } }
function button(text, fn, cls) { const b = document.createElement('button'); b.textContent = text; if (cls) b.className = cls; b.onclick = () => run(async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } }); return b; }
function matches() { return profiles.filter(p => `${p.name} ${p.group} ${p.notes}`.toLowerCase().includes($('#search').value.toLowerCase()) && (!$('#group-filter').value || p.group === $('#group-filter').value) && (!$('#status-filter').value || p.status === $('#status-filter').value)); }
function selection() { $('#selection').textContent = `已选 ${selected.size} 个`; const visible = matches(); $('#select-all').checked = !!visible.length && visible.every(p => selected.has(p.id)); $('#select-all').indeterminate = !$('#select-all').checked && visible.some(p => selected.has(p.id)); }
function render() {
  selected = new Set([...selected].filter(id => profiles.some(p => p.id === id)));
  const rows = $('#rows'); rows.replaceChildren(); $('#total').textContent = profiles.length; $('#running').textContent = profiles.filter(p => p.running).length; $('#proxied').textContent = profiles.filter(p => p.proxy.type !== 'direct').length;
  const group = $('#group-filter'), prev = group.value; group.replaceChildren(new Option('全部分组', '')); for (const g of [...new Set(profiles.map(p => p.group).filter(Boolean))].sort()) group.add(new Option(g, g)); group.value = prev;
  const match = matches();
  if (!match.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = profiles.length ? '没有找到匹配环境。试试调整搜索或筛选条件。' : '还没有环境。点击「新建环境」，开始你的第一个独立工作空间。'; rows.append(e); }
  for (const p of match) {
    const row = document.createElement('div'); row.className = 'row' + (selected.has(p.id) ? ' selected' : '');
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = selected.has(p.id); box.setAttribute('aria-label', '选择 ' + p.name); box.onchange = () => { box.checked ? selected.add(p.id) : selected.delete(p.id); row.classList.toggle('selected', box.checked); selection(); };
    const icon = document.createElement('div'); icon.className = 'avatar'; icon.textContent = p.name[0];
    const detail = document.createElement('div'); detail.className = 'details'; const name = document.createElement('b'); name.textContent = p.name;
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${p.group ? p.group + ' · ' : ''}${p.fingerprintMode==='native'?'本机原生':(osNames[p.operatingSystem]||'当前电脑')+(p.deviceModel?' / '+p.deviceModel:'')+' · '+p.language+' · '+p.timezone} · ${p.width} × ${p.height} · ${p.proxy.type === 'direct' ? '直连' : p.proxy.type.toUpperCase() + ' / ' + p.proxy.host + ':' + p.proxy.port}`;
    detail.append(name, meta); if (p.notes) { const notes = document.createElement('div'); notes.className = 'notes'; notes.textContent = p.notes; detail.append(notes); }
    const badge = document.createElement('span'); badge.className = 'badge' + (p.running ? ' live' : ''); badge.textContent = p.status === 'starting' ? '◌ 启动中' : p.running ? '● 运行中' : '已关闭';
    const actions = document.createElement('div'); actions.className = 'actions';
    const start = button(p.running ? '关闭' : '启动', () => p.running ? window.isola.stop(p.id) : window.isola.launch(p.id), p.running ? '' : 'primary'); start.disabled = p.status === 'starting';
    actions.append(start, button('编辑', () => { if (p.running) throw Error('请先关闭环境'); edit(p); }));
    const more = document.createElement('details'); more.className = 'more'; const summary = document.createElement('summary'); summary.textContent = '•••'; summary.setAttribute('aria-label', p.name + ' 更多操作'); const menu = document.createElement('div');
    menu.append(button('复制配置', async () => { more.open = false; await window.isola.duplicate(p.id); toast('已复制配置，浏览数据不会复制'); }), button('检测代理', async () => { more.open = false; toast('正在检测出口 IP…'); const r = await window.isola.test(p); toast(`${p.name} · ${r.ip} · ${r.ms} ms`); }), button('清理浏览数据', async () => { more.open = false; if (confirm(`清理「${p.name}」的 Cookie、站点存储和缓存？此操作无法撤销，环境配置会保留。`)) { await window.isola.clear(p.id); toast('浏览数据已清理'); } }), button('删除环境', async () => { more.open = false; if (confirm(`删除「${p.name}」及其 Cookie、站点存储和缓存？此操作无法撤销。`)) await window.isola.delete(p.id); }));
    more.append(summary, menu); actions.append(more); row.append(box, icon, detail, badge, actions); rows.append(row);
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
 for(const [k,v] of Object.entries(p?.proxy||{}))if(k!=='password'&&form.elements.namedItem(k))form.elements.namedItem(k).value=k==='port'&&!v?'':v;
 if(p&&!p.fingerprintMode)form.elements.fingerprintMode.value='custom';if(p&&!p.screenWidth)form.elements.screenWidth.value=p.width;if(p&&!p.screenHeight)form.elements.screenHeight.value=p.height;
 form.elements.password.placeholder=p?.proxy.hasPassword?'已保存，留空保持不变':'未设置';$('#heading').textContent=p?'编辑环境':'新建环境';$('#test-result').textContent='';$('#device-preset').value='keep';modeChanged();dialog.showModal();scheduleFingerprintPreview();
}
function input(){const d=Object.fromEntries(new FormData(form));for(const key of fingerprintFields)d[key]=form.elements.namedItem(key).value;return {...d,clearPassword:form.elements.clearPassword.checked,proxy:{type:d.type,host:d.host,port:d.port,username:d.username,password:d.password}};}
$('#new').onclick = () => edit(); $('#cancel').onclick = () => dialog.close(); $('#search').oninput = render; $('#group-filter').onchange = render; $('#status-filter').onchange = render;
$('#select-all').onchange = e => { for (const p of matches()) e.target.checked ? selected.add(p.id) : selected.delete(p.id); render(); };
form.onsubmit = e => { e.preventDefault(); run(async () => { const submit = form.querySelector('[type=submit]'); submit.disabled = true; try { await window.isola.save(input()); dialog.close(); toast('环境已保存'); } finally { submit.disabled = false; } }); };
$('#test').onclick = () => run(async () => { $('#test').disabled = true; $('#test-result').textContent = '检测中…'; try { const r = await window.isola.test(input()); $('#test-result').textContent = `出口 IP：${r.ip} · ${r.ms} ms`; } catch (e) { $('#test-result').textContent = '检测失败：' + e.message; } finally { $('#test').disabled = false; } });
for (const [id, action] of [['batch-launch', 'launch'], ['batch-stop', 'stop']]) $("#" + id).onclick = () => run(async () => { if (!selected.size) throw Error('请先选择环境'); $("#" + id).disabled = true; try { const failures = await window.isola.batch([...selected], action); toast(failures.length ? failures.map(f => f.name + '：' + f.error).join('；') : '批量操作完成'); } finally { $("#" + id).disabled = false; } });
$('#export').onclick = () => run(async () => { const n = await window.isola.export([...selected]); if (n !== undefined) toast(`已导出 ${n} 个环境配置，不包含凭据和浏览数据`); });
$('#import').onclick = () => run(async () => { const n = await window.isola.import(); if (n !== undefined) toast(`已导入 ${n} 个环境，请重新填写代理凭据`); });
window.isola.onChange(p => { profiles = p; render(); });
async function loadDeviceCatalog(){if(typeof window.isola.fingerprintCatalog!=='function')return;const catalog=await window.isola.fingerprintCatalog();deviceCatalog=catalog.devices||{};const group=document.createElement('optgroup');group.label='手机型号预设';for(const key of ['pixel7','galaxy-s23','iphone13','iphone14pro']){const preset=deviceCatalog[key];if(preset)group.append(new Option(preset.label,key));}$('#device-preset').append(group);}
run(async () => { profiles = await window.isola.list(); render(); const info = await window.isola.info(); await loadDeviceCatalog(); $('#app-version').textContent = `v${info.version} / ${{darwin:'macOS',win32:'Windows',linux:'Linux'}[info.platform]||info.platform}`; $('#app-info').textContent = `Isola ${info.version} · Chromium ${info.chromium} · ${info.platform} · 本地数据：${info.dataPath}`; });
