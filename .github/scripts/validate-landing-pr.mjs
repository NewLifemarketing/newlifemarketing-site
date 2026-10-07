#!/usr/bin/env node
// Validates a landing/{slug} or landing-review/{batch} PR before auto-publish.yml
// may act on it. Zero dependencies, like validate-blog-pr.mjs.
//
// TWO BRANCH SHAPES, DELIBERATELY DIFFERENT RULES
//
//   landing/{slug}          exactly ONE new page, and the branch name must be
//                           the slug. This branch auto-merges on a pass, so it
//                           stays one page at a time: a bad page can only ever
//                           publish itself.
//   landing-review/{name}   ONE OR MORE new pages. Never auto-merged — the
//                           owner merges by hand — so a batch is safe here.
//
// The landing-grid system runs as a batch by design (systems/landing-grid/CLAUDE.md:
// "a grid run is one batch, one preview, one approval"). This validator used to
// demand exactly one new page on every branch, which failed an 84-page grid run
// 79 times without ever assessing a single page. Every per-page check below is
// unchanged; they now simply run once per new page.
//
// What a landing PR is allowed to be — nothing else:
//   + one or more new ROOT-level pages:  {slug}/index.html
//   + new images under assets/locations/
//   ~ sitemap.xml            additive: every new URL present, none removed
//   ~ sitemap/index.html     additive: every new URL linked, none removed
//   ~ image-credits/index.html  pure insertion (optional)
//   ~ other pages ONLY inside their outbound-link block, and only if they
//     already had one
//
// These pages are deliberately NOT in the nav. Discovery is sitemap.xml and the
// footer-linked /sitemap/ page. So partials/, the homepage and every nav file
// are out of scope by construction.
//
// Run from the repo root. Writes validation-result.json for the workflow.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SITE_ORIGIN = "https://newlifemarketing.ca";
const failures = [];
const warnings = [];
const fail = (m) => failures.push(m);
const warn = (m) => warnings.push(m);

