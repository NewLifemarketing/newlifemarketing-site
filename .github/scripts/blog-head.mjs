/* VENDORED from seo-system/lib/blog-head.mjs — do not edit here.
   Change it in seo-system and run: node scripts/vendor-blog-head.mjs --write
   seo-system CI refuses a commit while any client's copy differs. */
/**
 * blog-head.mjs — is a published page's <head> actually well formed?
 *
 *   import { checkHead, repairHead } from './blog-head.mjs';
 *   const findings = checkHead(html, { origin: 'https://example.com', pagePath: '/blog/x/' });
 *   const { html: fixed, repairs } = repairHead(html, { origin, pagePath });
 *
 * No dependencies and no client in it. It is handed an origin and the page's
 * own path and knows nothing else, so the same file is correct for every
 * client. It runs on a bare GitHub runner, which is why there is no npm here.
 *
 * WHY THIS EXISTS
 *
 * On 2026-10-14 a post went live whose canonical read
 *
 *     https://<host>/blog/ dug-vs-drilled-well/
 *
 * -- a space in the path, so the page told Google its own address was a 404.
 * Worse, and invisible from the canonical: the publisher had also left a stray
 * opening double-quote in three meta values, and
 *
 *     <meta name="description" content=" "Dug vs drilled well in ...">
 *
 * closes the attribute at the second quote. The description, og:title and
 * og:description were EMPTY, with the rest of the sentence parsed as junk
 * attributes. All four clients' validators passed it, because all four asked
 * only whether a canonical tag EXISTED:
 *
 *     if (!/<link\s+rel="canonical"/i.test(html)) problems.push('missing canonical')
 *
 * A canonical containing a space is a canonical tag. The gate could only fail
 * one way, so it never asked whether the URL was this page's own, well formed,
 * or reachable. "A gate that cannot fail is worthless" -- CLAUDE.md.
 *
 * WHAT MAY BE REPAIRED, AND WHAT MAY NOT
 *
 * A finding is `repairable` only when the fix REMOVES characters that cannot
 * legitimately be there -- whitespace inside a URL, a stray quote, a leading
 * space on a date -- or derives a value with exactly one possible answer: a
 * page's canonical is its own URL.
 *
 * Everything else is a judgement and stays for a human. A canonical pointing at
 * a DIFFERENT host or a DIFFERENT path may be deliberate; an empty description
 * that is simply absent cannot be invented. A writer rewriting a page to pass
 * its own gate is the gate grading its own homework, which is the arrangement
 * this whole system exists to avoid.
 */

const HEAD = (html) => {
  const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : html;
};

/** Every http(s) URL sitting in an href= or content= attribute in the head. */
function headUrls(html) {
  const out = [];
  const re = /\b(href|content)="(https?:\/\/[^"]*)"/gi;
  let m;
  while ((m = re.exec(HEAD(html)))) out.push({ attr: m[1], value: m[2] });
  return out;
}

const tagValue = (html, re) => {
  const m = HEAD(html).match(re);
  return m ? m[1] : null;
};

const CANONICAL = /<link[^>]+rel="canonical"[^>]+href="([^"]*)"/i;
const OG_URL = /<meta[^>]+property="og:url"[^>]+content="([^"]*)"/i;
const TITLE = /<title>([\s\S]*?)<\/title>/i;
const DESCRIPTION = /<meta[^>]+name="description"[^>]+content="([^"]*)"/i;
const LD = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i;

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.+-]+Z?)?$/;

/** The one URL this page is allowed to call its own. */
const ownUrl = (origin, pagePath) =>
  origin.replace(/\/+$/, '') + (pagePath.startsWith('/') ? pagePath : `/${pagePath}`);

/**
 * Does `value` differ from `want` only by whitespace and stray quotes?
 * That is the whole test for "a repair can remove characters to reach this".
 */
