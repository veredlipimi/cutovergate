// Run: node --test   (no dependencies; Node 18+)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startNewPlatform, startLegacy } from './mock-server.mjs';
import { loadMap, logicalKey } from '../src/map.mjs';
import { preflight } from '../src/preflight.mjs';
import { runSite } from '../src/run.mjs';
import { detectOrigin, parseFingerprint, parseCandidates } from '../src/probe.mjs';
import { evaluateGate, addException, loadExceptions, triageExceptions } from '../src/gate.mjs';
import { checkFiles } from '../src/files.mjs';
import { parseCsv } from '../src/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => path.join(here, 'fixtures', f);
const cli = path.join(here, '..', 'bin', 'cutovergate.mjs');
let site, old, tmp;

before(async () => {
  site = await startNewPlatform();
  old = await startLegacy();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutovergate-test-'));
});
after(async () => { await site.close(); await old.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const opts = (extra = {}) => ({ outDir: path.join(tmp, extra.name || 'runs'), timeoutMs: 1500, concurrency: 8, ...extra });
const writeTmp = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f; };
const byFrom = run => Object.fromEntries(run.results.map(r => [r.from, r]));

// ---------------------------------------------------------------- map parsing
test('CSV parser handles quotes, embedded commas and CRLF', () => {
  const rows = parseCsv('from,to,note\r\n/a,/b,"x, ""quoted"""\r\n');
  assert.deepEqual(rows[1], ['/a', '/b', 'x, "quoted"']);
});

test('map loader accepts aliases, headerless CSV and JSON', () => {
  const f1 = path.join(tmp, 'alias.csv');
  fs.writeFileSync(f1, 'Old URL,New URL,Section\n/x,/y,blog\n');
  const r1 = loadMap(f1)[0];
  assert.equal(r1.from, '/x'); assert.equal(r1.to, '/y'); assert.equal(r1.group, 'blog'); assert.equal(r1.status, 301);
  const f2 = path.join(tmp, 'nohead.csv');
  fs.writeFileSync(f2, '/x,/y,308\n');
  assert.equal(loadMap(f2)[0].status, 308);
  const f3 = path.join(tmp, 'm.json');
  fs.writeFileSync(f3, JSON.stringify({ '/p': '/q' }));
  assert.equal(loadMap(f3)[0].to, '/q');
});

test('logical key groups spelling variants of one page', () => {
  assert.equal(logicalKey('/Contact_Us.htm'), logicalKey('/contact_us/'));
  assert.equal(logicalKey('/team.php'), logicalKey('/team'));
  assert.notEqual(logicalKey('/team'), logicalKey('/teams'));
});

// ---------------------------------------------------------------- pre-flight
test('pre-flight catches every planted map problem', () => {
  const res = preflight(loadMap(fx('preflight-bad.csv')), { legacyUrls: fs.readFileSync(fx('legacy-urls.txt'), 'utf8').trim().split('\n') });
  const codes = res.issues.map(i => `${i.code}:${i.from}`);
  const has = (code, from) => assert.ok(codes.some(x => x === `${code}:${from}` || (from === undefined && x.startsWith(code + ':'))), `expected ${code} ${from ?? ''}\n${codes.join('\n')}`);
  has('CHAIN_IN_MAP', '/a');
  has('LOOP_IN_MAP');
  has('SELF_REDIRECT', '/same');
  has('DUPLICATE_SOURCE', '/dup');
  has('DUPLICATE_ROW', '/dup2');
  has('MISSING_TARGET', '/no-target');
  has('INVALID_SOURCE', 'not-a-path');
  has('VARIANT_CONFLICT');
  has('VARIANT_DUPLICATE');
  has('QUERY_IN_SOURCE', '/q?id=1');
  has('UNENCODED_CHARS', '/space here');
  has('TARGET_TOO_LONG', '/long');
  has('EXTERNAL_TARGET', '/ext');
  has('RETIRED_PAGE', '/gone');
  has('UNEXPECTED_STATUS', '/weird');
  has('ROW_DISABLED', '/off');
  has('UNMAPPED_LEGACY_URL', '/never-mapped');
  has('UNMAPPED_LEGACY_URL', '/legacy/unmapped.html');
  assert.ok(!codes.includes('UNMAPPED_LEGACY_URL:/team.htm'), 'variant spelling counts as covered');
  assert.ok(!codes.includes('UNMAPPED_LEGACY_URL:/a'));
  assert.equal(res.issues.filter(i => i.code === 'LOOP_IN_MAP').length, 1, 'a loop is reported once');
  assert.equal(res.ok, false);
});

test('pre-flight: a clean map passes', () => {
  const f = path.join(tmp, 'clean.csv');
  fs.writeFileSync(f, 'from,to\n/a,/x\n/b,/y\n');
  const res = preflight(loadMap(f));
  assert.equal(res.ok, true); assert.equal(res.issues.length, 0); assert.equal(res.rules.length, 2);
});

// ---------------------------------------------------------------- live probe: every result type
let mainRun;
test('probe classifies every result type correctly', async () => {
  mainRun = await runSite({ map: fx('map.csv'), origin: site.url }, opts({ name: 'main', checkTargets: true }));
  const r = byFrom(mainRun);
  const expect = {
    '/old-pass': 'PASS', '/old-308': 'PASS', '/old-slash': 'PASS', '/old-302': 'WRONG_STATUS', '/old-wrong': 'WRONG_TARGET',
    '/old-home-1': 'WRONG_TARGET', '/old-chain': 'CHAIN', '/old-target-moves': 'CHAIN', '/old-loop': 'LOOP',
    '/old-broken': 'TARGET_BROKEN', '/old-any': 'REDIRECT_OK', '/old-abs': 'PASS', '/old-query?id=7': 'PASS',
    '/old-missing': 'MISSING', '/old-200': 'MISSING', '/retired': 'GONE_OK',
  };
  for (const [from, want] of Object.entries(expect)) assert.equal(r[from]?.result, want, `${from}: ${r[from]?.result} (${r[from]?.detail})`);
  assert.match(r['/old-slash'].detail, /trailing slash/);
  assert.match(r['/old-home-1'].detail, /homepage/);
  assert.match(r['/old-200'].detail, /served without a redirect/);
  assert.ok(!r['/old-disabled'], 'disabled rows are not probed');
});

test('an ERROR is reported on timeout, never a pass', async () => {
  const f = path.join(tmp, 'slow.csv');
  fs.writeFileSync(f, 'from,to\n/old-slow,/new-pass\n');
  const run = await runSite({ map: f, origin: site.url }, opts({ name: 'slow', timeoutMs: 400 }));
  assert.equal(run.results[0].result, 'ERROR');
  assert.equal(run.gate.status, 'FAIL');
});

test('--accept 301,302 lets temporary redirects pass', async () => {
  const f = path.join(tmp, 'temp.csv');
  fs.writeFileSync(f, 'from,to\n/old-302,/new-302\n');
  const run = await runSite({ map: f, origin: site.url }, opts({ name: 'accept', accept: [301, 302, 308] }));
  assert.equal(run.results[0].result, 'PASS');
});

// ---------------------------------------------------------------- taxonomy
test('failure taxonomy groups failures and produces triage hints', () => {
  const t = mainRun.taxonomy;
  assert.equal(t.matrix.shop.MISSING, 2);
  const text = t.hints.map(h => h.text).join('\n');
  const ids = t.hints.map(h => h.id);
  assert.equal(new Set(ids).size, ids.length, 'one hint per result type');
  assert.match(text, /Every rule in "shop" is MISSING/);
  assert.match(text, /"docs" points to the wrong target/);
  assert.match(text, /Also: 2 go to the homepage/, 'a second cause is a clause, not a second hint');
  assert.match(text, /temporary redirect/);
  assert.match(text, /redirect loop/);
  assert.match(text, /on a broken page/);
  assert.ok(!/"blog"/.test(text), 'a healthy group gets no hint');
});

// ---------------------------------------------------------------- exceptions and gate
test('gate: effective failures = 0 → PASS; exceptions need a reason; expired ones do not apply', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const rows = () => [
    { from: '/a', result: 'MISSING' }, { from: '/b', result: 'WRONG_TARGET' }, { from: '/c', result: 'ERROR' }, { from: '/d', result: 'PASS' },
  ];
  const ex = [
    { path: '/a', reason: 'Page retired, owner approved', expires: null },
    { path: '/b', reason: 'Fix pending', expires: '2026-05-01' },
    { path: '/c' },
  ];
  const g = evaluateGate(rows(), ex, { now });
  assert.equal(g.excepted, 1); assert.equal(g.effectiveFailures, 2); assert.equal(g.status, 'FAIL');
  assert.equal(g.exceptions.expired.length, 1); assert.equal(g.exceptions.invalid.length, 1);
  const all = [{ path: '/a', reason: 'r' }, { path: '/b', reason: 'r' }, { path: '/c', reason: 'flaky' }];
  assert.equal(evaluateGate(rows(), all, { now }).status, 'PASS');
  const strict = evaluateGate(rows(), all, { now, strict: true });
  assert.equal(strict.status, 'FAIL', 'strict: ERROR blocks even when excepted');
  assert.equal(strict.effectiveFailures, 1);
});

