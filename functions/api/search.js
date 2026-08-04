// Spotify track suggestions.
//
// Same shape as collaby's /api/search: the browser only ever talks to this
// origin, and the client secret stays server-side. Spotify's client-credentials
// flow requires that secret, so it can never live in a static bundle — this
// function is the reason the rest of the site can stay static.
//
// Cloudflare Pages Function. Set in the Pages project settings:
//   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET   (encrypted)

/** Tokens last an hour; cache in module scope so a warm isolate reuses one. */
let cachedToken = null;
let tokenExpiry = 0;

async function getToken(env) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const id = env.SPOTIFY_CLIENT_ID;
  const secret = env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Spotify credentials are not configured');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Workers have no Buffer; btoa is the equivalent here.
      Authorization: 'Basic ' + btoa(`${id}:${secret}`),
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify token request failed (${res.status})`);

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
  return cachedToken;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  const json = (body, status = 200, cache = 'no-store') =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
    });

  if (!q) return json({ error: 'Query parameter "q" is required' }, 400);
  if (q.length > 200) return json({ error: 'Query too long' }, 400);

  try {
    const token = await getToken(env);
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=12`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (res.status === 429) {
      // Pass Spotify's own backoff through rather than inventing one.
      const retry = res.headers.get('Retry-After') || '5';
      return new Response(JSON.stringify({ error: 'Rate limited', retryAfter: retry }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': retry },
      });
    }
    if (res.status === 401) {
      cachedToken = null; // force a refresh on the next call
      return json({ error: 'Spotify auth expired, try again' }, 503);
    }
    if (!res.ok) return json({ error: `Spotify search failed (${res.status})` }, 502);

    const data = await res.json();
    const tracks = (data.tracks?.items || []).map((t) => ({
      id: t.id,
      title: t.name,
      artist: (t.artists || []).map((a) => a.name).join(', '),
      album: t.album?.name ?? null,
      year: (t.album?.release_date || '').slice(0, 4) || null,
      art: t.album?.images?.length ? t.album.images[t.album.images.length - 1].url : null,
    }));

    // Suggestions for the same query are stable; let the edge absorb repeats.
    return json({ tracks }, 200, 'private, max-age=3600');
  } catch (e) {
    return json({ error: e.message || 'Search failed' }, 500);
  }
}
