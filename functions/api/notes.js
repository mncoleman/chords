// Each person's notes on a chart, and their drawing preferences.
//
//   GET /api/notes?id=<tab id>    -> { text, ink, updated }
//   PUT /api/notes?id=<tab id>    -> the chart's notes, replaced whole
//   GET /api/notes?prefs=1        -> { color, width, textSize, pencilOnly }
//   PUT /api/notes?prefs=1        -> the preferences, replaced whole
//
// One KV document per person per chart, written whole for the same reason the
// library is: the page holds the notes and edits them locally, and KV's reads
// are too eventually consistent for a read-modify-write. Ink is stored as the
// page describes it (strokes and text boxes pinned to a line of the chart),
// checked here only for shape and size.

import { verifyJwt } from './auth/[[route]].js';

const SESSION = 'chords_session';
const MAX_TEXT = 20000;
const MAX_ITEMS = 1500;
const MAX_POINTS = 4000; // per stroke, x and y counted together
const MAX_BYTES = 600000;

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

const COLOR = /^#[0-9a-f]{6}$/i;
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const round = (v) => Math.round(v * 10) / 10;

/** One stroke or text box, or null if it is not one. */
function item(it) {
  if (!it || typeof it !== 'object') return null;
  const a = Number.isInteger(it.a) && it.a >= -1 && it.a < 100000 ? it.a : null;
  if (a === null || !COLOR.test(it.c || '')) return null;
  if (it.k === 's') {
    if (!num(it.w, 0.5, 60) || !Array.isArray(it.p) || it.p.length < 2 || it.p.length > MAX_POINTS) return null;
    if (it.p.length % 2 || !it.p.every((v) => num(v, -20000, 20000))) return null;
    return { k: 's', a, c: it.c, w: round(it.w), ...(it.h ? { h: 1 } : {}), p: it.p.map(round) };
  }
  if (it.k === 't') {
    const t = typeof it.t === 'string' ? it.t.slice(0, 2000) : '';
    if (!t.trim() || !num(it.x, -20000, 20000) || !num(it.y, -20000, 20000) || !num(it.s, 8, 64)) return null;
    return { k: 't', a, c: it.c, s: round(it.s), x: round(it.x), y: round(it.y), t };
  }
  return null;
}

function cleanNotes(body) {
  const ink = [];
  for (const it of Array.isArray(body?.ink) ? body.ink : []) {
    const ok = item(it);
    if (ok) ink.push(ok);
    if (ink.length >= MAX_ITEMS) break;
  }
  // Chord changes: "<line>:<chord>" -> a chord symbol, a few hundred at most.
  const chords = {};
  if (body?.chords && typeof body.chords === 'object') {
    for (const [k, v] of Object.entries(body.chords).slice(0, 500)) {
      if (/^\d{1,6}:\d{1,3}$/.test(k) && typeof v === 'string' && /^(N\.?C\.?|[A-G][#b]?[^\s<>"'&]{0,15})$/.test(v)) {
        chords[k] = v;
      }
    }
  }
  return {
    text: typeof body?.text === 'string' ? body.text.slice(0, MAX_TEXT) : '',
    ink,
    chords,
    updated: num(body?.updated, 0, 1e14) ? body.updated : Date.now(),
  };
}

const DEFAULT_PREFS = { color: '#e5484d', width: 3, textSize: 16, pencilOnly: false };

function cleanPrefs(body) {
  return {
    color: COLOR.test(body?.color || '') ? body.color : DEFAULT_PREFS.color,
    width: num(body?.width, 1, 30) ? body.width : DEFAULT_PREFS.width,
    textSize: num(body?.textSize, 10, 40) ? body.textSize : DEFAULT_PREFS.textSize,
    pencilOnly: typeof body?.pencilOnly === 'boolean' ? body.pencilOnly : DEFAULT_PREFS.pencilOnly,
  };
}

async function whoami({ request, env }) {
  const payload = await verifyJwt(cookie(request, SESSION), env.JWT_SECRET, 'session');
  return payload && payload.sub ? String(payload.sub) : null;
}

/** Which document a request is about, or an error response. */
function target(request, sub) {
  const url = new URL(request.url);
  if (url.searchParams.has('prefs')) return { key: `noteprefs:${sub}`, prefs: true };
  const id = (url.searchParams.get('id') || '').trim();
  if (!/^\d{1,12}$/.test(id)) return { error: json({ error: 'Invalid chart id' }, 400) };
  return { key: `notes:${sub}:${id}`, prefs: false };
}

export async function onRequestGet(ctx) {
  const sub = await whoami(ctx);
  if (!sub) return json({ error: 'Not signed in' }, 401);
  const kv = ctx.env.CHORDS_USERS;
  if (!kv) return json({ error: 'Notes store is not configured' }, 500);
  const t = target(ctx.request, sub);
  if (t.error) return t.error;
  const raw = await kv.get(t.key);
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    /* treated as nothing saved */
  }
  if (t.prefs) return json(cleanPrefs(body));
  return json(body ? cleanNotes(body) : { text: '', ink: [], chords: {}, updated: 0 });
}

export async function onRequestPut(ctx) {
  const sub = await whoami(ctx);
  if (!sub) return json({ error: 'Not signed in' }, 401);
  const kv = ctx.env.CHORDS_USERS;
  if (!kv) return json({ error: 'Notes store is not configured' }, 500);
  const t = target(ctx.request, sub);
  if (t.error) return t.error;
  let body;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: 'Expected JSON' }, 400);
  }
  const clean = t.prefs ? cleanPrefs(body) : cleanNotes(body);
  const out = JSON.stringify(clean);
  if (out.length > MAX_BYTES) return json({ error: 'Too much ink on one chart. Erase some and try again.' }, 413);
  // A chart with nothing on it is not worth keeping a key for.
  if (!t.prefs && !clean.text && !clean.ink.length && !Object.keys(clean.chords).length) await kv.delete(t.key);
  else await kv.put(t.key, out);
  return json(clean);
}
