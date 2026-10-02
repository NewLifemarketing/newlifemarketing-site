#!/usr/bin/env node
// Validates a landing/{slug} (or landing-review/{slug}) PR from the
// landing-pages system (newlife-seo-system/systems/landing-pages) before
// auto-publish.yml may merge it. Zero dependencies, like validate-blog-pr.mjs.
//
// What a landing PR is allowed to be — nothing else:
//   + exactly one new ROOT-level page:  {slug}/index.html
//   + new images under assets/locations/
//   ~ sitemap.xml            pure insertion that references the new URL
//   ~ sitemap/index.html     pure insertion that links the new URL
//   ~ image-credits/index.html  pure insertion (optional)
//   ~ other pages ONLY inside their <!-- landing-siblings:start/end --> block
//     (the same-city link block), and only if they already had one
//
// These pages are deliberately NOT in the nav. Discovery is sitemap.xml, the
// footer-linked /sitemap/ page, and the sibling blocks. So partials/, the
// homepage and every nav file are out of scope by construction.
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
const SIB = /<!--\s*landing-siblings:start\s*-->[\s\S]*?<!--\s*landing-siblings:end\s*-->/;
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

const newPages = added.filter((p) => /^[a-z0-9]+(?:-[a-z0-9]+)*\/index\.html$/.test(p));
if (newPages.length !== 1) fail(`Expected exactly one new root-level {slug}/index.html, found ${newPages.length}: ${newPages.join(", ") || "(none)"}`);
const page = newPages[0] || null;
const slug = page ? page.split("/")[0] : null;
const url = slug ? `${SITE_ORIGIN}/${slug}/` : null;

const branch = process.env.HEAD_REF || (() => { try { return git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(); } catch { return ""; } })();
const bm = branch.match(/^landing(?:-review)?\/(.+)$/);
if (bm && slug && bm[1] !== slug) fail(`Branch ${branch} does not match the new page's slug "${slug}".`);

