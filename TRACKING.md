# Conversion tracking: rules for anyone editing this site

**Read this before changing forms, the booking page, phone links, `js/main.js`, or the `<head>` of any page.** That applies to people and to Claude sessions, including the blog, SEO and landing-page pipelines.

Google Ads counts leads through Google Tag Manager container **`GTM-K4PD7QK5`**. The container itself is managed outside this repo, in the NewLife Ads tracking setup. It needs the five things below from this site. Break any one of them and conversions silently stop counting: ads keep spending money, but Google can't see the leads.

| # | Keep this | Where | Feeds |
|---|---|---|---|
| 1 | The GTM snippet right after `<head>` on every page (one copy, this ID only) | every `*.html` | everything, including the ad click ID (Conversion Linker) |
| 2 | `document.dispatchEvent(new CustomEvent("nl:form-success", {detail:{form:"…"}}))` fired **after** the GHL webhook succeeds | `js/main.js` **and** `js/main.min.js` (book + contact forms), `trades/free-website/index.html` | Form Lead |
| 3 | The GoHighLevel calendar embed (`api.leadconnectorhq.com/widget/booking/…`) | `book/call/index.html` (and any other page that embeds it) | Booked Call |
| 4 | The phone number as a link: `<a href="tel:+17053021097">` | `partials/header.html`, `partials/footer.html`, any page that shows the number | Phone Click |
| 5 | The hardcoded GA4 tag `G-N3TBK96H9F` | page `<head>` | Bookings reported to GA4 |

## Safe to change freely

Copy, design, layout, CSS, images, new sections, new pages, URLs, and form fields. Form fields are fine as long as #2 still fires on success.

## Adding things

- **A new page:** nothing to do. The **Tracking guard** workflow adds the GTM snippet automatically once the page is on `main`. To add it immediately, run `node scripts/add-gtm.mjs --write`.
- **A new form:** either embed a GoHighLevel form (it's tracked automatically through its iframe message), or copy the book/contact pattern from `js/main.js` *including* the `nl:form-success` dispatch.
- **A different booking tool** (Calendly, etc.): the Booked Call conversion will stop. The GTM listener needs updating first.
- **Landing pages hosted elsewhere** (GHL funnels, other domains): add the GTM snippet in that platform's head tracking code. This repo can't cover them.

## Checks

```
node scripts/check-tracking.mjs   # what CI runs on every PR
node scripts/add-gtm.mjs --check  # just the GTM snippet coverage
```

The **Tracking guard** workflow (`.github/workflows/tracking-guard.yml`) does two jobs. On every PR, it fails the PR if #2 to #5 break, or if a page has a different or duplicate GTM container. On every push to `main`, it adds GTM to any page that's missing it.

## Don't

- Add a second Tag Manager container, or paste Google Ads `AW-` tags straight into pages. Conversions would double count. All Ads tags live inside GTM.
- Rename the dataLayer events `nl_form_success`, `ghl_form_submit` or `ghl_booking_complete`, or the `nl:form-success` document event. The GTM triggers match these names exactly.
