---
name: page-depth
description: >
  NewLife Marketing's page structure and content-depth standard for service,
  industry and location pages. Use whenever creating, rewriting, expanding or
  optimising any page under services/, industries/ or digital-marketing-agency-*,
  or when adding YouTube embeds, keyword placements, schema or a table of contents
  to those pages. Covers the 20-section skeleton, per-tier word targets, the
  mandatory keyword-placement checklist, readability gates, video placement and
  slot rules, required JSON-LD, and the location-page local-substance requirement.
  Read this BEFORE writing any page copy.
---

# NewLife Marketing — Page Depth Standard

Single source of truth for how service, industry and location pages are built.
Follow it unless a direct user instruction overrides it.

**Why this exists.** Our pages average ~2,500 words against a ~10,000-word
benchmark (`xgrowth.com.au/account-based-marketing/`). Our section *order* is
already competitive — the depth inside each section is not, and the video,
diagram and table-of-contents layer is missing entirely.

**Applies to:** `services/*/index.html` · `industries/*/index.html` ·
`digital-marketing-agency-*/index.html`

---

## PART 1 — Hard rules

These are not preferences. Violating any of them is a defect.

1. **Never ship an empty content slot.** No `[NEEDS: …]`, no placeholder video
   frame, no "coming soon" heading. A page renders complete or the section is
   removed. `.needs` renders as a visible amber badge and has reached production
   before; `scripts/check-drafts.mjs` guards this.
2. **Never change the slug of an existing page** to chase a keyword. It forfeits
   accrued ranking and every inbound link. Slug optimisation is for new pages only.
3. **Never lose a keyword placement.** Run `scripts/keyword-audit.mjs --snapshot`
   before editing and `--compare` after. It exits 1 on any regression.
4. **Never invent a statistic, client name, or result.** If a number is not
   confirmed, the sentence containing it does not ship.
5. **Readability outranks keyword density.** If an extra keyword mention makes a
   sentence read badly, it costs more than it gains. Leave it out.
6. **This is a service page, not a guide.** Never "in this guide", "we'll cover",
   "by the end of this article". We are describing what we do, not teaching a
   reader to do it themselves.

---

## PART 2 — The 20-section skeleton

Section order for every service page. Industry and location pages use the same
order with section 10 swapped for their own deep-dive.

| # | Section | Words | Video |
|---|---|---|---|
| 1 | Hero — H1, subhead, lead, CTAs, then `trust-band` | — | — |
| 2 | Table of contents with jump links | — | — |
| 3 | The problem with the status quo | 600 | ✓ |
| 4 | What [service] actually is | 700 | ✓ |
| 5 | The N core pillars of [service] | 900 | ✓ |
| 6 | Who it is right for — and who it is not | 700 | ✓ |
| 7 | Why it matters for your business — N benefits | 1,200 | ✓ |
| 8 | How we run it — the N-step process | 1,400 | ✓ |
| 9 | What you actually receive | 600 | — |
| 10 | Deep dive *(service-specific / vertical / local)* | 700 | ✓ |
| 11 | How we measure it — and what we refuse to report | 700 | ✓ |
| 12 | The N most common mistakes, and how we avoid them | 600 | ✓ |
| 13 | The tools and stack we use, and why | 500 | — |
| 14 | Proof — real numbers, attribution window stated | 400 | — |
| 15 | Pull-quote banner (`svc-banner`) | — | — |
| 16 | Meet your [role] | 300 | — |
| 17 | FAQ — 14 questions minimum | 1,000 | — |
| 18 | You / in-house / typical agency comparison table | 200 | — |
| 19 | Related services (`Services That Work Together`) | — | — |
| 20 | Final CTA (`cta-band` or `svc-final`) | — | — |

**Target: ~10,000 words of body copy per page.**

### Section notes

- **§2 TOC.** Full-width, above the first content band. Anchor text carries the
  keyword where natural. Every `<h2>` gets an `id`.
- **§5 pillars.** Numbered `<h3>` per pillar inside `svc-comps` / `svc-comp`.
  Name a real number ("The 5 Pillars of…") — a count in a heading earns featured
  snippets and gives the reader a map.
- **§6 who it is *not* for.** Use the two-column `grid cols-2` "fits when / does
  not fit when" pattern from `services/account-based-marketing/`. A stated
  disqualifier is the highest-trust element on the page.
- **§7 benefits.** The single biggest gap on every current page. Numbered `<h3>`
  per benefit, each with a mechanism ("*why* this happens"), not just a claim.
- **§8 process.** Numbered `<h3>` per step in `steps` / `step reveal`. Each step
  says what we do, what the client sees, and what it produces.
- **§11 measurement.** Two columns: "what we report" / "what we will not do".
  Always state the attribution window inside the metric string.
- **§12 mistakes.** Numbered `<h3>`. Strong keyword surface and highly linkable.
- **§17 FAQ.** `<details><summary>Q</summary><div class="faq-a"><p>A</p></div></details>`
  inside `<div class="faq">`. 14 minimum, 80–150 words each, mirrored into
  `FAQPage` JSON-LD.

### Do NOT copy from the benchmark page

Its depth, yes. These four make it a lead-magnet guide, not a service page:
an "Ultimate Guide" H1 · a downloadable-templates section · an ebook gate ·
an author-byline block.

---

## PART 3 — Keyword placement checklist

Read the page's target keyword from
`../../newlife-seo-system/config/page-target-keywords.json`
(relative to the site repo root). That file is the system of record. If a page
has no entry, ask before guessing.

Every page must place its target keyword in **all** of:

| # | Placement | Rule |
|---|---|---|
| 1 | `<title>` | Front-loaded where it reads naturally. ≤ 60 chars. |
| 2 | Meta description | 150–160 chars, keyword included, earns the click. |
| 3 | **H1 / main header** | Exact phrase or a natural close variant. |
| 4 | **Every image `alt`** | Every single one. Weakest spot on the site today. |
| 5 | H2 / H3 headers | Wherever it reads naturally. Never forced. |
| 6 | Body copy | As often as reads naturally, throughout — not clustered. |
| 7 | First 100 words | Early and unforced. |
| 8 | TOC jump-link anchors | Where natural. |
| 9 | Inbound internal-link anchors | On other pages linking *to* this one. |
| 10 | URL slug | **New pages only.** Never rename an existing slug. |

Alongside the exact phrase, use semantic variants and related terms — search
engines reward topical coverage, and variety is what keeps 10,000 words readable.

**Location pages** additionally place the city name in the title, H1, meta
description, first paragraph, the city-photo `alt`, and throughout the body.
Target format is `"{keyword} in {City}"` or `"{keyword} {City}"`.

---

## PART 3B — Geographic framing (de-localization)

**Rudy's call, 9 Sep 2026.** Google's AI overview was describing NewLife as a
*localized specialist*. That framing shrinks the addressable market and reads as
exclusive to anyone outside Simcoe County.

| Page type | Geographic framing |
|---|---|
| Homepage | **Not localized.** Target the raw keyword. |
| Service pages | **Not localized.** Target the raw keyword. |
| Industry pages | **Not localized.** |
| Location pages | **Fully localized** — this is where local intent lives. |

Rules for every non-location page:

1. **Never say we *serve* or are *for* a named region.** Not in the title, meta
   description, H1, hero lead, trust band, comparison table or schema.
2. **Saying we are *based in* Barrie / Simcoe County is fine** and stays. Being
   from somewhere is not the same as only selling there.
3. **`areaServed` on a page-scoped `Service` block is `"Worldwide"`.** Do not
   narrow it to a city list.
4. **Keep the real postal address** in `LocalBusiness`. That is factual and it
   is what the Google Business Profile needs.
5. **Example searches in body copy** ("roofer near me") should not read as a list
   of the only places we work. Prefer `near me` and generic phrasing over a
   named local town.

Location pages are the exception and stay fully localized — that is the entire
point of having them, and it is where the local keywords are supposed to live.

### Site-wide pass — done 9 Sep 2026

Applied across 227 files plus both chrome partials:

| Surface | Was | Now |
|---|---|---|
| Footer + nav contact | "Serving Barrie, Simcoe County & Ontario" | "Working with clients worldwide" |
| Nav "Our Office" | "Barrie, ON — and the markets we cover across Ontario" | "Barrie, ON — working with clients worldwide" |
| Nav careers | "real client work, Barrie & Simcoe County" | "real client work, in-house in Barrie" |
| Trust band | "Serving **Simcoe County** since 2022" | "Delivering results **since 2022**" |
| `LocalBusiness` description | "agency in Barrie and Simcoe County" | "based in Barrie, Ontario, working with clients worldwide" |
| Shared `areaServed` | `["Barrie","Simcoe County","Ontario"]` | `"Worldwide"` |

Untouched on purpose: the postal address, "Founded in Barrie, Ontario", the
Barrie page's own "Serving Barrie, Ontario" kicker, and the 45 city-scoped
`areaServed: {"@type":"City"}` blocks on location pages.

### ⚠️ Do not run `sync-chrome.mjs --write` to propagate chrome right now

`partials/header.html` is **stale relative to the pages**. Commit `b3972fcb`
edited 226 pages directly without updating the partial, so the partial has no
"Service Areas" nav link and an older Clients menu, while the pages have both.
A sync would delete live nav from 226 pages.

The de-localization pass therefore edited pages and partials in parallel with
identical strings. Chrome drift stayed at exactly 173 pages — unchanged, neither
fixed nor worsened. **Reconciling the partial against the current pages is a
separate job and should be done deliberately, from a page as the source.**

---

## PART 4 — Readability gates

Depth is worthless if the page cannot be read. Check every page against these.

- **Average sentence length ≤ 22 words.** Vary it — a short sentence after two
  long ones is what creates rhythm.
- **A subheading every ~200 words.** No wall of text longer than that.
- **No paragraph over 5 lines** as rendered.
- **One idea per paragraph.**
- **Second person, active voice.** "You get" not "clients are provided with".
- **Plain language.** If a shorter word works, use it.
- **State the honest negative.** Every page names who it is not for, and what we
  refuse to report. This is the house voice and it is why the pages are credible.
- **No filler.** Cut any sentence that would not be missed. Word targets are hit
  with substance or not at all — padding is worse than a shorter page.

---

## PART 5 — Video embeds

**Pages ship text-only. Videos are added in a later pass, after filming.**
Never leave an empty frame, a black box, or a "video coming" note on a live page.

When a video does exist, use the site's established pattern:

```html
<div class="post-video">
  <iframe src="https://www.youtube-nocookie.com/embed/VIDEO_ID"
          title="Descriptive title containing the target keyword"
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowfullscreen></iframe>
</div>
```

- `.post-video` for 16:9. `.post-video vertical` for shorts/reels.
- `youtube-nocookie.com` always — never `youtube.com/embed`.
- `loading="lazy"` always.
- `title` is real, descriptive, and carries the keyword. It is read by screen
  readers and indexed.
- **Every embed needs a `VideoObject` JSON-LD block** (see Part 6). Embedding
  without it forfeits most of the SEO value.

**How many.** One per explainer section — sections 3, 4, 5, 6, 7, 8, 10, 11, 12
gives 9. More is better where the content genuinely supports it: a 9-step process
can carry a video per step. Fewer is correct where an extra video would be filler.
Let the content decide; never pad to hit a count.

---

## PART 6 — Required schema

Per-page JSON-LD. Keep the existing `LocalBusiness` block untouched.

| Type | When | Status on site |
|---|---|---|
| `Service` | every service page | present |
| `FAQPage` | every page with an FAQ | present |
| `BreadcrumbList` | **every page** | **missing site-wide — add it** |
| `VideoObject` | **one per embedded video** | **missing site-wide — add it** |

