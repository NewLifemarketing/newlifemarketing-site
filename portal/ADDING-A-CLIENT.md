# Adding a Client to the Portal

Everything you do in Supabase to give a new client portal access. Roughly 5
minutes per client. Nothing here touches the website — no deploy needed.

Portal login page: **https://newlifemarketing.ca/portal/**
Supabase project: **newlife-portal** (NewLifemarketing's Org)

---

## Before you start (one time only)

These are already done for the live project — listed so a rebuild is repeatable:

- [x] `portal/supabase/schema.sql` has been run in the SQL Editor (tables, privileges, RLS)
- [x] Authentication → URL Configuration → Site URL = `https://newlifemarketing.ca`
- [x] Redirect URLs include `https://newlifemarketing.ca/portal/reset/`

---

## Step 1 — Create the client company row

**SQL Editor → + New query.** Fill in the two names, then Run.

```sql
insert into public.clients (name, business_name)
values ('SHORT NAME', 'FULL LEGAL / DISPLAY NAME')
returning id;
```

- `name` — short label you'll recognise, e.g. `Elite Cards`
- `business_name` — what the client sees in their sidebar, e.g. `Elite Cards Toronto Inc.`

**Copy the `id` it returns.** You need it in step 3.

*Optional — control which report sections they see* (Onboarding is always visible).
Default is all three. To limit them, add a `sections` value:

```sql
insert into public.clients (name, business_name, sections)
values ('SHORT NAME', 'FULL NAME', array['meta','gbp'])
returning id;
```
Valid entries: `meta`, `google_ads`, `gbp`.

---

## Step 2 — Create their login user

**Authentication** (padlock icon in the left rail) → **Users** → green **Add user** →
**Create new user**.

- **Email:** the client's real work email
- **Password:** type a long random throwaway — they will never use it (step 4 sends
  them a link to set their own)
- ✅ **Tick "Auto Confirm User"** ← required. Without it they get
  "Email not confirmed" and can never log in.

Click **Create user**.

---

## Step 3 — Link the user to the client

**SQL Editor → + New query.** Paste the client id from step 1, the client's email,
and their name. Run it.

```sql
update public.profiles
set client_id = 'PASTE-CLIENT-ID-FROM-STEP-1',
    full_name = 'CLIENT CONTACT NAME'
where id = (select id from auth.users where email = 'CLIENT-EMAIL');

-- confirm (should return exactly one row with the right client)
select p.full_name, p.role, c.name as client, c.business_name
from public.profiles p
left join public.clients c on c.id = p.client_id
where p.id = (select id from auth.users where email = 'CLIENT-EMAIL');
```

**The check must return one row showing their name and the right company.**
If it returns 0 rows, the profile row wasn't auto-created — run this, then re-run
the check:

```sql
insert into public.profiles (id, client_id, full_name, role)
select u.id, 'PASTE-CLIENT-ID-FROM-STEP-1', 'CLIENT CONTACT NAME', 'client'
from auth.users u
where u.email = 'CLIENT-EMAIL'
on conflict (id) do update
  set client_id = excluded.client_id, full_name = excluded.full_name;
```

---

## Step 4 — Have them set their own password

Don't email passwords. Send them to the portal and let Supabase do it:

1. Email the client: *"Your portal is ready at newlifemarketing.ca/portal/ — click
   **Forgot password?**, enter this email address, and you'll get a link to set your
   password."*
2. They click **Forgot password?**, enter their email, get the reset email, land on
   `/portal/reset/`, choose a password, and sign in.

*Alternative (you trigger it):* Authentication → Users → **⋯** at the end of their
row → **Send password recovery**.

---

## Step 5 — Verify before you tell them it's live

Log in as them once yourself (use the password from step 2, or set one via SQL —
see Troubleshooting), and check:

- [ ] Sidebar bottom-left shows **their contact name** and **their business name**
- [ ] Log out works and returns to the login page
- [ ] Pasting `/portal/dashboard/` while logged out bounces to the login page

Then change/reset the password so only they know it, and send the step-4 email.

---

## Troubleshooting

**"That email and password don't match an account"**
The account exists but the password is wrong (browser autofill is the usual
culprit). Set it explicitly:

```sql
update auth.users
set encrypted_password = extensions.crypt('SOME-TEMP-PASSWORD', extensions.gen_salt('bf'))
where email = 'CLIENT-EMAIL';
```

**"Email not confirmed"** — Auto Confirm wasn't ticked:

```sql
update auth.users set email_confirmed_at = now() where email = 'CLIENT-EMAIL';
```

**Sidebar shows their email instead of their name** — step 3 didn't take. Re-run the
confirm query in step 3. If it errors with *permission denied*, the privilege grants
are missing; re-run the `grant` block from `portal/supabase/schema.sql`.

**Reset email link goes to localhost** — Authentication → URL Configuration:
Site URL must be `https://newlifemarketing.ca` and
`https://newlifemarketing.ca/portal/reset/` must be in Redirect URLs.

---

## Removing access

**Pause one person** (keeps their data): Authentication → Users → **⋯** → Delete user.
The profile row deletes automatically; the client company and its data stay.

**Off-board a whole client** (deletes their data too):

```sql
delete from public.clients where name = 'SHORT NAME';
```

---

## Why this is safe

- The key in `portal/config.js` is the **publishable** key — public by design.
  It grants nothing on its own.
- Every table has **Row-Level Security**: a logged-in user can only read rows where
  `client_id` matches their own profile. Verified — a client sees only their own
  company row and nothing else.
- Clients have **read-only** access. They cannot create clients, cannot re-point
  their profile at another company, and cannot touch `platform_tokens` (no
  privilege and no policy — API tokens are server-side only).
- **Never** put the `sb_secret_…` key on the website. It bypasses RLS entirely and
  belongs only in server-side code.
