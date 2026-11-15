// Scan worker: does blocking filesystem calls (much faster than async ones),
// while the main thread stays free for the UI. Work arrives in small jobs so
// all workers stay busy.

import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { nameMatcher, targetMatcher } from './match.js';

const IS_WINDOWS = process.platform === 'win32';
const BUDGET = 4000; // entries handled before returning leftover folders to the queue
const TOP_FILES = 15; // files per folder kept individually for the tree view
const IN_NODE_MODULES = `${path.sep}node_modules${path.sep}`;

const { targets, exclude, excludePaths, minFileBytes, statFiles } = workerData;
const matchTarget = targetMatcher(targets);
const isExcluded = nameMatcher(exclude);
const skipPaths = new Set(excludePaths);

const diskSize = (st) => (IS_WINDOWS ? st.size : st.blocks * 512);
const lstat = (p) => fs.lstatSync(p, { throwIfNoEntry: false });
const readdir = (p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return null;
  }
};

/** Resolves entry type, asking the filesystem when the dirent doesn't say. */
function kind(entry, full) {
  if (entry.isSymbolicLink()) return 'link';
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (entry.isFIFO() || entry.isSocket() || entry.isBlockDevice() || entry.isCharacterDevice()) return 'other';
  const st = lstat(full);
  return st?.isDirectory() ? 'dir' : st?.isFile() ? 'file' : 'other';
}

/**
 * Walks folders depth-first until the budget runs out. For every folder it
 * reports the size of the files directly inside it, so the main thread can
 * build a size tree.
 */
function walk(dirs) {
  const stack = [...dirs];
  const records = [];
  const bigFiles = [];
  const measure = [];
  let seen = 0;
  let files = 0;

  while (stack.length > 0 && seen < BUDGET) {
    const dir = stack.pop();
    const entries = readdir(dir);
    if (!entries) continue;
    seen += entries.length;

    const record = { path: dir, bytes: 0, mtime: 0, top: [], restCount: 0, restBytes: 0 };
    const local = [];

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const type = kind(entry, full);
      if (type === 'dir') {
        if (isExcluded(entry.name) || skipPaths.has(full)) continue;
        let target = matchTarget(entry.name, entries);
        // A package's own dist/build inside node_modules is not junk, it's the package.
        if (target?.risky && full.includes(IN_NODE_MODULES)) target = null;
        if (target) measure.push({ path: full, name: entry.name, target });
        else stack.push(full);
      } else if (type === 'file' && statFiles) {
        files += 1;
        const st = lstat(full);
        if (!st) continue;
        const size = diskSize(st);
        record.bytes += size;
        if (st.mtimeMs > record.mtime) record.mtime = st.mtimeMs;
        local.push({ name: entry.name, size, mtime: st.mtimeMs });
        if (size >= minFileBytes) bigFiles.push({ dir, name: entry.name, size, mtime: st.mtimeMs });
      }
    }

    if (local.length > TOP_FILES) {
      local.sort((a, b) => b.size - a.size);
      for (let i = TOP_FILES; i < local.length; i += 1) {
        record.restCount += 1;
        record.restBytes += local[i].size;
      }
      local.length = TOP_FILES;
    }
    record.top = local;
    records.push(record);
  }

  return { records, bigFiles, measure, rest: stack, files };
}

/** Total on-disk size and newest modification time of a junk folder. */
function measure({ path: root, name, target }) {
  const stack = [root];
  const inodes = new Set();
  let size = 0;
  let mtime = 0;
  let dirs = 0;

  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = readdir(dir);
    if (!entries) continue;
    dirs += 1;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const type = kind(entry, full);
      if (type === 'dir') {
        stack.push(full);
      } else if (type === 'file') {
        const st = lstat(full);
        if (!st) continue;
        if (st.nlink > 1) {
          const key = `${st.dev}:${st.ino}`;
          if (inodes.has(key)) continue;
          inodes.add(key);
        }
        size += diskSize(st);
        if (st.mtimeMs > mtime) mtime = st.mtimeMs;
      }
    }
  }

  return { junk: { path: root, name, target, size, mtime }, dirs };
}

parentPort.on('message', (job) => {
  parentPort.postMessage(job.kind === 'measure' ? measure(job.target) : walk(job.dirs));
});
