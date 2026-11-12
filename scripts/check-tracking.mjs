// Guards the Google Ads conversion tracking (Tag Manager container GTM-K4PD7QK5).
// See TRACKING.md for what each check protects and why.
//
//   node scripts/check-tracking.mjs
//
// FAIL (exit 1): something that would silently stop conversions being counted
//                and will not fix itself.
// WARN (exit 0): pages missing the GTM snippet. The "Tracking guard" workflow
//                adds it on main automatically (scripts/add-gtm.mjs --write),
//                so a new post in a PR is expected to warn here.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GTM = "GTM-K4PD7QK5";
const GA4 = "G-N3TBK96H9F";
const PHONE = "tel:+17053021097";
const BOOKING_WIDGET = "widget/booking/";

const fails = [], warns = [];
const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : null);
const need = (rel, ok, msg) => { const s = read(rel); if (s === null) fails.push(`${rel}: file is missing (${msg})`); else if (!ok(s)) fails.push(`${rel}: ${msg}`); };
const count = (s, needle) => s.split(needle).length - 1;

// 1. Form success signal. Every native form must dispatch nl:form-success after
//    GHL confirms the lead; GTM's "Listener - NL Native Forms" turns it into the
//    Form Lead conversion. Pages load the MINIFIED build, so check both.
for (const f of ["js/main.js", "js/main.min.js"]) {
  need(f, (s) => count(s, "nl:form-success") >= 2,
    'must dispatch "nl:form-success" for BOTH the book form and the contact form (Form Lead conversion). If you edited main.js, rebuild main.min.js too.');
}
need("trades/free-website/index.html", (s) => s.includes("nl:form-success"),
  'Free Website form must dispatch "nl:form-success" after the webhook succeeds (Form Lead conversion).');

// 2. Booked Call: the calendar must stay the GoHighLevel booking widget.
need("book/call/index.html", (s) => s.includes(BOOKING_WIDGET),
  "booking page no longer embeds the GoHighLevel calendar. The Booked Call conversion listens for GHL's booking-complete message; a different booking tool needs a new listener in GTM.");

// 3. Phone: the number must stay a clickable tel: link in the shared header and footer.
for (const f of ["partials/header.html", "partials/footer.html"]) {
  need(f, (s) => s.includes(PHONE), `must keep the phone number as a link to ${PHONE} (Phone Click conversion).`);
}

// 4. GA4: the GHL listener reports bookings to GA4 through the page's gtag.
for (const f of ["index.html", "contact/index.html", "book/index.html", "book/call/index.html"]) {
  need(f, (s) => s.includes(GA4), `lost the GA4 tag ${GA4}.`);
}

// 5. GTM snippet: exactly one, and the right container. A second container or a
//    different ID would double-fire or send conversions somewhere else.
const html = execFileSync("git", ["ls-files", "*.html"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((f) => f && !f.startsWith("partials/") && !f.startsWith("portal/"));
const missing = [];
for (const f of html) {
  const s = read(f);
  if (!s || /http-equiv=["']refresh["']/i.test(s) || !/<head(\s[^>]*)?>/i.test(s)) continue;
  const ids = [...new Set(s.match(/GTM-[A-Z0-9]{6,}/g) || [])];
  if (ids.some((id) => id !== GTM)) fails.push(`${f}: contains another Tag Manager container (${ids.join(", ")}). NewLife uses only ${GTM}.`);
  else if (count(s, `'${GTM}'`) > 1) fails.push(`${f}: loads ${GTM} more than once (conversions would double count).`);
  else if (!ids.length) missing.push(f);
}
if (missing.length) {
  warns.push(`${missing.length} page(s) don't load ${GTM} yet. They are added automatically once merged to main; to do it now run: node scripts/add-gtm.mjs --write`);
  missing.slice(0, 10).forEach((f) => warns.push(`  - ${f}`));
}

for (const w of warns) console.log(`::warning::${w}`);
for (const f of fails) console.log(`::error::${f}`);
console.log(fails.length ? `\nTracking check FAILED (${fails.length}). See TRACKING.md.` : "\nTracking check passed.");
process.exit(fails.length ? 1 : 0);
