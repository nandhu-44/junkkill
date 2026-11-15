import path from 'node:path';
import readline from 'node:readline';
import {
  c, clip, colorEnabled, formatAge, formatBytes, formatCount, padEnd, padStart, tildify, truncateLeft, visibleLength
} from './format.js';
import { removeItem } from './remove.js';
import { isGone, isInside, markDeleted } from './tree.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const SORT_ORDER = ['size', 'age', 'path'];
const KIND_ORDER = ['all', 'junk', 'folder', 'file'];
const KIND_LABEL = { all: 'everything', junk: 'junk folders', folder: 'large folders', file: 'large files' };

const SORTERS = {
  size: (a, b) => b.size - a.size,
  age: (a, b) => a.mtime - b.mtime, // oldest first
  path: (a, b) => (a.rel ?? a.name).localeCompare(b.rel ?? b.name)
};
const TREE_SORTERS = { ...SORTERS, path: (a, b) => a.name.localeCompare(b.name) };

const W_TYPE = 11;
const W_AGE = 11;
const W_SIZE = 11;
const W_BAR = 12;
const W_PCT = 7;
const PREFIX = 4; // gutter + cursor + mark + space
const HEADER_LINES = 5;
const FOOTER_LINES = 2;

const sizeColor = (bytes) => (bytes >= 1024 ** 3 ? c.red : bytes >= 100 * 1024 ** 2 ? c.yellow : c.green);
const isLive = (e) => !e.pseudo && e.status !== 'deleted' && e.status !== 'deleting';
const sortKey = (p) => p.split(path.sep).join('\0'); // parents sort right before their children

function bar(fraction, width) {
  const units = Math.round(Math.max(0, Math.min(1, fraction)) * width * 8);
  const full = Math.floor(units / 8);
  const part = BLOCKS[units % 8];
  return '█'.repeat(full) + part + ' '.repeat(width - full - (part ? 1 : 0));
}

/** Drops entries that sit inside another entry of the same batch. */
function outermost(entries) {
  const sorted = [...entries].sort((a, b) => (sortKey(a.path) < sortKey(b.path) ? -1 : 1));
  const kept = [];
  for (const e of sorted) {
    if (kept.length && isInside(kept[kept.length - 1].path, e.path)) continue;
    kept.push(e);
  }
  return kept;
}

/**
 * Full-screen interactive UI with two views:
 *   list  every listed junk folder, large folder and large file
 *   tree  browse folders by size, like a disk analyzer
 * Resolves with { freed, deleted } once the user quits.
 */
