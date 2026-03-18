#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ANSI_ENABLED = Boolean(output.isTTY && !process.env.NO_COLOR);
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

const DEFAULT_TARGET_DIRS = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.cache',
  '.next',
  'dist',
  'build',
  'coverage',
  '.ipynb_checkpoints',
  'data',
  'dataset',
  'datasets'
];

const DEFAULT_EXCLUDE_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'System Volume Information',
  '$Recycle.Bin'
]);

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    minDirMb: 100,
    minFileMb: 100,
    includeFiles: true,
    targets: [...DEFAULT_TARGET_DIRS],
    exclude: [...DEFAULT_EXCLUDE_DIRS],
    dryRun: false,
    yes: false,
    json: false,
    maxResults: 1000
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    } else if (token === '--root' || token === '-d') {
      if (!next) throw new Error('Missing value for --root');
      args.root = path.resolve(next);
      i += 1;
    } else if (token === '--min-dir-mb') {
      if (!next) throw new Error('Missing value for --min-dir-mb');
      args.minDirMb = Number(next);
      i += 1;
    } else if (token === '--min-file-mb') {
      if (!next) throw new Error('Missing value for --min-file-mb');
      args.minFileMb = Number(next);
      i += 1;
    } else if (token === '--no-files') {
      args.includeFiles = false;
    } else if (token === '--targets') {
      if (!next) throw new Error('Missing value for --targets');
      args.targets = splitCsv(next);
      i += 1;
    } else if (token === '--exclude') {
      if (!next) throw new Error('Missing value for --exclude');
      args.exclude = splitCsv(next);
      i += 1;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token === '--yes' || token === '-y') {
      args.yes = true;
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--max-results') {
      if (!next) throw new Error('Missing value for --max-results');
      args.maxResults = Number(next);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!Number.isFinite(args.minDirMb) || args.minDirMb < 0) {
    throw new Error('--min-dir-mb must be a non-negative number');
  }
  if (!Number.isFinite(args.minFileMb) || args.minFileMb < 0) {
    throw new Error('--min-file-mb must be a non-negative number');
  }
  if (!Number.isFinite(args.maxResults) || args.maxResults < 1) {
    throw new Error('--max-results must be >= 1');
  }

  return args;
}

function splitCsv(value) {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function printHelp() {
  console.log(`junkkill - safe npkill-like cleaner\n
Usage:
  node junkkill.js [options]
  npx . [options]   (from this folder)

Options:
  -d, --root <path>        Root directory to scan (default: current directory)
  --min-dir-mb <n>         Minimum size for target directories (default: 100)
  --min-file-mb <n>        Minimum size for large files (default: 100)
  --targets <csv>          Comma-separated target directory names
  --exclude <csv>          Comma-separated directory names to skip while scanning
  --no-files               Disable large file scanning
  --max-results <n>        Limit number of listed results (default: 1000)
  --dry-run                Simulate deletion without removing anything
  -y, --yes                Skip the second confirmation prompt
  --json                   Print scan output as JSON and exit
  -h, --help               Show this help

Safety model:
  - Only items found during this scan can be deleted.
  - Selected paths must still exist under the scan root.
  - Root path and protected system paths are blocked.
  - No wildcard or random deletion is performed.
  - Use selection "all" to pick every listed item.
`);
}

function toBytes(mb) {
  return Math.round(mb * 1024 * 1024);
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function color(text, ...codes) {
  if (!ANSI_ENABLED || codes.length === 0) return text;
  return `${codes.join('')}${text}${ANSI.reset}`;
}

function clearTerminalScreen() {
  if (!ANSI_ENABLED) return;
  // Clear viewport + scrollback and move cursor to top-left.
  output.write('\x1b[2J\x1b[3J\x1b[H');
}

function getFileColorByExtension(extName) {
  const ext = extName.toLowerCase();

  if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'].includes(ext)) {
    return ANSI.yellow;
  }

  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.mp4', '.mkv', '.mov', '.mp3', '.wav', '.flac'].includes(ext)) {
    return ANSI.magenta;
  }

  if (['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.md'].includes(ext)) {
    return ANSI.green;
  }

  if (['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.rb', '.php', '.html', '.css', '.json', '.yml', '.yaml'].includes(ext)) {
    return ANSI.cyan;
  }

  if (['.exe', '.dll', '.so', '.dmg', '.iso', '.bin', '.msi'].includes(ext)) {
    return ANSI.red;
  }

  return ANSI.gray;
}

function colorForResultRow(row) {
  if (row.type === 'dir') {
    return {
      type: color('dir', ANSI.bold, ANSI.blue),
      target: color(row.targetName, ANSI.blue),
      path: color(row.relPath, ANSI.blue),
      size: color(formatBytes(row.size), ANSI.yellow)
    };
  }

  const extColor = getFileColorByExtension(row.targetName);
  return {
    type: color('file', ANSI.bold, ANSI.cyan),
    target: color(row.targetName, extColor),
    path: color(row.relPath, ANSI.dim),
    size: color(formatBytes(row.size), ANSI.yellow)
  };
}

