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

const MAX_PAGES = 40;          // see the subrequest ceiling above
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

async function get(url, accept) {
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
  } catch {
    return { ok: false, status: 0, url, text: '' };
  } finally { clearTimeout(t); }
}

// ------------------------------------------------------------------ crawl --
async function audit(target) {
  const origin = target.origin;
  let urls = await fromSitemaps(origin);
  let source = 'sitemap';

  if (urls.length < 2) {
    urls = await fromLinks(origin);
    source = 'links';
  }

  urls = dedupe(urls).filter((u) => sameSite(u, origin));
  const capped = urls.length > MAX_PAGES;
  urls = urls.slice(0, MAX_PAGES);
  if (!urls.includes(origin + '/') && !urls.includes(origin)) urls.unshift(origin + '/');

  const pages = await mapLimit(urls, CONCURRENCY, async (u) => {
    const res = await get(u);
    if (!res.ok || !res.text) return { url: path(u), status: res.status, error: true };
    return assess(path(u), res.text);
  });

  const good = pages.filter((p) => !p.error);
  return {
    origin,
    discovered_by: source,
    crawled: good.length,
    failed: pages.length - good.length,
    capped,
    cap: MAX_PAGES,
    footer_nap: good.some((p) => p.footer_nap),
    services: detectServices(good),
    areas: detectAreas(good),
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
const dedupe = (a) => [...new Set(a.map((u) => { try { const x = new URL(u); x.hash = ''; return x.toString(); } catch { return u; } }))];

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

const tagText = (html, tag) => [...strip(html).matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))]
  .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
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

function detectServices(pages) {
  const out = new Map();
  for (const p of pages) {
    const seg = p.url.replace(/\/+$/, '').split('/').filter(Boolean);
    if (p.kind === 'service' && seg.length > 1) {
      const slug = seg[seg.length - 1];
      out.set(slug, titleise(slug));
    }
  }
  // No /services/* tree: fall back to top-level pages that are not obviously
  // something else. Noisy on purpose -- the owner corrects it.
  if (out.size === 0) {
    for (const p of pages) {
      const seg = p.url.replace(/\/+$/, '').split('/').filter(Boolean);
      if (seg.length === 1 && ['other'].includes(p.kind)) out.set(seg[0], titleise(seg[0]));
    }
  }
  return [...out.entries()].map(([slug, name]) => ({ slug, name })).slice(0, 24);
}

function detectAreas(pages) {
  const out = new Map();
  for (const p of pages) {
    const seg = p.url.replace(/\/+$/, '').split('/').filter(Boolean);
    if (p.kind === 'area' && seg.length > 1) {
      const slug = seg[seg.length - 1];
      out.set(slug, titleise(slug));
    }
  }
  return [...out.entries()].map(([slug, name]) => ({ slug, name })).slice(0, 40);
}

const titleise = (s) => String(s).replace(/[-_]+/g, ' ')
  .replace(/\b([a-z])/g, (m, c) => c.toUpperCase()).trim();
