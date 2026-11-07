// Notifications to Slack and Microsoft Teams through incoming webhooks.
//
//   Slack: an incoming webhook (https://api.slack.com/messaging/webhooks)
//          --notify-slack URL  or  $CUTOVERGATE_SLACK_WEBHOOK
//   Teams: a Workflows webhook ("Post to a channel when a webhook request is received").
//          Teams' old Office 365 connectors are retired; Workflows accepts the same
//          message + Adaptive Card envelope, so one format works for both.
//          --notify-teams URL  or  $CUTOVERGATE_TEAMS_WEBHOOK
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

export function shouldNotifyBatch(rows, on = 'fail') {
  const anyRegression = rows.some(r => r.regressions > 0), anyFail = rows.some(r => r.gate !== 'PASS');
  return on === 'always' || (on === 'regression' ? anyRegression : anyFail || anyRegression);
}

// ------------------------------------------------------------- one model, two formats
const MAX = 5;

/** Everything a notification says about one run, independent of the channel. */
export function runSummary(run) {
  if (run.skipped) return { ok: false, title: `${run.domain} — NOT ON TARGET`, subtitle: run.reason, facts: [], sections: [] };
  const g = run.gate;
  const d = run.delta;
  const facts = [
    ['Gate', g.status], ['Phase', `${run.phase}${g.strict ? ' (strict)' : ''}`],
    ['Probed', g.probed], ['Passed', g.passed], ['Excepted', g.excepted], ['Effective failures', g.effectiveFailures],
  ];
  if (d) facts.push(['Delta', `${d.regressions.length} regressions · ${d.added.length} new · ${d.fixed.length} fixed`]);
  const sections = [];
  if (d?.regressions.length) sections.push({ title: 'Regressions', items: d.regressions.map(r => ({ code: r.from, text: `${r.was} → ${r.result}` })) });
  const open = run.results.filter(r => !r.ok && !r.excepted && !d?.regressions.some(x => x.from === r.from));
  if (open.length) sections.push({ title: 'Failing', items: open.map(r => ({ code: r.from, text: `${r.result}${r.detail ? ` — ${r.detail}` : ''}` })) });
  const s = run.suspects;
  if (s?.commits.length) sections.push({ title: `Changes in ${s.repo}${s.path ? `/${s.path}` : ''} since the previous run`, max: 3, items: s.commits.map(c => ({ link: c.url, label: c.short, text: `${c.title}${c.author ? ` — ${c.author}` : ''}` })) });
  const hints = run.taxonomy.hints.filter(h => h.level === 'high').slice(0, 2).map(h => h.text);
  return { ok: g.status === 'PASS' && !d?.regressions.length, title: `${run.domain} — gate ${g.status}`, facts, sections, hints };
}

export function batchSummary(rows) {
  const pass = rows.filter(r => r.gate === 'PASS').length;
  const bad = rows.filter(r => r.gate !== 'PASS' || r.regressions > 0);
  return {
    ok: !bad.length, title: `Redirect gate batch — ${pass}/${rows.length} sites pass`, facts: [], hints: [],
    sections: bad.length ? [{ title: 'Needs attention', max: 15, items: bad.map(r => ({ strong: r.domain, text: `${r.gate}${r.regressions ? ` · ${r.regressions} regressions` : ''}${r.detail ? ` — ${r.detail}` : ''}` })) }] : [],
  };
}

const more = (items, n) => items.length > n ? items.length - n : 0;

/** Slack: plain mrkdwn text, so it renders the same in every client. */
export function toSlack(sum) {
  const lines = [`${sum.ok ? ':white_check_mark:' : ':no_entry:'} *${sum.title}*`];
  if (sum.subtitle) lines.push(sum.subtitle);
  const f = Object.fromEntries(sum.facts);
  if (sum.facts.length) {
    lines.push(`${f.Phase} · probed ${f.Probed} · passed ${f.Passed} · excepted ${f.Excepted} · *effective failures ${f['Effective failures']}*`);
    if (f.Delta) lines.push(`delta: ${f.Delta}`);
  }
  for (const s of sum.sections) {
    const n = s.max || MAX;
    lines.push(`*${s.title}*`, ...s.items.slice(0, n).map(i => `• ${i.link ? `<${i.link}|${i.label}> ` : i.code ? `\`${i.code}\` ` : i.strong ? `*${i.strong}* ` : ''}${i.text}`));
    if (more(s.items, n)) lines.push(`… ${more(s.items, n)} more`);
  }
  for (const h of sum.hints) lines.push(`:small_red_triangle: ${h}`);
  return { text: lines.join('\n') };
}

/** Teams: an Adaptive Card in a message envelope (what Workflows webhooks expect). */
export function toTeams(sum) {
  const body = [{ type: 'TextBlock', text: sum.title, weight: 'Bolder', size: 'Large', wrap: true, color: sum.ok ? 'Good' : 'Attention' }];
  if (sum.subtitle) body.push({ type: 'TextBlock', text: sum.subtitle, wrap: true });
  if (sum.facts.length) body.push({ type: 'FactSet', facts: sum.facts.map(([title, value]) => ({ title, value: String(value) })) });
  for (const s of sum.sections) {
    const n = s.max || MAX;
    body.push({ type: 'TextBlock', text: s.title, weight: 'Bolder', wrap: true, spacing: 'Medium' });
    const lines = s.items.slice(0, n).map(i => `- ${i.link ? `[${i.label}](${i.link}) ` : i.code ? `\`${i.code}\` ` : i.strong ? `**${i.strong}** ` : ''}${i.text}`);
    if (more(s.items, n)) lines.push(`- … ${more(s.items, n)} more`);
    body.push({ type: 'TextBlock', text: lines.join('\n'), wrap: true });
  }
  for (const h of sum.hints) body.push({ type: 'TextBlock', text: `▲ ${h}`, wrap: true, color: 'Attention' });
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body } }],
  };
}

const FORMAT = { slack: toSlack, teams: toTeams };

// Kept for callers of the first version.
export const runMessage = run => toSlack(runSummary(run));
export const batchMessage = rows => toSlack(batchSummary(rows));

export async function postWebhook(url, payload, { timeoutMs = 10000 } = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timed out' : e.message };
  }
}
export const postSlack = postWebhook;

/** Send one summary to every configured target: [{ kind: 'slack'|'teams', url }]. */
export async function send(targets, sum) {
  return Promise.all(targets.map(async t => ({ kind: t.kind, ...(await postWebhook(t.url, FORMAT[t.kind](sum))) })));
}
