// Ultimate Guitar chord sheets.
//
// UG's mobile API is unauthenticated but signed: every request carries a random
// device id plus X-UG-API-KEY = MD5(deviceId + "YYYY-MM-DD:H" (UTC) + "createLog()").
// The hour is part of the payload, so a key is only valid for the hour it was
// minted in — hence no caching of the key itself.
//
// This runs server-side for two reasons: UG sends no CORS headers, so a browser
// fetch is impossible; and the signing keeps the request shaped like the app's.
//
//   GET /api/ug?q=<song>            search, ranked
//   GET /api/ug?id=<tab id>         one chord sheet
//
// Cloudflare's crypto.subtle supports MD5 as a non-standard extension, which is
// what makes the signature possible in a Worker at all.

const UG_API = 'https://api.ultimate-guitar.com/api/v1';
// 300 = chords. Tabs, bass and ukulele are different type ids; chords is what a
// chord chart wants.
const TYPE_CHORDS = 300;

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ugHeaders() {
  const raw = crypto.getRandomValues(new Uint8Array(8));
  const deviceId = hex(raw.buffer);

  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const stamp = `${n.getUTCFullYear()}-${p(n.getUTCMonth() + 1)}-${p(n.getUTCDate())}:${n.getUTCHours()}`;

  const digest = await crypto.subtle.digest(
    'MD5',
    new TextEncoder().encode(`${deviceId}${stamp}createLog()`)
  );

  return {
    'X-UG-CLIENT-ID': deviceId,
    'X-UG-API-KEY': hex(digest),
    Accept: 'application/json',
    'User-Agent': 'UG_ANDROID/7.1.3 (Pixel; Android 13)',
  };
}

/** Words, lowercased, punctuation and accents gone. "Don't" and "dont" are the
 *  same word to anyone searching. */
