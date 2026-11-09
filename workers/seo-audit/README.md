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

The page currently says "up to 300 pages". **One of those two numbers is wrong
and it has to be fixed before launch** — either raise `MAX_PAGES` on the paid
plan or change the copy. A run that truncates silently at 40 while the page
promised 300 is the kind of thing nobody notices for months.

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

Page kind is inferred from the URL, which `lib/page-kind.mjs` warns is the wrong
source — it reads the cluster a page owns instead, and cannot here, because
there is no registry for somebody else's site. A slug like `/barrie/` could be
an area page or a case study. That is the main reason the page asks the owner to
confirm the services and the areas rather than presenting a grid as fact.
