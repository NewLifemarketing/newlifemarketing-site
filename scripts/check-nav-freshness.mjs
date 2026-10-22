#!/usr/bin/env node
// Does the Case Studies mega-menu show the NEWEST case studies, newest first?
//
// Rule (owner, 2026-10-22): the menu shows the MAX most recent case studies by
// publish date (data-published on the index cards). Older ones live on /case-studies/.
// Before 2026-10-22 the rule was "every case study"; the history below still applies.
//
// WHY THIS EXISTS. The nav is not stored once. Every page carries its own pasted
// copy and scripts/sync-chrome.mjs propagates partials/header.html into all of
// them. Adding a sixth case study to the dropdown therefore means a ~180-file
// commit, which no PR validator can meaningfully check -- it would either wave a
// site-wide change through unchecked or block every publish.
//
// So the weekly case-study pipeline is forbidden from touching partials/header.html
// at all, and the owner updates the dropdown himself (his call, 2026-09-06). That
// is a perfectly good decision, but it has one failure mode: forgetting. A nav
// that silently falls behind is exactly the class of problem this system keeps
// getting bitten by -- nothing errors, nothing is red, the page is just quietly
// wrong for weeks.
//
// This turns "if you forget" into a non-zero exit. Run it in CI or read it in the
// morning brief; either way the drift is visible the day it happens rather than
// the day someone notices.
//
//   node scripts/check-nav-freshness.mjs          # exits 1 on drift
//   node scripts/check-nav-freshness.mjs --list   # always exits 0
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX = path.join(ROOT, 'case-studies', 'index.html');
const HEADER = path.join(ROOT, 'partials', 'header.html');
const LIST_ONLY = process.argv.includes('--list');

function read(p, label) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    console.error(`Could not read ${label}: ${e.message}`);
    process.exit(1);
  }
}

// Slugs are read from the CARD GRID, not from the whole file. The header is
// embedded in this page too, so a whole-file scan would compare the header
// against itself and always pass -- a check that can never fail is worse than
// no check, because it reads as reassurance.
const MAX = 5;   // keep in step with scripts/add-case-study-to-nav.mjs

function cardsFromIndex(html) {
  const start = html.indexOf('<div class="chips" data-filter-group');
  if (start < 0) {
    console.error('case-studies/index.html: could not find the card grid. The page');
    console.error('structure changed; this check needs updating rather than ignoring.');
    process.exit(1);
  }
  const grid = html.slice(start), seen = new Set(), out = [];
  for (const m of grid.matchAll(/href="\/case-studies\/([^/"]+)\/"[^>]*data-published="([0-9-]+)"/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push({ slug: m[1], date: m[2] }); }
  }
  return out;
}

function slugsFromHeader(html) {
  return [...new Set([...html.matchAll(/href="\/case-studies\/([^/"]+)\//g)].map((m) => m[1]))];
}

const cards = cardsFromIndex(read(INDEX, 'case-studies/index.html'));
// Newest first; ties keep the index page's order (stable sort).
const expected = cards.map((c, i) => ({ ...c, i })).sort((x, y) => y.date.localeCompare(x.date) || x.i - y.i)
  .slice(0, MAX).map((c) => c.slug);
const inNav = slugsFromHeader(read(HEADER, 'partials/header.html'));
const ok = expected.length === inNav.length && expected.every((s, k) => inNav[k] === s);

console.log(`published: ${cards.length}   menu shows: ${inNav.length} (rule: newest ${MAX})`);
for (let k = 0; k < Math.max(expected.length, inNav.length); k++)
  console.log(`  ${expected[k] === inNav[k] ? 'ok     ' : 'WRONG  '} expected ${expected[k] || '-'}   menu ${inNav[k] || '-'}`);

if (ok) {
  console.log('\nOK — the mega-menu shows the newest case studies, newest first.');
  process.exit(0);
}
console.log('\nThe menu is out of date. For each newer case study, oldest first:');
for (const s of expected.filter((s) => !inNav.includes(s)).reverse())
  console.log(`  node scripts/add-case-study-to-nav.mjs ${s} --name "<short menu name>" --write`);

if (LIST_ONLY) process.exit(0);
process.exit(1);
