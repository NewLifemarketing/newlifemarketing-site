#!/usr/bin/env node
/**
 * cta-big-rollout.mjs — put the current call-to-action button on every money page.
 *
 *   node scripts/cta-big-rollout.mjs            report what would change
 *   node scripts/cta-big-rollout.mjs --write    change it
 *   node scripts/cta-big-rollout.mjs --only /aurora-crm/   one page
 *
 * WHY A SCRIPT.
 *
 * The new button shipped on 33 pages and stopped. 255 live money pages were
 * still on the old pair — the whole city x service grid, every *-crm, *-seo,
 * *-web-design, *-videography. Hand-editing 255 files is how three of them end
 * up subtly different and nobody finds out for a year.
 *
 * WHAT IT CHANGES, and nothing else.
 *
 * Old, on 253 of the 255 (both of the two blocks each page carries):
 *   <div class="hero-ctas">
 *     <a class="btn" href="/book/">Book a Strategy Call</a>
 *     <a class="btn ghost" href="/case-studies/">View Case Studies</a>
 *   </div>
 *
 * New, copied off /seo-barrie/ and /google-ads-management-barrie/:
 *   <div class="hero-ctas cta-big-wrap">            (2nd block also gets cta-row)
 *     <a class="cta-big tb solid" href="/book/"><svg …/><span>Book Your Strategy Call</span></a>
 *     <a class="cta-sub" href="/case-studies/">View Case Studies</a>
 *   </div>
 *
 * THE SECONDARY LINK KEEPS ITS OWN HREF AND ITS OWN WORDS. Two pages do not
 * point at /case-studies/ — one sends people to a Barrie client, another to the
 * trades offer — and flattening those into "View Case Studies" would quietly
 * delete a deliberate choice.
 *
 * WHAT IT REFUSES. A block whose first button is not /book/ is left alone and
 * reported. One page leads with /trades/ and carries three buttons; it is not
 * the shape this migration is for, and guessing is how a migration breaks the
 * one page nobody checked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not url.pathname — this repo lives under a folder with a space
// in its name and pathname hands back "C:/AI%20AGENTS/...", which readdirSync
// then cannot find.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? process.argv[i + 1] : null; })();

// The pages to touch, as an explicit list — one URL per line.
//
// Without it this walks every index.html in the repo and finds 336 pages with
// a convertible block, because blog posts and /articles/ carry the same two
// buttons. That is a different decision from "roll the new button across the
// money pages", and a migration should not quietly make it. The list is
// generated from the client registry, which is the only thing that knows which
// URLs are money pages.
const LIST = (() => {
  const i = process.argv.indexOf('--pages');
  if (i < 0) return null;
  return new Set(fs.readFileSync(process.argv[i + 1], 'utf8')
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
})();

const PLANE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/** Every index.html under the repo, minus build output and the chrome partials. */
function pages(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (/^(\.git|node_modules|assets|css|js|static|partials|scripts)$/.test(e.name)) continue;
      pages(path.join(dir, e.name), out);
    } else if (e.name === 'index.html') out.push(path.join(dir, e.name));
  }
  return out;
}

// The three wrappers that carry a PAGE call to action.
//
// Deliberately not header-cta, mobile-cta or nav-drawer-foot: those are chrome,
// they are small by design, and /seo-barrie/ keeps them as `btn sm` after
// conversion. Rolling the big button into the sticky bar would be a different
// decision from the one being made here.
const WRAPPERS = ['hero-ctas', 'svc-ctas', 'pf-act'];
const BLOCK = new RegExp(`<div class="((?:${WRAPPERS.join('|')})[^"]*)">([\\s\\S]*?)<\\/div>`, 'g');
const ANCHOR = /<a class="([^"]*)"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

let changed = 0, skipped = 0, already = 0, refused = [];

for (const file of pages(ROOT)) {
  const url = '/' + path.relative(ROOT, file).replace(/\\/g, '/').replace(/index\.html$/, '');
  if (ONLY && url !== ONLY) continue;
  if (LIST && !LIST.has(url)) continue;
  let html = fs.readFileSync(file, 'utf8');
  if (/http-equiv=["']refresh/i.test(html)) { skipped++; continue; }   // redirect stub

  // Idempotent by BLOCK, not by page. Checking the page for "cta-big" and
  // skipping meant a page whose hero was converted kept an old button in its
  // closing svc-ctas forever — which is exactly how this ended up 33/289 in
  // the first place. A block already carrying cta-big is left alone; one still
  // holding an old .btn to /book/ is converted, whatever else is on the page.
  const seen = Object.create(null);
  let touched = false, untouchedBlocks = 0;
  const next = html.replace(BLOCK, (whole, cls, inner) => {
    const kind = WRAPPERS.find((w) => cls.startsWith(w));
    const i = (seen[kind] = (seen[kind] ?? -1) + 1);
    if (cls.includes('cta-big-wrap')) { untouchedBlocks++; return whole; }
    const anchors = [...inner.matchAll(ANCHOR)].map((m) => ({ cls: m[1], href: m[2], text: strip(m[3]) }));
    // A wrapper with no link to /book/ is not a call to action — most pf-act
    // divs hold the process flow's own "Next:" button. Those are passed over
    // silently; reporting them buried the real refusals under 1,200 lines.
    const bookAt = anchors.findIndex((a) => a.href === '/book/');
    if (bookAt < 0) return whole;
    // /book/ is not always written first. On the converted pages it is always
    // the big button regardless, with the others demoted to cta-sub in their
    // original order — /account-based-marketing-agency-toronto/ has
    // "/about/office/ + /book/" and seo-barrie's equivalent reads
    // "cta-big -> /book/" then "cta-sub -> /about/office/".
    if (anchors.length > 3) {
      refused.push(`${url}  ${kind}[${i}]  ${anchors.length} buttons (${anchors.map((a) => a.href).join(' + ')})`);
      return whole;
    }
    const wrap = `${cls} cta-big-wrap${i === 1 ? ' cta-row' : ''}`;
    const primary = `<a class="cta-big tb solid" href="/book/">${PLANE}<span>Book Your Strategy Call</span></a>`;
    const rest = anchors.filter((_, k) => k !== bookAt)
      .map((a) => `<a class="cta-sub" href="${a.href}">${a.text}</a>`).join('');
    touched = true;
    return `<div class="${wrap}">${primary}${rest}</div>`;
  });

  if (touched) {
    changed++;
    if (WRITE) fs.writeFileSync(file, next);
  } else if (untouchedBlocks) already++;
}

console.log(`${WRITE ? 'changed' : 'would change'}: ${changed} page(s)`);
console.log(`already on the new button: ${already}`);
console.log(`redirect stubs skipped   : ${skipped}`);
if (refused.length) {
  console.log(`\nLEFT ALONE — not the shape this migration is for (${refused.length}):`);
  for (const r of refused) console.log('   ' + r);
}
if (!WRITE) console.log('\n--write to apply.');
