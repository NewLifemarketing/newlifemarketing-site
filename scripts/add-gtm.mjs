// Inserts the NewLife Google Tag Manager container (GTM-K4PD7QK5) right after
// <head> on every real page. Idempotent: pages already carrying the marker are
// left alone, so it is safe to re-run after new pages are published.
//
// Skips: redirect stubs (http-equiv=refresh), portal/* (private client pages),
// partials/, and anything without a <head> tag.
//
//   node scripts/add-gtm.mjs           # dry run, lists what would change
//   node scripts/add-gtm.mjs --write   # apply
//   node scripts/add-gtm.mjs --check   # exit 1 if any eligible page is missing it
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ID = "GTM-K4PD7QK5";
const MARK = "<!-- Google Tag Manager -->";
const SNIPPET =
  `${MARK}<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':` +
  `new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],` +
  `j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=` +
  `'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);` +
  `})(window,document,'script','dataLayer','${ID}');</script><!-- End Google Tag Manager -->`;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODE = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : "dry";
const SKIP_DIRS = new Set([".git", "node_modules", "partials", "portal", ".github"]);
const RX_HEAD = /<head(\s[^>]*)?>/i;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) yield* walk(p); }
    else if (name.endsWith(".html")) yield p;
  }
}

const todo = [];
let already = 0, skipped = 0;
for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8");
  if (/http-equiv=["']refresh["']/i.test(src) || !RX_HEAD.test(src)) { skipped++; continue; }
  if (src.includes(ID)) { already++; continue; }
  todo.push(file);
  if (MODE === "write") writeFileSync(file, src.replace(RX_HEAD, (m) => m + "\n" + SNIPPET));
}

const rel = (f) => relative(ROOT, f).split(sep).join("/");
console.log(`${MODE}: ${todo.length} page(s) ${MODE === "write" ? "updated" : "missing GTM"}, ${already} already have it, ${skipped} skipped (stubs/no head)`);
if (MODE !== "write") todo.slice(0, 15).forEach((f) => console.log("  - " + rel(f)));
if (MODE === "check" && todo.length) process.exit(1);
