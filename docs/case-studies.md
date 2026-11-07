# Case studies: public, documented migrations

Each site below announced its migration publicly. CutoverGate was run against the old domain with read-only GET requests (3 in parallel, 200 ms apart). The legacy URL map was rebuilt from the Wayback Machine with `harvest --mode any`: any working target counts as a pass, except the homepage (a soft 404) or a broken page.

What is reported here is what was observed on the date of the run. A cause is labelled **Likely** or **Possible** when it is inferred. Every run was repeated, and the second run gave the same result (`delta: 0 regressions · 0 new · 0 fixed`).

How to reproduce any line below:

```bash
curl -sIL https://OLD-DOMAIN/PATH | grep -iE "^(HTTP|location)"
```

---

## postmarketOS → Nura

- **Move:** `postmarketos.org` → `nura.eco`. The project announced its new name on 27 September 2026.
- **Run:** 7 November 2026. 150 legacy URLs.

| Result | Count |
|---|---|
| Lands on a working page | 149 |
| Lands on a broken page | 1 |

**The one gap:** `/edge/2024/03/12/python-3.12/` redirects (301) to the same path on `nura.eco`, which answers 404. Verified with curl on 7 November 2026.

A clean migration: one archived post did not make it to the new site.

---

## Pure Storage → Everpure (blog)

- **Move:** `blog.purestorage.com` → `blog.everpuredata.com`, after the company renamed itself Everpure in 2026.
- **Run:** 7 November 2026. 150 legacy URLs.

| Result | Count |
|---|---|
| Lands on a working page | 107 |
| Lands on a broken page | 38 |
| Lands on the homepage | 5 |

**Why the 38 land on a broken page**, as CutoverGate groups them:

| Cause | Count | What happens | Example, verified with curl on 7 November 2026 |
|---|---|---|---|
| The old path is kept | 19 | The redirect keeps the path, and that path does not exist on the new blog. **Likely** a domain-level redirect that preserves the path. | `/bytes-ai-data-lifecycle/` → 301 → same path on the new blog → 404 |
| Sent to the error page | 9 | The redirect points at the new blog's `/404/` page. **Likely** a fallback for unknown slugs. | `/can-pure-make-cloud-storage-better/` → 301 → same path → 301 → `/404/` → 404 |
| Moved under a section that does not exist | 6 | The slug is kept but placed under a new section (`/uncategorized/…`, `/purely-technical/…`), which answers 404. | `/assigning-read-access-to-windows-private-key/` → 301 → same path → 301 → `/uncategorized/…` → 404 |
| The target was retired | 2 | The target answers 410 Gone. | `/an-annual-company-kick-off-to-remember/` → 301 → same path → 301 → `/uncategorized/…` → 410 |
| No common cause | 2 | | |

**The 5 that land on the homepage:** a deep article is sent to `/`. For example, `/7-questions-for-dell/` goes through three redirects and ends on the homepage. Verified with curl on 7 November 2026. Search engines treat this as a soft 404.

---

## What this shows

- The same tool, the same rules, two very different migrations: one with a single missing page, one where 43 of 150 archived blog URLs (29%) do not arrive where they should.
- The failures are grouped into a few causes, so the fix is a handful of rule changes, not 43 tickets.
- Results are repeatable: a second run on the same map gives the same result.
