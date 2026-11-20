"""Render a case study page on the case-study-v2 layout from a JSON spec.

  python -I scripts/case-study-v2/build.py <spec.json> [<spec.json> ...]     (from the site repo root)

The page must already exist at case-studies/<slug>/index.html with its own
<head> (title, meta, JSON-LD, canonical), header, cs-postmeta byline and
footer, and its card must already be on /case-studies/. This keeps all of
that and replaces the body between the header and the form; it adds the call
button to the form and the proof-of-us strip after it. Colour, logo and logo
size come from the page's card on /case-studies/, so hero and card can never
disagree. Re-running is safe: the output is the same.

Spec fields: slug, hide_logos[] (logo-file substrings to drop from the client wall, for anonymous cases), title, description, services[{name,icon}], issue[html],
goals[{title,detail,icon}], approach{idea,steps[html],media{type:video|photo|img,
src,alt,pos?,caption?}|null,creative_html,creative_label}, extra_sections[{kicker,
h2,html,place?:before_approach|after_results}], results{heading?,stats[{num,
what,ctx,icon}],intro_html,proof_html,note_html}, quote_html.

Kept in the repo, not a scratch folder, since 2026-11-20: the first version
lived in a session scratchpad and was lost when it was cleared."""
import html as H, json, re, sys
from PIL import Image

idx = open('case-studies/index.html', encoding='utf-8').read()
home = open('index.html', encoding='utf-8').read()
v2ref = open('case-studies/aarons-thunder-bay-fall-2026/index.html', encoding='utf-8').read()

SV = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
P = {
 'inbound': '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M4 13 6.5 5h11L20 13v6H4z"/><path d="M12 2.5v7m-2.5-2.5L12 9.5l2.5-2.5"/>',
 'people':  '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.6a3.2 3.2 0 0 1 0 6.2M18 14.3c1.8.8 3 2.6 3 4.7"/>',
 'shield':  '<path d="M12 3 4.5 6v6c0 4.4 3.2 8 7.5 9 4.3-1 7.5-4.6 7.5-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
 'chat':    '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>',
 'price':   '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/><path d="M14 9.5v5.5m-2.2-2.2L14 15l2.2-2.2"/>',
 'form':    '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
 'camera':  '<rect x="2.5" y="6" width="13.5" height="12" rx="2.5"/><path d="m16 10.5 5.5-3v9l-5.5-3z"/>',
 'social':  '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1"/>',
 'seo':     '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
 'search':  '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
 'web':     '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18M6.5 6.8h.01M9 6.8h.01"/>',
 'crm':     '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16.2c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4M14.5 10h4M14.5 13.5h3"/>',
 'drone':   '<rect x="9" y="10" width="6" height="4" rx="1.2"/><path d="M9 11 6.5 8.5M15 11l2.5-2.5M9 13l-2.5 2.5M15 13l2.5 2.5"/><circle cx="5" cy="7" r="2"/><circle cx="19" cy="7" r="2"/><circle cx="5" cy="17" r="2"/><circle cx="19" cy="17" r="2"/>',
 'code':    '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>',
 'ai':      '<path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.7l-1.6-5.5L5 10.6 10.4 9z"/><path d="m18.5 15.5.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7z"/>',
 'brand':   '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
 'portal':  '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3M12 14.5v2.5"/>',
 'photo':   '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-8 8"/>',
 'target':  '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
 'growth':  '<path d="M3.5 20.5h17"/><path d="m5 16 4.5-4.5 3.5 3.5L20 8"/><path d="M15 8h5v5"/>',
 'cart':    '<circle cx="9" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/><path d="M3 4h2.5l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h7.9a1.5 1.5 0 0 0 1.5-1.1L20.5 8H6.3"/>',
 'store':   '<path d="M4 9.5 5.5 4h13L20 9.5"/><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M5 11.5V20h14v-8.5M10 20v-4.5h4V20"/>',
 'clock':   '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
 'star':    '<path d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
 'map':     '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
 'film':    '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 4.5v15M17 4.5v15M3 9h4M3 15h4M17 9h4M17 15h4"/>',
 'doc':     '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5M9 13h6M9 16.5h4"/>',
}
# google-ads.svg in assets is white (made for dark tiles); the hero tiles are white, so use the blue copy
IMG_ICON = {'meta': '/assets/brand/logos/meta.svg', 'google': '/assets/brand/logos/google-ads-color.svg'}

def icon(k):
    return f'<svg {SV}>{P.get(k, P["star"])}</svg>'

def svc_icon(k):
    if k in IMG_ICON:
        return f'<img src="{IMG_ICON[k]}" alt="" width="30" height="30">'
    return icon(k)

def grab(src, pat):
    m = re.search(pat, src, re.S)
    return m.group(0) if m else None

