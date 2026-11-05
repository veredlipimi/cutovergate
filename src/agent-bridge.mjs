// Bridge between CutoverGate and web-qa-agent (https://github.com/veredlipimi/web-qa-agent).
//
//   CutoverGate answers: does every legacy URL land on the right page?
//   web-qa-agent answers: does the page it lands on actually work?
//
// Direction 1 — `cutovergate qa`: after the gate passes, the destination pages from the map are
//   handed to the agent's pipeline (crawl --no-follow → audit → field-matrix → report).
// Direction 2 — the agent's redirect-check.mjs uses CutoverGate as its engine and converts the run
//   with toAgentFindings() below, so the two tools never disagree about a redirect.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { toPath, isAbsolute } from './map.mjs';

// CutoverGate result → web-qa-agent result + severity.
const AGENT = {
  PASS: ['PASS'], REDIRECT_OK: ['PASS'], GONE_OK: ['PASS'],
  MISSING: ['MISSING', 'High'], WRONG_TARGET: ['WRONG-TARGET', 'High'], LOOP: ['LOOP', 'High'],
  TARGET_BROKEN: ['TARGET-BROKEN', 'High'], WRONG_STATUS: ['WRONG-STATUS', 'Low'], CHAIN: ['CHAIN', 'Low'], ERROR: ['ERROR', 'Medium'],
};
const FIX = {
  MISSING: 'Register the redirect (or restore the old URL).',
  WRONG_TARGET: 'Point the redirect at the mapped target.',
  LOOP: 'Break the loop — the page is unreachable.',
  TARGET_BROKEN: 'The redirect is right but the destination fails — migrate the content or fix the target slug.',
  CHAIN: 'Redirect straight to the final URL — chains lose link equity and add latency.',
  WRONG_STATUS: 'Use a permanent 301/308 for moved content so search engines transfer ranking.',
  ERROR: 'Re-run; check connectivity or rate limiting.',
};

/** Convert a CutoverGate run into web-qa-agent's findings.redirects.json shape. */
export function toAgentFindings(run) {
  const abs = p => (isAbsolute(p) ? p : run.origin + toPath(p));
  const results = run.results.map(r => ({ from: r.from, to: r.to, result: AGENT[r.result]?.[0] || r.result, engineResult: r.result, detail: r.detail, excepted: r.excepted || null }));
  // Excepted rows stay in results but are not reported as gaps: the waiver was a documented decision.
  const findings = run.results.filter(r => !r.ok && !r.excepted).map(r => {
    const [res, severity] = AGENT[r.result] || [r.result, 'Medium'];
    return {
      source: 'auto', ruleId: `redirect-${res.toLowerCase()}`, category: 'Redirects', severity,
      confidence: r.result === 'ERROR' ? 'verify' : 'confirmed', page: abs(r.from), viewport: 'desktop',
      title: `Redirect ${res}: ${r.from} → ${r.to || r.expectedStatus}`,
      steps: [`Request ${abs(r.from)} without following redirects`, 'Check the status and Location header'],
      expected: `${r.expectedStatus === 301 ? run.accept.join('/') : r.expectedStatus} → ${r.to || '(retired)'}`, actual: r.detail || `HTTP ${r.httpStatus}`,
      remediation: FIX[r.result] || '',
      evidence: { details: r.chain || '' },
    };
  });
  const tally = results.reduce((a, r) => (a[r.result] = (a[r.result] || 0) + 1, a), {});
  const errors = run.results.filter(r => r.result === 'ERROR').length;
  return {
    engine: 'cutovergate', origin: run.origin, phase: run.phase, map: run.map, tally, results, findings,
    gate: { status: run.gate.status, effectiveFailures: run.gate.effectiveFailures, excepted: run.gate.excepted, strict: run.gate.strict },
    reports: run.files,
    coverage: [{ category: 'Redirects', page: run.origin, viewport: 'desktop', status: results.length ? 'tested' : 'not-tested', ...(results.length ? {} : { reason: 'Empty redirect map' }) }],
    notCovered: errors ? [{ reason: `${errors} redirect(s) could not be probed (network errors) — not counted as passes` }] : [],
  };
}

