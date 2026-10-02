#!/usr/bin/env node
/**
 * sitemap-sort.mjs — keep sitemap.xml in alphabetical order by <loc>.
 *
 *   node scripts/sitemap-sort.mjs            report order, change nothing
 *   node scripts/sitemap-sort.mjs --check    exit 1 if out of order (CI gate)
 *   node scripts/sitemap-sort.mjs --write    sort in place
 *   node scripts/sitemap-sort.mjs --add URL  insert one URL in the right place
 *
 * Owner instruction, 2026-09-30: when a new page is added it must be added to
 * the sitemap IN ALPHABETICAL ORDER.
 *
 * Why a script and not just an instruction in the agent files. Every
 * site-publisher currently says "append one <url>", which is how all four
 * sitemaps drifted out of order in the first place -- 134 of NewLife's 234
 * entries, 44 of DMT's 32. Appending also puts every blog PR's edit on the same
 * final line, which is a guaranteed conflict the moment two PRs are open, and
 * that is a large part of why ten PRs sat stranded for three weeks. Sorting
 * spreads inserts across the file and makes most of those conflicts disappear.
 *
 * An instruction alone would not hold. The duplicated-lead bug on 2026-09-29
 * was already written down as a rule and still shipped, in about a minute,
 * because nothing checked. So --check runs in the PR validator.
 *
 * Each <url> block is moved verbatim, never rebuilt: several entries carry
 * lastmod/changefreq/priority and rewriting them would silently drop those.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'sitemap.xml');
const HTML_FILE = path.join(ROOT, 'sitemap', 'index.html');

/**
 * Insert one <li><a href=URL>TITLE</a></li> into /sitemap/index.html,
 * alphabetically by title, inside the right parent list.
 *
 * Returns the new HTML, the original unchanged if the URL is already listed,
 * or null if no list could be found (caller reports rather than guessing).
 */
function insertIntoHtmlSitemap(html, url, title) {
  const slugPath = url.replace(/^https?:\/\/[^/]+/, '');
  if (html.includes(`href="${slugPath}"`)) return html;      // already there

  // Titles usually arrive already HTML-escaped, because --title is lifted from
  // the page's own <title> tag. Escaping "&" unconditionally turned an existing
  // "&amp;" into "&amp;amp;", which a browser renders as the literal text
  // "&amp;" -- six links on /sitemap/ read "Awards &amp; Recognition" that way.
  // The lookahead leaves a well-formed entity alone and escapes a bare "&".
  const esc = (t) => t
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);)/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const li = `<li><a href="${slugPath}">${esc(title)}</a></li>`;

  // A child page (/blog/x/, /articles/x/) belongs in the nested <ul> that
  // follows its parent's own link. Anything else is a top-level entry.
  const seg = slugPath.replace(/^\/|\/$/g, '').split('/');
  const parentPath = seg.length > 1 ? `/${seg[0]}/` : null;

  // Everything below must be scoped to the sitemap list itself. The page's own
  // nav mega-menu also contains href="/blog/" followed by a <ul>, and matching
  // that put the first test insert at the very top of the list instead of in
  // alphabetical position. Find the list first, then search inside it.
  const listAnchor = html.indexOf('<ul class="sitemap-list"');
  if (listAnchor === -1) return null;

  let listStart = -1, listEnd = -1;
  if (parentPath) {
    const anchor = html.indexOf(`href="${parentPath}"`, listAnchor);
    if (anchor !== -1) {
      const ulAt = html.indexOf('<ul>', anchor);
      if (ulAt !== -1) {
        // match to the matching </ul>, allowing for deeper nesting
        let depth = 0, i = ulAt;
        while (i < html.length) {
          if (html.startsWith('<ul', i)) { depth++; i = html.indexOf('>', i) + 1; continue; }
          if (html.startsWith('</ul>', i)) { depth--; if (!depth) { listEnd = i; break; } i += 5; continue; }
          i++;
        }
        listStart = html.indexOf('>', ulAt) + 1;
      }
    }
  }
  if (listStart === -1) {
    const ulAt = html.indexOf('<ul class="sitemap-list"');
    if (ulAt === -1) return null;
    listStart = html.indexOf('>', ulAt) + 1;
    // the top-level list ends at its own matching </ul>
    let depth = 0, i = ulAt;
    while (i < html.length) {
      if (html.startsWith('<ul', i)) { depth++; i = html.indexOf('>', i) + 1; continue; }
      if (html.startsWith('</ul>', i)) { depth--; if (!depth) { listEnd = i; break; } i += 5; continue; }
      i++;
    }
  }
  if (listStart === -1 || listEnd === -1) return null;

  const inner = html.slice(listStart, listEnd);
  // Only this list's OWN <li> items: split on top-level <li>, ignoring nested.
  const items = [];
  let d = 0, start = -1;
  for (let i = 0; i < inner.length; i++) {
    if (inner.startsWith('<li', i)) { if (d === 0) start = i; d++; }
    else if (inner.startsWith('</li>', i)) { d--; if (d === 0) { items.push(inner.slice(start, i + 5)); } }
  }
  const textOf = (s) => {
    const m = s.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    return (m ? m[1] : s).replace(/<[^>]+>/g, '').trim().toLowerCase();
  };
  const key = title.trim().toLowerCase();
  let at = items.findIndex((it) => textOf(it) > key);
  if (at === -1) at = items.length;
  const rebuilt = items.slice(0, at).join('') + li + items.slice(at).join('');
  return html.slice(0, listStart) + rebuilt + html.slice(listEnd);
}

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };

const mode = has('--write') ? 'write' : has('--check') ? 'check' : has('--add') ? 'add' : 'report';
const addUrl = valOf('--add');
const addTitle = valOf('--title');

if (!fs.existsSync(FILE)) {
  console.error(`No sitemap.xml at ${FILE}`);
  process.exit(2);
}

const src = fs.readFileSync(FILE, 'utf8');
const nl = src.includes('\r\n') ? '\r\n' : '\n';

// Capture whole <url>…</url> blocks with their own indentation, plus whatever
// sits before the first and after the last, so the XML declaration, the
// <urlset> attributes and any comments survive untouched.
const BLOCK = /[ \t]*<url>[\s\S]*?<\/url>[ \t]*\r?\n?/g;
const blocks = src.match(BLOCK) || [];
if (!blocks.length) {
  console.error('No <url> blocks found — is this a sitemap?');
  process.exit(2);
}

const firstAt = src.indexOf(blocks[0]);
const lastBlock = blocks[blocks.length - 1];
const endAt = src.lastIndexOf(lastBlock) + lastBlock.length;
const head = src.slice(0, firstAt);
const tail = src.slice(endAt);

const locOf = (b) => {
  const m = b.match(/<loc>([\s\S]*?)<\/loc>/i);
  return m ? m[1].trim() : '';
};

let working = blocks.slice();

// --add: refuse a duplicate rather than creating a second entry for one page.
if (mode === 'add') {
  if (!addUrl) { console.error('--add needs a URL'); process.exit(2); }
  const url = addUrl.trim();
  // Present in the XML is NOT "nothing to do" -- the page may still be missing
  // from /sitemap/. This exited early and left local-seo-for-dentists-in-newmarket
  // in sitemap.xml but absent from the human sitemap, which is exactly the drift
  // between the two files that --add exists to prevent. Fall through instead.
  if (working.some((b) => locOf(b) === url)) {
    console.log(`Already in sitemap.xml: ${url}`);
  } else {
    const indent = (blocks[0].match(/^[ \t]*/) || [''])[0];
    working.push(`${indent}<url><loc>${url}</loc></url>${nl}`);
  }
}

const locs = working.map(locOf);
// Plain byte order, so it matches `sort` and is stable across machines and
// locales. Locale-aware collation would order differently on a different box,
// and then --check fails for nobody's benefit.
const sorted = working.slice().sort((a, b) => (locOf(a) < locOf(b) ? -1 : locOf(a) > locOf(b) ? 1 : 0));
const sortedLocs = sorted.map(locOf);

const outOfOrder = locs.filter((l, i) => l !== sortedLocs[i]);

const dupes = locs.filter((l, i) => locs.indexOf(l) !== i);
if (dupes.length) {
  console.error(`\n${dupes.length} DUPLICATE <loc> entr(ies):`);
  for (const d of [...new Set(dupes)]) console.error(`  ! ${d}`);
}

if (mode === 'report' || mode === 'check') {
  console.log(`${locs.length} url(s) in sitemap.xml`);
  if (outOfOrder.length) {
    console.log(`${outOfOrder.length} out of alphabetical order. First few:`);
    for (let i = 0, shown = 0; i < locs.length && shown < 5; i++) {
      if (locs[i] !== sortedLocs[i]) { console.log(`  line ${i + 1}: ${locs[i]}`); shown++; }
    }
  } else {
    console.log('Alphabetical order: OK');
  }
}

if (mode === 'check') {
  if (outOfOrder.length || dupes.length) {
    console.error('\nFAIL — run: node scripts/sitemap-sort.mjs --write');
    process.exit(1);
  }
  process.exit(0);
}

if (mode === 'write' || mode === 'add') {
  const out = head + sorted.join('') + tail;
  fs.writeFileSync(FILE, out);
  if (mode === 'add') console.log(`Added and sorted: ${addUrl}`);
  else console.log(`Sorted ${sorted.length} url(s).`);

  // ---- the HUMAN sitemap page, /sitemap/ ---------------------------------
  // Added 2026-09-30 with the page itself. sitemap.xml is for crawlers; this
  // is the page people and internal links actually use, and a new post that
  // reaches one but not the other is exactly the kind of drift that goes
  // unnoticed for weeks. `--add` keeps them in step.
  //
  // Structure, as authored: a flat <ul class="sitemap-list"> sorted
  // alphabetically by LINK TEXT (the page title, not the URL), with child
  // pages in a nested <ul> under their parent -- blog posts under /blog/,
  // articles under /articles/.
  if (mode === 'add' && fs.existsSync(HTML_FILE) && addTitle) {
    const before = fs.readFileSync(HTML_FILE, 'utf8');
    const after = insertIntoHtmlSitemap(before, addUrl.trim(), addTitle);
    if (after === null) {
      console.error(`Could not place ${addUrl} in ${path.basename(HTML_FILE)} — `
        + 'no parent list found. Add it by hand, alphabetically by title.');
      process.exit(1);
    }
    if (after === before) {
      console.log('Already listed on /sitemap/, nothing to do.');
    } else {
      fs.writeFileSync(HTML_FILE, after);
      console.log(`Added to /sitemap/ under its parent, alphabetically by title.`);
    }
  } else if (mode === 'add' && fs.existsSync(HTML_FILE) && !addTitle) {
    console.error('\n/sitemap/ exists but no --title was given, so the page was NOT '
      + 'updated. Re-run with: --add <url> --title "<page title>"');
    process.exit(1);
  }
  process.exit(0);
}
