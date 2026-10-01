#!/usr/bin/env node
/**
 * build-indexes.mjs — keep the things that must list every page in sync with
 * the pages that actually exist on disk.
 *
 * Owns ONE thing by default: Open Graph + Twitter Card tags, which nothing
 * else on the site adds. Without them a shared link renders as bare text.
 *
 * Both sitemaps belong to scripts/sitemap-sort.mjs, which the publishing agent
 * calls and validate-blog-pr.mjs enforces. This script only touches them under
 * an explicit --sitemaps, for reconciliation on main -- see the note there.
 *
 * Why a generator rather than an agent instruction: an instruction is one-shot,
 * so a page it misses stays missed. This reads the filesystem, so a page that
 * slipped through last time gets picked up on the next run. It also covers
 * service/industry/location pages, which no publishing agent touches, and it
 * removes deleted pages, which the "never alter existing entries" rule cannot.
 *
 *   node scripts/build-indexes.mjs                       tag any page missing OG tags
 *   node scripts/build-indexes.mjs --check               report only, exit 1 if any lack tags
 *   node scripts/build-indexes.mjs --sitemaps            ALSO rebuild both sitemaps (main only)
 *   node scripts/build-indexes.mjs --og-only             tags only, leave sitemaps alone
 *   node scripts/build-indexes.mjs --page blog/x/index.html   restrict to one page
 *
 * --og-only --page is what CI uses on a blog PR. The sitemaps are deliberately
 * NOT regenerated there: a blog/{slug} branch is cut from an older main, so
 * rebuilding the full page list on it would drop every page added to main since
 * the branch was created. Sitemaps are regenerated on main, never on a branch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://newlifemarketing.ca';
const CHECK = process.argv.includes('--check');
const OG_ONLY = process.argv.includes('--og-only');
const ONLY_PAGE = (() => {
  const i = process.argv.indexOf('--page');
  return i > -1 ? process.argv[i + 1].replace(/^\.?\//, '').split('\\').join('/') : null;
})();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'partials', '.github', '.claude', 'scripts', 'css', 'js', 'assets']);
// authenticated app screens: behind a login, never shared, no canonical
const SKIP_URLS = new Set(['/404.html', '/portal/admin/', '/portal/dashboard/', '/portal/reset/']);

// ------------------------------------------------------------- discovery ----
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const pages = [];
for (const abs of walk(ROOT)) {
  const src = fs.readFileSync(abs, 'utf8');
  if (/http-equiv=["']refresh["']/i.test(src)) continue;          // redirect stub
  if (/<meta\s+name="robots"[^>]*noindex/i.test(src)) continue;   // deliberately hidden
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const url = '/' + rel.replace(/index\.html$/, '');
  if (SKIP_URLS.has(url)) continue;
  const t = src.match(/<title>([\s\S]*?)<\/title>/i);
  const title = t ? t[1].replace(/\s+/g, ' ').trim() : url;
  pages.push({ abs, rel, url, src, title, short: title.split(/\s*\|\s*NewLife/)[0].trim() });
}
pages.sort((a, b) => sortKey(a.short).localeCompare(sortKey(b.short)));

function sortKey(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
          .replace(/&[a-z]+;/gi, ' ')
          .replace(/[^0-9a-zA-Z ]+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// --------------------------------------------------------- image helpers ----
const dimCache = new Map();
function dims(rel) {
  if (dimCache.has(rel)) return dimCache.get(rel);
  let r = null;
  try {
    const fd = fs.openSync(path.join(ROOT, rel.replace(/^\//, '')), 'r');
    const b = Buffer.alloc(65536);
    const n = fs.readSync(fd, b, 0, 65536, 0);
    fs.closeSync(fd);
    if (b[0] === 0xFF && b[1] === 0xD8) {                 // JPEG
      let i = 2;
      while (i < n - 9) {
        if (b[i] !== 0xFF) { i++; continue; }
        const m = b[i + 1];
        if (m === 0xC0 || m === 0xC1 || m === 0xC2) { r = [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; break; }
        i += 2 + b.readUInt16BE(i + 2);
      }
    } else if (b.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {  // PNG
      r = [b.readUInt32BE(16), b.readUInt32BE(20)];
    }
  } catch { r = null; }
  dimCache.set(rel, r);
  return r;
}
const bigEnough = (i) => { const d = dims(i); return !!(d && d[0] >= 600 && d[1] >= 315); };

const PEOPLE = ['/assets/team/', '/assets/bts/'];
const SECTION_CARD = {
  articles: 'articles', industries: 'industries', clients: 'clients',
  services: 'services', 'case-studies': 'case-studies', portfolio: 'portfolio',
  projects: 'projects', book: 'book', contact: 'contact', portal: 'portal',
};
function section(url) {
  if (url === '/') return 'home';
  const seg = url.replace(/^\/|\/$/g, '').split('/')[0];
  return seg.startsWith('digital-marketing-agency-') ? 'locations' : seg;
}

/**
 * Pick the most relevant preview image.
 * Order matters: blog posts carry an author byline photo ahead of the hero in
 * the DOM, so a naive "first image" rule picks the headshot. Slug-matched
 * images win, and people shots are a last resort off /about and /careers.
 */
