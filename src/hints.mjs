// Triage hints: turn a list of failures into one clear likely cause per kind of failure.
//
// One built-in hint per result type (MISSING, WRONG_TARGET, …). Each has candidate causes;
// the cause that explains the most rows is the hint. Other causes found in the same rows are
// mentioned in one short "Also:" clause, never as separate hints.
// Built-in causes describe behaviour any platform can show, never a specific site or vendor.
// Project- or site-specific knowledge goes in a hints file (see loadHints), and wins over built-ins.
import fs from 'node:fs';

export const LEVELS = ['high', 'medium', 'info'];

const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const pathOf = (u) => {
  if (!u) return '';
  let p;
  try { p = new URL(u, 'http://x').pathname; } catch { p = String(u).split('?')[0]; }
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
};
const eg = (rows, k = 3) => `(e.g. ${rows.slice(0, k).map(r => r.from).join(', ')})`;
const isRefusal = s => s && s !== 200 && s !== 404 && s !== 410;
const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) for (const k of [key(r)].flat()) {
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};
const largest = (m) => [...m].sort((a, b) => b[1].length - a[1].length)[0] || [null, []];
// The same legacy page in its other spelling(s), see spelling.mjs.
const counterparts = (r, results) => results.filter(o => o !== r && (o.from === r.variantOf || o.variantOf === r.from || (r.variantOf && o.variantOf === r.variantOf)));
const quoteList = names => names.map(g => `"${g}"`).join(', ');

/**
 * Path-pattern keys for clustering: the suffix after the first dot of the last segment,
 * with digit runs folded to N (".N.aspx", ".php"), and the first directory ("/blog/*").
 */
export function patternKeys(from) {
  const p = pathOf(from);
  const keys = [];
  const segs = p.split('/').filter(Boolean);
  const last = segs.at(-1) || '';
  const dot = last.indexOf('.');
  if (dot > 0) keys.push('*' + last.slice(dot).toLowerCase().replace(/\d+/g, 'N'));
  if (segs.length >= 2) keys.push(`/${segs[0]}/*`);
  return keys;
}

