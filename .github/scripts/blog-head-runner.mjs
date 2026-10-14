#!/usr/bin/env node
/* VENDORED from seo-system/lib/blog-head-runner.mjs — do not edit here.
   Change it in seo-system and run: node scripts/vendor-blog-head.mjs --write
   seo-system CI refuses a commit while any client's copy differs. */
/**
 * blog-head-runner.mjs — the gate the auto-publish workflow calls.
 *
 *   node .github/scripts/blog-head-runner.mjs --page blog/<slug>/index.html
 *   node .github/scripts/blog-head-runner.mjs --page <p> --repair
 *   node .github/scripts/blog-head-runner.mjs --all            # every post
 *
 * Exits 0 when the page's head is clean, 1 when it is not. With --repair it
 * fixes only the findings marked repairable, writes the file, and then RE-READS
 * IT FROM DISK and checks it again from scratch.
 *
 * THREE RULES, AND THEY ARE THE DESIGN
 *
 * 1. The re-check reads the file back off disk. It never trusts what the
 *    repair function returned. The gate has to be something other than the
 *    thing it is gating, and that holds just as much when the thing it is
 *    gating is its own repair.
 *
 * 2. Exactly ONE repair pass. Fix, re-validate, then merge or stop. A gate
 *    that keeps retrying is a gate that can oscillate, and a gate that can
 *    oscillate is one nobody reads.
 *
 * 3. Every repair is RECORDED, in .github/blog-head-repairs.jsonl, committed
 *    with the fix. A silent auto-repair means the thing producing the defect
 *    never gets fixed -- the frontmatter leak that caused all this would be
 *    quietly repaired every morning forever while the publisher kept emitting
 *    it. The ledger is what makes the recurrence visible, and the runner says
 *    out loud when it is repairing something it has repaired before.
 *
 * The origin comes from the repo's own CNAME. No client name or domain is
 * written down here, so this file is identical in all four site repos.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHead, repairHead } from './blog-head.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SITE_ROOT || process.cwd();
const LEDGER = path.join(ROOT, '.github', 'blog-head-repairs.jsonl');

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
const REPAIR = argv.includes('--repair');
const ALL = argv.includes('--all');
const JSON_OUT = argv.includes('--json');

/** The site's own origin, from the repo. Never a hardcoded domain. */
function origin() {
  if (process.env.SITE_ORIGIN) return process.env.SITE_ORIGIN.replace(/\/+$/, '');
  const cname = path.join(ROOT, 'CNAME');
  if (!fs.existsSync(cname)) {
    console.error('No CNAME and no SITE_ORIGIN — cannot tell what this site\'s own URLs look like.');
    process.exit(2);
  }
  return `https://${fs.readFileSync(cname, 'utf8').trim()}`;
}

const pagePathOf = (rel) => `/${rel.replace(/\\/g, '/').replace(/index\.html$/, '')}`;

/**
 * Does this site actually serve that path?
 *
 * The check uses it to tell a DELIBERATE canonical -- a near-duplicate
 * deferring to the original, or a post deferring to the money page that owns
 * its cluster -- from a page that has canonicalised itself into a URL that
 * does not exist. Without it the gate cannot tell the two apart and reports
 * rather than fails, which is the safe way round.
 */
function servesPath(p) {
  const rel = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return fs.existsSync(path.join(ROOT, rel, 'index.html'))
      || fs.existsSync(path.join(ROOT, rel || 'index.html'));
}

function posts() {
  const dir = path.join(ROOT, 'blog');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'index.html')))
    .map((d) => `blog/${d.name}/index.html`);
}

function priorRepairs() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const ORIGIN = origin();
const pages = ALL ? posts() : [val('--page')].filter(Boolean);
if (!pages.length) {
  console.error('Nothing to check. Pass --page <path> or --all.');
  process.exit(2);
}

const history = priorRepairs();
const report = [];
let bad = 0;

for (const rel of pages) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { console.error(`  MISSING  ${rel}`); bad++; continue; }
  const ctx = { origin: ORIGIN, pagePath: pagePathOf(rel), exists: servesPath };

  const blocking = (list) => list.filter((x) => !x.info);
  let findings = checkHead(fs.readFileSync(file, 'utf8'), ctx);
  const row = { page: rel, before: findings.map((f) => f.code), repaired: [], after: [] };

  if (blocking(findings).length && REPAIR) {
    const fixable = findings.filter((f) => f.repairable);
    if (fixable.length) {
      const { html, repairs } = repairHead(fs.readFileSync(file, 'utf8'), ctx);
      fs.writeFileSync(file, html);
      row.repaired = repairs.map((r) => r.code);

      // RULE 1 — read it back off disk and check again from scratch.
      findings = checkHead(fs.readFileSync(file, 'utf8'), ctx);

      const entry = {
        at: new Date().toISOString(), page: rel,
        repaired: repairs, remaining: findings.map((f) => f.code),
      };
      fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
      fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);

      // RULE 3 — say so when this is not the first time.
      for (const r of repairs) {
        const seen = history.filter((h) => (h.repaired || []).some((x) => x.code === r.code)).length;
        if (seen) {
          row.recurrence = row.recurrence || [];
          row.recurrence.push(`${r.code} has now been auto-repaired ${seen + 1} times — fix what is producing it`);
        }
      }
    }
  }

  row.after = blocking(findings).map((f) => f.code);
  row.notes = findings.filter((f) => f.info).map((f) => f.message);
  row.messages = blocking(findings)
    .map((f) => `${f.repairable ? 'repairable' : 'needs a human'}: ${f.message}`);
  if (row.after.length) bad++;
  report.push(row);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ origin: ORIGIN, pages: report, ok: bad === 0 }, null, 2));
  process.exit(bad ? 1 : 0);
}

for (const r of report) {
  for (const n of r.notes || []) console.log(`  note      ${r.page}
              ${n}`);
  if (!r.after.length && !r.repaired.length) { if (!(r.notes || []).length) console.log(`  ok        ${r.page}`); continue; }
  if (!r.after.length) {
    console.log(`  REPAIRED  ${r.page}`);
    for (const c of r.repaired) console.log(`              fixed ${c}`);
    for (const m of r.recurrence || []) console.log(`              ⚠ ${m}`);
    continue;
  }
  console.log(`  FAILED    ${r.page}`);
  for (const m of r.messages) console.log(`              ${m}`);
}

if (bad) {
  console.error('\n  A head that is wrong in these ways is invisible from inside the draft:');
  console.error('  the page renders, the post reads fine, and the canonical quietly points');
  console.error('  somewhere that does not exist. Anything marked "needs a human" is a');
  console.error('  judgement — a different host or a different path may be deliberate, and');
  console.error('  an empty description cannot be invented. Fix those by hand.');
}
process.exit(bad ? 1 : 0);
