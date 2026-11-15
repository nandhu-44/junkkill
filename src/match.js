const CASE_INSENSITIVE = process.platform === 'win32';

const norm = (s) => (CASE_INSENSITIVE ? s.toLowerCase() : s);
const isGlob = (s) => s.includes('*') || s.includes('?');

function globToRegExp(glob) {
  const body = norm(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

/** Returns a predicate that tests a single name against a list of names/globs. */
export function nameMatcher(patterns) {
  const exact = new Set();
  const globs = [];
  for (const p of patterns) {
    if (isGlob(p)) globs.push(globToRegExp(p));
    else exact.add(norm(p));
  }
  return (name) => {
    const n = norm(name);
    return exact.has(n) || globs.some((re) => re.test(n));
  };
}

/**
 * Returns `(name, siblings) => target | null` where `siblings` is the list of
 * directory entries next to `name`. First matching target wins.
 */
export function targetMatcher(targets) {
  const compiled = targets.map((t, order) => ({
    target: t,
    order,
    test: nameMatcher([t.name]),
    when: t.when?.length ? nameMatcher(t.when) : null
  }));
  const byName = new Map();
  const globbed = [];
  for (const c of compiled) {
    if (isGlob(c.target.name)) {
      globbed.push(c);
    } else {
      const key = norm(c.target.name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(c);
    }
  }

  return (name, siblings) => {
    const candidates = [...(byName.get(norm(name)) ?? []), ...globbed.filter((c) => c.test(name))];
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.order - b.order);
    for (const c of candidates) {
      if (!c.when || siblings.some((s) => !s.isDirectory() && c.when(s.name))) return c.target;
    }
    return null;
  };
}
