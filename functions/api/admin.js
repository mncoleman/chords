// User management for this app's own list.
//
// Access is NOT shared with the mncoleman.com admin panel, and cannot be:
// Telegram issues a pairwise subject, a different identifier per OAuth client,
// so the same person is a different id here than there. This list stands alone.
//
// Nobody can be added ahead of time for the same reason — their subject is
// unknowable until they try to sign in. So the flow is request-then-approve:
// a first sign-in files a pending request, and the admin approves it here.
//
//   GET  /api/admin              -> { me, users, pending }
//   POST /api/admin              -> { action: approve | revoke | remove, sub }
//
// Every route is admin-only. The middleware has already established that the
// caller has a valid session; this checks that the session says admin.

import { verifyJwt } from './auth/[[route]].js';

const SESSION = 'chords_session';

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

async function requireAdmin({ request, env }) {
  const payload = await verifyJwt(cookie(request, SESSION), env.JWT_SECRET, 'session');
  if (!payload || !payload.sub) return { error: json({ error: 'Not signed in' }, 401) };
  const owner = String(payload.sub) === String(env.OWNER_SUB);
  if (!owner && !/admin/.test(String(payload.role || ''))) {
    return { error: json({ error: 'Admins only' }, 403) };
  }
  return { payload, owner };
}

/** KV list() paginates; a personal tool will never fill a page, but looping is
 *  two lines and silently truncating a user list is the kind of bug nobody
 *  notices until someone loses access. */
