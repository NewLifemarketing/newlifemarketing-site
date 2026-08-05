# Report Data Format — `report_cache` payload spec

This is the contract between the **report-generation automation** and the
**client portal**. The automation exports data from Meta, Google Ads, Google
Business Profile, Semrush/Search Console and Sprout Social, converts it to the
JSON below, and inserts one row per client + platform + reporting period. The
portal renders whatever it finds — it does no maths on raw platform data and has
no hardcoded numbers.

**Golden rule:** the portal displays values *exactly as given*. Format numbers
(currency symbols, `%`, `x`, thousands separators, `K`/`M` shortening) in the
payload, not in the portal.

---

## 1. The row you insert

Table: `public.report_cache`

| Column | Type | Notes |
|---|---|---|
| `client_id` | uuid | From `public.clients.id` |
| `platform` | enum | One of `meta`, `google_ads`, `gbp`, `seo`, `organic` |
| `period_start` | date | First day of the reporting period (inclusive) |
| `period_end` | date | Last day of the reporting period (inclusive) |
| `payload` | jsonb | The document specified in §2 |
| `is_sample` | boolean | `false` for real data. `true` shows a "Sample data" badge |
| `refreshed_at` | timestamptz | Defaults to `now()`; shown as "Last updated" |

Reports are **per period, not rolling** — weekly for some clients, biweekly for
others. A unique index enforces one row per `(client_id, platform, period_start,
period_end)`, so re-running a period is an upsert, not a duplicate.

### Insert shape (real data)

```sql
insert into public.report_cache
  (client_id, platform, period_start, period_end, payload, is_sample)
values
  ('CLIENT-UUID', 'meta', '2026-07-22', '2026-08-04', '{ ...payload... }'::jsonb, false)
on conflict (client_id, platform, period_start, period_end)
do update set payload = excluded.payload,
              is_sample = excluded.is_sample,
              refreshed_at = now();
```

Notes for the automation:
- Insert with the **service-role key** (server-side). The portal's publishable
  key is read-only under RLS and cannot write.
- All five platforms for one period should share identical `period_start` /
  `period_end` so they group into one period in the portal's period selector.
- A platform with no service for that client simply has no row — the portal
  hides it (see §4).
- `date_range` is a legacy column; leave it null.

---

## 2. Payload document (same shape for every platform)

```jsonc
{
  "summary": {
    "cards":   [ { "label": "Spend", "value": "$4,583" } ],   // 3–4 items, Overview page
    "metrics": { "spend": 4583, "leads": 218 }                // normalized numbers, Overview totals
  },
  "kpis": [
    { "label": "Amount spent", "value": "$4,583",
      "delta": { "dir": "up", "text": "12% vs prev" } }
  ],
  "charts": [
    { "title": "Spend & conversions over time", "type": "line",
      "labels": ["Wk 1", "Wk 2"],
      "datasets": [
        { "label": "Spend ($)", "data": [520, 610], "color": "blue", "fill": true },
        { "label": "Conversions", "data": [420, 560], "color": "green" }
      ] }
  ],
  "tables": [
    { "title": "Campaigns",
      "columns": [
        { "key": "campaign", "label": "Campaign" },
        { "key": "spend", "label": "Spend", "align": "num" },
        { "key": "roas", "label": "ROAS", "align": "num", "hot": true }
      ],
      "rows": [ { "campaign": "Prospecting — Broad", "spend": "$3,120", "roas": "2.6x" } ] }
  ]
}
```

### Field reference

**`summary.cards`** — 3–4 compact stats for this channel's block on the Overview
page. `{ "label": string, "value": string }`. Required.

**`summary.metrics`** — normalized **numbers** (no symbols) the Overview adds up
across channels. Include only what applies:

| Key | Meaning | Used by |
|---|---|---|
| `spend` | Ad spend for the period | Total ad spend card (meta + google_ads) |
| `leads` | Leads / conversions | Total leads card (all paid channels) |
| `conversion_value` | Platform-reported conversion value | Conversion value card |
| `calls` | Phone calls from the profile | GBP calls card |
| `engagements` | Organic social engagements | Organic engagements card |
| `keywords_top10` | Keywords ranking in positions 1–10 | SEO keywords card |

