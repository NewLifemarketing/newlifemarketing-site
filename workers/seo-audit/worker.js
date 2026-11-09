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
  async fetch(request, env) {
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
    if (/(^|\.)newlifemarketing\.ca$/i.test(target.hostname)) {
      return json({ error: 'That is our site.' }, 400, origin);
    }

    try {
      const result = await audit(target);
      // The lead is worth keeping whatever the crawl found.
      if (env && env.AUDIT_LEADS) {
        await env.AUDIT_LEADS.put(
          `${new Date().toISOString()}-${target.hostname}`,
          JSON.stringify({
            website: target.origin,
            company: String(body.company || '').slice(0, 200),
            name: String(body.name || '').slice(0, 200),
            email: String(body.email || '').slice(0, 200),
            phone: String(body.phone || '').slice(0, 60),
            is_owner: body.is_owner === 'yes' ? 'yes' : body.is_owner === 'no' ? 'no' : '',
            at: new Date().toISOString(),
            pages_crawled: result.crawled,
          }),
          { expirationTtl: 60 * 60 * 24 * 365 },
        ).catch(() => {});
      }
      return json(result, 200, origin);
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
async function audit(target) {
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
  const grid = detectGrid(good, homeHtml, sitemap, hubHtml);
  return {
    origin,
    discovered_by: source,
    crawled: good.length,
    failed: pages.length - good.length,
    capped,
    cap: MAX_PAGES,
    discovered,
    sitemap,
    /* The pages that could not be read, with their status. Silent drops are
     * what let 17 failed fetches read as "nine towns you never built". */
    subrequests: SUBREQ,
    unreadable: pages.filter((p) => p.error).map((p) => ({ url: p.url, status: p.status, why: p.why })),
    footer_nap: good.some((p) => p.footer_nap),
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

  const footer = (clean.match(/<footer\b[\s\S]*?<\/footer>/i) || [''])[0]
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const hasPhone = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(footer);
  const hasPostal = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i.test(footer)
    || /\b\d{1,6}\s+[A-Za-z][A-Za-z.\- ]{2,40}\s(st|street|rd|road|ave|avenue|dr|drive|blvd|way|hwy|highway|cres|crescent|lane|ln|court|ct)\b/i.test(footer);

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
    footer_nap: hasPhone && hasPostal,
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

/* -- signal 2a: OPEN THE SERVICES PAGE AND READ IT -------------------------
 * This replaces a fallback that read the top menu and offered whatever was not
 * obviously furniture. On a real site that returned two "services": "Services"
 * -- the hub page itself -- and "Privacy & Terms". Both were in the menu, and
 * neither is a service, and no amount of widening the blocklist makes guessing
 * from a menu into reading.
 *
 * What a person does when a menu says "Services" is click it. So does this. It
 * costs one subrequest and it is the only signal here that looks at the page a
 * site wrote specifically to list what it sells.
 */
const HUB_PATH = /^\/(services?|our-services|what-we-do|services-we-offer)\/?$/i;

function hubServices(html) {
  const out = new Map();
  if (!html) return out;
  // The hub's own content, with the furniture taken out -- a nav link inside
  // the services page is still a nav link.
  const clean = strip(html)
    .replace(/<(header|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = clean.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const body = main ? main[1] : clean;

  for (const m of body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (/^(tel|mailto|javascript|#)/i.test(m[1])) continue;
    let seg;
    try { seg = slugOf(new URL(m[1], 'https://x.invalid').pathname); } catch { continue; }
    if (!seg.length) continue;
    const key = seg[seg.length - 1];
    if (!key || key.length < 3) continue;
    if (!text || text.length > 48) continue;
    if (/^(read|learn|see|view|more|details|get|book|call|contact|back|next|previous)\b/i.test(text)) continue;
    out.set(key, text);
    if (out.size >= 16) break;
  }
  return out;
}

/* -- signal 2b: THE HOMEPAGE, WHICH IS WHERE A HUMAN LOOKS ------------------
 * Reported on a real site: "we could not find any services section", when
 * anyone opening that site would name the services in three seconds. They were
 * right, and the reason is that none of the signals above read the page. The
 * trees are URL structure. The nav group needs a menu item literally labelled
 * "Services". The slug passes need a grid. A site whose top menu reads
 *
 *     Home | Roofing | Siding | Eavestrough | About | Contact
 *
 * has no services tree, no "Services" label to hang a dropdown off, and no grid
 * to factorise -- and its services are the four words in the middle of that
 * menu, which is exactly what a person sees.
 *
 * So two more reads, both of the homepage, both only used when the stronger
 * signals came back with less than a list:
 *
 *   2b  a heading that announces services, and what follows it
 *   2c  the top menu with the furniture taken out
 *
 * 2c is the blunt one and it is deliberately blunt: "the menu items that are
 * not About, Contact or Blog" is how a human reads a trades site, and the
 * blocklist already knows what the furniture is called. Some of what it offers
 * will be wrong. The owner is being asked, and being asked about four plausible
 * things beats being told we found nothing about a site that says what it does
 * at the top of every page. */
function homepageServices(html) {
  const out = new Map();
  if (!html) return out;
  const clean = strip(html);

  const heads = [...clean.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({
    at: m.index,
    lvl: Number(m[1]),
    text: decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
  }));

  const anchor = heads.find((h) => /\b(our\s+)?services\b|what\s+we\s+(do|offer)|how\s+we\s+help|our\s+expertise/i.test(h.text));
  if (!anchor) return out;

  // The section runs to the next heading at the same level or higher.
  const next = heads.find((h) => h.at > anchor.at && h.lvl <= anchor.lvl);
  const section = clean.slice(anchor.at, next ? next.at : Math.min(clean.length, anchor.at + 12000));

  for (const m of section.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    let seg;
    try { seg = slugOf(new URL(m[1], 'https://x.invalid').pathname); } catch { continue; }
    if (!seg.length) continue;
    const key = seg[seg.length - 1];
    if (!key || key.length < 3) continue;
    if (!text || text.length > 48) continue;
    if (/^(read more|learn more|more|view|see more|details|get a quote|contact)/i.test(text)) continue;
    out.set(key, text);
    if (out.size >= 14) break;
  }
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

function detectGrid(pages, homeHtml, sitemapPaths, hubHtml) {
  const byUrl = new Map(pages.map((p) => [p.url, p]));

  const services = new Map();   // slug -> {name, from}
  const areas = new Map();
  const addSvc = (slug, name, from) => {
    if (!slug || NOT_A_SERVICE.test(slug)) return;
    if (name && NOT_A_SERVICE_NAME.test(name)) return;
    if (!services.has(slug) && !areas.has(slug)) services.set(slug, { name: name || titleise(slug), from });
  };
  const addArea = (slug, name, from) => {
    if (!slug || NOT_A_SERVICE.test(slug)) return;
    if (name && NOT_A_SERVICE_NAME.test(name)) return;
    if (!areas.has(slug) && !services.has(slug)) areas.set(slug, { name: name || titleise(slug), from });
  };

  // 1. the trees -- certain
  for (const p of pages) {
    const seg = slugOf(p.url);
    if (seg.length > 1 && /^services?$/i.test(seg[0])) addSvc(seg[seg.length - 1], pageName(p), 'services tree');
    if (seg.length > 1 && AREA_WORDS.test(seg[0])) addArea(seg[seg.length - 1], pageName(p), 'areas tree');
  }

  // 2. the nav the owner built themselves
  const nav = navGroups(homeHtml);
  for (const [slug, text] of nav.areas) addArea(slug, text, 'your menu');
  for (const [slug, text] of nav.services) addSvc(slug, text, 'your menu');

  /* 2b and 2c: READ THE HOMEPAGE, but only once the signals that actually
   * know have come back with less than a list. A site with a /services/ tree
   * does not need its menu guessed at. */
  if (services.size < 2) {
    for (const [slug, text] of hubServices(hubHtml)) addSvc(slug, text, 'your services page');
  }
  if (services.size < 2) {
    for (const [slug, text] of homepageServices(homeHtml)) addSvc(slug, text, 'your services section');
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
  if (services.size < 2) {
    for (const f of families) {
      const slug = f.gram.replace(/\s+/g, '-');
      let name = titleise(f.gram);
      for (const [u, p] of byUrl) if (stemsOf(u).join(' ') === f.gram) { name = pageName(p); break; }
      addSvc(slug, name, 'repeats across your URLs');
    }
  }

  for (const [slug, name] of residueAreas(flat)) addArea(slug, name, 'your URLs name it');

  /* The flat-site fallback: no family recurs 4+ times and no tree or menu said
   * anything, so there is no grid to read. Each page with a multi-word slug is
   * offered as its own service, named by its own H1. */
  if (!families.length && services.size < 2) {
    for (const u of flat) {
      if (tokensOf(u).length < 2) continue;
      addSvc(lastSeg(u), pageName(byUrl.get(u)), 'a page of yours');
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