test('exceptions: glob paths, TTL choices, expiring-soon warning, reason mandatory', () => {
  const f = path.join(tmp, 'ex.json');
  const now = new Date('2026-06-01T12:00:00Z');
  assert.throws(() => addException(f, { path: '/x', reason: '  ' }, now), /reason is required/);
  assert.throws(() => addException(f, { path: '/x', reason: 'r', ttl: '5' }, now), /ttl must be/);
  const e7 = addException(f, { path: '/blog/*', reason: 'hotfix PR', ttl: '7' }, now);
  assert.equal(e7.expires, '2026-06-08');
  addException(f, { path: '/retired-page', reason: 'retired', ttl: 'none' }, now);
  const list = loadExceptions(f);
  assert.equal(list.length, 2);
  const t = triageExceptions(list, new Date('2026-06-03T00:00:00Z'));
  assert.equal(t.expiringSoon.length, 1);
  const g = evaluateGate([{ from: '/blog/old-post', result: 'MISSING' }], list, { now });
  assert.equal(g.status, 'PASS');
});

test('excepted rows are still probed and shown', async () => {
  const exFile = path.join(tmp, 'ex-run.json');
  for (const p of ['/old-302', '/old-wrong', '/old-home-*', '/old-chain', '/old-target-moves', '/old-loop', '/old-missing', '/old-200', '/shop/*', '/docs/*'])
    addException(exFile, { path: p, reason: 'known', ttl: '30' });
  const run = await runSite({ map: fx('map.csv'), origin: site.url, exceptions: exFile }, opts({ name: 'exc' }));
  assert.equal(run.gate.status, 'PASS', JSON.stringify(run.results.filter(r => !r.ok && !r.excepted).map(r => r.from)));
  assert.ok(run.results.some(r => r.excepted && r.from === '/old-302'));
  assert.equal(run.results.length, mainRun.results.length);
});

// ---------------------------------------------------------------- origin auto-detection
test('origin detection: picks the first candidate that matches the fingerprint', async () => {
  const fp = parseFingerprint('header:x-platform=newcms');
  const a = await detectOrigin([{ label: 'staging', url: old.url }, { label: 'live', url: site.url }], fp);
  assert.equal(a.phase, 'live'); assert.equal(a.origin, site.url);
  const b = await detectOrigin([{ label: 'staging', url: site.url }, { label: 'live', url: old.url }], fp);
  assert.equal(b.phase, 'staging');
  const none = await detectOrigin([{ label: 'staging', url: old.url }], fp);
  assert.equal(none.origin, null); assert.equal(none.reason, 'not-on-target');
  const dead = await detectOrigin([{ label: 'x', url: 'http://127.0.0.1:9' }], fp, { timeoutMs: 1000 });
  assert.equal(dead.reason, 'unreachable');
  const body = await detectOrigin([{ label: 'live', url: site.url }], parseFingerprint('body:new platform'));
  assert.equal(body.phase, 'live');
});

test('candidate spec parsing', () => {
  assert.deepEqual(parseCandidates('staging=https://s.example,live=https://www.example'), [{ label: 'staging', url: 'https://s.example' }, { label: 'live', url: 'https://www.example' }]);
  assert.equal(parseCandidates('https://a,https://b')[1].label, 'live');
  assert.throws(() => parseFingerprint('nope'));
});

test('a site still on the old server is skipped, not passed', async () => {
  const run = await runSite({ map: fx('map.csv'), candidates: `staging=${old.url}`, fingerprint: 'header:x-platform' }, opts({ name: 'skip' }));
  assert.equal(run.skipped, true); assert.equal(run.reason, 'not-on-target');
});

// ---------------------------------------------------------------- delta
test('delta: regressions, new failures and fixes across runs; post-cutover compares to pre-cutover', async () => {
  const dir = path.join(tmp, 'delta');
  const hist = path.join(dir, 'history');
  const m1 = path.join(tmp, 'd1.csv'), m2 = path.join(tmp, 'd2.csv');
  fs.writeFileSync(m1, 'from,to\n/old-pass,/new-pass\n/old-missing,/x\n');
  // run 2: /old-pass now expected elsewhere (regression), /old-missing gone from map, /old-wrong new
  fs.writeFileSync(m2, 'from,to\n/old-pass,/changed\n/old-wrong,/right\n/old-missing,/x\n');
  const cand = `staging=${site.url}`;
  const r1 = await runSite({ map: m1, candidates: cand, domain: 'www.example.test' }, opts({ name: 'delta', historyDir: hist }));
  assert.equal(r1.delta, null);
  const r2 = await runSite({ map: m2, candidates: cand, domain: 'www.example.test' }, opts({ name: 'delta', historyDir: hist }));
  assert.deepEqual(r2.delta.regressions.map(x => x.from), ['/old-pass']);
  assert.deepEqual(r2.delta.added.map(x => x.from), ['/old-wrong']);
  const r3 = await runSite({ map: m1, candidates: `live=${site.url}`, domain: 'www.example.test' }, opts({ name: 'delta', historyDir: hist, compareTo: 'other-phase' }));
  assert.equal(r3.delta.previousPhase, 'staging');
  assert.deepEqual(r3.delta.fixed.map(x => x.from), ['/old-pass']);
});

