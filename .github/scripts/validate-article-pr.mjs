#!/usr/bin/env node
// Validates an articles/{slug} PR against the site-publisher hard limits before
// auto-publish.yml is allowed to merge it. Sibling to validate-blog-pr.mjs —
// same approach, scoped to articles/ instead of blog/. Zero npm dependencies
// on purpose so the workflow never needs an `npm install` step.
//
// NOTE on "valid HTML": this is a pragmatic structural sanity check
// (doctype/html/head/body present exactly once, no obviously duplicated
// top-level tags) — not a full W3C validator, and it does not inspect
// <script> tag contents at all (inline Chart.js configs, gtag snippets,
// JSON-LD blocks are all untouched by every check below).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SITE_ORIGIN = "https://www.newlifemarketing.ca";
const failures = [];
const warnings = [];

function fail(msg) {
  failures.push(msg);
}

// Windows checkouts with core.autocrlf normalize LF -> CRLF on disk, while
// `git show <ref>:<path>` returns the raw (LF) blob — normalize both sides
// before any diff/equality comparison so that's never mistaken for a real
// content change.
function normalizeNewlines(s) {
  return s.replace(/\r\n/g, "\n");
}

function readFile(p) {
  return normalizeNewlines(fs.readFileSync(p, "utf8"));
}

