// Each person's own library: the charts they opened lately, and the folders
// they have saved charts into.
//
//   GET /api/library  -> { recents, folders }
//   PUT /api/library  -> the whole library, replaced; answers with what was kept
//
// One KV document per person, written whole. The page already holds the
// library and changes it locally before saving, so a whole-document write is
// the simplest thing that cannot interleave: KV reads are eventually
// consistent, and a read-modify-write here could apply an edit to a copy a
// minute old. Only the chart's id and names are kept; the chart itself is
// fetched fresh from UG whenever it is opened.

import { verifyJwt } from './auth/[[route]].js';

const SESSION = 'chords_session';
const MAX_RECENTS = 25;
const MAX_FOLDERS = 100;
const MAX_PER_FOLDER = 500;

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

const EMPTY = { recents: [], folders: [] };

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Display settings a set keeps, for the whole set or for one song in it.
 *  Only known keys with sane values survive; an empty result is dropped. */
function opts(o) {
  if (!o || typeof o !== 'object') return undefined;
  const out = {};
  if (o.instrument === 'piano' || o.instrument === 'guitar') out.instrument = o.instrument;
  if (typeof o.numbers === 'boolean') out.numbers = o.numbers;
  if (typeof o.condensed === 'boolean') out.condensed = o.condensed;
  if (typeof o.lineHeight === 'number' && o.lineHeight >= 1 && o.lineHeight <= 2) out.lineHeight = o.lineHeight;
  if (o.columns === 1 || o.columns === 2) out.columns = o.columns;
  if (Number.isInteger(o.semitones) && o.semitones >= -11 && o.semitones <= 11 && o.semitones !== 0) {
    out.semitones = o.semitones;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A chart as the library keeps it. Anything else the page sent is dropped. */
function chartRef(c, withOpts) {
  if (!c || !/^\d{1,12}$/.test(String(c.id))) return null;
  const r = { id: String(c.id), song: text(c.song, 200), artist: text(c.artist, 200) };
  const o = withOpts ? opts(c.opts) : undefined;
  return o ? { ...r, opts: o } : r;
}

function uniqueCharts(list, max, withOpts = false) {
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const r = chartRef(c, withOpts);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

/** Only what the page is allowed to store, at a size one person can use. */
function clean(body) {
  const folders = [];
  const ids = new Set();
  for (const f of Array.isArray(body?.folders) ? body.folders : []) {
    const id = String(f?.id || '');
    if (!/^[a-z0-9]{1,24}$/.test(id) || ids.has(id)) continue;
    const name = text(f.name, 60).trim();
    if (!name) continue;
    ids.add(id);
    const o = opts(f.opts);
    folders.push({ id, name, ...(o ? { opts: o } : {}), charts: uniqueCharts(f.charts, MAX_PER_FOLDER, true) });
    if (folders.length >= MAX_FOLDERS) break;
  }
  return { recents: uniqueCharts(body?.recents, MAX_RECENTS), folders };
}

async function whoami({ request, env }) {
  const payload = await verifyJwt(cookie(request, SESSION), env.JWT_SECRET, 'session');
  return payload && payload.sub ? String(payload.sub) : null;
}

export async function onRequestGet(ctx) {
  const sub = await whoami(ctx);
  if (!sub) return json({ error: 'Not signed in' }, 401);
  const kv = ctx.env.CHORDS_USERS;
  if (!kv) return json({ error: 'Library store is not configured' }, 500);
  const raw = await kv.get(`library:${sub}`);
  if (!raw) return json(EMPTY);
  try {
    return json(clean(JSON.parse(raw)));
  } catch {
    return json(EMPTY);
  }
}

export async function onRequestPut(ctx) {
  const sub = await whoami(ctx);
  if (!sub) return json({ error: 'Not signed in' }, 401);
  const kv = ctx.env.CHORDS_USERS;
  if (!kv) return json({ error: 'Library store is not configured' }, 500);
  let body;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: 'Expected JSON' }, 400);
  }
  const lib = clean(body);
  await kv.put(`library:${sub}`, JSON.stringify(lib));
  return json(lib);
}
