'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestGate } = require('../src/sku-transport.cjs');
const { SKUDeskClient } = require('../src/sku-desk.cjs');

const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
class FakeClock {
  time = 0;
  nextId = 1;
  timers = new Map();
  now = () => this.time;
  setTimeout = (fn, ms) => { const id = this.nextId++; this.timers.set(id, { at: this.time + ms, fn }); return id; };
  clearTimeout = id => this.timers.delete(id);
  async advance(ms) {
    this.time += ms;
    const due = [...this.timers].filter(([, value]) => value.at <= this.time).sort((a, b) => a[1].at - b[1].at);
    for (const [id, value] of due) if (this.timers.delete(id)) value.fn();
    await flush();
  }
}
const makeClient = (requestGate, fetchImpl) => new SKUDeskClient({ baseURL: 'https://sku.example.test', token: 'skud_fixture_only', requestGate, fetchImpl });

test('request gate defaults stay below documented global SKU limits', () => {
  const gate = new RequestGate();
  assert.deepEqual(gate.state(), { running: 0, queued: 0, startsInWindow: 0, maxConcurrent: 3, maxPerMinute: 100, windowMs: 60000 });
  for (const config of [{ maxConcurrent: 5 }, { maxConcurrent: 0 }, { maxPerMinute: 121 }, { windowMs: 0 }, { clock: {} }]) assert.throws(() => new RequestGate(config), TypeError);
});

test('shared gate enforces concurrency and FIFO across clients', async () => {
  const gate = new RequestGate({ maxConcurrent: 2 });
  const releases = [deferred(), deferred(), deferred(), deferred()];
  const starts = [];
  let active = 0, peak = 0;
  const jobs = releases.map((release, index) => gate.run(async () => { starts.push(index); active++; peak = Math.max(peak, active); await release.promise; active--; return index; }));
  assert.deepEqual(starts, [0, 1]);
  assert.equal(gate.state().queued, 2);
  releases[1].resolve(); await flush();
  assert.deepEqual(starts, [0, 1, 2]);
  releases[0].resolve(); await flush();
  assert.deepEqual(starts, [0, 1, 2, 3]);
  releases[2].resolve(); releases[3].resolve();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3]);
  assert.equal(peak, 2);
  assert.equal(gate.state().running, 0);
});

test('sliding window limits starts, including failed tasks, with no fixed-minute burst', async () => {
  const clock = new FakeClock();
  const gate = new RequestGate({ maxConcurrent: 3, maxPerMinute: 2, windowMs: 100, clock });
  const starts = [];
  await gate.run(() => { starts.push(clock.time); return 'first'; });
  await clock.advance(40);
  await assert.rejects(gate.run(() => { starts.push(clock.time); throw new Error('failure still counts'); }), /failure/);
  const third = gate.run(() => { starts.push(clock.time); return 'third'; });
  const fourth = gate.run(() => { starts.push(clock.time); return 'fourth'; });
  assert.deepEqual(starts, [0, 40]);
  await clock.advance(59); assert.deepEqual(starts, [0, 40]);
  await clock.advance(1); assert.deepEqual(starts, [0, 40, 100]);
  assert.equal(await third, 'third');
  await clock.advance(39); assert.deepEqual(starts, [0, 40, 100]);
  await clock.advance(1); assert.deepEqual(starts, [0, 40, 100, 140]);
  assert.equal(await fourth, 'fourth');
  assert.equal(clock.timers.size, 0);
});

test('queued cancellation removes task immediately without consuming rate quota', async () => {
  const gate = new RequestGate({ maxConcurrent: 1 });
  const held = deferred();
  const first = gate.run(() => held.promise);
  const controller = new AbortController();
  let invoked = false;
  const second = gate.run(() => { invoked = true; }, controller.signal);
  controller.abort();
  await assert.rejects(second, error => error.code === 'ABORTED' && error.ambiguous === false);
  assert.equal(gate.state().queued, 0);
  assert.equal(gate.state().startsInWindow, 1);
  held.resolve(); await first;
  assert.equal(invoked, false);
});

test('pre-cancelled task never starts or consumes quota', async () => {
  const gate = new RequestGate();
  const controller = new AbortController(); controller.abort();
  let invoked = false;
  await assert.rejects(gate.run(() => { invoked = true; }, controller.signal), error => error.code === 'ABORTED');
  assert.equal(invoked, false);
  assert.equal(gate.state().startsInWindow, 0);
});

