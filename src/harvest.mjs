// Harvest legacy URLs from the Wayback Machine (CDX API) when no redirect map exists.
// Builds a starter map: same-path (domain move) or "*" (platform change: any working target).
import fs from 'node:fs';
import { USER_AGENT } from './util.mjs';

const ASSET = /\.(css|js|mjs|map|json|xml|txt|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|eot|mp4|mp3|webm|zip)$/i;
const NOISE = /^\/(wp-json|wp-admin|wp-includes|cdn-cgi|_next|static|assets|feed|xmlrpc\.php|\.well-known)(\/|$)|\/(feed|amp)\/?$/i;
// The old site's own error page is not a legacy URL anyone needs redirected.
const ERROR_PAGE = /\/(404|410|500|not-?found|page-not-found|error)(\.(html?|php|aspx?))?\/?$/i;
// Tracking and cache-busting parameters: removed, so the page itself is kept once.
const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|yclid|wbraid|gbraid|mkt_tok|_hsenc|_hsmi|hsctatracking|vero_id|ref|ref_src|source|es_p|ver|print|share|target|amp|replytocom|wpx-.*)$/i;

/** A path Wayback recorded from a broken link (quotes, brackets, spaces), not a page that existed. */
function malformed(p) {
  if (/["'<>\\\s]|%2[27]/i.test(p)) return true;
  const open = (p.match(/\(/g) || []).length, close = (p.match(/\)/g) || []).length;
  return open !== close;
}

export function cleanPaths(originals, { limit = 150 } = {}) {
  const seen = new Set();
  const out = [];
  for (const o of originals) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(o) ? o : 'http://' + o); } catch { continue; }
    const p = decodeSafe(u.pathname);
    if (ASSET.test(p) || NOISE.test(p) || ERROR_PAGE.test(p) || malformed(p) || p.length > 200) continue;
    if ([...u.searchParams.keys()].some(k => /^(s|p)$/i.test(k))) continue; // site search and ?p= previews
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    const path = p.replace(/\/+$/, '') || '/';
    // A query on the homepage is a variant of the homepage, not another legacy page.
    // A "?" with nothing after it is part of the slug ("Is it worth it?"), not an empty query: keep it.
    const slugQ = path !== '/' && /\?$/.test(String(o).split('#')[0]) && !u.searchParams.toString() ? '?' : '';
    const search = path === '/' ? '' : (u.searchParams.toString() ? '?' + u.searchParams.toString() : slugQ);
    const key = path + search;
    if (seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    out.push(encodeURI(p) + search);
  }
  // Prefer shallow, representative pages first; keep the homepage.
  out.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  return out.slice(0, limit);
}

export async function harvest(oldDomain, { limit = 150, from, to, timeoutMs = 60000, retries = 3, backoffMs = 2000, fetchImpl = fetch } = {}) {
  const host = oldDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const qs = new URLSearchParams({ url: `${host}/*`, output: 'json', fl: 'original', filter: 'statuscode:200', collapse: 'urlkey', limit: String(limit * 8) });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const url = `https://web.archive.org/cdx/search/cdx?${qs}`;
  // The archive is often busy (429/5xx, timeouts): retry with backoff before giving up.
  let last = '';
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ac.signal, headers: { 'user-agent': USER_AGENT } });
      if (res.ok) return cleanPaths((await res.json()).slice(1).map(r => r[0]), { limit });
      last = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break; // a 4xx other than 429 will not change on retry
    } catch (e) {
      last = e.name === 'AbortError' ? `no answer in ${Math.round(timeoutMs / 1000)}s` : e.message;
    } finally { clearTimeout(t); }
    if (attempt < retries) await new Promise(r => setTimeout(r, backoffMs * attempt));
  }
  const err = new Error(`The Wayback Machine did not answer for ${host} (${last}, ${retries} attempts). It is often busy; try again in a few minutes. Nothing was written.`);
  err.usage = true; // an outside service problem: show the message, not a stack trace
  throw err;
}

export function writeStarterMap(file, paths, mode) {
  const lines = ['from,to,status,group,note'];
  for (const p of paths) {
    const group = p === '/' ? 'home' : (p.split('/')[1] || 'root').replace(/\.[a-z0-9]+$/i, '').slice(0, 30) || 'root';
    lines.push(`${csv(p)},${mode === 'same-path' ? csv(p) : '*'},301,${csv(group)},harvested from Wayback`);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

const csv = s => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
function decodeSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }
