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
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${p.group ? p.group + ' · ' : ''}${p.fingerprintMode==='native'?'本机原生':p.language+' · '+p.timezone} · ${p.width} × ${p.height} · ${p.proxy.type === 'direct' ? '直连' : p.proxy.type.toUpperCase() + ' / ' + p.proxy.host + ':' + p.proxy.port}`;
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
function modeChanged(){const native=form.elements.fingerprintMode.value==='native';for(const key of ['ua','language','timezone','hardwareConcurrency'])form.elements.namedItem(key).disabled=native;$('#mode-hint').textContent=native?'使用当前 Mac 的真实语言、时区、CPU、屏幕与 GPU。下方宽高仅设置初始窗口大小；Cookie 与代理仍按环境隔离。':'自定义参数作用于页面，Worker 或 iframe 可能仍显示本机值；请用指纹自检检查一致性。';}
form.elements.fingerprintMode.onchange=modeChanged;
function edit(p) {
  form.reset(); for (const [k, v] of Object.entries(p || {})) if (k !== 'proxy' && form.elements.namedItem(k)) form.elements.namedItem(k).value = v;
  for (const [k, v] of Object.entries(p?.proxy || {})) if (k !== 'password' && form.elements.namedItem(k)) form.elements.namedItem(k).value = k === 'port' && !v ? '' : v;
  form.elements.password.placeholder = p?.proxy.hasPassword ? '已保存，留空保持不变' : '未设置'; $('#heading').textContent = p ? '编辑环境' : '新建环境'; $('#test-result').textContent = ''; if(p&&!p.fingerprintMode)form.elements.fingerprintMode.value='custom';modeChanged();dialog.showModal();
}
function input() { const d = Object.fromEntries(new FormData(form)); return { ...d, clearPassword: form.elements.clearPassword.checked, proxy: { type: d.type, host: d.host, port: d.port, username: d.username, password: d.password } }; }
$('#new').onclick = () => edit(); $('#cancel').onclick = () => dialog.close(); $('#search').oninput = render; $('#group-filter').onchange = render; $('#status-filter').onchange = render;
$('#select-all').onchange = e => { for (const p of matches()) e.target.checked ? selected.add(p.id) : selected.delete(p.id); render(); };
form.onsubmit = e => { e.preventDefault(); run(async () => { const submit = form.querySelector('[type=submit]'); submit.disabled = true; try { await window.isola.save(input()); dialog.close(); toast('环境已保存'); } finally { submit.disabled = false; } }); };
$('#test').onclick = () => run(async () => { $('#test').disabled = true; $('#test-result').textContent = '检测中…'; try { const r = await window.isola.test(input()); $('#test-result').textContent = `出口 IP：${r.ip} · ${r.ms} ms`; } catch (e) { $('#test-result').textContent = '检测失败：' + e.message; } finally { $('#test').disabled = false; } });
for (const [id, action] of [['batch-launch', 'launch'], ['batch-stop', 'stop']]) $("#" + id).onclick = () => run(async () => { if (!selected.size) throw Error('请先选择环境'); $("#" + id).disabled = true; try { const failures = await window.isola.batch([...selected], action); toast(failures.length ? failures.map(f => f.name + '：' + f.error).join('；') : '批量操作完成'); } finally { $("#" + id).disabled = false; } });
$('#export').onclick = () => run(async () => { const n = await window.isola.export([...selected]); if (n !== undefined) toast(`已导出 ${n} 个环境配置，不包含凭据和浏览数据`); });
$('#import').onclick = () => run(async () => { const n = await window.isola.import(); if (n !== undefined) toast(`已导入 ${n} 个环境，请重新填写代理凭据`); });
window.isola.onChange(p => { profiles = p; render(); });
run(async () => { profiles = await window.isola.list(); render(); const info = await window.isola.info(); $('#app-version').textContent = `v${info.version} / macOS`; $('#app-info').textContent = `Isola ${info.version} · Chromium ${info.chromium} · ${info.platform} · 本地数据：${info.dataPath}`; });