LOOP_JS = grab(v2ref, r'<script>\(function\(\)\{var r=document\.querySelector\("\.csx-loop"\).*?</script>')
FINAL_REF = grab(v2ref, r'<section class="band svc-final">.*?</section>')
US_REF = grab(v2ref, r'<section class="csx-us">.*?</section>') + grab(home, r'<section class="band tight logo-band">.*?</section>')
V2_LINK = grab(v2ref, r'<link rel="stylesheet" href="/css/case-study-v2\.min\.css\?v=[0-9a-f]+">')
assert LOOP_JS and FINAL_REF and US_REF and V2_LINK, 'reference page is missing a shared block'

def card_of(slug):
    m = re.search(r'<a class="cs-feature[^"]*"[^>]*href="/case-studies/' + re.escape(slug) + r'/".*?</a>', idx, re.S)
    assert m, 'no card on /case-studies/ for ' + slug
    return m.group(0)

def build(spec):
    slug = spec['slug']
    path = f'case-studies/{slug}/index.html'
    s = open(path, encoding='utf-8', newline='').read()

    card = card_of(slug)
    colour = re.search(r'--cs-color:(#[0-9A-Fa-f]{3,8})', card).group(1)
    logo = re.search(r'<span class="cs-feature-logo"[^>]*><img src="([^"]+)" alt="([^"]*)"', card)
    lsrc, lalt = logo.group(1), logo.group(2)
    lp = lsrc.lstrip('/')
    if lp.endswith('.svg'):
        vb = re.search(r'viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"', open(lp, encoding='utf-8').read())
        lw, lh = round(float(vb.group(1))), round(float(vb.group(2)))
    else:
        lw, lh = Image.open(lp).size

    services = ''.join(f'<li><span class="csx-ico">{svc_icon(x["icon"])}</span>{H.escape(x["name"])}</li>' for x in spec['services'])
    strategy = ''
    if spec.get('strategy'):
        strategy = f'<div class="csx-strategy"><span>Strategy</span><strong>{H.escape(spec["strategy"])}</strong></div>'
    hero = (f'<section class="csx-hero" style="--cs-color:{colour}"><div class="wrap">'
            f'<img class="csx-logo" src="{lsrc}" alt="{lalt}" width="{lw}" height="{lh}">'
            f'<h1>{H.escape(spec["title"])}</h1><p class="csx-sub">{H.escape(spec["description"])}</p>'
            f'<div class="csx-used"><p class="csx-used-label">Services Used:</p><ul>{services}</ul></div>{strategy}'
            '</div></section>')
    postmeta = grab(s, r'<div class="cs-postmeta">.*?</div></div>')
    assert postmeta, 'no cs-postmeta byline on ' + path

    issue = ('<section class="csx-band csx-issue"><div class="wrap"><div class="csx-issue-panel"><h2 class="csx-h">The Issue</h2>'
             + ''.join(f'<p>{p}</p>' for p in spec['issue']) + '</div></div></section>')
    gcls = 'csx-goals csx-goals-2' if len(spec['goals']) == 2 else 'csx-goals'
    goals = (f'<section class="csx-band"><div class="wrap"><h2 class="csx-h">The Goals</h2><div class="{gcls}">'
             + ''.join(f'<div class="csx-goal">{icon(g["icon"])}<h3>{H.escape(g["title"])}</h3><p>{H.escape(g["detail"])}</p></div>' for g in spec['goals'])
             + '</div></div></section>')

    ap = spec['approach']
    media = ''
    m = ap.get('media')
    if m:
        alt = H.escape(m.get('alt') or '')
        if m['type'] == 'video':
            media = f'<div class="csx-approach-media"><video src="{m["src"]}" autoplay muted loop playsinline preload="metadata" aria-label="{alt}"></video></div>'
        elif m['type'] == 'photo':
            pos = f' style="object-position:{m["pos"]}"' if m.get('pos') else ''
            media = f'<div class="csx-approach-media"><img src="{m["src"]}" alt="{alt}" loading="lazy"{pos}></div>'
        else:
            media = f'<div class="csx-approach-media is-img"><img src="{m["src"]}" alt="{alt}" loading="lazy"></div>'
        if m.get('caption'):
            media = f'<figure class="csx-approach-fig">{media}<figcaption>{m["caption"]}</figcaption></figure>'
    idea = f'<p class="csx-idea">{ap["idea"]}</p>' if ap.get('idea') else ''
    steps = '<ol class="csx-steps">' + ''.join(f'<li>{x}</li>' for x in ap['steps']) + '</ol>'
    creative = ''
    if ap.get('creative_html'):
        creative = (f'<div class="csx-creative"><p class="kicker">{H.escape(ap.get("creative_label") or "The creative that ran")}</p>'
                    + ap['creative_html'] + '</div>')
    acls = 'csx-approach' + ('' if media else ' no-media') + (' has-img' if 'is-img' in media else '')
    approach = ('<section class="csx-band" style="padding-top:0"><div class="wrap">'
                f'<div class="{acls}">{media}<div><h2 class="csx-h">The Approach</h2>{idea}{steps}</div></div>'
                + creative + '</div></section>')

    early = mid = late = ''
    for i, x in enumerate(spec.get('extra_sections') or []):
        kick = f'<p class="kicker">{x["kicker"]}</p>' if x.get('kicker') else ''
        sec = (f'<section class="csx-band csx-extra{" alt" if i % 2 == 0 else ""}"><div class="wrap">'
               f'{kick}<h2 class="csx-h">{x["h2"]}</h2>{x["html"]}</div></section>')
        if x.get('place') == 'before_approach':
            early += sec
        elif x.get('place') == 'after_results':
            late += sec
        else:
            mid += sec

    r = spec['results']
    stats = ''.join(f'<div class="csx-result">{icon(x["icon"])}<div class="num">{H.escape(x["num"])}</div>'
                    f'<div class="what">{H.escape(x["what"])}</div><div class="ctx">{H.escape(x.get("ctx") or "")}</div></div>'
                    for x in r['stats'])
    results = (f'<section class="csx-band"><div class="wrap"><h2 class="csx-h">{H.escape(r.get("heading") or "The Results")}</h2>'
               + (f'<div class="csx-results-intro">{r["intro_html"]}</div>' if r.get('intro_html') else '')
               + f'<div class="csx-results">{stats}</div>'
               + (f'<div class="csx-proof"><p class="kicker">Real reports, not rounded-up claims</p>{r["proof_html"]}</div>' if r.get('proof_html') else '')
               + (f'<div class="csx-notes">{r["note_html"]}</div>' if r.get('note_html') else '')
               + '</div></section>')

    quote = ''
    if spec.get('quote_html'):
        quote = ('<section class="csx-band csx-extra alt"><div class="wrap"><h2 class="csx-h">In Their Words</h2>'
                 + spec['quote_html'] + '</div></section>')

    others = [re.sub(r' reveal(?=["\s])', '', mm.group(0))
              for mm in re.finditer(r'<a class="cs-feature[^"]*"[^>]*href="/case-studies/([^/"]+)/".*?</a>', idx, re.S)
              if mm.group(1) != slug]
    more = ('<section class="csx-band csx-more"><div class="wrap"><h2 class="csx-h">More Client Success Stories</h2>'
            '<div class="csx-loop"><button class="csx-arrow csx-prev" type="button" aria-label="Previous case study">&lsaquo;</button>'
            '<div class="csx-loop-track">' + ''.join(others) + '</div>'
            '<button class="csx-arrow csx-next" type="button" aria-label="Next case study">&rsaquo;</button></div>'
            '<p class="csx-note"><a href="/case-studies/" style="color:var(--blue);font-weight:700">See every case study &rarr;</a></p>'
            '</div></section>' + LOOP_JS)

    body = hero + postmeta + issue + goals + early + approach + mid + results + late + quote + more

    start = s.index('<div class="svc-page">') + len('<div class="svc-page">')
    fin = s.find('<section class="band svc-final">')
    if fin == -1:
        last_sec = s.rindex('</section>', 0, s.index('</main>')) + len('</section>')
        s = s[:start] + body + FINAL_REF + s[last_sec:]
    else:
        s = s[:start] + body + s[fin:]
        f0 = s.index('<section class="band svc-final">'); f1 = s.index('</section>', f0) + len('</section>')
        final = s[f0:f1]
        if 'tel:+17053021097' not in final:
            final = re.sub(r'(<button class="btn ghost" type="button" data-open-quiz>[^<]*</button>)',
                           r'\1<a class="btn ghost" href="tel:+17053021097">Call 705-302-1097</a>', final, count=1)
            s = s[:f0] + final + s[f1:]
    s = re.sub(r'<section class="csx-us">.*?</section><section class="band tight logo-band">.*?</section>', '', s, flags=re.S)
    f0 = s.index('<section class="band svc-final">'); f1 = s.index('</section>', f0) + len('</section>')
    us = US_REF
    # An anonymous case study must not sit above its own client's logo: drop
    # any listed logo cells from the client wall on this page only.
    for name in spec.get('hide_logos') or []:
        us = re.sub(r'<span class="logo-cell"><img src="[^"]*' + re.escape(name) + r'[^"]*"[^>]*></span>', '', us)
    s = s[:f1] + us + s[f1:]

    if 'case-study-v2.min.css' in s:
        s = re.sub(r'<link rel="stylesheet" href="/css/case-study-v2\.min\.css\?v=[0-9a-f]+">', V2_LINK, s)
    else:
        mm = re.search(r'<link rel="stylesheet" href="/css/case-study-v1\.min\.css\?v=[0-9a-f]+">', s)
        assert mm, 'no v1 stylesheet link on ' + path
        s = s[:mm.end()] + '\n' + V2_LINK + s[mm.end():]

    open(path, 'w', encoding='utf-8', newline='').write(s)
    print('built', slug, len(s), 'colour', colour)

for p in sys.argv[1:]:
    build(json.load(open(p, encoding='utf-8')))