function pickImage(p) {
  const head = p.src.slice(0, p.src.indexOf('</head>') + 1);
  const body = p.src.slice(p.src.indexOf('</head>'));
  let m = p.src.match(/poster="(\/assets\/[^"]+)"/);
  if (m && bigEnough(m[1])) return m[1];
  m = p.src.match(/<img[^>]*class="hero-photo"[^>]*src="(\/assets\/[^"]+)"/);
  if (m && bigEnough(m[1])) return m[1];

  const imgs = [...body.matchAll(/<img[^>]+src="(\/assets\/[^"]+)"/g)].map(x => x[1])
    .filter(i => !i.includes('/logos/') && !i.includes('favicon') && !i.includes('video-placeholder'));
  const slug = p.url.replace(/^\/|\/$/g, '').split('/').pop();
  for (const i of imgs) if (slug && i.includes(slug) && bigEnough(i)) return i;
  const peopleOk = ['about', 'careers'].includes(section(p.url));
  for (const i of imgs) {
    if (!peopleOk && PEOPLE.some(k => i.includes(k))) continue;
    if (bigEnough(i)) return i;
  }
  for (const i of imgs) if (bigEnough(i)) return i;
  return `/assets/brand/og/${SECTION_CARD[section(p.url)] || 'default'}.jpg`;
}

const esc = (s) => String(s ?? '')
  .replace(/&(?![a-zA-Z#0-9]+;)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ------------------------------------------------------------ 1. OG tags ----
let ogAdded = 0; const ogMissing = [];
if (ONLY_PAGE && !pages.some(p => p.rel === ONLY_PAGE)) {
  console.error(`  ! --page ${ONLY_PAGE} is not an indexable page (missing, a redirect stub, or noindex)`);
}
for (const p of pages) {
  if (ONLY_PAGE && p.rel !== ONLY_PAGE) continue;
  if (p.src.includes('og:image')) continue;
  const canonM = p.src.match(/<link rel="canonical" href="([^"]+)"\s*\/?>/);
  const descM = p.src.match(/<meta name="description" content="([^"]*)"/);
  const anchor = canonM ? canonM[0] : (descM ? descM[0] : null);
  if (!anchor) { ogMissing.push(p.url + '  (no canonical or description)'); continue; }
  ogMissing.push(p.url);
  if (CHECK) continue;

  const canon = canonM ? canonM[1] : SITE + p.url;
  const desc = descM && descM[1].trim() ? descM[1].replace(/\s+/g, ' ').trim()
             : 'NewLife Marketing — a full-service digital marketing agency.';
  const img = pickImage(p);
  const d = dims(img) || [1200, 630];
  const type = ['blog', 'articles'].includes(section(p.url)) ? 'article' : 'website';
  const nl = p.src.includes('\r\n') ? '\r\n' : '\n';
  const tags =
    `<meta property="og:type" content="${type}">` +
    `<meta property="og:site_name" content="NewLife Marketing">` +
    `<meta property="og:locale" content="en_CA">` +
    `<meta property="og:url" content="${esc(canon)}">` +
    `<meta property="og:title" content="${esc(p.title)}">` +
    `<meta property="og:description" content="${esc(desc)}">` +
    `<meta property="og:image" content="${SITE}${img}">` +
    `<meta property="og:image:width" content="${d[0]}">` +
    `<meta property="og:image:height" content="${d[1]}">` +
    `<meta property="og:image:alt" content="${esc(p.title)}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${esc(p.title)}">` +
    `<meta name="twitter:description" content="${esc(desc)}">` +
    `<meta name="twitter:image" content="${SITE}${img}">`;
  fs.writeFileSync(p.abs, p.src.replace(anchor, anchor + nl + tags), 'utf8');
  ogAdded++;
}

// --------------------------------------------------------- 2. sitemap.xml ---
// sorted by URL, not by title: stable across runs, and it keeps the diff small
// when the publishing agent appends a single entry of its own.
const xmlWanted = ['<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...pages.map(p => p.url).sort().map(u => `  <url><loc>${SITE}${u}</loc></url>`),
  '</urlset>', ''].join('\n');
/**
 * Sitemaps are OFF by default -- scripts/sitemap-sort.mjs already owns them.
 *
 * That tool is wired into the publishing agent AND into validate-blog-pr.mjs,
 * which fails a PR whose sitemap.xml entries were reordered. Two tools writing
 * the same file disagree: sitemap-sort uses the title passed on the command
 * line (the full post title), this script derives it from the <title> tag, so
 * each would rewrite the other's link text on every post.
 *
 * --sitemaps is kept for occasional reconciliation ON MAIN ONLY: it is the only
 * thing that removes deleted pages, and it covers service/industry/location
 * pages, which nothing calls sitemap-sort for. Never run it on a feature
 * branch -- a blog/<slug> branch is cut from an older main, so rebuilding the
 * page list there would drop everything added to main since.
 */
const SITEMAPS = process.argv.includes('--sitemaps') && !OG_ONLY && !ONLY_PAGE;
const xmlPath = path.join(ROOT, 'sitemap.xml');
const xmlCur = fs.existsSync(xmlPath) ? fs.readFileSync(xmlPath, 'utf8') : '';
const xmlStale = SITEMAPS && xmlCur.replace(/\r\n/g, '\n') !== xmlWanted;
if (xmlStale && !CHECK) fs.writeFileSync(xmlPath, xmlWanted, 'utf8');

// ---------------------------------------------------- 3. sitemap/index.html -
const byUrl = new Map(pages.map(p => [p.url, p]));
const kids = new Map(); const top = [];
for (const p of pages) {
  if (p.url === '/sitemap/') continue;
  const segs = p.url.replace(/^\/|\/$/g, '').split('/');
  const parent = segs.length > 1 ? '/' + segs.slice(0, -1).join('/') + '/' : null;
  if (parent && byUrl.has(parent)) {
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(p);
  } else if (p.url !== '/sitemap/') top.push(p);
}
const li = (p) => `<li><a href="${p.url}">${esc(p.short)}</a>` +
  (kids.has(p.url) ? `<ul>${kids.get(p.url).map(li).join('')}</ul>` : '') + '</li>';
const listHtml = `<ul class="sitemap-list">${top.map(li).join('')}</ul>`;

/**
 * Find the sitemap list and its MATCHING close.
 *
 * A greedy /<ul class="sitemap-list">[\s\S]*<\/ul>/ runs past the nested
 * child lists and swallows everything to the last </ul> in the document —
 * which is in the footer. That silently deleted the footer once. Count depth
 * instead.
 */
function findList(html) {
  const start = html.indexOf('<ul class="sitemap-list">');
  if (start === -1) return null;
  const re = /<ul\b[^>]*>|<\/ul>/g;
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html)) !== null) {
    depth += m[0] === '</ul>' ? -1 : 1;
    if (depth === 0) return { start, end: m.index + m[0].length };
  }
  return null;
}

