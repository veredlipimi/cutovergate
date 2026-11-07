// Exports: JSON (full detail), CSV (spreadsheet / status email), HTML (self-contained, filterable).
// Filename format: redirect-qa-{domain}-{datetime}.{ext}
import fs from 'node:fs';
import path from 'node:path';
import { toCsv, writeJson, safeName, c } from './util.mjs';
import { RESULTS } from './probe.mjs';

const COLUMNS = ['result', 'excepted', 'group', 'from', 'to', 'expectedStatus', 'httpStatus', 'actual', 'hops', 'detail', 'chain', 'variantOf', 'note', 'line'];

export function writeExports(run, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  let base = path.join(outDir, `redirect-qa-${safeName(run.domain)}-${run.id}`);
  for (let i = 2; fs.existsSync(base + '.json'); i++) base = path.join(outDir, `redirect-qa-${safeName(run.domain)}-${run.id}-${i}`);
  writeJson(base + '.json', run);
  const rows = run.results.map(r => ({ ...r, excepted: r.excepted ? `yes: ${r.excepted.reason}${r.excepted.expires ? ` (until ${r.excepted.expires})` : ''}` : '' }));
  fs.writeFileSync(base + '.csv', toCsv(rows, COLUMNS));
  fs.writeFileSync(base + '.html', html(run));
  return { json: base + '.json', csv: base + '.csv', html: base + '.html' };
}

