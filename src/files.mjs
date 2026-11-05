// Linked-file check: are the PDFs / documents / downloads that pages link to still reachable?
// Sources: a list of hrefs (--urls), and/or pages to scan for file links (--pages).
// Probe: HEAD, falling back to GET with Range: bytes=0-0 when HEAD is refused.
import { USER_AGENT, runPool } from './util.mjs';

export const FILE_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|rtf|txt|odt|ods|epub|mp3|mp4|mov)$/i;

export function isFileLike(href, { pattern, all } = {}) {
  if (!href || href === '#' || href === './' || /^(mailto|tel|javascript):/i.test(href)) return false;
  if (all) return true;
  if (pattern && new RegExp(pattern, 'i').test(href)) return true;
  if (/\/files?\//i.test(href)) return true;
  try { return FILE_EXT.test(new URL(href, 'http://x.invalid').pathname); } catch { return false; }
}

export function resolveHref(origin, href) {
  const h = href.trim();
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('//')) return 'https:' + h;
  try { return new URL(h.startsWith('/') ? h : '/' + h, origin + '/').href; } catch { return null; }
}

/** Extract file-like links from a page's HTML (href/src attributes). */
export function extractLinks(htmlText, pageUrl, opts) {
  const out = [];
  const re = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(htmlText))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim().replace(/&amp;/g, '&');
    if (!isFileLike(raw, opts)) continue;
    try { out.push({ rawHref: raw, resolvedUrl: new URL(raw, pageUrl).href, foundOn: pageUrl }); } catch {}
  }
  return out;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ac.signal, headers: { 'user-agent': USER_AGENT, ...(init.headers || {}) } }); }
  finally { clearTimeout(t); }
}

export async function probeFile(url, timeoutMs = 20000) {
  try {
    let res = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow' }, timeoutMs);
    if ([403, 405, 501].includes(res.status)) {
      res = await fetchWithTimeout(url, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-0' } }, timeoutMs);
      try { await res.body?.cancel(); } catch {}
    }
    const type = res.headers.get('content-type') || '';
    const ok = res.ok;
    // A file link answered with an HTML page is usually a soft 404 (error page or homepage).
    const expectsFile = FILE_EXT.test(new URL(url).pathname);
    const soft404 = ok && expectsFile && /text\/html/i.test(type);
    return { status: res.status, finalUrl: res.url, contentType: type, result: !ok ? 'BROKEN' : soft404 ? 'SOFT_404' : 'OK' };
  } catch (e) {
    return { status: 0, finalUrl: url, contentType: '', result: 'ERROR', error: e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.message) };
  }
}

export async function checkFiles({ origin, hrefs = [], pages = [], pattern, all, concurrency = 6, timeoutMs = 20000 }) {
  const rows = [];
  for (const h of hrefs) {
    if (!isFileLike(h, { pattern, all: all ?? true })) continue;
    const abs = resolveHref(origin, h);
    if (abs) rows.push({ rawHref: h, resolvedUrl: abs, foundOn: 'list' });
  }
  const pageErrors = [];
  for (const p of pages) {
    const pageUrl = resolveHref(origin, p);
    try {
      const res = await fetchWithTimeout(pageUrl, { method: 'GET', redirect: 'follow' }, timeoutMs);
      if (!res.ok) { pageErrors.push({ page: pageUrl, status: res.status }); continue; }
      rows.push(...extractLinks(await res.text(), res.url, { pattern, all: false }));
    } catch (e) { pageErrors.push({ page: pageUrl, error: e?.message }); }
  }
  const seen = new Map();
  for (const r of rows) {
    const k = r.resolvedUrl;
    if (!seen.has(k)) seen.set(k, { ...r, foundOn: [r.foundOn] });
    else if (!seen.get(k).foundOn.includes(r.foundOn)) seen.get(k).foundOn.push(r.foundOn);
  }
  const unique = [...seen.values()];
  const probed = await runPool(unique, concurrency, async (row) => ({ ...row, ...(await probeFile(row.resolvedUrl, timeoutMs)) }));
  const count = k => probed.filter(r => r.result === k).length;
  return { summary: { checked: probed.length, ok: count('OK'), broken: count('BROKEN'), soft404: count('SOFT_404'), errors: count('ERROR'), pagesScanned: pages.length - pageErrors.length, pageErrors: pageErrors.length }, pageErrors, results: probed };
}