const smPath = path.join(ROOT, 'sitemap', 'index.html');
let smStale = false;
if (SITEMAPS && fs.existsSync(smPath)) {
  const cur = fs.readFileSync(smPath, 'utf8');
  const loc = findList(cur);
  if (!loc) {
    console.error('  ! sitemap/index.html: could not locate the list — leaving it alone');
  } else if (cur.slice(loc.start, loc.end) !== listHtml) {
    smStale = true;
    if (!CHECK) {
      const next = cur.slice(0, loc.start) + listHtml + cur.slice(loc.end);
      // never write a version that lost the managed chrome
      if (!next.includes('<footer class="site-footer"') || !next.includes('BEGIN SITE FOOTER')) {
        console.error('  ! refusing to write sitemap/index.html: footer would be lost');
        process.exit(2);
      }
      fs.writeFileSync(smPath, next, 'utf8');
    }
  }
}

// ------------------------------------------------------------------ report --
const smState = (stale) => !SITEMAPS ? 'skipped (branch-safe mode)'
                         : stale ? (CHECK ? 'STALE' : 'rewritten') : 'up to date';
console.log(`indexable pages: ${pages.length}${ONLY_PAGE ? `   (scoped to ${ONLY_PAGE})` : ''}`);
console.log(`sitemap.xml        : ${smState(xmlStale)}`);
console.log(`sitemap/index.html : ${smState(smStale)}`);
console.log(`og tags            : ${CHECK ? `${ogMissing.length} page(s) missing` : `${ogAdded} page(s) tagged`}`);
for (const u of ogMissing.slice(0, 12)) console.log(`   - ${u}`);
if (ogMissing.length > 12) console.log(`   ... and ${ogMissing.length - 12} more`);

if (CHECK && (xmlStale || smStale || ogMissing.length)) {
  console.error('\nFAIL — run: node scripts/build-indexes.mjs');
  process.exit(1);
}
console.log(CHECK ? '\nOK — indexes are current.' : '\nDone.');
