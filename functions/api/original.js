// Who a song is really by: its writers, and the artist who recorded it first.
//
//   GET /api/original?title=<song>&artist=<one performer of it>[&also=<a>|<b>…]
//     -> { writers, original: { artist, year } | null, cover, performers }
//
// `also` names other artists with a recording of the same TITLE, and
// `performers` answers which of them (and `artist`) are confirmed to be
// performing this same song. A title is not a song: Leonard Cohen's
// "Hallelujah" and Forrest Frank's share nothing but the word, and labelling
// the second a cover of the first would be wrong. Unconfirmed is left out.
//
// Spotify lists a dozen recordings of a title and says nothing about which one
// is the song and which are covers. MusicBrainz does: every recording links to
// the "work" it performs, a cover is marked as one on that link, and the work
// carries its composers and lyricists. So from any one performance of a song,
// three lookups give the rest:
//
//   1. find that performance (search by title and artist)
//   2. its work, and whether this performance is marked a cover
//   3. the work's writers and every performance of it; the earliest dated one
//      not marked a cover is the original, and one more lookup names its artist
//
// MusicBrainz asks for a descriptive User-Agent and about one request a second,
// so answers are edge-cached for a long time: who wrote a song does not change.
//
// Its catalogue is thin on worship and recent independent releases. When it
// knows nothing, Genius is asked instead (the same GENIUS_TOKEN as
// /api/lyrics): its song pages list the writers and, for a cover, the song it
// is a cover of.

const MB = 'https://musicbrainz.org/ws/2';
const UA = 'chords/1.0 ( https://github.com/mncoleman/chords )';
const CACHE = 'private, max-age=604800';

const json = (body, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** One MusicBrainz call. A 503 is its rate limiter; one retry after a second
 *  is what it asks for, and a second refusal is an answer of "not now". */
async function mb(path) {
  for (let tries = 0; tries < 2; tries++) {
    const res = await fetch(`${MB}${path}${path.includes('?') ? '&' : '?'}fmt=json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (res.ok) return res.json();
    if (res.status !== 503) throw new Error(`MusicBrainz returned ${res.status}`);
    await pause(1100);
  }
  throw new Error('MusicBrainz is busy');
}

/** Lucene escaping for a phrase inside double quotes. */
const phrase = (s) => `"${s.replace(/["\\]/g, '\\$&')}"`;

/** Titles compare loose: case, punctuation and "the" are not the song. */
const norm = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bthe\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const credit = (ac) => (ac || []).map((c) => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('').trim();

const edge = () => (typeof caches !== 'undefined' ? caches.default : null);

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const title = (url.searchParams.get('title') || '').trim();
  const artist = (url.searchParams.get('artist') || '').trim();
  const also = (url.searchParams.get('also') || '')
    .split('|')
    .map((a) => a.trim())
    .filter((a) => a && a.length <= 200 && norm(a) !== norm(artist))
    .slice(0, 8);
  if (!title || !artist) return json({ error: 'title and artist are required' }, 400);
  if (title.length > 200 || artist.length > 200) return json({ error: 'Query too long' }, 400);

  const key = new Request(url.toString(), { method: 'GET' });
  const c = edge();
  if (c) {
    try {
      const hit = await c.match(key);
      if (hit) return json(await hit.json(), 200, CACHE);
    } catch {
      /* a cache miss by another name */
    }
  }

  try {
    let body = await lookup(title, artist, also).catch(() => null);
    if (!body || (!body.writers.length && !body.original)) {
      body = (env?.GENIUS_TOKEN && (await genius(title, artist, env.GENIUS_TOKEN).catch(() => null))) || body;
    }
    if (!body) throw new Error('MusicBrainz is unavailable');
    // A song nobody has catalogued may be catalogued tomorrow, so only real
    // answers are shared; the browser still keeps the empty one for an hour.
    const found = body.writers.length || body.original;
    if (c && found) {
      const copy = new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=2592000' },
      });
      const put = c.put(key, copy).catch(() => {});
      if (waitUntil) waitUntil(put);
    }
    return json(body, 200, found ? CACHE : 'private, max-age=3600');
  } catch (e) {
    return json({ error: e.message || 'Lookup failed' }, 502);
  }
}

