"""Refresh every case-study-v2 page after a case study is added or removed.

  python -I scripts/case-study-v2/refresh.py     (from the site repo root)

Each page's "More Client Success Stories" carousel becomes every card on
/case-studies/ except its own, and each page's css/case-study-v2.min.css link is
stamped with the current file's version (?v= = first 8 hex of its sha256).

It never rebuilds the .min.css. The site's minified files are produced by a
proper minifier (site audit, PR #207, 2026-11-17); a hand-rolled one here would
silently overwrite that. If case-study-v2.css changes, re-minify it with the
same tool first, then run this to re-stamp."""
import glob, hashlib, re

v = hashlib.sha256(open('css/case-study-v2.min.css', 'rb').read()).hexdigest()[:8]

idx = open('case-studies/index.html', encoding='utf-8').read()
cards = [(m.group(1), re.sub(r' reveal(?=["\s])', '', m.group(0)))
         for m in re.finditer(r'<a class="cs-feature[^"]*"[^>]*href="/case-studies/([^/"]+)/".*?</a>', idx, re.S)]

n = 0
for p in sorted(glob.glob('case-studies/*/index.html')):
    slug = p.replace('\\', '/').split('/')[1]
    s = open(p, encoding='utf-8', newline='').read()
    if 'csx-loop-track' not in s:
        continue
    a = s.index('<div class="csx-loop-track">') + len('<div class="csx-loop-track">')
    b = s.index('</div><button class="csx-arrow csx-next"', a)
    s = s[:a] + ''.join(h for sl, h in cards if sl != slug) + s[b:]
    s = re.sub(r'case-study-v2\.min\.css\?v=[0-9a-f]+', 'case-study-v2.min.css?v=' + v, s)
    open(p, 'w', encoding='utf-8', newline='').write(s)
    n += 1
print('v2', v, '| pages refreshed', n, '|', ', '.join(sl for sl, _ in cards))
