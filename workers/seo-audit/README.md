# seo-audit worker

The crawl behind `/seo-audit/`. A browser cannot fetch another origin's HTML
and this site is static on GitHub Pages, so the crawl has to run somewhere
else. It runs here, on the same Cloudflare account as the Elite editor worker.

## Deploy

```bash
cd workers/seo-audit
npx wrangler deploy
```

Then put the URL it prints into `seo-audit/index.html` — the `SA_ENDPOINT`
constant near the top of the page's script. Until that is set the page runs in
preview mode and says so on screen.

Optional, for keeping the leads:

```bash
npx wrangler kv namespace create AUDIT_LEADS
# paste the id into wrangler.toml, uncomment the binding, deploy again
```

**Without the KV binding the worker still returns the audit.** It simply does
not keep the lead. That is deliberate: the report a visitor asked for must not
depend on our CRM working.

## What it returns

`POST /` with `{website, company, name, email, phone, is_owner}` returns the
crawl — `pages[]` with the eleven slots assessed per page, plus the `services[]`
and `areas[]` it detected.

**It does not compute the grid or the score.** Both depend on which services and
areas are real, and only the owner knows that. The page asks them and recomputes
in the browser. A grid computed here would be thrown away the moment somebody
corrected a service, and a second round trip to redo arithmetic is a round trip
for nothing.

## Three things to know before this goes public

**The page cap is set by the subrequest ceiling, not by taste.** A Worker gets
**50 subrequests per request on the free plan**, 1000 on paid. Every page
fetched is one. `MAX_PAGES` is therefore **40**, which fits the free plan with
room for robots.txt and the sitemaps.

The page said "up to 300 pages" and the crawl did 40. **Resolved by changing the
copy** (2026-11-09), in all three places it appeared — the badge above the fold,
the FAQ, and the `FAQPage` schema, which is the one a copy fix forgets and the
one Google reads. Raising `MAX_PAGES` instead would need the paid plan.

40 still truncates a real grid: DMT has 22 service-area towns and the crawl
reaches 18 of them, so the four it misses are counted as pages they never built
when in fact we never looked. **The cap is reported in the response (`capped`,
`cap`) and the report has to say so**, because a share-of-grid score computed off
a truncated crawl is wrong in the direction that flatters us.

**There is no rate limiting.** Anyone can post any URL, so this is a crawler
pointed at whatever the internet asks it to crawl. It refuses private and
loopback hosts, and it refuses our own domain, but that is a floor rather than
an answer. Before it is linked publicly it wants a per-IP limit — Cloudflare
Rate Limiting on the route is the least code.

**The eleven slots are defined twice.** `lib/keyword-placement.mjs` in
`seo-system` is the source of truth, read by both the blog gate and the on-page
floor precisely so a post and its page cannot be held to two different ideas of
what optimised means. A Worker cannot import from that repo, so `SLOTS` in
`worker.js` is a restatement, and **it will drift.** The honest fix is to
generate it from that module at deploy time. Until that exists: anybody who
changes one changes the other.

## What it infers rather than knows

The keyword. It is taken from the slug, then the title, then the H1 — the same
thing the registry calls a `candidate_keyword` and explicitly forbids using as
a target. It is used only to measure a page against what the page itself says it
is about, and every panel on the report says so.

**Services and areas are read from four signals, in order of how much each one
knows:** the `/services/` and `/service-areas/` trees (certain), the site's own
nav grouping (strong — the owner grouped those pages themselves), a token run
recurring across 4+ slugs (the service family on a grid site), and a repeated
head noun (the flat-site fallback). Measured on three real Ontario trade sites,
all three shaped differently.

Slug POSITION is never used, and that is the point. One builder writes
`/ajax-home-builders/`, `/home-additions-barrie/`, `/home-addition-aurora/` and
`/custom-home-builder-angus/` — one grid, service first and last, singular and
plural. Frequency survives all four; position survives none of them.

Singular and plural are stemmed together before counting. Counted apart,
"home addition" (6) and "home additions" (12) each look minor, the bare token
"builder" wins on count, and a page of real services comes back as "Builders".

Page kind is inferred from the URL, which `lib/page-kind.mjs` warns is the wrong
source — it reads the cluster a page owns instead, and cannot here, because
there is no registry for somebody else's site. A slug like `/barrie/` could be
an area page or a case study. That is the main reason the page asks the owner to
confirm the services and the areas rather than presenting a grid as fact.
