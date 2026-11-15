// Scan worker: does blocking filesystem calls (much faster than async ones),
// while the main thread stays free for the UI. Work arrives in small jobs so
// all workers stay busy.

import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { fileKind } from './defaults.js';
import { nameMatcher, targetMatcher } from './match.js';

const IS_WINDOWS = process.platform === 'win32';
const BUDGET = 4000; // entries handled before returning leftover folders to the queue
const IN_NODE_MODULES = `${path.sep}node_modules${path.sep}`;

const { targets, exclude, excludePaths, minDirBytes, minFileBytes, scanFiles } = workerData;
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

/** Walks folders depth-first until the budget runs out. */
function walk(dirs) {
  const stack = [...dirs];
  const items = [];
  const measure = [];
  let seen = 0;
  let scanned = 0;
  let files = 0;

  while (stack.length > 0 && seen < BUDGET) {
    const dir = stack.pop();
    const entries = readdir(dir);
    if (!entries) continue;
    scanned += 1;
    seen += entries.length;

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
      } else if (type === 'file' && scanFiles) {
        files += 1;
        const st = lstat(full);
        if (!st) continue;
        const size = diskSize(st);
        if (size >= minFileBytes) {
          items.push({ type: 'file', path: full, name: entry.name, group: fileKind(entry.name), risky: false, size, mtime: st.mtimeMs });
        }
      }
    }
  }

  return { items, measure, rest: stack, dirs: scanned, files };
}

/** Total on-disk size and newest modification time of a folder. */
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

  const items = size >= minDirBytes
    ? [{ type: 'dir', path: root, name, group: target.group ?? 'custom', risky: Boolean(target.risky), size, mtime }]
    : [];
  return { items, measure: [], rest: [], dirs, files: 0 };
}

parentPort.on('message', (job) => {
  parentPort.postMessage(job.kind === 'measure' ? measure(job.target) : walk(job.dirs));
});
