// Exceptions (waivers with mandatory reason + TTL), the release gate, and failure taxonomy.
import fs from 'node:fs';
import { RESULTS } from './probe.mjs';
import { readJson, writeJson } from './util.mjs';
import { toPath } from './map.mjs';

export const TTL_CHOICES = { none: null, 7: 7, 14: 14, 30: 30, 90: 90 };
const DAY = 86400000;
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;

export function loadExceptions(file) {
  if (!file || !fs.existsSync(file)) return [];
  const data = readJson(file, []);
  return Array.isArray(data) ? data : data.exceptions || [];
}

/** Add an exception; reason is mandatory, ttl is one of none/7/14/30/90 (days). */
export function addException(file, { path: p, reason, ttl = '14', by = '' }, now = new Date()) {
  if (!p) throw new Error('--path is required');
  if (!reason || !String(reason).trim()) throw new Error('--reason is required: document why this failure is waived');
  const key = String(ttl).toLowerCase();
  if (!(key in TTL_CHOICES)) throw new Error(`--ttl must be one of: ${Object.keys(TTL_CHOICES).join(', ')}`);
  const days = TTL_CHOICES[key];
  const list = loadExceptions(file).filter(e => e.path !== p);
  const entry = { path: p, reason: String(reason).trim(), added: now.toISOString().slice(0, 10), expires: days ? new Date(now.getTime() + days * DAY).toISOString().slice(0, 10) : null };
  if (by) entry.by = by;
  list.push(entry);
  writeJson(file, { exceptions: list });
  return entry;
}

export function removeException(file, p) {
  const list = loadExceptions(file);
  const left = list.filter(e => e.path !== p);
  writeJson(file, { exceptions: left });
  return list.length - left.length;
}

const globToRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

/** Split exceptions into active / expired / invalid and flag those expiring within 7 days. */
export function triageExceptions(list, now = new Date()) {
  const active = [], expired = [], invalid = [], expiringSoon = [];
  for (const e of list) {
    if (!e.path) { invalid.push({ ...e, problem: 'missing path' }); continue; }
    if (!e.reason || !String(e.reason).trim()) { invalid.push({ ...e, problem: 'missing reason' }); continue; }
    if (e.expires && new Date(e.expires + 'T23:59:59Z') < now) { expired.push(e); continue; }
    if (e.expires && new Date(e.expires + 'T23:59:59Z') - now < 7 * DAY) expiringSoon.push(e);
    active.push({ ...e, _re: globToRe(toPath(e.path) || e.path) });
  }
  return { active, expired, invalid, expiringSoon };
}

/**
 * Gate rule: release is blocked until effective failures = 0.
 * Excepted rows are still probed and shown, but not counted.
 * Strict mode: ERROR rows always block, even when excepted.
 */
export function evaluateGate(results, exceptionList, { strict = false, now = new Date() } = {}) {
  const ex = triageExceptions(exceptionList, now);
  const used = new Set();
  for (const r of results) {
    r.ok = RESULTS[r.result]?.ok ?? false;
    r.excepted = null;
    if (r.ok) continue;
    const p = toPath(r.from) || r.from;
    const hit = ex.active.find(e => e._re.test(p));
    if (!hit) continue;
    if (strict && r.result === 'ERROR') { r.exceptionIgnored = 'strict mode: network errors always block'; continue; }
    r.excepted = { reason: hit.reason, expires: hit.expires || null };
    used.add(hit.path);
  }
  const failures = results.filter(r => !r.ok);
  const effective = failures.filter(r => !r.excepted);
  const counts = {};
  for (const r of results) counts[r.result] = (counts[r.result] || 0) + 1;
  const clean = e => { const { _re, ...rest } = e; return rest; };
  return {
    status: effective.length === 0 ? 'PASS' : 'FAIL',
    strict,
    probed: results.length,
    passed: results.length - failures.length,
    failures: failures.length,
    excepted: failures.length - effective.length,
    effectiveFailures: effective.length,
    counts,
    exceptions: {
      active: ex.active.map(clean).map(e => ({ ...e, used: used.has(e.path) })),
      expired: ex.expired, invalid: ex.invalid, expiringSoon: ex.expiringSoon,
      unused: ex.active.filter(e => !used.has(e.path)).map(clean),
    },
  };
}

/** Failures grouped by group × result, with triage hints. */
export function taxonomy(results) {
  const matrix = {};
  for (const r of results) {
    matrix[r.group] ??= { total: 0 };
    matrix[r.group].total++;
    if (!r.ok) matrix[r.group][r.result] = (matrix[r.group][r.result] || 0) + 1;
  }
  const hints = [];
  const failing = results.filter(r => !r.ok);
  for (const [group, row] of Object.entries(matrix)) {
    if (row.total >= 2 && row.MISSING === row.total) hints.push({ level: 'high', group, text: `Every rule in "${group}" is MISSING — the rules for this group were most likely never deployed, or the deploy step failed.` });
    else if (row.total >= 3 && (row.WRONG_TARGET || 0) / row.total >= 0.5) hints.push({ level: 'high', group, text: `Most of "${group}" points to the wrong target — the deployed config probably comes from a different version of the map.` });
  }
  const missing200 = failing.filter(r => r.result === 'MISSING' && r.httpStatus === 200);
  if (missing200.length >= 2) hints.push({ level: 'high', text: `${missing200.length} legacy URLs answer 200 with no redirect — the new platform may not be serving this origin yet, or a catch-all route swallows the paths.` });
  const toHome = failing.filter(r => r.result === 'WRONG_TARGET' && r.actual === '/');
  if (toHome.length >= 2) hints.push({ level: 'high', text: `${toHome.length} URLs redirect to the homepage — a catch-all rule is overriding specific rules. Search engines treat this as a soft 404.` });
  const temp = failing.filter(r => r.result === 'WRONG_STATUS' && [302, 303, 307].includes(r.httpStatus));
  if (temp.length) hints.push({ level: 'medium', text: `${n(temp.length, 'temporary redirect', 'temporary redirects')} (302/307) — use 301/308 so search ranking moves to the new URL.` });
  const chains = failing.filter(r => r.result === 'CHAIN');
  if (chains.length) hints.push({ level: 'medium', text: `${n(chains.length, 'redirect chain', 'redirect chains')} — point each rule straight at the final URL.` });
  const loops = failing.filter(r => r.result === 'LOOP');
  if (loops.length) hints.push({ level: 'high', text: `${n(loops.length, 'redirect loop', 'redirect loops')} — ${loops.length === 1 ? 'this page is' : 'these pages are'} unreachable.` });
  const broken = failing.filter(r => r.result === 'TARGET_BROKEN');
  if (broken.length) hints.push({ level: 'high', text: `${n(broken.length, 'redirect lands', 'redirects land')} on a broken page — the content was not migrated, or the target slug changed.` });
  const errors = failing.filter(r => r.result === 'ERROR');
  if (errors.length && errors.length / results.length >= 0.2) hints.push({ level: 'high', text: `${n(errors.length, 'network error', 'network errors')} (${Math.round(100 * errors.length / results.length)}%) — check VPN, DNS, firewall or rate limiting, then re-run. Use --strict for the final gate.` });
  else if (errors.length) hints.push({ level: 'medium', text: `${n(errors.length, 'network error', 'network errors')} — re-run before trusting the result.` });
  return { matrix, hints };
}
