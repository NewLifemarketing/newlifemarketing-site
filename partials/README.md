# Site chrome (shared header/footer)

`header.html` and `footer.html` are the **single source of truth** for the site
header (proof-bar + mega-menu nav) and footer. Every participating page embeds a
copy of these between marker comments; `scripts/sync-chrome.mjs` keeps those copies
identical to these files.

## Editing the header or footer

1. Edit `partials/header.html` and/or `partials/footer.html`.
2. Push to `main`. The **Sync site chrome** workflow (`.github/workflows/sync-chrome.yml`)
   runs `sync-chrome.mjs --write` and commits the propagated change across every
   participating page — including already-published posts.

Do **not** hand-edit the header/footer inside a page; it will be overwritten and
CI (`sync-chrome.mjs --check`) will flag it as drift.

## Markers

A page participates by wrapping its header and footer in these exact comments:

```
<!-- BEGIN SITE HEADER — managed by scripts/sync-chrome.mjs; edit partials/header.html, not here -->…<!-- END SITE HEADER -->
<!-- BEGIN SITE FOOTER — managed by scripts/sync-chrome.mjs; edit partials/footer.html, not here -->…<!-- END SITE FOOTER -->
```

Pages **without** the markers (e.g. `portal/*`, redirect stubs) are never touched.

## New posts must be born with the current chrome

The blog/article generation template (in the site-publisher / blog-writer agent
skill — **not** in this repo) must place the markers around the header and footer
and embed the **current** contents of `partials/header.html` / `partials/footer.html`
between them.

This is enforced: `auto-publish.yml` runs

```
node scripts/sync-chrome.mjs --check --only "blog/**/index.html"    --require-participation
node scripts/sync-chrome.mjs --check --only "articles/**/index.html" --require-participation
```

so a new post that is **missing the markers** or whose chrome is **out of date**
fails the publish gate (the reason is added to the PR comment / notification email).

> **Merge-ordering note:** this enforcement is only satisfiable once the external
> generation template embeds the markers. Update that template before (or together
> with) merging the chrome-sync change, or the next post PR will fail the gate.

## Commands

```
node scripts/sync-chrome.mjs --check     # report drift (CI); exit 1 if any
node scripts/sync-chrome.mjs --write     # propagate partials to all pages
node scripts/sync-chrome.mjs --adopt     # one-time: wrap markers + normalize (already done)
```
