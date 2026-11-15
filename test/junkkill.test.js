import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeTargets, mergeNames, parseSize, resolveOptions, loadConfig } from '../src/config.js';
import { DEFAULT_TARGETS, DEFAULT_EXCLUDE, fileKind } from '../src/defaults.js';
import { parseArgs } from '../src/cli.js';
import { Scanner } from '../src/scanner.js';
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
    root, targets: DEFAULT_TARGETS, exclude: DEFAULT_EXCLUDE,
    minDirBytes: 0, minFileBytes: 64 * KB, threads: 2, ...overrides
  });
  const items = [];
  s.on('item', (i) => items.push(i));
  await s.start();
  return items.sort((a, b) => a.rel.localeCompare(b.rel));
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
  const opts = resolveOptions({ minDirSize: '50MB', sort: 'age' }, { minDir: '1MB', yes: true });
  assert.equal(opts.minDirBytes, 1024 ** 2);
  assert.equal(opts.minFileBytes, 100 * 1024 ** 2);
  assert.equal(opts.sort, 'age');
  assert.equal(opts.confirm, false);
  assert.throws(() => resolveOptions({ sort: 'color' }, {}));
});

test('loadConfig tolerates a missing file but not broken JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'junkkill-cfg-'));
  assert.deepEqual(loadConfig(path.join(dir, 'nope.json')), {});
  assert.throws(() => loadConfig(path.join(dir, 'nope.json'), { required: true }));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ nope');
  assert.throws(() => loadConfig(path.join(dir, 'bad.json')), /Invalid JSON/);
});

test('parseArgs reads positional folder, flags and lists', () => {
  const a = parseArgs(['~/code', '--min-dir=5MB', '-t', 'node_modules, .venv', '--no-files', '-y']);
  assert.equal(a.dir, '~/code');
  assert.equal(a.minDir, '5MB');
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

  const filtered = await scan(root, { minDirBytes: 20 * KB, scanFiles: false });
  assert.deepEqual(filtered.map((i) => i.name), ['node_modules']);
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
