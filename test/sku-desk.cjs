'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SKUDeskClient, SKUDeskError, normalizeBaseURL, MAX_JSON_BYTES, MAX_LABEL_BYTES } = require('../src/sku-desk.cjs');

const TOKEN = 'skud_fixture_only';
const productItems = [{ productId: 'product-1', quantity: 2, productRevision: 3 }];
const selfOrder = () => ({ items: productItems, buyerUsername: 'fixture_buyer', fulfillmentMethod: 'self', carrier: 'Fixture Carrier', trackingNo: 'TRACK-001' });
const label = () => ({ data: Buffer.from('%PDF-1.7\nfixture document'), contentType: 'application/pdf' });
const wmsOrder = () => ({ ...selfOrder(), fulfillmentMethod: 'wms', warehouse: 'WH-1', confirmationKey: 'confirmation-1', confirmWms: '1', file: label() });
function jsonResponse(value, options = {}) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...options.headers }, status: options.status || 200 }); }
function fixture(reply = () => jsonResponse({ ok: true })) {
  const calls = [];
  const client = new SKUDeskClient({ baseURL: 'https://sku.example.test', token: TOKEN, fetchImpl: async (url, options) => { calls.push({ url, options }); return reply(url, options); } });
  return { client, calls };
}

test('SKU API base is normalized and remote HTTP or URL credentials are rejected', () => {
  assert.equal(normalizeBaseURL('https://sku.example.test/'), 'https://sku.example.test/api/v1');
  assert.equal(normalizeBaseURL('https://sku.example.test/shop/api/v1/'), 'https://sku.example.test/shop/api/v1');
  assert.equal(normalizeBaseURL('http://127.0.0.1:1234'), 'http://127.0.0.1:1234/api/v1');
  assert.equal(normalizeBaseURL('http://[::1]:1234'), 'http://[::1]:1234/api/v1');
  for (const base of ['http://sku.example.test', 'https://user:secret@sku.example.test', 'https://sku.example.test?token=secret', 'file:///tmp/key', 'https://sku.example.test/#secret']) assert.throws(() => normalizeBaseURL(base), SKUDeskError);
});

test('constructor rejects injected header characters and keeps token out of serialization', () => {
  assert.throws(() => new SKUDeskClient({ baseURL: 'https://sku.example.test', token: 'skud_ok\r\nX-Evil: yes' }), SKUDeskError);
  const { client } = fixture();
  assert.equal(JSON.stringify(client).includes(TOKEN), false);
});

