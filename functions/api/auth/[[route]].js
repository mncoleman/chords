// Telegram OAuth, mirroring the flow mncoleman.com already uses.
//
// Same bot (@mncolemandotcombot), same OIDC endpoints, same PKCE dance. The
// session is a short HS256 JWT in an HttpOnly cookie; nothing sensitive ever
// reaches the page.
//
//   GET /api/auth/login     -> Telegram
//   GET /api/auth/callback  -> exchange, verify, set session
//   GET /api/auth/me        -> who am I (used to decide login vs app)
//   GET /api/auth/logout    -> clear session
//
// Secrets (Pages project settings): TELEGRAM_BOT_ID, TELEGRAM_CLIENT_SECRET,
// JWT_SECRET, OWNER_SUB.

const enc = new TextEncoder();
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** Every token carries what it is FOR. Two purposes shared one secret and no
 *  purpose claim, so the short-lived PKCE stash — handed to any anonymous
 *  caller by /api/auth/login — verified as a session and walked straight past
 *  the gate. A token is now only ever accepted for the job it was minted for. */
async function signJwt(payload, secret, ttlSeconds = 60 * 60 * 24 * 30, typ = 'session') {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, typ, iat: now, exp: now + ttlSeconds };
  const head = b64urlStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64urlStr(JSON.stringify(body))}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

