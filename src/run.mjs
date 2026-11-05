// One full gate run for one site: map → preflight → origin → probe → exceptions/gate → taxonomy → history/delta → exports.
import path from 'node:path';
import { loadMap, hostOf } from './map.mjs';
import { preflight } from './preflight.mjs';
import { probeRules, detectOrigin, parseCandidates, parseFingerprint } from './probe.mjs';
import { loadExceptions, evaluateGate, taxonomy } from './gate.mjs';
import { recordRun } from './history.mjs';
import { writeExports } from './report.mjs';
import { stamp } from './util.mjs';

export async function runSite(site, opts = {}) {
  const {
    concurrency = 6, timeoutMs = 20000, maxHops = 6, delayMs = 0,
    accept = [301, 308], strict = false, checkTargets = false,
    outDir = 'cutovergate-runs', historyDir, expectPhase, compareTo = 'previous', onProgress,
  } = opts;

  const rules = loadMap(site.map);
  const candidates = site.candidates ? (Array.isArray(site.candidates) ? site.candidates : parseCandidates(site.candidates)) : [];
  if (site.origin) candidates.unshift({ label: site.phase || 'given', url: site.origin });
  if (!candidates.length) throw new Error('Give --origin or --candidates');

  const siteHosts = [...new Set([...candidates.map(c => hostOf(c.url)), ...(site.domain ? [String(site.domain).toLowerCase()] : [])].filter(Boolean))];
  const pf = preflight(rules, { siteHosts });

  const fp = parseFingerprint(site.fingerprint || opts.fingerprint);
  const detected = site.origin && !fp && candidates.length === 1
    ? { origin: site.origin.replace(/\/+$/, ''), phase: candidates[0].label, checks: [] }
    : await detectOrigin(candidates, fp, { timeoutMs: Math.min(timeoutMs, 10000) });

  const domain = site.domain || hostOf(candidates.at(-1).url);
  const id = stamp();
  if (!detected.origin) {
    return { domain, id, at: new Date().toISOString(), skipped: true, reason: detected.reason, checks: detected.checks, preflight: pf.summary };
  }
  if (expectPhase && detected.phase !== expectPhase) {
    return { domain, id, at: new Date().toISOString(), skipped: true, reason: `expected phase "${expectPhase}", detected "${detected.phase}"`, checks: detected.checks, preflight: pf.summary };
  }

  const results = await probeRules(pf.rules, { origin: detected.origin, siteHosts, accept, checkTargets, concurrency, timeoutMs, maxHops, delayMs, onProgress });
  const gate = evaluateGate(results, loadExceptions(site.exceptions), { strict });
  const run = {
    tool: 'cutovergate', domain, id, at: new Date().toISOString(),
    map: path.basename(site.map), origin: detected.origin, phase: detected.phase, originChecks: detected.checks,
    accept, strict, checkTargets,
    preflight: { summary: pf.summary, errors: pf.issues.filter(i => i.severity === 'error') },
    gate, taxonomy: taxonomy(results), results,
  };
  run.delta = recordRun(historyDir || path.join(outDir, 'history'), domain, run, { compareTo });
  run.files = writeExports(run, outDir);
  return run;
}
