// Songs that match a line of their lyrics, for someone who remembers the words
// but not the title.
//
//   GET /api/lyrics?q=<words>   -> { tracks: [{ title, artist, artists, art, year }] }
//
// Genius's search matches lyrics as well as titles, and needs an access token
// (free; Pages secret GENIUS_TOKEN). Its site search blocks server requests, so
// the official API is the only way in. Without the token this answers with no
// tracks rather than an error, so the search box works as it did before.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function onRequestGet({ request, env }) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  if (!q) return json({ error: 'Query parameter "q" is required' }, 400);
  if (q.length > 200) return json({ error: 'Query too long' }, 400);
  if (!env.GENIUS_TOKEN) return json({ tracks: [], configured: false });

  try {
    const res = await fetch(`https://api.genius.com/search?q=${encodeURIComponent(q)}&per_page=8`, {
      headers: { Authorization: `Bearer ${env.GENIUS_TOKEN}` },
    });
    if (!res.ok) return json({ tracks: [], error: `Genius search failed (${res.status})` });
    const data = await res.json();
    const tracks = (data.response?.hits || [])
      .filter((h) => h.type === 'song' && h.result)
      .map(({ result: r }) => ({
        id: `genius-${r.id}`,
        title: r.title,
        artist: r.artist_names || r.primary_artist?.name || '',
        // UG files a song under one artist, so the primary one goes alone.
        artists: r.primary_artist?.name ? [r.primary_artist.name] : [],
        art: r.song_art_image_thumbnail_url || null,
        year: r.release_date_components?.year ? String(r.release_date_components.year) : null,
      }));
    return json({ tracks });
  } catch (e) {
    return json({ tracks: [], error: String(e?.message || e) });
  }
}
