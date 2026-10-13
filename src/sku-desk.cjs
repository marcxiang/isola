'use strict';

const { createHash } = require('node:crypto');

const API_VERSION = '1.8.0';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 11 * 1024 * 1024;
const MAX_LABEL_BYTES = 10 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const STATUS_MESSAGES = {
  400: 'SKU Desk 请求参数或确认信息不完整', 401: 'SKU Desk 密钥无效或已失效',
  403: 'SKU Desk 账号或密钥权限不足', 404: 'SKU Desk 记录不存在或不可访问',
  409: 'SKU Desk 库存、版本、照片或原请求内容发生冲突', 413: 'SKU Desk 请求内容过大',
  429: 'SKU Desk 请求过快，请等待后再检查', 503: 'SKU Desk 暂不可用，请核对原请求结果',
};

class SKUDeskError extends Error {
  constructor(code, message, { status = 0, ambiguous = false, retryAfter = null, requestId = '' } = {}) {
    super(message);
    this.name = 'SKUDeskError';
    this.code = code;
    this.status = status;
    this.ambiguous = ambiguous;
    this.retryAfter = retryAfter; // Seconds, following HTTP Retry-After.
    this.requestId = requestId;
  }
}

function invalid(message) { throw new SKUDeskError('INVALID_ARGUMENT', message); }
function text(value, name, { optional = false, max = 2048 } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid(`${name} 无效`);
  return value;
}
function object(value, name, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${name} 必须是对象`);
  if (keys && Object.keys(value).some(key => !keys.includes(key))) invalid(`${name} 包含 API 1.8 不支持的字段`);
  return value;
}
function id(value) {
  const result = text(value, '记录编号', { max: 256 });
  if (result === '.' || result === '..' || /[\\/]/.test(result)) invalid('记录编号无效');
  return encodeURIComponent(result);
}
function idempotencyKey(value, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) invalid('必须提供 1–128 字符的固定 Idempotency-Key');
  return value;
}
function normalizeBaseURL(value) {
  let url;
  try { url = new URL(text(value, 'SKU Desk 地址')); } catch { invalid('SKU Desk 地址无效'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) invalid('SKU Desk 必须使用 HTTPS；本机测试地址可使用 HTTP');
  if (url.username || url.password || url.search || url.hash) invalid('SKU Desk 地址不能包含账号、密码、查询参数或片段');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/api/v1') ? path : `${path}/api/v1`;
  return url.href.replace(/\/+$/, '');
}
function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJSON(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function items(value) {
  if (!Array.isArray(value) || !value.length || value.length > 50) invalid('订单必须包含 1–50 行商品');
  const seen = new Set();
  return value.map(item => {
    object(item, '商品行', ['productId', 'quantity', 'productRevision']);
    const productId = text(item.productId, '商品编号', { max: 256 });
    if (seen.has(productId)) invalid('相同商品请合并数量后提交');
    seen.add(productId);
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) invalid('商品数量必须是正整数');
    if (item.productRevision !== undefined && (!Number.isSafeInteger(item.productRevision) || item.productRevision < 0)) invalid('商品版本无效');
    return cleanObject({ productId, quantity: item.quantity, productRevision: item.productRevision });
  });
}
function queryString(query, allowed) {
  if (query === undefined) return '';
  object(query, '查询条件', allowed);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'page' || key === 'pageSize') {
      if (!Number.isSafeInteger(value) || value < 1 || value > (key === 'page' ? 100000 : 100)) invalid(`${key} 超出分页范围`);
    } else if (key === 'mine') {
      if (![0, 1, '0', '1'].includes(value)) invalid('mine 仅支持 0 或 1');
    } else text(value, key, { max: 512 });
    params.set(key, String(value));
  }
  return params.size ? `?${params}` : '';
}
function retryAfter(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}
function multipart(payload, file) {
  object(file, '面单', ['data', 'contentType']);
  if (!Buffer.isBuffer(file.data) && !(file.data instanceof Uint8Array)) invalid('面单必须提供二进制数据');
  const data = Buffer.from(file.data);
  if (!data.length || data.length > MAX_LABEL_BYTES) invalid('面单须大于 0 且不超过 10 MiB');
  const extensions = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
  const extension = extensions[file.contentType];
  if (!extension) invalid('面单仅支持 PDF、JPG 或 PNG');
  const matches = extension === 'pdf' ? data.subarray(0, 5).toString() === '%PDF-' : extension === 'png' ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (!matches) invalid('面单内容与文件类型不符');
  const boundary = `isola-${createHash('sha256').update(stableJSON(payload)).update(data).digest('hex')}`;
  const parts = [];
  for (const key of Object.keys(payload).sort()) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${typeof value === 'object' ? stableJSON(value) : value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="label.${extension}"\r\nContent-Type: ${file.contentType}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

class SKUDeskClient {
  #token;
  #fetch;
  #requestGate;
  constructor({ baseURL, token, fetchImpl = globalThis.fetch, timeoutMs = 20000, requestGate }) {
    this.baseURL = normalizeBaseURL(baseURL);
    this.#token = text(token, 'SKU Desk 密钥', { max: 4096 });
    if (/[^\x21-\x7e]/.test(this.#token)) invalid('SKU Desk 密钥格式无效');
    if (typeof fetchImpl !== 'function') invalid('fetchImpl 无效');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) invalid('请求超时须在 1–120000 毫秒之间');
    if (requestGate !== undefined && typeof requestGate?.run !== 'function') invalid('请求调度器无效');
    this.#fetch = fetchImpl;
    this.#requestGate = requestGate;
    this.timeoutMs = timeoutMs;
  }

  #url(path) {
    if (typeof path !== 'string' || !path || /[\\\x00-\x20\x7f]/.test(path) || path.startsWith('//')) invalid('仅允许 SKU Desk API 地址');
    const rawPath = path.split(/[?#]/, 1)[0];
    if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath) || /%(?:2e|2f|5c|25)/i.test(rawPath)) invalid('API 路径编码无效');
    let result;
    try {
      const base = new URL(this.baseURL);
      if (/^https?:\/\//i.test(path)) result = new URL(path);
      else if (path.startsWith(`${base.pathname}/`) || path === base.pathname) result = new URL(path, base.origin);
      else result = new URL(`${this.baseURL}/${path.replace(/^\//, '')}`);
      if (result.origin !== base.origin || !result.pathname.startsWith(`${base.pathname}/`) || result.username || result.password || result.hash) invalid('拒绝向其他地址发送 SKU Desk 密钥');
      // Encoded separators/dot segments can be decoded differently by a proxy.
      if (/%(?:2e|2f|5c|25)/i.test(result.pathname)) invalid('API 路径编码无效');
    } catch (error) {
      if (error instanceof SKUDeskError) throw error;
      invalid('API 地址无效');
    }
    return result.href;
  }

  async #request(method, path, options = {}) {
    if (!this.#requestGate) return this.#requestNow(method, path, options);
    // Do not occupy the shared queue with invalid destinations.
    this.#url(path);
    try {
      return await this.#requestGate.run(signal => this.#requestNow(method, path, { ...options, signal }), options.signal);
    } catch (error) {
      if (error instanceof SKUDeskError) throw error;
      if (error?.code === 'ABORTED') throw new SKUDeskError('ABORTED', 'SKU Desk 请求在发送前已取消');
      throw new SKUDeskError('QUEUE_ERROR', 'SKU Desk 请求调度失败，请检查队列状态');
    }
  }

  async #requestNow(method, path, { payload, key, signal, binary = false, maxBytes = MAX_JSON_BYTES, file } = {}) {
    const url = this.#url(path);
    const writing = method !== 'GET';
    if (signal?.aborted) throw new SKUDeskError('ABORTED', 'SKU Desk 请求已取消');
    const headers = { Authorization: `Bearer ${this.#token}`, Accept: binary ? '*/*' : 'application/json' };
    if (key !== undefined) headers['Idempotency-Key'] = idempotencyKey(key);
    let body;
    if (file !== undefined) {
      const encoded = multipart(payload, file);
      body = encoded.body; headers['Content-Type'] = encoded.contentType;
    } else if (payload !== undefined) {
      body = Buffer.from(stableJSON(payload)); headers['Content-Type'] = 'application/json';
    }
    if (body && body.byteLength > MAX_REQUEST_BYTES) invalid('SKU Desk 请求体不能超过 11 MiB');
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let response;
    try {
      // The scheduler owns retries and the original persisted request ID/payload.
      // In particular, a failed write must never become a newly numbered request.
      response = await this.#fetch(url, { method, headers, body, signal: controller.signal, redirect: 'error' });
      if (response.redirected || (response.url && new URL(response.url).href !== url) || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel?.().catch(() => {});
        throw new SKUDeskError('REDIRECT', 'SKU Desk 不允许重定向', { status: response.status, ambiguous: writing });
      }
      const metadata = { status: response.status, ambiguous: writing && response.status >= 500, retryAfter: retryAfter(response.headers.get('retry-after')), requestId: /^[A-Za-z0-9._:-]{1,128}$/.test(response.headers.get('x-request-id') || '') ? response.headers.get('x-request-id') : '' };
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new SKUDeskError(`HTTP_${response.status}`, STATUS_MESSAGES[response.status] || 'SKU Desk 请求失败，请凭请求编号核对结果', metadata);
      }
      const lengthHeader = response.headers.get('content-length');
      if (lengthHeader && Number(lengthHeader) > maxBytes) {
        await response.body?.cancel?.().catch(() => {});
        throw new SKUDeskError('RESPONSE_TOO_LARGE', 'SKU Desk 返回内容超出限制', { ...metadata, ambiguous: writing });
      }
      const chunks = [];
      let total = 0;
      if (!response.body?.getReader) throw new SKUDeskError('INVALID_RESPONSE', 'SKU Desk 未返回可读取内容', { ...metadata, ambiguous: writing });
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new SKUDeskError('RESPONSE_TOO_LARGE', 'SKU Desk 返回内容超出限制', { ...metadata, ambiguous: writing });
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks, total);
      if (binary) return bytes;
      let result;
      try { result = JSON.parse(bytes.toString('utf8')); } catch {
        throw new SKUDeskError('INVALID_JSON', 'SKU Desk 返回的 JSON 无效，请核对原请求结果', { ...metadata, ambiguous: writing });
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SKUDeskError('INVALID_RESPONSE', 'SKU Desk 返回格式无效', { ...metadata, ambiguous: writing });
      if (result.ok === false || typeof result.error === 'string') throw new SKUDeskError('API_REJECTED', 'SKU Desk 未确认请求成功，请核对原请求结果', { ...metadata, ambiguous: writing });
      return result;
    } catch (error) {
      if (error instanceof SKUDeskError) throw error;
      // Do not expose raw server bodies, request bodies, URLs or transport errors:
      // these can contain the API token, buyer identity, or a label address.
      const code = timedOut ? 'TIMEOUT' : controller.signal.aborted ? 'ABORTED' : 'NETWORK';
      throw new SKUDeskError(code, code === 'TIMEOUT' ? 'SKU Desk 请求超时，请核对原请求结果' : code === 'ABORTED' ? 'SKU Desk 请求已取消；已发送的操作需核对结果' : 'SKU Desk 网络请求失败，请核对原请求结果', { status: response?.status || 0, ambiguous: writing });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  me(options = {}) { return this.#request('GET', '/me', options); }
  products(query, options = {}) { return this.#request('GET', `/products${queryString(query, ['sku', 'q', 'categoryId', 'storeId', 'page', 'pageSize'])}`, options); }
  product(productId, options = {}) { return this.#request('GET', `/products/${id(productId)}`, options); }
  photoSets(query, options = {}) { return this.#request('GET', `/photos/sets${queryString(query, ['productId', 'status', 'mine', 'page', 'pageSize'])}`, options); }
  photoSet(setId, options = {}) { return this.#request('GET', `/photos/sets/${id(setId)}`, options); }
  claim(claimId, options = {}) { return this.#request('GET', `/photos/claims/${id(claimId)}`, options); }
  orders(query, options = {}) { return this.#request('GET', `/orders${queryString(query, ['buyerUsername', 'method', 'storeId', 'page', 'pageSize'])}`, options); }
  order(orderId, options = {}) { return this.#request('GET', `/orders/${id(orderId)}`, options); }
  wmsOrder(orderId, options = {}) { return this.#request('GET', `/wms/orders/${id(orderId)}`, options); }
  syncWmsOrder(orderId, { signal } = {}) { return this.#request('POST', `/wms/orders/${id(orderId)}`, { payload: { action: 'sync' }, signal }); }

  claimPhotos(payload, { idempotencyKey: key, signal } = {}) {
    object(payload, '照片领取', ['productId', 'setId']);
    const body = cleanObject({ productId: text(payload.productId, '商品编号', { max: 256 }), setId: text(payload.setId, '照片套组编号', { optional: true, max: 256 }) });
    return this.#request('POST', '/photos/claims', { payload: body, key: idempotencyKey(key), signal });
  }

  markListed(claimId, payload, { idempotencyKey: key, signal } = {}) {
    object(payload, '上架关联', ['action', 'platform', 'listingId', 'listingUrl']);
    if (payload.action !== 'published') invalid('上架关联 action 必须为 published');
    const body = cleanObject({ action: 'published', platform: text(payload.platform, '平台名称', { max: 120 }), listingId: text(payload.listingId, '平台商品编号', { optional: true, max: 512 }), listingUrl: text(payload.listingUrl, '平台商品链接', { optional: true }) });
    if (!body.listingId && !body.listingUrl) invalid('必须提供平台商品编号或链接');
    if (body.listingUrl) {
      let url;
      try { url = new URL(body.listingUrl); } catch { invalid('平台商品链接无效'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) invalid('平台商品链接必须为 HTTP(S) 地址');
    }
    return this.#request('POST', `/photos/claims/${id(claimId)}`, { payload: body, key: idempotencyKey(key, true), signal });
  }

  checkout(payload, { signal } = {}) {
    object(payload, '仓库预检', ['items', 'storeId']);
    return this.#request('POST', '/wms/checkout', { payload: cleanObject({ items: items(payload.items), storeId: text(payload.storeId, '货盘客户编号', { optional: true, max: 256 }) }), signal });
  }

  createOrder(payload, { idempotencyKey: key, signal } = {}) {
    object(payload, '货盘订单', ['items', 'buyerUsername', 'fulfillmentMethod', 'storeId', 'warehouse', 'confirmationKey', 'confirmWms', 'carrier', 'trackingNo', 'note', 'file']);
    if (!['self', 'wms'].includes(payload.fulfillmentMethod)) invalid('发货方式必须为 self 或 wms');
    const body = { items: items(payload.items), buyerUsername: text(payload.buyerUsername, '买家账号', { max: 120 }), fulfillmentMethod: payload.fulfillmentMethod };
    for (const field of ['storeId', 'warehouse', 'confirmationKey', 'carrier', 'trackingNo', 'note']) {
      const value = text(payload[field], field, { optional: true, max: field === 'note' ? 4000 : 512 });
      if (value !== undefined) body[field] = value;
    }
    if (payload.fulfillmentMethod === 'wms') {
      if (!body.warehouse || !body.confirmationKey || payload.confirmWms !== '1' || !payload.file) invalid('WMS 下单必须提供预检仓库、confirmationKey、confirmWms="1" 和面单');
      body.confirmWms = '1';
    } else if (payload.confirmWms !== undefined || payload.warehouse !== undefined || payload.confirmationKey !== undefined) invalid('自行发货订单不能携带 WMS 确认信息');
    return this.#request('POST', '/orders', { payload: body, file: payload.file, key: idempotencyKey(key), signal });
  }

  download(pathOrURL, { signal, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DOWNLOAD_BYTES) invalid('下载大小限制必须在 1 字节至 128 MiB 之间');
    return this.#request('GET', pathOrURL, { signal, binary: true, maxBytes });
  }
}

module.exports = { SKUDeskClient, SKUDeskError, normalizeBaseURL, API_VERSION, MAX_JSON_BYTES, MAX_REQUEST_BYTES, MAX_LABEL_BYTES, MAX_DOWNLOAD_BYTES };
