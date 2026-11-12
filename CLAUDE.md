# newlifemarketing-site

## Conversion tracking is load-bearing: read TRACKING.md first

Google Ads counts NewLife's leads through Tag Manager `GTM-K4PD7QK5`. Before you edit forms, `js/main.js` / `js/main.min.js`, the booking page (`book/call/`), phone links, or any page `<head>`, read [TRACKING.md](TRACKING.md).

The short version: never remove these five things.

- The GTM snippet after `<head>`
- The `nl:form-success` dispatch on form success
- The GoHighLevel calendar embed
- `tel:+17053021097` links
- The GA4 tag `G-N3TBK96H9F`

Never add a second GTM container or a raw `AW-` Google Ads tag.

Run `node scripts/check-tracking.mjs` before opening a PR. CI runs it on every PR.