const nl = (s) => s.replace(/\r\n/g, "\n");
const read = (rel) => nl(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
const exists = (rel) => fs.existsSync(path.join(REPO_ROOT, rel));
const git = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
function showAtRef(ref, rel) {
  try { return nl(execFileSync("git", ["show", `${ref}:${rel}`], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return null; }
}
function insertionOnly(oldStr, newStr) {
  let p = 0; const m = Math.min(oldStr.length, newStr.length);
  while (p < m && oldStr[p] === newStr[p]) p++;
  let s = 0; const ms = m - p;
  while (s < ms && oldStr[oldStr.length - 1 - s] === newStr[newStr.length - 1 - s]) s++;
  return oldStr.slice(p, oldStr.length - s) === "";
}
const count = (s, re) => (s.match(re) || []).length;

// The outbound block had two names. It was "landing-siblings" when a city's
// grid pages linked to each other; the owner reversed that on 2026-10-07
// ("the grid pages should only ever be linked on the site map") and it became
// "landing-outbound". Both are accepted so the validator is not the thing that
// decides which generation of page may ship.
const SIB = /<!--\s*landing-(?:siblings|outbound):start\s*-->[\s\S]*?<!--\s*landing-(?:siblings|outbound):end\s*-->/;
const text = (s) => s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- 1. scope
try { git(["fetch", "origin", "main", "--quiet"]); } catch { /* local run without network: use what origin/main is */ }
const base = git(["merge-base", "origin/main", "HEAD"]).trim();
const changes = git(["diff", "--name-status", base, "HEAD"]).trim().split("\n").filter(Boolean)
  .map((l) => { const p = l.split("\t"); return { st: p[0][0], paths: p.slice(1) }; });

const added = [], modified = [];
for (const c of changes) {
  if (c.st === "A") added.push(c.paths[0]);
  else if (c.st === "M") modified.push(c.paths[0]);
  else fail(`Disallowed change (${c.st}): ${c.paths.join(" -> ")} — a landing PR only adds files and makes the allowed edits.`);
}

const branch = process.env.HEAD_REF || (() => { try { return git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(); } catch { return ""; } })();
const isReview = branch.startsWith("landing-review/");

const newPages = added.filter((p) => /^[a-z0-9]+(?:-[a-z0-9]+)*\/index\.html$/.test(p)).sort();
const pages = newPages.map((p) => { const slug = p.split("/")[0]; return { path: p, slug, url: `${SITE_ORIGIN}/${slug}/` }; });

if (pages.length === 0) {
  fail("No new root-level {slug}/index.html in this PR — a landing PR exists to add at least one page.");
} else if (!isReview && pages.length !== 1) {
  // landing/* auto-merges, so it stays one page per branch. Batches belong on
  // landing-review/*, which the workflow never merges by itself.
  fail(`A landing/* branch must add exactly one page, found ${pages.length}: ${pages.map((p) => p.slug).join(", ")}. `
    + "Put a batch on a landing-review/* branch instead — those are not merged automatically.");
}

const bm = branch.match(/^landing(?:-review)?\/(.+)$/);
if (bm && pages.length === 1 && bm[1] !== pages[0].slug) {
  fail(`Branch ${branch} does not match the new page's slug "${pages[0].slug}".`);
}

const newPagePaths = new Set(newPages);
for (const p of added) {
  if (newPagePaths.has(p)) continue;
  if (/^assets\/locations\/[a-z0-9-]+\.(jpe?g|png|webp)$/i.test(p)) continue;
  fail(`Unexpected new file: ${p} — only {slug}/index.html and assets/locations/* images may be added.`);
}

const siblingEdits = [];
for (const p of modified) {
  if (["sitemap.xml", "sitemap/index.html", "image-credits/index.html"].includes(p)) continue;
  if (/^[a-z0-9-]+\/index\.html$/.test(p) || /^[a-z0-9-]+\/[a-z0-9-]+\/index\.html$/.test(p)) { siblingEdits.push(p); continue; }
  fail(`Unexpected modified file: ${p}`);
}

// ---------------------------------------------------------------- 2. allowed edits
//
// The sitemap check is "additive" rather than "pure insertion". sitemap-sort.mjs
// keeps both files alphabetical, so adding 75 pages interleaves them through the
// existing entries and a prefix/suffix comparison reports the whole middle as
// changed. What actually matters is that nothing was lost and every new page is
// listed, which is what this checks.
function additive(rel, extract, label, required) {
  if (!modified.includes(rel)) return false;
  const before = showAtRef(base, rel), after = read(rel);
  if (before === null) { fail(`${rel}: no previous version at merge-base.`); return true; }
  const had = extract(before), has = new Set(extract(after));
  const lost = had.filter((x) => !has.has(x));
  if (lost.length) {
    fail(`${rel} lost ${lost.length} existing entr${lost.length === 1 ? "y" : "ies"} — a landing PR may only add. `
      + `First: ${lost.slice(0, 3).join(", ")}${lost.length > 3 ? ", …" : ""}`);
  }
  const missing = required.filter((x) => !has.has(x));
  if (missing.length) {
    fail(`${rel} does not list ${missing.length} of the new pages: `
      + `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""} — ${label}`);
  }
  return true;
}
const locsOf = (s) => [...s.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => m[1].trim());
const hrefsOf = (s) => [...s.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);

if (pages.length) {
  const sitemapOk = additive("sitemap.xml", locsOf,
    'run: node scripts/sitemap-sort.mjs --add "<url>" --title "..."', pages.map((p) => p.url));
  if (!sitemapOk) fail(`sitemap.xml must gain ${pages.map((p) => `<loc>${p.url}</loc>`).slice(0, 3).join(", ")}${pages.length > 3 ? ", …" : ""}.`);

  const indexOk = additive("sitemap/index.html", hrefsOf,
    "that is how these pages get crawled.", pages.map((p) => `/${p.slug}/`));
  if (!indexOk) fail("sitemap/index.html (the footer-linked site map) must list every new page — that is how they get crawled.");

  if (modified.includes("image-credits/index.html")) {
    const before = showAtRef(base, "image-credits/index.html"), after = read("image-credits/index.html");
    if (before !== null && !insertionOnly(before, after)) {
      fail("image-credits/index.html was not purely additive — existing content was changed, removed or reordered.");
    }
  }
}

for (const p of siblingEdits) {
  const before = showAtRef(base, p), after = read(p);
  if (before === null) { fail(`${p}: no previous version.`); continue; }
  if (!SIB.test(before)) { fail(`${p} was modified but has no outbound-link block on main — existing pages may only change inside that block.`); continue; }
  if (before.replace(SIB, "") !== after.replace(SIB, "")) fail(`${p} was changed outside its outbound-link block.`);
}

// ---------------------------------------------------------------- 3. the pages
//
// Build the site's existing <title> map ONCE. The previous version walked the
// whole site per page, which is fine for one page and is 75 full walks for a
// grid batch.
const walk = (rel = "") => fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !["assets", "css", "js", "partials", "node_modules"].includes(d.name))
  .flatMap((d) => { const r = rel ? `${rel}/${d.name}` : d.name; return [r, ...walk(r)]; });
const headTitle = (html) => ((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "").trim().split(/\s*\|\s*/)[0].trim();
const titlesInUse = new Map(); // lowercased title -> directory it belongs to
for (const d of ["", ...walk()]) {
  const f = d ? `${d}/index.html` : "index.html";
  if (newPagePaths.has(f) || !exists(f)) continue;
  const t = headTitle(read(f));
  if (t && !titlesInUse.has(t.toLowerCase())) titlesInUse.set(t.toLowerCase(), `/${d}/`);
}

for (const pg of pages) {
  const { path: page, slug, url } = pg;
  const at = (m) => fail(`${slug}: ${m}`);
  if (!exists(page)) { fail(`${page} is in the diff but not on disk.`); continue; }
  const html = read(page);

  for (const [re, label] of [[/<!doctype html>/gi, "DOCTYPE"], [/<html[ >]/gi, "<html>"], [/<\/html>/gi, "</html>"], [/<head[ >]/gi, "<head>"], [/<\/head>/gi, "</head>"], [/<body[ >]/gi, "<body>"], [/<\/body>/gi, "</body>"]]) {
    if (count(html, re) !== 1) at(`Structure: expected exactly one ${label}.`);
  }
  if (count(html, /<h1[ >]/gi) !== 1) at(`Expected exactly one <h1>, found ${count(html, /<h1[ >]/gi)}.`);

  const t = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!t) at("No <title>.");
  else {
    pg.title = headTitle(html);
    if (pg.title.length > 60) at(`Title is ${pg.title.length} chars (max 60 before " | brand"): "${pg.title}"`);
  }

  const mt = html.match(/<meta[^>]*name=["']description["'][^>]*>/i);
  pg.metaDescription = mt ? (mt[0].match(/content=(["'])([\s\S]*?)\1/i) || [])[2] ?? null : null;
  if (pg.metaDescription == null) at("No meta description.");
  else if (pg.metaDescription.length < 70 || pg.metaDescription.length > 160) at(`Meta description is ${pg.metaDescription.length} chars (70-160).`);

  const canon = ((html.match(/<link[^>]*rel=["']canonical["'][^>]*>/i) || [""])[0].match(/href=["']([^"']+)/) || [])[1];
  if (canon !== url) at(`Canonical must be ${url}, found ${canon || "(none)"}.`);
  if (/<meta[^>]*name=["']robots["'][^>]*noindex/i.test(html)) at("Page is noindex — a landing page exists to be indexed.");
  if (!/<meta[^>]*name=["']nl-page-type["'][^>]*content=["']landing["']/i.test(html)) at('Missing <meta name="nl-page-type" content="landing">.');
  if (!SIB.test(html)) at("Missing the <!-- landing-outbound:start --> … <!-- landing-outbound:end --> block.");
  if (!html.includes("END SITE HEADER") || !html.includes("BEGIN SITE FOOTER")) at("Missing the site chrome marker comments.");
  if (/\.tbc\b|\[NEEDS SOURCE|\bTODO\b|lorem ipsum/i.test(html)) at("Draft marker left in the page (.tbc / [NEEDS SOURCE / TODO / lorem).");

  const a = html.indexOf("END SITE HEADER"), z = html.indexOf("BEGIN SITE FOOTER");
  const body = a > -1 && z > a ? html.slice(a, z) : html;
  const words = text(body.replace(SIB, " ")).split(" ").filter(Boolean).length;
  if (words < 1200) at(`Body is ${words} words (min 1200).`);
  pg.words = words;

  // schema
  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const parsed = [];
  blocks.forEach((b, i) => { try { parsed.push(JSON.parse(b)); } catch (e) { at(`JSON-LD block ${i + 1} does not parse: ${e.message}`); } });
  const flat = JSON.stringify(parsed);
  for (const need of ["FAQPage", "BreadcrumbList"]) if (!flat.includes(`"${need}"`)) at(`Missing ${need} schema.`);
  if (!/"(Service|ProfessionalService)"/.test(flat)) at("Missing Service / ProfessionalService schema.");
  if (!flat.includes('"areaServed"')) at("Schema has no areaServed.");
  const own = parsed.flatMap((b) => (Array.isArray(b) ? b : b["@graph"] || [b]))
    .filter((b) => /aggregateRating|"Review"/.test(JSON.stringify(b)) && !/^https:\/\/newlifemarketing\.ca\/?$/.test(b.url || ""));
  if (own.length) at("Page-specific AggregateRating/Review markup — only the site-wide organization block (url = homepage) may carry the rating.");
  const faqQs = count(flat, /"@type":\s*"Question"/g), details = count(body, /<details\b/gi);
  if (faqQs !== details) warn(`${slug}: FAQPage has ${faqQs} questions but the page shows ${details}.`);

  // duplicate title, against the existing site AND against the rest of this batch
  if (pg.title) {
    const k = pg.title.toLowerCase();
    if (titlesInUse.has(k)) at(`Duplicate <title> with ${titlesInUse.get(k)}: "${pg.title}"`);
    else titlesInUse.set(k, `/${slug}/`);
  }

  // links and assets resolve
  for (const [, href] of html.matchAll(/href="(\/[^"]*)"/g)) {
    const clean = href.split("#")[0].split("?")[0];
    if (!clean || clean === "/") continue;
    const rel = clean.replace(/^\//, "");
    const cands = clean.endsWith("/") ? [path.join(rel, "index.html")] : [rel, path.join(rel, "index.html"), `${rel}.html`];
    if (!cands.some(exists)) at(`Internal link does not resolve: href="${href}"`);
  }
  for (const [, src] of html.matchAll(/(?:src|poster)="(\/[^"]*)"/g)) {
    const rel = src.split("#")[0].split("?")[0].replace(/^\//, "");
    if (!exists(rel)) at(`Referenced file does not exist: ${src}`);
  }
}

// ---------------------------------------------------------------- 4. sitemap order
try {
  const locs = locsOf(read("sitemap.xml"));
  const sorted = locs.slice().sort();
  const bad = locs.findIndex((l, i) => l !== sorted[i]);
  if (bad !== -1) fail(`sitemap.xml is not alphabetical (first out of place: ${locs[bad]}). Fix: node scripts/sitemap-sort.mjs --write`);
  const dupes = [...new Set(locs.filter((l, i) => locs.indexOf(l) !== i))];
  if (dupes.length) fail(`sitemap.xml has duplicate <loc>: ${dupes.join(", ")}`);
} catch (e) { fail(`Could not read sitemap.xml: ${e.message}`); }

// ---------------------------------------------------------------- output
// title/url stay populated for a single-page PR, because auto-publish.yml reads
// them for the merge subject and the notification. A batch reports a count.
const one = pages.length === 1 ? pages[0] : null;
const result = {
  pass: failures.length === 0,
  branch,
  batch: pages.length > 1,
  pageCount: pages.length,
  pages: pages.map((p) => ({ path: p.path, slug: p.slug, url: p.url, title: p.title ?? null, words: p.words ?? null })),
  slug: one ? one.slug : null,
  title: one ? one.title ?? null : `${pages.length} landing pages`,
  metaDescription: one ? one.metaDescription ?? null : null,
  url: one ? one.url : null,
  failures,
  warnings,
};
fs.writeFileSync(path.join(REPO_ROOT, "validation-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (failures.length) {
  console.error(`\nVALIDATION FAILED (${failures.length} issue(s)):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nVALIDATION PASSED (${pages.length} page${pages.length === 1 ? "" : "s"}).`);