async function readAll(kv, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (raw) {
        try {
          out.push(JSON.parse(raw));
        } catch {
          /* a malformed entry should not take the whole list down */
        }
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

/** Look someone up on Telegram by numeric id.
 *
 *  Usernames do NOT work here, and that is Telegram's rule, not an oversight:
 *  getChat resolves @names for public channels and groups, but never for a
 *  private person — tested against an account that had messaged the bot. A
 *  numeric id works if the bot has met them.
 *
 *  The photo comes back as a data URI on purpose: the real file URL contains
 *  the bot token, so it must never reach the browser. */
async function telegramLookup(env, query) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { error: 'Telegram lookup is not configured (TELEGRAM_BOT_TOKEN)' };

  const api = (method, params) =>
    fetch(`https://api.telegram.org/bot${token}/${method}?${new URLSearchParams(params)}`).then((r) =>
      r.json()
    );

  const isId = /^\d+$/.test(query);
  const chat = await api('getChat', { chat_id: isId ? query : `@${query.replace(/^@/, '')}` });
  if (!chat.ok) {
    return {
      username: isId ? null : query.replace(/^@/, '').toLowerCase(),
      error: isId
        ? 'The bot has never met that id, so Telegram will not describe it.'
        : 'Telegram will not resolve a person by @username — only a numeric id. You can still invite the username; their name and picture fill in when they sign in.',
    };
  }

  const c = chat.result;
  let photo = null;
  const fileId = c.photo?.small_file_id;
  if (fileId) {
    const file = await api('getFile', { file_id: fileId });
    if (file.ok) {
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.result.file_path}`);
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        photo = `data:${res.headers.get('content-type') || 'image/jpeg'};base64,${btoa(bin)}`;
      }
    }
  }

  return {
    telegramId: String(c.id),
    username: (c.username || '').toLowerCase() || null,
    name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || null,
    photo,
  };
}

export async function onRequestGet(ctx) {
  const gate = await requireAdmin(ctx);
  if (gate.error) return gate.error;

  const kv = ctx.env.CHORDS_USERS;
  if (!kv) return json({ error: 'User store is not configured' }, 500);

  const q = new URL(ctx.request.url).searchParams.get('lookup');
  if (q !== null) {
    const clean = q.trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{3,64}$/.test(clean)) return json({ error: 'Enter a @username or numeric id' }, 400);
    return json(await telegramLookup(ctx.env, clean));
  }

  const [users, pending, invites] = await Promise.all([
    readAll(kv, 'user:'),
    readAll(kv, 'pending:'),
    readAll(kv, 'invite:'),
  ]);

  // The owner's own Telegram profile. Their OIDC subject says nothing about
  // which Telegram account it is, so the id is configured separately and the
  // bot is asked for the name and picture.
  let profile = null;
  if (gate.owner && ctx.env.OWNER_TELEGRAM_ID) {
    const found = await telegramLookup(ctx.env, String(ctx.env.OWNER_TELEGRAM_ID));
    if (!found.error) profile = found;
  }
  return json({
    me: {
      sub: String(gate.payload.sub),
      owner: gate.owner,
      name: gate.payload.name ?? null,
      username: gate.payload.username || null,
      profile,
    },
    ownerSub: String(ctx.env.OWNER_SUB || ''),
    users: users.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    pending: pending.sort((a, b) => (a.requestedAt || '').localeCompare(b.requestedAt || '')),
    invites: invites.sort((a, b) => (a.username || '').localeCompare(b.username || '')),
  });
}

export async function onRequestPost(ctx) {
  const gate = await requireAdmin(ctx);
  if (gate.error) return gate.error;

  const kv = ctx.env.CHORDS_USERS;
  if (!kv) return json({ error: 'User store is not configured' }, 500);

  let body;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: 'Expected JSON' }, 400);
  }

  const role = body.role === 'admin' ? 'admin' : 'user';

  // Grant access to someone who has never signed in here, by the Telegram
  // username in the token they will present. Claimed on their first sign-in.
  if (body.action === 'invite') {
    const username = String(body.username || '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,64}$/.test(username)) return json({ error: 'Invalid username' }, 400);
    const invite = {
      username,
      name: typeof body.name === 'string' ? body.name.slice(0, 120) : null,
      photo: typeof body.photo === 'string' && body.photo.startsWith('data:image/') ? body.photo.slice(0, 200_000) : null,
      telegramId: /^\d{1,20}$/.test(String(body.telegramId || '')) ? String(body.telegramId) : null,
      role,
      invitedAt: new Date().toISOString(),
      invitedBy: String(gate.payload.sub),
    };
    await kv.put(`invite:${username}`, JSON.stringify(invite));
    return json({ ok: true, invite });
  }

  if (body.action === 'uninvite') {
    const username = String(body.username || '').trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,64}$/.test(username)) return json({ error: 'Invalid username' }, 400);
    await kv.delete(`invite:${username}`);
    return json({ ok: true });
  }

  const sub = String(body.sub || '').trim();
  // Subjects are digit strings; anything else would be a key-injection attempt.
  if (!/^\d{1,32}$/.test(sub)) return json({ error: 'Invalid subject' }, 400);

  // The owner is granted by OWNER_SUB, not by this list. Editing them here
  // would look like it worked and change nothing.
  if (sub === String(ctx.env.OWNER_SUB)) return json({ error: 'That is the owner' }, 400);

  if (body.action === 'approve') {
    const raw = await kv.get(`pending:${sub}`);
    const existing = await kv.get(`user:${sub}`);
    const base = raw ? JSON.parse(raw) : existing ? JSON.parse(existing) : { sub };
    const user = {
      sub,
      name: base.name || null,
      username: base.username || null,
      photo: base.photo || null,
      role,
      status: 'active',
      addedAt: new Date().toISOString(),
      addedBy: String(gate.payload.sub),
    };
    await kv.put(`user:${sub}`, JSON.stringify(user));
    await kv.delete(`pending:${sub}`);
    return json({ ok: true, user });
  }

  if (body.action === 'revoke') {
    const raw = await kv.get(`user:${sub}`);
    if (!raw) return json({ error: 'No such user' }, 404);
    const user = JSON.parse(raw);
    user.status = 'revoked';
    user.revokedAt = new Date().toISOString();
    await kv.put(`user:${sub}`, JSON.stringify(user));
    // The middleware re-checks this on every request, so an open session in
    // someone's browser stops working immediately, not in 30 days.
    return json({ ok: true });
  }

  if (body.action === 'remove') {
    await kv.delete(`user:${sub}`);
    await kv.delete(`pending:${sub}`);
    return json({ ok: true });
  }

  return json({ error: 'Unknown action' }, 400);
}