export function runUI({ scanner, root, options, name, version, dryRun }) {
  const out = process.stdout;
  const inp = process.stdin;
  const relOf = (e) => e.rel ?? path.relative(root, e.path);

  const pane = () => ({ rows: [], cursor: 0, top: 0, current: null });
  const state = {
    items: [],
    view: options.view === 'tree' && scanner.tree ? 'tree' : 'list',
    kind: 'all',
    sort: options.sort,
    filter: '',
    mode: 'list', // list | filter | confirm
    confirmItems: [],
    note: null,
    scanning: true,
    deleting: 0,
    freed: 0,
    deleted: 0,
    quitting: false,
    frame: 0,
    dirty: true,
    selected: new Set(),
    list: pane(),
    tree: { ...pane(), dir: scanner.tree }
  };

  let renderTimer = null;
  let spinTimer = null;
  let noteTimer = null;
  let resolveUI;

  const active = () => (state.view === 'list' ? state.list : state.tree);

  // --- data ---------------------------------------------------------------

  const listRows = () => {
    const q = state.filter.toLowerCase();
    return state.items
      .filter((i) => (state.kind === 'all' || i.kind === state.kind) && (!q || i.rel.toLowerCase().includes(q)))
      .sort(SORTERS[state.sort]);
  };

  const treeRows = () => {
    const dir = state.tree.dir;
    if (!dir) return [];
    const q = state.filter.toLowerCase();
    const rows = [...dir.kids, ...dir.files]
      .filter((e) => !q || e.name.toLowerCase().includes(q))
      .sort(TREE_SORTERS[state.sort]);
    if (dir.restCount > 0 && !q) {
      rows.push({ pseudo: true, type: 'rest', name: `${formatCount(dir.restCount)} smaller files`, size: dir.restBytes, mtime: 0 });
    }
    return rows;
  };

  const rebuild = () => {
    const p = active();
    p.rows = state.view === 'list' ? listRows() : treeRows();
    state.dirty = false;
    const idx = p.current ? p.rows.indexOf(p.current) : -1;
    moveTo(idx >= 0 ? idx : p.cursor);
  };

  const listHeight = () => Math.max(1, (out.rows || 24) - HEADER_LINES - FOOTER_LINES);

  const moveTo = (index) => {
    const p = active();
    const n = p.rows.length;
    p.cursor = n === 0 ? 0 : Math.min(Math.max(index, 0), n - 1);
    p.current = p.rows[p.cursor] ?? null;
    const h = listHeight();
    if (p.cursor < p.top) p.top = p.cursor;
    if (p.cursor >= p.top + h) p.top = p.cursor - h + 1;
    p.top = Math.max(0, Math.min(p.top, Math.max(0, n - h)));
  };

  /** Space you'd get back by deleting every listed item (nested items counted once). */
  const reclaimable = () => {
    let sum = 0;
    for (const e of outermost(state.items.filter(isLive))) sum += e.size;
    return sum;
  };
  const selectedItems = () => [...state.selected].filter(isLive);
  const selectedBytes = () => outermost(selectedItems()).reduce((s, e) => s + e.size, 0);

  // --- actions ------------------------------------------------------------

  const note = (text, tone = 'info') => {
    state.note = { text, tone };
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { state.note = null; schedule(); }, 3500);
    schedule();
  };

  const toggle = (e) => {
    if (!e || !isLive(e)) return;
    if (state.selected.has(e)) state.selected.delete(e);
    else state.selected.add(e);
  };

  const toggleAll = () => {
    const visible = active().rows.filter(isLive);
    const allOn = visible.length > 0 && visible.every((e) => state.selected.has(e));
    for (const e of visible) {
      if (allOn) state.selected.delete(e);
      else state.selected.add(e);
    }
  };

  const requestDelete = () => {
    const cur = active().current;
    const picked = state.selected.size ? selectedItems() : [cur].filter((e) => e && isLive(e));
    if (picked.length === 0) return;
    if (picked.some((e) => e.path === root || !isInside(root, e.path))) return note('The scanned folder itself cannot be deleted', 'error');
    if (!options.confirm) return startDelete(picked);
    state.mode = 'confirm';
    state.confirmItems = outermost(picked);
  };

  const onDeleted = (entry) => {
    state.freed += markDeleted(entry);
    state.deleted += 1;
    if (entry.type === 'dir') {
      // Anything listed inside is gone too.
      for (const i of state.items) {
        if (isLive(i) && isInside(entry.path, i.path)) i.status = 'deleted';
      }
      for (const s of state.selected) if (isInside(entry.path, s.path)) state.selected.delete(s);
    }
    state.dirty = true;
  };

  const startDelete = (entries) => {
    for (const entry of outermost(entries)) {
      if (!isLive(entry) || isGone(entry.parent)) continue;
      entry.status = 'deleting';
      state.selected.delete(entry);
      state.deleting += 1;
      ensureSpinner();
      removeItem(entry, root, { dryRun })
        .then(() => onDeleted(entry))
        .catch((err) => {
          entry.status = 'error';
          note(`Could not delete ${relOf(entry)}: ${err.message}`, 'error');
        })
        .finally(() => {
          state.deleting -= 1;
          if (state.quitting && state.deleting === 0) finish();
          schedule();
        });
    }
  };

  const openDir = () => {
    const e = state.tree.current;
    if (!e || e.type !== 'dir') return;
    if (e.junk) return note(`${e.name} is junk: it's measured as a whole, not browsed`);
    if (!isLive(e)) return;
    state.tree.dir = e;
    state.tree.current = null;
    state.tree.cursor = 0;
    state.tree.top = 0;
    state.filter = '';
    state.dirty = true;
  };

  const goUp = () => {
    const dir = state.tree.dir;
    if (!dir?.parent) return;
    state.tree.dir = dir.parent;
    state.tree.current = dir; // keep the cursor on the folder we came from
    state.filter = '';
    state.dirty = true;
  };

  const switchView = () => {
    if (!scanner.tree) return note('Tree view needs file sizes: run without --only junk');
    state.view = state.view === 'list' ? 'tree' : 'list';
    state.filter = '';
    state.dirty = true;
  };

  const quit = (force = false) => {
    if (state.deleting > 0 && !force) {
      state.quitting = true;
      note('Finishing deletions… press ctrl+c again to abort');
      return;
    }
    finish();
  };

  // --- input --------------------------------------------------------------

  const onKey = (str, key = {}) => {
    if (key.ctrl && key.name === 'c') return quit(state.quitting);

    if (state.mode === 'confirm') {
      const items = state.confirmItems;
      state.mode = 'list';
      state.confirmItems = [];
      if (key.name === 'y') startDelete(items);
      return schedule();
    }

    if (state.mode === 'filter') {
      if (key.name === 'escape') { state.filter = ''; state.mode = 'list'; }
      else if (key.name === 'return' || key.name === 'tab') state.mode = 'list';
      else if (key.name === 'backspace') state.filter = state.filter.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && str >= ' ' && str.length === 1) state.filter += str;
      state.dirty = true;
      return schedule();
    }

    const p = active();
    const page = listHeight();
    const tree = state.view === 'tree';
    switch (key.name) {
      case 'up': case 'k': moveTo(p.cursor - 1); break;
      case 'down': case 'j': moveTo(p.cursor + 1); break;
      case 'pageup': moveTo(p.cursor - page); break;
      case 'pagedown': moveTo(p.cursor + page); break;
      case 'home': moveTo(0); break;
      case 'end': moveTo(p.rows.length - 1); break;
      case 'g': moveTo(key.shift ? p.rows.length - 1 : 0); break;
      case 'space': toggle(p.current); moveTo(p.cursor + 1); break;
      case 'a': toggleAll(); break;
      case 'd': case 'delete': case 'x': requestDelete(); break;
      case 'return':
        if (tree) openDir();
        else requestDelete();
        break;
      case 'right': case 'l': if (tree) openDir(); break;
      case 'left': case 'h': case 'backspace': if (tree) goUp(); break;
      case 'v': switchView(); break;
      case 't':
        if (!tree) {
          state.kind = KIND_ORDER[(KIND_ORDER.indexOf(state.kind) + 1) % KIND_ORDER.length];
          state.dirty = true;
        }
        break;
      case 's':
        state.sort = SORT_ORDER[(SORT_ORDER.indexOf(state.sort) + 1) % SORT_ORDER.length];
        state.dirty = true;
        break;
      case 'escape':
        if (state.selected.size) state.selected.clear();
        else if (state.filter) { state.filter = ''; state.dirty = true; }
        else if (tree && state.tree.dir?.parent) goUp();
        else quit();
        break;
      case 'q': quit(); break;
      default:
        if (str === '/') state.mode = 'filter';
    }
    schedule();
  };

  // --- rendering ----------------------------------------------------------

  const keyHint = (k, label) => `${c.bold(k)} ${c.dim(label)}`;

  const typeLabel = (e) => (e.risky ? `${e.group} !` : e.group || '');
  const typeColor = (e) => (e.risky ? c.yellow : e.type === 'dir' ? c.cyan : c.magenta);

  const statusCell = (e) => {
    if (e.status === 'deleting') return c.dim(padStart(`${SPINNER[state.frame]} deleting`, W_SIZE - 1));
    if (e.status === 'deleted') return c.green(padStart(dryRun ? '✓ dry run' : `✓ ${formatBytes(e.size)}`, W_SIZE - 1));
    if (e.status === 'error') return c.red(padStart('✗ failed', W_SIZE - 1));
    if (e.pseudo) return c.dim(padStart(formatBytes(e.size), W_SIZE - 1));
    return sizeColor(e.size)(padStart(formatBytes(e.size), W_SIZE - 1));
  };

  const marks = (e, isCursor) => {
    const cursor = isCursor ? c.cyan('❯') : ' ';
    const mark = state.selected.has(e) ? c.magenta('●') : ' ';
    return ` ${cursor}${mark} `;
  };

  const finishRow = (line, isCursor) => (isCursor && colorEnabled() ? c.rowBg(line) : line);

  const renderListRow = (e, isCursor, width) => {
    const pathW = Math.max(8, width - PREFIX - W_TYPE - W_AGE - W_SIZE);
    const gone = e.status === 'deleted';
    // Dim parent, bright leaf. Truncated from the left so the leaf stays visible.
    const shown = truncateLeft(e.rel, pathW);
    const cut = Math.max(0, shown.length - e.name.length);
    const pad = ' '.repeat(pathW - shown.length);
    const pathCell = gone
      ? c.dim(c.strike(shown)) + pad
      : c.dim(shown.slice(0, cut)) + (e.type === 'dir' ? c.bold(shown.slice(cut)) : shown.slice(cut)) + pad;
    const typeCell = typeColor(e)(padEnd(typeLabel(e), W_TYPE - 1)) + ' ';
    const ageCell = c.dim(padStart(formatAge(e.mtime), W_AGE - 1)) + ' ';
    return finishRow(`${marks(e, isCursor)}${pathCell}${typeCell}${ageCell}${statusCell(e)} `, isCursor);
  };

  const renderTreeRow = (e, isCursor, width, total) => {
    const nameW = Math.max(8, width - PREFIX - W_TYPE - W_BAR - W_PCT - W_SIZE);
    const label = e.type === 'dir' ? `${e.name}${path.sep}` : e.name;
    const shown = padEnd(label, nameW);
    let nameCell;
    if (e.status === 'deleted') nameCell = c.dim(c.strike(shown));
    else if (e.pseudo) nameCell = c.dim(shown);
    else if (e.type === 'dir' && !e.junk) nameCell = c.bold(shown);
    else nameCell = shown;

    const typeCell = typeColor(e)(padEnd(e.pseudo ? '' : typeLabel(e), W_TYPE - 1)) + ' ';
    const fraction = total > 0 && isLive(e) ? e.size / total : 0;
    const barColor = e.pseudo ? c.gray : e.type === 'dir' ? (e.junk ? c.yellow : c.cyan) : c.magenta;
    const barCell = barColor(bar(fraction, W_BAR - 2)) + '  ';
    const pctCell = c.dim(padStart(isLive(e) || e.pseudo ? `${(fraction * 100).toFixed(1)}%` : '', W_PCT - 1)) + ' ';
    return finishRow(`${marks(e, isCursor)}${nameCell}${typeCell}${barCell}${pctCell}${statusCell(e)} `, isCursor);
  };

  const limit = (bytes) => formatBytes(bytes).replace(/\.0+ /, ' ');
  const thresholds = () => {
    const parts = [];
    if (scanner.kinds.has('junk')) parts.push(`junk ≥ ${limit(options.minJunkBytes)}`);
    if (scanner.kinds.has('folder')) parts.push(`folders ≥ ${limit(options.minFolderBytes)}`);
    if (scanner.kinds.has('file')) parts.push(`files ≥ ${limit(options.minFileBytes)}`);
    return parts.join(' · ');
  };

  const renderFooter = (width) => {
    if (state.mode === 'confirm') {
      const items = state.confirmItems;
      const bytes = items.reduce((s, i) => s + i.size, 0);
      const what = items.length === 1 ? relOf(items[0]) : `${items.length} items`;
      const warn = items.some((i) => i.risky) ? c.yellow('  check first: includes your own data or build output') : '';
      const verb = dryRun ? 'Dry-run delete' : 'Delete';
      return ` ${c.red(c.bold(`${verb} ${truncateLeft(what, Math.max(10, width - 60))}`))} ${c.dim('·')} ${formatBytes(bytes)}?  ${keyHint('y', 'yes')}  ${keyHint('n', 'no')}${warn}`;
    }
    if (state.mode === 'filter') {
      return ` ${c.cyan('/')} ${state.filter}${c.cyan('█')}   ${keyHint('enter', 'done')}  ${keyHint('esc', 'clear')}`;
    }
    if (state.note) return ` ${(state.note.tone === 'error' ? c.red : c.cyan)(state.note.text)}`;

    const sel = selectedItems();
    const left = sel.length ? `${c.magenta(`${sel.length} selected · ${formatBytes(selectedBytes())}`)}   ` : '';
    const filter = state.filter ? `${c.cyan(`filter: ${state.filter}`)}   ` : '';
    const hints = state.view === 'list'
      ? [keyHint('↑↓', 'move'), keyHint('space', 'select'), keyHint('enter', 'delete'), keyHint('v', 'tree'),
        keyHint('t', 'kind'), keyHint('q', 'quit'), keyHint('s', 'sort'), keyHint('/', 'filter'), keyHint('a', 'all')]
      : [keyHint('↑↓', 'move'), keyHint('→', 'open'), keyHint('←', 'back'), keyHint('d', 'delete'),
        keyHint('space', 'select'), keyHint('v', 'list'), keyHint('q', 'quit'), keyHint('s', 'sort'), keyHint('/', 'filter')];
    // Drop the least important hints until the line fits.
    const line = () => ` ${left}${filter}${hints.join('  ')}`;
    while (hints.length > 1 && visibleLength(line()) > width) hints.pop();
    return line();
  };

  const render = () => {
    renderTimer = null;
    if (state.dirty || state.view === 'tree') rebuild();
    const width = Math.max(40, (out.columns || 80) - 1);
    const height = listHeight();
    const p = active();
    const tree = state.view === 'tree';
    const lines = [];

    // Title + scan status
    const secs = ((scanner.stats.endedAt - scanner.stats.startedAt) / 1000).toFixed(1);
    const status = state.scanning
      ? `${c.cyan(SPINNER[state.frame])} ${c.dim(`scanning · ${formatCount(scanner.stats.dirs)} folders`)}`
      : `${c.green('✓')} ${c.dim(`${formatCount(scanner.stats.dirs)} folders in ${secs}s`)}`;
    const badge = dryRun ? `  ${c.yellow(c.bold('DRY RUN'))}` : '';
    const viewTag = c.dim(tree ? 'tree view' : 'list view');
    lines.push(` ${c.badge(` ${name} `)} ${c.dim(`v${version}`)}${badge}   ${status}   ${viewTag}`);

    // Location + limits
    if (tree) {
      lines.push(` ${c.cyan(truncateLeft(tildify(state.tree.dir?.path ?? root), width - 2))}`);
    } else {
      const limits = thresholds();
      const where = truncateLeft(tildify(root), Math.max(10, width - limits.length - 5));
      const gap = Math.max(3, width - 1 - where.length - limits.length);
      lines.push(` ${c.dim(where)}${' '.repeat(gap)}${c.dim(limits)}`);
    }

    // Stats
    const freedLabel = c.dim(dryRun ? 'would free' : 'freed');
    if (tree) {
      const dir = state.tree.dir;
      const count = dir ? dir.kids.length + dir.files.length + dir.restCount : 0;
      lines.push([
        ` ${c.dim('size')} ${c.bold(c.yellow(formatBytes(dir?.total ?? 0)))}`,
        `${freedLabel} ${c.bold(c.green(formatBytes(state.freed)))}`,
        `${c.dim('items')} ${c.bold(formatCount(count))}`
      ].join('    '));
    } else {
      const kindNote = state.kind === 'all' ? '' : `    ${c.cyan(`showing ${KIND_LABEL[state.kind]}`)}`;
      lines.push([
        ` ${c.dim('reclaimable')} ${c.bold(c.yellow(formatBytes(reclaimable())))}`,
        `${freedLabel} ${c.bold(c.green(formatBytes(state.freed)))}`,
        `${c.dim('found')} ${c.bold(formatCount(state.items.length))}`
      ].join('    ') + kindNote);
    }
    lines.push('');

    // Column header
    const label = (key, text) => (state.sort === key ? `${text} ▾` : text);
    const tint = (key) => (state.sort === key ? c.cyan : c.dim);
    if (tree) {
      const nameW = Math.max(8, width - PREFIX - W_TYPE - W_BAR - W_PCT - W_SIZE);
      lines.push(' '.repeat(PREFIX)
        + tint('path')(padEnd(label('path', 'NAME'), nameW))
        + c.dim(padEnd('TYPE', W_TYPE))
        + tint('size')(padEnd('', W_BAR) + padStart('%', W_PCT - 1)) + ' '
        + tint('size')(padStart(label('size', 'SIZE'), W_SIZE - 1)));
    } else {
      const pathW = Math.max(8, width - PREFIX - W_TYPE - W_AGE - W_SIZE);
      lines.push(' '.repeat(PREFIX)
        + tint('path')(padEnd(label('path', 'PATH'), pathW))
        + c.dim(padEnd('TYPE', W_TYPE))
        + tint('age')(padStart(label('age', 'MODIFIED'), W_AGE - 1)) + ' '
        + tint('size')(padStart(label('size', 'SIZE'), W_SIZE - 1)));
    }

    // Rows
    if (p.rows.length === 0) {
      let msg;
      if (state.filter) msg = `Nothing matches "${state.filter}"`;
      else if (tree) msg = state.scanning ? 'Measuring…' : 'Empty folder';
      else if (state.scanning) msg = 'Looking for junk…';
      else if (state.items.length) msg = `No ${KIND_LABEL[state.kind]} found. Press t to show another kind`;
      else msg = 'All clean. Nothing above the size limits here.';
      lines.push('', `    ${c.dim(msg)}`);
    } else {
      const total = state.tree.dir?.total ?? 0;
      p.rows.slice(p.top, p.top + height).forEach((e, i) => {
        const isCursor = p.top + i === p.cursor;
        lines.push(tree ? renderTreeRow(e, isCursor, width, total) : renderListRow(e, isCursor, width));
      });
    }
    while (lines.length < HEADER_LINES + height) lines.push('');

    // Scroll position + footer
    let info = '';
    if (p.rows.length > height) info = ` ${p.top + 1}-${Math.min(p.top + height, p.rows.length)} of ${p.rows.length}`;
    if (!tree && state.scanning && scanner.kinds.has('folder')) info += `${info ? '  ·  ' : ' '}large folders are listed when the scan finishes`;
    lines.push(c.dim(info));
    lines.push(renderFooter(width));

    out.write(`\x1b[H${lines.map((l) => `${clip(l, width)}\x1b[K`).join('\n')}\x1b[J`);
  };

  const schedule = () => {
    if (!resolveUI) return; // closed
    if (!renderTimer) renderTimer = setTimeout(render, 16);
  };

  const ensureSpinner = () => {
    if (spinTimer) return;
    spinTimer = setInterval(() => {
      if (!state.scanning && state.deleting === 0) {
        clearInterval(spinTimer);
        spinTimer = null;
      }
      state.frame = (state.frame + 1) % SPINNER.length;
      schedule();
    }, 80);
  };

  // --- lifecycle ----------------------------------------------------------

  const restoreTerminal = () => {
    out.write('\x1b[?25h\x1b[?1049l');
    if (inp.isTTY) inp.setRawMode(false);
  };

  const onResize = () => { moveTo(active().cursor); schedule(); };

  const finish = () => {
    if (!resolveUI) return;
    scanner.abort();
    clearInterval(spinTimer);
    clearTimeout(renderTimer);
    clearTimeout(noteTimer);
    inp.off('keypress', onKey);
    out.off('resize', onResize);
    process.off('exit', restoreTerminal);
    inp.pause();
    restoreTerminal();
    const done = resolveUI;
    resolveUI = null;
    done({ freed: state.freed, deleted: state.deleted });
  };

  return new Promise((resolve) => {
    resolveUI = resolve;

    out.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J');
    process.on('exit', restoreTerminal);
    readline.emitKeypressEvents(inp);
    inp.setRawMode(true);
    inp.resume();
    inp.on('keypress', onKey);
    out.on('resize', onResize);

    scanner.on('item', (item) => {
      state.items.push(item);
      state.dirty = true;
      schedule();
    });
    scanner.on('progress', () => {
      if (state.view === 'tree') schedule();
    });
    scanner.on('done', () => {
      if (scanner.error) note(`Scan incomplete: ${scanner.error.message}`, 'error');
      state.scanning = false;
      state.dirty = true;
      schedule();
    });

    ensureSpinner();
    render();
    scanner.start();
  });
}