function rel(from, target) {
  const r = path.relative(from, target);
  return r || '.';
}

function normalizeName(name) {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

function isNameInList(name, list) {
  const n = normalizeName(name);
  return list.some((v) => normalizeName(v) === n);
}

function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isProtectedPath(absPath) {
  const normalized = path.resolve(absPath);
  const root = path.parse(normalized).root;
  if (normalized === root) return true;

  const blocked = [
    process.env.WINDIR,
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData') : undefined
  ]
    .filter(Boolean)
    .map((p) => path.resolve(String(p)));

  return blocked.some((p) => normalized === p);
}

async function getDirectorySize(startPath) {
  let total = 0;
  const stack = [startPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          const st = await fs.stat(full);
          total += st.size;
        }
      } catch {
        continue;
      }
    }
  }

  return total;
}

async function scan(root, options) {
  const minDirBytes = toBytes(options.minDirMb);
  const minFileBytes = toBytes(options.minFileMb);
  const rootResolved = path.resolve(root);

  const results = [];
  const stack = [rootResolved];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (results.length >= options.maxResults) break;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const entryName = entry.name;

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (isNameInList(entryName, options.exclude)) {
          continue;
        }

        if (isNameInList(entryName, options.targets)) {
          const size = await getDirectorySize(fullPath);
          if (size >= minDirBytes) {
            results.push({
              type: 'dir',
              targetName: entryName,
              path: fullPath,
              size,
              relPath: rel(rootResolved, fullPath),
              safeToDelete: true
            });
            if (results.length >= options.maxResults) break;
          }
          // Skip descending into matched target dirs to avoid duplicate nested hits.
          continue;
        }

        stack.push(fullPath);
      } else if (entry.isFile() && options.includeFiles) {
        let st;
        try {
          st = await fs.stat(fullPath);
        } catch {
          continue;
        }
        if (st.size >= minFileBytes) {
          results.push({
            type: 'file',
            targetName: path.extname(entryName) || '(file)',
            path: fullPath,
            size: st.size,
            relPath: rel(rootResolved, fullPath),
            safeToDelete: true
          });
          if (results.length >= options.maxResults) break;
        }
      }
    }
  }

  results.sort((a, b) => b.size - a.size);
  return { rootResolved, results };
}

function printResults(results) {
  if (results.length === 0) {
    console.log('No matching large targets/files found.');
    return;
  }

  console.log(color('Idx  Type  Size       Target        Path', ANSI.bold));
  console.log(color('---- ----  ---------- ------------ ----------------------------------------------', ANSI.gray));

  for (let i = 0; i < results.length; i += 1) {
    const row = results[i];
    const idx = String(i + 1).padStart(3, ' ');
    const typeRaw = row.type.padEnd(4, ' ');
    const sizeRaw = formatBytes(row.size).padEnd(10, ' ');
    const targetRaw = row.targetName.slice(0, 12).padEnd(12, ' ');
    const type = row.type === 'dir' ? color(typeRaw, ANSI.bold, ANSI.blue) : color(typeRaw, ANSI.bold, ANSI.cyan);
    const size = color(sizeRaw, ANSI.yellow);
    const target = row.type === 'dir'
      ? color(targetRaw, ANSI.blue)
      : color(targetRaw, getFileColorByExtension(row.targetName));
    const rowPath = row.type === 'dir' ? color(row.relPath, ANSI.blue) : color(row.relPath, ANSI.dim);
    console.log(`${color(idx, ANSI.bold)}  ${type}  ${size} ${target} ${rowPath}`);
  }
}

function parseSelection(raw, max) {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'all') {
    return Array.from({ length: max }, (_, i) => i);
  }

  const selected = new Set();
  const chunks = raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    if (chunk.includes('-')) {
      const [startRaw, endRaw] = chunk.split('-').map((x) => x.trim());
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error(`Invalid range: ${chunk}`);
      }
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      if (lo < 1 || hi > max) {
        throw new Error(`Range out of bounds: ${chunk}`);
      }
      for (let i = lo; i <= hi; i += 1) selected.add(i - 1);
    } else {
      const n = Number(chunk);
      if (!Number.isInteger(n) || n < 1 || n > max) {
        throw new Error(`Invalid index: ${chunk}`);
      }
      selected.add(n - 1);
    }
  }

  return [...selected].sort((a, b) => a - b);
}

async function deletePathSafe(entry, root, dryRun) {
  const full = path.resolve(entry.path);

  if (!isInside(root, full)) {
    return { ok: false, reason: 'outside-root' };
  }
  if (full === root) {
    return { ok: false, reason: 'is-root' };
  }
  if (isProtectedPath(full)) {
    return { ok: false, reason: 'protected-path' };
  }

  let st;
  try {
    st = await fs.lstat(full);
  } catch {
    return { ok: false, reason: 'not-found' };
  }

  if (st.isSymbolicLink()) {
    return { ok: false, reason: 'symlink-blocked' };
  }

  if (dryRun) {
    return { ok: true, reason: 'dry-run' };
  }

  try {
    if (st.isDirectory()) {
      await fs.rm(full, { recursive: true, force: false });
    } else {
      await fs.rm(full, { force: false });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'delete-failed' };
  }
}

