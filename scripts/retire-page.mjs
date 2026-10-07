#!/usr/bin/env node
/**
 * retire-page.mjs — 301 one page onto another and take it out of circulation.
 *
 *   node scripts/retire-page.mjs --from /blog/old/ --to /blog/new/
 *   node scripts/retire-page.mjs --file retirements.json
 *   node scripts/retire-page.mjs --from ... --to ... --dry-run
 *
 * Use this when two pages chase the same search. Deleting the loser throws away
 * whatever links and history it earned and leaves a 404; a 301 hands all of it
 * to the page you want to win. Owner decision, 2026-10-01: pages beat blogs, and
 * the loser is retargeted or redirected -- not deleted.
 *
 * Four things have to happen together, which is why this is a script and not a
 * checklist. Doing three of them leaves a page that still competes.
 *
 *   1. the page becomes a redirect stub   meta refresh + canonical + noindex
 *   2. _redirects gains a 301             with and without the trailing slash
 *   3. sitemap.xml drops the URL          a redirect does not belong in a sitemap
 *   4. /sitemap/ and blog/index.html      drop the link, so nothing points at it
 *
 * The stub matches the ones already in about/, which is the shape this site
 * already uses: GitHub Pages ignores _redirects, so the meta refresh is what
 * actually moves a visitor, and _redirects is there for any CDN in front.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://newlifemarketing.ca';

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
const DRY = argv.includes('--dry-run');

let jobs = [];
const file = val('--file');
if (file) {
  jobs = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
} else if (val('--from') && val('--to')) {
  jobs = [{ from: val('--from'), to: val('--to') }];
} else {
  console.error('usage: retire-page.mjs --from /a/ --to /b/ [--dry-run]');
  console.error('       retire-page.mjs --file retirements.json [--dry-run]');
  process.exit(2);
}

const norm = (u) => `/${String(u).replace(/^\/|\/$/g, '')}/`;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const write = (rel, s) => { if (!DRY) fs.writeFileSync(path.join(ROOT, rel), s); };
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const stub = (to) => '<!DOCTYPE html><html lang="en-CA"><head><meta charset="utf-8">'
  + '<title>Page moved</title><meta name="robots" content="noindex">'
  + `<link rel="canonical" href="${ORIGIN}${to}">`
  + `<meta http-equiv="refresh" content="0; url=${to}">`
  + `<script>location.replace("${to}")</script></head>`
  + `<body>This page has moved to <a href="${to}">${to}</a>.</body></html>`;

let changed = 0;
const notes = [];

for (const raw of jobs) {
  const from = norm(raw.from), to = norm(raw.to);
  const page = `${from.replace(/^\/|\/$/g, '')}/index.html`;
  if (from === to) { notes.push(`SKIP  ${from} -> itself`); continue; }
  if (!exists(page)) { notes.push(`SKIP  ${from} — no page on disk`); continue; }
  if (!exists(`${to.replace(/^\/|\/$/g, '')}/index.html`)) {
    notes.push(`REFUSE ${from} -> ${to} — the target does not exist, that would be a redirect to a 404`);
    continue;
  }
  const current = read(page);
  if (/http-equiv=["']refresh["']/i.test(current)) { notes.push(`SKIP  ${from} — already a redirect`); continue; }

  write(page, stub(to));
  notes.push(`301   ${from} -> ${to}`);
  changed += 1;
}

// _redirects — both spellings, and never a duplicate line.
if (changed || DRY) {
  const rel = '_redirects';
  let body = exists(rel) ? read(rel) : '';
  const lines = body.split('\n');
  const have = new Set(lines.map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  const add = [];
  for (const raw of jobs) {
    const from = norm(raw.from), to = norm(raw.to);
    if (!notes.some((n) => n.startsWith('301') && n.includes(`${from} -> ${to}`))) continue;
    for (const f of [from, from.replace(/\/$/, '')]) {
      if (!have.has(f)) { add.push(`${f} ${to} 301`); have.add(f); }
    }
  }
  if (add.length) {
    body = `${body.replace(/\n+$/, '')}\n${add.join('\n')}\n`;
    write(rel, body);
    notes.push(`_redirects  +${add.length} line(s)`);
  }
}

// sitemap.xml and /sitemap/ and blog/index.html — stop pointing at the retired URL.
const retired = notes.filter((n) => n.startsWith('301')).map((n) => n.split(/\s+/)[1]);
if (retired.length) {
  let xml = read('sitemap.xml');
  let dropped = 0;
  for (const u of retired) {
    // 39 of this sitemap's entries use https://www. and 340 do not, so match
    // either host rather than only the canonical one. Missing that silently
    // leaves a retired page listed, which is the one thing this must not do.
    const esc = u.replace(/[/\-]/g, (m) => `\\${m}`);
    const re = new RegExp(`\\s*<url>\\s*<loc>https://(?:www\\.)?newlifemarketing\\.ca${esc}</loc>[\\s\\S]*?</url>`, 'g');
    const before = xml; xml = xml.replace(re, '');
    if (xml !== before) dropped += 1;
  }
  if (dropped) { write('sitemap.xml', xml); notes.push(`sitemap.xml  -${dropped} <url>`); }

  for (const rel of ['sitemap/index.html', 'blog/index.html']) {
    if (!exists(rel)) continue;
    let h = read(rel); let n = 0;
    for (const u of retired) {
      // a whole <li>…</li> or a whole card <a …>…</a> that links the retired URL
      const li = new RegExp(`\\s*<li>(?:(?!</li>)[\\s\\S])*?href="${u}"[\\s\\S]*?</li>`, 'g');
      const card = new RegExp(`\\s*<a[^>]*href="${u}"[\\s\\S]*?</a>`, 'g');
      const before = h;
      h = h.replace(li, '').replace(card, '');
      if (h !== before) n += 1;
    }
    if (n) { write(rel, h); notes.push(`${rel}  -${n} link(s)`); }
  }
}

for (const n of notes) console.log(`  ${n}`);
console.log(`\n${changed} page(s) retired${DRY ? ' (dry run — nothing written)' : ''}.`);
if (!changed) process.exit(1);
