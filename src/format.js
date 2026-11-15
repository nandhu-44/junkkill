import os from 'node:os';
import path from 'node:path';

let colorOn = true;
export const setColor = (on) => { colorOn = on; };
export const colorEnabled = () => colorOn;

// Each style closes only itself, so a row background survives inner styling.
const style = (open, close) => (s) => (colorOn ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: style(1, 22),
  dim: style(2, 22),
  strike: style(9, 29),
  red: style(31, 39),
  green: style(32, 39),
  yellow: style(33, 39),
  blue: style(34, 39),
  magenta: style(35, 39),
  cyan: style(36, 39),
  gray: style(90, 39),
  rowBg: style('48;5;236', 49),
  badge: style('1;30;46', '0')
};

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function formatAge(mtimeMs, now = Date.now()) {
  if (!mtimeMs) return '—';
  const min = Math.max(0, (now - mtimeMs) / 60000);
  if (min < 60) return 'just now';
  const h = min / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 14) return `${Math.floor(d)}d ago`;
  if (d < 60) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

export const formatCount = (n) => n.toLocaleString('en-US');

export function tildify(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

export function truncateLeft(s, width) {
  if (width <= 0) return '';
  if (s.length <= width) return s;
  return width === 1 ? '…' : `…${s.slice(s.length - width + 1)}`;
}

export function truncateRight(s, width) {
  if (width <= 0) return '';
  if (s.length <= width) return s;
  return width === 1 ? '…' : `${s.slice(0, width - 1)}…`;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/y;

/** Visible length of a string containing ANSI escapes. */
export const visibleLength = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;

/** Cuts a styled string to `width` visible characters, keeping escapes intact. */
export function clip(s, width) {
  if (visibleLength(s) <= width) return s;
  let out = '';
  let seen = 0;
  for (let i = 0; i < s.length;) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(s);
    if (m) {
      out += m[0];
      i += m[0].length;
    } else {
      if (seen < width) out += s[i];
      seen += 1;
      i += 1;
    }
  }
  return colorOn ? `${out}\x1b[0m` : out;
}

export const padEnd = (s, w) => truncateRight(s, w).padEnd(w);
export const padStart = (s, w) => truncateRight(s, w).padStart(w);
