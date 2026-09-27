// Listen: a few seconds of a room singing, turned into the words being sung.
//
//   POST /api/listen   body: one short recording (audio/webm or audio/mp4)
//                      -> { text }
//
// The words then go to /api/lyrics like anything typed. Whisper runs on
// Workers AI (@cf/openai/whisper-large-v3-turbo), billed per audio minute, so
// this is only open to people the admin has switched Listen on for.

import { verifyJwt, featuresFor } from './auth/[[route]].js';

const SESSION = 'chords_session';
const MAX_BYTES = 3 * 1024 * 1024;

function cookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** What Whisper says over music when nobody is singing: lines from the videos
 *  it was trained on, not from the room. */
const INVENTED = /thank(s| you) for watching|subscribe|like and share|see you (in the )?next|♪|\[(music|applause)\]|\(music\)/i;

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function onRequestPost({ request, env }) {
  const payload = await verifyJwt(cookie(request, SESSION), env.JWT_SECRET, 'session');
  if (!payload?.sub) return json({ error: 'Not signed in' }, 401);
  if (!(await featuresFor(env, payload.sub)).includes('listen')) return json({ error: 'Listen is not switched on for you' }, 403);
  if (!env.AI) return json({ error: 'Transcription is not configured' }, 500);

  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length) return json({ text: '' });
  if (buf.length > MAX_BYTES) return json({ error: 'Recording too long' }, 413);

  try {
    const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: toBase64(buf),
      language: 'en',
      // Drops the stretches with no voice, which is where Whisper invents text.
      vad_filter: true,
      initial_prompt: 'Worship song lyrics, sung by a group.',
    });
    const text = String(out?.text ?? out?.transcription_info?.text ?? '').trim();
    return json({ text: INVENTED.test(text) ? '' : text });
  } catch (e) {
    return json({ error: `Transcription failed: ${e?.message || e}` }, 502);
  }
}