export function printSummary(run, { quiet = false } = {}) {
  const g = run.gate;
  const badge = g.status === 'PASS' ? c.green(c.bold(' GATE PASS ')) : g.status === 'BLOCKED' ? c.yellow(c.bold(' GATE BLOCKED ')) : c.red(c.bold(' GATE FAIL '));
  const lines = [];
  lines.push('', `${badge}  ${run.domain}  ${c.dim(`origin ${run.origin} · phase ${run.phase}${g.strict ? ' · STRICT' : ''}`)}`);
  if (g.blocked) lines.push('  ' + c.yellow(g.blocked.reason));
  lines.push(`  probed ${g.probed} · passed ${g.passed} · failed ${g.failures} · excepted ${g.excepted} · ${c.bold(`effective failures ${g.effectiveFailures}`)}`);
  lines.push('  ' + Object.entries(g.counts).map(([k, v]) => `${k} ${v}`).join(' · '));
  if (run.delta) {
    const d = run.delta;
    lines.push(`  delta vs ${d.previousRun}${d.previousPhase && d.previousPhase !== run.phase ? ` (${d.previousPhase})` : ''}: ` +
      `${d.regressions.length ? c.red(`${d.regressions.length} regressions`) : '0 regressions'} · ${d.added.length} new · ${c.green(`${d.fixed.length} fixed`)}`);
  }
  if (run.suspects) {
    const s = run.suspects;
    if (s.error) lines.push(`  ${c.yellow('⚠')} suspect changes unavailable (${s.repo}): ${s.error}`);
    else {
      lines.push(`  changes in ${s.repo}${s.path ? `/${s.path}` : ''} since the previous run: ${s.commits.length}${s.truncated ? '+' : ''} commits`);
      for (const k of s.commits.slice(0, 5)) lines.push(`    ${c.cyan(k.short)} ${k.title}${k.author ? c.dim(` — ${k.author}`) : ''}`);
    }
  }
  for (const h of run.taxonomy.hints) lines.push(`  ${h.level === 'high' ? c.red('▲') : c.yellow('●')} ${h.source === 'custom' ? c.dim(`[${h.id}] `) : ''}${h.text}`);
  for (const e of run.gate.exceptions.expiringSoon) lines.push(`  ${c.yellow('⚠')} exception for ${e.path} expires ${e.expires}`);
  for (const e of run.gate.exceptions.invalid) lines.push(`  ${c.yellow('⚠')} exception ignored (${e.problem}): ${e.path || '?'}`);
  if (!quiet) {
    const bad = run.results.filter(r => !r.ok);
    if (bad.length) {
      lines.push('', c.bold('  Failures'));
      for (const r of bad.slice(0, 40)) lines.push(`  ${r.excepted ? c.dim('EXCEPTED') : c.red(r.result.padEnd(13))} ${r.from}  ${c.dim(r.detail || '')}`);
      if (bad.length > 40) lines.push(c.dim(`  … ${bad.length - 40} more in the report`));
    }
  }
  console.log(lines.join('\n'));
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function suspects(s) {
  if (!s) return '';
  const where = `${esc(s.repo)}${s.path ? `/${esc(s.path)}` : ''}`;
  if (s.error) return `<div class="hint">Suspect changes unavailable (${where}): ${esc(s.error)}</div>`;
  if (!s.commits.length) return `<div class="muted" style="margin-top:8px">No commits in ${where} between the two runs — look outside the repo (manual config, CMS, CDN).</div>`;
  return `<details open><summary>Changes in ${where} since the previous run <b>${s.commits.length}${s.truncated ? '+' : ''}</b></summary><ul>${s.commits.map(k => `<li><a href="${esc(k.url)}"><code>${esc(k.short)}</code></a> ${esc(k.title)} <span class="muted">${esc(k.author)} · ${esc(String(k.date).slice(0, 10))}</span></li>`).join('')}</ul></details>`;
}

function html(run) {
  const g = run.gate;
  const d = run.delta;
  const resultKeys = Object.keys(RESULTS).filter(k => g.counts[k]);
  const tax = Object.entries(run.taxonomy.matrix);
  const failKeys = [...new Set(run.results.filter(r => !r.ok).map(r => r.result))];
  const deltaList = (title, items, cls) => items.length ? `<details ${cls === 'reg' ? 'open' : ''}><summary class="${cls}">${title} <b>${items.length}</b></summary><ul>${items.slice(0, 200).map(i => `<li><code>${esc(i.from)}</code> ${i.was ? `<span class="muted">${esc(i.was)} →</span> ` : ''}<span class="pill ${RESULTS[i.result]?.ok ? 'ok' : 'bad'}">${esc(i.result)}</span></li>`).join('')}</ul></details>` : `<div class="muted">${title}: 0</div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Redirect QA — ${esc(run.domain)}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--ok:#1f7a4d;--okbg:#e5f3ea;--bad:#b3261e;--badbg:#fbe9e7;--warn:#8a5a00;--warnbg:#fdf3dc;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--muted:#9c9b94;--line:#33322f;--ok:#5fcf93;--okbg:#17301f;--bad:#ff8a80;--badbg:#3a1a17;--warn:#f0c36a;--warnbg:#3a2e12;--accent:#8aa8ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0}h2{font-size:15px;margin:28px 0 10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.gate{font-weight:800;font-size:18px;padding:8px 16px;border-radius:8px}.gate.PASS{background:var(--okbg);color:var(--ok)}.gate.FAIL{background:var(--badbg);color:var(--bad)}.gate.BLOCKED{background:var(--warnbg);color:var(--warn)}
.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--muted);margin-right:6px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-top:14px}.stat b{display:block;font-size:24px}.stat span{color:var(--muted);font-size:12px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}.pill.ok{background:var(--okbg);color:var(--ok)}.pill.bad{background:var(--badbg);color:var(--bad)}.pill.exc{background:var(--warnbg);color:var(--warn)}
.muted{color:var(--muted)}code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.hint{padding:8px 12px;border-left:3px solid var(--warn);background:var(--warnbg);border-radius:4px;margin:6px 0}.hint.high{border-color:var(--bad);background:var(--badbg)}
table{width:100%;border-collapse:collapse;background:var(--card)}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--card)}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.filters button{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:4px 12px;cursor:pointer;font:inherit;font-size:12px}.filters button.on{background:var(--ink);color:var(--bg)}
input[type=search]{width:100%;max-width:340px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:760px){.grid2{grid-template-columns:1fr}}
details summary{cursor:pointer;padding:4px 0}summary.reg{color:var(--bad);font-weight:700}a{color:var(--accent)}ul{margin:4px 0 8px;padding-left:18px}
button.copy{white-space:nowrap;border:1px solid var(--line);background:none;color:var(--accent);border-radius:6px;font-size:11px;padding:1px 6px;cursor:pointer}
footer{margin-top:40px;color:var(--muted);font-size:12px}
</style></head><body><main>
<div class="card head">
  <div><h1>${esc(run.domain)}</h1>
  <div style="margin-top:6px"><span class="badge">phase: ${esc(run.phase)}</span><span class="badge">origin: ${esc(run.origin)}</span>${g.strict ? '<span class="badge">STRICT</span>' : ''}<span class="badge">${esc(run.at)}</span></div></div>
  <div class="gate ${g.status}">GATE ${g.status}</div>${g.blocked ? `<div class="hint high">${esc(g.blocked.reason)}</div>` : ''}
</div>
<div class="stats">
  <div class="card stat"><b>${g.probed}</b><span>probed</span></div>
  <div class="card stat"><b>${g.passed}</b><span>passed</span></div>
  <div class="card stat"><b>${g.failures}</b><span>failed</span></div>
  <div class="card stat"><b>${g.excepted}</b><span>excepted</span></div>
  <div class="card stat"><b style="color:${g.effectiveFailures ? 'var(--bad)' : 'var(--ok)'}">${g.effectiveFailures}</b><span>effective failures (gate)</span></div>
</div>

${run.taxonomy.hints.length ? `<h2>Triage</h2>${run.taxonomy.hints.map(h => `<div class="hint ${h.level}">${h.source === 'custom' ? `<b>${esc(h.id)}</b> · ` : ''}${esc(h.text)}</div>`).join('')}` : ''}

<div class="grid2">
<section><h2>Delta</h2><div class="card">${d ? `<div class="muted" style="margin-bottom:6px">vs ${esc(d.previousRun)}${d.previousPhase ? ` · ${esc(d.previousPhase)}` : ''}</div>${deltaList('Regressions (was passing → now failing)', d.regressions, 'reg')}${deltaList('New failures', d.added, '')}${deltaList('Fixed', d.fixed, '')}${d.changed.length ? deltaList('Failing, different result', d.changed, '') : ''}${suspects(run.suspects)}` : '<div class="muted">First run on this domain — the delta appears from the second run.</div>'}</div></section>
<section><h2>Exceptions</h2><div class="card">
${g.exceptions.active.length ? `<ul>${g.exceptions.active.map(e => `<li><code>${esc(e.path)}</code> — ${esc(e.reason)} <span class="muted">${e.expires ? `until ${esc(e.expires)}` : 'no expiry'}${e.used ? '' : ' · not used this run'}</span></li>`).join('')}</ul>` : '<div class="muted">No active exceptions.</div>'}
${g.exceptions.expiringSoon.map(e => `<div class="hint">⚠ ${esc(e.path)} expires ${esc(e.expires)}</div>`).join('')}
${g.exceptions.expired.length ? `<div class="muted">Expired (not applied): ${g.exceptions.expired.map(e => `<code>${esc(e.path)}</code>`).join(', ')}</div>` : ''}
${g.exceptions.invalid.length ? `<div class="hint">Ignored — ${g.exceptions.invalid.map(e => `${esc(e.path || '?')} (${esc(e.problem)})`).join(', ')}</div>` : ''}
${g.strict ? '<div class="muted">Strict mode: network ERRORs block even when excepted.</div>' : ''}
</div></section>
</div>

${failKeys.length ? `<h2>Failure taxonomy (group × result)</h2><div class="tablewrap"><table><thead><tr><th>Group</th><th>Rules</th>${failKeys.map(k => `<th>${k}</th>`).join('')}</tr></thead><tbody>${tax.map(([gname, row]) => `<tr><td>${esc(gname)}</td><td>${row.total}</td>${failKeys.map(k => `<td>${row[k] ? `<span class="pill bad">${row[k]}</span>` : '<span class="muted">·</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}

<h2>Results</h2>
<div class="filters" id="f"><button data-k="all" class="on">All ${g.probed}</button><button data-k="fail">Failing ${g.failures}</button>${resultKeys.map(k => `<button data-k="${k}">${k} ${g.counts[k]}</button>`).join('')}<button data-k="exc">Excepted ${g.excepted}</button></div>
<input type="search" id="q" placeholder="Filter by path, group or detail…" aria-label="Filter results">
<div class="tablewrap" style="margin-top:10px"><table id="t"><thead><tr><th>Result</th><th>From</th><th>Expected</th><th>Actual</th><th>HTTP</th><th>Group</th><th>Detail</th><th></th></tr></thead><tbody>
${run.results.map(r => `<tr data-r="${r.result}" data-ok="${r.ok ? 1 : 0}" data-exc="${r.excepted ? 1 : 0}">
<td>${r.excepted ? `<span class="pill exc" title="${esc(r.excepted.reason)}">EXCEPTED</span><br><span class="muted" style="font-size:11px">${r.result}</span>` : `<span class="pill ${r.ok ? 'ok' : 'bad'}">${r.result}</span>`}</td>
<td><code>${esc(r.from)}</code></td><td><code>${esc(r.to || r.expectedStatus)}</code></td><td><code>${esc(r.actual || '')}</code></td><td>${r.httpStatus || '—'}${r.hops > 1 ? `<br><span class="muted" style="font-size:11px">${r.hops} hops</span>` : ''}</td>
<td>${esc(r.group)}</td><td>${esc(r.detail)}${r.exceptionIgnored ? `<br><span class="muted">${esc(r.exceptionIgnored)}</span>` : ''}</td>
<td>${!r.ok && !r.excepted ? `<button class="copy" data-p="${esc(r.from)}" title="Copy the command that adds an exception for this path">+ exception</button>` : ''}</td></tr>`).join('')}
</tbody></table></div>
<footer>CutoverGate · map ${esc(run.map)} · ${esc(run.id)} · accepted statuses ${esc(run.accept.join('/'))}</footer>
</main>
<script>
(function(){var key='all',q='';var rows=[].slice.call(document.querySelectorAll('#t tbody tr'));
function apply(){rows.forEach(function(tr){var m=key==='all'||(key==='fail'&&tr.dataset.ok==='0')||(key==='exc'&&tr.dataset.exc==='1')||tr.dataset.r===key;
if(m&&q)m=tr.textContent.toLowerCase().indexOf(q)>-1;tr.style.display=m?'':'none';});}
document.getElementById('f').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;key=b.dataset.k;
[].forEach.call(this.children,function(x){x.classList.toggle('on',x===b)});apply();});
document.getElementById('q').addEventListener('input',function(){q=this.value.toLowerCase();apply();});
document.getElementById('t').addEventListener('click',function(e){var b=e.target.closest('button.copy');if(!b)return;
var cmd='cutovergate exceptions add --file exceptions.json --path "'+b.dataset.p+'" --ttl 14 --reason "..."';
try{navigator.clipboard.writeText(cmd);b.textContent='copied';}catch(err){prompt('Command',cmd);}});
})();
</script></body></html>`;
}
