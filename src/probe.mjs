// Live probe: real HTTP requests (GET, redirect: manual), hop-by-hop.
// Read-only by design: GET/HEAD only, bounded concurrency, identifiable User-Agent.
import { USER_AGENT, runPool } from './util.mjs';
import { toPath, isAbsolute, hostOf } from './map.mjs';

export const RESULTS = {
  PASS:          { ok: true,  text: 'Redirects to the expected target with an accepted status.' },
  REDIRECT_OK:   { ok: true,  text: 'Redirect exists; target not specified in the map ("*").' },
  GONE_OK:       { ok: true,  text: 'Retired page returns the expected 404/410.' },
  MISSING:       { ok: false, text: 'No redirect — the legacy URL answers directly (404, 200, …).' },
  WRONG_TARGET:  { ok: false, text: 'Redirects, but to a different page than the map says.' },
  WRONG_STATUS:  { ok: false, text: 'Right target, wrong status (e.g. 302 instead of 301).' },
  CHAIN:         { ok: false, text: 'Reaches the right target only through extra hops.' },
  LOOP:          { ok: false, text: 'Redirect loop — the browser never arrives.' },
  TARGET_BROKEN: { ok: false, text: 'Redirect is right, but the destination page itself fails.' },
  ERROR:         { ok: false, text: 'Network error, timeout or DNS failure — nothing was verified.' },
};

async function request(url, { timeoutMs, method = 'GET', headers = {} }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method, redirect: 'manual', signal: ac.signal, headers: { 'user-agent': USER_AGENT, ...headers } });
    // Read a small part of the body for fingerprinting, then drop the rest.
    let body = '';
    if (method === 'GET' && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (body.length < 64 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        body += dec.decode(value, { stream: true });
      }
      try { await reader.cancel(); } catch {}
    }
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, body, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, location: null, headers: new Headers(), body: '', ms: Date.now() - started, error: e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.message || String(e)) };
  } finally { clearTimeout(t); }
}

/** Follow redirects manually so every hop is visible. */
export async function trace(url, { timeoutMs = 20000, maxHops = 6 } = {}) {
  const hops = [];
  let cur = url;
  const visited = new Set();
  for (let i = 0; i <= maxHops; i++) {
    const r = await request(cur, { timeoutMs });
    hops.push({ url: cur, status: r.status, location: r.location, ms: r.ms, error: r.error });
    if (r.error) return { hops, error: r.error, loop: false, final: r };
    if (r.status >= 300 && r.status < 400 && r.location) {
      let nextUrl;
      try { nextUrl = new URL(r.location, cur).href; } catch { return { hops, error: `bad Location: ${r.location}`, loop: false, final: r }; }
      if (visited.has(nextUrl) || nextUrl === cur) { hops.push({ url: nextUrl, status: null, location: null }); return { hops, loop: true, final: r }; }
      visited.add(cur);
      cur = nextUrl;
      continue;
    }
    return { hops, loop: false, final: r };
  }
  return { hops, loop: false, tooManyHops: true, final: hops.at(-1) };
}

/** Normalise a URL for comparison: same-site → path+query; external → full URL without trailing slash. */
function comparable(u, base, siteHosts) {
  if (!u) return null;
  let url;
  try { url = new URL(u, base); } catch { return u; }
  const host = url.host.toLowerCase();
  if (host === hostOf(base) || siteHosts.has(host)) return url.pathname + url.search;
  return url.href;
}
const sameTarget = (a, b) => {
  if (a === b) return { same: true, note: '' };
  const strip = s => (s || '').replace(/\/+(\?|$)/, '$1');
  if (strip(a) === strip(b)) return { same: true, note: 'trailing slash differs' };
  return { same: false };
};

