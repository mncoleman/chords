// Resolve Spotify track ids to titles/artists.
//
// The catalogue is keyed by track id, so a shared or bookmarked URL carries an
// id and nothing else. This turns it back into something readable without the
// visitor having to search again.

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
  // Spotify ids are 22 chars of base62; reject anything else rather than
  // forwarding arbitrary strings upstream.
  const ids = (url.searchParams.get('ids') || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9]{22}$/.test(s))
    .slice(0, 50);

  const json = (body, status = 200, cache = 'no-store') =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
    });

  if (!ids.length) return json({ error: 'ids parameter is required' }, 400);

  try {
    const token = await getToken(env);
    const res = await fetch(`https://api.spotify.com/v1/tracks?ids=${ids.join(',')}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      cachedToken = null;
      return json({ error: 'Spotify auth expired, try again' }, 503);
    }
    if (!res.ok) return json({ error: `Spotify lookup failed (${res.status})` }, 502);

    const data = await res.json();
    const tracks = (data.tracks || []).filter(Boolean).map((t) => ({
      id: t.id,
      title: t.name,
      artist: (t.artists || []).map((a) => a.name).join(', '),
      album: t.album?.name ?? null,
      year: (t.album?.release_date || '').slice(0, 4) || null,
      art: t.album?.images?.length ? t.album.images[t.album.images.length - 1].url : null,
    }));

    // A track's title never changes; cache hard.
    return json({ tracks }, 200, 'public, max-age=86400');
  } catch (e) {
    return json({ error: e.message || 'Lookup failed' }, 500);
  }
}
