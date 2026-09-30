#!/usr/bin/env node
// Does the Case Studies mega-menu still list every case study?
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
function slugsFromIndex(html) {
  const start = html.indexOf('<div class="chips" data-filter-group');
  if (start < 0) {
    console.error('case-studies/index.html: could not find the card grid. The page');
    console.error('structure changed; this check needs updating rather than ignoring.');
    process.exit(1);
  }
  const grid = html.slice(start);
  return [...new Set([...grid.matchAll(/href="\/case-studies\/([^/"]+)\//g)].map((m) => m[1]))];
}

function slugsFromHeader(html) {
  return [...new Set([...html.matchAll(/href="\/case-studies\/([^/"]+)\//g)].map((m) => m[1]))];
}

const published = slugsFromIndex(read(INDEX, 'case-studies/index.html'));
const inNav = slugsFromHeader(read(HEADER, 'partials/header.html'));

const missing = published.filter((s) => !inNav.includes(s));
const stale = inNav.filter((s) => !published.includes(s));

console.log(`published: ${published.length}   in the mega-menu: ${inNav.length}`);
if (LIST_ONLY || (!missing.length && !stale.length)) {
  for (const s of published) {
    console.log(`  ${inNav.includes(s) ? 'in nav ' : 'MISSING'}  ${s}`);
  }
}

if (!missing.length && !stale.length) {
  console.log('\nOK — the mega-menu lists every case study and nothing extra.');
  process.exit(0);
}

console.log('');
if (missing.length) {
  console.log(`${missing.length} case stud${missing.length === 1 ? 'y is' : 'ies are'} live but NOT in the mega-menu:`);
  for (const s of missing) console.log(`  ✗ ${s}`);
  console.log('');
  console.log('Add each one, then propagate the nav to every page:');
  for (const s of missing) console.log(`  node scripts/add-case-study-to-nav.mjs ${s}`);
}
if (stale.length) {
  console.log(`${stale.length} entr${stale.length === 1 ? 'y' : 'ies'} in the mega-menu no longer exist${stale.length === 1 ? 's' : ''} on the index:`);
  for (const s of stale) console.log(`  ✗ ${s}`);
  console.log('  Remove by hand from partials/header.html, then: node scripts/sync-chrome.mjs --write');
}

if (LIST_ONLY) process.exit(0);
process.exit(1);
