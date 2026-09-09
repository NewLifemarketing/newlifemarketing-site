#!/usr/bin/env node
/**
 * keyword-audit.mjs — prove that a page edit did not lose any keyword placement.
 *
 * Target keywords come from the SEO pipeline's declared source of truth:
 *   ../newlife-seo-system/config/page-target-keywords.json
 * That file is what the on-page agent and blog-writer already read, so it stays
 * authoritative — this script never invents a keyword.
 *
 *   node scripts/keyword-audit.mjs                    report current placements
 *   node scripts/keyword-audit.mjs --snapshot         write .keyword-baseline.json
 *   node scripts/keyword-audit.mjs --compare          exit 1 on ANY regression
 *   node scripts/keyword-audit.mjs --page services/seo/    limit to one page
 *
 * Tracked per page: title · meta description · H1 · first 100 words · H2 hits ·
 * H3 hits · exact-phrase body count · body word count · images · images whose
 * alt contains the keyword · slug.
 *
 * A regression is a boolean going true -> false, or a count going down. Counts
 * going UP is the intent, so it never fails on growth.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KW_CONFIG = path.resolve(ROOT, '..', '..', 'newlife-seo-system', 'config',
                               'page-target-keywords.json');
const BASELINE = path.join(ROOT, '.keyword-baseline.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };

const mode = has('--snapshot') ? 'snapshot' : has('--compare') ? 'compare' : 'report';
const onlyPage = valOf('--page');

// ------------------------------------------------------------------ helpers --
const strip = (s) => s
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ');

const unent = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&#8217;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '-').replace(/&ndash;/g, '-');

const norm = (s) => unent(s).toLowerCase().replace(/\s+/g, ' ').trim();

function bodyOf(src) {
  // the chrome is identical on every page and would skew every count
  let b = src;
  const a = b.indexOf('END SITE HEADER');
  if (a > -1) b = b.slice(a);
  const z = b.indexOf('BEGIN SITE FOOTER');
  if (z > -1) b = b.slice(0, z);
  return b;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) {
    const j = haystack.indexOf(needle, i);
    if (j === -1) return n;
    n++; i = j + needle.length;
  }
}

function measure(relDir, src, keyword) {
  const kw = norm(keyword);
  const body = bodyOf(src);

  const titleM = src.match(/<title>([\s\S]*?)<\/title>/i);
  const descM = src.match(/<meta\s+name="description"\s+content="([\s\S]*?)"/i);
  const h1M = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  const h2s = [...body.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => norm(strip(m[1])));
  const h3s = [...body.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)].map((m) => norm(strip(m[1])));
  const alts = [...body.matchAll(/<img[^>]*\balt="([^"]*)"/gi)].map((m) => norm(m[1]));
  const imgTotal = (body.match(/<img\b/gi) || []).length;

  const text = norm(strip(body));
  const words = text ? text.split(' ').length : 0;
  const first100 = text.split(' ').slice(0, 100).join(' ');

  return {
    slug: '/' + relDir.replace(/\\/g, '/'),
    keyword,
    inTitle: titleM ? norm(titleM[1]).includes(kw) : false,
    inMetaDescription: descM ? norm(descM[1]).includes(kw) : false,
    inH1: h1M ? norm(strip(h1M[1])).includes(kw) : false,
    inFirst100Words: first100.includes(kw),
    inSlug: ('/' + relDir.replace(/\\/g, '/')).includes(kw.replace(/\s+/g, '-')),
    h2Hits: h2s.filter((h) => h.includes(kw)).length,
    h2Total: h2s.length,
    h3Hits: h3s.filter((h) => h.includes(kw)).length,
    h3Total: h3s.length,
    bodyExactCount: countOccurrences(text, kw),
    bodyWords: words,
    images: imgTotal,
    imagesWithKeywordAlt: alts.filter((a) => a.includes(kw)).length,
    altsMissingKeyword: alts.filter((a) => !a.includes(kw)).length,
  };
}

// ------------------------------------------------------------------- inputs --
if (!fs.existsSync(KW_CONFIG)) {
  console.error(`Cannot find the keyword config at:\n  ${KW_CONFIG}`);
  console.error('This script reads the declared targets, it does not guess them.');
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync(KW_CONFIG, 'utf8'));
const declared = cfg.pages || {};

const BOOLS = ['inTitle', 'inMetaDescription', 'inH1', 'inFirst100Words', 'inSlug'];
const COUNTS = ['h2Hits', 'h3Hits', 'bodyExactCount', 'imagesWithKeywordAlt'];

const results = {};
let missingPages = 0;

for (const [url, entry] of Object.entries(declared)) {
  if (onlyPage && !url.includes(onlyPage.replace(/^\/|\/$/g, ''))) continue;
  const relDir = url.replace(/^\/|\/$/g, '');
  const file = path.join(ROOT, relDir, 'index.html');
  const rootFile = path.join(ROOT, 'index.html');
  const target = url === '/' ? rootFile : file;
  if (!fs.existsSync(target)) {
    console.error(`  ! ${url} declared in config but no page on disk`);
    missingPages++;
    continue;
  }
  results[url] = measure(relDir, fs.readFileSync(target, 'utf8'), entry.target_keyword);
}

if (!Object.keys(results).length) {
  console.error('No pages measured. Check --page, or the config has no matching entries.');
  process.exit(2);
}

// ------------------------------------------------------------------ output ---
function printRow(url, r) {
  const yn = (b) => (b ? 'yes' : 'NO ');
  console.log(`\n${url}   target: "${r.keyword}"`);
  console.log(`  title ${yn(r.inTitle)}   meta ${yn(r.inMetaDescription)}   `
            + `h1 ${yn(r.inH1)}   first100 ${yn(r.inFirst100Words)}   slug ${yn(r.inSlug)}`);
  console.log(`  h2 ${r.h2Hits}/${r.h2Total}   h3 ${r.h3Hits}/${r.h3Total}   `
            + `body ${r.bodyExactCount}x in ${r.bodyWords}w   `
            + `alts ${r.imagesWithKeywordAlt}/${r.images}`);
  if (r.altsMissingKeyword > 0) {
    console.log(`  -> ${r.altsMissingKeyword} image alt(s) missing the keyword`);
  }
}

if (mode === 'report' || mode === 'snapshot') {
  for (const [url, r] of Object.entries(results)) printRow(url, r);
}

if (mode === 'snapshot') {
  fs.writeFileSync(BASELINE, JSON.stringify(results, null, 2));
  console.log(`\nBaseline written to .keyword-baseline.json (${Object.keys(results).length} page(s)).`);
  console.log('Edit the pages, then run --compare.');
  process.exit(0);
}

if (mode === 'report') {
  console.log(`\n${Object.keys(results).length} page(s) measured. `
            + `${Object.keys(declared).length} declared in config.`);
  if (missingPages) process.exit(2);
  process.exit(0);
}

// ------------------------------------------------------------------ compare --
if (!fs.existsSync(BASELINE)) {
  console.error('No .keyword-baseline.json found. Run --snapshot before editing.');
  process.exit(2);
}
const before = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const regressions = [];
const gains = [];

for (const [url, after] of Object.entries(results)) {
  const prev = before[url];
  if (!prev) {
    console.log(`  (new since baseline: ${url})`);
    continue;
  }
  for (const k of BOOLS) {
    if (prev[k] && !after[k]) regressions.push(`${url}: ${k} was present, now missing`);
  }
  for (const k of COUNTS) {
    if (after[k] < prev[k]) {
      regressions.push(`${url}: ${k} dropped ${prev[k]} -> ${after[k]}`);
    } else if (after[k] > prev[k]) {
      gains.push(`${url}: ${k} ${prev[k]} -> ${after[k]}`);
    }
  }
  if (after.bodyWords < prev.bodyWords * 0.9) {
    regressions.push(`${url}: body copy shrank ${prev.bodyWords} -> ${after.bodyWords} words`);
  }
}

if (gains.length) {
  console.log('Improved:');
  for (const g of gains) console.log(`  + ${g}`);
}

if (regressions.length) {
  console.error(`\nFAIL — ${regressions.length} keyword regression(s):`);
  for (const r of regressions) console.error(`  ! ${r}`);
  process.exit(1);
}

console.log('\nOK — no keyword placement was lost.');
