// Pre-flight: static analysis of a redirect map. No HTTP requests.
// Catches problems in the map itself before it reaches the platform.
import { toPath, isAbsolute, logicalKey, hostOf } from './map.mjs';

export const PREFLIGHT_CODES = {
  INVALID_SOURCE:      { severity: 'error',   text: 'Source is empty or not a valid path/URL — no redirect can be registered.' },
  MISSING_TARGET:      { severity: 'error',   text: 'No target — the redirect will be skipped. Use "*" if any target is acceptable.' },
  SELF_REDIRECT:       { severity: 'error',   text: 'Source and target are the same path — this is a redirect loop.' },
  DUPLICATE_SOURCE:    { severity: 'error',   text: 'Same source mapped to different targets — only one can survive.' },
  LOOP_IN_MAP:         { severity: 'error',   text: 'Rules form a loop (A → B → … → A).' },
  CHAIN_IN_MAP:        { severity: 'warning', text: 'Target is itself a source of another rule — users get a redirect chain. Point it at the final URL.' },
  VARIANT_CONFLICT:    { severity: 'warning', text: 'Spelling variants of the same page (case, slash, extension) point to different targets.' },
  TARGET_TOO_LONG:     { severity: 'warning', text: 'A target path segment is longer than 80 characters.' },
  QUERY_IN_SOURCE:     { severity: 'warning', text: 'Source has a query string — many platforms match on path only.' },
  UNENCODED_CHARS:     { severity: 'warning', text: 'Unencoded spaces or non-ASCII characters in the path — verify the platform stores them the same way.' },
  FRAGMENT_IN_SOURCE:  { severity: 'error',   text: 'Source contains "#" — everything after it never reaches the server, so no redirect can match it. Only the encoded "%23" form can be redirected; both are probed.' },
  QUESTION_MARK_SLUG:  { severity: 'warning', text: 'Source ends with "?" — a browser sends it without the "?", an encoded link sends "%3F". Visitors arrive with both spellings; the rule must match both, and both are probed.' },
  STRAY_PERCENT:       { severity: 'warning', text: '"%" not followed by two hex digits — many servers refuse this with 400 before any rule runs. Encode it as "%25".' },
  UNEXPECTED_STATUS:   { severity: 'warning', text: 'Unusual expected status — use 301/308 for permanent moves, 410 for retired pages.' },
  UNMAPPED_LEGACY_URL: { severity: 'warning', text: 'Known legacy URL with no rule — it will 404 after cutover.' },
  DUPLICATE_ROW:       { severity: 'info',    text: 'Exact duplicate row — harmless, counted once.' },
  VARIANT_DUPLICATE:   { severity: 'info',    text: 'Several spellings of the same page point to the same target — fine; usually one is enough.' },
  EXTERNAL_TARGET:     { severity: 'info',    text: 'Target is on another host.' },
  RETIRED_PAGE:        { severity: 'info',    text: 'Expected to return 404/410 — intentionally retired.' },
  ROW_DISABLED:        { severity: 'info',    text: 'Row disabled — intentionally excluded.' },
};

const ORDER = { error: 0, warning: 1, info: 2 };

