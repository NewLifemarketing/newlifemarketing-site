#!/usr/bin/env node
/**
 * sort-blog-index.mjs — blog/index.html in date order, newest first.
 *
 *   node scripts/sort-blog-index.mjs            # check, exit 1 if out of order
 *   node scripts/sort-blog-index.mjs --write    # fix it
 *
 * Runs in auto-publish.yml on every post, so the order is maintained by code
 * rather than by whoever edits the index.
 *
 * WHY IT HAS TO BE CODE
 *
 * The writer adds each new card at the top, which is only correct when posts
 * publish in the order they are written. One held back by a failing check or a
 * missed day publishes later and still lands above newer posts. By the time
 * anyone looked, 18 of 117 cards were out of place and a Sept 6 post was
 * sitting in position 7.
 *
 * It was fixed by hand once and that fixes nothing: the next late post puts it
 * back. An instruction to run a sorter is not a sorter.
 *
 * THE ROUND TRIP IS THE SAFETY
 *
 * This rewrites a live page, so before changing anything it takes the cards out
 * and puts them back in their ORIGINAL order, and asserts the result is
 * byte-identical to the file it read. If that fails the parse is wrong and it
 * refuses, rather than rebuilding a page from a model of itself it cannot
 * prove. The sort is then the same proven transformation with a different order.
 */
import fs from 'node:fs';
import path from 'node:path';

const WRITE = process.argv.includes('--write');
const ROOT = process.cwd();
const INDEX = path.join(ROOT, 'blog', 'index.html');

if (!fs.existsSync(INDEX)) {
  console.error('No blog/index.html here.');
  process.exit(2);
}
const html = fs.readFileSync(INDEX, 'utf8');

/* ---- find the cards structurally, not by class name ---- */

const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

function elementAt(src, i) {
  const open = /^<([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/.exec(src.slice(i));
  if (!open) return null;
  const tag = open[1];
  const head = open[0].length;
  if (open[2] === '/' || VOID.test(tag)) return { start: i, end: i + head };
  const re = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}\\s*>`, 'gi');
  re.lastIndex = i + head;
  let depth = 1; let m;
  while ((m = re.exec(src))) {
    if (m[0][1] === '/') { depth -= 1; if (!depth) return { start: i, end: m.index + m[0].length }; }
    else if (m[1] !== '/') depth += 1;
  }
  return null;
}

const LINK = /href="\/blog\/([^"/]+)\/"/g;
const cards = [];
for (let i = 0; i < html.length; i += 1) {
  if (html[i] !== '<' || html[i + 1] === '/' || html[i + 1] === '!') continue;
  const el = elementAt(html, i);
  if (!el) continue;
  const inner = html.slice(el.start, el.end);
  LINK.lastIndex = 0;
  const uniq = [...new Set([...inner.matchAll(LINK)].map((x) => x[1]))];
  // Exactly one post link: a card. Zero is furniture, more than one is the
  // grid that holds them.
  if (uniq.length !== 1) continue;
  if (cards.some((c) => el.start >= c.start && el.end <= c.end)) continue;
  cards.push({ ...el, slug: uniq[0], html: inner });
  i = el.end - 1;
}

if (!cards.length) { console.log('No blog cards found. Nothing to order.'); process.exit(0); }

/* ---- prove the transformation is lossless before using it ---- */

function reassemble(order) {
  let out = ''; let cur = 0;
  for (let i = 0; i < cards.length; i += 1) {
    out += html.slice(cur, cards[i].start) + order[i].html;
    cur = cards[i].end;
  }
  return out + html.slice(cur);
}

if (reassemble(cards) !== html) {
  console.error('REFUSED — cards out and back in did not reproduce the file. The parse is wrong.');
  process.exit(2);
}

/* ---- date each card from the post itself ---- */

for (const c of cards) {
  const f = path.join(ROOT, 'blog', c.slug, 'index.html');
  if (!fs.existsSync(f)) { c.date = null; continue; }
  const t = fs.readFileSync(f, 'utf8');
  const d = t.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/) || t.match(/datetime="(\d{4}-\d{2}-\d{2})/);
  c.date = d ? d[1] : null;
}

const undated = cards.filter((c) => !c.date);
if (undated.length) {
  // Placing a card whose date is unknown would be arbitrary and would call
  // itself correct. Name them and stop.
  console.error(`REFUSED — ${undated.length} post(s) have no datePublished:`);
  for (const c of undated) console.error(`  ${c.slug}`);
  process.exit(2);
}

// Stable sort, so a re-run never churns the diff.
const sorted = [...cards].sort((a, b) => b.date.localeCompare(a.date));
const wrong = cards.filter((c, i) => sorted[i].slug !== c.slug);

if (!wrong.length) { console.log(`blog/index.html: ${cards.length} cards, already newest-first.`); process.exit(0); }

console.log(`blog/index.html: ${wrong.length} of ${cards.length} cards out of date order.`);
for (let i = 0; i < cards.length; i += 1) {
  if (cards[i].slug !== sorted[i].slug) console.log(`  ${i + 1}: ${cards[i].slug} (${cards[i].date})`);
}

if (!WRITE) { console.log('Re-run with --write to fix.'); process.exit(1); }

const out = reassemble(sorted);
if (out.length !== html.length) {
  console.error('REFUSED — the reordered page is a different length. Something was lost.');
  process.exit(2);
}
fs.writeFileSync(INDEX, out);
console.log('Reordered. Same cards, nothing added or removed.');
process.exit(0);
