// Suspect changes: when a run finds regressions or new failures, list the commits that landed
// in a repository between the previous run and this one. A regression after a clean run almost
// always has a cause in that window — a config deploy, a routing change, a CMS export.
//
// Works with any repo the token can read (GitHub or GitHub Enterprise via --github-api).
// Uses only the commits endpoint, so it is one request per run. Never fails the run:
// an API problem is reported in suspects.error and the gate is unaffected.
import { USER_AGENT } from './util.mjs';

/** "owner/name", "https://github.com/owner/name(.git)" → { owner, name } */
export function parseRepo(spec) {
  if (!spec) return null;
  const s = String(spec).trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = s.match(/^(?:https?:\/\/[^/]+\/)?([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

/** First line of a commit message, and a PR number if the message carries one. */
export function describeCommit(message = '') {
  const title = String(message).split('\n')[0].trim();
  const m = title.match(/Merge pull request #(\d+)/) || title.match(/\(#(\d+)\)\s*$/) || title.match(/#(\d+)\b/);
  return { title, pr: m ? Number(m[1]) : null };
}

/** Should this run look for suspects? Only when something got worse. */
export const needsSuspects = delta => !!delta && (delta.regressions.length + delta.added.length) > 0;

export async function suspectChanges({ repo, path, since, until, api = 'https://api.github.com', token, limit = 30, timeoutMs = 10000 }) {
  const r = parseRepo(repo);
  const out = { repo, path: path || null, since, until, commits: [], truncated: false, error: null };
  if (!r) { out.error = `not a repository: "${repo}" (use owner/name)`; return out; }
  if (!since) { out.error = 'no previous run time to compare with'; return out; }
  const q = new URLSearchParams({ since, until, per_page: String(Math.min(limit + 1, 100)) });
  if (path) q.set('path', path);
  const url = `${api.replace(/\/+$/, '')}/repos/${r.owner}/${r.name}/commits?${q}`;
  const headers = { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      out.error = res.status === 404 ? `HTTP 404 — repo not found, or the token can't read it${token ? '' : ' (set GITHUB_TOKEN for private repos)'}`
        : res.status === 401 || res.status === 403 ? `HTTP ${res.status} — check GITHUB_TOKEN (rate limit or permissions)`
        : `HTTP ${res.status}`;
      return out;
    }
    const list = await res.json();
    if (!Array.isArray(list)) { out.error = 'unexpected API response'; return out; }
    out.truncated = list.length > limit;
    out.commits = list.slice(0, limit).map(c => {
      const { title, pr } = describeCommit(c.commit?.message);
      return {
        sha: c.sha, short: String(c.sha || '').slice(0, 7), title, pr,
        author: c.commit?.author?.name || c.author?.login || '',
        date: c.commit?.committer?.date || c.commit?.author?.date || '',
        url: c.html_url || '',
      };
    });
  } catch (e) {
    out.error = e.name === 'TimeoutError' ? 'timed out' : e.message;
  }
  return out;
}
