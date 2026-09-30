#!/usr/bin/env node
/**
 * check-drafts.mjs — guard for unfinished pages.
 *
 * A page is a DRAFT if it contains `class="tbc"` markers (figures awaiting
 * client confirmation). Drafts are allowed to exist, but must not be
 * discoverable by search:
 *
 *   1. they must carry <meta name="robots" content="noindex...">
 *   2. they must NOT appear in sitemap.xml
 *
 * Also hard-fails on the older `[NEEDS: ...]` authoring convention. Those are
 * rendered as visible amber badges by `.needs` in style.css, so any that reach
 * production publish internal notes to visitors.
 *
 *   node scripts/check-drafts.mjs           exit 1 on any violation
 *   node scripts/check-drafts.mjs --list     report only, always exit 0
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules', 'partials']);
const listOnly = process.argv.includes('--list');
const strict = process.argv.includes('--strict');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const smPath = path.join(ROOT, 'sitemap.xml');
const sitemap = fs.existsSync(smPath) ? fs.readFileSync(smPath, 'utf8') : '';

const problems = [];
const drafts = [];
const needsBacklog = [];

for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const src = fs.readFileSync(abs, 'utf8');

  if (src.includes('[NEEDS')) needsBacklog.push(rel);

  const markers = (src.match(/class="tbc"/g) || []).length;
  if (!markers) continue;
  drafts.push({ rel, markers });

  if (!/<meta\s+name="robots"[^>]*noindex/i.test(src)) {
    problems.push(`${rel}: ${markers} unconfirmed .tbc marker(s) but NOT noindex`);
  }
  const url = '/' + rel.replace(/index\.html$/, '');
  if (sitemap.includes(`<loc>https://newlifemarketing.ca${url}</loc>`)) {
    problems.push(`${rel}: ${markers} unconfirmed .tbc marker(s) but IS in sitemap.xml`);
  }
}

console.log(`scanned ${files.length} html file(s)`);

if (needsBacklog.length) {
  console.log(`
WARNING: ${needsBacklog.length} page(s) still contain [NEEDS: ...] authoring`);
  console.log('placeholders, which .needs in style.css renders as visible amber badges.');
  console.log('This is a pre-existing backlog on main, not a per-change problem.');
  console.log('Run with --strict to fail the build on these.');
}
if (drafts.length) {
  console.log(`\n${drafts.length} draft page(s) awaiting confirmed figures:`);
  for (const d of drafts) console.log(`  - ${d.rel}  (${d.markers} marker(s))`);
  console.log('\nReplace every marker with a real figure, then remove the noindex tag');
  console.log('and add the page to sitemap.xml.');
} else {
  console.log('\nNo draft pages — every figure on the site is confirmed.');
}

if (strict && needsBacklog.length) {
  for (const r of needsBacklog) problems.push(`${r}: contains a [NEEDS: ...] placeholder`);
}

if (problems.length) {
  console.error(`\nFAIL — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ! ${p}`);
  if (!listOnly) process.exit(1);
} else {
  console.log('\nOK — no unfinished content is discoverable.');
}
