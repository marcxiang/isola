const { randomUUID } = require('node:crypto');
const net = require('node:net');
const { normalizeFingerprintSettings } = require('./fingerprint-config.cjs');
function checkedTime(value,label) {
  if (typeof value !== 'string') throw Error(label+'无效');
  let canonical;try { canonical=new Date(value).toISOString(); } catch { throw Error(label+'无效'); }
  if (canonical!==value) throw Error(label+'必须为标准 ISO 时间');
  return value;
}
function runtimeMetadata(input) {
  const lastOpenedAt=input.lastOpenedAt==null?null:checkedTime(input.lastOpenedAt,'最近打开时间');
  const value=input.proxyCheck;
  if (value==null) return {lastOpenedAt,proxyCheck:null};
  if (typeof value!=='object'||Array.isArray(value)||typeof value.ip!=='string'||!net.isIP(value.ip)||typeof value.ms!=='number'||!Number.isFinite(value.ms)||value.ms<0||value.ms>120000) throw Error('代理检测记录无效');
  return {lastOpenedAt,proxyCheck:{ip:value.ip,ms:value.ms,checkedAt:checkedTime(value.checkedAt,'代理检测时间')}};
}
function validate(input = {}) {
  if (input.id !== undefined && input.id !== '' && typeof input.id !== 'string') throw Error('环境标识必须是字符串');
  const p = {
    id: input.id || randomUUID(), name: String(input.name ?? '新环境').trim().slice(0, 80),
    windowType: input.windowType === undefined ? 'normal' : input.windowType,
    group: String(input.group || '').trim().slice(0, 40), notes: String(input.notes || '').slice(0, 1000),
    url: String(input.url || 'https://example.com'), ua: String(input.ua || '').trim(),
    ...normalizeFingerprintSettings(input),
    ...runtimeMetadata(input),
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
  if (!['normal', 'automation'].includes(p.windowType)) throw Error('窗口用途无效');
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
function validateProfileIdentities(rows) {
  if (!Array.isArray(rows)) throw Error('环境列表无效');
  const identities = new Set();
  for (const row of rows) {
    if (!row || typeof row!=='object' || Array.isArray(row) || typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(row.id)) throw Error('环境标识无效，原数据已保留');
    // Electron lowercases persistent partition directory names. Preserve the
    // stored ID, but never let two logical profiles address the same directory.
    const key = row.id.toLowerCase();
    if (identities.has(key)) throw Error('环境标识重复或仅大小写不同，不能共享浏览器数据目录；原数据已保留');
    identities.add(key);
  }
  return rows;
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
function exportProfiles(rows) { return { format: 'isola-profiles', version: 1, exportedAt: new Date().toISOString(), profiles: rows.map(p => { const { password, username, ...proxy } = p.proxy; const {lastOpenedAt,proxyCheck,...config}=p;return { ...config, proxy }; }) }; }
function importProfiles(data) {
  if (data?.format !== 'isola-profiles' || data.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 500) throw Error('配置格式无效，最多可导入 500 个环境');
  return data.profiles.map(p => validate({ ...p, id: randomUUID(), name: `${p.name || '环境'}（导入）`, createdAt: new Date().toISOString(), lastOpenedAt:null,proxyCheck:null,proxy: { ...p.proxy, username: '', password: '' } }));
}
module.exports = { validate, validateProfileIdentities, normalizeURL, proxyConfig, publicProfile, exportProfiles, importProfiles };
