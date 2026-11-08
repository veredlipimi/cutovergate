// Harvest legacy URLs from the Wayback Machine (CDX API) when no redirect map exists.
// Builds a starter map: same-path (domain move) or "*" (platform change: any working target).
import fs from 'node:fs';
import { USER_AGENT } from './util.mjs';

const ASSET = /\.(css|js|mjs|map|json|xml|txt|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|eot|mp4|mp3|webm|zip)$/i;
const NOISE = /^\/(wp-json|wp-admin|wp-includes|cdn-cgi|_next|static|assets|feed|xmlrpc\.php|\.well-known)(\/|$)|\/(feed|amp)\/?$/i;
// The old site's own error page is not a legacy URL anyone needs redirected.
const ERROR_PAGE = /\/(404|410|500|not-?found|page-not-found|error)(\.(html?|php|aspx?))?\/?$/i;
// Tracking and cache-busting parameters: removed, so the page itself is kept once.
const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|yclid|wbraid|gbraid|mkt_tok|linkid|_hsenc|_hsmi|hsctatracking|vero_id|ref|ref_src|source|es_p|ver|print|share|target|amp|replytocom|wpx-.*)$/i;

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
  const shallow = (a, b) => a.split('/').length - b.split('/').length || a.length - b.length;
  // Spread the sample across sections (/blog/*, /about, …): one section with thousands of
  // URLs (user profiles, tag pages) must not crowd out the rest of the site.
  const groups = new Map();
  for (const p of out.sort(shallow)) {
    const g = p === '/' ? '' : p.split(/[/?]/)[1].toLowerCase();
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  const lists = [...groups.values()];
  const picked = [];
  for (let i = 0; picked.length < limit && lists.some(l => i < l.length); i++)
    for (const l of lists) if (i < l.length && picked.length < limit) picked.push(l[i]);
  return picked;
}

export async function harvest(oldDomain, { limit = 150, from, to, timeoutMs = 60000, retries = 3, backoffMs = 2000, samplePrefixes = 8, fetchImpl = fetch } = {}) {
  const host = oldDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const cap = limit * 8;
  const qs = new URLSearchParams({ url: `${host}/*`, output: 'json', fl: 'original', filter: 'statuscode:200', collapse: 'urlkey', limit: String(cap) });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const base = 'https://web.archive.org/cdx/search/cdx?';

  // The archive is often busy (429/5xx, timeouts): retry with backoff before giving up.
  async function get(params, tries = retries) {
    let last = '';
    for (let attempt = 1; attempt <= tries; attempt++) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(base + params, { signal: ac.signal, headers: { 'user-agent': USER_AGENT } });
        if (res.ok) return { ok: true, data: await res.json() };
        last = `HTTP ${res.status}`;
        if (res.status !== 429 && res.status < 500) break; // a 4xx other than 429 will not change on retry
      } catch (e) {
        last = e.name === 'AbortError' ? `no answer in ${Math.round(timeoutMs / 1000)}s` : e.message;
      } finally { clearTimeout(t); }
      if (attempt < tries) await new Promise(r => setTimeout(r, backoffMs * attempt));
    }
    return { ok: false, last };
  }

  const first = await get(qs.toString());
  if (!first.ok) {
    const err = new Error(`The Wayback Machine did not answer for ${host} (${first.last}, ${retries} attempts). It is often busy; try again in a few minutes. Nothing was written.`);
    err.usage = true; // an outside service problem: show the message, not a stack trace
    throw err;
  }
  const rows = first.data.slice(1).map(r => r[0]);

  // The index is sorted by URL, so a capped answer from a large site covers only the start of
  // the alphabet (/0…, /1…). Then also ask for a few path prefixes spread across the alphabet.
  // (The archive's page-based paging does not work together with filter and collapse.)
  // Best effort: if the archive refuses a prefix, the rows already read are used as they are.
  if (rows.length >= cap && samplePrefixes > 0) {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const pick = [...new Set(Array.from({ length: samplePrefixes }, (_, i) => letters[Math.floor((i * letters.length) / samplePrefixes)]))];
    const each = Math.max(limit, Math.ceil(cap / pick.length));
    for (const ch of pick) {
      const r = await get(new URLSearchParams({ ...Object.fromEntries(qs), url: `${host}/${ch}*`, limit: String(each) }).toString(), 1);
      if (r.ok && Array.isArray(r.data)) rows.push(...r.data.slice(1).map(x => x && x[0]).filter(Boolean));
    }
  }
  return cleanPaths(rows, { limit });
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
