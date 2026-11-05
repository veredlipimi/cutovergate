#!/usr/bin/env node
// CutoverGate — a release gate for website migrations.
// Every legacy URL must land where the redirect map says, before DNS cutover and after it.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, readLines, writeJson, toCsv, safeName, stamp, c, VERSION } from '../src/util.mjs';
import { loadMap, hostOf } from '../src/map.mjs';
import { preflight } from '../src/preflight.mjs';
import { runSite } from '../src/run.mjs';
import { printSummary } from '../src/report.mjs';
import { addException, removeException, loadExceptions, triageExceptions } from '../src/gate.mjs';
import { checkFiles } from '../src/files.mjs';
import { findAgent, runAgentOnTargets, targetPages } from '../src/agent-bridge.mjs';
import { harvest, writeStarterMap } from '../src/harvest.mjs';

const HELP = `CutoverGate ${VERSION} — release gate for website migrations

Usage: cutovergate <command> [options]

Commands
  preflight   Check a redirect map without any HTTP requests
              --map FILE  [--legacy-urls FILE] [--domain HOST] [--json]
  probe       Probe every rule on a live origin and evaluate the gate
              --map FILE  (--origin URL | --candidates "staging=URL,live=URL")
              [--fingerprint header:NAME[=VALUE] | body:TEXT]  [--exceptions FILE]
              [--strict] [--check-targets] [--accept 301,308] [--expect-phase live]
              [--compare-to previous|other-phase] [--domain HOST] [--out DIR]
              [--concurrency 6] [--timeout-ms 20000] [--max-hops 6] [--delay-ms 0] [--quiet]
  verify      Post-cutover pass: probe with --expect-phase live --compare-to other-phase
  batch       Run probe for many sites: --sites sites.json [probe options]
  harvest     No map? Build a starter map from the Wayback Machine's copy of the old site
              --old-domain HOST --out map.csv [--mode same-path|any] [--limit 150] [--from YYYY] [--to YYYY]
              same-path = domain move (old path → same path); any = platform change (any working, non-homepage target)
  qa          Gate first, then QA the destination pages with web-qa-agent
              probe options + [--agent PATH] [--max-pages 20] [--viewports mobile,desktop] [--lang en|he] [--force]
  files       Check linked files (PDFs, documents) are reachable
              --origin URL (--urls FILE | --pages FILE) [--pattern REGEX] [--json] [--out DIR]
  exceptions  add --file F --path P --reason "…" [--ttl none|7|14|30|90] [--by NAME]
              remove --file F --path P  ·  list --file F

Exit codes: 0 = gate PASS / no errors · 1 = gate FAIL / errors found · 2 = usage or setup problem
`;

const BOOL = ['strict', 'checkTargets', 'json', 'quiet', 'help', 'all', 'force'];
const argv = process.argv.slice(2);
const cmd = argv[0];
const a = parseArgs(argv.slice(1), BOOL);
const die = (msg) => { console.error(c.red(msg)); process.exit(2); };
const num = (v, d) => (v === undefined ? d : Math.max(0, parseInt(v, 10) || d));

