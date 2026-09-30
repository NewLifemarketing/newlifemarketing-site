#!/usr/bin/env node
// Add a case study to the Case Studies mega-menu, then propagate the nav.
//
//   node scripts/add-case-study-to-nav.mjs <slug> [--write]
//
// WHY A SCRIPT FOR A ONE-LINE EDIT. The mega-menu lists every case study, and the
// owner keeps it that way and updates it himself (his decision, 2026-09-06). The
// weekly pipeline is forbidden from touching partials/header.html, because doing
// so means a ~180-file chrome commit in every PR and no validator can safely gate
// that. So this is the manual step -- and a manual step that takes one command is
// one people actually do.
//
// It reads the title and the headline stat OUT OF THE PUBLISHED PAGE rather than
// asking for them. Retyping a stat into the nav by hand is how the nav ends up
// disagreeing with the page it points at, and there are already live examples of
// that on this site.
//
// Default is a DRY RUN. Nothing is written and nothing is propagated without
// --write, because the propagation step touches every page in the repo.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const HEADER = path.join(ROOT, 'partials', 'header.html');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const slug = args.find((a) => !a.startsWith('--'));

if (!slug) {
  console.error('Usage: node scripts/add-case-study-to-nav.mjs <slug> [--write]');
  console.error('');
  console.error('  <slug>   the folder name under case-studies/, e.g. aarons-furniture');
  console.error('  --write  actually edit partials/header.html and propagate to every page');
  process.exit(1);
}

const pagePath = path.join(ROOT, 'case-studies', slug, 'index.html');
if (!fs.existsSync(pagePath)) {
  console.error(`No such case study: case-studies/${slug}/index.html`);
  console.error('Publish the page first; the nav entry is built from what the page says.');
  process.exit(1);
}

const page = fs.readFileSync(pagePath, 'utf8');
const header = fs.readFileSync(HEADER, 'utf8');

if (header.includes(`href="/case-studies/${slug}/"`)) {
  console.log(`${slug} is already in the mega-menu. Nothing to do.`);
  process.exit(0);
}

// --- pull the title and headline stat from the page itself -------------------
//
// m-title is the client name, taken from the Article block's `about` rather than
// the h1: the h1 is a full sentence ("How Elite Cards Toronto Turned $17K...")
// and would blow out the dropdown.
let clientName = null;
const ld = page.match(/<script type="application\/ld\+json">(\{"@context[^<]*"@type":"Article"[^<]*)<\/script>/);
if (ld) {
  try { clientName = JSON.parse(ld[1])?.about?.name ?? null; } catch { /* fall through */ }
}
if (!clientName) {
  console.error(`Could not read the client name from case-studies/${slug}/index.html.`);
  console.error('It needs the Article JSON-LD block with an "about" organisation —');
  console.error('the same block that carries datePublished and temporalCoverage.');
  process.exit(1);
}

// The headline stat is the FIRST hero KPI tile: its value and its label. That is
// the same number the index card leads with, so nav and index cannot disagree.
const kpi = page.match(/<div class="camp-kpi"><div class="stat">([^<]+)<\/div><div class="stat-label">([^<]+)<\/div>/);
if (!kpi) {
  console.error(`Could not read a hero KPI tile from case-studies/${slug}/index.html.`);
  console.error('Expected the standard .camp-kpis > .camp-kpi > .stat / .stat-label markup.');
  process.exit(1);
}
const [, statValue, statLabel] = kpi;

const entry = `<a href="/case-studies/${slug}/"><span class="m-title">${clientName}</span>`
  + `<span class="m-teaser"><strong>${statValue}</strong> ${statLabel}</span></a>`;

// --- insert directly after "All Case Studies", i.e. newest first -------------
const ALL = '<a href="/case-studies/"><span class="m-title">All Case Studies</span>'
  + '<span class="m-teaser">Stat-first results stories</span></a>';
if (!header.includes(ALL)) {
  console.error('Could not find the "All Case Studies" anchor in partials/header.html.');
  console.error('The mega-menu markup changed; update this script rather than editing by hand.');
  process.exit(1);
}
const next = header.replace(ALL, ALL + entry);

console.log(`entry for ${slug}:`);
console.log(`  ${clientName} — ${statValue} ${statLabel}`);
console.log('');

if (!WRITE) {
  console.log('DRY RUN. Nothing written.');
  console.log('Re-run with --write to edit partials/header.html and propagate to every page.');
  process.exit(0);
}

// --- PRE-FLIGHT: refuse to propagate over drift we did not cause -------------
//
// sync-chrome --write overwrites each page's header region with whatever is in
// partials/header.html. That is only safe when the partial is AHEAD of the pages.
// If the partial is BEHIND them, propagating silently reverts live work across the
// whole site.
//
// This is not hypothetical. On 2026-09-06 the About menu was restructured directly
// in the pages -- /about/leadership/ appears twice on every page -- while
// partials/header.html still carried the older /about/office/ entry and no
// leadership link at all. Running --write at that moment would have rolled the
// entire site's navigation back, and the case-study PR that triggered it would
// have looked like the cause.
//
// So: check first. Any drift that is not explained by the entry we are adding
// means the partial and the pages disagree about something else, and a human has
// to reconcile that before anything is propagated.
console.log('pre-flight: checking for drift we did not cause...');
try {
  execFileSync('node', [path.join(ROOT, 'scripts', 'sync-chrome.mjs'), '--check'],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  console.log('  clean — the pages already match the partials.');
} catch (e) {
  const out = String((e.stdout || '') + (e.stderr || ''));
  console.error('');
  console.error('REFUSING TO PROPAGATE. The pages and partials/header.html already disagree,');
  console.error('for a reason unrelated to this case study:');
  console.error('');
  console.error(out.trim().split('\n').slice(0, 10).join('\n'));
  console.error('');
  console.error('Propagating now would overwrite every page with the partial, reverting');
  console.error('whatever that difference represents. Reconcile partials/header.html with');
  console.error('the live pages first, then re-run this.');
  console.error('');
  console.error('Nothing has been written.');
  process.exit(1);
}

fs.writeFileSync(HEADER, next);
console.log('partials/header.html updated.');

console.log('propagating the nav to every page (this touches ~180 files)...');
try {
  const out = execFileSync('node', [path.join(ROOT, 'scripts', 'sync-chrome.mjs'), '--write'],
    { cwd: ROOT, encoding: 'utf8' });
  process.stdout.write(out.split('\n').slice(-12).join('\n') + '\n');
} catch (e) {
  console.error('sync-chrome failed — partials/header.html HAS been edited but the pages have not.');
  console.error(String((e.stdout || '') + (e.stderr || '')).trim().slice(0, 600));
  console.error('Fix the cause and run: node scripts/sync-chrome.mjs --write');
  process.exit(1);
}

console.log('');
console.log('Verify with: node scripts/check-nav-freshness.mjs');