// ---------------------------------------------------------------- exports
test('exports: JSON, CSV and self-contained HTML with the expected filename', () => {
  for (const k of ['json', 'csv', 'html']) {
    assert.ok(fs.existsSync(mainRun.files[k]), k);
    assert.match(path.basename(mainRun.files[k]), /^redirect-qa-127\.0\.0\.1_\d+-\d{8}-\d{6}\./);
  }
  const html = fs.readFileSync(mainRun.files.html, 'utf8');
  assert.match(html, /GATE FAIL/);
  assert.ok(!/<script[^>]+src=/i.test(html) && !/<link[^>]+stylesheet/i.test(html), 'no external assets');
  const csv = parseCsv(fs.readFileSync(mainRun.files.csv, 'utf8'));
  assert.equal(csv.length, mainRun.results.length + 1);
});

// ---------------------------------------------------------------- linked files
test('files: OK, BROKEN, SOFT_404, HEAD-refused fallback, page scan', async () => {
  const res = await checkFiles({ origin: site.url, pages: ['/page-with-links'], hrefs: ['/files/ok.pdf', 'files/missing.pdf'] });
  const by = Object.fromEntries(res.results.map(r => [new URL(r.resolvedUrl).pathname, r.result]));
  assert.equal(by['/files/ok.pdf'], 'OK');
  assert.equal(by['/files/missing.pdf'], 'BROKEN');
  assert.equal(by['/files/soft.pdf'], 'SOFT_404');
  assert.equal(by['/files/nohead.pdf'], 'OK');
  assert.equal(by['/downloads/report.docx'], 'OK');
  assert.ok(!('/about' in by), 'ordinary page links are not file checks');
  assert.equal(res.results.find(r => r.resolvedUrl.endsWith('/files/ok.pdf')).foundOn.length, 2, 'deduped with all sources kept');
});

// ---------------------------------------------------------------- CLI
// Async on purpose: the mock servers live in this process, so a sync child would deadlock them.
const run = (args) => new Promise(resolve => execFile(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
  (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr })));

test('CLI exit codes: preflight, probe, verify, batch, exceptions, usage', async () => {
  assert.equal((await run(['preflight', '--map', fx('preflight-bad.csv')])).code, 1);
  const clean = path.join(tmp, 'cli-clean.csv'); fs.writeFileSync(clean, 'from,to\n/old-pass,/new-pass\n/old-308,/new-pass\n');
  assert.equal((await run(['preflight', '--map', clean])).code, 0);
  const p = await run(['probe', '--map', clean, '--origin', site.url, '--out', path.join(tmp, 'cli')]);
  assert.equal(p.code, 0, p.out); assert.match(p.out, /GATE PASS/);
  assert.equal((await run(['probe', '--map', fx('map.csv'), '--origin', site.url, '--out', path.join(tmp, 'cli'), '--quiet', '--timeout-ms', '1500'])).code, 1);
  assert.equal((await run(['probe', '--map', clean])).code, 2);
  const v = await run(['verify', '--map', clean, '--candidates', `staging=${site.url}`, '--out', path.join(tmp, 'cli')]);
  assert.equal(v.code, 1); assert.match(v.out, /expected phase "live"/);
  const exf = path.join(tmp, 'cli-ex.json');
  assert.equal((await run(['exceptions', 'add', '--file', exf, '--path', '/x'])).code, 2, 'reason is mandatory');
  assert.equal((await run(['exceptions', 'add', '--file', exf, '--path', '/x', '--reason', 'retired', '--ttl', 'none'])).code, 0);
  assert.match((await run(['exceptions', 'list', '--file', exf])).out, /\/x\s+no expiry/);
  const sites = path.join(tmp, 'sites.json');
  fs.writeFileSync(sites, JSON.stringify({ fingerprint: 'header:x-platform', sites: [
    { domain: 'good.test', map: clean, candidates: `staging=${site.url}` },
    { domain: 'old.test', map: clean, candidates: `staging=${old.url}` },
  ] }));
  const b = await run(['batch', '--sites', sites, '--out', path.join(tmp, 'batch')]);
  assert.equal(b.code, 1, b.out); assert.match(b.out, /1\/2 sites pass/); assert.match(b.out, /SKIP/);
  assert.equal((await run(['nope'])).code, 2);
});

// ---------------------------------------------------------------- web-qa-agent bridge
import { toAgentFindings, targetPages, findAgent } from '../src/agent-bridge.mjs';

test('bridge: converts a run to web-qa-agent findings; excepted rows are not gaps', () => {
  const fake = { ...mainRun, results: mainRun.results.map(r => r.from === '/old-wrong' ? { ...r, excepted: { reason: 'known' } } : r) };
  const out = toAgentFindings(fake);
  assert.equal(out.engine, 'cutovergate');
  const by = Object.fromEntries(out.results.map(r => [r.from, r.result]));
  assert.equal(by['/old-302'], 'WRONG-STATUS'); assert.equal(by['/old-missing'], 'MISSING'); assert.equal(by['/old-any'], 'PASS'); assert.equal(by['/old-loop'], 'LOOP');
  assert.ok(!out.findings.some(f => f.title.includes('/old-wrong')), 'excepted is not a gap');
  assert.ok(out.findings.every(f => f.steps.length && f.expected && f.actual && f.severity));
  assert.equal(out.findings.find(f => f.title.includes('/old-missing')).severity, 'High');
});

test('bridge: target pages are deduped, same-site only and spread across groups', () => {
  const t = targetPages(mainRun, 3);
  assert.equal(t.pages.length, 3);
  assert.equal(new Set(t.pages).size, 3);
  assert.ok(t.pages.every(u => u.startsWith(mainRun.origin)));
  const groups = new Set(t.pages.map(u => mainRun.results.find(r => mainRun.origin + r.actual === u).group));
  assert.ok(groups.size >= 2, 'round-robin across groups');
  assert.equal(findAgent('/nonexistent/path') === '/nonexistent/path', false);
});

// ---------------------------------------------------------------- harvest + "*" rules
import { cleanPaths } from '../src/harvest.mjs';

test('harvest: keeps pages, drops assets and duplicates; tracking params are stripped, the page kept once', () => {
  const out = cleanPaths(['http://old.example/', 'http://old.example/about/', 'http://old.example/about', 'http://old.example/style.css',
    'http://old.example/wp-json/x', 'http://old.example/blog/post-1?utm_source=x', 'http://old.example/blog/post-1', 'http://old.example/shop/item?id=4', 'http://old.example/feed/']);
  assert.deepEqual(out, ['/', '/about/', '/blog/post-1', '/shop/item?id=4']);
});

