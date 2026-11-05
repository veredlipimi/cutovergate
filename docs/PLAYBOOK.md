# Redirect Gate: Team Playbook

> **Source of truth:** the redirect map for each site.
> **Gate rule:** the release is blocked until effective failures = 0.

The map is the single source of truth. Everything CutoverGate checks, and everything your platform registers, comes from that file. If the deployed redirects don't match the map, that is a gap to fix, not to waive.

## 1. Pre-flight (before deploy)

```bash
cutovergate preflight --map map.csv --legacy-urls legacy-urls.txt
```

Fix every **error** before deploying. Review each **warning**; most of them are real problems. **Info** items are usually expected.

**One redirect per logical page.** Old sites often expose the same page under several spellings, such as `contact_us.htm`, `contact_us.cfm` and `contact_us/`. Pre-flight groups these spellings. If they all point to the same place, it reports info. If they point to different places, it reports a warning (`VARIANT_CONFLICT`).

**Build the legacy URL list from every source you have:** the old sitemap, analytics top landing pages, backlink reports, and the navigation. Any URL on that list with no rule is reported as `UNMAPPED_LEGACY_URL`.

## 2. Live probe (after deploy)

```bash
cutovergate probe --map map.csv --candidates "staging=…,live=…" --fingerprint "header:…" --exceptions exceptions.json
```

The phase badge shows which origin answered as the new platform. If the result is NOT ON TARGET, check your VPN (for staging) or DNS (for live).

## 3. Handling failures

**Fix the root cause (preferred).** For MISSING or WRONG_TARGET, fix the deploy or the map and re-run. The delta panel shows what changed.

**Add an exception** only for failures that are known, intentional, or waiting on a fix elsewhere:

| TTL | When to use it |
|---|---|
| none | The page was permanently retired, so the redirect is truly not needed |
| 7 days | A hotfix is waiting to merge |
| 14 days | Waiting for the next deploy batch |
| 30 days | Waiting for a migration milestone |
| 90 days | A long-running dependency on another team |

## 4. Strict mode

Use `--strict` for the **final** pre-cutover check. In strict mode, network errors block the gate even when they are excepted, so a flaky connection can't hide real gaps.

## 5. Cutover, then verify

Run this after the DNS change:

```bash
cutovergate verify --map map.csv --candidates "staging=…,live=…" --fingerprint "header:…"
```

1. The phase must be **live**.
2. The delta compares against the last pre-cutover run. Any regression needs immediate attention.
3. The gate must pass before you close the migration ticket.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Every rule in one group is MISSING | That group's rules were never deployed | Check the deploy step for that group |
| Old URLs answer 200 with no redirect | The new platform isn't serving yet, or a catch-all route catches them | Check the origin and the routing order |
| Many URLs redirect to `/` | A catch-all redirect overrides specific rules | Put specific rules first; remove the catch-all |
| Most of a group has WRONG_TARGET | The deployed config comes from a different version of the map | Redeploy from the current map |
| NOT ON TARGET | VPN not connected, DNS not switched, or a wrong fingerprint | Check `--fingerprint` against the response headers |
| The gate passes but a redirect looks wrong | A WRONG_TARGET was waived | Review the exceptions panel, remove the waiver, fix the target |
| A regression after a config change | A redeploy overwrote a correct rule | Compare the deploy with the previous run |
| Many ERRORs | Rate limiting or a firewall | Lower `--concurrency`, add `--delay-ms`, re-run with `--strict` |
