/**
 * seo-audit worker — the crawl behind /seo-audit/.
 *
 * A browser cannot fetch another origin's HTML; CORS forbids it, and the site
 * is static on GitHub Pages. So the crawl lives here, on the same Cloudflare
 * account as the Elite editor worker.
 *
 * POST /  {website, company, name, email, phone, is_owner}
 *   ->   {origin, crawled, capped, pages[], services[], areas[], footerNap}
 *
 * IT DOES NOT COMPUTE THE GRID OR THE SCORE. Both depend on which services and
 * which areas are real, and only the owner knows that -- the page asks them,
 * and recomputes in the browser from their answer. A grid computed here would
 * have to be thrown away the moment they corrected a service, and a second
 * round trip to recompute arithmetic is a round trip for nothing.
 *
 * ---------------------------------------------------------------------------
 * THE SUBREQUEST CEILING DECIDES THE PAGE CAP
 *
 * A Worker gets 50 subrequests per request on the free plan and 1000 on paid.
 * Every page fetched is one. So MAX_PAGES is 40 by default, which fits the free
 * plan with room for robots.txt and the sitemaps; the page's copy must agree
 * with whatever this is set to. Raising it to 300 REQUIRES the paid plan and is
 * one line, but say it out loud rather than letting a run truncate silently.
 *
 * ---------------------------------------------------------------------------
 * THE ELEVEN SLOTS ARE DEFINED TWICE AND THAT IS A KNOWN DEBT
 *
 * lib/keyword-placement.mjs in seo-system is the source of truth, read by the
 * blog gate and the on-page floor so a post and its page can never be held to
 * two ideas of what optimised means. A Worker cannot import from that repo, so
 * the slot list below is a RESTATEMENT. It will drift. The honest fix is to
 * generate this file's SLOTS from that module at deploy time; until then,
 * anybody changing one changes the other, and README.md says so.
 */

/* 20, measured, not chosen. The free plan allows 50 subrequests per
 * invocation and EVERY FETCH COSTS TWO, so the real ceiling is 25: on a live
 * run 22 pages succeeded, robots + sitemap + homepage made 25, and the next 18
 * threw "Too many subrequests". None of that reproduces in `wrangler dev
 * --local`, which has no ceiling at all.
 *
 * 20 leaves room for the three overhead fetches and a second sitemap. It is
 * also too few to see a whole grid -- DMT has 22 towns -- so `capped` is in the
 * response and the report must say so. A truncated crawl reports pages as never
 * built when we simply never looked, which is the one error that flatters us.
 *
 * Workers Paid raises the limit to 1000, i.e. ~500 pages. That is the fix. */
const MAX_PAGES = 20;          // see the subrequest ceiling above
const CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 6000;
const UA = 'NewLifeSEOAudit/1.0 (+https://newlifemarketing.ca/seo-audit/)';

const ALLOWED_ORIGINS = [
  'https://newlifemarketing.ca',
  'https://www.newlifemarketing.ca',
  'http://127.0.0.1:8812',
  'http://localhost:8812',
];

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': ok,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) },
});

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, origin);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Send JSON.' }, 400, origin); }

    let target;
    try { target = normaliseTarget(body.website); }
    catch (e) { return json({ error: e.message }, 400, origin); }

    /* Anyone can post any URL, so this is a crawler pointed at whatever the
     * internet asks it to crawl. Rate limiting belongs here before it is
     * public -- see README. Refusing our own site and obvious non-sites is the
     * floor, not the whole answer. */
    /* Our own site used to be refused here, and that was wrong twice over: it
     * is the one site we are plainly entitled to crawl, and it is the obvious
     * thing to type when checking whether the tool works at all. The refusal
     * was meant to stop the crawler being aimed at us, which is not something
     * we need protecting from -- the private-host and loopback refusals above
     * are the ones doing real work. */

    try {
      const result = await audit(target, env);

      const lead = {
        website: target.origin,
        company: String(body.company || '').slice(0, 200),
        name: String(body.name || '').slice(0, 200),
        email: String(body.email || '').slice(0, 200),
        phone: String(body.phone || '').slice(0, 60),
        is_owner: body.is_owner === 'yes' ? 'yes' : body.is_owner === 'no' ? 'no' : '',
        at: new Date().toISOString(),
        pages_crawled: result.crawled,
        pages_found: result.discovered,
        services: (result.services || []).map((x) => x.name).join(', '),
        areas: (result.areas || []).map((x) => x.name).join(', '),
        tag: 'seo audit',
      };

      // The lead is worth keeping whatever the crawl found.
      if (env && env.AUDIT_LEADS) {
        await env.AUDIT_LEADS.put(
          `${new Date().toISOString()}-${target.hostname}`,
          JSON.stringify(lead),
          { expirationTtl: 60 * 60 * 24 * 365 },
        ).catch(() => {});
      }

      /* THE CRM, AND IT MUST NOT BE ABLE TO BREAK THE REPORT.
       *
       * GHL_WEBHOOK is a secret -- `wrangler secret put GHL_WEBHOOK` -- never a
       * file in this repo. Where it is unset, the audit still runs and still
       * returns; the lead simply is not forwarded, and `lead_sent` says so.
       *
       * waitUntil, not await: the visitor asked for a report, not for our CRM
       * to be reachable. A slow or broken webhook must not hold their report
       * back or fail it, which is the same rule as the KV write above. */
      let leadSent = null;
      if (env && env.GHL_WEBHOOK) {
        leadSent = 'queued';
        const send = fetch(env.GHL_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(lead),
        }).catch(() => {});
        if (ctx && ctx.waitUntil) ctx.waitUntil(send); else await send;
      }

      return json({ ...result, lead_sent: leadSent }, 200, origin);
    } catch (e) {
      return json({ error: String(e && e.message || e).slice(0, 300) }, 502, origin);
    }
  },
};

// ------------------------------------------------------------------ input --
function normaliseTarget(raw) {
  let v = String(raw || '').trim();
  if (!v) throw new Error('No website given.');
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  let u;
  try { u = new URL(v); } catch { throw new Error('That does not look like a website address.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https.');
  if (!u.hostname.includes('.')) throw new Error('That does not look like a website address.');
  // No private hosts: a public endpoint that will fetch any URL must not be
  // usable to probe an internal network.
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(u.hostname)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)
      || u.hostname.endsWith('.local') || u.hostname.endsWith('.internal')) {
    throw new Error('That address is not reachable from here.');
  }
  return u;
}

let SUBREQ = 0;
async function get(url, accept) {
  SUBREQ++;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: accept || 'text/html,*/*' },
    });
    const text = res.ok ? await res.text() : '';
    return { ok: res.ok, status: res.status, url: res.url, text };
  } catch (e) {
    return { ok: false, status: 0, url, text: '', why: String(e && e.message || e).slice(0, 120) };
  } finally { clearTimeout(t); }
}