function exists(relPath) {
  return fs.existsSync(path.join(REPO_ROOT, relPath));
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

function showAtRef(ref, relPath) {
  try {
    return normalizeNewlines(
      execFileSync("git", ["show", `${ref}:${relPath}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      })
    );
  } catch {
    return null; // file didn't exist at that ref
  }
}

// "old + exactly one inserted block, nothing removed, nothing reordered"
function pureInsertionMiddle(oldStr, newStr) {
  let prefix = 0;
  const maxPrefix = Math.min(oldStr.length, newStr.length);
  while (prefix < maxPrefix && oldStr[prefix] === newStr[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(oldStr.length, newStr.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldStr[oldStr.length - 1 - suffix] === newStr[newStr.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldMiddle = oldStr.slice(prefix, oldStr.length - suffix);
  const newMiddle = newStr.slice(prefix, newStr.length - suffix);
  return { oldMiddle, newMiddle };
}

function countMatches(str, re) {
  const m = str.match(re);
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------
// 1. Diff scope: figure out exactly what this PR touches
// ---------------------------------------------------------------------
git(["fetch", "origin", "main", "--quiet"]);
const mergeBase = git(["merge-base", "origin/main", "HEAD"]).trim();
const diffOut = git(["diff", "--name-status", mergeBase, "HEAD"]).trim();
const changes = diffOut
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const parts = line.split("\t");
    return { status: parts[0][0], paths: parts.slice(1) };
  });

const added = [];
const modified = [];
for (const c of changes) {
  if (c.status === "A") added.push(c.paths[0]);
  else if (c.status === "M") modified.push(c.paths[0]);
  else fail(`Disallowed change (${c.status}): ${c.paths.join(" -> ")} — only additions and the specific allowed edits are permitted; nothing may be deleted, renamed, or copied.`);
}

const newPostPages = added.filter((p) => /^articles\/[^/]+\/index\.html$/.test(p));
if (newPostPages.length !== 1) {
  fail(
    `Expected exactly one new articles/{slug}/index.html to be added, found ${newPostPages.length}: ${newPostPages.join(", ") || "(none)"}`
  );
}
const newPostPath = newPostPages[0];
const slug = newPostPath ? newPostPath.split("/")[1] : null;

// every other added file must be an image for this slug (in its own
// assets/articles/{slug}/ folder), or the one-time css/article-v1.css
for (const p of added) {
  if (p === newPostPath) continue;
  if (p === "css/article-v1.css") continue;
  const imgMatch = p.match(/^assets\/articles\/([^/]+)\/[^/]+\.(jpg|jpeg|png)$/i);
  if (imgMatch && slug && imgMatch[1] === slug) {
    continue;
  }
  fail(`Unexpected new file outside the allowed scope: ${p}`);
}

// modified files: only articles/index.html, sitemap.xml, and at most one
// OTHER article's index.html (the previous newest, to fill its empty
// "next" nav span)
let prevNewestPath = null;
for (const p of modified) {
  if (p === "articles/index.html") continue;
  if (p === "sitemap.xml") continue;
  const m = p.match(/^articles\/([^/]+)\/index\.html$/);
  if (m && slug && m[1] !== slug) {
    if (prevNewestPath) {
      fail(`More than one existing article's index.html was modified (${prevNewestPath} and ${p}) — only the single previous-newest article's nav link may be touched.`);
    } else {
      prevNewestPath = p;
    }
    continue;
  }
  fail(`Unexpected modified file outside the allowed scope: ${p}`);
}

// ---------------------------------------------------------------------
// 2. articles/index.html — must be a pure insertion (one new card, nothing else changed)
// ---------------------------------------------------------------------
if (modified.includes("articles/index.html")) {
  const oldContent = showAtRef(mergeBase, "articles/index.html");
  const newContent = readFile(path.join(REPO_ROOT, "articles/index.html"));
  if (oldContent === null) {
    fail("articles/index.html modified but no previous version found at merge-base.");
  } else {
    const { oldMiddle } = pureInsertionMiddle(oldContent, newContent);
    if (oldMiddle !== "") {
      fail("articles/index.html was not purely additive — existing cards were changed, removed, or reordered.");
    } else if (slug && !newContent.includes(`href="/articles/${slug}/"`)) {
      fail(`articles/index.html's inserted content doesn't link to the new post (/articles/${slug}/).`);
    }
  }
}

// ---------------------------------------------------------------------
// 3. sitemap.xml — must be a pure insertion of exactly one <url> entry
// ---------------------------------------------------------------------
if (modified.includes("sitemap.xml")) {
  const oldContent = showAtRef(mergeBase, "sitemap.xml");
  const newContent = readFile(path.join(REPO_ROOT, "sitemap.xml"));
  if (oldContent === null) {
    fail("sitemap.xml modified but no previous version found at merge-base.");
  } else {
    const { oldMiddle } = pureInsertionMiddle(oldContent, newContent);
    if (oldMiddle !== "") {
      fail("sitemap.xml was not purely additive — existing <url> entries were changed, removed, or reordered.");
    } else if (slug && !newContent.includes(`${SITE_ORIGIN}/articles/${slug}/`)) {
      fail(`sitemap.xml's inserted content doesn't reference the new post's canonical URL.`);
    }
  }
}

// ---------------------------------------------------------------------
// 4. previous-newest article's index.html — must be exactly one empty
//    <span></span> replaced with a "next article" nav link, nothing else.
//    The previous newest article is determined from articles/index.html's
//    card order at merge-base (first card = newest before this PR's
//    insertion) — the modified file's own name/slug is not trusted alone.
// ---------------------------------------------------------------------
if (prevNewestPath) {
  const oldIndexContent = showAtRef(mergeBase, "articles/index.html");
  const firstCardMatch = oldIndexContent
    ? oldIndexContent.match(/class="card reveal blog-card" href="\/articles\/([^/"]+)\/"/)
    : null;
  const expectedPrevNewestSlug = firstCardMatch ? firstCardMatch[1] : null;
  const prevNewestSlug = prevNewestPath.split("/")[1];
  if (!expectedPrevNewestSlug) {
    fail("Could not determine the previous newest article from articles/index.html's card order at merge-base.");
  } else if (prevNewestSlug !== expectedPrevNewestSlug) {
    fail(`${prevNewestPath} was modified, but the previous newest article (per articles/index.html's card order) is articles/${expectedPrevNewestSlug}/ — only that article's nav link may be touched.`);
  }

  const oldContent = showAtRef(mergeBase, prevNewestPath);
  const newContent = readFile(path.join(REPO_ROOT, prevNewestPath));
  if (oldContent === null) {
    fail(`${prevNewestPath} modified but no previous version found at merge-base.`);
  } else {
    const emptySpanCount = countMatches(oldContent, /<span><\/span>/g);
    if (emptySpanCount !== 1) {
      fail(`${prevNewestPath}: expected exactly one empty <span></span> nav placeholder in the previous version, found ${emptySpanCount}.`);
    } else if (slug) {
      const anchorRe = new RegExp(
        `<a class="btn ghost sm" href="/articles/${slug}/">[^<]*</a>`
      );
      const reverted = newContent.replace(anchorRe, "<span></span>");
      if (reverted !== oldContent) {
        fail(`${prevNewestPath} was changed beyond replacing its empty nav slot with a link to the new article — content, title, images, or body may have been touched.`);
      }
    }
  }
}

// ---------------------------------------------------------------------
// 5. The new article page itself — content-level checks
// ---------------------------------------------------------------------
let title = null;
let metaDescription = null;

// The shared page template has one permanent, decorative placeholder baked
// into the footer video lightbox on every page (blog and articles alike) —
// it is never meant to be resolved and is present on live, published posts.
// Every other "[NEEDS: ...]" marker (e.g. unwritten body content) must fail.
const NEEDS_MARKER_RE = /\[NEEDS:[^\]]*\]/g;
const PERMANENT_NEEDS_PLACEHOLDER = "[NEEDS: final video file]";

if (newPostPath && exists(newPostPath)) {
  const html = readFile(path.join(REPO_ROOT, newPostPath));

  // structural sanity (not full W3C validation — see file header note)
  const structuralChecks = [
    [/<!doctype html>/i, "DOCTYPE"],
    [/<html[ >]/i, "<html>"],
    [/<\/html>/i, "</html>"],
    [/<head[ >]/i, "<head>"],
    [/<\/head>/i, "</head>"],
    [/<body[ >]/i, "<body>"],
    [/<\/body>/i, "</body>"],
  ];
  for (const [re, label] of structuralChecks) {
    if (countMatches(html, new RegExp(re, "gi")) !== 1) {
      fail(`Structural HTML check failed: expected exactly one ${label} in ${newPostPath}.`);
    }
  }

  // exactly one H1
  const h1Count = countMatches(html, /<h1[ >]/gi);
  if (h1Count !== 1) {
    fail(`Expected exactly one <h1>, found ${h1Count} in ${newPostPath}.`);
  }

  // no leftover placeholder markers, except the one permanent placeholder
  const needsMarkers = [...html.matchAll(NEEDS_MARKER_RE)]
    .map((m) => m[0])
    .filter((marker) => marker !== PERMANENT_NEEDS_PLACEHOLDER);
  if (needsMarkers.length > 0) {
    fail(`Leftover placeholder marker(s) found in ${newPostPath}: ${needsMarkers.join(", ")} — every marker except the permanent "${PERMANENT_NEEDS_PLACEHOLDER}" video placeholder must be resolved before publish.`);
  }

  // title tag length — measured against the page title only, same
  // convention as validate-blog-pr.mjs (brand suffix excluded).
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!titleMatch) {
    fail(`No <title> tag found in ${newPostPath}.`);
  } else {
    const fullTitle = titleMatch[1].trim();
    title = fullTitle.split(/\s*\|\s*/)[0].trim();
    if (title.length > 60) {
      fail(`Title tag is ${title.length} characters (max 60): "${title}"`);
    }
  }

  // meta description length. The content-attribute regex must only stop at
  // the SAME quote character that opened it — [^"']* incorrectly treats an
  // apostrophe inside the description (e.g. "Here's") as the closing quote
  // and truncates the match.
  const metaTagMatch = html.match(/<meta[^>]*name=["']description["'][^>]*>/i);
  if (!metaTagMatch) {
    fail(`No <meta name="description"> tag found in ${newPostPath}.`);
  } else {
    const contentMatch = metaTagMatch[0].match(/content=(["'])([\s\S]*?)\1/i);
    metaDescription = contentMatch ? contentMatch[2] : null;
    if (metaDescription === null) {
      fail(`<meta name="description"> tag has no content attribute in ${newPostPath}.`);
    } else if (metaDescription.length < 150 || metaDescription.length > 160) {
      fail(`Meta description is ${metaDescription.length} characters (must be 150-160): "${metaDescription}"`);
    }
  }

  // duplicate title vs existing articles (everything under articles/ except the new post itself)
  if (title) {
    const articleDirs = fs.readdirSync(path.join(REPO_ROOT, "articles"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => name !== slug);
    for (const otherSlug of articleDirs) {
      const otherPath = path.join("articles", otherSlug, "index.html");
      if (!exists(otherPath)) continue;
      const otherHtml = readFile(path.join(REPO_ROOT, otherPath));
      const otherTitleMatch = otherHtml.match(/<title>([\s\S]*?)<\/title>/i);
      const otherTitle = otherTitleMatch
        ? otherTitleMatch[1].trim().split(/\s*\|\s*/)[0].trim()
        : null;
      if (otherTitle && otherTitle === title) {
        fail(`Duplicate <title> — matches existing article articles/${otherSlug}/: "${title}"`);
        break;
      }
    }
  }

  // internal links resolve to real files
  const hrefs = [...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    const clean = href.split("#")[0].split("?")[0];
    if (clean === "") continue;
    const rel = clean.replace(/^\//, "");
    const candidates =
      clean.endsWith("/") || clean === "/"
        ? [path.join(rel, "index.html")]
        : [rel, path.join(rel, "index.html"), `${rel}.html`];
    if (!candidates.some((c) => exists(c))) {
      fail(`Internal link does not resolve to a real file: href="${href}"`);
    }
  }

  // images referenced actually exist
  const srcs = [...html.matchAll(/src="(\/[^"]*)"/g)].map((m) => m[1]);
  for (const src of srcs) {
    const clean = src.split("#")[0].split("?")[0];
    const rel = clean.replace(/^\//, "");
    if (!exists(rel)) {
      fail(`Referenced image does not exist in the repo: src="${src}"`);
    }
  }
} else if (newPostPath) {
  fail(`${newPostPath} was reported as added but is not present on disk.`);
}

// ---------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------
const pass = failures.length === 0;
const result = {
  pass,
  slug,
  title,
  metaDescription,
  url: slug ? `${SITE_ORIGIN}/articles/${slug}/` : null,
  failures,
  warnings,
};

fs.writeFileSync(
  path.join(REPO_ROOT, "validation-result.json"),
  JSON.stringify(result, null, 2)
);

console.log(JSON.stringify(result, null, 2));
if (!pass) {
  console.error(`\nVALIDATION FAILED (${failures.length} issue(s)):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log("\nVALIDATION PASSED.");
  process.exit(0);
}
