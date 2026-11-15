import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileKind } from './defaults.js';
import { DirNode, FileEntry, findLargeFolders, isGone } from './tree.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);

export const KINDS = ['junk', 'folder', 'file'];

export const defaultThreads = () =>
  Math.max(2, Math.min(8, os.availableParallelism?.() ?? os.cpus().length));

/**
 * Scans a folder tree using a small pool of worker threads and builds a size
 * tree of everything outside junk folders.
 *
 * Emits:
 *   'item'      a listed entry (junk folder, large file, large folder)
 *   'progress'  after each batch of work, for live views
 *   'done'      stats
 *
 * Large folders can only be known once every size is in, so they are emitted
 * right before 'done'.
 */
export class Scanner extends EventEmitter {
  #walkQueue = [];
  #measureQueue = [];
  #workers = [];
  #idle = [];
  #busy = 0;
  #nextId = 1;
  #nodes = new Map();
  #resolve = () => {};

  constructor(opts) {
    super();
    this.root = path.resolve(opts.root);
    this.kinds = new Set(opts.kinds ?? KINDS);
    this.minJunkBytes = opts.minJunkBytes ?? 0;
    this.minFolderBytes = opts.minFolderBytes ?? Infinity;
    this.minFileBytes = opts.minFileBytes ?? Infinity;
    this.threads = Math.max(1, opts.threads ?? defaultThreads());

    // Folder sizes need every file statted; junk-only scans can skip that.
    const statFiles = opts.tree || this.kinds.has('folder') || this.kinds.has('file');
    this.tree = statFiles ? new DirNode(path.basename(this.root) || this.root, this.root, null) : null;
    this.workerData = {
      targets: opts.targets ?? [],
      exclude: opts.exclude ?? [],
      excludePaths: (opts.excludePaths ?? []).map((p) => path.resolve(p)),
      minFileBytes: this.kinds.has('file') ? this.minFileBytes : Infinity,
      statFiles
    };
    this.stats = { dirs: 0, files: 0, found: 0, startedAt: 0, endedAt: 0 };
    this.finished = false;
    this.error = null;
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
    this.#finish(false);
  }

  // --- workers -------------------------------------------------------------

  #spawn() {
    // execArgv: [] so flags meant for the main process can't stop workers from starting.
    const worker = new Worker(WORKER_URL, { workerData: this.workerData, execArgv: [] });
    worker.on('message', (result) => this.#onResult(worker, result));
    worker.on('error', (err) => {
      this.error ??= err;
      this.#onResult(worker, null);
    });
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
    if (this.#busy === 0) this.#finish(true);
  }

  #onResult(worker, result) {
    if (this.finished) return;
    this.#busy -= 1;
    this.#idle.push(worker);
    if (result?.junk) this.#onJunk(result);
    else if (result) this.#onWalk(result);
    this.emit('progress');
    this.#dispatch();
  }

  // --- tree building -------------------------------------------------------

  #node(p) {
    if (p === this.root) return this.tree;
    let n = this.#nodes.get(p);
    if (!n) {
      const parentPath = path.dirname(p);
      const parent = parentPath === p ? this.tree : this.#node(parentPath);
      n = new DirNode(path.basename(p), p, parent);
      parent.kids.push(n);
      this.#nodes.set(p, n);
    }
    return n;
  }

  /** Adds bytes to a node and all its parents, unless that part of the tree is being deleted. */
  #grow(node, bytes, mtime) {
    if (isGone(node)) return false;
    for (let n = node; n; n = n.parent) {
      n.total += bytes;
      if (mtime > n.mtime) n.mtime = mtime;
    }
    return true;
  }

  #onWalk({ records, bigFiles, measure, rest, files }) {
    this.stats.dirs += records.length;
    this.stats.files += files;
    this.#measureQueue.push(...measure);

    // Split leftover folders so idle workers can share them.
    const chunk = Math.max(1, Math.ceil(rest.length / this.threads));
    for (let i = 0; i < rest.length; i += chunk) this.#walkQueue.push(rest.slice(i, i + chunk));

    if (!this.tree) return;
    for (const r of records) {
      const node = this.#node(r.path);
      if (!this.#grow(node, r.bytes, r.mtime)) continue;
      node.own += r.bytes;
      node.restCount += r.restCount;
      node.restBytes += r.restBytes;
      for (const f of r.top) node.files.push(new FileEntry(node, f));
    }

    for (const f of bigFiles) {
      const node = this.#node(f.dir);
      if (isGone(node)) continue;
      const entry = node.files.find((e) => e.name === f.name) ?? new FileEntry(node, f, false);
      entry.kind = 'file';
      entry.group = fileKind(f.name);
      node.listedBytes += entry.size;
      this.#emitItem(entry);
    }
  }

  #onJunk({ junk, dirs }) {
    this.stats.dirs += dirs;
    const node = this.tree
      ? this.#node(junk.path)
      : new DirNode(junk.name, junk.path, null);
    node.junk = true;
    node.group = junk.target.group ?? 'custom';
    node.risky = Boolean(junk.target.risky);
    node.own = junk.size;
    if (!this.#grow(node, junk.size, junk.mtime)) return;
    if (this.kinds.has('junk') && junk.size >= this.minJunkBytes) {
      node.kind = 'junk';
      this.#emitItem(node);
    }
  }

  #emitItem(entry) {
    entry.id = this.#nextId++;
    entry.rel = path.relative(this.root, entry.path) || '.';
    this.stats.found += 1;
    this.emit('item', entry);
  }

  #finish(complete) {
    if (this.finished) return;
    this.finished = true;
    for (const w of this.#workers) w.terminate();
    if (complete && this.tree && this.kinds.has('folder')) {
      for (const node of findLargeFolders(this.tree, this.minFolderBytes)) {
        node.kind = 'folder';
        node.group = 'folder';
        node.risky = true; // regular folders hold your own data
        this.#emitItem(node);
      }
    }
    this.stats.endedAt = Date.now();
    this.emit('done', this.stats);
    this.#resolve(this.stats);
  }
}