// cause: { key, min, pick(rows, ctx) → subset, say(subset, ctx) → full sentence, short(subset) → "Also" phrase }
export const BUILTIN_HINTS = [
  {
    id: 'MISSING', level: 'high',
    causes: [
      {
        // One spelling of "?" / "#" works and the other does not: the rule matches only part of the visitors.
        key: 'other-spelling', min: 1, evidence: 'Possible',
        pick: (rows, ctx) => rows.filter(r => counterparts(r, ctx.results).some(o => o.ok)),
        say: sub => `${plural(sub.length, 'URL fails', 'URLs fail')} in one spelling of a special character while the other spelling works ${eg(sub)} — visitors arrive with both ("?" and "%3F", "%23"). Possible: the platform matches the rule on one spelling only. Add a rule for the failing spelling.`,
        short: sub => `${sub.length} fail in one spelling of "?" or "#" only`,
      },
      {
        key: 'refused', min: 1, evidence: 'Possible', // the status itself is observed; why it is refused is not
        pick: rows => largest(groupBy(rows.filter(r => isRefusal(r.httpStatus)), r => r.httpStatus))[1],
        say: sub => {
          const s = sub[0].httpStatus;
          const why = [401, 403, 429].includes(s)
            ? 'Possible: bot protection or rate limiting is answering the probe, not the site. Re-run with --delay-ms, or from an allowed network, before changing the map.'
            : 'the platform refuses them before any redirect rule runs, so adding rules will not help. Possible: route or file-extension validation, or an edge filter. Check one with curl -I and a browser User-Agent.';
          return `${plural(sub.length, 'legacy URL answers', 'legacy URLs answer')} HTTP ${s} with no redirect ${eg(sub)} — ${why}`;
        },
        short: sub => `${sub.length} answer HTTP ${sub[0].httpStatus} (${[401, 403, 429].includes(sub[0].httpStatus) ? 'Possible: bot protection' : 'Possible: refused before any rule runs'})`,
      },
      {
        key: 'served-200', min: 1, evidence: 'Possible',
        pick: rows => rows.filter(r => r.httpStatus === 200),
        say: sub => `${plural(sub.length, 'legacy URL answers', 'legacy URLs answer')} 200 with no redirect ${eg(sub)} — Possible: the new platform is not serving this origin yet, or a catch-all route swallows the paths.`,
        short: sub => `${sub.length} answer 200 (Possible: not served by the new platform yet)`,
      },
      {
        key: 'group-not-deployed', min: 2, evidence: 'Likely',
        pick: (rows, { matrix }) => rows.filter(r => { const m = matrix[r.group]; return m && m.total >= 2 && m.MISSING === m.total; }),
        say: sub => {
          const groups = [...new Set(sub.map(r => String(r.group)))];
          return `Every rule in ${quoteList(groups)} is MISSING (${plural(sub.length, 'URL', 'URLs')}) — Likely the rules for ${groups.length === 1 ? 'this group' : 'these groups'} were never deployed, or the deploy step failed.`;
        },
        short: sub => `${sub.length} in ${quoteList([...new Set(sub.map(r => String(r.group)))])} (Likely never deployed)`,
      },
      {
        key: 'shared-pattern', min: 3, evidence: 'Possible',
        pick: rows => { const [key, sub] = largest(groupBy(rows, r => patternKeys(r.from))); return Object.assign(sub, { key }); },
        say: sub => `${sub.length} legacy URLs with no redirect share the pattern "${sub.key}" ${eg(sub)} — Possible: one pattern rule on the platform covers all of them.`,
        short: sub => `${sub.length} share "${sub.key}" (Possible: one pattern rule)`,
      },
    ],
    fallback: rows => `${plural(rows.length, 'legacy URL has', 'legacy URLs have')} no redirect ${eg(rows)} — add a rule for each, or retire them with 410.`,
  },
  {
    id: 'WRONG_TARGET', level: 'high',
    causes: [
      {
        // One spelling of "?" / "#" works and the other does not: the rule matches only part of the visitors.
        key: 'other-spelling', min: 1, evidence: 'Possible',
        pick: (rows, ctx) => rows.filter(r => counterparts(r, ctx.results).some(o => o.ok)),
        say: sub => `${plural(sub.length, 'URL fails', 'URLs fail')} in one spelling of a special character while the other spelling works ${eg(sub)} — visitors arrive with both ("?" and "%3F", "%23"). Possible: the platform matches the rule on one spelling only. Add a rule for the failing spelling.`,
        short: sub => `${sub.length} fail in one spelling of "?" or "#" only`,
      },
      {
        key: 'catch-all-home', min: 2, evidence: 'Likely',
        pick: rows => rows.filter(r => r.actual === '/'),
        say: sub => `${sub.length} URLs redirect to the homepage ${eg(sub)} — Likely a catch-all rule overriding specific rules. Search engines treat this as a soft 404.`,
        short: sub => `${sub.length} go to the homepage (Likely a catch-all)`,
      },
      {
        // Source ends in "/", the platform drops the slash first, and the specific rule no longer matches.
        key: 'trailing-slash-stripped', min: 1, evidence: 'Possible',
        pick: rows => rows.filter(r => /\/(\?|$)/.test(r.from) && pathOf(r.from) !== '/'
          && r.location && pathOf(r.location) === pathOf(r.from) && !/\/(\?|$)/.test(String(r.location).split('#')[0])
          && pathOf(r.to) !== pathOf(r.from)),
        say: sub => `${plural(sub.length, 'URL', 'URLs')} ending in "/" ${sub.length === 1 ? 'is' : 'are'} first redirected to the same path without the slash, so the specific rule no longer matches ${eg(sub)}. Possible: the platform normalises trailing slashes before matching rules — add the slash-less variant to the map, or match both.`,
        short: sub => `${sub.length} lose the trailing slash first (Possible: slashes normalised before matching)`,
      },
      {
        key: 'group-other-map', min: 3, evidence: 'Possible',
        pick: (rows, { matrix }) => rows.filter(r => { const m = matrix[r.group]; return m && m.total >= 3 && (m.WRONG_TARGET || 0) / m.total >= 0.5; }),
        say: sub => {
          const groups = [...new Set(sub.map(r => String(r.group)))];
          return `Most of ${quoteList(groups)} points to the wrong target (${plural(sub.length, 'URL', 'URLs')}) — Possible: the deployed config comes from a different version of the map.`;
        },
        short: sub => `${sub.length} in ${quoteList([...new Set(sub.map(r => String(r.group)))])} (Possible: another map version)`,
      },
    ],
    fallback: rows => `${plural(rows.length, 'URL redirects', 'URLs redirect')} somewhere other than the map says ${eg(rows)} — compare the deployed rules with the map.`,
  },
  {
    id: 'TARGET_BROKEN', level: 'high',
    causes: [
      {
        // One spelling of "?" / "#" works and the other does not: the rule matches only part of the visitors.
        key: 'other-spelling', min: 1, evidence: 'Possible',
        pick: (rows, ctx) => rows.filter(r => counterparts(r, ctx.results).some(o => o.ok)),
        say: sub => `${plural(sub.length, 'URL fails', 'URLs fail')} in one spelling of a special character while the other spelling works ${eg(sub)} — visitors arrive with both ("?" and "%3F", "%23"). Possible: the platform matches the rule on one spelling only. Add a rule for the failing spelling.`,
        short: sub => `${sub.length} fail in one spelling of "?" or "#" only`,
      },
      {
        // A domain-level redirect that keeps the path: every old path is sent to the same path on the new site.
        key: 'path-preserved', min: 2, evidence: 'Likely',
        pick: rows => rows.filter(r => r.actual && pathOf(r.actual) === pathOf(r.from) && pathOf(r.from) !== '/'),
        say: sub => `${sub.length} redirects keep the old path and land on a page that does not exist on the new site ${eg(sub)} — Likely a domain-level redirect that preserves the path. Map these URLs to their new pages, or retire them with 410.`,
        short: sub => `${sub.length} keep the old path (Likely a domain-level redirect)`,
      },
    ],
    fallback: rows => `${plural(rows.length, 'redirect lands', 'redirects land')} on a broken page ${eg(rows)} — the content was not migrated, or the target slug changed.`,
  },
  {
    id: 'WRONG_STATUS', level: 'medium',
    causes: [
      {
        key: 'temporary', min: 1, evidence: 'observed',
        pick: rows => rows.filter(r => [302, 303, 307].includes(r.httpStatus)),
        say: sub => `${plural(sub.length, 'temporary redirect', 'temporary redirects')} (302/307) ${eg(sub)} — use 301/308 so search ranking moves to the new URL.`,
        short: sub => `${sub.length} temporary (302/307)`,
      },
    ],
    fallback: rows => `${plural(rows.length, 'URL answers', 'URLs answer')} with a different status than the map expects ${eg(rows)} — compare with the status column.`,
  },
  {
    id: 'CHAIN', level: 'medium', causes: [],
    fallback: rows => `${plural(rows.length, 'redirect chain', 'redirect chains')} ${eg(rows)} — point each rule straight at the final URL.`,
  },
  {
    id: 'LOOP', level: 'high', causes: [],
    fallback: rows => `${plural(rows.length, 'redirect loop', 'redirect loops')} ${eg(rows)} — ${rows.length === 1 ? 'this page is' : 'these pages are'} unreachable.`,
  },
  {
    id: 'ERROR', level: 'high', causes: [],
    fallback: (rows, { results }) => (rows.length / results.length >= 0.2
      ? `${plural(rows.length, 'network error', 'network errors')} (${Math.round(100 * rows.length / results.length)}%) — check VPN, DNS, firewall or rate limiting, then re-run. Use --strict for the final gate.`
      : `${plural(rows.length, 'network error', 'network errors')} — re-run before trusting the result.`),
    levelFor: (rows, { results }) => (rows.length / results.length >= 0.2 ? 'high' : 'medium'),
  },
];
export const BUILTIN_IDS = BUILTIN_HINTS.map(h => h.id);