test('harvest: Wayback noise never becomes a legacy URL', () => {
  const noise = [
    'http://old.example/.well-known/nodeinfo', 'http://old.example/.well-known/openid-configuration', // protocol endpoints
    'http://old.example/404/', 'http://old.example/not-found', 'http://old.example/error.html',       // the old site's error page
    'http://old.example/)', 'http://old.example/2)', 'http://old.example/%22?ref=x', "http://old.example/it's%20here", // broken links
    'http://old.example/?ref=news.example', 'http://old.example/?ver=3.8.3', 'http://old.example/?Social+Account=x', // homepage variants
  ];
  assert.deepEqual(cleanPaths(['http://old.example/', ...noise]), ['/']);
  // tracking stripped, a real query kept
  assert.deepEqual(cleanPaths(['http://old.example/post/?es_p=123', 'http://old.example/post/?ref=x&lang=fr', 'http://old.example/index.php?page_id=7']),
    ['/index.php?page_id=7', '/post/', '/post/?lang=fr']);
  // a slug that ends in "?" keeps its "?" (it is part of the title, not an empty query)
  assert.deepEqual(cleanPaths(['http://old.example/blog/is-it-worth-it?']), ['/blog/is-it-worth-it?']);
  // a page whose name only contains "error" is a real page
  assert.deepEqual(cleanPaths(['http://old.example/blog/error-handling-guide/']), ['/blog/error-handling-guide/']);
});

test('"*" rules: a deep page sent to the homepage is a gap; a broken landing page is a gap', async () => {
  const f = path.join(tmp, 'any.csv');
  fs.writeFileSync(f, 'from,to\n/old-home-1,*\n/old-broken,*\n/old-any,*\n');
  const run = await runSite({ map: f, origin: site.url }, opts({ name: 'any', checkTargets: true }));
  const r = byFrom(run);
  assert.equal(r['/old-home-1'].result, 'WRONG_TARGET'); assert.match(r['/old-home-1'].detail, /homepage/);
  assert.equal(r['/old-broken'].result, 'TARGET_BROKEN');
  assert.equal(r['/old-any'].result, 'REDIRECT_OK');
});

// ---------------------------------------------------------------- suspect changes + Slack
import http from 'node:http';
import { parseRepo, describeCommit, suspectChanges } from '../src/changes.mjs';
import { shouldNotify, shouldNotifyBatch, runMessage, batchMessage, runSummary, toTeams } from '../src/notify.mjs';

/** A fake GitHub API and Slack webhook in one server; records every request. */
function fakeServices() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/repos/acme/site-config/commits') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify([
          { sha: 'a1b2c3d4e5', html_url: 'https://gh.test/acme/site-config/commit/a1b2c3d', commit: { message: 'Merge pull request #42 from acme/strip-slash\n\nNormalize trailing slashes', author: { name: 'Dana' }, committer: { date: '2026-11-07T10:00:00Z' } } },
          { sha: 'f6e5d4c3b2', html_url: 'https://gh.test/acme/site-config/commit/f6e5d4c', commit: { message: 'Update newsletter redirects (#41)', author: { name: 'Omer' }, committer: { date: '2026-11-06T09:00:00Z' } } },
        ]));
      }
      if (u.pathname.startsWith('/repos/')) { res.writeHead(404); return res.end('{}'); }
      if (u.pathname === '/slack' || u.pathname === '/teams') { res.writeHead(u.pathname === '/teams' ? 202 : 200); return res.end('ok'); }
      res.writeHead(404); res.end();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise(x => { server.closeAllConnections?.(); server.close(x); }) })));
}

test('changes: repo spec and commit titles are parsed', () => {
  assert.deepEqual(parseRepo('acme/site-config'), { owner: 'acme', name: 'site-config' });
  assert.deepEqual(parseRepo('https://github.com/acme/site-config.git'), { owner: 'acme', name: 'site-config' });
  assert.equal(parseRepo('not a repo'), null);
  assert.deepEqual(describeCommit('Merge pull request #42 from a/b\n\nbody'), { title: 'Merge pull request #42 from a/b', pr: 42 });
  assert.equal(describeCommit('Fix redirects (#7)').pr, 7);
  assert.equal(describeCommit('Plain commit').pr, null);
});

