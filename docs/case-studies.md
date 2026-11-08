# Case studies: public, documented migrations

Each site below announced its migration publicly. CutoverGate was run against the old domain with read-only GET requests (3 in parallel, 200 ms apart). The legacy URL map was rebuilt from the Wayback Machine with `harvest --mode any`: any working target counts as a pass, except the homepage (a soft 404) or a broken page.

What is reported here is what was observed on the date of the run. A cause is labelled **Likely** or **Possible** when it is inferred. The Nura and Everpure runs were repeated, and the repeat gave the same result (`delta: 0 regressions · 0 new · 0 fixed`). The Eluviant and Magnific runs were run once.

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

## IntelexVision → Eluviant

- **Move:** `www.intelexvision.com` → `www.eluviant.com`. The company announced its new name on 15 July 2026.
- **Run:** 8 November 2026. 150 legacy URLs. One run so far.

| Result | Count |
|---|---|
| Lands where expected | 1 |
| Lands on the homepage | 149 |

**What happens:** every deep page on the old domain answers 301 to `https://www.eluviant.com`, the homepage. **Likely** a domain-level redirect that drops the path, so no old page keeps its address. Search engines treat this as a soft 404.

**Why it matters, verified with curl on 8 November 2026:**

| Old URL | Today | On the new site |
|---|---|---|
| `/about/` | 301 → homepage | `/about` leads to `/about-us`, which answers 200: a matching page exists |
| `/contact/` | 301 → homepage | `/contact` answers 404 |
| `/careers/` | 301 → homepage | `/careers` answers 404 |
| `/privacy-policy/` | 301 → homepage | `/privacy-policy` answers 404 |

At least one old page has a direct match on the new site and still lands on the homepage. Whether the others have matches under different names was not checked.

---

## Freepik → Magnific: a run that is not a result

- **Move:** `www.freepik.com` → `www.magnific.com`. Magnific's docs say Freepik links redirect so saved links keep working.
- **Run:** 8 November 2026. 150 legacy URLs.

All 150 URLs answered HTTP 403 with no redirect. CutoverGate marked the run **BLOCKED**: the site refused the probe (**Possible:** bot protection or rate limiting), so the run says nothing about the redirects. It did not report 150 failures, did not pass or fail the gate, and was kept out of history. No attempt was made to get around the protection.

---

## What this shows

- The same tool, the same rules, very different migrations: one with a single missing page, one where 43 of 150 archived blog URLs (29%) do not arrive where they should, and one where 149 of 150 land on the homepage.
- When a site refuses the probe, the run is reported as not tested (BLOCKED), not as 150 failures.
- The failures are grouped into a few causes, so the fix is a handful of rule changes, not 43 tickets.
- Results are repeatable: a second run on the same map gives the same result.
