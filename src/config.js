import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, DEFAULT_EXCLUDE, DEFAULT_TARGETS } from './defaults.js';

export const APP = 'junkkill';

export function configPath() {
  if (process.env.JUNKKILL_CONFIG) return path.resolve(process.env.JUNKKILL_CONFIG);
  const base = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, APP, 'config.json');
}

const UNITS = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 };

/** "500MB" | "1.5 GB" | "0" | 250 (number = MB) -> bytes */
export function parseSize(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value * UNITS.mb);
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(String(value));
  const unit = m ? (m[2] ? UNITS[m[2].toLowerCase()] : UNITS.mb) : undefined;
  if (!unit) throw new Error(`Invalid size "${value}". Use something like 10MB, 1.5GB or 500KB.`);
  return Math.round(Number(m[1]) * unit);
}

/** Reads the config file. A missing file is fine unless it was asked for explicitly. */
export function loadConfig(file, { required = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && !required) return {};
    throw new Error(`Cannot read config ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config ${file} must contain a JSON object`);
  }
  return parsed;
}

export function writeStarterConfig(file) {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
  return true;
}

const asList = (value, key) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Config "${key}" must be an array`);
  return value;
};

/**
 * User targets go first so they win over built-ins with the same name.
 * "!name" removes a built-in target, a plain string adds one, an object
 * ({ name, when, group, risky }) adds one with options.
 */
export function mergeTargets(defaults, user) {
  const removed = new Set();
  const added = [];
  for (const entry of asList(user, 'targets')) {
    if (typeof entry === 'string' && entry.startsWith('!')) {
      removed.add(entry.slice(1));
    } else if (typeof entry === 'string' && entry) {
      added.push({ name: entry, group: 'custom' });
    } else if (entry && typeof entry === 'object' && typeof entry.name === 'string' && entry.name) {
      added.push({ group: 'custom', ...entry, when: entry.when ? asList(entry.when, 'targets[].when') : undefined });
    } else {
      throw new Error(`Invalid target ${JSON.stringify(entry)}`);
    }
  }
  return [...added, ...defaults].filter((t) => !removed.has(t.name));
}

/** Same rules as targets, for plain name lists. */
export function mergeNames(defaults, user) {
  const list = asList(user, 'exclude');
  for (const n of list) if (typeof n !== 'string' || !n) throw new Error(`Invalid exclude entry ${JSON.stringify(n)}`);
  const removed = new Set(list.filter((n) => n.startsWith('!')).map((n) => n.slice(1)));
  const added = list.filter((n) => !n.startsWith('!'));
  return [...new Set([...defaults, ...added])].filter((n) => !removed.has(n));
}

const SORTS = ['size', 'age', 'path'];
const VIEWS = ['list', 'tree'];
const KIND_ALIASES = { junk: 'junk', folder: 'folder', folders: 'folder', file: 'file', files: 'file' };

export function parseKinds(list) {
  const kinds = new Set();
  for (const k of asList(list, 'show')) {
    const kind = KIND_ALIASES[String(k).toLowerCase()];
    if (!kind) throw new Error(`Unknown kind "${k}". Use junk, folder or file.`);
    kinds.add(kind);
  }
  if (kinds.size === 0) throw new Error('Show at least one of: junk, folder, file');
  return kinds;
}

/** Combines built-in defaults, the config file and CLI flags (in that order). */
export function resolveOptions(config, args) {
  const pick = (cli, key) => cli ?? config[key] ?? DEFAULTS[key];

  let targets;
  if (args.targets) {
    // --targets narrows the search to exactly these names, reusing built-in rules when known.
    targets = args.targets.flatMap((name) => {
      const known = DEFAULT_TARGETS.filter((t) => t.name === name);
      return known.length ? known : [{ name, group: 'custom' }];
    });
  } else {
    targets = mergeTargets(DEFAULT_TARGETS, config.targets);
  }

  const sort = pick(args.sort, 'sort');
  if (!SORTS.includes(sort)) throw new Error(`Sort must be one of: ${SORTS.join(', ')}`);

  const threads = config.threads === undefined ? undefined : Number(config.threads);
  if (threads !== undefined && (!Number.isInteger(threads) || threads < 1)) {
    throw new Error('"threads" must be a positive integer');
  }

  const view = args.tree ? 'tree' : pick(undefined, 'view');
  if (!VIEWS.includes(view)) throw new Error(`View must be one of: ${VIEWS.join(', ')}`);

  // --only beats the config's "show". --no-files and "scanFiles": false are kept from 0.1.
  const kinds = parseKinds(args.only ?? config.show ?? DEFAULTS.show);
  if (args.files === false || (!args.only && config.scanFiles === false)) kinds.delete('file');
  if (kinds.size === 0) throw new Error('Nothing left to show');

  // Per-kind flag > --min > config > default. --min-dir / "minDirSize" are 0.1 names for junk.
  const size = (cli, ...keys) => {
    const fromConfig = keys.map((k) => config[k]).find((v) => v !== undefined);
    return parseSize(cli ?? args.min ?? fromConfig ?? DEFAULTS[keys[0]]);
  };

  return {
    minJunkBytes: size(args.minJunk ?? args.minDir, 'minJunkSize', 'minDirSize'),
    minFolderBytes: size(args.minFolder, 'minFolderSize'),
    minFileBytes: size(args.minFile, 'minFileSize'),
    kinds,
    view,
    confirm: args.yes ? false : Boolean(config.confirm ?? DEFAULTS.confirm),
    sort,
    threads,
    targets,
    exclude: [...mergeNames(DEFAULT_EXCLUDE, config.exclude), ...(args.exclude ?? [])]
  };
}
