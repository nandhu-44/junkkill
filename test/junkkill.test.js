import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeTargets, mergeNames, parseSize, resolveOptions, loadConfig } from '../src/config.js';
import { DEFAULT_TARGETS, DEFAULT_EXCLUDE, fileKind } from '../src/defaults.js';
import { parseArgs } from '../src/cli.js';
import { Scanner } from '../src/scanner.js';
import { markDeleted } from '../src/tree.js';
import { removeItem } from '../src/remove.js';
import { formatBytes, truncateLeft } from '../src/format.js';

const KB = 1024;

function tree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'junkkill-test-'));
  for (const [rel, bytes] of Object.entries(spec)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(bytes, 1));
  }
  return root;
}

async function scan(root, overrides = {}) {
  const s = new Scanner({
    root, targets: DEFAULT_TARGETS, exclude: DEFAULT_EXCLUDE, kinds: ['junk', 'file'],
    minJunkBytes: 0, minFileBytes: 64 * KB, minFolderBytes: 64 * KB, threads: 2, ...overrides
  });
  const items = [];
  s.on('item', (i) => items.push(i));
  await s.start();
  items.sort((a, b) => a.rel.localeCompare(b.rel));
  items.scanner = s;
  return items;
}

test('parseSize understands units and plain MB numbers', () => {
  assert.equal(parseSize('10MB'), 10 * 1024 ** 2);
  assert.equal(parseSize('1.5 gb'), 1.5 * 1024 ** 3);
  assert.equal(parseSize('512k'), 512 * KB);
  assert.equal(parseSize('0'), 0);
  assert.equal(parseSize(2), 2 * 1024 ** 2);
  assert.throws(() => parseSize('lots'));
  assert.throws(() => parseSize('5 parsecs'));
});

test('mergeTargets adds, overrides and removes', () => {
  const merged = mergeTargets(DEFAULT_TARGETS, ['!dist', 'data', { name: 'build', when: [] }]);
  assert.ok(!merged.some((t) => t.name === 'dist'));
  assert.equal(merged[0].name, 'data');
  assert.equal(merged[1].name, 'build');
  assert.throws(() => mergeTargets(DEFAULT_TARGETS, [42]));
});

test('mergeNames handles additions and removals', () => {
  assert.deepEqual(mergeNames(['.git', '.hg'], ['archive', '!.hg']), ['.git', 'archive']);
});

test('resolveOptions layers defaults, config and CLI', () => {
  const MB = 1024 ** 2;
  const opts = resolveOptions({ minJunkSize: '50MB', sort: 'age' }, { minJunk: '1MB', yes: true });
  assert.equal(opts.minJunkBytes, MB);
  assert.equal(opts.minFolderBytes, 1024 * MB);
  assert.equal(opts.minFileBytes, 100 * MB);
  assert.deepEqual([...opts.kinds], ['junk', 'folder', 'file']);
  assert.equal(opts.view, 'list');
  assert.equal(opts.sort, 'age');
  assert.equal(opts.confirm, false);
  assert.throws(() => resolveOptions({ sort: 'color' }, {}));

  // --min sets every kind, per-kind flags still win
  const min = resolveOptions({ minFolderSize: '5GB' }, { min: '2MB', minFile: '3MB' });
  assert.deepEqual([min.minJunkBytes, min.minFolderBytes, min.minFileBytes], [2 * MB, 2 * MB, 3 * MB]);

  // --only, --tree
  const only = resolveOptions({}, { only: ['files', 'junk'], tree: true });
  assert.deepEqual([...only.kinds].sort(), ['file', 'junk']);
  assert.equal(only.view, 'tree');
  assert.throws(() => resolveOptions({}, { only: ['photos'] }), /Unknown kind/);
});

test('0.1 option names keep working', () => {
  const opts = resolveOptions({ minDirSize: '7MB', scanFiles: false }, {});
  assert.equal(opts.minJunkBytes, 7 * 1024 ** 2);
  assert.ok(!opts.kinds.has('file'));
  assert.equal(resolveOptions({}, { minDir: '3MB' }).minJunkBytes, 3 * 1024 ** 2);
  assert.ok(!resolveOptions({}, { files: false }).kinds.has('file'));
});

test('loadConfig tolerates a missing file but not broken JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'junkkill-cfg-'));
  assert.deepEqual(loadConfig(path.join(dir, 'nope.json')), {});
  assert.throws(() => loadConfig(path.join(dir, 'nope.json'), { required: true }));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ nope');
  assert.throws(() => loadConfig(path.join(dir, 'bad.json')), /Invalid JSON/);
});

test('parseArgs reads positional folder, flags and lists', () => {
  const a = parseArgs(['~/code', '--min-folder=5GB', '--only', 'junk,file', '-t', 'node_modules, .venv', '--no-files', '-y', '--tree']);
  assert.equal(a.dir, '~/code');
  assert.equal(a.minFolder, '5GB');
  assert.deepEqual(a.only, ['junk', 'file']);
  assert.equal(a.tree, true);
  assert.deepEqual(a.targets, ['node_modules', '.venv']);
  assert.equal(a.files, false);
  assert.equal(a.yes, true);
  assert.throws(() => parseArgs(['--bogus']));
  assert.throws(() => parseArgs(['--min-dir']));
});

