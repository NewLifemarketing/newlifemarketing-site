#!/usr/bin/env node
// Validates a blog/{slug} PR against the site-publisher hard limits before
// auto-publish.yml is allowed to merge it. Zero npm dependencies on purpose
// so the workflow never needs an `npm install` step — everything here is
// built-in Node (fs, path, child_process) plus regex-based HTML checks.
//
// NOTE on "valid HTML": this is a pragmatic structural sanity check
// (doctype/html/head/body present exactly once, no obviously duplicated
// top-level tags) — not a full W3C validator. Swapping in a real validator
// (e.g. html-validate) is a reasonable future upgrade if this proves
// insufficient; it would just require adding a package.json + npm install.

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

const newPostPages = added.filter((p) => /^blog\/[^/]+\/index\.html$/.test(p));
if (newPostPages.length !== 1) {
  fail(
    `Expected exactly one new blog/{slug}/index.html to be added, found ${newPostPages.length}: ${newPostPages.join(", ") || "(none)"}`
  );
}
const newPostPath = newPostPages[0];
const slug = newPostPath ? newPostPath.split("/")[1] : null;

// every other added file must be an image for this slug, or the one-time blog-v2.css
for (const p of added) {
  if (p === newPostPath) continue;
  if (p === "css/blog-v2.css") continue;
  const imgMatch = p.match(/^assets\/blog\/([^/]+)\.(jpg|jpeg|png)$/i);
  if (imgMatch && slug && (imgMatch[1] === slug || imgMatch[1].startsWith(`${slug}-`))) {
    continue;
  }
  fail(`Unexpected new file outside the allowed scope: ${p}`);
}

// modified files: only blog/index.html, sitemap.xml, and at most one OTHER post's index.html
let prevNewestPath = null;
for (const p of modified) {
  if (p === "blog/index.html") continue;
  if (p === "sitemap.xml") continue;
  const m = p.match(/^blog\/([^/]+)\/index\.html$/);
  if (m && slug && m[1] !== slug) {
    if (prevNewestPath) {
      fail(`More than one existing post's index.html was modified (${prevNewestPath} and ${p}) — only the single previous-newest post's nav link may be touched.`);
    } else {
      prevNewestPath = p;
    }
    continue;
  }
  fail(`Unexpected modified file outside the allowed scope: ${p}`);
}

// ---------------------------------------------------------------------
// 2. blog/index.html — must be a pure insertion (one new card, nothing else changed)
// ---------------------------------------------------------------------
if (modified.includes("blog/index.html")) {
  const oldContent = showAtRef(mergeBase, "blog/index.html");
  const newContent = readFile(path.join(REPO_ROOT, "blog/index.html"));
  if (oldContent === null) {
    fail("blog/index.html modified but no previous version found at merge-base.");
  } else {
    const { oldMiddle } = pureInsertionMiddle(oldContent, newContent);
    if (oldMiddle !== "") {
      fail("blog/index.html was not purely additive — existing cards were changed, removed, or reordered.");
    } else if (slug && !newContent.includes(`href="/blog/${slug}/"`)) {
      // Checked against the whole file, not just the greedily-trimmed diff
      // region — adjacent cards share identical boilerplate
      // (`<a class="card reveal blog-card" href="/blog/`), so the prefix/
      // suffix split can cut through the middle of the inserted href itself.
      fail(`blog/index.html's inserted content doesn't link to the new post (/blog/${slug}/).`);
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
    } else if (slug && !newContent.includes(`${SITE_ORIGIN}/blog/${slug}/`)) {
      fail(`sitemap.xml's inserted content doesn't reference the new post's canonical URL.`);
    }
  }
}

// ---------------------------------------------------------------------
// 4. previous-newest post's index.html — must be exactly one empty
//    <span></span> replaced with a "← new post" nav link, nothing else
// ---------------------------------------------------------------------
if (prevNewestPath) {
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
        `<a class="btn ghost sm" href="/blog/${slug}/">[^<]*</a>`
      );
      const reverted = newContent.replace(anchorRe, "<span></span>");
      if (reverted !== oldContent) {
        fail(`${prevNewestPath} was changed beyond replacing its empty nav slot with a link to the new post — content, title, images, or body may have been touched.`);
      }
    }
  }
}

// ---------------------------------------------------------------------
// 5. The new post page itself — content-level checks
// ---------------------------------------------------------------------
let title = null;
let metaDescription = null;

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

  // no leftover fact-checker markers
  if (html.includes("[NEEDS SOURCE")) {
    fail(`Leftover "[NEEDS SOURCE" marker found in ${newPostPath} — fact-checker must resolve every marker before publish.`);
  }

  // title tag length — measured against the page title only. blog-writer.md
  // defines `title_tag` (the <=60-char value) as the bare page title; the
  // " | NewLife..." brand suffix is appended by the template afterward and
  // is not part of the measured string.
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

  // duplicate title vs existing posts (everything under blog/ except the new post itself)
  if (title) {
    const blogDirs = fs.readdirSync(path.join(REPO_ROOT, "blog"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => name !== slug);
    for (const otherSlug of blogDirs) {
      const otherPath = path.join("blog", otherSlug, "index.html");
      if (!exists(otherPath)) continue;
      const otherHtml = readFile(path.join(REPO_ROOT, otherPath));
      const otherTitleMatch = otherHtml.match(/<title>([\s\S]*?)<\/title>/i);
      const otherTitle = otherTitleMatch
        ? otherTitleMatch[1].trim().split(/\s*\|\s*/)[0].trim()
        : null;
      if (otherTitle && otherTitle === title) {
        fail(`Duplicate <title> — matches existing post blog/${otherSlug}/: "${title}"`);
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
  url: slug ? `${SITE_ORIGIN}/blog/${slug}/` : null,
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