test('changes: a regression lists the commits between the two runs; nothing is fetched on a clean run', async () => {
  const gh = await fakeServices();
  try {
    const hist = path.join(tmp, 'suspects-history');
    const m1 = path.join(tmp, 's1.csv'), m2 = path.join(tmp, 's2.csv');
    fs.writeFileSync(m1, 'from,to\n/old-pass,/new-pass\n');
    fs.writeFileSync(m2, 'from,to\n/old-pass,/changed\n');
    const changes = { repo: 'acme/site-config', path: 'redirects', api: gh.url, token: 't0ken' };
    const o = opts({ name: 'suspects', historyDir: hist, changes });
    const r1 = await runSite({ map: m1, origin: site.url, domain: 'sus.example.test' }, o);
    assert.equal(r1.suspects, undefined, 'first run: no delta, no lookup');
    const r1b = await runSite({ map: m1, origin: site.url, domain: 'sus.example.test' }, o);
    assert.equal(r1b.suspects, undefined, 'nothing got worse: no lookup');
    assert.equal(gh.seen.length, 0);

    const r2 = await runSite({ map: m2, origin: site.url, domain: 'sus.example.test' }, o);
    assert.equal(r2.delta.regressions.length, 1);
    assert.equal(r2.suspects.error, null);
    assert.deepEqual(r2.suspects.commits.map(c => [c.short, c.pr, c.author]), [['a1b2c3d', 42, 'Dana'], ['f6e5d4c', 41, 'Omer']]);
    const q = new URL(gh.seen[0].url, 'http://x').searchParams;
    assert.equal(q.get('since'), r1b.at, 'window starts at the previous run');
    assert.equal(q.get('until'), r2.at);
    assert.equal(q.get('path'), 'redirects');
    assert.equal(gh.seen[0].headers.authorization, 'Bearer t0ken');
    const html = fs.readFileSync(r2.files.html, 'utf8');
    assert.match(html, /Changes in acme\/site-config\/redirects/);
    assert.match(html, /Merge pull request #42/);
    assert.equal(r2.gate.status, 'FAIL');
  } finally { await gh.close(); }
});

test('changes: an API problem is reported, never breaks the run', async () => {
  const gh = await fakeServices();
  try {
    const s = await suspectChanges({ repo: 'acme/private', since: '2026-11-01T00:00:00Z', until: '2026-11-02T00:00:00Z', api: gh.url });
    assert.match(s.error, /404.*GITHUB_TOKEN/);
    assert.deepEqual(s.commits, []);
    const bad = await suspectChanges({ repo: 'nope', since: 'x', until: 'y', api: gh.url });
    assert.match(bad.error, /not a repository/);
  } finally { await gh.close(); }
});

test('notifications: when to notify, and what Slack and Teams messages say', () => {
  const run = (status, regressions = []) => ({
    domain: 'www.example.test', phase: 'live', gate: { status, strict: false, probed: 10, passed: status === 'PASS' ? 10 : 8, excepted: 0, effectiveFailures: status === 'PASS' ? 0 : 2 },
    delta: { previousRun: 'r1', regressions, added: [], fixed: [] },
    results: status === 'PASS' ? [] : [{ from: '/a', ok: false, result: 'MISSING', detail: 'HTTP 404' }, { from: '/b', ok: false, result: 'WRONG_TARGET' }],
    taxonomy: { hints: [] },
    suspects: { repo: 'acme/site-config', path: null, commits: [{ short: 'a1b2c3d', title: 'Merge pull request #42', author: 'Dana', url: 'https://gh.test/c' }] },
  });
  const reg = [{ from: '/a', was: 'PASS', result: 'MISSING' }];
  assert.equal(shouldNotify(run('PASS'), 'fail'), false);
  assert.equal(shouldNotify(run('FAIL'), 'fail'), true);
  assert.equal(shouldNotify(run('PASS', reg), 'fail'), true, 'a regression always counts');
  assert.equal(shouldNotify(run('FAIL'), 'regression'), false);
  assert.equal(shouldNotify(run('PASS'), 'always'), true);
  const text = runMessage(run('FAIL', reg)).text;
  assert.match(text, /gate FAIL/);
  assert.match(text, /`\/a` PASS → MISSING/);
  assert.match(text, /`\/b` WRONG_TARGET/);
  assert.ok(!/`\/a` MISSING/.test(text), 'a regression is not listed twice');
  assert.match(text, /<https:\/\/gh\.test\/c\|a1b2c3d>/);
  assert.match(batchMessage([{ domain: 'a', gate: 'PASS' }, { domain: 'b', gate: 'FAIL', regressions: 2 }]).text, /1\/2 sites pass[\s\S]*\*b\* FAIL · 2 regressions/);
  assert.equal(shouldNotifyBatch([{ gate: 'PASS' }], 'fail'), false);
  assert.equal(shouldNotifyBatch([{ gate: 'PASS', regressions: 1 }], 'fail'), true);
  assert.equal(shouldNotifyBatch([{ gate: 'FAIL' }], 'regression'), false);

  // Teams: an Adaptive Card in the envelope Workflows webhooks expect
  const card = toTeams(runSummary(run('FAIL', reg)));
  assert.equal(card.type, 'message');
  assert.equal(card.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  const body = card.attachments[0].content.body;
  assert.equal(card.attachments[0].content.version, '1.4');
  assert.equal(body[0].color, 'Attention');
  const facts = Object.fromEntries(body.find(b => b.type === 'FactSet').facts.map(f => [f.title, f.value]));
  assert.equal(facts.Gate, 'FAIL'); assert.equal(facts['Effective failures'], '2');
  const all = body.map(b => b.text || '').join('\n');
  assert.match(all, /`\/a` PASS → MISSING/);
  assert.match(all, /\[a1b2c3d\]\(https:\/\/gh\.test\/c\)/);
  assert.equal(toTeams(runSummary(run('PASS'))).attachments[0].content.body[0].color, 'Good');
});

test('CLI: --notify-slack and --notify-teams post on a failing gate and stay quiet on a pass', async () => {
  const hook = await fakeServices();
  const run = args => new Promise(r => execFile(process.execPath, [cli, ...args], { env: { ...process.env, NO_COLOR: '1' } }, (e, out, err) => r({ code: e ? e.code : 0, out, err })));
  try {
    const good = path.join(tmp, 'slack-good.csv'), bad = path.join(tmp, 'slack-bad.csv');
    fs.writeFileSync(good, 'from,to\n/old-pass,/new-pass\n');
    fs.writeFileSync(bad, 'from,to\n/old-missing,/x\n');
    const base = ['--origin', site.url, '--out', path.join(tmp, 'slack-runs'), '--notify-slack', `${hook.url}/slack`, '--notify-teams', `${hook.url}/teams`, '--quiet'];
    assert.equal((await run(['probe', '--map', good, ...base])).code, 0);
    assert.equal(hook.seen.length, 0);
    const r = await run(['probe', '--map', bad, ...base]);
    assert.equal(r.code, 1);
    assert.equal(hook.seen.length, 2);
    const slack = hook.seen.find(x => x.url === '/slack'), teams = hook.seen.find(x => x.url === '/teams');
    assert.match(JSON.parse(slack.body).text, /gate FAIL[\s\S]*\/old-missing/);
    assert.equal(JSON.parse(teams.body).attachments[0].content.type, 'AdaptiveCard');
    assert.match(r.out, /teams notified/);
    assert.equal((await run(['probe', '--map', good, ...base, '--notify-on', 'sometimes'])).code, 2);
  } finally { await hook.close(); }
});

// ---------------------------------------------------------------- triage hints: one clear hint per failure type
import { triageHints, parseHints, loadHints, patternKeys, BUILTIN_IDS } from '../src/hints.mjs';

const row = (from, result, extra = {}) => ({ from, to: extra.to ?? '/x', group: extra.group ?? 'g', result, ok: false, httpStatus: extra.status ?? 301, location: extra.location ?? null, actual: extra.actual ?? null, ...extra });
const only = (hs, id) => { const f = hs.filter(h => h.id === id); assert.equal(f.length, 1, `exactly one ${id} hint`); return f[0]; };

test('hints: built-in ids are the result types — one hint per kind of failure, never two', () => {
  assert.deepEqual(BUILTIN_IDS, ['MISSING', 'WRONG_TARGET', 'TARGET_BROKEN', 'WRONG_STATUS', 'CHAIN', 'LOOP', 'ERROR']);
  const results = [
    ...['/k/a.1.aspx', '/k/b.2.aspx', '/k/c.3.aspx'].map(f => row(f, 'MISSING', { status: 400, group: 'legacy' })),
    row('/p', 'MISSING', { status: 200 }), row('/q', 'MISSING', { status: 200 }),
    row('/h1', 'WRONG_TARGET', { actual: '/' }), row('/h2', 'WRONG_TARGET', { actual: '/' }),
  ];
  const hs = triageHints(results, { legacy: { total: 3, MISSING: 3 } });
  assert.deepEqual(hs.map(h => h.id), ['MISSING', 'WRONG_TARGET']);
  for (const h of hs) assert.equal(h.source, 'builtin');
});

test('hints MISSING: the cause that explains the most rows leads; others are one short clause', () => {
  const refused = ['/k/a.1.aspx', '/k/b.2.aspx', '/k/c.3.aspx'].map(f => row(f, 'MISSING', { status: 400, group: 'legacy' }));
  const h = only(triageHints([...refused, row('/p', 'MISSING', { status: 200 }), row('/q', 'MISSING', { status: 200 })], { legacy: { total: 3, MISSING: 3 } }), 'MISSING');
  assert.equal(h.cause, 'refused'); assert.equal(h.count, 5);
  assert.match(h.text, /^\[3 of 5\] 3 legacy URLs answer HTTP 400 with no redirect/, 'the lead says how much it covers');
  assert.match(h.text, /adding rules will not help/);
  assert.match(h.text, /Also: 2 answer 200 \(Possible: not served by the new platform yet\)\.$/, 'inferred causes are labelled in the clause too');
  assert.deepEqual(h.causes.map(c => [c.cause, c.evidence, c.count]), [['refused', 'Possible', 3], ['served-200', 'Possible', 2]]);
  assert.equal(h.causes.reduce((a, c) => a + c.count, 0), h.count, 'every row counted exactly once');
  assert.ok(!/never deployed|pattern/.test(h.text), 'refused rows are not also blamed on deploy or a missing pattern rule');
  // the same shape answering 404 is a deploy problem
  const h404 = only(triageHints(refused.map(r => ({ ...r, httpStatus: 404 })), { legacy: { total: 3, MISSING: 3 } }), 'MISSING');
  assert.equal(h404.cause, 'group-not-deployed');
  // 403 is named as possible bot protection
  assert.match(only(triageHints([row('/a', 'MISSING', { status: 403 }), row('/b', 'MISSING', { status: 403 })], {}), 'MISSING').text, /Possible: bot protection/);
});

test('hints MISSING: shared path shape → one pattern rule', () => {
  assert.deepEqual(patternKeys('/docs/intro.12.aspx'), ['*.N.aspx', '/docs/*']);
  assert.deepEqual(patternKeys('/contact'), []);
  const results = ['/p/one.1.aspx', '/q/two.2.aspx', '/r/three.3.aspx', '/solo'].map(f => row(f, 'MISSING', { status: 404 }));
  const h = only(triageHints(results, {}), 'MISSING');
  assert.equal(h.cause, 'shared-pattern');
  assert.match(h.text, /^\[3 of 4\] 3 legacy URLs with no redirect share the pattern "\*\.N\.aspx"/);
  assert.match(h.text, /Also: 1 with no common cause\./);
  assert.deepEqual(h.causes.map(c => [c.cause, c.count]), [['shared-pattern', 3], ['unspecified', 1]]);
  const generic = only(triageHints([row('/a', 'MISSING', { status: 404 })], {}), 'MISSING');
  assert.equal(generic.cause, 'unspecified'); assert.match(generic.text, /^1 legacy URL has no redirect/, 'no [k of N] when one cause covers all');
  assert.match(generic.text, /add a rule for each, or retire them with 410/);
  assert.deepEqual(generic.causes, [{ cause: 'unspecified', evidence: 'observed', count: 1, from: ['/a'] }]);
});

test('hints WRONG_TARGET: trailing slash dropped before the rule matches', () => {
  const h = only(triageHints([row('/section/page/', 'WRONG_TARGET', { to: '/page', location: '/section/page', actual: '/section/page' })], {}), 'WRONG_TARGET');
  assert.equal(h.cause, 'trailing-slash-stripped'); assert.match(h.text, /without the slash/);
  // a rule that maps a slash URL to its own slash-less form is not this pattern
  assert.equal(only(triageHints([row('/a/', 'WRONG_TARGET', { to: '/a', location: '/a' })], {}), 'WRONG_TARGET').cause, 'unspecified');
});

test('hints TARGET_BROKEN: a domain-level redirect that keeps the path is the cause, the rest is a clause', () => {
  const results = [
    row('/about-us/', 'TARGET_BROKEN', { to: '*', actual: '/about-us' }),
    row('/faq', 'TARGET_BROKEN', { to: '*', actual: 'https://new.example/faq' }),
    row('/team', 'TARGET_BROKEN', { to: '/people', actual: '/people' }),
  ];
  const h = only(triageHints(results, {}), 'TARGET_BROKEN');
  assert.equal(h.cause, 'path-preserved'); assert.equal(h.count, 3);
  assert.match(h.text, /^\[2 of 3\] 2 redirects keep the old path/); assert.match(h.text, /Likely a domain-level redirect/); assert.match(h.text, /Also: 1 with no common cause\./);
  assert.equal(h.causes[0].evidence, 'Likely');
});

test('custom hints: they win — rows they explain leave the built-in hint; disable by result type; site overrides project', () => {
  const results = [row('/a.php', 'MISSING', { status: 400, group: 'nav' }), row('/b.php', 'MISSING', { status: 400, group: 'nav' }), row('/c', 'MISSING', { status: 404 }),
    row('/l', 'LOOP'), { ...row('/ok.php', 'PASS'), ok: true }];
  const custom = parseHints({ disable: ['LOOP'], hints: [
    { id: 'php', level: 'high', min: 2, match: { result: 'MISSING', status: 400, from: '\\.PHP$', group: 'nav' }, text: '{count}/{total} ({percent}%): {examples}' },
    { id: 'too-few', min: 5, match: { result: 'MISSING' }, text: 'never shown' },
    { id: 'all-php', includePassing: true, match: { from: '\\.php$' }, text: '{count} php rows' },
  ] });
  const hs = triageHints(results, {}, { disable: new Set(custom.disable), hints: custom.hints });
  const c = hs.find(h => h.id === 'php');
  assert.equal(c.source, 'custom'); assert.equal(c.level, 'high');
  assert.equal(c.text, '2/5 (40%): /a.php, /b.php', 'regex is case-insensitive; group and status filter');
  assert.ok(!hs.some(h => h.id === 'too-few'));
  assert.equal(hs.find(h => h.id === 'all-php').text, '3 php rows');
  const m = only(hs, 'MISSING');
  assert.equal(m.count, 1, 'only the row no custom hint explained'); assert.deepEqual(m.from, ['/c']);
  assert.ok(!hs.some(h => h.id === 'LOOP'), 'disabled built-in');

  const proj = path.join(tmp, 'proj-hints.json'), own = path.join(tmp, 'site-hints.json');
  fs.writeFileSync(proj, JSON.stringify({ disable: ['CHAIN'], hints: [{ id: 'h', text: 'project' }] }));
  fs.writeFileSync(own, JSON.stringify({ disable: ['LOOP'], hints: [{ id: 'h', text: 'site' }, { id: 'h2', text: 'x' }] }));
  const merged = loadHints([proj, own]);
  assert.deepEqual([...merged.disable].sort(), ['CHAIN', 'LOOP']);
  assert.deepEqual(merged.hints.map(h => `${h.id}:${h.text}`), ['h:site', 'h2:x']);
});

test('custom hints: a bad file is a clear setup error, never a silent skip', () => {
  const bad = cfg => assert.throws(() => parseHints(cfg, 'f'));
  bad({ hints: [{ text: 'no id' }] });
  bad({ hints: [{ id: 'x' }] });
  bad({ hints: [{ id: 'x', text: 't', level: 'urgent' }] });
  bad({ hints: [{ id: 'x', text: 't', match: { path: '/a' } }] });
  bad({ hints: [{ id: 'x', text: 't', match: { from: '(' } }] });
  bad({ hints: [{ id: 'x', text: 't', min: 0 }] });
  bad({ hints: [{ id: 'LOOP', text: 't' }] });
  bad({ disable: ['NOT_A_HINT'] });
  assert.throws(() => loadHints(path.join(tmp, 'nope.json')), /not found/);
});

test('CLI: --hints on a live probe — custom hint, then one built-in hint per remaining failure type; a bad file exits 2', async () => {
  const out = path.join(tmp, 'cli-hints');
  const p = await run(['probe', '--map', fx('hints-map.csv'), '--origin', site.url, '--out', out, '--hints', fx('hints.json')]);
  assert.equal(p.code, 1, p.out);
  assert.match(p.out, /\[legacy-aspx\] 3 of 6 legacy \.aspx pages are refused/);
  assert.match(p.out, /without the slash/);
  assert.ok(!/answer HTTP 400/.test(p.out), 'rows the project hint explains get no second, built-in hint');
  const json = JSON.parse(fs.readFileSync(fs.readdirSync(out).filter(f => f.endsWith('.json')).map(f => path.join(out, f))[0], 'utf8'));
  assert.deepEqual(json.hintFiles, ['hints.json']);
  assert.deepEqual(json.taxonomy.hints.map(h => h.id), ['legacy-aspx', 'WRONG_TARGET']);
  const html = fs.readFileSync(path.join(out, fs.readdirSync(out).find(f => f.endsWith('.html'))), 'utf8');
  assert.match(html, /<b>legacy-aspx<\/b>/);

  const badFile = path.join(tmp, 'bad-hints.json'); fs.writeFileSync(badFile, '{"hints":[{"id":"x"}]}');
  const b = await run(['probe', '--map', fx('hints-map.csv'), '--origin', site.url, '--out', out, '--hints', badFile]);
  assert.equal(b.code, 2); assert.match(b.out, /needs a "text"/); assert.ok(!/at .*\.mjs/.test(b.out), 'no stack trace');
});

test('hints MISSING: a single refusal is still a refusal, not "add a rule"', () => {
  const h = only(triageHints([row('/a.aspx', 'MISSING', { status: 400 })], {}), 'MISSING');
  assert.equal(h.cause, 'refused'); assert.match(h.text, /^1 legacy URL answers HTTP 400/);
});

// ---------------------------------------------------------------- blocked runs
import { detectBlocked } from '../src/gate.mjs';

test('gate: a site that refuses the probe is BLOCKED (not tested), never PASS or FAIL', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ from: `/p${i}`, result: 'MISSING', httpStatus: 403, location: null, group: 'g' }));
  const all = rows(10);
  const g = evaluateGate(all, []);
  assert.equal(g.status, 'BLOCKED'); assert.equal(g.blocked.httpStatus, 403); assert.equal(g.blocked.count, 10);
  assert.match(g.blocked.reason, /not tested/);
  // 7 of 10 refused is below the share: a real result, not a block
  const mixed = [...rows(7), ...Array.from({ length: 3 }, (_, i) => ({ from: `/ok${i}`, result: 'PASS', httpStatus: 301, location: '/x', group: 'g' }))];
  assert.equal(evaluateGate(mixed, []).status, 'FAIL');
  // a 403 that comes with a redirect is not a refusal; too few rows is not a block
  assert.equal(detectBlocked(rows(10).map(r => ({ ...r, location: '/login' }))), null);
  assert.equal(detectBlocked(rows(2)), null);
  // 429 counts too
  assert.equal(detectBlocked(rows(5).map(r => ({ ...r, httpStatus: 429 }))).httpStatus, 429);
});