/**
 * One hint for one result type: the cause that explains the most rows leads; other causes get one
 * short "Also:" clause. Every row is counted exactly once, so the causes always add up to the total.
 * The text starts with "[k of N]" when the leading cause covers only part of the rows.
 */
function explain(def, rows, ctx) {
  const found = [];
  let left = rows;
  // Greedy: take the cause that explains the most of what is left, then look again at the remainder.
  for (;;) {
    let best = null;
    for (const c of def.causes) {
      if (found.some(f => f.cause === c)) continue;
      const sub = c.pick(left, ctx) || [];
      if (sub.length >= c.min && (!best || sub.length > best.sub.length)) best = { cause: c, sub };
    }
    if (!best) break;
    found.push(best);
    const taken = new Set(best.sub);
    left = left.filter(r => !taken.has(r));
    if (!left.length) break;
  }
  const level = def.levelFor ? def.levelFor(rows, ctx) : def.level;
  const causes = found.map(f => ({ cause: f.cause.key, evidence: f.cause.evidence, count: f.sub.length, from: f.sub.slice(0, 20).map(r => r.from) }));
  if (left.length) causes.push({ cause: 'unspecified', evidence: 'observed', count: left.length, from: left.slice(0, 20).map(r => r.from) });
  if (!found.length) return { level, cause: 'unspecified', causes, rows, text: def.fallback(rows, ctx) };
  const [main, ...rest] = found;
  const also = rest.map(f => f.cause.short(f.sub));
  if (left.length) also.push(`${left.length} with no common cause`);
  const share = main.sub.length < rows.length ? `[${main.sub.length} of ${rows.length}] ` : '';
  return { level, cause: main.cause.key, causes, rows, text: share + main.cause.say(main.sub, ctx) + (also.length ? ` Also: ${also.join('; ')}.` : '') };
}