test('scanner finds targets, respects sibling markers, excludes and size limits', async () => {
  const root = tree({
    'web/package.json': 10,
    'web/node_modules/a/index.js': 8 * KB,
    'web/node_modules/b/deep/x.js': 8 * KB,
    'web/dist/bundle.js': 8 * KB,
    'crate/Cargo.toml': 10,
    'crate/target/debug/app': 16 * KB,
    'notes/target/keep.txt': 16 * KB, // no Cargo.toml: not junk
    'py/.venv/lib/site.py': 4 * KB,
    'py/src/__pycache__/m.pyc': 4 * KB,
    'media/movie.mp4': 128 * KB,
    'media/small.mp4': 1 * KB,
    'repo/.git/node_modules/x.js': 8 * KB, // inside excluded folder
    'web/node_modules/big.zip': 256 * KB // inside a target: counted, not listed separately
  });

  const items = await scan(root);
  assert.deepEqual(items.map((i) => `${i.type}:${i.rel.split(path.sep).join('/')}:${i.group}`), [
    'dir:crate/target:rust',
    'file:media/movie.mp4:video',
    'dir:py/.venv:python',
    'dir:py/src/__pycache__:python',
    'dir:web/dist:build',
    'dir:web/node_modules:node'
  ]);
  const nm = items.find((i) => i.name === 'node_modules');
  assert.ok(nm.size >= 272 * KB);
  assert.ok(items.find((i) => i.name === 'dist').risky);

  const filtered = await scan(root, { minJunkBytes: 20 * KB, kinds: ['junk'] });
  assert.deepEqual(filtered.map((i) => i.name), ['node_modules']);
  assert.equal(filtered.scanner.tree, null); // junk-only scans skip the size tree
});

test('large folders: deepest folders holding data not already listed', async () => {
  const root = tree({
    'photos/2023/a.raw': 40 * KB,
    'photos/2023/b.raw': 40 * KB,
    'photos/2024/a.raw': 40 * KB,
    'photos/2024/b.raw': 40 * KB,
    'docs/notes.txt': 4 * KB,
    'videos/big.mp4': 128 * KB, // listed as a file, so videos/ isn't also a large folder
    'app/package.json': 10,
    'app/node_modules/x.js': 100 * KB // listed as junk, so app/ isn't a large folder
  });
  const items = await scan(root, { kinds: ['junk', 'folder', 'file'] });
  const label = (i) => `${i.kind}:${i.rel.split(path.sep).join('/')}`;
  assert.deepEqual(items.map(label), [
    'junk:app/node_modules',
    'folder:photos/2023',
    'folder:photos/2024',
    'file:videos/big.mp4'
  ]);
  assert.ok(items.find((i) => i.kind === 'folder').risky);

  // Size tree: totals roll up, junk counts toward its parent.
  const t = items.scanner.tree;
  const photos = t.kids.find((k) => k.name === 'photos');
  const app = t.kids.find((k) => k.name === 'app');
  assert.equal(photos.total, photos.kids.reduce((s, k) => s + k.total, 0));
  assert.ok(app.total >= 100 * KB);
  assert.equal(t.total, t.kids.reduce((s, k) => s + k.total, 0) + t.own);

  // Deleting updates every parent total and reports the bytes freed.
  const before = t.total;
  const y2023 = photos.kids.find((k) => k.name === '2023');
  const freed = markDeleted(y2023);
  assert.equal(t.total, before - freed);
  assert.equal(photos.total, photos.kids.find((k) => k.name === '2024').total);
});

test('tree view keeps the biggest files per folder and sums the rest', async () => {
  const spec = {};
  for (let i = 0; i < 20; i += 1) spec[`many/f${String(i).padStart(2, '0')}.bin`] = (i + 1) * KB;
  const root = tree(spec);
  const items = await scan(root, { kinds: ['folder'], tree: true, minFolderBytes: Infinity });
  assert.equal(items.length, 0);
  const many = items.scanner.tree.kids[0];
  assert.equal(many.files.length + many.restCount, 20);
  assert.ok(many.files.length <= 15);
  const kept = many.files.reduce((s, f) => s + f.size, 0);
  assert.equal(kept + many.restBytes, many.total);
  assert.ok(Math.min(...many.files.map((f) => f.size)) >= many.restBytes / many.restCount);
});

test('scanner skips symlinks', async (t) => {
  const root = tree({ 'real/node_modules/x.js': 4 * KB });
  try {
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
  } catch {
    t.skip('symlinks not supported here');
    return;
  }
  const items = await scan(root);
  assert.equal(items.length, 1);
  assert.equal(items[0].rel, path.join('real', 'node_modules'));
});

test('removeItem deletes inside root and refuses everything else', async () => {
  const root = tree({ 'app/node_modules/x.js': 10, 'outside/file': 10 });
  const inner = path.join(root, 'app');
  const nm = { type: 'dir', path: path.join(inner, 'node_modules') };

  await removeItem(nm, inner, { dryRun: true });
  assert.ok(fs.existsSync(nm.path));
  await removeItem(nm, inner);
  assert.ok(!fs.existsSync(nm.path));

  await assert.rejects(removeItem({ type: 'dir', path: inner }, inner), /outside/);
  await assert.rejects(removeItem({ type: 'file', path: path.join(root, 'outside/file') }, inner), /outside/);
  await assert.rejects(removeItem({ type: 'dir', path: path.join(inner, 'gone') }, inner), /no longer exists/);
});

test('formatting helpers', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(150 * 1024 ** 2), '150 MB');
  assert.equal(truncateLeft('a/b/node_modules', 10), '…e_modules');
  assert.equal(fileKind('model.SAFETENSORS'), 'model');
  assert.equal(fileKind('README'), 'file');
});