**`kpis`** — the stat-card row at the top of the channel page. 6 recommended.
- `label` — small uppercase caption
- `value` — the big number, pre-formatted
- `delta` *(optional)* — `dir` is `"up"`, `"down"` or `"flat"`; `text` is the
  change, e.g. `"12% vs prev"`. `up` renders green, `down` red. **`dir` is about
  colour, not arithmetic** — for a metric where falling is good (cost per lead),
  send `dir: "up"` with `text: "▼ 8%"` only if you want it green; otherwise use
  `down`. Keep it honest and consistent per metric.

**`charts`** — 1 or 2 per page. Two render side by side (wide + narrow); one
renders full width.
- `type` — `"line"`, `"bar"` or `"doughnut"`
- `labels` — x-axis labels (or segment labels for doughnut)
- `datasets[].data` — plain numbers, same length as `labels`
- `datasets[].color` — `"blue"`, `"blue2"`, `"green"` or `"grey"` (brand palette;
  omit for auto). Doughnut/bar segments cycle the palette automatically.
- `datasets[].fill` — `true` for the shaded area look used on existing pages

**`tables`** — 0, 1 or 2 per page, rendered in order.
- `columns[].key` — matches a key in each row object
- `columns[].align` — `"num"` right-aligns (use for all numbers)
- `columns[].hot` — `true` renders the value in brand blue (highlight column)
- `rows[]` — cell values are strings, **or** an object for coloured deltas:
  `{ "text": "+3", "dir": "up" }` → renders `▲ +3` in green.
  `dir: "down"` → red, `"flat"` → neutral.
- Keep rows to a sensible number (4–10). The portal scrolls horizontally on
  mobile but does not paginate.

---

## 3. Per-platform specifics

Below is what each channel's page expects. The shape is identical; only the
contents differ. `metrics` keys listed are the ones that channel must supply.

### 3.1 `meta` — Meta Ads

- **KPI cards (6):** Amount spent · Leads · Purchases ROAS · CTR · CPC · Conversions
- **Charts:** line "Spend & conversions over time" · doughnut "Spend by campaign"
- **Table:** Campaigns — Campaign, Reach, Spend, Results, ROAS, Status
- **metrics:** `spend`, `leads`, `conversion_value`

```json
{
  "summary": {
    "cards": [
      { "label": "Spend", "value": "$4,583" },
      { "label": "Leads", "value": "218" },
      { "label": "ROAS", "value": "3.9x" },
      { "label": "Conv. value", "value": "$17.9K" }
    ],
    "metrics": { "spend": 4583, "leads": 218, "conversion_value": 17900 }
  },
  "kpis": [
    { "label": "Amount spent", "value": "$4,583", "delta": { "dir": "up", "text": "12% vs prev" } },
    { "label": "Leads", "value": "218", "delta": { "dir": "up", "text": "18%" } },
    { "label": "Purchases ROAS", "value": "3.9x", "delta": { "dir": "up", "text": "0.4" } },
    { "label": "CTR", "value": "2.4%", "delta": { "dir": "up", "text": "0.3%" } },
    { "label": "CPC", "value": "$0.70", "delta": { "dir": "down", "text": "8%" } },
    { "label": "Conversions", "value": "3,824", "delta": { "dir": "up", "text": "21%" } }
  ],
  "charts": [
    { "title": "Spend & conversions over time", "type": "line",
      "labels": ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "Wk 5", "Wk 6"],
      "datasets": [
        { "label": "Spend ($)", "data": [520, 610, 700, 760, 900, 1090], "color": "blue", "fill": true },
        { "label": "Conversions", "data": [420, 560, 620, 700, 820, 980], "color": "green" }
      ] },
    { "title": "Spend by campaign", "type": "doughnut",
      "labels": ["Prospecting", "Retargeting", "Advantage+", "Interests"],
      "datasets": [{ "label": "Spend", "data": [3120, 1840, 2210, 1250] }] }
  ],
  "tables": [
    { "title": "Campaigns",
      "columns": [
        { "key": "campaign", "label": "Campaign" },
        { "key": "reach", "label": "Reach", "align": "num" },
        { "key": "spend", "label": "Spend", "align": "num" },
        { "key": "results", "label": "Results", "align": "num" },
        { "key": "roas", "label": "ROAS", "align": "num", "hot": true },
        { "key": "status", "label": "Status" }
      ],
      "rows": [
        { "campaign": "Prospecting — Broad", "reach": "89,400", "spend": "$3,120", "results": "342", "roas": "2.6x", "status": "Active" }
      ] }
  ]
}
```