test('read methods use API 1.8 paths and preserve response envelopes', async () => {
  const envelope = { products: [{ id: 'product-1', price_cents: 1995 }], page: 1, pageSize: 50, total: 1 };
  const { client, calls } = fixture(() => jsonResponse(envelope));
  assert.deepEqual(await client.products({ sku: 'SKU/1 & 2', page: 1, pageSize: 100 }), envelope);
  await client.me(); await client.product('product-1'); await client.photoSets({ productId: 'product-1', mine: 1 });
  await client.photoSet('set-1'); await client.claim('claim-1'); await client.orders({ buyerUsername: 'buyer & friend' }); await client.order('order-1');
  assert.equal(calls[0].url, 'https://sku.example.test/api/v1/products?sku=SKU%2F1+%26+2&page=1&pageSize=100');
  assert.deepEqual(calls.slice(1).map(c => new URL(c.url).pathname), ['/api/v1/me', '/api/v1/products/product-1', '/api/v1/photos/sets', '/api/v1/photos/sets/set-1', '/api/v1/photos/claims/claim-1', '/api/v1/orders', '/api/v1/orders/order-1']);
  for (const { options } of calls) { assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`); assert.equal(options.redirect, 'error'); }
});

test('invalid pagination, undocumented query fields and unsafe IDs fail before fetch', () => {
  const { client, calls } = fixture();
  for (const q of [{ pageSize: 101 }, { page: 0 }, { page: '1' }, { token: 'secret' }]) assert.throws(() => client.products(q), SKUDeskError);
  assert.throws(() => client.photoSets({ mine: true }), SKUDeskError);
  for (const value of ['', '..', '../me', 'a\\b']) assert.throws(() => client.product(value), SKUDeskError);
  assert.equal(calls.length, 0);
});

test('claim requires stable idempotency and exact API payload', async () => {
  const result = { claimId: 'claim-1', set: { images: [{ url: '/api/v1/photos/images/img-1' }], claim: { download_url: '/api/v1/photos/claims/claim-1/download' } } };
  const { client, calls } = fixture(() => jsonResponse(result));
  assert.throws(() => client.claimPhotos({ productId: 'product-1' }), /Idempotency/);
  assert.throws(() => client.claimPhotos({ productId: 'product-1' }, { idempotencyKey: 'x\ny' }), /Idempotency/);
  assert.throws(() => client.claimPhotos({ productId: 'product-1', externalRef: 'invented' }, { idempotencyKey: 'claim-1' }), /不支持/);
  assert.deepEqual(await client.claimPhotos({ productId: 'product-1', setId: 'set-1' }, { idempotencyKey: 'claim-profile1-job1' }), result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'claim-profile1-job1');
  assert.deepEqual(JSON.parse(calls[0].options.body), { productId: 'product-1', setId: 'set-1' });
});

test('published association requires an actual listing reference', async () => {
  const { client, calls } = fixture();
  assert.throws(() => client.markListed('claim-1', { action: 'published', platform: 'Vinted' }), /编号或链接/);
  assert.throws(() => client.markListed('claim-1', { action: 'publish', platform: 'Vinted', listingId: '123' }), /published/);
  assert.throws(() => client.markListed('claim-1', { action: 'published', platform: 'Vinted', listingUrl: 'javascript:alert(1)' }), /HTTP/);
  await client.markListed('claim-1', { action: 'published', platform: 'Vinted', listingId: '123', listingUrl: 'https://www.vinted.fr/items/123' });
  assert.equal(calls[0].options.headers['Idempotency-Key'], undefined);
  assert.equal(JSON.parse(calls[0].options.body).listingId, '123');
});

test('self order sends decimal-free product quantities and no invented sale price', async () => {
  const { client, calls } = fixture(() => jsonResponse({ ok: true, id: 'sale-1', method: 'self', wmsStatus: null }));
  assert.throws(() => client.createOrder(selfOrder()), /Idempotency/);
  assert.throws(() => client.createOrder({ ...selfOrder(), price: 1995 }, { idempotencyKey: 'order-1' }), /不支持/);
  assert.throws(() => client.createOrder({ ...selfOrder(), items: [{ productId: 'p', quantity: 1.5 }] }, { idempotencyKey: 'order-1' }), /正整数/);
  assert.throws(() => client.createOrder({ ...selfOrder(), items: [{ productId: 'p', quantity: 1 }, { productId: 'p', quantity: 2 }] }, { idempotencyKey: 'order-1' }), /合并/);
  await client.createOrder(selfOrder(), { idempotencyKey: 'vinted-profile1-order123' });
  assert.deepEqual(JSON.parse(calls[0].options.body), selfOrder());
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
});

test('checkout preserves confirmation data and does not create an order', async () => {
  const result = { warehouses: [{ code: 'WH-1', canFulfill: true }], recommendedWarehouse: 'WH-1', confirmationKey: 'confirmation-1' };
  const { client, calls } = fixture(() => jsonResponse(result));
  assert.deepEqual(await client.checkout({ items: productItems, storeId: 'store-1' }), result);
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/wms/checkout');
  assert.deepEqual(JSON.parse(calls[0].options.body), { items: productItems, storeId: 'store-1' });
  assert.equal(calls[0].options.headers['Idempotency-Key'], undefined);
});

test('WMS order requires preflight confirmation, label and exact explicit confirmation', async () => {
  const { client, calls } = fixture();
  for (const patch of [{ file: undefined }, { confirmationKey: '' }, { warehouse: '' }, { confirmWms: true }]) assert.throws(() => client.createOrder({ ...wmsOrder(), ...patch }, { idempotencyKey: 'order-1' }), /WMS/);
  assert.throws(() => client.createOrder({ ...selfOrder(), warehouse: 'WH-1' }, { idempotencyKey: 'order-1' }), /自行发货/);
  assert.equal(calls.length, 0);
});

test('multipart preserves original label and is deterministic for replay with same business ID', async () => {
  const { client, calls } = fixture(() => jsonResponse({ ok: true, id: 'sale-1', orderId: 'wms-1', wmsStatus: 'uncertain' }));
  const result = await client.createOrder(wmsOrder(), { idempotencyKey: 'order-1' });
  await client.createOrder(wmsOrder(), { idempotencyKey: 'order-1' });
  assert.equal(result.wmsStatus, 'uncertain'); // HTTP 200 must not be promoted to WMS success.
  assert.equal(result.orderId, 'wms-1');
  assert.equal(calls[0].options.headers['Content-Type'], calls[1].options.headers['Content-Type']);
  assert.deepEqual(calls[0].options.body, calls[1].options.body);
  const body = calls[0].options.body.toString();
  assert.match(body, /name="items"\r\n\r\n\[\{"productId":"product-1","productRevision":3,"quantity":2\}\]/);
  assert.match(body, /filename="label.pdf"/);
  assert.match(body, /%PDF-1.7\nfixture document/);
  assert.equal(body.includes(TOKEN), false);
});

test('invalid or oversized label is rejected before making a request', async () => {
  const { client, calls } = fixture();
  for (const file of [{ data: Buffer.from('wrong'), contentType: 'application/pdf' }, { data: Buffer.from('x'), contentType: 'text/html' }, { data: Buffer.alloc(MAX_LABEL_BYTES + 1), contentType: 'application/pdf' }, { data: '/tmp/secret.pdf', contentType: 'application/pdf' }]) await assert.rejects(client.createOrder({ ...wmsOrder(), file }, { idempotencyKey: 'order-1' }), SKUDeskError);
  assert.equal(calls.length, 0);
});

test('ambiguous transport write failure is not retried and cannot leak transport details', async () => {
  const { client, calls } = fixture(() => { throw new Error(`leaked ${TOKEN} fixture_buyer`); });
  await assert.rejects(client.createOrder(selfOrder(), { idempotencyKey: 'order-1' }), error => {
    assert.equal(error.code, 'NETWORK'); assert.equal(error.ambiguous, true); assert.equal(error.status, 0);
    assert.equal(error.message.includes(TOKEN), false); assert.equal(error.message.includes('fixture_buyer'), false); return true;
  });
  assert.equal(calls.length, 1);
});

test('read transport failure is non-ambiguous and returned for scheduler retry', async () => {
  const { client, calls } = fixture(() => { throw new Error('offline'); });
  await assert.rejects(client.me(), error => error.code === 'NETWORK' && error.ambiguous === false);
  assert.equal(calls.length, 1);
});

test('503 write is ambiguous while 409 conflict and 429 rate limit are explicit rejection', async () => {
  for (const [status, ambiguous] of [[503, true], [409, false], [429, false]]) {
    const { client, calls } = fixture(() => jsonResponse({ error: `private ${TOKEN} fixture_buyer` }, { status, headers: { 'Retry-After': '17', 'X-Request-Id': 'req-123' } }));
    await assert.rejects(client.claimPhotos({ productId: 'product-1' }, { idempotencyKey: 'claim-1' }), error => {
      assert.equal(error.status, status); assert.equal(error.ambiguous, ambiguous); assert.equal(error.retryAfter, 17); assert.equal(error.requestId, 'req-123'); assert.equal(error.message.includes(TOKEN), false); return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('malformed HTTP 200 write is ambiguous, so caller must reconcile original operation', async () => {
  const { client } = fixture(() => new Response('<html>upstream failure</html>', { status: 200 }));
  await assert.rejects(client.createOrder(selfOrder(), { idempotencyKey: 'order-1' }), error => error.code === 'INVALID_JSON' && error.ambiguous && error.status === 200);
});

test('response stream size is bounded even when Content-Length is absent', async () => {
  const { client } = fixture(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_JSON_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } })));
  await assert.rejects(client.me(), error => error.code === 'RESPONSE_TOO_LARGE' && !error.ambiguous);
});

test('declared content length is checked before response body buffering', async () => {
  const { client } = fixture(() => new Response('tiny', { headers: { 'Content-Length': String(MAX_JSON_BYTES + 1) } }));
  await assert.rejects(client.me(), error => error.code === 'RESPONSE_TOO_LARGE');
});

test('pre-aborted write does not send while in-flight abort requires reconciliation', async () => {
  const pre = new AbortController(); pre.abort();
  const first = fixture();
  await assert.rejects(first.client.createOrder(selfOrder(), { idempotencyKey: 'order-1', signal: pre.signal }), error => error.code === 'ABORTED' && !error.ambiguous);
  assert.equal(first.calls.length, 0);
  const active = new AbortController();
  const second = fixture((_url, options) => new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); queueMicrotask(() => active.abort()); }));
  await assert.rejects(second.client.createOrder(selfOrder(), { idempotencyKey: 'order-1', signal: active.signal }), error => error.code === 'ABORTED' && error.ambiguous);
  assert.equal(second.calls.length, 1);
});

test('request timeout marks dispatched write as ambiguous', async () => {
  const client = new SKUDeskClient({ baseURL: 'https://sku.example.test', token: TOKEN, timeoutMs: 5, fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  await assert.rejects(client.claimPhotos({ productId: 'product-1' }, { idempotencyKey: 'claim-1' }), error => error.code === 'TIMEOUT' && error.ambiguous);
});

test('download allows only same-origin API paths and never forwards auth elsewhere', async () => {
  const { client, calls } = fixture(() => new Response(Buffer.from([1, 2, 3])));
  for (const path of ['https://other.test/api/v1/photos/images/img-1', '//other.test/api/v1/img', 'https://sku.example.test/other', '/photos/../../other', '/photos/%2e%2e/other', '/photos/%252e%252e/other', 'https://user:pass@sku.example.test/api/v1/me']) await assert.rejects(client.download(path), SKUDeskError);
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.download('/api/v1/photos/images/img-1'), Buffer.from([1, 2, 3]));
  assert.deepEqual(await client.download('/photos/claims/claim-1/download'), Buffer.from([1, 2, 3]));
  assert.deepEqual(await client.download('https://sku.example.test/api/v1/orders/order-1/label'), Buffer.from([1, 2, 3]));
  assert.equal(calls.length, 3);
});

test('download stops when explicit binary limit is exceeded', async () => {
  const { client } = fixture(() => new Response(Buffer.from([1, 2, 3])));
  await assert.rejects(client.download('/photos/images/img-1', { maxBytes: 2 }), error => error.code === 'RESPONSE_TOO_LARGE');
  assert.throws(() => client.download('/photos/images/img-1', { maxBytes: 0 }), SKUDeskError);
});

test('redirect responses fail without reading or retrying another destination', async () => {
  const { client, calls } = fixture(() => new Response(null, { status: 302, headers: { Location: 'https://other.test' } }));
  await assert.rejects(client.me(), error => error.code === 'REDIRECT');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'error');
});

test('WMS reconciliation addresses only original WMS record and preserves uncertain state', async () => {
  const { client, calls } = fixture(() => jsonResponse({ order: { id: 'wms-1', status: 'uncertain' }, retry_after: 30 }));
  await client.wmsOrder('wms-1');
  const result = await client.syncWmsOrder('wms-1');
  assert.equal(result.order.status, 'uncertain');
  assert.equal(result.retry_after, 30);
  assert.equal(calls[1].url, 'https://sku.example.test/api/v1/wms/orders/wms-1');
  assert.deepEqual(JSON.parse(calls[1].options.body), { action: 'sync' });
});
