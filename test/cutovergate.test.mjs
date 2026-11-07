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
  assert.equal(logicalKey('/team.cfm'), logicalKey('/team'));
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
  assert.match(text, /Every rule in "shop" is MISSING/);
  assert.match(text, /"docs" points to the wrong target/);
  assert.match(text, /redirect to the homepage/);
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

test('harvest: keeps pages, drops assets, tracking params and duplicates', () => {
  const out = cleanPaths(['http://old.example/', 'http://old.example/about/', 'http://old.example/about', 'http://old.example/style.css',
    'http://old.example/wp-json/x', 'http://old.example/blog/post-1?utm_source=x', 'http://old.example/shop/item?id=4', 'http://old.example/feed/']);
  assert.deepEqual(out, ['/', '/about/', '/shop/item?id=4']);
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