### 3.2 `google_ads` — Google Ads

- **KPI cards (6):** Cost · Leads · Conv. value · CTR · CPC · Conversions
- **Charts:** line "Conversions over time" · bar "Cost by campaign type"
- **Table:** Campaigns — Campaign, Cost, Clicks, Conv., Conv. value
- **metrics:** `spend`, `leads`, `conversion_value`

```json
{
  "summary": {
    "cards": [
      { "label": "Cost", "value": "$4,560" },
      { "label": "Leads", "value": "312" },
      { "label": "Conv. value", "value": "$34.6K" },
      { "label": "CPC", "value": "$0.93" }
    ],
    "metrics": { "spend": 4560, "leads": 312, "conversion_value": 34600 }
  },
  "kpis": [
    { "label": "Cost", "value": "$4,560", "delta": { "dir": "up", "text": "6%" } },
    { "label": "Leads", "value": "312", "delta": { "dir": "up", "text": "18%" } },
    { "label": "Conv. value", "value": "$34.6K", "delta": { "dir": "up", "text": "26%" } },
    { "label": "CTR", "value": "7.1%", "delta": { "dir": "up", "text": "0.6%" } },
    { "label": "CPC", "value": "$0.93", "delta": { "dir": "down", "text": "5%" } },
    { "label": "Conversions", "value": "312", "delta": { "dir": "up", "text": "14%" } }
  ],
  "charts": [
    { "title": "Conversions over time", "type": "line",
      "labels": ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "Wk 5", "Wk 6"],
      "datasets": [{ "label": "Conversions", "data": [38, 46, 52, 61, 70, 82], "color": "blue", "fill": true }] },
    { "title": "Cost by campaign type", "type": "bar",
      "labels": ["Search-Brand", "Search-NB", "PMax", "YouTube"],
      "datasets": [{ "label": "Cost ($)", "data": [410, 2140, 1480, 530] }] }
  ],
  "tables": [
    { "title": "Campaigns",
      "columns": [
        { "key": "campaign", "label": "Campaign" },
        { "key": "cost", "label": "Cost", "align": "num" },
        { "key": "clicks", "label": "Clicks", "align": "num" },
        { "key": "conv", "label": "Conv.", "align": "num" },
        { "key": "value", "label": "Conv. value", "align": "num", "hot": true }
      ],
      "rows": [
        { "campaign": "Search — Brand", "cost": "$410", "clicks": "980", "conv": "96", "value": "$9,800" }
      ] }
  ]
}
```

### 3.3 `gbp` — Google Business Profile

- **KPI cards (6):** Calls · Direction requests · Website clicks · Profile views · Reviews · Avg. rating
- **Charts:** line "Customer actions over time" · doughnut "How customers found you"
- **Table:** Top search queries — Search term, Impressions, Actions
- **metrics:** `calls`

