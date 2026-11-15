import readline from 'node:readline';
import {
  c, clip, colorEnabled, formatAge, formatBytes, formatCount, padEnd, padStart, tildify, truncateLeft, visibleLength
} from './format.js';
import { removeItem } from './remove.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SORT_ORDER = ['size', 'age', 'path'];
const SORTERS = {
  size: (a, b) => b.size - a.size,
  age: (a, b) => a.mtime - b.mtime, // oldest first
  path: (a, b) => a.rel.localeCompare(b.rel)
};

const W_TYPE = 11;
const W_AGE = 11;
const W_SIZE = 11;
const PREFIX = 4; // gutter + cursor + mark + space
const HEADER_LINES = 5;
const FOOTER_LINES = 2;

const sizeColor = (bytes) => (bytes >= 1024 ** 3 ? c.red : bytes >= 100 * 1024 ** 2 ? c.yellow : c.green);

/**
 * Full-screen interactive list. Resolves with { freed, deleted } once the user quits.
 */
export function runUI({ scanner, root, options, name, version, dryRun }) {
  const out = process.stdout;
  const inp = process.stdin;

  const state = {
    items: [],
    view: [],
    dirty: true,
    cursor: 0,
    current: null,
    top: 0,
    selected: new Set(),
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
    frame: 0
  };

  let renderTimer = null;
  let spinTimer = null;
  let noteTimer = null;
  let resolveUI;

  // --- data ---------------------------------------------------------------

  const rebuildView = () => {
    const q = state.filter.toLowerCase();
    state.view = (q ? state.items.filter((i) => i.rel.toLowerCase().includes(q)) : [...state.items])
      .sort(SORTERS[state.sort]);
    state.dirty = false;
    const idx = state.current ? state.view.indexOf(state.current) : -1;
    moveTo(idx >= 0 ? idx : state.cursor);
  };

  const listHeight = () => Math.max(1, (out.rows || 24) - HEADER_LINES - FOOTER_LINES);

  const moveTo = (index) => {
    const n = state.view.length;
    state.cursor = n === 0 ? 0 : Math.min(Math.max(index, 0), n - 1);
    state.current = state.view[state.cursor] ?? null;
    const h = listHeight();
    if (state.cursor < state.top) state.top = state.cursor;
    if (state.cursor >= state.top + h) state.top = state.cursor - h + 1;
    state.top = Math.max(0, Math.min(state.top, Math.max(0, n - h)));
  };

  const live = (i) => i.status !== 'deleted' && i.status !== 'deleting';
  const reclaimable = () => state.items.reduce((sum, i) => sum + (live(i) ? i.size : 0), 0);
  const selectedItems = () => [...state.selected].filter(live);
  const selectedBytes = () => selectedItems().reduce((s, i) => s + i.size, 0);

  // --- actions ------------------------------------------------------------

  const note = (text, tone = 'info') => {
    state.note = { text, tone };
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { state.note = null; schedule(); }, 3500);
    schedule();
  };

  const toggle = (item) => {
    if (!item || !live(item)) return;
    if (state.selected.has(item)) state.selected.delete(item);
    else state.selected.add(item);
  };

  const toggleAll = () => {
    const visible = state.view.filter(live);
    const allOn = visible.length > 0 && visible.every((i) => state.selected.has(i));
    for (const i of visible) {
      if (allOn) state.selected.delete(i);
      else state.selected.add(i);
    }
  };

  const requestDelete = () => {
    const picked = state.selected.size ? selectedItems() : [state.current].filter((i) => i && live(i));
    if (picked.length === 0) return;
    if (!options.confirm) return startDelete(picked);
    state.mode = 'confirm';
    state.confirmItems = picked;
  };

  const startDelete = (items) => {
    for (const item of items) {
      if (!live(item)) continue;
      item.status = 'deleting';
      state.selected.delete(item);
      state.deleting += 1;
      ensureSpinner();
      removeItem(item, root, { dryRun })
        .then(() => {
          item.status = 'deleted';
          state.freed += item.size;
          state.deleted += 1;
        })
        .catch((err) => {
          item.status = 'error';
          note(`Could not delete ${item.rel}: ${err.message}`, 'error');
        })
        .finally(() => {
          state.deleting -= 1;
          if (state.quitting && state.deleting === 0) finish();
          schedule();
        });
    }
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

    const page = listHeight();
    switch (key.name) {
      case 'up': case 'k': moveTo(state.cursor - 1); break;
      case 'down': case 'j': moveTo(state.cursor + 1); break;
      case 'pageup': moveTo(state.cursor - page); break;
      case 'pagedown': moveTo(state.cursor + page); break;
      case 'home': moveTo(0); break;
      case 'end': moveTo(state.view.length - 1); break;
      case 'g': moveTo(key.shift ? state.view.length - 1 : 0); break;
      case 'space': toggle(state.current); moveTo(state.cursor + 1); break;
      case 'a': toggleAll(); break;
      case 'return': case 'd': case 'delete': case 'x': requestDelete(); break;
      case 's':
        state.sort = SORT_ORDER[(SORT_ORDER.indexOf(state.sort) + 1) % SORT_ORDER.length];
        state.dirty = true;
        break;
      case 'escape':
        if (state.selected.size) state.selected.clear();
        else if (state.filter) { state.filter = ''; state.dirty = true; }
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

  const renderRow = (item, isCursor, width) => {
    const pathW = Math.max(8, width - PREFIX - W_TYPE - W_AGE - W_SIZE);
    const gone = item.status === 'deleted';

    const cursor = isCursor ? c.cyan('❯') : ' ';
    const mark = state.selected.has(item) ? c.magenta('●') : ' ';

    // Path: dim parent, bright leaf. Truncated from the left so the leaf stays visible.
    const shown = truncateLeft(item.rel, pathW);
    const cut = Math.max(0, shown.length - item.name.length);
    const parent = shown.slice(0, cut);
    const leaf = shown.slice(cut);
    const pad = ' '.repeat(pathW - shown.length);
    let pathCell;
    if (gone) pathCell = c.dim(c.strike(shown)) + pad;
    else pathCell = c.dim(parent) + (item.type === 'dir' ? c.bold(leaf) : leaf) + pad;

    const typeText = item.risky ? `${item.group} !` : item.group;
    const typeCell = (item.risky ? c.yellow : item.type === 'dir' ? c.cyan : c.magenta)(padEnd(typeText, W_TYPE - 1)) + ' ';
    const ageCell = c.dim(padStart(formatAge(item.mtime), W_AGE - 1)) + ' ';

    let sizeCell;
    if (item.status === 'deleting') sizeCell = c.dim(padStart(`${SPINNER[state.frame]} deleting`, W_SIZE - 1));
    else if (gone) sizeCell = c.green(padStart(dryRun ? '✓ dry run' : `✓ ${formatBytes(item.size)}`, W_SIZE - 1));
    else if (item.status === 'error') sizeCell = c.red(padStart('✗ failed', W_SIZE - 1));
    else sizeCell = sizeColor(item.size)(padStart(formatBytes(item.size), W_SIZE - 1));

    const line = ` ${cursor}${mark} ${pathCell}${typeCell}${ageCell}${sizeCell} `;
    return isCursor && colorEnabled() ? c.rowBg(line) : line;
  };

  const renderFooter = (width) => {
    if (state.mode === 'confirm') {
      const items = state.confirmItems;
      const bytes = items.reduce((s, i) => s + i.size, 0);
      const what = items.length === 1 ? items[0].rel : `${items.length} items`;
      const risky = items.some((i) => i.risky) ? c.yellow('  includes build output, check first') : '';
      const verb = dryRun ? 'Dry-run delete' : 'Delete';
      return ` ${c.red(c.bold(`${verb} ${truncateLeft(what, Math.max(10, width - 50))}`))} ${c.dim('·')} ${formatBytes(bytes)}?  ${keyHint('y', 'yes')}  ${keyHint('n', 'no')}${risky}`;
    }
    if (state.mode === 'filter') {
      return ` ${c.cyan('/')} ${state.filter}${c.cyan('█')}   ${keyHint('enter', 'done')}  ${keyHint('esc', 'clear')}`;
    }
    if (state.note) {
      const tone = state.note.tone === 'error' ? c.red : c.cyan;
      return ` ${tone(state.note.text)}`;
    }
    const sel = selectedItems();
    const left = sel.length ? `${c.magenta(`${sel.length} selected · ${formatBytes(selectedBytes())}`)}   ` : '';
    const filter = state.filter ? `${c.cyan(`filter: ${state.filter}`)}   ` : '';
    const hints = [
      keyHint('↑↓', 'move'),
      keyHint('space', 'select'),
      keyHint('enter', 'delete'),
      keyHint('q', 'quit'),
      keyHint('a', 'all'),
      keyHint('s', 'sort'),
      keyHint('/', 'filter')
    ];
    // Drop the least important hints until the line fits.
    const line = () => ` ${left}${filter}${hints.join('  ')}`;
    while (hints.length > 1 && visibleLength(line()) > width) hints.pop();
    return line();
  };

  const render = () => {
    renderTimer = null;
    if (state.dirty) rebuildView();
    const width = Math.max(40, (out.columns || 80) - 1);
    const height = listHeight();
    const lines = [];

    // Title + scan status
    const status = state.scanning
      ? `${c.cyan(SPINNER[state.frame])} ${c.dim(`scanning · ${formatCount(scanner.stats.dirs)} folders`)}`
      : `${c.green('✓')} ${c.dim(`${formatCount(scanner.stats.dirs)} folders in ${((scanner.stats.endedAt - scanner.stats.startedAt) / 1000).toFixed(1)}s`)}`;
    const badge = dryRun ? `  ${c.yellow(c.bold('DRY RUN'))}` : '';
    lines.push(` ${c.badge(` ${name} `)} ${c.dim(`v${version}`)}${badge}   ${status}`);
    lines.push(` ${c.dim(truncateLeft(tildify(root), width - 2))}`);

    // Stats
    lines.push([
      ` ${c.dim('reclaimable')} ${c.bold(c.yellow(formatBytes(reclaimable())))}`,
      `${c.dim(dryRun ? 'would free' : 'freed')} ${c.bold(c.green(formatBytes(state.freed)))}`,
      `${c.dim('found')} ${c.bold(formatCount(state.items.length))}`
    ].join('    '));
    lines.push('');

    // Column header
    const pathW = Math.max(8, width - PREFIX - W_TYPE - W_AGE - W_SIZE);
    const label = (key, text) => (state.sort === key ? `${text} ▾` : text);
    const tint = (key) => (state.sort === key ? c.cyan : c.dim);
    const head = ' '.repeat(PREFIX)
      + tint('path')(padEnd(label('path', 'PATH'), pathW))
      + c.dim(padEnd('TYPE', W_TYPE))
      + tint('age')(padStart(label('age', 'MODIFIED'), W_AGE - 1)) + ' '
      + tint('size')(padStart(label('size', 'SIZE'), W_SIZE - 1));
    lines.push(head);

    // List
    if (state.view.length === 0) {
      let msg;
      if (state.filter) msg = `Nothing matches "${state.filter}"`;
      else if (state.scanning) msg = 'Looking for junk…';
      else msg = 'All clean. Nothing above the size limits here.';
      lines.push('', `    ${c.dim(msg)}`);
      while (lines.length < HEADER_LINES + height) lines.push('');
    } else {
      const slice = state.view.slice(state.top, state.top + height);
      slice.forEach((item, i) => lines.push(renderRow(item, state.top + i === state.cursor, width)));
      while (lines.length < HEADER_LINES + height) lines.push('');
    }

    // Scroll position + footer
    const more = state.view.length > height
      ? c.dim(` ${state.top + 1}-${Math.min(state.top + height, state.view.length)} of ${state.view.length}`)
      : '';
    lines.push(more);
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

  const onResize = () => { moveTo(state.cursor); schedule(); };

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
    scanner.on('done', () => {
      state.scanning = false;
      schedule();
    });

    ensureSpinner();
    render();
    scanner.start();
  });
}
