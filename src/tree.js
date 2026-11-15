import path from 'node:path';

/**
 * Size tree shared by the list and tree views. Folders and files are
 * "entries": both have type, name, path, size, mtime and status, so the UI
 * can select and delete either the same way.
 */

export class DirNode {
  constructor(name, fullPath, parent) {
    this.type = 'dir';
    this.name = name;
    this.path = fullPath;
    this.parent = parent;
    this.kids = [];
    this.files = []; // largest files, kept individually
    this.restCount = 0; // remaining smaller files, summed
    this.restBytes = 0;
    this.own = 0; // bytes of files directly inside
    this.total = 0; // bytes of everything inside
    this.listedBytes = 0; // bytes of files directly inside that are listed as large files
    this.mtime = 0;
    this.junk = false; // measured as a whole, never walked into
    this.kind = undefined; // 'junk' | 'folder' when listed
    this.group = '';
    this.risky = false;
    this.status = undefined;
  }

  get size() {
    return this.total;
  }
}

export class FileEntry {
  constructor(parent, { name, size, mtime }, inTop = true) {
    this.name = name;
    this.parent = parent;
    this.size = size;
    this.mtime = mtime;
    this.inTop = inTop;
  }

  // Computed on demand: there can be millions of these.
  get path() {
    return path.join(this.parent.path, this.name);
  }
}
// Shared defaults live on the prototype to keep each entry small.
Object.assign(FileEntry.prototype, { type: 'file', kind: undefined, group: '', risky: false, status: undefined });

export const isInside = (base, target) => target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);

/** True when the entry or one of its parents is deleted or being deleted. */
export function isGone(entry) {
  for (let n = entry; n; n = n.parent) {
    if (n.status === 'deleted' || n.status === 'deleting') return true;
  }
  return false;
}

/** Records a successful deletion in the tree. Returns the bytes freed. */
export function markDeleted(entry) {
  const size = entry.size;
  entry.status = 'deleted';
  const parent = entry.parent;
  if (entry.type === 'file' && parent) {
    parent.own -= size;
    if (!entry.inTop) {
      parent.restCount -= 1;
      parent.restBytes -= size;
    }
  }
  for (let n = parent; n; n = n.parent) n.total -= size;
  return size;
}

/**
 * Picks the deepest folders that hold at least `minBytes` of data not already
 * listed as junk or as a large file. Showing only the deepest ones avoids
 * listing ~/, ~/Videos and ~/Videos/2024 for the same bytes.
 */
export function findLargeFolders(root, minBytes) {
  const order = [];
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    order.push(n);
    for (const k of n.kids) if (!k.junk) stack.push(k);
  }

  const rem = new Map();
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const n = order[i];
    let r = n.own - n.listedBytes;
    for (const k of n.kids) {
      if (k.status === 'deleted') continue;
      r += k.junk ? (k.kind === 'junk' ? 0 : k.total) : rem.get(k);
    }
    rem.set(n, r);
  }

  return order.filter((n) =>
    n !== root &&
    n.status !== 'deleted' &&
    rem.get(n) >= minBytes &&
    !n.kids.some((k) => !k.junk && rem.get(k) >= minBytes));
}