```json
{
  "summary": {
    "cards": [
      { "label": "Calls", "value": "214" },
      { "label": "Directions", "value": "486" },
      { "label": "Website clicks", "value": "903" },
      { "label": "Avg. rating", "value": "5.0★" }
    ],
    "metrics": { "calls": 214 }
  },
  "kpis": [
    { "label": "Calls", "value": "214", "delta": { "dir": "up", "text": "38%" } },
    { "label": "Direction requests", "value": "486", "delta": { "dir": "up", "text": "22%" } },
    { "label": "Website clicks", "value": "903", "delta": { "dir": "up", "text": "14%" } },
    { "label": "Profile views", "value": "1,940", "delta": { "dir": "up", "text": "62%" } },
    { "label": "Reviews", "value": "127", "delta": { "dir": "up", "text": "9 new" } },
    { "label": "Avg. rating", "value": "5.0★", "delta": { "dir": "flat", "text": "steady" } }
  ],
  "charts": [
    { "title": "Customer actions over time", "type": "line",
      "labels": ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "Wk 5", "Wk 6"],
      "datasets": [
        { "label": "Calls", "data": [28, 34, 39, 41, 47, 51], "color": "blue" },
        { "label": "Directions", "data": [60, 72, 78, 84, 96, 110], "color": "green", "fill": true }
      ] },
    { "title": "How customers found you", "type": "doughnut",
      "labels": ["Search — Discovery", "Search — Direct", "Maps"],
      "datasets": [{ "label": "Share", "data": [58, 27, 15] }] }
  ],
  "tables": [
    { "title": "Top search queries",
      "columns": [
        { "key": "term", "label": "Search term" },
        { "key": "impressions", "label": "Impressions", "align": "num" },
        { "key": "actions", "label": "Actions", "align": "num", "hot": true }
      ],
      "rows": [ { "term": "businesses near me", "impressions": "4,120", "actions": "312" } ] }
  ]
}
```

### 3.4 `seo` — SEO (Semrush + Search Console)

- **KPI cards (6):** Keywords ranking · Keywords in top 3 · Keywords in top 10 · Average position · Organic traffic (sessions) · Site health
- **Charts:** line "Keyword position distribution over time" (one dataset per
  bucket: top 3 / 4–10 / 11–20 / 21–50) · line "Organic traffic over time"
- **Tables (2):** Top keywords — Keyword, Position, Previous, Change, Ranking URL ·
  Top pages by organic traffic — Page, Sessions, Change
- **metrics:** `keywords_top10`

Use the delta-cell object for the Change columns so arrows and colour render.

```json
{
  "summary": {
    "cards": [
      { "label": "Keywords ranking", "value": "412" },
      { "label": "Top 10", "value": "34" },
      { "label": "Avg. position", "value": "18.4" },
      { "label": "Organic sessions", "value": "2,880" }
    ],
    "metrics": { "keywords_top10": 34 }
  },
  "kpis": [
    { "label": "Keywords ranking", "value": "412", "delta": { "dir": "up", "text": "26 new" } },
    { "label": "Keywords in top 3", "value": "9", "delta": { "dir": "up", "text": "3" } },
    { "label": "Keywords in top 10", "value": "34", "delta": { "dir": "up", "text": "7" } },
    { "label": "Average position", "value": "18.4", "delta": { "dir": "up", "text": "2.1 better" } },
    { "label": "Organic traffic", "value": "2,880", "delta": { "dir": "up", "text": "19%" } },
    { "label": "Site health", "value": "92%", "delta": { "dir": "up", "text": "4 pts" } }
  ],
  "charts": [
    { "title": "Keyword position distribution over time", "type": "line",
      "labels": ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "Wk 5", "Wk 6"],
      "datasets": [
        { "label": "Top 3", "data": [4, 5, 6, 7, 8, 9], "color": "green" },
        { "label": "4–10", "data": [14, 17, 19, 21, 23, 25], "color": "blue" },
        { "label": "11–20", "data": [38, 41, 44, 46, 49, 52], "color": "blue2" },
        { "label": "21–50", "data": [120, 128, 133, 139, 144, 151], "color": "grey" }
      ] },
    { "title": "Organic traffic over time", "type": "line",
      "labels": ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "Wk 5", "Wk 6"],
      "datasets": [{ "label": "Sessions", "data": [1980, 2130, 2260, 2440, 2670, 2880], "color": "blue", "fill": true }] }
  ],
  "tables": [
    { "title": "Top keywords",
      "columns": [
        { "key": "keyword", "label": "Keyword" },
        { "key": "position", "label": "Position", "align": "num", "hot": true },
        { "key": "previous", "label": "Previous", "align": "num" },
        { "key": "change", "label": "Change", "align": "num" },
        { "key": "url", "label": "Ranking URL" }
      ],
      "rows": [
        { "keyword": "marketing agency barrie", "position": "3", "previous": "6",
          "change": { "text": "3", "dir": "up" }, "url": "/services/" }
      ] },
    { "title": "Top pages by organic traffic",
      "columns": [
        { "key": "page", "label": "Page" },
        { "key": "sessions", "label": "Sessions", "align": "num", "hot": true },
        { "key": "change", "label": "Change", "align": "num" }
      ],
      "rows": [
        { "page": "/", "sessions": "812", "change": { "text": "14%", "dir": "up" } }
      ] }
  ]
}
```

