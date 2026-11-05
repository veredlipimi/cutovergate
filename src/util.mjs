// Shared helpers: argument parsing, concurrency pool, CSV, files.
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.0';
export const USER_AGENT = `CutoverGate/${VERSION} (+https://github.com/veredlipimi/cutovergate)`;

/** Minimal flag parser: --key value, --flag, positional args. */
export function parseArgs(argv, booleans = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = (eq > -1 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq > -1) out[key] = a.slice(eq + 1);
    else if (booleans.includes(key) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

export async function runPool(items, concurrency, fn, { delayMs = 0 } = {}) {
  let idx = 0;
  const results = new Array(items.length);
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) || 1 }, worker));
  return results;
}

/** RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF). Also handles TSV when sep='\t'. */
export function parseCsv(text, sep) {
  text = text.replace(/^﻿/, '');
  if (!sep) {
    const first = text.split(/\r?\n/, 1)[0];
    sep = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
  }
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

export function toCsv(rows, columns) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map(r => columns.map(c => esc(r[c])).join(','))].join('\n') + '\n';
}

export const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
export const writeJson = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n');
};

export const safeName = s => String(s).replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]+/gi, '_').replace(/^_+|_+$/g, '');
export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

export function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

/** Colors only on a TTY and when NO_COLOR is unset. */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = code => s => useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s);
export const c = { red: wrap(31), green: wrap(32), yellow: wrap(33), dim: wrap(2), bold: wrap(1), cyan: wrap(36) };