const onlyNoise = (value, want) =>
  value.replace(/[\s"']/g, '') === String(want).replace(/[\s"']/g, '');

/**
 * @returns {{code:string,message:string,repairable:boolean}[]} empty when clean
 */
export function checkHead(html, { origin, pagePath, exists }) {
  const f = [];
  // `info` marks a finding that is REPORTED but does not fail the gate -- a
  // deliberate choice the gate can see but must not overrule.
  const add = (code, message, repairable, info = false) => f.push({ code, message, repairable, info });
  const want = ownUrl(origin, pagePath);
  const host = new URL(origin).host;

  // ---- every URL in the head is a URL -------------------------------------
  for (const { attr, value } of headUrls(html)) {
    if (/\s/.test(value)) {
      add('url-whitespace', `${attr}="${value}" contains whitespace — that URL does not exist`, true);
    } else {
      try { new URL(value); } catch {
        add('url-unparseable', `${attr}="${value}" is not a URL`, false);
      }
    }
  }

  // ---- the attribute a stray quote silently closed ------------------------
  // content=" "Dug vs ...  ->  the value is ' ' and the rest is junk attributes.
  const head = HEAD(html);
  for (const m of head.matchAll(/\b(?:name|property)="([^"]+)"\s+content="([^"]*)"/gi)) {
    const [, key, value] = m;
    if (value.trim() === '') {
      // Empty because a stray quote closed it early, or empty because it is
      // empty? The difference is what comes NEXT: a well-formed attribute is
      // followed by the end of the tag or by another attribute. Anything else
      // means the rest of the value is being parsed as markup, and putting the
      // quote back restores text that is still right there in the file.
      const after = head.slice(m.index + m[0].length, m.index + m[0].length + 40);
      const wellFormed = /^\s*\/?>/.test(after) || /^\s+[a-zA-Z-]+\s*=/.test(after);
      add('attr-empty', `<meta ${key}> has an empty content attribute`, !wellFormed);
    } else if (/^\s*["']/.test(value)) {
      add('attr-stray-quote', `<meta ${key}> content opens with a stray quote`, true);
    }
  }
  // the specific shape that closed the attribute early
  if (/content="\s+"/.test(HEAD(html))) {
    add('attr-quote-closed',
      'a meta content attribute is closed by a stray quote — its text is being parsed as attributes', true);
  }

  // ---- the canonical ------------------------------------------------------
  const canonical = tagValue(html, CANONICAL);
  if (canonical === null) {
    add('canonical-missing', 'no canonical link', true);
  } else if (canonical.trim() !== want) {
    const clean = canonical.replace(/\s+/g, '');
    if (onlyNoise(canonical, want)) {
      add('canonical-noise', `canonical "${canonical}" is this page's URL with noise in it`, true);
    } else {
      let h = null;
      try { h = new URL(clean).host; } catch { /* reported above */ }
      if (h && h !== host) {
        add('canonical-host', `canonical points at ${h}, not ${host}`, false);
      } else {
        // A canonical pointing at ANOTHER page on this site is usually
        // deliberate: a near-duplicate deferring to the original, or a post
        // deferring to the money page that owns its cluster. That is the
        // "one cluster, one page" rule working, and failing it would train
        // people to ignore the gate. It is only a defect when the target does
        // not exist -- then the page has consolidated itself into nothing.
        let target = null;
        try { target = new URL(clean).pathname; } catch { /* reported above */ }
        const known = target && exists ? exists(target) : null;
        if (known === false) {
          add('canonical-dangling', `canonical is ${clean}, which does not exist on this site`, false);
        } else {
          add('canonical-elsewhere',
            `canonical defers to ${clean} rather than this page — deliberate consolidation, or a mistake`,
            false, known === true);
        }
      }
    }
  }

  // ---- og:url agrees with it ---------------------------------------------
  const og = tagValue(html, OG_URL);
  if (og !== null && og.trim() !== want) {
    add(onlyNoise(og, want) ? 'ogurl-noise' : 'ogurl-mismatch',
      `og:url is "${og}", canonical should be ${want}`, onlyNoise(og, want));
  }

  // ---- the visible title --------------------------------------------------
  const title = tagValue(html, TITLE);
  if (title === null) add('title-missing', 'no <title>', false);
  else if (/^\s*["']/.test(title)) add('title-stray-quote', `<title> opens with a stray quote: "${title.slice(0, 40)}…"`, true);
  else if (title.trim() === '') add('title-empty', '<title> is empty', false);

  const desc = tagValue(html, DESCRIPTION);
  if (desc === null) add('description-missing', 'no meta description', false);

  // ---- the structured data ------------------------------------------------
  //
  // A page carries SEVERAL ld+json blocks -- typically the business, the post,
  // and an FAQ -- so every block is read, not just the first. And only the
  // PAGE's node is asked whether its url is this page's: a LocalBusiness node's
  // url is the company's homepage and is supposed to be the homepage. Checking
  // it reported 100+ correct pages as broken on the first run across all four
  // clients, which is how a gate teaches people to ignore it.
  const blocks = [...HEAD(html).matchAll(new RegExp(LD.source, 'gi'))];
  if (!blocks.length) {
    add('jsonld-missing', 'no JSON-LD structured data', false);
  } else {
    const nodes = [];
    for (const b of blocks) {
      let parsed = null;
      try { parsed = JSON.parse(b[1]); } catch (e) {
        add('jsonld-unparseable', `JSON-LD does not parse: ${e.message}`, false);
        continue;
      }
      const flatten = (x) => (Array.isArray(x) ? x.flatMap(flatten)
        : x && typeof x === 'object' ? [x, ...flatten(x['@graph'] || [])] : []);
      nodes.push(...flatten(parsed));
    }
    const PAGE_TYPES = /^(BlogPosting|Article|NewsArticle|TechArticle|WebPage|ItemPage|AboutPage|ContactPage|CollectionPage)$/;
    const isPage = (n) => [].concat(n['@type'] || []).some((t) => PAGE_TYPES.test(t));
    {
      for (const n of nodes.filter(isPage)) {
        for (const k of ['datePublished', 'dateModified']) {
          if (n[k] == null) continue;
          if (!ISO.test(n[k])) {
            add(`jsonld-date`, `JSON-LD ${k} is ${JSON.stringify(n[k])}, not an ISO date`,
              ISO.test(String(n[k]).trim()));
          }
        }
        for (const k of ['mainEntityOfPage', 'url']) {
          const v = typeof n[k] === 'object' && n[k] ? n[k]['@id'] : n[k];
          if (typeof v !== 'string') continue;
          if (v.trim() !== want) {
            add('jsonld-url', `JSON-LD ${k} is "${v}", this page is ${want}`, onlyNoise(v, want));
          }
        }
        for (const k of ['headline', 'description']) {
          if (typeof n[k] === 'string' && /^\s*["']/.test(n[k])) {
            add('jsonld-stray-quote', `JSON-LD ${k} opens with a stray quote`, true);
          }
        }
      }
    }
  }

  // A page that deliberately defers its canonical to another page is a
  // consolidation stub: a near-duplicate pointing at the original, or a post
  // standing aside for the money page that owns its cluster. Being thin is the
  // POINT of such a page, so its own description and structured data are not
  // required -- Google is being told to index the other URL.
  //
  // On the first sweep this was six NewLife posts failing twice each, and all
  // six were correct. Demanding a description from a page that has formally
  // asked not to be indexed is the gate misunderstanding its own job.
  if (f.some((x) => x.code === 'canonical-elsewhere' && x.info)) {
    return f.filter((x) => !['description-missing', 'jsonld-missing'].includes(x.code));
  }

  return f;
}

/**
 * Apply only the repairs that remove noise or restore the page's own URL.
 *
 * Deliberately NOT a loop and deliberately not clever: it makes one pass, and
 * the caller re-runs checkHead against the result from scratch rather than
 * trusting what comes back here.
 *
 * @returns {{html:string, repairs:{code:string,detail:string}[]}}
 */
export function repairHead(html, { origin, pagePath }) {
  const want = ownUrl(origin, pagePath);
  const repairs = [];
  const note = (code, detail) => repairs.push({ code, detail });
  let head = HEAD(html);
  const original = head;

  // 1. whitespace inside any head URL -- there is no legitimate one
  head = head.replace(/\b(href|content)="(https?:\/\/[^"]*)"/gi, (m, attr, url) => {
    if (!/\s/.test(url)) return m;
    note('url-whitespace', `${url} → ${url.replace(/\s+/g, '')}`);
    return `${attr}="${url.replace(/\s+/g, '')}"`;
  });

  // 2. the stray quote that closes a content attribute early
  //
  // The lookahead is load-bearing. Without it this also matches a legitimately
  // empty content="" -- whose two quotes look identical to the defect -- and
  // eats the closing one, turning <meta content=""> into <meta content=">.
  // The test caught it. An empty attribute is a missing value, not a stray
  // quote, and it is not this function's to invent.
  head = head.replace(/content="\s*["'](?!\s*\/?>)/g, () => {
    note('attr-quote-closed', 'removed a stray quote that was closing a content attribute');
    return 'content="';
  });

  // 3. the same stray quote where it merely leads the value
  head = head.replace(/\b((?:name|property)="[^"]+"\s+content=")\s+/gi, (m, lead) => {
    note('attr-leading-space', 'trimmed a leading space from a meta value');
    return lead;
  });

  // 4. the visible <title>
  head = head.replace(/<title>\s*["']?\s*/i, (m) => {
    if (m === '<title>') return m;
    note('title-noise', 'removed leading whitespace / stray quote from <title>');
    return '<title>';
  });

  // 5. a canonical that is this page's URL with noise in it, or missing entirely
  const canonical = head.match(CANONICAL)?.[1];
  if (canonical != null && canonical !== want && onlyNoise(canonical, want)) {
    head = head.replace(CANONICAL, (m) => m.replace(canonical, want));
    note('canonical-noise', `${canonical} → ${want}`);
  } else if (canonical == null) {
    head = head.replace(/(<\/title>)/i, `$1\n<link rel="canonical" href="${want}">`);
    note('canonical-missing', `added the page's own canonical ${want}`);
  }

  // 6. the JSON-LD: parse, trim every string, drop a stray opening quote,
  //    and put the page's own URL back where it is only noise away from it
  // All blocks, not just the first -- a page carries several. And the page's
  // own URL is only restored on a page-type node, for the same reason the
  // check only asks page-type nodes: a business node's url is the homepage.
  head = head.replace(new RegExp(LD.source, 'gi'), (m, body) => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { return m; }   // unparseable is NOT repairable
    let touched = false;
    const clean = (v) => {
      if (typeof v !== 'string') return v;
      const t = v.trim().replace(/^["'](?!.*["']$)/, '');
      if (t !== v) touched = true;
      return t;
    };
    const walk = (o) => {
      if (Array.isArray(o)) return o.map(walk);
      if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)]));
      return clean(o);
    };
    const fixed = walk(parsed);
    const flatten = (x) => (Array.isArray(x) ? x.flatMap(flatten)
      : x && typeof x === 'object' ? [x, ...flatten(x['@graph'] || [])] : []);
    const PAGE_TYPES = /^(BlogPosting|Article|NewsArticle|TechArticle|WebPage|ItemPage|AboutPage|ContactPage|CollectionPage)$/;
    for (const n of flatten(fixed)) {
      if (![].concat(n['@type'] || []).some((t) => PAGE_TYPES.test(t))) continue;
      for (const k of ['mainEntityOfPage', 'url']) {
        if (typeof n[k] === 'string' && n[k] !== want && onlyNoise(n[k], want)) { n[k] = want; touched = true; }
      }
    }
    if (!touched) return m;
    note('jsonld-noise', 'trimmed JSON-LD values and restored the page URL');
    return m.replace(body, JSON.stringify(fixed));
  });

  if (head === original) return { html, repairs };
  return { html: html.replace(original, head), repairs };
}

/** Convenience for callers that just want a yes/no plus a reason list. */
export function describe(findings) {
  if (!findings.length) return 'head is clean';
  const r = findings.filter((x) => x.repairable).length;
  return `${findings.length} problem(s), ${r} repairable, ${findings.length - r} needing a human`;
}
