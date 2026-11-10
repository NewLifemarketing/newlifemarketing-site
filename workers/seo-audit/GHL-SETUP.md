# Sending audit leads into GoHighLevel

The worker posts every completed audit to one webhook URL. GHL receives it,
creates or updates the contact, tags it, and an automation sends the email.

**No credential belongs in this repo.** The webhook URL is a Worker secret.

---

## 1. Build the workflow in GHL

In your sub-account: **Automation → Workflows → Create Workflow → Start from
scratch.**

**Trigger:** `Inbound Webhook`. Save it, and GHL shows a URL ending in
`/hooks/.../webhook-trigger/...`. That URL is the thing you paste in step 3.

GHL needs to see one real payload before it will let you map fields, so leave
the tab open and come back to it after step 3 and 4 — run one audit and the
sample appears.

**Actions, in order:**

| action | set to |
|---|---|
| **Create/Update Contact** | Email → `{{inboundWebhookRequest.email}}` · First Name → `{{inboundWebhookRequest.name}}` · Phone → `{{inboundWebhookRequest.phone}}` · Company Name → `{{inboundWebhookRequest.company}}` |
| **Add Contact Tag** | `seo audit` |
| **Send Email** | see §2 |

Set **Contact Creation: Allow re-entry** off unless you want a repeat visitor
re-entering the workflow.

### What the webhook sends

```json
{
  "website": "https://example.ca",
  "company": "Example Landscaping",
  "name": "Sam Taylor",
  "email": "sam@example.ca",
  "phone": "705 555 0199",
  "is_owner": "yes",
  "at": "2026-11-10T14:03:11.004Z",
  "pages_crawled": 20,
  "pages_found": 145,
  "services": "Interlock Patios & Walkways, Stone Steps, Armourstone",
  "areas": "Barrie, Midhurst, Innisfil, Wasaga, Simcoe County",
  "tag": "seo audit"
}
```

`is_owner` is worth a condition branch: `no` means they were checking somebody
else's site — a competitor, or an agency looking at a prospect. Same lead,
different conversation, and tagging them the same way loses that.

Add **Custom Fields** for `website`, `pages_found` and `services` if you want
them on the contact record; GHL only maps what you give it a home for.

## 2. The email

Keep it honest about what they already saw. They have the instant report on
screen; what this promises is the full one.

> **Subject:** Your full SEO audit for {{contact.company_name}}
>
> Hi {{contact.first_name}},
>
> Thanks for running the audit on {{inboundWebhookRequest.website}}. The version
> on screen read {{inboundWebhookRequest.pages_crawled}} of your
> {{inboundWebhookRequest.pages_found}} pages — enough to show the shape of it,
> not enough to be the whole picture.
>
> We are going through the rest by hand and will send you the full one, with the
> keyword research behind it, within two business days.
>
> — Cruz, NewLife Marketing

**Only promise what gets delivered.** That email commits a person to doing the
real audit within two days. If that is not going to happen, change the wording
before this goes live, not after the first one is late.

## 3. Give the worker the URL

```bash
cd workers/seo-audit
npx wrangler secret put GHL_WEBHOOK
```

Paste the URL at the prompt. It is stored by Cloudflare, never written to this
repo, and never printed back.

```bash
npx wrangler deploy
```

## 4. Prove it fires

Run one audit from `/seo-audit/`. The response carries `lead_sent: "queued"`
when the secret is set and `null` when it is not, so you can tell a missing
secret from a GHL problem without guessing.

Then check, in this order, because each one rules out the stage before it:

1. the workflow's **Execution Logs** — did GHL receive it
2. **Contacts** — was the contact created with the tag `seo audit`
3. the contact's **Activity** — did the email send

**Verify the outcome, not the step.** A green workflow execution means GHL ran;
it does not mean the email arrived. Check your own inbox with a real address
once before trusting it.

## What this deliberately does not do

**The webhook cannot break the report.** It is sent with `waitUntil`, so a slow
or broken GHL never delays or fails the audit the visitor asked for. The cost of
that choice: a failed send is invisible here. If leads stop appearing in GHL, the
worker will not tell you — check the execution logs.

**There is no retry.** One attempt, and the lead is also written to KV when that
namespace exists (see `wrangler.toml`), which is the backstop worth having
before this is linked publicly.
