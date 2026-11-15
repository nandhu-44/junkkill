import fs from 'node:fs';
import path from 'node:path';
import { APP, configPath, loadConfig, resolveOptions, writeStarterConfig } from './config.js';
import { DEFAULT_EXCLUDE_PATHS } from './defaults.js';
import { c, formatAge, formatBytes, formatCount, padEnd, padStart, setColor, tildify } from './format.js';
import { Scanner } from './scanner.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const FLAGS = {
  '-d': 'dir', '--dir': 'dir',
  '--min': 'min',
  '--min-junk': 'minJunk',
  '--min-folder': 'minFolder',
  '--min-file': 'minFile',
  '--min-dir': 'minDir', // 0.1 name for --min-junk
  '--only': 'only',
  '-t': 'targets', '--targets': 'targets',
  '-e': 'exclude', '--exclude': 'exclude',
  '-s': 'sort', '--sort': 'sort',
  '--config': 'config'
};
const LIST_FLAGS = new Set(['targets', 'exclude', 'only']);

const SWITCHES = {
  '--tree': ['tree', true],
  '--no-files': ['files', false], // 0.1 name for --only junk,folder
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
      args[key] = LIST_FLAGS.has(key) ? csv(value) : value;
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
 Find what's eating your disk (junk folders, large folders, large files) and delete it.

${h('Usage')}
  ${APP} [folder] [options]

${h('What gets listed')}
  ${c.cyan('junk')}     known regenerable folders: node_modules, .venv, target, caches…
  ${c.cyan('folder')}   other folders holding lots of data, marked ${c.yellow('!')} since it's your data
  ${c.cyan('file')}     single large files

${h('Options')}
${o('--min <size>', 'Same size limit for all three kinds')}
${o('--min-junk <size>', 'Smallest junk folder to list (default: 10MB)')}
${o('--min-folder <size>', 'Smallest regular folder to list (default: 1GB)')}
${o('--min-file <size>', 'Smallest file to list (default: 100MB)')}
${o('--only <kinds>', 'List only these kinds, e.g. --only junk or --only folder,file')}
${o('--tree', 'Start in tree view: browse every folder by size')}
${o('-d, --dir <path>', 'Folder to scan (default: current folder)')}
${o('-t, --targets <list>', 'Only look for these junk folder names, comma separated')}
${o('-e, --exclude <list>', 'Extra folder names to skip, comma separated')}
${o('-s, --sort <key>', 'size | age | path (default: size)')}
${o('--dry-run', 'Go through the motions without deleting anything')}
${o('-y, --yes', 'Delete without asking for confirmation')}
${o('--list', 'Print results and exit (with --tree: print the top level)')}
${o('--json', 'Print results as JSON and exit')}
${o('--config <file>', 'Use a different config file')}
${o('--init', 'Create the config file with default values')}
${o('--no-color', 'Disable colors')}
${o('-v, --version', 'Print version')}

${h('Keys')}
  ${c.dim('↑↓ / j k  move     space  select     a  select all     d / del  delete')}
  ${c.dim('v  list ↔ tree     t  kind filter    s  sort           /  filter     q  quit')}
  ${c.dim('list view: enter deletes     tree view: enter / → opens a folder, ← goes back')}

${h('Config')}
  ${tildify(configPath())}
`;
}

const SORTERS = {
  size: (a, b) => b.size - a.size,
  age: (a, b) => a.mtime - b.mtime,
  path: (a, b) => (a.rel ?? a.name).localeCompare(b.rel ?? b.name)
};

function typeLabel(i) {
  const label = i.risky ? `${i.group} !` : i.group;
  return label;
}

/** Non-interactive mode: scan to completion, then print. */
async function printResults(scanner, { json, sort, tree }) {
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
  if (scanner.error) throw new Error(`scan failed: ${scanner.error.message}`);
  items.sort(SORTERS[sort]);

  const top = scanner.tree
    ? [...scanner.tree.kids, ...scanner.tree.files].sort(SORTERS[sort === 'path' ? 'path' : 'size'])
    : [];

  if (json) {
    const out = {
      root: scanner.root,
      items: items.map((i) => ({
        kind: i.kind, type: i.type, path: i.path, rel: i.rel, group: i.group,
        risky: i.risky, size: i.size, modified: i.mtime ? new Date(i.mtime).toISOString() : null
      }))
    };
    if (scanner.tree) {
      out.total = scanner.tree.total;
      out.tree = top.map((e) => ({ name: e.name, type: e.type, path: e.path, size: e.size }));
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  const secs = ((stats.endedAt - stats.startedAt) / 1000).toFixed(1);
  const footer = c.dim(`· ${formatCount(stats.dirs)} folders scanned in ${secs}s`);

  if (tree) {
    if (!scanner.tree) throw new Error('--tree needs file sizes; drop --only junk');
    const total = scanner.tree.total || 1;
    for (const e of top) {
      const pct = padStart(`${((e.size / total) * 100).toFixed(1)}%`, 6);
      const name = e.type === 'dir' ? c.bold(`${e.name}/`) : e.name;
      console.log(`${c.yellow(padStart(formatBytes(e.size), 10))}  ${c.dim(pct)}  ${name}`);
    }
    if (scanner.tree.restCount) {
      console.log(`${c.yellow(padStart(formatBytes(scanner.tree.restBytes), 10))}  ${c.dim(padStart(`${((scanner.tree.restBytes / total) * 100).toFixed(1)}%`, 6))}  ${c.dim(`${scanner.tree.restCount} smaller files`)}`);
    }
    console.log(`\n${c.bold(formatBytes(scanner.tree.total))} in ${tildify(scanner.root)} ${footer}`);
    return;
  }

  if (items.length === 0) {
    console.log(c.dim('Nothing above the size limits here.'));
    return;
  }
  for (const i of items) {
    const type = padEnd(typeLabel(i), 11);
    console.log(`${c.yellow(padStart(formatBytes(i.size), 10))}  ${c.dim(padStart(formatAge(i.mtime), 9))}  ${i.risky ? c.yellow(type) : c.cyan(type)}  ${i.rel}`);
  }
  const s = items.length === 1 ? '' : 's';
  console.log(`\n${items.length} item${s} ${footer}`);
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
    kinds: options.kinds,
    tree: options.view === 'tree',
    targets: options.targets,
    exclude: options.exclude,
    excludePaths: DEFAULT_EXCLUDE_PATHS,
    minJunkBytes: options.minJunkBytes,
    minFolderBytes: options.minFolderBytes,
    minFileBytes: options.minFileBytes,
    threads: options.threads
  });

  const interactive = process.stdin.isTTY && process.stdout.isTTY && !args.list && !args.json;
  if (!interactive) {
    return printResults(scanner, { json: args.json, sort: options.sort, tree: options.view === 'tree' });
  }

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