export function classify(rule, t, { origin, siteHosts, accept, checkTargets }) {
  const hosts = new Set(siteHosts);
  const first = t.hops[0];
  const base = { httpStatus: first?.status ?? 0, location: first?.location ?? null, hops: t.hops.length - 1, chain: t.hops.map(h => `${h.status ?? '…'} ${comparable(h.url, origin, hosts)}`).join(' → ') };
  if (t.error && t.hops.length === 1) return { ...base, result: 'ERROR', detail: t.error };

  const retired = rule.status === 404 || rule.status === 410;
  const isRedirect = first.status >= 300 && first.status < 400 && first.location;

  if (retired) {
    if (!isRedirect && first.status === rule.status) return { ...base, result: 'GONE_OK', detail: `HTTP ${first.status}` };
    if (!isRedirect && (first.status === 404 || first.status === 410)) return { ...base, result: 'GONE_OK', detail: `HTTP ${first.status} (expected ${rule.status})` };
    return { ...base, result: 'WRONG_STATUS', detail: `expected ${rule.status}, got ${first.status}${isRedirect ? ` → ${comparable(first.location, origin, hosts)}` : ''}` };
  }
  if (!isRedirect) {
    const hint = first.status === 200 ? ' — page is served without a redirect (old page still live, or a catch-all route)' : '';
    return { ...base, result: 'MISSING', detail: `HTTP ${first.status}${hint}` };
  }
  if (t.loop) return { ...base, result: 'LOOP', detail: base.chain };

  const firstTarget = comparable(new URL(first.location, origin).href, origin, hosts);
  const finalHop = t.hops.at(-1);
  const finalUrl = comparable(finalHop.url, origin, hosts);

  if (rule.to === '*') {
    // Any target is fine — except the homepage catch-all for a deep page (a soft 404) or a broken landing page.
    const landed = t.hops.length > 2 ? finalUrl : firstTarget;
    const fromPath = toPath(rule.from);
    if ((landed === '/' || /^https?:\/\/[^/]+\/?$/.test(landed || '')) && fromPath !== '/') {
      return { ...base, result: 'WRONG_TARGET', detail: `→ ${landed} — deep page redirected to the homepage (catch-all; search engines treat this as a soft 404)`, actual: landed };
    }
    if (checkTargets && t.final && !t.error && !t.tooManyHops && (t.final.status < 200 || t.final.status >= 300)) {
      return { ...base, result: 'TARGET_BROKEN', detail: `→ ${landed}, which answers HTTP ${t.final.status}`, actual: landed };
    }
    return { ...base, result: 'REDIRECT_OK', detail: `→ ${landed}${t.hops.length > 2 ? ` (${t.hops.length - 1} hops)` : ''}`, actual: landed };
  }

  const expected = isAbsolute(rule.to) ? comparable(rule.to, origin, hosts) : toPath(rule.to);
  const direct = sameTarget(firstTarget, expected);
  const statusOk = accept.includes(first.status) || (rule.status !== 301 && first.status === rule.status);

  if (direct.same) {
    if (!statusOk) return { ...base, result: 'WRONG_STATUS', detail: `expected ${rule.status}${accept.length > 1 ? ` (accepted: ${accept.join('/')})` : ''}, got ${first.status}`, actual: firstTarget };
    if (t.hops.length > 2) {
      // Target itself redirects onward (e.g. /new → /new/ → /new-final).
      const fin = sameTarget(finalUrl, expected);
      if (!fin.same) return { ...base, result: 'CHAIN', detail: `expected target redirects onward: ${base.chain}`, actual: finalUrl };
    }
    if (checkTargets && t.final && !t.error && (t.final.status < 200 || t.final.status >= 300) && !t.tooManyHops) {
      return { ...base, result: 'TARGET_BROKEN', detail: `target answers HTTP ${t.final.status}`, actual: firstTarget };
    }
    if (checkTargets && t.error) return { ...base, result: 'TARGET_BROKEN', detail: `target failed: ${t.error}`, actual: firstTarget };
    return { ...base, result: 'PASS', detail: direct.note, actual: firstTarget };
  }
  // Not the expected first hop — does it get there eventually?
  const eventually = t.hops.slice(1).some(h => sameTarget(comparable(h.url, origin, hosts), expected).same);
  if (eventually) return { ...base, result: 'CHAIN', detail: base.chain, actual: firstTarget };
  const homeHint = (firstTarget === '/' && expected !== '/') ? ' — redirects to the homepage (catch-all rule?)' : '';
  return { ...base, result: 'WRONG_TARGET', detail: `expected ${expected}, got ${firstTarget}${homeHint}`, actual: firstTarget };
}

