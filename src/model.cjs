const { randomUUID } = require('node:crypto');
const net = require('node:net');
const { normalizeFingerprintSettings } = require('./fingerprint-config.cjs');
function validate(input = {}) {
  const p = {
    id: input.id || randomUUID(), name: String(input.name ?? '新环境').trim().slice(0, 80),
    group: String(input.group || '').trim().slice(0, 40), notes: String(input.notes || '').slice(0, 1000),
    url: String(input.url || 'https://example.com'), ua: String(input.ua || '').trim(),
    ...normalizeFingerprintSettings(input),
    language: input.language || 'zh-CN', timezone: input.timezone || 'Asia/Shanghai',
    createdAt: input.createdAt || new Date().toISOString(),
    proxy: {
      type: input.proxy?.type || 'direct', host: String(input.proxy?.host || '').trim().toLowerCase(),
      port: Number(input.proxy?.port || 0), username: String(input.proxy?.username || ''),
      password: String(input.proxy?.password || '')
    }
  };
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(p.id)) throw Error('环境标识无效');
  if (!p.name) throw Error('请输入环境名称');
  p.url = normalizeURL(p.url);
  if (String(input.ua ?? '').length > 1024 || /[\x00-\x1f\x7f]/.test(String(input.ua ?? ''))) throw Error('User-Agent 无效');
  if (!/^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(p.language)) throw Error('语言代码无效');
  try { new Intl.DateTimeFormat('en', { timeZone: p.timezone }); } catch { throw Error('时区名称无效'); }
  if (!['direct', 'http', 'socks5'].includes(p.proxy.type)) throw Error('代理类型无效');
  if (p.proxy.type !== 'direct') {
    if (!p.proxy.host || (!net.isIP(p.proxy.host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(p.proxy.host))) throw Error('代理主机无效');
    if (!Number.isInteger(p.proxy.port) || p.proxy.port < 1 || p.proxy.port > 65535) throw Error('代理端口无效');
    if (Buffer.byteLength(p.proxy.username) > 255 || Buffer.byteLength(p.proxy.password) > 255) throw Error('代理凭据过长');
    if (p.proxy.password && !p.proxy.username) throw Error('使用代理密码时请填写用户名');
  }
  return p;
}
function normalizeURL(value) {
  let s = String(value).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw Error('网址必须使用 HTTP/HTTPS，不能包含登录凭据');
  return u.href;
}
function proxyConfig(p) {
  const host = net.isIP(p.host) === 6 ? `[${p.host}]` : p.host;
  return p.type === 'direct' ? { mode: 'direct' } : { mode: 'fixed_servers', proxyRules: `${p.type}://${host}:${p.port}`, proxyBypassRules: '<-loopback>' };
}
function publicProfile(p, status = 'closed') { const { password, ...proxy } = p.proxy; return { ...p, proxy: { ...proxy, hasPassword: !!password }, status, running: status === 'running' || status === 'starting' }; }
function exportProfiles(rows) { return { format: 'isola-profiles', version: 1, exportedAt: new Date().toISOString(), profiles: rows.map(p => { const { password, username, ...proxy } = p.proxy; return { ...p, proxy }; }) }; }
function importProfiles(data) {
  if (data?.format !== 'isola-profiles' || data.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 500) throw Error('配置格式无效，最多可导入 500 个环境');
  return data.profiles.map(p => validate({ ...p, id: randomUUID(), name: `${p.name || '环境'}（导入）`, createdAt: new Date().toISOString(), proxy: { ...p.proxy, username: '', password: '' } }));
}
module.exports = { validate, normalizeURL, proxyConfig, publicProfile, exportProfiles, importProfiles };