export async function verifyJwt(token, secret, expectedTyp = 'session') {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const sig = Uint8Array.from(fromB64url(parts[2]), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(data));
  if (!ok) return null;
  try {
    const payload = JSON.parse(fromB64url(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    // A token minted for one purpose must never satisfy another.
    if (payload.typ !== expectedTyp) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** Verify Telegram's id_token against its JWKS.
 *
 *  Telegram publishes FOUR keys with different algorithms — RS256 (RSA), ES256
 *  (EC), EdDSA (OKP) and ES256K — and signs with whichever it likes. Importing
 *  every key as RSA throws `DataError: Invalid JWK "kty" Parameter`, which is
 *  what produced a bare Cloudflare 1101 on the callback.
 *
 *  The key is now chosen strictly by `kid` with NO fallback. Falling back to
 *  keys[0] was also an algorithm-confusion hole: an attacker choosing the kid
 *  could aim verification at a key of their choosing. Unknown kid = reject.
 *  The header `alg` must also agree with the key's own `alg`. */
const JWK_ALGOS = {
  RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  ES256: { name: 'ECDSA', namedCurve: 'P-256', hash: { name: 'SHA-256' } },
  EdDSA: { name: 'Ed25519' },
};

async function verifyTelegramIdToken(idToken, botId) {
  const bad = (why) => ({ error: why });
  const parts = (idToken || '').split('.');
  if (parts.length !== 3) return bad('shape');

  let header;
  try {
    header = JSON.parse(fromB64url(parts[0]));
  } catch {
    return bad('header');
  }
  // Never accept an unsigned or attacker-named algorithm.
  if (!header.alg || header.alg === 'none') return bad('alg_none');
  if (!JWK_ALGOS[header.alg]) return bad(`alg_${header.alg}`);

  const jwks = await fetch('https://oauth.telegram.org/.well-known/jwks.json').then((r) => r.json());
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return bad(`kid_${header.kid || 'absent'}`);
  if (jwk.alg && jwk.alg !== header.alg) return bad('alg_mismatch');

  const params = JWK_ALGOS[header.alg];
  const importParams =
    params.name === 'ECDSA'
      ? { name: 'ECDSA', namedCurve: params.namedCurve }
      : params.name === 'Ed25519'
        ? { name: 'Ed25519' }
        : { name: params.name, hash: params.hash };

  let key;
  try {
    key = await crypto.subtle.importKey('jwk', jwk, importParams, false, ['verify']);
  } catch (e) {
    return bad(`import_${header.alg}`);
  }

  const verifyParams =
    params.name === 'ECDSA' ? { name: 'ECDSA', hash: params.hash } : { name: params.name };

  const sig = Uint8Array.from(fromB64url(parts[2]), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify(verifyParams, key, sig, enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return bad(`sig_${header.alg}`);

  let payload;
  try {
    payload = JSON.parse(fromB64url(parts[1]));
  } catch {
    return bad('payload');
  }
  // aud may be a string or an array, per the OIDC spec.
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.map(String).includes(String(botId))) return bad('aud');
  if (payload.iss && !/oauth\.telegram\.org/.test(String(payload.iss))) return bad('iss');
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return bad('expired');
  return payload;
}

const SESSION = 'chords_session';

/** Authorisation reads the SAME KV namespace as the mncoleman.com admin panel,
 *  so whoever is granted access there gets chords too — one user list, managed
 *  in one place. Deliberately mirrors that worker's checkUserAuthorization,
 *  including claiming an invitation on first sign-in.
 *
 *  If the binding is missing the answer is owner-only, never open: a
 *  misconfiguration must not turn into an unlocked door. */
async function authorize(env, sub, username, firstName, claims = {}) {
  if (String(sub) === String(env.OWNER_SUB)) {
    return { authorized: true, role: 'admin' };
  }
  const kv = env.CHORDS_USERS;
  if (!kv) return { authorized: false, role: '' };

  const raw = await kv.get(`user:${sub}`);
  if (raw) {
    const user = JSON.parse(raw);
    if (user.status === 'active') {
      // Cheap last-seen, useful when deciding who still needs access.
      user.lastSeen = new Date().toISOString();
      if (username) user.username = username;
      if (firstName) user.name = firstName;
      await kv.put(`user:${sub}`, JSON.stringify(user));
      return { authorized: true, role: user.role || 'user' };
    }
    return { authorized: false, role: '' };
  }

  // An invitation may be waiting under their Telegram username. This is the
  // only way to grant access BEFORE someone has ever signed in: the subject in
  // the token is specific to this app and unknowable in advance, but the
  // username in the same token is the one the admin looked them up by.
  if (username) {
    const inviteRaw = await kv.get(`invite:${username}`);
    if (inviteRaw) {
      const invite = JSON.parse(inviteRaw);
      const user = {
        sub: String(sub),
        name: firstName || invite.name || null,
        username,
        photo: invite.photo || null,
        telegramId: invite.telegramId || null,
        role: invite.role === 'admin' ? 'admin' : 'user',
        status: 'active',
        addedAt: invite.invitedAt || new Date().toISOString(),
        addedBy: invite.invitedBy || null,
        claimedAt: new Date().toISOString(),
      };
      await kv.put(`user:${sub}`, JSON.stringify(user));
      await kv.delete(`invite:${username}`);
      return { authorized: true, role: user.role };
    }
  }

  // Otherwise file a request the admin can approve — better than a dead end
  // for someone who was never invited.
  const already = await kv.get(`pending:${sub}`);
  if (!already) {
    await kv.put(
      `pending:${sub}`,
      JSON.stringify({
        sub: String(sub),
        name: firstName || null,
        username: username || null,
        photo: typeof claims.picture === 'string' ? claims.picture : null,
        requestedAt: new Date().toISOString(),
      })
    );
  }

  return { authorized: false, role: '' };
}

export async function onRequestGet(ctx) {
  try {
    return await handle(ctx);
  } catch (e) {
    // A bare throw here surfaces as a Cloudflare 1101 with no explanation.
    // Anything unexpected becomes a readable auth_error instead.
    const detail = encodeURIComponent(String(e?.message || e).slice(0, 120));
    return new Response(null, { status: 302, headers: { Location: `/?auth_error=server&detail=${detail}` } });
  }
}

async function handle(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const step = url.pathname.replace(/^\/api\/auth\/?/, '').replace(/\/$/, '');

  if (step === 'me') {
    const payload = await verifyJwt(cookie(request, SESSION), env.JWT_SECRET);
    // `admin` is computed, not read from the token: the owner is an admin by
    // virtue of OWNER_SUB, and sessions minted before the roles were renamed
    // still say "super_admin". A stale session must not lose the admin UI.
    const admin = payload
      ? String(payload.sub) === String(env.OWNER_SUB) || /admin/.test(String(payload.role || ''))
      : false;
    return Response.json(
      payload
        ? { authed: true, name: payload.name ?? null, role: payload.role ?? null, admin }
        : { authed: false },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (step === 'logout') {
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': `${SESSION}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      },
    });
  }

  if (step === 'login') {
    // PKCE: the verifier stays in a signed cookie so the callback can prove the
    // request it is completing is the one it started.
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
    const state = crypto.randomUUID();
    const stash = await signJwt({ verifier, state }, env.JWT_SECRET, 600, 'pkce');

    const params = new URLSearchParams({
      client_id: env.TELEGRAM_BOT_ID,
      scope: 'openid profile',
      response_type: 'code',
      redirect_uri: `${url.origin}/api/auth/callback`,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    return new Response(null, {
      status: 302,
      headers: {
        Location: `https://oauth.telegram.org/auth?${params}`,
        'Set-Cookie': `oauth_stash=${stash}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    });
  }

  if (step === 'callback') {
    const fail = (why) =>
      new Response(null, { status: 302, headers: { Location: `/?auth_error=${why}` } });

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return fail('missing_params');

    const stash = await verifyJwt(cookie(request, 'oauth_stash'), env.JWT_SECRET, 'pkce');
    if (!stash || stash.state !== state) return fail('bad_state');

    const tokenRes = await fetch('https://oauth.telegram.org/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${url.origin}/api/auth/callback`,
        client_id: env.TELEGRAM_BOT_ID,
        client_secret: env.TELEGRAM_CLIENT_SECRET,
        code_verifier: stash.verifier,
      }),
    });
    if (!tokenRes.ok) {
      const body = (await tokenRes.text()).slice(0, 80).replace(/[^\w .:-]/g, '');
      return fail(`token_exchange_${tokenRes.status}_${encodeURIComponent(body)}`);
    }

    const tokenData = await tokenRes.json();
    const idToken = tokenData.id_token;
    // "shape" told us the id_token was not a JWT but not why. Name the fields
    // Telegram actually returned — that distinguishes "absent" from "renamed".
    if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
      // Telegram answers 200 with {"error": "..."} on an OAuth-level refusal.
      // The code names the cause: invalid_client is a bad client_secret,
      // invalid_grant a reused code or mismatched redirect_uri.
      const why = String(tokenData.error || tokenData.error_description || 'absent')
        .slice(0, 60)
        .replace(/[^\w.-]/g, '_');
      return fail(`oauth_${why}`);
    }
    const claims = await verifyTelegramIdToken(idToken, env.TELEGRAM_BOT_ID);
    if (!claims || claims.error) return fail(`bad_token_${claims?.error || 'unknown'}`);

    const username = (claims.username || claims.preferred_username || '').toLowerCase();
    const auth = await authorize(env, String(claims.sub), username, claims.first_name, claims);
    if (!auth.authorized) {
      // Report the subject we were given. Telegram may issue a PAIRWISE sub —
      // a different identifier per OAuth client — so it need not match the
      // user id any other bot sees. Not a secret: it is the caller's own id,
      // returned only to the caller's own browser.
      // A request is now on file, so say so rather than showing a dead end.
      return fail('pending');
    }

    const session = await signJwt(
      {
        sub: claims.sub,
        name: claims.first_name || claims.username || 'Admin',
        username,
        role: auth.role,
      },
      env.JWT_SECRET
    );

    const headers = new Headers({ Location: '/' });
    headers.append('Set-Cookie', 'oauth_stash=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    headers.append(
      'Set-Cookie',
      `${SESSION}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
    );
    return new Response(null, { status: 302, headers });
  }

  return new Response('Not found', { status: 404 });
}
