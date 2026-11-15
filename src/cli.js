import fs from 'node:fs';
import path from 'node:path';
import { APP, configPath, loadConfig, resolveOptions, writeStarterConfig } from './config.js';
import { DEFAULT_EXCLUDE_PATHS } from './defaults.js';
import { c, formatAge, formatBytes, formatCount, padEnd, padStart, setColor, tildify } from './format.js';
import { Scanner } from './scanner.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const FLAGS = {
  '-d': 'dir', '--dir': 'dir',
  '--min-dir': 'minDir',
  '--min-file': 'minFile',
  '-t': 'targets', '--targets': 'targets',
  '-e': 'exclude', '--exclude': 'exclude',
  '-s': 'sort', '--sort': 'sort',
  '--config': 'config'
};

const SWITCHES = {
  '--no-files': ['files', false],
  '--files': ['files', true],
  '--dry-run': ['dryRun', true],
  '-y': ['yes', true], '--yes': ['yes', true],
  '--list': ['list', true],
  '--json': ['json', true],
  '--init': ['init', true],
  '--no-color': ['color', false],
  '-v': ['version', true], '--version': ['version', true],
  '-h': ['help', true], '--help': ['help', true]
};

const csv = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    let token = argv[i];
    let inline;
    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq > 0) {
      inline = token.slice(eq + 1);
      token = token.slice(0, eq);
    }

    if (SWITCHES[token]) {
      const [key, value] = SWITCHES[token];
      args[key] = value;
    } else if (FLAGS[token]) {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith('-') && value !== '-')) {
        throw new Error(`Missing value for ${token}`);
      }
      const key = FLAGS[token];
      args[key] = key === 'targets' || key === 'exclude' ? csv(value) : value;
    } else if (!token.startsWith('-') && args.dir === undefined) {
      args.dir = token;
    } else {
      throw new Error(`Unknown option ${token}. Run ${APP} --help`);
    }
  }
  return args;
}

function help() {
  const h = (s) => c.bold(s);
  const o = (flag, desc) => `  ${c.cyan(padEnd(flag, 22))} ${desc}`;
  return `
 ${c.badge(` ${APP} `)} ${c.dim(`v${pkg.version}`)}
 Find heavy dev junk (node_modules, venvs, build output, caches, huge files) and delete it.

${h('Usage')}
  ${APP} [folder] [options]

${h('Options')}
${o('-d, --dir <path>', 'Folder to scan (default: current folder)')}
${o('--min-dir <size>', 'Hide junk folders smaller than this (default: 10MB)')}
${o('--min-file <size>', 'Report loose files larger than this (default: 100MB)')}
${o('--no-files', 'Only look for junk folders, skip large files')}
${o('-t, --targets <list>', 'Only look for these folder names, comma separated')}
${o('-e, --exclude <list>', 'Extra folder names to skip, comma separated')}
${o('-s, --sort <key>', 'size | age | path (default: size)')}
${o('--dry-run', 'Go through the motions without deleting anything')}
${o('-y, --yes', 'Delete without asking for confirmation')}
${o('--list', 'Print results as a table and exit')}
${o('--json', 'Print results as JSON and exit')}
${o('--config <file>', 'Use a different config file')}
${o('--init', 'Create the config file with default values')}
${o('--no-color', 'Disable colors')}
${o('-v, --version', 'Print version')}

${h('Keys')}
  ${c.dim('↑↓ / j k  move     space  select     a  select all     enter  delete')}
  ${c.dim('s  sort     /  filter     esc  clear     q  quit')}

${h('Config')}
  ${tildify(configPath())}
`;
}

/** Non-interactive mode: scan to completion, then print. */
async function printResults(scanner, { json, sort }) {
  const items = [];
  scanner.on('item', (i) => items.push(i));

  const showProgress = process.stderr.isTTY && !json;
  const tick = showProgress
    ? setInterval(() => process.stderr.write(`\r${c.dim(`scanning · ${formatCount(scanner.stats.dirs)} folders · ${items.length} found`)}\x1b[K`), 100)
    : null;
  const stats = await scanner.start();
  if (tick) {
    clearInterval(tick);
    process.stderr.write('\r\x1b[K');
  }

  const sorters = {
    size: (a, b) => b.size - a.size,
    age: (a, b) => a.mtime - b.mtime,
    path: (a, b) => a.rel.localeCompare(b.rel)
  };
  items.sort(sorters[sort]);
  const total = items.reduce((s, i) => s + i.size, 0);

  if (json) {
    const rows = items.map(({ type, path: p, rel, group, risky, size, mtime }) => ({
      type, path: p, rel, group, risky, size, modified: new Date(mtime).toISOString()
    }));
    process.stdout.write(`${JSON.stringify({ root: scanner.root, total, count: rows.length, items: rows }, null, 2)}\n`);
    return;
  }

  if (items.length === 0) {
    console.log(c.dim('Nothing above the size limits here.'));
    return;
  }
  for (const i of items) {
    const size = padStart(formatBytes(i.size), 10);
    const type = padEnd(i.risky ? `${i.group} !` : i.group, 11);
    console.log(`${c.yellow(size)}  ${c.dim(padStart(formatAge(i.mtime), 9))}  ${i.risky ? c.yellow(type) : c.cyan(type)}  ${i.rel}`);
  }
  const secs = ((stats.endedAt - stats.startedAt) / 1000).toFixed(1);
  console.log(`\n${c.bold(formatBytes(total))} in ${items.length} item${items.length === 1 ? '' : 's'} ${c.dim(`· ${formatCount(stats.dirs)} folders scanned in ${secs}s`)}`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  setColor(args.color !== false && !process.env.NO_COLOR && Boolean(process.stdout.isTTY) && !args.json);

  if (args.help) return void process.stdout.write(help());
  if (args.version) return void console.log(pkg.version);

  const cfgFile = args.config ? path.resolve(args.config) : configPath();
  if (args.init) {
    const created = writeStarterConfig(cfgFile);
    console.log(created ? `Created ${tildify(cfgFile)}` : `Config already exists: ${tildify(cfgFile)}`);
    return;
  }

  const options = resolveOptions(loadConfig(cfgFile, { required: Boolean(args.config) }), args);

  const root = path.resolve(args.dir ?? process.cwd());
  const st = fs.statSync(root, { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new Error(`Not a folder: ${root}`);

  const scanner = new Scanner({
    root,
    targets: options.targets,
    exclude: options.exclude,
    excludePaths: DEFAULT_EXCLUDE_PATHS,
    minDirBytes: options.minDirBytes,
    minFileBytes: options.minFileBytes,
    scanFiles: options.scanFiles,
    threads: options.threads
  });

  const interactive = process.stdin.isTTY && process.stdout.isTTY && !args.list && !args.json;
  if (!interactive) return printResults(scanner, { json: args.json, sort: options.sort });

  const { runUI } = await import('./ui.js');
  const { freed, deleted } = await runUI({
    scanner, root, options, name: APP, version: pkg.version, dryRun: Boolean(args.dryRun)
  });
  if (deleted > 0) {
    const verb = args.dryRun ? 'Would free' : 'Freed';
    console.log(`${c.green('✓')} ${verb} ${c.bold(formatBytes(freed))} from ${deleted} item${deleted === 1 ? '' : 's'}.`);
  }
  process.exit(0);
}