/** Destination pages worth QA-ing: same-site targets of passing rules, spread across groups. */
export function targetPages(run, max = 20) {
  const byGroup = new Map();
  const seen = new Set();
  for (const r of run.results) {
    if (!r.ok || r.result === 'GONE_OK') continue;
    // The page the user really lands on (may be on the new domain), else origin + target path.
    const url = r.landedUrl || (r.actual && !/^https?:/i.test(r.actual) ? run.origin + r.actual : null);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group).push(url);
  }
  // Round-robin so a capped run still covers every group (blog, shop, static…).
  const out = [];
  const lists = [...byGroup.values()];
  for (let i = 0; out.length < max && lists.some(l => l.length > i); i++) for (const l of lists) if (l[i] && out.length < max) out.push(l[i]);
  return { pages: out, total: seen.size, groups: Object.fromEntries([...byGroup].map(([g, l]) => [g, l.length])) };
}

export function findAgent(explicit) {
  const candidates = [explicit, process.env.WEB_QA_AGENT, path.join(os.homedir(), '.claude', 'skills', 'web-qa-agent')].filter(Boolean);
  return candidates.find(p => fs.existsSync(path.join(p, 'scripts', 'audit.mjs'))) || null;
}

function step(agent, script, args, log) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(agent, 'scripts', script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stdout.on('data', d => log?.(String(d)));
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, err }));
  });
}

/** Run the agent's automated pipeline on the destination pages. Returns the QA run folder. */
export async function runAgentOnTargets(run, { agent, maxPages = 20, outDir, viewports = 'mobile,desktop', lang = 'en', log } = {}) {
  const { pages, total, groups } = targetPages(run, maxPages);
  const siteOrigin = pages[0] ? new URL(pages[0]).origin : run.origin; // QA the new site, not the old domain
  const qaDir = path.join(outDir, `qa-${run.domain.replace(/[^a-z0-9.-]+/gi, '_')}-${run.id}`);
  fs.mkdirSync(qaDir, { recursive: true });
  fs.writeFileSync(path.join(qaDir, 'targets.txt'), pages.join('\n') + '\n');
  fs.writeFileSync(path.join(qaDir, 'findings.redirects.json'), JSON.stringify(toAgentFindings(run), null, 2));
  fs.writeFileSync(path.join(qaDir, 'claude-prompt.md'), [
    `QA ${siteOrigin}`, '',
    `Context: website migration. CutoverGate gate = ${run.gate.status} (${run.phase}), report: ${run.files.html}`,
    `Scope: the ${pages.length} destination pages in targets.txt${total > pages.length ? ` (sampled from ${total}, spread across groups: ${Object.keys(groups).join(', ')})` : ''}.`,
    'The automated pass already ran in this folder — continue from Phase 4 (field matrix review + exploratory) and finish with the report.',
  ].join('\n') + '\n');
  if (!pages.length) return { qaDir, pages, total, skipped: 'no passing same-site targets' };

  const steps = [
    ['preflight', 'preflight.mjs', ['--url', siteOrigin + '/', '--out', qaDir]],
    ['crawl', 'crawl.mjs', ['--url', siteOrigin + '/', '--urls', path.join(qaDir, 'targets.txt'), '--no-follow', '--max-pages', String(pages.length), '--out', qaDir]],
    ['audit', 'audit.mjs', ['--sitemap', path.join(qaDir, 'sitemap.json'), '--out', qaDir, '--viewports', viewports]],
    ['field-matrix', 'field-matrix.mjs', ['--sitemap', path.join(qaDir, 'sitemap.json'), '--out', qaDir]],
    ['report', 'report.mjs', ['--run', qaDir, '--lang', lang, '--title', `Post-migration QA — ${run.domain}`]],
  ];
  const ran = [];
  for (const [name, script, args] of steps) {
    log?.(`  · ${name}\n`);
    const r = await step(agent, script, args);
    ran.push({ name, code: r.code });
    // preflight may exit non-zero on warnings; report exits non-zero only with --gate.
    if (r.code !== 0 && !['preflight'].includes(name)) return { qaDir, pages, total, failedStep: name, error: r.err.slice(-800), ran };
  }
  const findings = JSON.parse(fs.readFileSync(path.join(qaDir, 'findings.json'), 'utf8'));
  return { qaDir, pages, total, ran, report: path.join(qaDir, 'report.html'), verdict: findings.verdict, gaps: findings.gaps?.length ?? 0, qaGate: findings.gate?.status };
}