export function preflight(rules, { legacyUrls = [], siteHosts = [] } = {}) {
  const issues = [];
  const add = (code, rule, detail = '') => issues.push({ code, severity: PREFLIGHT_CODES[code].severity, line: rule?.line ?? null, from: rule?.from ?? null, to: rule?.to ?? null, detail, text: PREFLIGHT_CODES[code].text });
  const hosts = new Set(siteHosts.map(h => h.toLowerCase()));

  const active = [];
  const seen = new Map(); // exact source → rule
  for (const r of rules) {
    if (!r.enabled) { add('ROW_DISABLED', r); continue; }
    const fromPath = toPath(r.from);
    if (!r.from || !fromPath || (!r.from.startsWith('/') && !isAbsolute(r.from))) { add('INVALID_SOURCE', r); continue; }
    const retired = r.status === 404 || r.status === 410;
    if (retired) add('RETIRED_PAGE', r);
    else if (!r.to) { add('MISSING_TARGET', r); continue; }
    if (![301, 302, 303, 307, 308, 404, 410].includes(r.status)) add('UNEXPECTED_STATUS', r, `status ${r.status}`);

    const prev = seen.get(fromPath);
    if (prev) {
      if (prev.to === r.to && prev.status === r.status) add('DUPLICATE_ROW', r, `same as line ${prev.line}`);
      else add('DUPLICATE_SOURCE', r, `line ${prev.line} → ${prev.to || prev.status}, line ${r.line} → ${r.to || r.status}`);
      continue;
    }
    seen.set(fromPath, r);

    if (!retired && r.to !== '*') {
      const toP = toPath(r.to);
      const external = isAbsolute(r.to) && !hosts.has(hostOf(r.to));
      if (external) add('EXTERNAL_TARGET', r);
      else if (toP === fromPath) { add('SELF_REDIRECT', r); continue; }
      if (toP && toP.split('?')[0].split('/').some(seg => decodeSafe(seg).length > 80)) add('TARGET_TOO_LONG', r);
    }
    const rawPath = String(r.from).split('#')[0];
    if (String(r.from).includes('#')) add('FRAGMENT_IN_SOURCE', r);
    if (/\?$/.test(rawPath)) add('QUESTION_MARK_SLUG', r);
    else if (fromPath.includes('?')) add('QUERY_IN_SOURCE', r);
    if (/%(?![0-9a-f]{2})/i.test(r.from)) add('STRAY_PERCENT', r);
    if (/[\s]|[^\x00-\x7F]/.test(r.from) || (r.to && /[\s]|[^\x00-\x7F]/.test(r.to))) add('UNENCODED_CHARS', r);
    active.push(r);
  }

  // Variants of one logical page (contact_us.htm / contact_us.cfm / contact_us/).
  const byLogical = new Map();
  for (const r of active) {
    const k = logicalKey(r.from);
    if (!byLogical.has(k)) byLogical.set(k, []);
    byLogical.get(k).push(r);
  }
  for (const group of byLogical.values()) {
    if (group.length < 2) continue;
    const targets = new Set(group.map(r => r.to === '*' ? '*' : (toPath(r.to) || '').replace(/\/+$/, '')));
    const lines = group.map(r => r.line).join(', ');
    if (targets.size > 1) add('VARIANT_CONFLICT', group[1], `lines ${lines}: ${group.map(r => `${r.from} → ${r.to}`).join(' | ')}`);
    else add('VARIANT_DUPLICATE', group[1], `lines ${lines}`);
  }

  // Chains and loops inside the map (same-site targets only).
  const next = new Map();
  for (const r of active) {
    if (r.to && r.to !== '*' && !(r.status === 404 || r.status === 410)) {
      if (isAbsolute(r.to) && !hosts.has(hostOf(r.to))) continue;
      next.set(toPath(r.from), toPath(r.to));
    }
  }
  const reportedLoops = new Set();
  for (const r of active) {
    const start = toPath(r.from);
    if (!next.has(start)) continue;
    const firstTarget = next.get(start);
    if (!next.has(firstTarget)) continue;
    const pathSeen = [start];
    let cur = firstTarget;
    while (next.has(cur) && !pathSeen.includes(cur) && pathSeen.length < 20) { pathSeen.push(cur); cur = next.get(cur); }
    if (pathSeen.includes(cur)) {
      const loopKey = [...pathSeen.slice(pathSeen.indexOf(cur))].sort().join('|');
      if (!reportedLoops.has(loopKey)) { reportedLoops.add(loopKey); add('LOOP_IN_MAP', r, [...pathSeen, cur].join(' → ')); }
    } else add('CHAIN_IN_MAP', r, [...pathSeen, cur].join(' → ') + ` (${pathSeen.length} hops; should go straight to ${cur})`);
  }

  // Legacy URL coverage: every known old URL should have a rule.
  if (legacyUrls.length) {
    const covered = new Set(active.map(r => logicalKey(r.from)));
    for (const u of legacyUrls) {
      if (!covered.has(logicalKey(u))) add('UNMAPPED_LEGACY_URL', { from: toPath(u) || u, line: null, to: null });
    }
  }

  issues.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.line ?? 1e9) - (b.line ?? 1e9));
  const count = s => issues.filter(i => i.severity === s).length;
  const groups = {};
  for (const r of active) groups[r.group] = (groups[r.group] || 0) + 1;
  return {
    summary: { rows: rules.length, checkable: active.length, errors: count('error'), warnings: count('warning'), info: count('info'), groups },
    ok: count('error') === 0,
    issues,
    rules: active,
  };
}

function decodeSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }
