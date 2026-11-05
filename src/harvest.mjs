// Harvest legacy URLs from the Wayback Machine (CDX API) when no redirect map exists.
// Builds a starter map: same-path (domain move) or "*" (platform change: any working target).
import fs from 'node:fs';
import { USER_AGENT } from './util.mjs';

const ASSET = /\.(css|js|mjs|map|json|xml|txt|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|eot|mp4|mp3|webm|zip)$/i;
const NOISE = /^\/(wp-json|wp-admin|wp-includes|cdn-cgi|_next|static|assets|feed|xmlrpc\.php)(\/|$)|\/(feed|amp)\/?$/i;

export function cleanPaths(originals, { limit = 150 } = {}) {
  const seen = new Set();
  const out = [];
  for (const o of originals) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(o) ? o : 'http://' + o); } catch { continue; }
    const p = decodeSafe(u.pathname);
    if (ASSET.test(p) || NOISE.test(p) || p.length > 200) continue;
    if ([...u.searchParams.keys()].some(k => /^(utm_|fbclid|gclid|replytocom|s$|p$)/i.test(k))) continue;
    const key = (p.replace(/\/+$/, '') || '/') + u.search;
    if (seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    out.push(encodeURI(p) + u.search);
  }
  // Prefer shallow, representative pages first; keep the homepage.
  out.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  return out.slice(0, limit);
}

export async function harvest(oldDomain, { limit = 150, from, to, timeoutMs = 60000 } = {}) {
  const host = oldDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const qs = new URLSearchParams({ url: `${host}/*`, output: 'json', fl: 'original', filter: 'statuscode:200', collapse: 'urlkey', limit: String(limit * 8) });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`https://web.archive.org/cdx/search/cdx?${qs}`, { signal: ac.signal, headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`Wayback CDX answered HTTP ${res.status}`);
    const rows = await res.json();
    return cleanPaths(rows.slice(1).map(r => r[0]), { limit });
  } finally { clearTimeout(t); }
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