function probeOpts() {
  return {
    concurrency: num(a.concurrency, 6), timeoutMs: num(a.timeoutMs, 20000), maxHops: num(a.maxHops, 6), delayMs: num(a.delayMs, 0),
    accept: String(a.accept || '301,308').split(',').map(Number).filter(Boolean),
    strict: !!a.strict, checkTargets: !!a.checkTargets, outDir: a.out || 'cutovergate-runs', historyDir: a.history,
    expectPhase: a.expectPhase, compareTo: a.compareTo || 'previous', fingerprint: a.fingerprint,
    onProgress: process.stderr.isTTY && !a.json ? (d, t) => { process.stderr.write(d === t ? '\r\x1b[K' : `\r  probing ${d}/${t}`); } : null,
  };
}

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h' || a.help) { console.log(HELP); return 0; }
  if (cmd === '--version' || cmd === '-v') { console.log(VERSION); return 0; }

  if (cmd === 'preflight') {
    if (!a.map) die('--map is required');
    const legacy = a.legacyUrls ? readLines(a.legacyUrls) : [];
    const res = preflight(loadMap(a.map), { legacyUrls: legacy, siteHosts: a.domain ? [a.domain] : [] });
    if (a.json) console.log(JSON.stringify({ summary: res.summary, ok: res.ok, issues: res.issues }, null, 2));
    else {
      const s = res.summary;
      console.log(`\n${res.ok ? c.green(c.bold(' PRE-FLIGHT OK ')) : c.red(c.bold(' PRE-FLIGHT ERRORS '))}  ${a.map}`);
      console.log(`  ${s.rows} rows · ${s.checkable} rules will be probed · ${s.errors} errors · ${s.warnings} warnings · ${s.info} info`);
      console.log('  groups: ' + Object.entries(s.groups).map(([g, n]) => `${g} ${n}`).join(' · '));
      for (const i of res.issues) {
        const tag = i.severity === 'error' ? c.red('ERROR  ') : i.severity === 'warning' ? c.yellow('WARN   ') : c.dim('INFO   ');
        console.log(`  ${tag}${i.code.padEnd(20)} ${i.line ? `line ${i.line}: ` : ''}${i.from ?? ''}${i.to ? ` → ${i.to}` : ''}${i.detail ? c.dim(`  (${i.detail})`) : ''}`);
      }
      if (res.issues.length) console.log(c.dim('\n  ' + [...new Set(res.issues.map(i => i.code))].map(k => `${k}: ${res.issues.find(i => i.code === k).text}`).join('\n  ')));
    }
    if (a.out) writeJson(path.join(a.out, `preflight-${safeName(a.domain || path.basename(a.map))}-${stamp()}.json`), res);
    return res.ok ? 0 : 1;
  }

  if (cmd === 'probe' || cmd === 'verify') {
    if (!a.map) die('--map is required');
    if (!a.origin && !a.candidates) die('--origin or --candidates is required');
    const o = probeOpts();
    if (cmd === 'verify') { o.expectPhase ||= 'live'; o.compareTo = 'other-phase'; }
    const run = await runSite({ map: a.map, origin: a.origin, candidates: a.candidates, exceptions: a.exceptions, domain: a.domain }, o);
    if (run.skipped) {
      console.log(`\n${c.yellow(c.bold(' NOT ON TARGET '))}  ${run.domain}: ${run.reason}`);
      for (const ch of run.checks || []) console.log(`  ${ch.label.padEnd(12)} ${ch.url}  ${ch.state} ${c.dim(ch.detail || '')}`);
      return 1;
    }
    if (a.json) console.log(JSON.stringify(run, null, 2));
    else {
      printSummary(run, { quiet: !!a.quiet });
      console.log(c.dim(`\n  report: ${run.files.html}\n  csv:    ${run.files.csv}\n  json:   ${run.files.json}`));
    }
    return run.gate.status === 'PASS' ? 0 : 1;
  }

  if (cmd === 'qa') {
    if (!a.map) die('--map is required');
    if (!a.origin && !a.candidates) die('--origin or --candidates is required');
    const agent = findAgent(a.agent);
    const o = probeOpts();
    const run = await runSite({ map: a.map, origin: a.origin, candidates: a.candidates, exceptions: a.exceptions, domain: a.domain }, o);
    if (run.skipped) { console.log(`\n${c.yellow(c.bold(' NOT ON TARGET '))}  ${run.domain}: ${run.reason}`); return 1; }
    printSummary(run, { quiet: true });
    if (run.gate.status !== 'PASS' && !a.force) {
      console.log(`\n  ${c.yellow('Page QA skipped:')} the redirect gate must pass first — fix the redirects, or add --force to QA the pages that already land correctly.\n  ${c.dim(run.files.html)}`);
      return 1;
    }
    const maxPages = num(a.maxPages, 20);
    if (!agent) {
      const t = targetPages(run, maxPages);
      console.log(`\n  ${c.yellow('web-qa-agent not found.')} Install it, or pass --agent PATH:\n    git clone https://github.com/veredlipimi/web-qa-agent ~/.claude/skills/web-qa-agent\n    node ~/.claude/skills/web-qa-agent/scripts/setup.mjs\n  ${t.pages.length} destination pages are ready for QA.`);
      return 2;
    }
    console.log(`\n${c.bold('Page QA')} with web-qa-agent (${agent})`);
    const qa = await runAgentOnTargets(run, { agent, maxPages, outDir: o.outDir, viewports: a.viewports || 'mobile,desktop', lang: a.lang || 'en', log: s => process.stdout.write(c.dim(s)) });
    if (qa.skipped) { console.log(`  ${c.yellow(qa.skipped)}`); return 1; }
    if (qa.failedStep) { console.log(`  ${c.red(`${qa.failedStep} failed`)}\n${c.dim(qa.error)}`); return 2; }
    console.log(`\n  ${qa.pages.length} destination pages${qa.total > qa.pages.length ? ` (of ${qa.total})` : ''} · ${qa.gaps} gaps identified · QA gate ${qa.qaGate || '—'}\n  ${qa.verdict}`);
    console.log(c.dim(`\n  redirect report: ${run.files.html}\n  page QA report:  ${qa.report}\n  continue in Claude Code (exploratory pass): ${path.join(qa.qaDir, 'claude-prompt.md')}`));
    return run.gate.status === 'PASS' && qa.qaGate !== 'FAIL' ? 0 : 1;
  }

  if (cmd === 'batch') {
    if (!a.sites) die('--sites is required');
    const cfg = JSON.parse(fs.readFileSync(a.sites, 'utf8'));
    const sites = Array.isArray(cfg) ? cfg : cfg.sites;
    const dir = path.dirname(path.resolve(a.sites));
    const rel = p => (p && !path.isAbsolute(p) ? path.join(dir, p) : p);
    const o = probeOpts(); o.onProgress = null;
    const rows = [];
    console.log(`\nBatch: ${sites.length} sites\n`);
    for (const s of sites) {
      const site = { ...s, map: rel(s.map), exceptions: rel(s.exceptions || cfg.exceptions) };
      let run;
      try { run = await runSite(site, { ...o, fingerprint: s.fingerprint || cfg.fingerprint || o.fingerprint }); }
      catch (e) { rows.push({ domain: s.domain || s.map, gate: 'ERROR', detail: e.message }); console.log(`  ${c.red('ERROR'.padEnd(7))} ${s.domain}  ${e.message}`); continue; }
      if (run.skipped) { rows.push({ domain: run.domain, gate: 'SKIPPED', detail: run.reason }); console.log(`  ${c.yellow('SKIP'.padEnd(7))} ${run.domain}  ${c.dim(run.reason)}`); continue; }
      const g = run.gate;
      const issues = run.results.filter(r => !r.ok && !r.excepted).slice(0, 3).map(r => `[${r.result}] ${r.from}`).join('; ');
      rows.push({ domain: run.domain, gate: g.status, phase: run.phase, probed: g.probed, passed: g.passed, effectiveFailures: g.effectiveFailures, excepted: g.excepted, regressions: run.delta?.regressions.length ?? '', report: run.files.html, detail: issues });
      console.log(`  ${(g.status === 'PASS' ? c.green : c.red)(g.status.padEnd(7))} ${run.domain.padEnd(36)} ${String(run.phase).padEnd(12)} ${g.passed}/${g.probed}  ${issues ? c.dim(issues) : ''}`);
    }
    const outDir = o.outDir;
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, `batch-${stamp()}`);
    writeJson(base + '.json', { at: new Date().toISOString(), sites: rows });
    fs.writeFileSync(base + '.csv', toCsv(rows, ['domain', 'gate', 'phase', 'probed', 'passed', 'effectiveFailures', 'excepted', 'regressions', 'detail', 'report']));
    const pass = rows.filter(r => r.gate === 'PASS').length;
    console.log(`\n  ${pass}/${rows.length} sites pass · ${rows.filter(r => r.gate === 'FAIL').length} fail · ${rows.filter(r => r.gate === 'SKIPPED').length} skipped\n  ${c.dim(base + '.csv')}`);
    return rows.every(r => r.gate === 'PASS') ? 0 : 1;
  }

  if (cmd === 'harvest') {
    if (!a.oldDomain || !a.out) die('--old-domain and --out are required');
    const mode = a.mode === 'same-path' ? 'same-path' : 'any';
    const paths = await harvest(a.oldDomain, { limit: num(a.limit, 150), from: a.from, to: a.to });
    if (!paths.length) { console.log(c.yellow(`No archived pages found for ${a.oldDomain}.`)); return 1; }
    writeStarterMap(a.out, paths, mode);
    console.log(`${paths.length} legacy URLs from the Wayback Machine → ${a.out} (mode: ${mode})`);
    console.log(c.dim(`Next: cutovergate probe --map ${a.out} --origin https://${a.oldDomain.replace(/^https?:\/\//, '')} --domain <new host> --check-targets`));
    return 0;
  }

  if (cmd === 'files') {
    if (!a.origin) die('--origin is required');
    if (!a.urls && !a.pages) die('--urls or --pages is required');
    const origin = a.origin.replace(/\/+$/, '');
    const res = await checkFiles({ origin, hrefs: a.urls ? readLines(a.urls) : [], pages: a.pages ? readLines(a.pages) : [], pattern: a.pattern, concurrency: num(a.concurrency, 6), timeoutMs: num(a.timeoutMs, 20000) });
    if (a.out) {
      const base = path.join(a.out, `files-${safeName(hostOf(origin) || origin)}-${stamp()}`);
      writeJson(base + '.json', res);
      fs.writeFileSync(base + '.csv', toCsv(res.results.map(r => ({ ...r, foundOn: r.foundOn.join(' | ') })), ['result', 'status', 'rawHref', 'resolvedUrl', 'finalUrl', 'contentType', 'foundOn', 'error']));
    }
    if (a.json) console.log(JSON.stringify(res, null, 2));
    else {
      const s = res.summary;
      console.log(`\nLinked files on ${origin}: ${s.checked} checked · ${c.green(`${s.ok} OK`)} · ${s.broken ? c.red(`${s.broken} broken`) : '0 broken'} · ${s.soft404} soft-404 · ${s.errors} errors`);
      for (const r of res.results.filter(r => r.result !== 'OK')) console.log(`  ${c.red(r.result.padEnd(9))} ${String(r.status || '').padEnd(4)} ${r.resolvedUrl}  ${c.dim(r.error || r.contentType)}`);
      for (const p of res.pageErrors) console.log(`  ${c.yellow('PAGE    ')} ${p.page} ${c.dim(p.status ? `HTTP ${p.status}` : p.error)}`);
    }
    return res.summary.broken + res.summary.soft404 + res.summary.errors > 0 ? 1 : 0;
  }

  if (cmd === 'exceptions') {
    const sub = a._[0];
    if (!a.file) die('--file is required');
    if (sub === 'add') {
      try { const e = addException(a.file, { path: a.path, reason: a.reason, ttl: a.ttl ?? '14', by: a.by }); console.log(`Added: ${e.path} — ${e.reason} (${e.expires ? `until ${e.expires}` : 'no expiry'})`); }
      catch (e) { die(e.message); }
      return 0;
    }
    if (sub === 'remove') { if (!a.path) die('--path is required'); console.log(`Removed ${removeException(a.file, a.path)}`); return 0; }
    if (sub === 'list') {
      const t = triageExceptions(loadExceptions(a.file));
      for (const e of t.active) console.log(`  ${t.expiringSoon.includes(e) || t.expiringSoon.some(x => x.path === e.path) ? c.yellow('⚠ soon ') : c.green('active ')} ${e.path}  ${e.expires ? `until ${e.expires}` : 'no expiry'}  ${c.dim(e.reason)}`);
      for (const e of t.expired) console.log(`  ${c.dim('expired')} ${e.path}  ${e.expires}  ${c.dim(e.reason)}`);
      for (const e of t.invalid) console.log(`  ${c.red('invalid')} ${e.path || '?'}  ${e.problem}`);
      return 0;
    }
    die('exceptions add | remove | list');
  }

  console.error(HELP); return 2;
}

main().then(code => process.exit(code ?? 0)).catch(e => { console.error(c.red(e.stack || e.message)); process.exit(2); });