// ---------------------------------------------------------------- custom hints
// A hints file (JSON) adds project- or site-specific knowledge without touching the code:
// {
//   "disable": ["CHAIN"],
//   "hints": [{
//     "id": "legacy-php", "level": "high", "min": 2,
//     "match": { "result": ["MISSING"], "status": [400], "from": "\\.php$", "group": "nav" },
//     "text": "{count} old .php pages are refused ({examples}) — ask the platform team to enable the legacy handler."
//   }]
// }
// match fields: result, status, group (value or list) · from, to, actual, detail (case-insensitive regex).
// By default only failing, non-excepted rows are matched; "includePassing": true matches every row.
// A custom hint wins: the failing rows it explains are left out of the built-in hint for that result type.
// Placeholders in text: {count} {total} {percent} {examples}.

const MATCH_KEYS = ['result', 'status', 'group', 'from', 'to', 'actual', 'detail'];
const REGEX_KEYS = ['from', 'to', 'actual', 'detail'];

/** Read and validate one or more hint files; later files add to (and may disable more than) earlier ones. */
export function loadHints(files) {
  const list = [files].flat().filter(Boolean);
  const out = { disable: new Set(), hints: [], files: list };
  for (const f of list) {
    let parsed;
    try {
      parsed = parseHints(JSON.parse(fs.readFileSync(f, 'utf8')), `Hints file ${f}`);
    } catch (e) {
      const err = new Error(e.code === 'ENOENT' ? `Hints file ${f}: not found` : e.message.startsWith('Hints file') ? e.message : `Hints file ${f}: ${e.message}`);
      err.usage = true; // a setup problem: show the message, not a stack trace
      throw err;
    }
    for (const id of parsed.disable) out.disable.add(id);
    for (const h of parsed.hints) {
      const i = out.hints.findIndex(x => x.id === h.id);
      if (i > -1) out.hints[i] = h; else out.hints.push(h); // a site file can override a project hint by id
    }
  }
  return out;
}