### 3.5 `organic` — Organic Social (Sprout Social)

- **KPI cards (6):** Views/impressions · Engagements · Engagement rate · Followers (net change in delta) · Posts published · Video views
- **Charts:** line "Impressions & engagements over time" · bar "Performance by platform"
  (Facebook / Instagram / TikTok / YouTube / LinkedIn)
- **Table:** Top posts — Post, Platform, Impressions, Engagements, Eng. rate
- **metrics:** `engagements`

```json
{
  "summary": {
    "cards": [
      { "label": "Impressions", "value": "184K" },
      { "label": "Engagements", "value": "12.4K" },
      { "label": "Eng. rate", "value": "6.7%" },
      { "label": "Followers", "value": "8,420" }
    ],
    "metrics": { "engagements": 12400 }
  },
  "kpis": [
    { "label": "Views / impressions", "value": "184K", "delta": { "dir": "up", "text": "23%" } },
    { "label": "Engagements", "value": "12,400", "delta": { "dir": "up", "text": "31%" } },
    { "label": "Engagement rate", "value": "6.7%", "delta": { "dir": "up", "text": "0.8%" } },
    { "label": "Followers", "value": "8,420", "delta": { "dir": "up", "text": "212 net" } },
    { "label": "Posts published", "value": "34", "delta": { "dir": "flat", "text": "same" } },
    { "label": "Video views", "value": "96,300", "delta": { "dir": "up", "text": "28%" } }
  ],
  "charts": [
    { "title": "Impressions & engagements over time", "type": "line",
      "labels": ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "Wk 5", "Wk 6"],
      "datasets": [
        { "label": "Impressions", "data": [21000, 24500, 27800, 31200, 36400, 43100], "color": "blue", "fill": true },
        { "label": "Engagements", "data": [1420, 1680, 1910, 2140, 2380, 2870], "color": "green" }
      ] },
    { "title": "Performance by platform", "type": "bar",
      "labels": ["Facebook", "Instagram", "TikTok", "YouTube", "LinkedIn"],
      "datasets": [{ "label": "Impressions", "data": [48200, 71400, 39800, 18600, 6300] }] }
  ],
  "tables": [
    { "title": "Top posts",
      "columns": [
        { "key": "post", "label": "Post" },
        { "key": "platform", "label": "Platform" },
        { "key": "impressions", "label": "Impressions", "align": "num" },
        { "key": "engagements", "label": "Engagements", "align": "num" },
        { "key": "rate", "label": "Eng. rate", "align": "num", "hot": true }
      ],
      "rows": [
        { "post": "Behind the scenes — shoot day", "platform": "Instagram",
          "impressions": "28,400", "engagements": "2,140", "rate": "7.5%" }
      ] }
  ]
}
```

---

## 4. Portal behaviour the automation should know

- **Sections gate visibility.** `public.clients.sections` (a text array) controls
  which channels appear in the sidebar and Overview. Valid entries: `meta`,
  `google_ads`, `gbp`, `seo`, `organic`. A report inserted for a platform not in
  `sections` is stored but not shown.
- **Latest period wins.** Each page opens on the newest `period_start` for that
  client. The period selector lists every period that has at least one report.
- **Missing report → empty state.** A section in `sections` with no row for the
  selected period shows "Your first report is being prepared." Never fake data.
- **Sample badge.** `is_sample = true` → a "Sample data" badge. `false` → the
  period dates are shown instead, plus "Last updated" from `refreshed_at`.
- **Overview is derived.** It is not a stored platform. It is computed in the
  browser from the `summary` blocks of whatever reports exist for the period, so
  the automation never writes an overview row.
- **Partial payloads are safe.** Missing `charts` or `tables` just render fewer
  panels. Missing `kpis` renders no stat row. Nothing throws.
