'use strict';

const { performance } = require('node:perf_hooks');

class RequestGateAbortedError extends Error {
  constructor() {
    super('SKU Desk 请求在等待队列中已取消');
    this.name = 'AbortError';
    this.code = 'ABORTED';
    this.ambiguous = false;
  }
}

// Share one instance across all SKU clients/windows. A slot covers the whole
// operation supplied to run(), including streamed response reads and cleanup.
class RequestGate {
  #queue = [];
  #starts = [];
  #running = 0;
  #timer = null;
  #pumping = false;
  #clock;

  constructor({ maxConcurrent = 3, maxPerMinute = 100, windowMs = 60000, clock } = {}) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw new TypeError('SKU 并发上限须在 1–4 之间');
    if (!Number.isSafeInteger(maxPerMinute) || maxPerMinute < 1 || maxPerMinute > 120) throw new TypeError('SKU 滑动窗口请求数须在 1–120 之间');
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new TypeError('SKU 请求窗口时长必须为正整数毫秒');
    this.maxConcurrent = maxConcurrent;
    this.maxPerMinute = maxPerMinute;
    this.windowMs = windowMs;
    this.#clock = clock || { now: () => performance.now(), setTimeout, clearTimeout };
    for (const key of ['now', 'setTimeout', 'clearTimeout']) if (typeof this.#clock[key] !== 'function') throw new TypeError('SKU 请求调度时钟无效');
  }

  run(fn, signal) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('请求任务必须是函数'));
    if (signal?.aborted) return Promise.reject(new RequestGateAbortedError());
    return new Promise((resolve, reject) => {
      const job = { fn, signal, resolve, reject, started: false, onAbort: null };
      job.onAbort = () => {
        if (job.started) return;
        const index = this.#queue.indexOf(job);
        if (index !== -1) this.#queue.splice(index, 1);
        signal?.removeEventListener('abort', job.onAbort);
        reject(new RequestGateAbortedError());
        this.#pump();
      };
      signal?.addEventListener('abort', job.onAbort, { once: true });
      this.#queue.push(job);
      this.#pump();
    });
  }

  state() {
    this.#prune(this.#clock.now());
    return { running: this.#running, queued: this.#queue.length, startsInWindow: this.#starts.length, maxConcurrent: this.maxConcurrent, maxPerMinute: this.maxPerMinute, windowMs: this.windowMs };
  }

  #prune(now) {
    while (this.#starts.length && this.#starts[0] <= now - this.windowMs) this.#starts.shift();
  }

  #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      if (this.#timer !== null) { this.#clock.clearTimeout(this.#timer); this.#timer = null; }
      let now = this.#clock.now();
      this.#prune(now);
      while (this.#queue.length && this.#running < this.maxConcurrent && this.#starts.length < this.maxPerMinute) {
        const job = this.#queue.shift();
        job.signal?.removeEventListener('abort', job.onAbort);
        if (job.signal?.aborted) { job.reject(new RequestGateAbortedError()); continue; }
        job.started = true;
        this.#running++;
        now = this.#clock.now();
        this.#starts.push(now);
        // This function catches task failures itself; no background rejection is
        // left unhandled, and failed writes are never automatically repeated.
        this.#execute(job);
      }
      if (this.#queue.length && this.#starts.length >= this.maxPerMinute) {
        const delay = Math.max(1, Math.ceil(this.#starts[0] + this.windowMs - this.#clock.now()));
        this.#timer = this.#clock.setTimeout(() => { this.#timer = null; this.#pump(); }, delay);
      }
    } finally { this.#pumping = false; }
  }

  async #execute(job) {
    try {
      // The operation receives the signal and must stop/clean up on abort.
      // Keep its slot until it settles; releasing early could exceed the
      // server limit while an aborted download is still being cleaned up.
      job.resolve(await job.fn(job.signal));
    } catch (error) {
      job.reject(error);
    } finally {
      this.#running--;
      this.#pump();
    }
  }
}

module.exports = { RequestGate, RequestGateAbortedError };