export function parseHints(cfg, where = 'hints') {
  const fail = msg => { throw new Error(`${where}: ${msg}`); };
  if (Array.isArray(cfg)) cfg = { hints: cfg };
  if (!cfg || typeof cfg !== 'object') fail('expected an object with "hints" and/or "disable"');
  const disable = [cfg.disable || []].flat();
  for (const id of disable) if (!BUILTIN_IDS.includes(id)) fail(`"disable" names unknown built-in hint "${id}". Known: ${BUILTIN_IDS.join(', ')}`);
  const hints = (cfg.hints || []).map((h, i) => {
    const at = `hint #${i + 1}${h?.id ? ` ("${h.id}")` : ''}`;
    if (!h || typeof h !== 'object') fail(`${at} is not an object`);
    if (!h.id || typeof h.id !== 'string') fail(`${at} needs an "id"`);
    if (BUILTIN_IDS.includes(h.id)) fail(`${at} uses a built-in id — pick another id, or list it in "disable"`);
    if (!h.text || typeof h.text !== 'string') fail(`${at} needs a "text"`);
    const level = h.level || 'medium';
    if (!LEVELS.includes(level)) fail(`${at}: level must be ${LEVELS.join(', ')}`);
    const match = h.match || {};
    for (const k of Object.keys(match)) if (!MATCH_KEYS.includes(k)) fail(`${at}: unknown match field "${k}". Use ${MATCH_KEYS.join(', ')}`);
    const test = {};
    for (const k of REGEX_KEYS) if (match[k] != null) {
      try { test[k] = new RegExp(match[k], 'i'); } catch (e) { fail(`${at}: bad regex in "${k}": ${e.message}`); }
    }
    for (const k of ['result', 'status', 'group']) if (match[k] != null) test[k] = new Set([match[k]].flat().map(v => (k === 'status' ? Number(v) : String(v))));
    const min = h.min == null ? 1 : Number(h.min);
    if (!Number.isInteger(min) || min < 1) fail(`${at}: "min" must be a whole number ≥ 1`);
    return { id: h.id, level, text: h.text, min, includePassing: !!h.includePassing, test };
  });
  return { disable, hints };
}

function matches(r, test) {
  if (test.result && !test.result.has(r.result)) return false;
  if (test.status && !test.status.has(r.httpStatus)) return false;
  if (test.group && !test.group.has(String(r.group))) return false;
  for (const k of REGEX_KEYS) if (test[k] && !test[k].test(String(r[k] ?? ''))) return false;
  return true;
}

function runCustom(h, results) {
  const pool = h.includePassing ? results : results.filter(r => !r.ok && !r.excepted);
  const rows = pool.filter(r => matches(r, h.test));
  if (rows.length < h.min) return null;
  const text = h.text
    .replaceAll('{count}', String(rows.length))
    .replaceAll('{total}', String(results.length))
    .replaceAll('{percent}', String(Math.round(100 * rows.length / (results.length || 1))))
    .replaceAll('{examples}', rows.slice(0, 3).map(r => r.from).join(', '));
  return { level: h.level, rows, text };
}

// ---------------------------------------------------------------- evaluation

/**
 * All hints for a run. Custom hints first: what they explain is theirs. Then at most one
 * built-in hint per result type, over the failing rows no custom hint explained.
 */
export function triageHints(results, matrix, custom = null) {
  const disabled = custom?.disable || new Set();
  const claimed = new Set();
  const out = [];
  for (const h of custom?.hints || []) {
    const found = runCustom(h, results);
    if (!found) continue;
    for (const r of found.rows) if (!r.ok) claimed.add(r);
    out.push(finish(found, h.id, 'custom'));
  }
  const failing = results.filter(r => !r.ok && !claimed.has(r));
  const ctx = { results, matrix };
  for (const def of BUILTIN_HINTS) {
    if (disabled.has(def.id)) continue;
    const rows = failing.filter(r => r.result === def.id);
    if (rows.length) out.push(finish(explain(def, rows, ctx), def.id, 'builtin'));
  }
  return out;
}

const finish = ({ rows, ...h }, id, source) => ({ id, source, ...h, count: rows.length, from: rows.slice(0, 20).map(r => r.from) });
