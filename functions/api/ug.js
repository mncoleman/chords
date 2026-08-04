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

/** UG's own ordering is not quality ordering. Rate by score weighted by how many
 *  people voted, so a lone 5-star tab loses to a 4.8 with two thousand votes. */
function rank(tabs) {
  return [...tabs]
    .filter((t) => t.type_name === 'Chords' || t.type === TYPE_CHORDS || !t.type_name)
    .map((t) => ({
      id: t.id,
      song: t.song_name,
      artist: t.artist_name,
      rating: Number(t.rating) || 0,
      votes: Number(t.votes) || 0,
      verified: Boolean(t.verified || t.tab_access_type === 'verified'),
      version: t.version ?? null,
      url: t.tab_url ?? null,
      score: (Number(t.rating) || 0) * Math.log10((Number(t.votes) || 0) + 1),
    }))
    .sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || b.score - a.score);
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

    if (!q) return json({ error: 'Provide q (search) or id (tab)' }, 400);
    if (q.length > 200) return json({ error: 'Query too long' }, 400);

    const res = await fetch(
      `${UG_API}/tab/search?title=${encodeURIComponent(q)}&page=1&type[]=${TYPE_CHORDS}`,
      { headers }
    );
    if (!res.ok) return json({ error: `Ultimate Guitar returned ${res.status}` }, 502);

    const data = await res.json();
    const tabs = data.tabs || data.data?.tabs || [];
    return json({ results: rank(tabs).slice(0, 20) }, 200, 'private, max-age=3600');
  } catch (e) {
    return json({ error: e.message || 'Lookup failed' }, 500);
  }
}