export async function probeRules(rules, opts) {
  const { origin, concurrency = 6, timeoutMs = 20000, maxHops = 6, delayMs = 0, onProgress } = opts;
  let done = 0;
  return runPool(rules, concurrency, async (rule) => {
    const url = isAbsolute(rule.from) ? origin + toPath(rule.from) : origin + rule.from;
    const followFor = opts.checkTargets ? maxHops : Math.min(maxHops, 3);
    const t = await trace(url, { timeoutMs, maxHops: followFor });
    const verdict = classify(rule, t, opts);
    onProgress?.(++done, rules.length);
    return { from: rule.from, to: rule.to, expectedStatus: rule.status, group: rule.group, note: rule.note, line: rule.line, url, ...verdict };
  }, { delayMs });
}

// ---------------------------------------------------------------------------
// Origin auto-detection.
// candidates: [{ label: 'staging', url }, { label: 'live', url }] — probed in parallel,
// the first (in the given order) that matches the fingerprint wins.
// fingerprint: 'header:x-served-by' | 'header:server=nginx' | 'body:<meta name="generator" content="NewCMS"' | null
export function parseFingerprint(spec) {
  if (!spec) return null;
  const m = /^(header|body):(.+)$/i.exec(spec);
  if (!m) throw new Error(`Bad --fingerprint "${spec}". Use header:<name>[=<value>] or body:<text>`);
  if (m[1].toLowerCase() === 'header') {
    const [name, ...rest] = m[2].split('=');
    return { type: 'header', name: name.trim().toLowerCase(), value: rest.length ? rest.join('=').trim() : null };
  }
  return { type: 'body', text: m[2] };
}

export async function detectOrigin(candidates, fingerprint, { timeoutMs = 8000 } = {}) {
  const checks = await Promise.all(candidates.map(async (cand) => {
    const t = await trace(cand.url.replace(/\/+$/, '') + '/', { timeoutMs, maxHops: 5 });
    const r = t.final;
    if (t.error || !r || r.status === 0) return { ...cand, state: 'unreachable', detail: t.error || 'no response' };
    if (!fingerprint) return { ...cand, state: 'match', detail: `HTTP ${r.status}` };
    let match = false;
    if (fingerprint.type === 'header') {
      const v = r.headers?.get?.(fingerprint.name);
      match = v != null && (fingerprint.value == null || v.toLowerCase().includes(fingerprint.value.toLowerCase()));
    } else match = (r.body || '').includes(fingerprint.text);
    return { ...cand, state: match ? 'match' : 'other', detail: `HTTP ${r.status}` };
  }));
  const winner = checks.find(c => c.state === 'match');
  if (winner) return { origin: winner.url.replace(/\/+$/, ''), phase: winner.label, checks };
  const reason = checks.every(c => c.state === 'unreachable') ? 'unreachable' : 'not-on-target';
  return { origin: null, phase: null, reason, checks };
}

export function parseCandidates(spec) {
  // "staging=https://a.example,live=https://www.example.com" or "https://a,https://b"
  return String(spec).split(',').map(s => s.trim()).filter(Boolean).map((part, i) => {
    const m = /^([a-z0-9_-]+)=(https?:\/\/.+)$/i.exec(part);
    return m ? { label: m[1], url: m[2] } : { label: i === 0 ? 'pre-cutover' : i === 1 ? 'live' : `origin-${i + 1}`, url: part };
  });
}