test('cancelling final rate-limited queued task clears pending wakeup', async () => {
  const clock = new FakeClock();
  const gate = new RequestGate({ maxPerMinute: 1, windowMs: 100, clock });
  await gate.run(() => 1);
  const controller = new AbortController();
  const queued = gate.run(() => 2, controller.signal);
  assert.equal(clock.timers.size, 1);
  controller.abort();
  await assert.rejects(queued, error => error.code === 'ABORTED');
  assert.equal(clock.timers.size, 0);
});

test('in-flight cancellation propagates but slot remains held until task cleanup settles', async () => {
  const gate = new RequestGate({ maxConcurrent: 1 });
  const cleanup = deferred();
  const controller = new AbortController();
  let sawAbort = false, secondStarted = false;
  const first = gate.run(async signal => {
    await new Promise(resolve => signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true }));
    await cleanup.promise;
    throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
  }, controller.signal);
  const second = gate.run(() => { secondStarted = true; });
  const firstResult = assert.rejects(first, /aborted/);
  controller.abort(); await flush();
  assert.equal(sawAbort, true);
  assert.equal(secondStarted, false);
  assert.equal(gate.state().running, 1);
  cleanup.resolve(); await firstResult; await second;
  assert.equal(secondStarted, true);
});

test('shared client gate holds slot until response body is fully consumed', async () => {
  const gate = new RequestGate({ maxConcurrent: 1 });
  let stream;
  const fetched = [];
  const first = makeClient(gate, async () => { fetched.push('first'); return new Response(new ReadableStream({ start(controller) { stream = controller; } })); });
  const second = makeClient(gate, async () => { fetched.push('second'); return new Response('{"ok":true}'); });
  const firstResult = first.me();
  const secondResult = second.me();
  await flush();
  assert.deepEqual(fetched, ['first']);
  assert.equal(gate.state().running, 1);
  stream.enqueue(Buffer.from('{"ok":true}')); stream.close();
  await firstResult; await secondResult;
  assert.deepEqual(fetched, ['first', 'second']);
  assert.equal(gate.state().running, 0);
});

test('queued client write cancellation reports unambiguous and never sends', async () => {
  const gate = new RequestGate({ maxConcurrent: 1 });
  const held = deferred(); const first = gate.run(() => held.promise);
  let fetches = 0;
  const client = makeClient(gate, async () => { fetches++; return new Response('{"ok":true}'); });
  const controller = new AbortController();
  const request = client.claimPhotos({ productId: 'product-1' }, { idempotencyKey: 'claim-1', signal: controller.signal });
  controller.abort();
  await assert.rejects(request, error => error.name === 'SKUDeskError' && error.code === 'ABORTED' && !error.ambiguous);
  assert.equal(fetches, 0);
  held.resolve(); await first;
});

test('dispatched write cancellation retains ambiguous classification through gate', async () => {
  const gate = new RequestGate({ maxConcurrent: 1 });
  let fetches = 0;
  const client = makeClient(gate, async (_url, options) => { fetches++; return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
  const controller = new AbortController();
  const request = client.claimPhotos({ productId: 'product-1' }, { idempotencyKey: 'claim-1', signal: controller.signal });
  controller.abort();
  await assert.rejects(request, error => error.code === 'ABORTED' && error.ambiguous);
  assert.equal(fetches, 1);
  assert.equal(gate.state().running, 0);
});

test('failed mutation is never silently retried and next queued operation proceeds', async () => {
  const gate = new RequestGate({ maxConcurrent: 1 });
  let writes = 0;
  const client = makeClient(gate, async (_url, options) => { if (options.method === 'POST') { writes++; throw new Error('offline'); } return new Response('{"ok":true}'); });
  const write = client.claimPhotos({ productId: 'product-1' }, { idempotencyKey: 'claim-1' });
  const read = client.me();
  await assert.rejects(write, error => error.code === 'NETWORK' && error.ambiguous);
  assert.deepEqual(await read, { ok: true });
  assert.equal(writes, 1);
  assert.equal(gate.state().startsInWindow, 2);
});

test('invalid API destination is rejected before occupying shared request quota', async () => {
  const gate = new RequestGate();
  const client = makeClient(gate, async () => { throw new Error('must not fetch'); });
  await assert.rejects(client.download('https://other.test/api/v1/photos/images/1'), error => error.code === 'INVALID_ARGUMENT');
  assert.equal(gate.state().startsInWindow, 0);
});