async function lookup(title, artist, also = []) {
  const none = { writers: [], original: null, cover: null, performers: [] };

  // 1. This performance. Search ranks loosely, so keep only exact titles.
  const found = await mb(
    `/recording?query=${encodeURIComponent(`recording:${phrase(title)} AND artist:${phrase(artist)}`)}&limit=10`
  );
  const want = norm(title);
  const candidates = (found.recordings || []).filter((r) => norm(r.title) === want).slice(0, 3);
  if (!candidates.length) return none;

  // 2. Its work. Not every recording is linked to one; the next match may be.
  let work = null;
  let cover = null;
  for (const r of candidates) {
    const rec = await mb(`/recording/${r.id}?inc=work-rels`);
    const rel = (rec.relations || []).find((x) => x['target-type'] === 'work' && x.work);
    if (rel) {
      work = rel.work;
      cover = (rel.attributes || []).includes('cover');
      break;
    }
  }
  if (!work) return none;

  // 3. Writers, and the first performance that is not a cover. Live takes and
  //    covers are both later by nature, but a live take is still the writer's
  //    own; it only loses to a dated studio take.
  const w = await mb(`/work/${work.id}?inc=artist-rels+recording-rels`);
  const rels = w.relations || [];
  const writers = [];
  for (const r of rels) {
    if (r['target-type'] !== 'artist' || !r.artist) continue;
    if (!['composer', 'lyricist', 'writer'].includes(r.type)) continue;
    if (!writers.includes(r.artist.name)) writers.push(r.artist.name);
  }

  const takes = rels
    .filter((r) => r['target-type'] === 'recording' && r.recording && r.begin)
    .filter((r) => !(r.attributes || []).includes('cover'))
    .sort((a, b) => {
      const live = Number((a.attributes || []).includes('live')) - Number((b.attributes || []).includes('live'));
      return live || a.begin.localeCompare(b.begin);
    });

  let original = null;
  if (takes.length) {
    const first = takes[0];
    const rec = await mb(`/recording/${first.recording.id}?inc=artist-credits`);
    const name = credit(rec['artist-credit']);
    if (name) original = { artist: name, year: first.begin.slice(0, 4) };
  }

  // 4. Which of the other artists sing THIS song: one search for the title
  //    by any of them, kept where the recording is one of this work's.
  const performers = [artist];
  if (also.length) {
    const ids = new Set(rels.filter((r) => r['target-type'] === 'recording' && r.recording).map((r) => r.recording.id));
    const q = `recording:${phrase(title)} AND (${also.map((a) => `artist:${phrase(a)}`).join(' OR ')})`;
    try {
      const res = await mb(`/recording?query=${encodeURIComponent(q)}&limit=100`);
      for (const r of res.recordings || []) {
        if (!ids.has(r.id)) continue;
        const by = norm(credit(r['artist-credit']));
        for (const a of also) {
          if (!performers.includes(a) && by.includes(norm(a))) performers.push(a);
        }
      }
    } catch {
      /* the asked-for artist is still confirmed; the others stay unknown */
    }
  }

  return { writers, original, cover, performers };
}

/** The fallback. Genius answers search with title and primary artist, and the
 *  song itself with its writers and what it covers. */
async function genius(title, artist, token) {
  const get = async (path) => {
    const res = await fetch(`https://api.genius.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Genius returned ${res.status}`);
    return (await res.json()).response;
  };
  const found = await get(`/search?q=${encodeURIComponent(`${title} ${artist}`)}&per_page=10`);
  const want = norm(title);
  const hit = (found?.hits || []).find((h) => h.type === 'song' && h.result && norm(h.result.title) === want);
  if (!hit) return null;

  const song = (await get(`/songs/${hit.result.id}?text_format=plain`))?.song;
  if (!song) return null;
  const writers = (song.writer_artists || []).map((a) => a.name).filter(Boolean);
  const of = (song.song_relationships || []).find((r) => r.relationship_type === 'cover_of')?.songs?.[0];
  const year = (s) => (s?.release_date_components?.year ? String(s.release_date_components.year) : null);
  // Genius links few covers, so "not linked as a cover" is weak evidence. The
  // performer only counts as the original when they also wrote it.
  const own = song.primary_artist?.name && writers.some((w) => norm(w) === norm(song.primary_artist.name));
  const original = of?.primary_artist?.name
    ? { artist: of.primary_artist.name, year: year(of) }
    : own
      ? { artist: song.primary_artist.name, year: year(song) }
      : null;
  return { writers, original, cover: Boolean(of), performers: [artist] };
}