`VideoObject` requires `name`, `description`, `thumbnailUrl`, `uploadDate`,
`embedUrl`. Use the real YouTube thumbnail URL.

---

## PART 7 — Location pages

Same skeleton, plus one hard requirement.

**Every location page carries a photograph of that city.** Alt text contains
both the target keyword and the city name. A cityscape is not evidentiary — it
does not claim to be our work — so licensed stock is acceptable here, unlike on
a client page.

**Local substance is mandatory, not decorative.** Thirteen city pages at 10,000
words each will only rank if each is genuinely different. Templated city pages at
that length read as doorway pages and get demoted rather than promoted. Every
location page needs real, city-specific content:

- Local market conditions and what makes that city's competition distinct
- Named local client work where it exists
- Local search behaviour and the terms people there actually use
- Neighbourhoods, districts or surrounding towns served
- The city photo

If a city has no local substance available, the page is better at 2,000 honest
words than 10,000 templated ones. Flag it rather than padding it.

---

## PART 8 — Visual system

Reuse the existing house style. Introduce no new design language.

| Component | Class | Use |
|---|---|---|
| Content band | `band` / `band alt` | alternating section backgrounds |
| Inner width | `wrap` | every band's inner container |
| Eyebrow | `kicker` | short label above an H2 |
| Intro line | `lead` | first paragraph of a section |
| Sub-heading | `svc-sub` | **required** on any `<h3>` that is a direct child of `.wrap` |
| Cards | `grid cols-2` / `cols-3` + `card reveal` | parallel points |
| Deep blocks | `svc-comps` > `svc-comp` + `svc-when` | pillars, offers |
| Process | `steps` > `step reveal` | numbered steps |
| Two-column copy/visual | `svc-mod` > `svc-mod-copy` + `svc-mod-media` | copy beside a diagram |
| Single-column variant | `svc-mod svc-mod-1up` | when there is no media |
| Stat block | `stat` + `stat-label`, or `camp-kpis` > `camp-kpi` | numbers |
| Pull quote | `svc-banner` | mid-page emphasis |
| FAQ | `faq` > `details` > `summary` + `faq-a` | questions |
| Final CTA | `cta-band` / `band svc-final` | page close |

**A bare `<h3>` inside a `.wrap` must carry `class="svc-sub"`.** Without it, its
top margin collapses against a preceding `.grid` or `.svc-mod` block and the
heading renders flush against the element above. This shipped as a visible
defect on `/services/seo/` and was caught in review.

**Every inline `<svg role="img">` needs an `aria-label`** describing what it
shows, with the target keyword where it reads naturally. A mockup with no
accessible name announces nothing to a screen reader and gives a crawler no
context.

**Diagrams are hand-authored inline `<svg>`** inside a `browser-frame` (`bf-bar`,
`bf-dot`, `bf-url`, `bf-screen`) for UI mockups. There are 327 inline SVGs on the
site already — match them. Never use a raster screenshot where an SVG will do.

Every `.reveal` element animates in via `js/main.js`. Add `reveal` to new cards
and blocks for consistency.

---

## PART 9 — Before you finish

```bash
node scripts/keyword-audit.mjs --compare        # no keyword placement lost
node scripts/check-drafts.mjs                   # no placeholders, no empty slots
node scripts/sync-chrome.mjs --check            # chrome not hand-edited
```

Then confirm by hand:

- Body word count is at or near target
- Every image has an `alt` containing the keyword
- Every `<h2>` has an `id` and appears in the TOC
- `BreadcrumbList` present; `VideoObject` present for each embed
- Average sentence length under 22 words
- No section shipped empty
- Page renders at mobile, tablet and desktop

**Never hand-edit the header or footer inside a page.** Edit `partials/header.html`
or `partials/footer.html`, then run `node scripts/sync-chrome.mjs --write`.
See `partials/README.md`.