async function interactiveDelete(scanOutput, args) {
  const { rootResolved, results } = scanOutput;

  printResults(results);
  if (results.length === 0) return;

  const rl = readline.createInterface({ input, output });

  try {
    const selectRaw = await rl.question(
      '\nSelect items to delete by index (e.g., 1,4-7), "all", or empty to quit: '
    );

    if (!selectRaw.trim()) {
      console.log('No selection. Exiting without deleting.');
      return;
    }

    const indexes = parseSelection(selectRaw, results.length);
    const picked = indexes.map((i) => results[i]);

    clearTerminalScreen();
    const total = picked.reduce((sum, item) => sum + item.size, 0);
    console.log(color('Review selection', ANSI.bold, ANSI.cyan));
    console.log(color('----------------', ANSI.gray));
    console.log(`\nSelected ${picked.length} item(s), potential reclaim: ${color(formatBytes(total), ANSI.bold, ANSI.green)}`);
    for (const item of picked) {
      const row = colorForResultRow(item);
      const selectedType = item.type === 'dir'
        ? color('DIR', ANSI.bold, ANSI.blue)
        : color('FILE', ANSI.bold, ANSI.cyan);
      console.log(` - ${selectedType} ${row.path} (${row.size})`);
    }

    const confirm1 = await rl.question(
      `\n${color('Type', ANSI.bold, ANSI.gray)} ${color('DELETE', ANSI.bold, ANSI.red)} ${color('to continue:', ANSI.bold, ANSI.gray)} `
    );
    if (confirm1.trim().toLowerCase() !== 'delete') {
      console.log(color('Cancelled. Nothing deleted.', ANSI.bold, ANSI.red));
      return;
    }

    if (!args.yes) {
      const confirm2 = await rl.question(
        `${color('Final confirm', ANSI.bold, ANSI.gray)} ${color('(y/n):', ANSI.bold, ANSI.cyan)} `
      );
      if (!['y', 'yes'].includes(confirm2.trim().toLowerCase())) {
        console.log(color('Cancelled. Nothing deleted.', ANSI.bold, ANSI.red));
        return;
      }
    }

    clearTerminalScreen();
    console.log(color('Deletion progress', ANSI.bold, ANSI.cyan));
    console.log(color('-----------------', ANSI.gray));
    console.log(args.dryRun ? '\nDry-run enabled. Simulating deletion...' : '\nDeleting selected items...');

    let deleted = 0;
    let skipped = 0;

    for (const item of picked) {
      const res = await deletePathSafe(item, rootResolved, args.dryRun);
      if (res.ok) {
        deleted += 1;
        console.log(` ${color('[OK]', ANSI.bold, ANSI.green)} ${color(item.relPath, ANSI.dim)}${args.dryRun ? color(' (dry-run)', ANSI.yellow) : ''}`);
      } else {
        skipped += 1;
        console.log(` ${color('[SKIP]', ANSI.bold, ANSI.red)} ${color(item.relPath, ANSI.dim)} (${color(String(res.reason), ANSI.red)})`);
      }
    }

    console.log(`\nDone. deleted=${deleted}, skipped=${skipped}, total-selected=${picked.length}`);
  } finally {
    rl.close();
  }
}

async function main() {
  clearTerminalScreen();
  try {
    const args = parseArgs(process.argv);
    const rootStat = await fs.stat(args.root);
    if (!rootStat.isDirectory()) {
      throw new Error(`Root is not a directory: ${args.root}`);
    }

    const scanOutput = await scan(args.root, args);

    if (args.json) {
      output.write(
        `${JSON.stringify(
          {
            root: scanOutput.rootResolved,
            count: scanOutput.results.length,
            results: scanOutput.results
          },
          null,
          2
        )}\n`
      );
      return;
    }
    if(args.dryRun) console.log(color('\nDry-run mode: no actual deletions will be performed.', ANSI.bold, ANSI.yellow));

    console.log(`\n${color('Scan root:', ANSI.bold, ANSI.blue)} ${color(scanOutput.rootResolved, ANSI.dim)}`);
    console.log(`${color('Thresholds:', ANSI.bold, ANSI.blue)} dirs >= ${color(`${args.minDirMb}MB`, ANSI.yellow)}, files >= ${color(`${args.minFileMb}MB`, ANSI.yellow)}`);
    console.log(`${color('Exclude:', ANSI.bold, ANSI.blue)} ${color(args.exclude.join(', '), ANSI.gray)}`);
    console.log(`${color('Targets:', ANSI.bold, ANSI.blue)} ${color(args.targets.join(', '), ANSI.green)}\n`);

    await interactiveDelete(scanOutput, args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

main();