// ------------------------------------------------------------------ crawl --
async function audit(target, env) {
  SVC_DROPPED = [];
  BRAND_FROM_HOST = String(target.hostname).replace(/^www\./i, '').split('.')[0] || '';
  SUBREQ = 0;
  /* RESOLVE THE CANONICAL ORIGIN FIRST, AND SPEND ONE SUBREQUEST DOING IT.
   *
   * Measured on the first live run: a visitor types dmtbuilding.ca, every page
   * on that host 301s to www.dmtbuilding.ca, and a redirect is a SECOND
   * subrequest. 40 pages became 80 against the free plan's ceiling of 50, so
   * 17 of 40 fetches failed -- and the failures were silent, because failed
   * pages are dropped from the report. The areas went from 18 to 9 and the
   * report would have told a builder they had never built nine towns we simply
   * never looked at. A crawl that flatters us by losing pages is the worst
   * failure this tool has.
   *
   * Locally none of this showed: there is no subrequest ceiling in `wrangler
   * dev --local`. The ceiling only exists in production, which is the whole
   * reason "it works on my machine" is not a test of a Worker.
   *
   * So: follow the homepage once, adopt wherever it lands, crawl there. Every
   * later fetch then costs one subrequest instead of two, and the report names
   * the origin it actually audited rather than the one that was typed. */
  const first = await get(target.origin + '/');
  let origin = target.origin;
  if (first.ok && first.url) {
    try {
      const landed = new URL(first.url);
      if (sameSite(landed.href, target.origin) || landed.hostname.replace(/^www\./, '') === target.hostname.replace(/^www\./, '')) {
        origin = landed.origin;
      }
    } catch { /* keep what was typed */ }
  }

  let urls = await fromSitemaps(origin);
  let source = 'sitemap';

  if (urls.length < 2) {
    urls = await fromLinks(origin);
    source = 'links';
  }

  urls = dedupe(urls).filter((u) => sameSite(u, origin));

  /* PRIORITISE BEFORE CAPPING. A sitemap is usually alphabetical, so slicing
   * the first 40 spent them on /about/ and /blog/* and never reached
   * /services/* at all -- measured on a real builder's site, which returned
   * "Ajax Home Builders" as a service and no services whatsoever. The cap has
   * to take the pages that answer the question, not the pages that sort first. */
  const rank = (u) => {
    const seg = new URL(u).pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (seg.length === 0) return 0;                                    // home
    if (/^services?$/i.test(seg[0])) return seg.length > 1 ? 1 : 2;    // service pages
    if (AREA_WORDS.test(seg[0])) return seg.length > 1 ? 1 : 2;        // area pages
    if (/^(blog|news|article|articles|post|posts|tag|tags|category|categories|author)$/i.test(seg[0])) return 9;
    if (NOT_A_SERVICE.test(seg[0])) return 7;   // furniture and theme demos, last
    return 3 + Math.min(seg.length - 1, 3);                            // money-ish, shallow first
  };
  urls.sort((a, b) => rank(a) - rank(b) || a.length - b.length);

  /* How many pages the site HAS, kept before the slice. Without it the report
   * can say "we read 20" but not "of 41", and "20 of 41" is the difference
   * between a partial audit and one that looks complete. */
  const discovered = urls.length;
  const capped = urls.length > MAX_PAGES;
  /* EVERY URL THE SITE HAS, as paths, kept whole. Two different questions are
   * being answered here and only one of them is expensive:
   *
   *   does the page EXIST?   -> is it in this list. Free, complete, uncapped.
   *   is the page ANY GOOD?  -> needs the HTML. 20 pages, and that is the cap.
   *
   * Conflating them is what made the report dishonest. The grid was matched
   * against the 20 CRAWLED pages, so on a 145-page site a real page we simply
   * had not fetched came back as "missing" -- and "missing" is the word that
   * sells the service. Most of DMT's grid was being reported as unbuilt when
   * it was built and merely unread. */
  const sitemap = [...new Set(urls.map((u) => { try { return new URL(u).pathname; } catch { return null; } }).filter(Boolean))];
  urls = urls.slice(0, MAX_PAGES);
  // The home page is the one URL that must be in every crawl.
  const homeIn = urls.some((u) => { try { return new URL(u).pathname.replace(/\/+$/, '') === ''; } catch { return false; } });
  if (!homeIn) urls.unshift(origin + '/');

  /* The homepage HTML is kept, not just assessed. The nav is the one place a
   * site states which pages are services and which are areas in its owner's
   * own words, and a parsed page summary has thrown that away. */
  let homeHtml = first.ok ? first.text : '';
  let hubHtml = '';
  const pages = await mapLimit(urls, CONCURRENCY, async (u) => {
    // The homepage is already in hand from the origin resolution above. Fetching
    // it twice would spend a subrequest to learn nothing.
    if (path(u) === '/' && homeHtml) return assess('/', homeHtml);
    const res = await get(u);
    if (!res.ok || !res.text) return { url: path(u), status: res.status, error: true, why: res.why };
    if (path(u) === '/') homeHtml = res.text;
    if (HUB_PATH.test(path(u))) hubHtml = res.text;
    return assess(path(u), res.text);
  });

  const good = pages.filter((p) => !p.error);
  /* THE RULES PROPOSE, THE MODEL DISPOSES.
   *
   * Suppressing the URL passes whenever the model answered was an overcorrection
   * and it cost real data: DMT's 34 service-area pages -- 34 towns with 34 real
   * pages behind them -- collapsed to the two its homepage happens to name. A
   * URL is evidence. /home-additions-barrie/ existing IS a Barrie page, whether
   * or not a sentence anywhere says Barrie.
   *
   * The junk was never the URLs either; it was blog slugs read as towns, and
   * telling a place from a blog topic is a reading job. So the rules run first
   * and hand their candidates over, and the model keeps the real places, drops
   * "Mulch", and adds whatever the prose names that no URL did. */
  /* ASK THE PAGES WHAT THEY ARE. This is the primary path now; the name-to-slug
   * machinery below it is the fallback for when there is no model to ask. */
  const labels = await labelPages(env, good, sitemap, origin);
  const pre = detectGrid(good, homeHtml, sitemap, hubHtml, null);
  /* BOTH READS, AND THEY ANSWER DIFFERENT QUESTIONS.
   *
   * Labelling the pages says what EXISTS. It cannot say what is missing,
   * because a town with no page has no page to label -- and the towns with no
   * page are the entire product. The landscaper names Midhurst, Innisfil and
   * Wasaga on its home page and has a page for none of them, which is the
   * finding and was invisible to the labeller.
   *
   * So the page reader supplies the roster of places the business claims, and
   * the labeller supplies which of them have a page. */
  const read = await readWithModel(env, homeHtml, hubHtml, origin, pre.areas.map((a) => a.name), sitemap);
  const grid = labels ? gridFromLabels(labels) : detectGrid(good, homeHtml, sitemap, hubHtml, read, pre);

  if (labels && read) {
    const seen = new Set(grid.areas.map((a) => a.slug));
    const kc = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    /* THREE SOURCES OF TOWN, AND THE LABELLER IS THE NARROWEST.
     *
     * It only sees the ~90 urls that fit one answer, and only labels what it
     * can finish, so on a 145-page site DMT's towns fell from 36 to 18 when
     * labelling replaced the url passes. That is a regression and it is the
     * expensive direction: a town that is never listed cannot be reported as
     * missing, and the missing ones are the product.
     *
     * So all three go in: what the pages say they are, what the prose names,
     * and the url-derived candidates the model did not reject as non-places. */
    const add = (name, from) => {
      const k = kc(name);
      if (k && !seen.has(k) && grid.areas.length < 60) {
        seen.add(k);
        grid.areas.push({ slug: k, name, from, own: null });
      }
    };
    for (const name of read.areas) add(name, 'named on your site');
    for (const a of pre.areas) {
      if (!read.notPlaces || !read.notPlaces.has(String(a.name).toLowerCase())) add(a.name, a.from);
    }
  }
  return {
    origin,
    discovered_by: source,
    crawled: good.length,
    failed: pages.length - good.length,
    capped,
    cap: MAX_PAGES,
    discovered,
    sitemap,
    read_by: labels ? 'pages labelled by model' : read ? 'model, name matched' : 'markup rules',
    label_why: LABEL_WHY,
    /* WHY THE WEAK ANSWER, IN THE RESPONSE. Out of quota, the audit falls back
     * to the markup rules and quietly returns 3 services where there are 13.
     * A degraded run that looks like a normal one is the exact failure this
     * estate has a rule against -- silence is never green -- so the reason
     * travels with the report and the page says it on screen. */
    degraded: labels ? null : (LABEL_WHY || 'the reader was unavailable'),
    // Which page is which cell, read off the pages themselves.
    cells: grid.cells || null,
    /* The pages that could not be read, with their status. Silent drops are
     * what let 17 failed fetches read as "nine towns you never built". */
    subrequests: SUBREQ,
    unreadable: pages.filter((p) => p.error).map((p) => ({ url: p.url, status: p.status, why: p.why })),
    footer_nap: good.some((p) => p.footer_nap),
    nap: {
      name: good.some((p) => p.nap && p.nap.name),
      address: good.some((p) => p.nap && p.nap.address),
      phone: good.some((p) => p.nap && p.nap.phone),
    },
    services: grid.services,
    areas: grid.areas,
    pages: good,
  };
}

async function fromSitemaps(origin) {
  const robots = await get(origin + '/robots.txt', 'text/plain');
  let maps = [...String(robots.text).matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (!maps.length) maps = [origin + '/sitemap.xml', origin + '/sitemap_index.xml'];

  const out = [];
  const seen = new Set();
  // One level of sitemap-index recursion. Deeper is rare and every fetch is a
  // subrequest off the ceiling.
  for (const m of maps.slice(0, 3)) {
    if (seen.has(m)) continue;
    seen.add(m);
    const r = await get(m, 'application/xml,text/xml');
    if (!r.ok) continue;
    const locs = [...String(r.text).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((x) => x[1]);
    if (/<sitemapindex/i.test(r.text)) {
      for (const child of locs.slice(0, 3)) {
        if (seen.has(child)) continue;
        seen.add(child);
        const c = await get(child, 'application/xml,text/xml');
        if (!c.ok) continue;
        out.push(...[...String(c.text).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((x) => x[1]));
        if (out.length >= MAX_PAGES * 2) break;
      }
    } else {
      out.push(...locs);
    }
    if (out.length >= MAX_PAGES * 2) break;
  }
  return out;
}

async function fromLinks(origin) {
  const home = await get(origin + '/');
  if (!home.ok) throw new Error('Could not load that website.');
  const hrefs = [...String(home.text).matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const abs = [];
  for (const h of hrefs) {
    try { abs.push(new URL(h, origin).toString().split('#')[0]); } catch { /* skip */ }
  }
  return [origin + '/', ...abs];
}

const path = (u) => { try { const x = new URL(u); return x.pathname.replace(/\/?$/, '/') + x.search; } catch { return u; } };
const sameSite = (u, origin) => { try { return new URL(u).host.replace(/^www\./, '') === new URL(origin).host.replace(/^www\./, ''); } catch { return false; } };
/* `https://x.ca` and `https://x.ca/` are one page, and both were being
 * crawled -- the home page appeared twice in the first real run. */
const dedupe = (a) => {
  const seen = new Set(); const out = [];
  for (const u of a) {
    let k;
    try { const x = new URL(u); x.hash = ''; x.search = ''; x.pathname = x.pathname.replace(/\/+$/, '') || '/'; k = x.toString(); }
    catch { k = u; }
    if (seen.has(k)) continue;
    seen.add(k); out.push(k);
  }
  return out;
};

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  }));
  return out;
}

// ------------------------------------------------------------------ parse --
const strip = (h) => String(h)
  .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ');

/* Headings carry entities and the report prints them, so "A&amp;R Build
 * Process" shipped verbatim into the services column. Decode on the way out of
 * the HTML, once, rather than at every place that renders a name. */
const ENTS = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…' };
const decode = (t) => String(t)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => (ENTS[n.toLowerCase()] !== undefined ? ENTS[n.toLowerCase()] : m));

