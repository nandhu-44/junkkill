import { lstat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Deletes a scanned item after re-checking it: it must still exist, live
 * strictly inside the scan root, not be a symlink and not be a protected path.
 */
export async function removeItem(item, root, { dryRun = false } = {}) {
  const full = path.resolve(item.path);
  const scanRoot = path.resolve(root);

  if (!isInside(scanRoot, full)) throw new Error('outside the scanned folder');
  if (full === path.parse(full).root || full === os.homedir()) throw new Error('protected path');

  const st = await lstat(full).catch(() => null);
  if (!st) throw new Error('no longer exists');
  if (st.isSymbolicLink()) throw new Error('is a symlink');
  if ((item.type === 'dir') !== st.isDirectory()) throw new Error('changed since scan');

  if (dryRun) return;
  await rm(full, { recursive: true, force: true, maxRetries: 3 });
}
