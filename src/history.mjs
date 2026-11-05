// Every run is saved. From the second run on a domain, a delta shows:
//   regressions  — was passing → now failing   (investigate immediately)
//   new failures — not seen before → now failing
//   fixed        — was failing → now passing
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, safeName } from './util.mjs';

const KEEP = 50;

export function historyFile(dir, domain) {
  return path.join(dir, `${safeName(domain)}.json`);
}

export function loadHistory(dir, domain) {
  return readJson(historyFile(dir, domain), { domain, runs: [] });
}

export function computeDelta(prevRun, results) {
  if (!prevRun) return null;
  const before = prevRun.results;
  const regressions = [], added = [], fixed = [], changed = [];
  for (const r of results) {
    const was = before[r.from];
    const failing = !r.ok;
    if (!was) { if (failing) added.push(pick(r)); continue; }
    if (was.ok && failing) regressions.push({ ...pick(r), was: was.result });
    else if (!was.ok && !failing) fixed.push({ ...pick(r), was: was.result });
    else if (!was.ok && failing && was.result !== r.result) changed.push({ ...pick(r), was: was.result });
  }
  const now = new Set(results.map(r => r.from));
  const removed = Object.keys(before).filter(k => !now.has(k));
  return { previousRun: prevRun.id, previousAt: prevRun.at, previousPhase: prevRun.phase, regressions, added, fixed, changed, removedFromMap: removed.length };
}

const pick = r => ({ from: r.from, to: r.to, result: r.result, group: r.group, detail: r.detail });

/**
 * Save a run and return the delta against the previous one.
 * Post-cutover runs are compared to the last pre-cutover run when compareTo='other-phase'.
 */
export function recordRun(dir, domain, run, { compareTo = 'previous' } = {}) {
  const hist = loadHistory(dir, domain);
  let prev = hist.runs.at(-1);
  if (compareTo === 'other-phase') prev = [...hist.runs].reverse().find(r => r.phase !== run.phase) || prev;
  const delta = computeDelta(prev, run.results);
  const slim = Object.fromEntries(run.results.map(r => [r.from, { result: r.result, ok: r.ok }]));
  hist.runs.push({ id: run.id, at: run.at, phase: run.phase, origin: run.origin, gate: run.gate.status, results: slim });
  hist.runs = hist.runs.slice(-KEEP);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(historyFile(dir, domain), hist);
  return delta;
}
