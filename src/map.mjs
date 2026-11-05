// Load a redirect map (CSV / TSV / JSON) into normalized rules.
//
// Columns / keys (case-insensitive, aliases accepted):
//   from     legacy path or URL                  (old, source, old_url, legacy)
//   to       expected target path or URL; "*" = any redirect accepted   (new, target, new_url, destination)
//   status   expected status, default 301; 410/404 = page intentionally retired
//   group    optional label used for failure taxonomy (layer, section, type)
//   enabled  false/no/0/off = row kept in the file but not checked
//   note     free text, carried into reports
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from './util.mjs';

const ALIASES = {
  from: ['from', 'old', 'source', 'old_url', 'oldurl', 'legacy', 'legacy_url', 'src'],
  to: ['to', 'new', 'target', 'new_url', 'newurl', 'destination', 'dest', 'expected'],
  status: ['status', 'code', 'type', 'http_status', 'expected_status'],
  group: ['group', 'layer', 'section', 'category', 'kind'],
  enabled: ['enabled', 'active', 'status_enabled', 'include'],
  note: ['note', 'notes', 'comment', 'comments'],
};

function pick(obj, field) {
  const keys = Object.keys(obj);
  for (const alias of ALIASES[field]) {
    const k = keys.find(k => k.trim().toLowerCase().replace(/[\s-]+/g, '_') === alias);
    if (k !== undefined && obj[k] !== undefined && obj[k] !== null) return String(obj[k]).trim();
  }
  return '';
}

const OFF = new Set(['false', 'no', '0', 'off', 'n', 'disabled']);

export function loadMap(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  let records;
  if (ext === '.json') {
    const data = JSON.parse(raw);
    records = Array.isArray(data) ? data : data.rules || data.redirects
      || Object.entries(data).map(([from, to]) => (typeof to === 'object' ? { from, ...to } : { from, to }));
  } else {
    const rows = parseCsv(raw);
    if (!rows.length) return [];
    const header = rows[0].map(h => h.trim().toLowerCase());
    const hasHeader = header.some(h => ALIASES.from.includes(h.replace(/[\s-]+/g, '_')));
    const cols = hasHeader ? rows[0] : ['from', 'to', 'status', 'group'];
    records = (hasHeader ? rows.slice(1) : rows).map(r => Object.fromEntries(cols.map((k, i) => [k, r[i] ?? ''])));
  }
  return records.map((rec, i) => {
    const statusRaw = pick(rec, 'status');
    const status = /^\d{3}$/.test(statusRaw) ? Number(statusRaw) : 301;
    const enabled = pick(rec, 'enabled');
    return {
      line: ext === '.json' ? i + 1 : i + 2,
      from: pick(rec, 'from'),
      to: pick(rec, 'to'),
      status,
      group: pick(rec, 'group') || 'default',
      enabled: !OFF.has(enabled.toLowerCase()),
      note: pick(rec, 'note'),
    };
  });
}

/** Path + query of a URL or path, for comparisons. Returns null for unparseable input. */
export function toPath(u) {
  if (!u) return null;
  try {
    const url = new URL(u, 'http://placeholder.invalid');
    return url.pathname + url.search;
  } catch { return null; }
}

export const isAbsolute = u => /^https?:\/\//i.test(u || '');
export const hostOf = u => { try { return new URL(u).host.toLowerCase(); } catch { return null; } };

/** Logical key for "same page, different spelling": case, trailing slash, common legacy extensions. */
export function logicalKey(p) {
  const pathOnly = (toPath(p) || '').split('?')[0].toLowerCase();
  return pathOnly.replace(/\/index\.(html?|php|aspx?|cfm|jsp)$/, '/').replace(/\.(html?|php|aspx?|cfm|jsp)$/, '').replace(/\/+$/, '') || '/';
}