function words(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** How much of what was asked for is present, 0 to 1. Dice over word sets, with
 *  a prefix counting as a hit so "Brandon Lak" still matches Brandon Lake. */
function similarity(got, want) {
  const a = words(got);
  const b = words(want);
  if (!a.length || !b.length) return 0;
  let hits = 0;
  for (const w of b) {
    if (a.some((x) => x === w || (w.length > 3 && (x.startsWith(w) || w.startsWith(x))))) hits++;
  }
  return (2 * hits) / (a.length + b.length);
}

/** Titles carry things a chord chart never does: "- Live", "(feat. …)", a remaster
 *  note. They are in Spotify's title and not in UG's, so they only ever cost
 *  matches. */
function normalizeTitle(title) {
  return (title || '')
    .replace(/\s*[-–—]\s*(live|radio edit|single version|remaster(ed)?[^,]*|.*version)\s*$/i, '')
    .replace(/\s*[([](feat\.?|ft\.?|with)[^)\]]*[)\]]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** UG's own ordering is not quality ordering, and quality is not relevance.
 *
 *  Rating weighted by how many people voted says which chart of a song is best;
 *  it says nothing about whether it is the right song. Sorting by that alone put
 *  a verified chart of a different song that happens to share a title above the
 *  one actually asked for. So relevance to the title and artist leads, and
 *  quality — rating, votes, UG's verified mark — breaks the ties within it. */
function rank(tabs, want = {}) {
  const asked = want.title || want.raw || '';
  return [...tabs]
    .filter((t) => t.type_name === 'Chords' || t.type === TYPE_CHORDS || !t.type_name)
    .map((t) => {
      const rating = Number(t.rating) || 0;
      const votes = Number(t.votes) || 0;
      const verified = Boolean(t.verified || t.tab_access_type === 'verified');
      const titleFit = asked ? similarity(t.song_name, asked) : 1;
      const artistFit = want.artist ? similarity(t.artist_name, want.artist) : 0;
      // Rating is out of 5 and votes are unbounded; over ten thousand votes the
      // log flattens, which is the point — quality should never outweigh being
      // the right song.
      const quality = (rating / 5) * Math.min(1, Math.log10(votes + 1) / 4) + (verified ? 0.3 : 0);
      return {
        id: t.id,
        song: t.song_name,
        artist: t.artist_name,
        rating,
        votes,
        verified,
        version: t.version ?? null,
        url: t.tab_url ?? null,
        titleFit,
        score: titleFit * 3 + artistFit * 2 + quality,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** UG wraps chords and tab blocks in [ch]/[tab] markup; strip it for display. */
function clean(content) {
  return (content || '').replace(/\[\/?(ch|tab)\]/g, '').replace(/\r\n/g, '\n');
}

const json = (body, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  });

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const id = (url.searchParams.get('id') || '').trim();

  try {
    const headers = await ugHeaders();

    if (id) {
      if (!/^\d{1,12}$/.test(id)) return json({ error: 'Invalid tab id' }, 400);
      const res = await fetch(
        `${UG_API}/tab/info?tab_id=${encodeURIComponent(id)}&tab_access_type=public`,
        { headers }
      );
      if (!res.ok) return json({ error: `Ultimate Guitar returned ${res.status}` }, 502);
      const t = await res.json();
      const content = clean(t.content || t.tab_view?.wiki_tab?.content || '');
      if (!content) return json({ error: 'That tab has no chord content' }, 404);

      return json(
        {
          id: t.id,
          song: t.song_name,
          artist: t.artist_name,
          key: t.tonality_name || null,
          capo: t.capo ?? null,
          tuning: t.tuning?.name ?? null,
          version: t.version ?? null,
          rating: t.rating ?? null,
          votes: t.votes ?? null,
          url: t.tab_url ?? null,
          content,
        },
        200,
        // A given tab revision is immutable; let the edge hold it.
        'private, max-age=86400'
      );
    }

    const title = (url.searchParams.get('title') || '').trim();
    const artist = (url.searchParams.get('artist') || '').trim();

    if (!q && !title) return json({ error: 'Provide q or title (search), or id (tab)' }, 400);
    if (q.length > 200 || title.length > 200 || artist.length > 200)
      return json({ error: 'Query too long' }, 400);

    // The rungs, most precise first. Each is only tried when the one above it
    // came back empty.
    //
    // The artist is a filter on the way down and a ranking hint at the bottom,
    // never a filter at the bottom: the whole reason a search fails is that the
    // artist you asked for did not write the song. Pentatonix sing Amazing
    // Grace; UG files it under Chris Tomlin. Filtering by Pentatonix finds
    // nothing, so the last rungs drop the filter and let the chart by whoever
    // wrote it come up, ranked with the artist still counting for something.
    const plain = normalizeTitle(title);
    const rungs = title
      ? [
          { by: 'exact', title, artist },
          ...(plain && plain !== title ? [{ by: 'normalized', title: plain, artist }] : []),
          { by: 'title', title },
          ...(plain && plain !== title ? [{ by: 'normalized-title', title: plain }] : []),
        ]
      : [{ by: 'typed', title: q }, ...(normalizeTitle(q) !== q ? [{ by: 'normalized', title: normalizeTitle(q) }] : [])];

    let results = [];
    let matched = null;

    for (const rung of rungs) {
      const params = new URLSearchParams({ title: rung.title, page: '1' });
      // UG's own filter. Not the `artist` parameter, which it silently ignores.
      if (rung.artist) params.set('artist_name', rung.artist);
      const res = await fetch(`${UG_API}/tab/search?${params}&type[]=${TYPE_CHORDS}`, {
        headers,
        // A 302 is how UG's search backend says "no match"; following it lands
        // on a page that is not JSON.
        redirect: 'manual',
      });

      // 404 and 302 are both UG saying it found nothing. Treating them as
      // failures — which is what a bare !res.ok does — turned every empty search
      // into "Search failed: Ultimate Guitar returned 404" and made the
      // fallbacks below unreachable.
      if (res.status === 404 || res.status === 302 || res.status === 301) continue;
      if (!res.ok) return json({ error: `Ultimate Guitar returned ${res.status}` }, 502);

      const data = await res.json();
      const tabs = data.tabs || data.data?.tabs || [];
      // Rank the whole page before cutting it down: the right chart is regularly
      // outside UG's own first twenty, and nothing downstream can rank a result
      // it was never sent.
      const ranked = rank(tabs, { title: title || q, artist, raw: q });
      if (!ranked.length) continue;
      results = ranked;
      matched = rung.by;
      break;
    }

    return json(
      {
        results: results.slice(0, 20),
        // Which rung answered, so the page can say it looked for one thing and
        // is showing another rather than pretending this is what was asked for.
        matched,
        asked: { title: title || q, artist: artist || null },
      },
      200,
      'private, max-age=3600'
    );
  } catch (e) {
    return json({ error: e.message || 'Lookup failed' }, 500);
  }
}
