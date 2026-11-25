"""Put a case study's YouTube video on its page, in the one place videos go.

  python -I scripts/case-study-v2/add-video.py <slug> <youtube-id> "<lead line>" [--kicker "Watch the breakdown"]
  (from the site repo root)

WHERE: The Approach's media slot, left of the steps (above them on phones),
replacing whatever photo or clip was there. A blue kicker and one line sit
above the video, saying what the viewer gets. The owner chose this spot on
2026-11-25 out of five laid out on the Barrie Insulation page (in the hero,
a band under the hero, a split hero, after the results, and this). Every
case-study video goes here; don't re-decide it per page.

The lead line is written per case, for a customer: what the video walks
through and how long it is ("How the new site was built, and the numbers
behind it, in 6 minutes."). Never the keyword or the page's targeting.

HOW: click-to-play. The page loads only the YouTube thumbnail; pressing play
swaps in the youtube-nocookie player. A plain iframe would load YouTube's
player script on every visit to every case study, whether or not anyone
watches. The thumbnail is maxresdefault (1280x720), so this refuses a video
that has none rather than show a grey box.

Also writes a VideoObject JSON-LD block (name, description, upload date,
duration, thumbnail) read live from YouTube, so the video can show in search.
Re-running is safe: the output is the same, and a new id replaces the old video.
build.py calls apply() when a spec's approach.media is {"type": "youtube"}."""
import html as H, json, re, sys, urllib.request

UA = {'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en'}

PLAY_JS = ('<script data-csx-video>document.addEventListener("click",function(e){var b=e.target.closest(".csx-video-play");'
           'if(!b)return;var f=document.createElement("iframe");'
           'f.src="https://www.youtube-nocookie.com/embed/"+b.dataset.yt+"?autoplay=1&rel=0";'
           'f.title=b.dataset.title;f.allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";'
           'f.allowFullscreen=true;b.replaceWith(f)});</script>')


def fetch(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode('utf-8', 'replace')


def youtube_meta(vid):
    """Title, description, upload date and length, from YouTube itself. Fails loudly."""
    o = json.loads(fetch(f'https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={vid}&format=json'))
    page = fetch(f'https://www.youtube.com/watch?v={vid}')
    secs = re.search(r'"lengthSeconds":"(\d+)"', page)
    date = re.search(r'"uploadDate":"([^"]+)"', page) or re.search(r'<meta itemprop="uploadDate" content="([^"]+)"', page)
    desc = re.search(r'"shortDescription":"((?:[^"\\]|\\.)*)"', page)
    assert secs and date, f'could not read length/upload date for {vid} from YouTube'
    req = urllib.request.Request(f'https://i.ytimg.com/vi/{vid}/maxresdefault.jpg', method='HEAD', headers=UA)
    assert urllib.request.urlopen(req, timeout=30).status == 200, f'{vid} has no maxresdefault thumbnail'
    d = json.loads('"' + desc.group(1) + '"') if desc else ''
    return {'title': o['title'], 'seconds': int(secs.group(1)), 'date': date.group(1),
            'description': (d.split('\n\n')[0].strip() or o['title'])[:300]}


def apply(s, vid, lead, meta, kicker='Watch the breakdown'):
    """Return page HTML `s` with the video in The Approach's media slot."""
    t = H.escape(meta['title'])
    media = (f'<div class="csx-approach-media is-video"><p class="csx-video-lead"><span class="csx-video-kicker">{H.escape(kicker)}</span>'
             f'{H.escape(lead)}</p><div class="csx-video"><button type="button" class="csx-video-play" data-yt="{vid}" data-title="{t}" '
             f'aria-label="Play video: {t}"><img src="https://i.ytimg.com/vi/{vid}/maxresdefault.jpg" alt="" width="1280" height="720" '
             f'loading="lazy"><span class="csx-play" aria-hidden="true"></span></button></div></div>')
    s, n = re.subn(r'<div class="csx-approach[^"]*">.*?(?=<div><h2 class="csx-h">The Approach</h2>)',
                   lambda m: '<div class="csx-approach">' + media, s, count=1, flags=re.S)
    assert n == 1, 'no Approach section to put the video in'

    s = re.sub(r'<script data-csx-video>.*?</script>', '', s, flags=re.S)
    s = s.replace('</body>', PLAY_JS + '</body>', 1)

    m, sec = divmod(meta['seconds'], 60)
    ld = {'@context': 'https://schema.org', '@type': 'VideoObject', 'name': meta['title'],
          'description': meta['description'], 'uploadDate': meta['date'],
          'duration': f'PT{m}M{sec}S', 'thumbnailUrl': f'https://i.ytimg.com/vi/{vid}/maxresdefault.jpg',
          'embedUrl': f'https://www.youtube.com/embed/{vid}', 'contentUrl': f'https://www.youtube.com/watch?v={vid}'}
    s = re.sub(r'<script type="application/ld\+json" data-csx-video>.*?</script>\n?', '', s, flags=re.S)
    s = s.replace('</head>', '<script type="application/ld+json" data-csx-video>'
                  + json.dumps(ld, ensure_ascii=False) + '</script>\n</head>', 1)
    return s


if __name__ == '__main__':
    a = sys.argv[1:]
    kicker = 'Watch the breakdown'
    if '--kicker' in a:
        i = a.index('--kicker'); kicker = a[i + 1]; del a[i:i + 2]
    slug, vid, lead = a
    path = f'case-studies/{slug}/index.html'
    s = open(path, encoding='utf-8', newline='').read()
    meta = youtube_meta(vid)
    open(path, 'w', encoding='utf-8', newline='').write(apply(s, vid, lead, meta, kicker))
    print('video', vid, f'({meta["seconds"] // 60}:{meta["seconds"] % 60:02d})', 'on', path)