test('CLI: a blocked probe exits 3, says why, and does not become a history baseline', async () => {
  const f = path.join(tmp, 'blocked.csv');
  fs.writeFileSync(f, 'from,to\n/blocked-1,/a\n/blocked-2,/b\n/blocked-3,/c\n/blocked-4,/d\n');
  const out = path.join(tmp, 'cli-blocked');
  const p = await run(['probe', '--map', f, '--origin', site.url, '--out', out]);
  assert.equal(p.code, 3, p.out);
  assert.match(p.out, /GATE BLOCKED/); assert.match(p.out, /refusing the probe/);
  const json = JSON.parse(fs.readFileSync(path.join(out, fs.readdirSync(out).find(x => x.endsWith('.json'))), 'utf8'));
  assert.equal(json.gate.status, 'BLOCKED'); assert.equal(json.delta, null);
  assert.ok(!fs.existsSync(path.join(out, 'history')) || !fs.readdirSync(path.join(out, 'history', 'redirects')).length, 'no baseline written');
});

// ---------------------------------------------------------------- special characters: one page, two spellings
import { otherSpellings, withOtherSpellings } from '../src/spelling.mjs';

test('spelling: a trailing "?" and a "#" each have another spelling a visitor can send', () => {
  assert.deepEqual(otherSpellings('/is-it-worth-it?'), ['/is-it-worth-it%3F']);
  assert.deepEqual(otherSpellings('/is-it-worth-it%3F'), ['/is-it-worth-it?']);
  assert.deepEqual(otherSpellings('/faq#rates'), ['/faq%23rates']);
  assert.deepEqual(otherSpellings('/plain/page'), []);
  assert.deepEqual(otherSpellings('/search?q=x'), [], 'a real query string is not a slug');
  assert.deepEqual(otherSpellings('https://old.example/a?'), [], 'absolute sources are left alone');
  const rules = withOtherSpellings([{ from: '/a?', to: '/x' }, { from: '/a%3F', to: '/x' }, { from: '/b?', to: '/y' }]);
  assert.deepEqual(rules.map(r => r.from), ['/a?', '/a%3F', '/b?', '/b%3F'], 'a spelling already in the map is not added twice');
  assert.equal(rules.at(-1).variantOf, '/b?');
});