for (const p of added) {
  if (p === page) continue;
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
function pureInsertion(rel, mustContain) {
  if (!modified.includes(rel)) return false;
  const before = showAtRef(base, rel), after = read(rel);
  if (before === null) { fail(`${rel}: no previous version at merge-base.`); return true; }
  if (!insertionOnly(before, after)) fail(`${rel} was not purely additive — existing content was changed, removed or reordered.`);
  else if (mustContain && !after.includes(mustContain)) fail(`${rel}: the insertion doesn't reference ${mustContain}.`);
  return true;
}
if (slug) {
  if (!pureInsertion("sitemap.xml", `<loc>${url}</loc>`)) fail(`sitemap.xml must gain <loc>${url}</loc> (run: node scripts/sitemap-sort.mjs --add "${url}" --title "...").`);
  if (!pureInsertion("sitemap/index.html", `href="/${slug}/"`)) fail(`sitemap/index.html (the footer-linked site map) must list /${slug}/ — that is how this page gets crawled.`);
  pureInsertion("image-credits/index.html", null);
}
for (const p of siblingEdits) {
  const before = showAtRef(base, p), after = read(p);
  if (before === null) { fail(`${p}: no previous version.`); continue; }
  if (!SIB.test(before)) { fail(`${p} was modified but has no landing-siblings block on main — existing pages may only change inside that block.`); continue; }
  if (before.replace(SIB, "") !== after.replace(SIB, "")) fail(`${p} was changed outside its landing-siblings block.`);
  else if (slug && !after.match(SIB)[0].includes(`href="/${slug}/"`)) warn(`${p}: sibling block changed but doesn't link the new page.`);
}

// ---------------------------------------------------------------- 3. the page
let title = null, metaDescription = null;
if (page && exists(page)) {
  const html = read(page);
  for (const [re, label] of [[/<!doctype html>/gi, "DOCTYPE"], [/<html[ >]/gi, "<html>"], [/<\/html>/gi, "</html>"], [/<head[ >]/gi, "<head>"], [/<\/head>/gi, "</head>"], [/<body[ >]/gi, "<body>"], [/<\/body>/gi, "</body>"]]) {
    if (count(html, re) !== 1) fail(`Structure: expected exactly one ${label}.`);
  }
  if (count(html, /<h1[ >]/gi) !== 1) fail(`Expected exactly one <h1>, found ${count(html, /<h1[ >]/gi)}.`);

  const t = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!t) fail("No <title>.");
  else { title = t[1].trim().split(/\s*\|\s*/)[0].trim(); if (title.length > 60) fail(`Title is ${title.length} chars (max 60 before " | brand"): "${title}"`); }

  const mt = html.match(/<meta[^>]*name=["']description["'][^>]*>/i);
  metaDescription = mt ? (mt[0].match(/content=(["'])([\s\S]*?)\1/i) || [])[2] ?? null : null;
  if (metaDescription === null) fail("No meta description.");
  else if (metaDescription.length < 70 || metaDescription.length > 160) fail(`Meta description is ${metaDescription.length} chars (70-160).`);

  const canon = ((html.match(/<link[^>]*rel=["']canonical["'][^>]*>/i) || [""])[0].match(/href=["']([^"']+)/) || [])[1];
  if (canon !== url) fail(`Canonical must be ${url}, found ${canon || "(none)"}.`);
  if (/<meta[^>]*name=["']robots["'][^>]*noindex/i.test(html)) fail("Page is noindex — a landing page exists to be indexed.");
  if (!/<meta[^>]*name=["']nl-page-type["'][^>]*content=["']landing["']/i.test(html)) fail('Missing <meta name="nl-page-type" content="landing">.');
  if (!SIB.test(html)) fail("Missing the <!-- landing-siblings:start --> … <!-- landing-siblings:end --> block.");
  if (!html.includes("END SITE HEADER") || !html.includes("BEGIN SITE FOOTER")) fail("Missing the site chrome marker comments.");
  if (/\.tbc\b|\[NEEDS SOURCE|\bTODO\b|lorem ipsum/i.test(html)) fail("Draft marker left in the page (.tbc / [NEEDS SOURCE / TODO / lorem).");

  const a = html.indexOf("END SITE HEADER"), z = html.indexOf("BEGIN SITE FOOTER");
  const body = a > -1 && z > a ? html.slice(a, z) : html;
  const words = text(body.replace(SIB, " ")).split(" ").filter(Boolean).length;
  if (words < 1200) fail(`Body is ${words} words (min 1200).`);

  // schema
  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const parsed = [];
  blocks.forEach((b, i) => { try { parsed.push(JSON.parse(b)); } catch (e) { fail(`JSON-LD block ${i + 1} does not parse: ${e.message}`); } });
  const flat = JSON.stringify(parsed);
  for (const need of ["FAQPage", "BreadcrumbList"]) if (!flat.includes(`"${need}"`)) fail(`Missing ${need} schema.`);
  if (!/"(Service|ProfessionalService)"/.test(flat)) fail("Missing Service / ProfessionalService schema.");
  if (!flat.includes('"areaServed"')) fail("Schema has no areaServed.");
  const own = parsed.flatMap((b) => (Array.isArray(b) ? b : b["@graph"] || [b]))
    .filter((b) => /aggregateRating|"Review"/.test(JSON.stringify(b)) && !/^https:\/\/newlifemarketing\.ca\/?$/.test(b.url || ""));
  if (own.length) fail("Page-specific AggregateRating/Review markup — only the site-wide organization block (url = homepage) may carry the rating.");
  const faqQs = count(flat, /"@type":\s*"Question"/g), details = count(body, /<details\b/gi);
  if (faqQs !== details) warn(`FAQPage has ${faqQs} questions but the page shows ${details}.`);

  // duplicate title anywhere on the site
  if (title) {
    const walk = (rel = "") => fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !["assets", "css", "js", "partials", "node_modules"].includes(d.name))
      .flatMap((d) => { const r = rel ? `${rel}/${d.name}` : d.name; return [r, ...walk(r)]; });
    for (const d of ["", ...walk()]) {
      const f = d ? `${d}/index.html` : "index.html";
      if (f === page || !exists(f)) continue;
      const ot = (read(f).match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
      if (ot && ot.trim().split(/\s*\|\s*/)[0].trim().toLowerCase() === title.toLowerCase()) { fail(`Duplicate <title> with /${d}/: "${title}"`); break; }
    }
  }

  // links and assets resolve
  for (const [, href] of html.matchAll(/href="(\/[^"]*)"/g)) {
    const clean = href.split("#")[0].split("?")[0];
    if (!clean || clean === "/") continue;
    const rel = clean.replace(/^\//, "");
    const cands = clean.endsWith("/") ? [path.join(rel, "index.html")] : [rel, path.join(rel, "index.html"), `${rel}.html`];
    if (!cands.some(exists)) fail(`Internal link does not resolve: href="${href}"`);
  }
  for (const [, src] of html.matchAll(/(?:src|poster)="(\/[^"]*)"/g)) {
    const rel = src.split("#")[0].split("?")[0].replace(/^\//, "");
    if (!exists(rel)) fail(`Referenced file does not exist: ${src}`);
  }
} else if (page) {
  fail(`${page} is in the diff but not on disk.`);
}

// ---------------------------------------------------------------- 4. sitemap order
try {
  const locs = [...read("sitemap.xml").matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => m[1].trim());
  const sorted = locs.slice().sort();
  const bad = locs.findIndex((l, i) => l !== sorted[i]);
  if (bad !== -1) fail(`sitemap.xml is not alphabetical (first out of place: ${locs[bad]}). Fix: node scripts/sitemap-sort.mjs --write`);
  const dupes = [...new Set(locs.filter((l, i) => locs.indexOf(l) !== i))];
  if (dupes.length) fail(`sitemap.xml has duplicate <loc>: ${dupes.join(", ")}`);
} catch (e) { fail(`Could not read sitemap.xml: ${e.message}`); }

// ---------------------------------------------------------------- output
const result = { pass: failures.length === 0, slug, title, metaDescription, url, branch, failures, warnings };
fs.writeFileSync(path.join(REPO_ROOT, "validation-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (failures.length) {
  console.error(`\nVALIDATION FAILED (${failures.length} issue(s)):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nVALIDATION PASSED.");