const tagText = (html, tag) => [...strip(html).matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))]
  .map((m) => decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
  .filter(Boolean);

const attr = (tagStr, name) => {
  const m = tagStr.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
};

const norm = (s) => String(s || '').toLowerCase().match(/[a-z0-9']+/g)?.join(' ') || '';

function assess(p, html) {
  const clean = strip(html);
  const title = (tagText(html, 'title')[0] || '').trim();
  const metaTag = clean.match(/<meta\b[^>]*name\s*=\s*["']description["'][^>]*>/i);
  const meta = metaTag ? (attr(metaTag[0], 'content') || '') : '';
  const h1 = tagText(html, 'h1');
  const h2 = tagText(html, 'h2');
  const h3 = tagText(html, 'h3');

  // Body text, with the chrome taken out as far as tags allow. Imperfect by
  // nature -- sites do not mark their furniture the same way -- so density is
  // reported rather than scored.
  const main = clean.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const bodySrc = main ? main[1] : clean.replace(/<(header|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  const body = bodySrc.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  const firstSentence = (body.split(/(?<=[.!?])\s+/)[0] || '').trim();

  const imgs = [...clean.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const alts = imgs.map((i) => attr(i, 'alt'));

  /* NO <footer> TAG IS NOT NO FOOTER. A landscaper's site scored 0/3 with its
   * phone number plainly on the page, because this read the <footer> ELEMENT
   * and that site is built out of divs. Every bug in this file has been the
   * same one: reading markup where a person reads content.
   *
   * A footer is the bottom of the page, whatever it is made of. Where the
   * element exists it is exact and is used; where it does not, the last stretch
   * of visible text is the footer, because that is where the contact block sits
   * on every site ever built. */
  const footerEl = (clean.match(/<footer\b[\s\S]*?<\/footer>/i) || [''])[0]
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const pageText = decode(clean.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  const footer = footerEl.trim().length > 40 ? footerEl : pageText.slice(-2200);
  const hasPhone = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(footer);
  const hasPostal = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i.test(footer)
    || /\b\d{1,6}\s+[A-Za-z][A-Za-z.\- ]{2,40}\s(st|street|rd|road|ave|avenue|dr|drive|blvd|way|hwy|highway|cres|crescent|lane|ln|court|ct)\b/i.test(footer);

  /* NAME, ADDRESS, PHONE: THREE FACTS, SCORED SEPARATELY. One boolean for all
   * three said "Yes" to a footer carrying a phone and no address, and "No" to
   * one missing only the business name -- and either way the owner cannot tell
   * from the report which of the three to go and fix. Google reads them
   * separately and so should this.
   *
   * The name is tried three ways, because a title tag is not a reliable place
   * to find one: the last clause ("Service | Brand"), the first ("Brand -
   * Service"), and the domain, which is the one spelling that always exists.
   * Compared with the punctuation and spaces taken out of both, so a footer
   * saying "MC Landscaping" matches mclandscaping.ca. */
  const squash = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const flatFooter = squash(footer);
  const brands = String(title).split(/[|–—·]/).map((x) => x.trim()).concat([BRAND_FROM_HOST]);
  const hasName = brands.some((b) => {
    const f = squash(b);
    return f.length > 3 && flatFooter.includes(f);
  });

  const faq = /<details\b/i.test(clean)
    || /"@type"\s*:\s*"FAQPage"/i.test(html)
    || /\b(frequently asked|faqs?)\b/i.test([...h2, ...h3].join(' '));

  const keyword = inferKeyword(p, title, h1[0]);
  const k = norm(keyword);
  const kIn = (s) => !!k && norm(s).includes(k);

  const slots = {
    title: kIn(title),
    slug: !!k && norm(p.replace(/[/-]/g, ' ')).includes(k),
    h1: h1.length === 1 && kIn(h1[0]),
    meta: !!meta && kIn(meta),
    first_sentence: kIn(firstSentence),
    h2: h2.some(kIn),
    h3: h3.length === 0 ? null : h3.some(kIn),
    image_alt: alts.some((a) => a && kIn(a)) && !alts.some((a) => a === ''),
    body: kIn(body),
    faq: faq,
    footer_nap: hasName && hasPhone && hasPostal,
  };
  const applicable = Object.values(slots).filter((v) => v !== null).length;
  const filled = Object.values(slots).filter((v) => v === true).length;

  const words = body ? body.split(/\s+/).length : 0;
  const occurrences = k ? (norm(body).match(new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g')) || []).length : 0;

  return {
    url: p,
    kind: classify(p, title, h1[0]),
    keyword,
    keyword_inferred: true,
    title, meta,
    h1_count: h1.length,
    h1_text: h1[0] || '',
    words,
    occurrences,
    slots, filled, applicable,
    footer_nap: slots.footer_nap,
    // The three parts on their own, so the report can say WHICH is missing.
    nap: { name: hasName, address: hasPostal, phone: hasPhone },
  };
}

/* The keyword is INFERRED: from the slug, then the title, then the h1. We do
 * not know what the page was aimed at. The registry calls this a
 * candidate_keyword and forbids using one as a target; it is used here only to
 * measure the page against what the page itself says it is about, and the page
 * says so on every panel. */
function inferKeyword(p, title, h1) {
  const fromSlug = p.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
  const slugWords = fromSlug.replace(/[-_]+/g, ' ').replace(/\.(html?|php|aspx?)$/i, '').trim();
  if (slugWords && slugWords.split(' ').length >= 2) return slugWords;
  const t = String(title).split(/[|–—·:]/)[0].trim();
  if (t && t.split(' ').length >= 2) return t.toLowerCase();
  if (h1 && String(h1).split(' ').length >= 2) return String(h1).toLowerCase();
  return slugWords || '';
}

/* BOILERPLATE IS NOT A SERVICE, and nothing stopped it being offered as one.
 * A real site came back with exactly one candidate service: "Block Content
 * Examples" -- a page the WordPress theme ships with. It is worse than finding
 * nothing. Finding nothing asks the owner what they sell; finding one wrong
 * thing asks them to confirm it, which is a question about our bug dressed up
 * as a question about their business.
 *
 * Two jobs, and the first is the one that was costing most: these pages sit at
 * the ROOT, so the crawl ranked them as money pages and spent the 20-page
 * budget on them ahead of real services. */
const NOT_A_SERVICE = new RegExp('^(' + [
  // what a theme ships with
  'block-content-examples?', 'sample-page', 'hello-world', 'elementor(-.*)?', 'typography',
  'shortcodes?', 'style-?guide', 'kitchen-sink', 'patterns?', 'blocks?', 'elements?', 'widgets?',
  'icons?', 'buttons?', 'demo(-.*)?', 'test(-page)?', 'lorem-ipsum', 'coming-soon', 'maintenance',
  // site furniture
  'about(-us)?', 'contact(-us)?', 'home(page)?', 'index', 'blog', 'news', 'articles?', 'posts?',
  'services?', 'our-services', 'what-we-do', 'service-areas?', 'areas-we-serve', 'locations?',
  'privacy-?(and|&)?-?terms', 'terms-?(and|&)?-?privacy', 'legal', 'policies', 'refund-policy',
  'privacy(-policy)?', 'terms(-of-service|-and-conditions)?', 'cookies?(-policy)?', 'disclaimer',
  'accessibility', 'sitemap', 'search', 'cart', 'checkout', 'my-account', 'account', 'login',
  'thank(s|-you)?', 'careers?', 'jobs?', 'faqs?', 'reviews?', 'testimonials?', 'gallery',
  'portfolio', 'projects?', 'our-work', 'book(-a-call)?', 'quote', 'request-a-quote', 'estimate',
  'financing', 'warranty', 'team', 'our-team', 'staff', 'process', 'how-we-build', 'packages?',
  'free-plans?', 'home-plans?', 'promotions?', 'pricing', 'subscribe', 'newsletter',
].join('|') + ')$', 'i');

const AREA_WORDS = /\b(service[- ]areas?|areas?[- ]served|locations?|where[- ]we[- ]work)\b/i;

function classify(p, title, h1) {
  const seg = p.replace(/\/+$/, '').split('/').filter(Boolean);
  if (seg.length === 0) return 'home';
  if (/^(blog|news|article|articles|post|posts)$/i.test(seg[0])) return 'content';
  if (/^(about|contact|privacy|terms|careers|sitemap|thank|thanks|404)/i.test(seg[0])) return 'no-keyword';
  if (AREA_WORDS.test(seg[0])) return seg.length > 1 ? 'area' : 'areas-hub';
  if (/^services?$/i.test(seg[0])) return seg.length > 1 ? 'service' : 'services-hub';
  // A slug carrying both a service word and a place word is a grid cell. We
  // cannot tell a place from a product without the owner, which is exactly why
  // the page asks them.
  return 'other';
}

/* ---------------------------------------------------------------- detect --
 * THE SLUG IS NOT THE SIGNAL, and a version of this that assumed it was got a
 * real builder's site wrong in both columns -- two grid cells reported as the
 * services, and no areas at all.
 *
 * Trades sites do not agree on a shape. All four of these are ordinary:
 *
 *   /services/attic-insulation/   a tree          -- certain
 *   /spray-foam-insulation/       flat, no tree   -- repeated head noun
 *   /ajax-home-builders/          a grid cell     -- factorises
 *   /barrie/                      a bare area     -- nothing to go on
 *
 * The last one is the point: in `/barrie/` there is no token that says
 * "place". No amount of slug reading settles it, because the information is
 * not in the slug. So detection reads FOUR signals, in order of how much each
 * one actually knows, and every candidate carries which one found it:
 *
 *   1. the /services/ or /service-areas/ tree      certain
 *   2. the site's own nav grouping                 strong -- the owner
 *                                                  grouped these themselves
 *   3. the slug factorisation across the crawl     good on grid sites
 *   4. a head noun repeated while modifiers vary   the flat-site fallback
 *
 * Names come from the site's own words -- nav anchor text, then the page's H1
 * -- never from titleising a slug, because "Ajax Home Builders" and
 * "ajax-home-builders" are the same mistake twice.
 *
 * None of it is presented as fact. The page asks the owner to confirm both
 * columns, and that is not a fallback for weak detection -- it is the only
 * thing that can be right, because which pages are services and which are
 * areas is a fact about the business, not about its URLs.
 */
const STOP_SLUG = new Set(['the', 'and', 'for', 'our', 'your', 'with', 'in', 'of', 'a', 'an', 'to',
  'services', 'service', 'company', 'companies', 'contractor', 'contractors', 'near', 'me',
  'best', 'top', 'local', 'pro', 'pros', 'ontario', 'canada', 'ca', 'on', 'index', 'home', 'page']);

/* NOT "our work" -- that is a portfolio, and reading it as a services menu
 * put six project case studies in the services column on a real site. */
/* TEST THE NAME, NOT JUST THE SLUG. The blocklist above only ever looked at
 * URLs, so "Privacy & Terms" was offered as a service because its slug was not
 * on the list -- and "Services", the hub page, because nothing said a hub is
 * not one of the things it lists. Both read as nonsense to anyone looking at
 * the screen, which is the test that was missing: the slug is what we parse,
 * the NAME is what a person sees, and only one of them was being checked. */
const NOT_A_SERVICE_NAME = new RegExp('^\s*(' + [
  'services?', 'our services', 'all services', 'what we do', 'service areas?', 'areas we serve',
  'privacy', 'privacy policy', 'terms', 'terms of service', 'terms (and|&) conditions',
  'privacy (and|&) terms', 'terms (and|&) privacy', 'legal', 'cookie policy', 'cookies',
  'disclaimer', 'accessibility', 'sitemap', 'site map', 'home', 'about', 'about us', 'contact',
  'contact us', 'blog', 'news', 'gallery', 'portfolio', 'projects', 'our work', 'reviews',
  'testimonials', 'careers', 'faqs?', 'book a call', 'get a quote', 'request a quote', 'financing',
  'login', 'client login', 'my account', 'cart', 'checkout', 'search',
].join('|') + ')\s*$', 'i');

const NAV_SERVICE_LABEL = /\b(services?|what\s+we\s+do)\b/i;
const NAV_AREA_LABEL = /\b(service\s*areas?|areas?\s*(we\s*)?(served?)?|locations?|where\s+we\s+(work|serve)|cities|towns)\b/i;

const slugOf = (u) => String(u).replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').filter(Boolean);
const lastSeg = (u) => (slugOf(u).pop() || '').replace(/\.(html?|php|aspx?)$/i, '');
const tokensOf = (u) => lastSeg(u).split(/[-_]+/).filter(Boolean);

/** A page's own name for itself: its H1, else the title's first clause. Falls
 *  back to the slug only when it has neither. */
function pageName(p) {
  if (!p) return '';
  const h1 = String(p.h1_text || '').trim();
  if (h1 && h1.length <= 60 && h1.split(' ').length <= 7) return h1;
  const t = String(p.title || '').split(/[|–—·:]/)[0].trim();
  if (t && t.length <= 60) return t;
  return titleise(lastSeg(p.url));
}

/* -- signal 2: the nav ----------------------------------------------------
 * A dropdown puts its label before its links in source order, near enough
 * always, so a label followed by a run of internal links IS the group. On a
 * flat site this is the strongest signal there is, for the reason that
 * matters: the owner put those pages under "Services" themselves. */
function navGroups(html) {
  const services = new Map();
  const areas = new Map();
  if (!html) return { services, areas };

  const chrome = [...strip(html).matchAll(/<(nav|header)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]).join('\n');
  if (!chrome) return { services, areas };

  const LINK = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const links = [...chrome.matchAll(LINK)].map((m) => ({
    at: m.index,
    href: m[1],
    text: decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
  }));

  const OTHER_TOP = /^(about|contact|blog|gallery|reviews|testimonials|careers|home|financing|faq|quote|estimate)/i;

  for (const label of links) {
    const isArea = NAV_AREA_LABEL.test(label.text);
    const isSvc = !isArea && NAV_SERVICE_LABEL.test(label.text);  // "service areas" is an area
    if (!isSvc && !isArea) continue;
    const bucket = isArea ? areas : services;
    /* A DROPDOWN'S ITEMS ARE SIBLINGS, and that is what ends the run. Without
     * it the Services run read straight on through the next menu and put six
     * project case studies in the services column -- they were simply the
     * links that came after. A change of parent path once the run has started
     * is the menu ending. */
    let parent = null;
    let taken = 0;
    for (const l of links) {
      if (l.at <= label.at) continue;
      if (OTHER_TOP.test(l.text)) break;
      if (NAV_SERVICE_LABEL.test(l.text) || NAV_AREA_LABEL.test(l.text)) break;
      if (taken >= 14) break;
      let seg;
      try { seg = slugOf(new URL(l.href, 'https://x.invalid').pathname); } catch { continue; }
      if (!seg.length) continue;
      const here = seg.slice(0, -1).join('/');
      if (parent === null) parent = here;
      else if (here !== parent) break;
      const key = seg[seg.length - 1];
      if (!key || key.length < 3) continue;
      if (l.text && l.text.length <= 48) { bucket.set(key, l.text); taken++; }
    }
  }
  return { services, areas };
}

const HUB_PATH = /^\/(services?|our-services|what-we-do|services-we-offer)\/?$/i;

/* ----------------------------------------------------------- labelling --
 * ASK WHAT EACH PAGE IS. DO NOT MATCH A NAME TO A SLUG.
 *
 * Everything before this tried to pair a service NAME with a URL and failed on
 * a real landscaper's site: the model read "Interlock Patios & Walkways" and
 * "Stone Steps" off the pages, both correct, and the pages are at
 * /interlock-service and /stone-staircases-service. Nothing that compares those
 * two strings finds the pair, and loosening the comparison enough to catch
 * "Stone Steps" also hands it /stone-work.
 *
 * The question was wrong. /stone-staircases-service is the Stone Steps page
 * because THAT PAGE SAYS SO -- its own title and H1 say so, and they were sitting
 * in the crawl the whole time, unread for this purpose. So each page is asked
 * what it is, once, and the grid is assembled from what the pages say about
 * themselves rather than from arithmetic over their spelling.
 *
 * This also gets the grid cells right for free. /custom-home-builder-barrie/ is
 * not "a service token plus a leftover"; it is a page that says it is custom
 * home building in Barrie, which is a thing to read, not to compute.
 */
function pageDigest(pages, paths) {
  const seen = new Set();
  const rows = [];
  for (const p of pages) {
    seen.add(p.url);
    const t = String(p.title || '').replace(/\s+/g, ' ').slice(0, 90);
    const h = String(p.h1_text || '').replace(/\s+/g, ' ').slice(0, 70);
    rows.push(p.url + ' | ' + t + (h && h !== t ? ' | ' + h : ''));
  }
  // Pages we never fetched still have a URL, and a URL is still evidence.
  for (const u of (paths || [])) {
    if (!seen.has(u) && rows.length < 90) rows.push(u + ' |');
  }
  return rows;
}

async function labelPages(env, pages, paths, origin) {
  if (!env || !env.AI) return null;
  const rows = pageDigest(pages, paths);
  if (rows.length < 2) return null;

  const prompt = [
    'You are reading the page list of a trades or home-service business.',
    'Each line is:  url | title | h1',
    '',
    'For every url, say what that page IS. Return ONLY JSON:',
    '{"pages":{"/url":{"service":"...","area":"..."}}}',
    '',
    'service: the service that page is about, in the words the business uses.',
    '  null if the page is not about a service.',
    'area: the town, city, county or region the page TARGETS. null if none.',
    '  Set it ONLY when the page is specifically for that place - the place is',
    '  normally in the title or the h1. Nearly every page of a local business',
    '  mentions its home town somewhere; that does NOT make it a page for that',
    '  town. A landscaper whose every page says "serving Barrie" still has one',
    '  interlock page, not an interlock-in-Barrie page, and calling it the',
    '  latter loses the service page entirely.',
    '',
    'So:',
    '  a page about one service, no place        -> service set, area null',
    '  a page about one place, no service        -> service null, area set',
    '  a page about one service in one place     -> both set',
    '  home, about, contact, blog, legal, faqs   -> both null',
    '  a hub listing all services or all areas   -> both null',
    '',
    'READ THE TITLE, NOT THE URL SPELLING. /stone-staircases-service titled',
    '"Stone Steps" is the Stone Steps page. Use the SAME wording for a service',
    'every time it appears, so pages about one service group together.',
    'Invent nothing: if a url is not in the list below, do not mention it.',
    '',
    'PAGES (' + origin + '):',
    rows.join('\n'),
  ].join('\n');

  let raw;
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
      temperature: 0,
    });
    const c = res && res.choices && res.choices[0];
    raw = [
      res, res && res.response, res && res.response && res.response.content,
      c && c.message && c.message.content, c && c.text, res && res.result,
    ].find((x) => typeof x === 'string' && x.trim()) || '';
  } catch (e) {
    LABEL_WHY = 'run threw: ' + String(e && e.message || e).slice(0, 120);
    return null;
  }

  /* Fences first, then a repair for the one failure a long list produces: the
   * answer runs out of tokens mid-object, which is valid JSON with the end
   * missing. Closing it keeps the pages it did label instead of throwing the
   * lot away and falling back -- measured, a six-page site hit this. */
  let body = String(raw).replace(/^[\s\S]*?```(?:json)?/i, '').replace(/```[\s\S]*$/, '');
  const open = body.indexOf('{');
  if (open === -1) { LABEL_WHY = 'no json'; return null; }
  body = body.slice(open);
  let parsed = null;
  for (let cut = body.length; cut > 40 && !parsed; cut = body.lastIndexOf('}', cut - 1)) {
    const attempt = body.slice(0, cut + 1);
    const depth = (attempt.match(/\{/g) || []).length - (attempt.match(/\}/g) || []).length;
    try { parsed = JSON.parse(attempt + '}'.repeat(Math.max(0, depth))); } catch { /* try shorter */ }
  }
  if (!parsed) { LABEL_WHY = 'bad json: ' + body.slice(0, 120); return null; }
  if (!parsed.pages || typeof parsed.pages !== 'object') { LABEL_WHY = 'no pages key'; return null; }

  const known = new Set(rows.map((r) => r.split(' |')[0]));
  const tidy = (v) => {
    if (typeof v !== 'string') return null;
    const t = v.replace(/\s+/g, ' ').trim();
    if (!t || t.length > 48 || t.split(' ').length > 6) return null;
    if (/^(null|none|n\/a|-)$/i.test(t)) return null;
    if (NOT_A_SERVICE_NAME.test(t)) return null;
    return t;
  };

  /* THE PLACE HAS TO BE ON THE PAGE. Told plainly that a page merely mentioning
   * the home town is not a page for that town, the model still labelled a
   * landscaper's /interlock-service with "Barrie & Simcoe County" -- every page
   * on that site says it, so it read as targeting it. The service page was then
   * a grid cell and the service had no page of its own, which is the exact
   * complaint: three pages that exist, reported as missing.
   *
   * Instruction is not enforcement. A page that TARGETS a place says so where
   * targeting lives -- the url, the title or the h1 -- so that is checked here
   * rather than asked for. */
  const said = new Map();
  for (const pg of pages) said.set(pg.url, (pg.url + ' ' + (pg.title || '') + ' ' + (pg.h1_text || '')).toLowerCase());
  const targets = (url, area) => {
    const hay = said.get(url) || url.toLowerCase();
    const words = String(area).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (!words.length) return false;
    return words.some((w) => hay.includes(w));
  };

  const labels = new Map();
  for (const [url, v] of Object.entries(parsed.pages)) {
    const u = String(url).replace(/^https?:\/\/[^/]+/, '') || '/';
    /* A url the crawl never saw is one the model invented, and an invented url
     * becomes a page reported as built. That is the one direction of error this
     * report may never make, so unknown urls are dropped without apology. */
    if (!known.has(u)) continue;
    if (!v || typeof v !== 'object') continue;
    const service = tidy(v.service);
    let area = tidy(v.area);
    if (area && !targets(u, area)) area = null;
    if (!service && !area) continue;
    labels.set(u, { service, area });
  }
  if (!labels.size) { LABEL_WHY = 'nothing labelled'; return null; }
  LABEL_WHY = 'ok';
  return labels;
}

/** Services, areas and cells, taken from what the pages said they were.
 *  One spelling per service: the first one seen wins, and the rest fold into
 *  it, because "Stone Steps" and "Stone steps" are one row of the grid. */
function gridFromLabels(labels) {
  const services = new Map();
  const areas = new Map();
  const cells = [];

  /* ONE SERVICE, ONE SPELLING. Asked to keep its wording consistent the model
   * still returned "Home Addition", "Home Additions" and "House Addition" as
   * three services off one site's grid pages. Singular and plural are the same
   * word, so names whose stemmed words match are one service and the first
   * spelling seen wins. "House" and "home" are genuinely different words and
   * are left alone -- the owner can untick one. */
  const stemKey = (n) => String(n).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .sort().join('-');
  const canon = new Map();
  const key = (n) => {
    const sk = stemKey(n);
    if (!canon.has(sk)) canon.set(sk, String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
    return canon.get(sk);
  };

  /* ONE AREA ON EVERY PAGE IS THE HOME TERRITORY, NOT A GRID AXIS.
   *
   * A landscaper's pages are titled "Interlock Patios, Walkways & Driveways in
   * Barrie & Simcoe County" and "Stone Steps & Staircases in Barrie & Simcoe
   * County". The model was right to call those Barrie pages -- they say so --
   * but taking that as a grid dimension made a 3x1 grid of cells and left the
   * service-page column empty, so three pages that plainly exist were reported
   * as missing. That was the complaint, and the model was not the one wrong.
   *
   * A business says where it works. Saying it on every service page makes it
   * their territory, not a targeting choice, and their interlock page is the
   * interlock page. A town is a grid axis when SOME pages carry it and others
   * do not -- that is what makes it a dimension rather than a letterhead. */
  const svcPages = [...labels.values()].filter((l) => l.service).length;
  const areaTally = new Map();
  for (const l of labels.values()) if (l.service && l.area) areaTally.set(l.area, (areaTally.get(l.area) || 0) + 1);
  let home = null;
  for (const [a, n] of areaTally) {
    if (areaTally.size === 1 && svcPages > 1 && n >= svcPages * 0.6) home = a;
  }

  for (const [url, raw] of labels) {
    // The home territory is dropped from the page's label, so a service page
    // that names it is the service's own page rather than a cell.
    const l = (home && raw.area === home) ? { service: raw.service, area: null } : raw;
    if (l.service) {
      const k = key(l.service);
      if (!services.has(k)) services.set(k, { slug: k, name: l.service, from: 'read off your pages', own: null });
      if (!l.area && !services.get(k).own) services.get(k).own = url;
    }
    if (l.area) {
      const k = key(l.area);
      if (!areas.has(k)) areas.set(k, { slug: k, name: l.area, from: 'read off your pages', own: null });
      if (!l.service && !areas.get(k).own) areas.get(k).own = url;
    }
    if (l.service && l.area) cells.push({ service: key(l.service), area: key(l.area), url });
  }

  return {
    services: [...services.values()].slice(0, 24),
    areas: [...areas.values()].slice(0, 60),
    cells,
    home,
  };
}

let LABEL_WHY = '';
let SVC_DROPPED = [];

/* The domain's own label, e.g. mclandscaping.ca -> "mclandscaping". The one
 * spelling of a business name that is guaranteed to exist, and the fallback
 * when a title tag does not carry it. Set per audit. */
let BRAND_FROM_HOST = '';

/* ---------------------------------------------------------------- read --
 * A MODEL READS THE PAGE. Everything below it is a fallback.
 *
 * Four rounds of this were fixed by hand and each one failed the same way: a
 * business's services and towns were plainly on screen and the parser could not
 * see them, because every rule here was written about MARKUP. The services were
 * in <strong> and the rule looked at <h2>. The towns were in the first sentence
 * of the hero -- "Locally Serving Collingwood, Blue Mountain, Creemore, Stayner,
 * Mansfield" -- and the rule only ever looked at URL slugs. There was no rule
 * for prose at all, so no site that writes its coverage as a sentence, which is
 * most of them, could ever be read.
 *
 * Widening the rules cannot fix that. The next site puts it in a <span>, or an
 * image caption, or a line of italics under the phone number. The thing being
 * asked for -- "what does this business sell and where" -- is a reading
 * comprehension question, and it should be answered by something that reads.
 *
 * So: the page text goes to a model, and the markup rules stay as the backstop
 * for when the model is unavailable, over quota, or returns nothing usable.
 * They are not deleted, because an audit that fails when a binding is missing
 * is worse than one that falls back to being a bit thick.
 *
 * THE MODEL IS NOT TRUSTED, IT IS ASKED. What it returns is a candidate list
 * shown to the owner for confirmation, exactly like every other signal here --
 * which is the same reason it is safe to let it read a stranger's website at
 * all: nothing it says reaches the report without a human ticking it.
 */
/* Named exactly, and checked against the catalogue: llama-3.1-8b-instruct was
 * deprecated on 2026-05-30 and the first deploy failed silently against it --
 * silently, because readWithModel swallows its own errors so a dead model
 * cannot take the audit down. That is right, and it is why the reason is
 * reported in the response: a fallback nobody can see runs for months. */
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** Visible text, collapsed, with the furniture left in -- a nav tells a reader
 *  what a business does too, and the model can tell a menu from a service. */
function visibleText(html, max) {
  if (!html) return '';
  return decode(strip(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 4000);
}

async function readWithModel(env, homeHtml, hubHtml, origin, candidateAreas, paths) {
  if (!env || !env.AI) return null;

  const text = [
    'HOME PAGE:\n' + visibleText(homeHtml, 14000),
    hubHtml ? '\nSERVICES PAGE:\n' + visibleText(hubHtml, 6000) : '',
  ].join('\n');
  if (text.replace(/\s/g, '').length < 200) return null;

  const prompt = [
    'You are reading the website of a trades or home-service business.',
    /* ASK FOR THE REJECTS, NOT THE LIST.
     *
     * Asking it to echo back every real place cost DMT 24 of its 34 towns: 34
     * names plus the services does not fit a sane token budget, and a model
     * asked for a long list it cannot finish returns a short one instead. The
     * answer looked clean and was quietly two-thirds short, which is the worst
     * shape of wrong this tool can produce.
     *
     * The rejects are the short list. "Mulch, Fertilizer, Watering Tips" is
     * three names where the keepers are thirty, so asking which ones are NOT
     * places is both the cheaper question and the one it can finish. Candidates
     * are then kept unless named, which also means a truncated answer loses
     * nothing: it keeps too much, and the owner unticks. */
    'Return ONLY a JSON object, no prose, in exactly this shape:',
    '{"services":["..."],"areas":["..."],"not_places":["..."],"service_pages":{}}',
    '',
    'services: the things this business is hired to do, in their own words.',
    '  Not "Services", not "About", not "Contact", not "Privacy" - those are',
    '  pages, not services. Not slogans. Usually between 3 and 10 of them.',
    'areas: the towns, cities, counties or regions it serves, as the TEXT says',
    '  them. Often one sentence or paragraph, e.g. "proudly serving X, Y and Z",',
    '  and often near the bottom of the page. Place names only - drop "and',
    '  surrounding area" and "and more".',
    (candidateAreas && candidateAreas.length
      ? 'not_places: the list below was taken from this site\'s own page URLs,'
        + ' and most of them are towns. Return ONLY the entries that are NOT'
        + ' real places - products, materials, blog topics, fragments of a'
        + ' sentence. A place is somewhere a person could live and that you'
        + ' could put on a map. "Mulch", "Fertilizer", "Watering Tips" and'
        + ' "What Clippings" are not places. Do not repeat the good ones. If'
        + ' they are all places, return []. The list: ' + candidateAreas.join(', ')
      : 'not_places: return [].'),
    'Use [] for any of the three if the page genuinely does not say.',
    '',
    /* ASK WHICH PAGE EACH SERVICE IS, BECAUSE THE NAME IS NOT THE URL.
     *
     * A landscaper's site: the model named "Interlock Patios & Walkways" and
     * "Stone Steps" off the page, correctly, and the pages are at
     * /interlock-service and /stone-staircases-service. Matching the name's
     * words against the URL's words finds neither, so three pages that exist
     * were reported as never built -- the single worst thing this tool can say.
     *
     * No amount of fuzzier matching fixes that: "Stone Steps" against
     * /stone-staircases-service and /stone-work is a judgement, and loosening
     * the match enough to catch one catches the other too. Which page is which
     * is a reading question, and the model is already reading. It just has
     * never been shown the URLs. */
    (paths && paths.length
      ? 'service_pages: these are this site\'s page URLs. For each service you'
        + ' listed, give the ONE url that is that service\'s own page, or null if'
        + ' it has none. Match on meaning, not spelling: a service called'
        + ' "Interlock Patios & Walkways" may live at /interlock-service. Shape:'
        + ' {"service_pages":{"Service Name":"/its-url"}}. The urls:\n'
        + paths.slice(0, 80).join('\n')
      : ''),
    '',
    'WEBSITE (' + origin + '):',
    text,
  ].join('\n');

  let raw;
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 700,
      temperature: 0,
    });
    /* THE SHAPE IS NOT PROMISED, SO TAKE THE FIRST CANDIDATE THAT IS A STRING.
     * Guessed wrong three times running, each one deployed before being looked
     * at: `response` on the deprecated model, then OpenAI's
     * choices[0].message.content, then `response` again -- which on this model
     * EXISTS and is an OBJECT, so a `||` chain took it and stringified it to
     * the literal "[object Object]", 15 characters, no JSON in it. The model
     * had answered correctly every single time.
     *
     * A truthiness test cannot tell a string from an object. A type check can,
     * and it keeps working when the next model answers in a third shape. */
    const c = res && res.choices && res.choices[0];
    raw = [
      res,
      res && res.response,
      res && res.response && res.response.content,
      c && c.message && c.message.content,
      c && c.text,
      res && res.result,
      res && res.result && res.result.response,
    ].find((x) => typeof x === 'string' && x.trim()) || '';
  } catch {
    return null;   // over quota, not enabled, model gone: fall back, never fail
  }

  // The model is told to return only JSON and sometimes wraps it anyway.
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return null; }

  const clean = (arr) => (Array.isArray(arr) ? arr : [])
    .map((x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim())
    .filter((x) => x && x.length <= 48 && x.split(' ').length <= 6 && /[a-z]/i.test(x))
    .filter((x) => !NOT_A_SERVICE_NAME.test(x))
    .slice(0, 24);

  /* The name -> url mapping, kept only where the url is one we actually saw.
   * A model naming a page that does not exist would otherwise invent a built
   * page, which is the one direction of error this report must never make. */
  const known = new Set(paths || []);
  const pageFor = new Map();
  if (parsed.service_pages && typeof parsed.service_pages === 'object') {
    for (const [name, url] of Object.entries(parsed.service_pages)) {
      if (typeof url !== 'string') continue;
      const u = url.replace(/^https?:\/\/[^/]+/, '') || '/';
      if (known.has(u) || known.has(u.replace(/\/+$/, ''))) pageFor.set(String(name).trim(), known.has(u) ? u : u.replace(/\/+$/, ''));
    }
  }

  const services = clean(parsed.services);

  /* WHAT THE MODEL LEFT UNMAPPED, MATCHED BY OVERLAP. It mapped "Interlock
   * Patios & Walkways" to /interlock-service and left "Stone Steps" unmapped,
   * though /stone-staircases-service was sitting in the list. Asking again is
   * not the answer; the pairing is now a small assignment problem with a
   * correct greedy solution.
   *
   * Every service-url pair that shares a real word is scored, the strongest
   * pairing is taken first, and both sides are then spent -- so "Stone Steps"
   * takes /stone-staircases-service and "Stone Work", sharing only the word
   * already spent, correctly gets nothing. One page, one service. */
  {
    const tk = (x) => String(x).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
      .filter((w) => w.length > 2 && !['and', 'the', 'our', 'service', 'services', 'page'].includes(w))
      .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));

    const taken = new Set(pageFor.values());
    const pairs = [];
    for (const name of services) {
      if (pageFor.has(name)) continue;
      const want = tk(name);
      if (!want.length) continue;
      for (const u of (paths || [])) {
        if (taken.has(u)) continue;
        const have = tk(u);
        const shared = want.filter((w) => have.includes(w)).length;
        if (shared) pairs.push({ name, u, score: shared / Math.max(want.length, have.length) });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    const spentName = new Set();
    for (const pr of pairs) {
      if (spentName.has(pr.name) || taken.has(pr.u)) continue;
      pageFor.set(pr.name, pr.u);
      spentName.add(pr.name);
      taken.add(pr.u);
    }
  }
  const areas = clean(parsed.areas);
  const notPlaces = new Set(clean(parsed.not_places).map((x) => x.toLowerCase()));
  if (!services.length && !areas.length && !notPlaces.size && !pageFor.size) return null;
  return { services, areas, notPlaces, pageFor };
}

/** A name with no URL behind it still needs a key, and the key is what the grid
 *  matches against the sitemap. Derived from the name, so a service that has no
 *  page simply matches nothing -- which is the finding, not an error. */
const keyOf = (name) => String(name).toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

/* -- signal 2: READ THE PAGE THE WAY A PERSON READS IT ----------------------
 * Three times now a site came back with no services while anyone opening it
 * could name them instantly. Reproduced on a real one, and the services were
 * sitting in plain sight:
 *
 *     /services/   <strong>Lot Clearing</strong> then a sentence about it
 *     /            <li class="has-large-font-size">Lot Clearing</li>
 *
 * Tree Removal & Pruning, Lot Clearing, Wood Chips, Firewood Delivery -- four
 * services, no <h2>, no <a>, nothing to click. Every reader in here looked only
 * at headings and links, so it found nothing and said so, on a page whose whole
 * purpose is to list what the business sells.
 *
 * A PERSON DOES NOT READ TAGS. They read short bold phrases followed by a
 * sentence, and bulleted lists. So this takes candidates from all four shapes
 * -- links, headings, bold runs and list items -- in that order, because that
 * is the order of how much each one usually means. Anything 1-5 words that is
 * not furniture is a candidate, and candidates are confirmed by the owner.
 *
 * A candidate with no URL still counts. A business that sells four services off
 * one page HAS four services and nought pages for them, and that is the finding
 * -- reporting "no services" instead both insults them and buries the thing we
 * are there to sell.
 */
/* A SERVICE IS A THING YOU BUY. A SLOGAN IS A THING YOU READ.
 *
 * Reading a flat site's home page for services returned, alongside four real
 * ones, "What We Build", "Competitive Pricing, Clearly Quoted", "Dates You Can
 * Plan Around", "Designed Around Your Property", "Our Work Is Guaranteed",
 * "Owner-Operated", an email address and the web designer's domain. Every one
 * came from a <strong> or an <li>, exactly like the real ones.
 *
 * What separates them is not markup, it is grammar: a slogan speaks TO the
 * reader and about the firm. "Interlock" and "Armourstone" name a thing you
 * can buy and contain none of these words. The address and the domain give
 * themselves away with an @ or a TLD. */
const SLOGAN_WORDS = new Set(['you', 'your', 'yours', 'we', 'our', 'ours', 'us', 'why', 'how',
  'what', 'when', 'where', 'guaranteed', 'guarantee', 'pricing', 'priced', 'quoted', 'quote',
  'owned', 'operated', 'trusted', 'affordable', 'quality', 'best', 'cheap', 'fast', 'reliable',
  'professional', 'experienced', 'insured', 'licensed', 'satisfaction', 'promise', 'difference']);
/* Written WITHOUT a word-boundary escape on purpose. Twice now a word-boundary escape written
 * through a shell heredoc has arrived here as a literal backspace (0x08),
 * making a regex that can never match and a filter that silently does
 * nothing -- which is how "heavyads.ca" survived three deploys in a list of
 * services while the rule looked right in the source. A character class
 * cannot be mangled that way. check-no-control-chars.mjs exists for this. */
const LOOKS_LIKE_CONTACT = /(@|[a-z0-9-]+[.](ca|com|net|org|co|io)([^a-z]|$))/i;

/* Not services either, all from one real home page: "46 Five-Star Reviews",
 * "Direct Contact", "Services Interlock". Proof, a contact heading, and a
 * menu label with its parent still attached. None of them a thing to buy. */
const NOT_A_SERVICE_SHAPE = /^[ ]*(services?|our services)[ ]+[^ ]|^[ ]*[0-9]|reviews?([^a-z]|$)|direct contact|five[- ]star/i;
/* Cloudflare rewrites addresses to the literal text "[email protected]", which
 * carries no @ for the rule above to catch, and it reached the services list. */
const OBFUSCATED_EMAIL = /\[email[^\]]*protected\]|email[ ]protected/i;

const NOT_A_LABEL = /^(read|learn|see|view|more|details?|get|book|call|contact|back|next|prev(ious)?|home|menu|skip|close|toggle|submit|send|click)\b/i;

function contentServices(html, scope) {
  const out = new Map();
  if (!html) return out;

  let clean = strip(html).replace(/<(header|nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = clean.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  let body = main ? main[1] : clean;

  /* `scope` narrows to a services section on a page that is not itself the
   * services page -- a homepage's "What we do" block. Without it the whole
   * homepage is fair game, which is right only as a last resort. */
  if (scope) {
    const heads = [...body.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({
      at: m.index, lvl: Number(m[1]),
      text: decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
    }));
    const a = heads.find((h) => /\b(our\s+)?services\b|what\s+we\s+(do|offer)|how\s+we\s+help|our\s+expertise/i.test(h.text));
    if (!a) return out;
    const n = heads.find((h) => h.at > a.at && h.lvl <= a.lvl);
    body = body.slice(a.at, n ? n.at : Math.min(body.length, a.at + 14000));
  }

  const take = (raw, href) => {
    const text = decode(String(raw).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 48) return;
    if (text.split(' ').length > 5) return;
    if (NOT_A_LABEL.test(text) || NOT_A_SERVICE_NAME.test(text)) return;
    if (LOOKS_LIKE_CONTACT.test(text) || NOT_A_SERVICE_SHAPE.test(text) || OBFUSCATED_EMAIL.test(text)) return;
    if (text.toLowerCase().split(/[^a-z]+/).some((w) => SLOGAN_WORDS.has(w))) return;
    if (!/[a-z]/i.test(text)) return;

    let slug = null;
    if (href && !/^(tel:|mailto:|javascript:|#)/i.test(href)) {
      try {
        const seg = slugOf(new URL(href, 'https://x.invalid').pathname);
        if (seg.length) slug = seg[seg.length - 1];
      } catch { /* fall through to the name */ }
    }
    // No URL is not a disqualification. A service listed on one page is still a
    // service; it simply has no page, which is the point of the report.
    if (!slug) {
      slug = text.toLowerCase().replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }
    if (!slug || slug.length < 3 || NOT_A_SERVICE.test(slug)) return;
    if (!out.has(slug) && out.size < 16) out.set(slug, text);
  };

  for (const m of body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) take(m[2], m[1]);
  for (const m of body.matchAll(/<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) take(m[2]);
  for (const m of body.matchAll(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi)) take(m[2]);
  for (const m of body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) take(m[1]);
  return out;
}

/* -- signals 3 and 4: what the flat slugs can and cannot say ---------------
 * Measured on a real builder's site, and the slugs look like this:
 *
 *   /ajax-home-builders/          service LAST
 *   /home-additions-barrie/       service FIRST
 *   /home-addition-aurora/        and singular
 *   /custom-home-builder-angus/   and a different service word
 *   /commercial-contractors-ajax/ and another
 *
 * Same business, same grid, four slug shapes and no fixed position. So nothing
 * that keys off "the first segment" or "the last token" can work, and the
 * earlier version of this that tried both got "Ajax" and "Builders" back as
 * services.
 *
 * What DOES separate the two axes is how often a thing recurs. A trades site
 * sells a handful of services into a lot of towns, so across the flat slugs:
 *
 *   home addition(s)   18 slugs      <- the service
 *   custom home builder 5 slugs      <- the service
 *   barrie              2 slugs      <- the town
 *   angus               1 slug       <- the town
 *
 * A gram recurring 4+ times is a service family. What is left of a slug once
 * its family is removed is the area. That is the whole method, and it survives
 * the position and the plural because it never looks at either.
 *
 * SINGULAR AND PLURAL ARE ONE THING. Counted apart, "home addition" (6) and
 * "home additions" (12) each look minor and the single word "builder" wins on
 * count instead -- which is how a page of real services became "Builders".
 */
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const stemsOf = (u) => tokensOf(u).map(stem);

/** Token runs recurring across 4+ of the flat slugs: the service families, and
 *  the thing an area has to have stripped off it. */
function recurringGrams(urls) {
  const freq = new Map();
  for (const u of urls) {
    const t = stemsOf(u);
    const seen = new Set();
    for (let n = Math.min(4, t.length); n >= 1; n--) {
      for (let i = 0; i + n <= t.length; i++) {
        const g = t.slice(i, i + n).join(' ');
        if (g.length < 4) continue;
        if (g.split(' ').every((w) => STOP_SLUG.has(w))) continue;
        if (!seen.has(g)) { seen.add(g); freq.set(g, (freq.get(g) || 0) + 1); }
      }
    }
  }
  /* 4, not 3. At 3 a town that happens to sit in three cells -- Ajax did --
   * reads as a service, and an area reported as a service is the one error the
   * owner is least likely to catch, because it is a real page with a real name. */
  return [...freq.entries()]
    .filter(([, n]) => n >= 4)
    .sort((a, b) => (b[1] - a[1]) || (b[0].split(' ').length - a[0].split(' ').length))
    .map(([g, n]) => ({ gram: g, slugs: n }));
}

/** The best-named member of a family: the longest gram that still covers most
 *  of it, so "home builder" is preferred to the bare "builder" it contains. */
function pickFamilyNames(grams) {
  const out = [];
  for (const { gram, slugs } of grams) {
    const covered = out.find((o) => o.gram.includes(gram) || gram.includes(o.gram));
    if (!covered) { out.push({ gram, slugs }); continue; }
    // A longer gram replaces a shorter one when it still accounts for most of it.
    if (gram.length > covered.gram.length && slugs >= covered.slugs * 0.6) {
      covered.gram = gram; covered.slugs = slugs;
    }
  }
  return out;
}

/** What is left of each slug once the service is taken off it.
 *
 * STRIPPING FAMILY GRAMS DOES NOT SURVIVE A REAL SITEMAP. On 20 crawled URLs it
 * worked; over all 145 it produced "Construction Barrie", "Builder Toronto",
 * "Custom Barrie", "House Addition" and "Builder" as service AREAS, because
 * with more URLs there are more families, a slug contains several, and removing
 * only the busiest leaves the others sitting in the answer.
 *
 * So no stripping. Each TOKEN is placed by how many slugs it appears in, within
 * its own slug:
 *
 *   home-additions-barrie     home 30, addition 25, barrie 5   -> Barrie
 *   construction-barrie       construction 10, barrie 5        -> Barrie
 *   angus-custom-home-builder angus 1, custom 15, builder 20    -> Angus
 *
 * A trade sells a few services into many towns, so the service tokens are the
 * frequent ones in every slug they appear in and the town is the rare one. The
 * comparison is WITHIN the slug, which is what makes it hold: "construction"
 * beats "barrie" there while being nowhere near as frequent as "home", and no
 * global threshold could have separated both cases at once.
 *
 * THE NAME COMES FROM THE ORIGINAL TOKENS, NEVER THE STEMS. Matching stems
 * singular and plural together -- that is the only reason it exists -- and a
 * stem reaching the screen printed Angus as "Angu".
 */
/* THE FREE PATH READS THE ONE SENTENCE THAT NAMES THE TOWNS.
 *
 * Without a model, a flat site returned no areas at all -- yet its footer says
 * "Interlock and natural stone for homes and commercial properties across
 * Barrie, Midhurst and Simcoe County", and its heading says "Service Areas
 * Barrie Midhurst Innisfil Wasaga Simcoe County". Every town is on the page in
 * plain sight; nothing deterministic was looking at prose.
 *
 * This is a narrow rule for a phrasing the trade uses constantly: a cue word,
 * then a run of capitalised names. It will not read every site. It reads the
 * common case, for nothing, with no model, and a wrong one is a chip to untick. */
const NOT_A_PLACE_WORD = new Set(['before', 'after', 'many', 'more', 'most', 'now', 'today',
  'all', 'every', 'each', 'new', 'other', 'others', 'both', 'some', 'any', 'this', 'that',
  'these', 'those', 'here', 'there', 'homes', 'home', 'property', 'properties', 'project',
  'projects', 'commercial', 'residential', 'areas', 'area', 'region', 'regions', 'and']);

const AREA_CUE = /(serving|service areas?|areas? we serve|areas? served|proudly serve[sd]?|work(?:ing)? (?:in|throughout)|across|around)(?![a-z])/i;

function areasFromProse(text) {
  const out = new Map();
  if (!text) return out;
  const hay = String(text).replace(/\s+/g, ' ');
  let m;
  const cue = new RegExp(AREA_CUE.source, 'gi');
  while ((m = cue.exec(hay)) !== null) {
    // The run that follows the cue, stopping at a full stop or a cue for
    // something else. 160 characters is about as long as such a list gets.
    const after = hay.slice(m.index + m[0].length, m.index + m[0].length + 160).split(/[.!?|]/)[0];
    const names = after.match(/[A-Z][a-z]+(?:[ -][A-Z][a-z]+){0,2}/g) || [];
    for (const n of names) {
      const t = n.trim();
      if (t.length < 3 || t.split(' ').length > 3) continue;
      if (NOT_A_SERVICE_NAME.test(t)) continue;
      /* A capitalised word after "across" is not automatically a town. One
       * real footer gave Barrie, Midhurst and Simcoe County -- correct -- and
       * alongside them "Before", "Your Property Many" and "Landscaping", which
       * is half the company's own name. Three cheap tests, in order of how
       * often each fires: words that address the reader, words that are not
       * names at all, and the brand itself. */
      const words = t.toLowerCase().split(' ');
      if (words.some((w) => SLOGAN_WORDS.has(w))) continue;
      if (words.some((w) => NOT_A_PLACE_WORD.has(w))) continue;
      if (BRAND_FROM_HOST && words.some((w) => w.length > 3 && BRAND_FROM_HOST.includes(w))) continue;
      const k = t.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (k && !out.has(k) && out.size < 30) out.set(k, t);
    }
  }
  return out;
}

function residueAreas(urls) {
  const df = new Map();
  const rows = [];
  for (const u of urls) {
    const raw = tokensOf(u);
    if (raw.length < 2) continue;                 // one word cannot split
    const st = raw.map(stem);
    rows.push({ raw, st });
    for (const t of new Set(st)) df.set(t, (df.get(t) || 0) + 1);
  }

  const out = new Map();
  for (const { raw, st } of rows) {
    const counts = st.map((t) => df.get(t) || 0);
    const top = Math.max(...counts);
    /* No repeating family in this slug at all: it is a one-off page, not a grid
     * cell, and guessing an area off it is how "Garden Suite" became a town. */
    if (top < 3) continue;

    const cut = Math.max(1, Math.floor(top * 0.4));
    const low = [];
    for (let i = 0; i < raw.length; i++) {
      if (counts[i] <= cut && !STOP_SLUG.has(st[i]) && raw[i].length > 2) low.push(raw[i]);
    }
    // One or two tokens. Three is a sentence, not a place name.
    if (!low.length || low.length > 2) continue;
    // And it has to be genuinely rarer than the service, not merely tied.
    if (low.every((w) => (df.get(stem(w)) || 0) === top)) continue;

    const name = low.join(' ');
    out.set(name.toLowerCase().replace(/\s+/g, '-'), titleise(name));
  }
  return out;
}

function detectGrid(pages, homeHtml, sitemapPaths, hubHtml, read, pre) {
  const byUrl = new Map(pages.map((p) => [p.url, p]));

  const services = new Map();   // slug -> {name, from}
  const areas = new Map();
  /* Keyed on the NAME as well as the slug. The model calls it "Multi-Storey
   * Construction" and derives the slug from that; the /services/ tree calls it
   * the same thing with the slug "multi-storey". Two keys, one service, and it
   * appeared twice on screen. */
  const seenNames = new Set();
  const nameKey = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '');

  const addSvc = (slug, name, from) => {
    if (!slug || NOT_A_SERVICE.test(slug)) return;
    if (name && NOT_A_SERVICE_NAME.test(name)) return;
    if (name && seenNames.has(nameKey(name))) return;
    if (name) seenNames.add(nameKey(name));
    if (!services.has(slug) && !areas.has(slug)) services.set(slug, { name: name || titleise(slug), from });
  };
  const addArea = (slug, name, from) => {
    if (!slug || NOT_A_SERVICE.test(slug)) return;
    if (name && NOT_A_SERVICE_NAME.test(name)) return;
    if (name && seenNames.has(nameKey(name))) return;
    if (name) seenNames.add(nameKey(name));
    if (!areas.has(slug) && !services.has(slug)) areas.set(slug, { name: name || titleise(slug), from });
  };

  /* 0. WHAT THE MODEL READ. First, because it is the only signal here that
   * reads PROSE. A site whose coverage is one sentence in the hero -- "Locally
   * Serving Collingwood, Blue Mountain, Creemore, Stayner, Mansfield" -- has
   * nothing for any rule below to find, because every one of them reads markup
   * or URLs and none of them reads a sentence. */
  if (read) {
    /* A name the model kept that came from a URL keeps THAT URL's slug. The
     * slug is what the grid matches against the sitemap, so deriving a new one
     * from the name would throw away the page it was found on. */
    const nk = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '');
    const preSlug = new Map();
    for (const x of (pre ? pre.areas.concat(pre.services) : [])) preSlug.set(nk(x.name), x.slug);
    const slugFor = (n) => preSlug.get(nk(n)) || keyOf(n);

    /* A service whose page the model identified takes THAT page's slug, so
     * the grid finds the page that exists. Otherwise it falls back to the name,
     * and correctly finds nothing. */
    for (const name of read.services) {
      const url = read.pageFor && read.pageFor.get(name);
      addSvc(url ? (lastSeg(url) || keyOf(name)) : slugFor(name), name, 'read off your site');
    }
    for (const name of read.areas) addArea(slugFor(name), name, 'read off your site');

    /* Every candidate the model did NOT name as a non-place is kept. This is
     * the half that makes a truncated answer harmless -- it keeps too much, and
     * a wrong chip costs one click while a missing town costs a page. */
    for (const a of (pre ? pre.areas : [])) {
      if (!read.notPlaces.has(String(a.name).toLowerCase())) addArea(a.slug, a.name, a.from);
    }
  }

  /* 1. THE TREES, OVER THE WHOLE SITEMAP -- certain, and free.
   *
   * This read the 20 CRAWLED pages. So a site with 11 service pages and 45
   * service-area pages in its sitemap came back with the 3 services that
   * happened to get crawled, and guessed the rest into nonsense -- "Google",
   * "Automation", "Thunder" and "Firms" offered to a marketing agency as towns
   * it serves.
   *
   * /service-areas/barrie IS a Barrie page. Knowing that costs nothing: the
   * sitemap is one fetch and we already have it. No cleverness downstream beats
   * reading the list a site publishes of its own pages. The crawl cap limits
   * what can be GRADED and has never had anything to do with what can be
   * FOUND, and conflating the two is what produced the guessing. */
  let treeS = 0;
  let treeA = 0;
  const treeSrc = (sitemapPaths && sitemapPaths.length) ? sitemapPaths : pages.map((p) => p.url);
  for (const url of treeSrc) {
    const seg = slugOf(url);
    if (seg.length < 2) continue;
    const slug = seg[seg.length - 1];
    // Named by the page itself where we read it, else by its own slug.
    const named = byUrl.get(url) ? pageName(byUrl.get(url)) : titleise(slug);
    if (/^services?$/i.test(seg[0])) { const n = services.size; addSvc(slug, named, 'services tree'); if (services.size > n) treeS++; }
    else if (AREA_WORDS.test(seg[0])) { const n = areas.size; addArea(slug, named, 'areas tree'); if (areas.size > n) treeA++; }
  }

  // 2. the nav the owner built themselves
  const nav = navGroups(homeHtml);
  for (const [slug, text] of nav.areas) addArea(slug, text, 'your menu');
  for (const [slug, text] of nav.services) addSvc(slug, text, 'your menu');

  /* 2b and 2c: READ THE HOMEPAGE, but only once the signals that actually
   * know have come back with less than a list. A site with a /services/ tree
   * does not need its menu guessed at. */
  /* Three reads, widening only when the one before came back with less than a
   * list: the services page, then a services section on the homepage, then the
   * homepage entire. Widening last is deliberate -- the whole homepage will
   * offer some rubbish, and that is still better than telling a business we
   * could not find services it lists on its front page. */
  if (!read && services.size < 2) {
    for (const [slug, text] of contentServices(hubHtml)) addSvc(slug, text, 'your services page');
  }
  if (!read && services.size < 2) {
    for (const [slug, text] of contentServices(homeHtml, true)) addSvc(slug, text, 'your services section');
  }
  if (!read && services.size < 2) {
    for (const [slug, text] of contentServices(homeHtml)) addSvc(slug, text, 'your home page');
  }

  // 3 and 4 run on the flat pages only. Anything a tree or the nav already
  // placed is settled and must not be guessed at a second time.
  /* THE SLUG PASSES RUN OVER THE WHOLE SITEMAP, NOT THE 20 PAGES READ.
   *
   * Reading a URL costs nothing -- it is a string we already have -- and
   * restricting these passes to the crawl made the cap self-fulfilling: areas
   * were only ever found on pages we had fetched, so the grid could never show
   * a town past page 20, and looking existence up in the sitemap afterwards
   * could not help because the town was never a candidate in the first place.
   * Measured on a 145-page builder: 7 areas from the crawl, and the other 15
   * towns invisible, each one of them a cell reported as never built.
   *
   * Grading still needs the HTML and is still capped at 20. Finding out what
   * exists does not. */
  const flat = (sitemapPaths && sitemapPaths.length ? sitemapPaths : pages.map((p) => p.url))
    .filter((u) => {
      const seg = slugOf(u);
      if (!seg.length) return false;
      if (seg.some((x) => NOT_A_SERVICE.test(x))) return false;
      return !services.has(lastSeg(u)) && !areas.has(lastSeg(u));
    });

  const families = pickFamilyNames(recurringGrams(flat));

  /* A SITE THAT STATES ITS SERVICES DOES NOT NEED THEM INFERRED. DMT lists
   * seven under /services/; adding "Builders" from the grid slugs on top of
   * them is not extra information, it is noise over an answer we already had.
   * So the families are only offered as services where the site named too few
   * to go on -- below, they are still used to find the areas. */
  if (!read && services.size < 2) {
    for (const f of families) {
      const slug = f.gram.replace(/\s+/g, '-');
      let name = titleise(f.gram);
      for (const [u, p] of byUrl) if (stemsOf(u).join(' ') === f.gram) { name = pageName(p); break; }
      addSvc(slug, name, 'repeats across your URLs');
    }
  }

  /* THE GUESSWORK ONLY RUNS WHEN THE READING DID NOT.
   *
   * This is what "no common sense" meant, exactly. A lawn-care site was read
   * correctly -- Simcoe County, the GTA -- and then this line unioned slug
   * arithmetic over blog posts on top of it and offered the owner the towns of
   * "Mulch", "Fertilizer", "Watering Tips", "When Aerate" and "What Clippings".
   * /how-to-get-rid-of-grubs/ became "Rid".
   *
   * The fault was not the arithmetic. It was running the dumb system ALONGSIDE
   * the one that can read and merging the two, which can only ever make the
   * better answer worse. A fallback that runs when the primary succeeded is not
   * a fallback. So where the model read the page, nothing below guesses at
   * areas; where it could not, the arithmetic is still better than nothing. */
  /* A site that publishes a /service-areas/ tree has told us its towns. Running
   * the slug arithmetic on top could only add wrong ones, which is exactly what
   * it did. Same reasoning as not inferring services when the site lists them. */
  if (!read && treeA < 2) {
    for (const [slug, name] of residueAreas(flat)) addArea(slug, name, 'your URLs name it');
    // And the sentence that says where they work, which no URL pass can see.
    if (areas.size < 2 && homeHtml) {
      const txt = decode(strip(homeHtml).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
      for (const [slug, name] of areasFromProse(txt)) addArea(slug, name, 'named on your page');
    }
  }

  /* The flat-site fallback: no family recurs 4+ times and no tree or menu said
   * anything, so there is no grid to read. Each page with a multi-word slug is
   * offered as its own service, named by its own H1. */
  if (!read && !families.length && services.size < 2) {
    for (const u of flat) {
      if (tokensOf(u).length < 2) continue;
      addSvc(lastSeg(u), pageName(byUrl.get(u)), 'a page of yours');
    }
  }

  /* STRIP THE TRADE OUT OF THE TOWN.
   *
   * An agency site came back serving "Online Marketing Aurora", "Internet
   * Marketing Guelph", "Digital Marketing Oshawa" and "Advertising Agency
   * Orillia" -- those are its own page TITLES, and the model handed them back
   * as places because that is what they look like in a menu. The town is in
   * each one; the trade words around it are the noise.
   *
   * A word that recurs across many area names cannot be the thing that makes
   * them different places, so it is not part of any of their names. Aurora,
   * Guelph, Oshawa and Orillia differ; "marketing" does not. Same for any word
   * already in a service name -- it was a service before it was a town.
   *
   * Deterministic on purpose. The model is better at reading than at being
   * consistent, and this is arithmetic over its answer rather than a second
   * question for it. */
  {
    const tok = (n) => String(n).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const freq = new Map();
    for (const v of areas.values()) for (const t of new Set(tok(v.name))) freq.set(t, (freq.get(t) || 0) + 1);
    const inServices = new Set();
    for (const v of services.values()) for (const t of tok(v.name)) inServices.add(t);

    /* Always noise, however rarely it appears. Frequency alone left "Call",
     * "Agencies", "Agency Toronto" and "Digital Ottawa" standing on a site
     * where each occurred once or twice. These are words about a business, not
     * about a place, in any town in the country. */
    const TRADE_WORDS = new Set(['call', 'agency', 'agencies', 'digital', 'online', 'internet',
      'advertising', 'marketing', 'seo', 'web', 'website', 'websites', 'consulting', 'consultant',
      'consultants', 'company', 'companies', 'enterprise', 'enterprises', 'group', 'service',
      'services', 'contracting', 'contractor', 'contractors', 'excavation', 'construction',
      'builder', 'builders', 'design', 'build', 'solutions', 'media', 'studio', 'studios',
      'professional', 'professionals', 'experts', 'expert', 'specialists', 'specialist',
      'near', 'best', 'top', 'local', 'free', 'quote', 'quotes', 'book', 'now', 'today']);

    const filler = new Set(TRADE_WORDS);
    for (const [t, n] of freq) {
      // A word in 3+ area names, or in a service name, and never a name entire.
      const isWholeName = [...areas.values()].some((v) => tok(v.name).length === 1 && tok(v.name)[0] === t);
      if (!isWholeName && (n >= 3 || inServices.has(t))) filler.add(t);
    }

    for (const [slug, v] of [...areas.entries()]) {
      const kept = tok(v.name).filter((t) => !filler.has(t) && !/\d/.test(t) && t.length > 2);
      // Nothing left once the trade is removed: it was never a place.
      if (!kept.length || kept.length > 3) { areas.delete(slug); continue; }
      const name = kept.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      if (name.toLowerCase() !== String(v.name).toLowerCase()) {
        areas.delete(slug);
        const k = kept.join('-');
        if (!areas.has(k) && !services.has(k)) areas.set(k, { name, from: v.from });
      }
    }
  }

  /* THE SHORTER NAME IS THE PLACE. Over a whole sitemap the same town arrives
   * twice -- once clean and once with a service word still attached: "Barrie"
   * and "Additions Barrie", "Ajax" and "House Ajax", "Muskoka" and "Muskoka
   * Cottage". Both halves of each pair are the same town, and the longer one is
   * the one that failed to shed its service. So where one area's words are a
   * superset of another's, the superset goes.
   *
   * Dropping rather than merging is deliberate: a town listed twice is a town
   * the owner has to untick twice, and every wrong chip costs more trust than
   * a missing one, because a missing town can be typed into the box underneath. */
  for (const [slug, v] of [...areas.entries()]) {
    const mine = new Set(slug.split('-').filter(Boolean));
    for (const other of areas.keys()) {
      if (other === slug) continue;
      const theirs = other.split('-').filter(Boolean);
      if (theirs.length < mine.size && theirs.every((t) => mine.has(t))) { areas.delete(slug); break; }
    }
    void v;
  }

  const out = (m) => [...m.entries()].map(([slug, v]) => ({ slug, name: v.name, from: v.from }));
  return { services: out(services).slice(0, 24), areas: out(areas).slice(0, 60) };
}

const titleise = (s) => String(s).replace(/[-_]+/g, ' ')
  .replace(/\b([a-z])/g, (m, c) => c.toUpperCase()).trim();