test('pre-flight: "#", a trailing "?" and a stray "%" in a source are flagged', () => {
  const res = preflight(loadMap(writeTmp('chars.csv', 'from,to\n/faq#rates,/help\n/is-it-worth-it?,/worth-it\n/50%-off,/sale\n/search?q=x,/s\n')));
  const codes = res.issues.map(i => `${i.code}:${i.from}`);
  assert.ok(codes.includes('FRAGMENT_IN_SOURCE:/faq#rates'), codes.join());
  assert.ok(codes.includes('QUESTION_MARK_SLUG:/is-it-worth-it?'));
  assert.ok(codes.includes('STRAY_PERCENT:/50%-off'));
  assert.ok(codes.includes('QUERY_IN_SOURCE:/search?q=x'));
  assert.ok(!codes.includes('QUERY_IN_SOURCE:/is-it-worth-it?'), 'a trailing "?" is a slug, not a query');
  assert.equal(res.issues.find(i => i.code === 'FRAGMENT_IN_SOURCE').severity, 'error');
});

test('probe: both spellings are probed; a page that works in only one spelling gets one clear hint', async () => {
  const f = writeTmp('spelling.csv', 'from,to\n/what-is-a-sitemap?,/articles/sitemap\n/how-to-save?,/articles/save\n/faq#rates,/help/rates\n');
  const run = await runSite({ map: f, origin: site.url }, opts({ name: 'spelling' }));
  const r = Object.fromEntries(run.results.map(x => [x.from, x]));
  // raw "?" arrives stripped → no rule matches; the encoded spelling works
  assert.equal(r['/what-is-a-sitemap?'].result, 'MISSING');
  assert.equal(r['/what-is-a-sitemap%3F'].result, 'PASS'); assert.equal(r['/what-is-a-sitemap%3F'].variantOf, '/what-is-a-sitemap?');
  // both spellings handled → both pass
  assert.equal(r['/how-to-save?'].result, 'PASS'); assert.equal(r['/how-to-save%3F'].result, 'PASS');
  // "#": only the encoded spelling can be redirected, and it is
  assert.equal(r['/faq%23rates'].result, 'PASS');
  const h = run.taxonomy.hints.find(x => x.id === 'MISSING');
  assert.equal(h.cause, 'other-spelling');
  assert.match(h.text, /one spelling of a special character while the other spelling works/);
  assert.ok(h.from.includes('/what-is-a-sitemap?'));
  // off switch
  const off = await runSite({ map: f, origin: site.url }, opts({ name: 'spelling-off', spellingVariants: false }));
  assert.equal(off.results.length, 3);
});

