const input = document.querySelector('#url'), status = document.querySelector('#status');
async function action(a, v) { try { await window.browser.navigate(a, v); } catch (e) { status.textContent = e.message; status.className = 'error'; } }
document.querySelector('form').onsubmit = e => { e.preventDefault(); input.blur(); action('go', input.value); };
for (const a of ['back', 'forward', 'reload', 'check']) document.getElementById(a).onclick = () => action(a);
window.browser.onState(state => {
  document.title = (state.windowType==='automation'?'自动化窗口':'正常窗口') + ' · ' + state.profileName + ' · Isola';
  const tabs = document.querySelector('#tabs'); tabs.replaceChildren();
  for (const t of state.tabs) {
    const tab = document.createElement('div'); tab.className = 'tab' + (t.id === state.active ? ' active' : ''); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(t.id === state.active)); tab.tabIndex = 0;
    const label = document.createElement('span'); label.textContent = (t.loading ? '◌ ' : '') + t.title;
    const close = document.createElement('button'); close.textContent = '×'; close.title = '关闭标签'; close.onclick = e => { e.stopPropagation(); action('close', t.id); };
    tab.onclick = () => action('switch', t.id); tab.onkeydown = e => { if (e.key === 'Enter') action('switch', t.id); }; tab.append(label, close); tabs.append(tab);
  }
  const add = document.createElement('button'); add.textContent = '＋'; add.title = '新建标签'; add.onclick = () => action('new'); tabs.append(add);
  const current = state.tabs.find(t => t.id === state.active);
  if (document.activeElement !== input) input.value = current?.url?.startsWith('file:') ? '' : current?.url || '';
  status.className = current?.error&&!current?.notice ? 'error' : ''; status.textContent = current?.notice || (current?.error ? '页面加载失败：' + current.error + ' · 可修改网址或点击刷新重试' : `${state.profileName} · ${state.proxy === 'direct' ? '直连' : state.proxy.toUpperCase() + ' 代理'} · ${state.fingerprintMode==='native'?'本机原生':state.width+' × '+state.height+' 固定视口 · 窗口等比显示'} · Cookie 与站点存储独立`);
});
window.browser.refresh();
