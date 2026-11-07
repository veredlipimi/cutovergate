// Slack notifications through an incoming webhook (https://api.slack.com/messaging/webhooks).
// The webhook URL comes from --notify-slack or $CUTOVERGATE_SLACK_WEBHOOK.
//
// --notify-on fail        (default) gate FAIL, or any regression even when the gate passes
// --notify-on regression  only when something that passed before now fails
// --notify-on always      every run
import { USER_AGENT } from './util.mjs';

export const NOTIFY_ON = ['fail', 'regression', 'always'];

export function shouldNotify(run, on = 'fail') {
  if (!run || run.skipped) return on === 'always';
  const regressions = run.delta?.regressions.length || 0;
  if (on === 'always') return true;
  if (on === 'regression') return regressions > 0;
  return run.gate.status !== 'PASS' || regressions > 0;
}

const list = (items, n, fmt) => items.slice(0, n).map(fmt).join('\n') + (items.length > n ? `\n… ${items.length - n} more` : '');

/** One run → Slack message. Plain mrkdwn text, no blocks, so it renders the same in every client. */
export function runMessage(run) {
  if (run.skipped) return { text: `:satellite_antenna: *${run.domain}* — NOT ON TARGET: ${run.reason}` };
  const g = run.gate;
  const d = run.delta;
  const icon = g.status === 'PASS' ? ':white_check_mark:' : ':no_entry:';
  const lines = [
    `${icon} *${run.domain}* — gate *${g.status}* (${run.phase}${g.strict ? ', strict' : ''})`,
    `probed ${g.probed} · passed ${g.passed} · excepted ${g.excepted} · *effective failures ${g.effectiveFailures}*`,
  ];
  if (d) lines.push(`delta vs ${d.previousRun}: ${d.regressions.length} regressions · ${d.added.length} new · ${d.fixed.length} fixed`);
  if (d?.regressions.length) lines.push('*Regressions*', list(d.regressions, 5, r => `• \`${r.from}\` ${r.was} → ${r.result}`));
  const open = run.results.filter(r => !r.ok && !r.excepted && !d?.regressions.some(x => x.from === r.from));
  if (open.length) lines.push('*Failing*', list(open, 5, r => `• \`${r.from}\` ${r.result}${r.detail ? ` — ${r.detail}` : ''}`));
  const s = run.suspects;
  if (s?.commits.length) lines.push(`*Changes in ${s.repo}${s.path ? `/${s.path}` : ''} since the previous run*`, list(s.commits, 3, c => `• <${c.url}|${c.short}> ${c.title}${c.author ? ` — ${c.author}` : ''}`));
  for (const h of run.taxonomy.hints.filter(h => h.level === 'high').slice(0, 2)) lines.push(`:small_red_triangle: ${h.text}`);
  return { text: lines.join('\n') };
}

/** Batch → one summary message. */
export function batchMessage(rows) {
  const pass = rows.filter(r => r.gate === 'PASS').length;
  const bad = rows.filter(r => r.gate !== 'PASS');
  const lines = [`${bad.length ? ':no_entry:' : ':white_check_mark:'} *Redirect gate batch*: ${pass}/${rows.length} sites pass`];
  if (bad.length) lines.push(list(bad, 15, r => `• *${r.domain}* ${r.gate}${r.regressions ? ` · ${r.regressions} regressions` : ''}${r.detail ? ` — ${r.detail}` : ''}`));
  return { text: lines.join('\n') };
}

export async function postSlack(webhook, payload, { timeoutMs = 10000 } = {}) {
  try {
    const res = await fetch(webhook, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timed out' : e.message };
  }
}