test('harvest: a busy archive is retried; when it stays down, a clear message and no stack trace', async () => {
  const { harvest } = await import('../src/harvest.mjs');
  let calls = 0;
  const flaky = async () => (++calls < 3 ? { ok: false, status: 503 } : { ok: true, json: async () => [['original'], ['http://old.example/about']] });
  assert.deepEqual(await harvest('old.example', { fetchImpl: flaky, backoffMs: 1 }), ['/about']);
  assert.equal(calls, 3, 'two 503s, then success');
  calls = 0;
  const down = async () => { calls++; return { ok: false, status: 503 }; };
  await assert.rejects(harvest('old.example', { fetchImpl: down, backoffMs: 1 }), e => e.usage === true && /did not answer.*HTTP 503, 3 attempts/.test(e.message));
  calls = 0;
  const notFound = async () => { calls++; return { ok: false, status: 404 }; };
  await assert.rejects(harvest('old.example', { fetchImpl: notFound, backoffMs: 1 }));
  assert.equal(calls, 1, 'a 404 is not retried');
});

test('hints TARGET_BROKEN: a redirect to the error page and to a retired (410) page are named causes', () => {
  const results = [
    row('/a/', 'TARGET_BROKEN', { actual: '/404/', detail: '→ /404/, which answers HTTP 404' }),
    row('/b/', 'TARGET_BROKEN', { actual: '/not-found', detail: '→ /not-found, which answers HTTP 404' }),
    row('/c/', 'TARGET_BROKEN', { actual: '/archive/c/', detail: '→ /archive/c/, which answers HTTP 410' }),
    row('/d/', 'TARGET_BROKEN', { actual: '/new/d/', detail: '→ /new/d/, which answers HTTP 404' }),
  ];
  const h = only(triageHints(results, {}), 'TARGET_BROKEN');
  assert.equal(h.cause, 'error-page-target');
  assert.match(h.text, /^\[2 of 4\] 2 redirects send visitors to the site's error page/);
  assert.deepEqual(h.causes.map(c => [c.cause, c.count]), [['error-page-target', 2], ['target-retired', 1], ['unspecified', 1]]);
  assert.match(h.text, /Also: 1 point at a retired page \(410\); 1 with no common cause\./);
  // a page whose slug only contains "error" is not the error page
  assert.equal(only(triageHints([row('/e/', 'TARGET_BROKEN', { actual: '/blog/error-budgets/', detail: 'x, which answers HTTP 404' })], {}), 'TARGET_BROKEN').cause, 'unspecified');
});

test('harvest: linkId is a tracking parameter', () => {
  assert.deepEqual(cleanPaths(['http://old.example/post/?linkId=88902254']), ['/post/']);
});

test('hints TARGET_BROKEN: the same slug under a section that does not exist is one cause', () => {
  const results = [
    row('/hello-world/', 'TARGET_BROKEN', { actual: '/uncategorized/hello-world/', detail: 'x, which answers HTTP 404' }),
    row('/second-post/', 'TARGET_BROKEN', { actual: '/news/second-post/', detail: 'x, which answers HTTP 404' }),
    row('/third/', 'TARGET_BROKEN', { actual: '/elsewhere/', detail: 'x, which answers HTTP 404' }),
  ];
  const h = only(triageHints(results, {}), 'TARGET_BROKEN');
  assert.equal(h.cause, 'slug-under-new-section');
  assert.match(h.text, /\(\/uncategorized\/, \/news\/\)/);
  assert.deepEqual(h.causes.map(c => [c.cause, c.count]), [['slug-under-new-section', 2], ['unspecified', 1]]);
});

test('harvest: the sample is spread across sections, so one huge section cannot crowd out the site', () => {
  const profiles = Array.from({ length: 50 }, (_, i) => `http://old.example/tag/0topic${i}`);
  const out = cleanPaths(['http://old.example/', ...profiles, 'http://old.example/about/', 'http://old.example/blog/post-1', 'http://old.example/blog/post-2'], { limit: 5 });
  assert.equal(out[0], '/');
  assert.ok(out.includes('/about/') && out.some(p => p.startsWith('/blog/')), `about and blog are in the sample: ${out}`);
});

test('harvest: a capped answer from a large site also reads index pages spread across the site', async () => {
  const { harvest } = await import('../src/harvest.mjs');
  const urls = [];
  const fetchImpl = async (u) => {
    urls.push(u);
    const q = new URL(u).searchParams;
    if (q.get('showNumPages')) return { ok: true, json: async () => 10 };
    if (q.get('page')) return { ok: true, json: async () => [['original'], [`http://old.example/section${q.get('page')}/page`]] };
    // first answer: capped (limit 2 × 8 = 16 rows), all from one section at the start of the alphabet
    return { ok: true, json: async () => [['original'], ...Array.from({ length: 16 }, (_, i) => [`http://old.example/u/0user${i}`])] };
  };
  const out = await harvest('old.example', { limit: 2, fetchImpl, backoffMs: 1 });
  assert.ok(urls.some(u => /showNumPages=true/.test(u)), 'asks how many index pages there are');
  assert.ok(out.some(p => p.startsWith('/section')), `pages from later in the index are sampled: ${out}`);
  // a small site (answer under the cap) makes one request only
  urls.length = 0;
  await harvest('old.example', { limit: 150, fetchImpl: async (u) => { urls.push(u); return { ok: true, json: async () => [['original'], ['http://old.example/about']] }; }, backoffMs: 1 });
  assert.equal(urls.length, 1);
});

test('hints: nearly every URL to the homepage reads as a domain-level redirect that drops the path', async () => {
  const { triageHints } = await import('../src/hints.mjs');
  const results = Array.from({ length: 20 }, (_, i) => ({ from: `/p${i}/`, to: '*', result: 'WRONG_TARGET', actual: '/', group: 'g', ok: false }));
  results.push({ from: '/', to: '*', result: 'REDIRECT_OK', group: 'home', ok: true });
  const t = triageHints(results, { g: { total: 20, WRONG_TARGET: 20 }, home: { total: 1 } }).find(h => h.id === 'WRONG_TARGET');
  assert.match(t.text, /20 of 21 legacy URLs redirect to the homepage .*domain-level redirect that drops the path/);
  const few = results.slice(0, 3).concat(Array.from({ length: 10 }, (_, i) => ({ from: `/ok${i}`, result: 'REDIRECT_OK', ok: true, group: 'g' })));
  assert.match(triageHints(few, { g: { total: 13, WRONG_TARGET: 3 } }).find(h => h.id === 'WRONG_TARGET').text, /catch-all rule/);
});
