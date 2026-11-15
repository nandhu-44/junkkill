import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./worker.js', import.meta.url);

export const defaultThreads = () =>
  Math.max(2, Math.min(8, os.availableParallelism?.() ?? os.cpus().length));

/**
 * Scans a folder tree using a small pool of worker threads.
 *
 * Emits:
 *   'item'  { id, type: 'dir'|'file', path, rel, name, group, risky, size, mtime }
 *   'done'  stats
 */
export class Scanner extends EventEmitter {
  #walkQueue = [];
  #measureQueue = [];
  #workers = [];
  #idle = [];
  #busy = 0;
  #nextId = 1;
  #resolve = () => {};

  constructor(opts) {
    super();
    this.root = path.resolve(opts.root);
    this.threads = Math.max(1, opts.threads ?? defaultThreads());
    this.workerData = {
      targets: opts.targets ?? [],
      exclude: opts.exclude ?? [],
      excludePaths: (opts.excludePaths ?? []).map((p) => path.resolve(p)),
      minDirBytes: opts.minDirBytes ?? 0,
      minFileBytes: opts.minFileBytes ?? Infinity,
      scanFiles: opts.scanFiles !== false
    };
    this.stats = { dirs: 0, files: 0, found: 0, startedAt: 0, endedAt: 0 };
    this.finished = false;
  }

  start() {
    this.stats.startedAt = Date.now();
    return new Promise((resolve) => {
      this.#resolve = resolve;
      this.#walkQueue.push([this.root]);
      for (let i = 0; i < this.threads; i += 1) this.#spawn();
      this.#dispatch();
    });
  }

  abort() {
    this.#walkQueue.length = 0;
    this.#measureQueue.length = 0;
    this.#finish();
  }

  #spawn() {
    const worker = new Worker(WORKER_URL, { workerData: this.workerData });
    worker.on('message', (result) => this.#onResult(worker, result));
    worker.on('error', () => this.#onResult(worker, null));
    this.#workers.push(worker);
    this.#idle.push(worker);
  }

  #dispatch() {
    while (this.#idle.length > 0) {
      let job;
      if (this.#measureQueue.length > 0) job = { kind: 'measure', target: this.#measureQueue.pop() };
      else if (this.#walkQueue.length > 0) job = { kind: 'walk', dirs: this.#walkQueue.pop() };
      else break;
      this.#busy += 1;
      this.#idle.pop().postMessage(job);
    }
    if (this.#busy === 0) this.#finish();
  }

  #onResult(worker, result) {
    if (this.finished) return;
    this.#busy -= 1;
    this.#idle.push(worker);

    if (result) {
      this.stats.dirs += result.dirs;
      this.stats.files += result.files;
      this.#measureQueue.push(...result.measure);
      // Split leftover folders so idle workers can share them.
      const { rest } = result;
      const chunk = Math.max(1, Math.ceil(rest.length / this.threads));
      for (let i = 0; i < rest.length; i += chunk) this.#walkQueue.push(rest.slice(i, i + chunk));
      for (const item of result.items) {
        item.id = this.#nextId++;
        item.rel = path.relative(this.root, item.path) || '.';
        this.stats.found += 1;
        this.emit('item', item);
      }
    }
    this.#dispatch();
  }

  #finish() {
    if (this.finished) return;
    this.finished = true;
    this.stats.endedAt = Date.now();
    for (const w of this.#workers) w.terminate();
    this.emit('done', this.stats);
    this.#resolve(this.stats);
  }
}
