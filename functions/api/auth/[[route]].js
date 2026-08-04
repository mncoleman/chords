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

async function signJwt(payload, secret, ttlSeconds = 60 * 60 * 24 * 30) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64urlStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64urlStr(JSON.stringify(body))}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

export async function verifyJwt(token, secret) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const sig = Uint8Array.from(fromB64url(parts[2]), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(data));
  if (!ok) return null;
  try {
    const payload = JSON.parse(fromB64url(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
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

/** Telegram signs its id_token with RS256; fetch the JWKS and verify properly
 *  rather than trusting the payload. */
async function verifyTelegramIdToken(idToken, botId) {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;

  const header = JSON.parse(fromB64url(parts[0]));
  const jwks = await fetch('https://oauth.telegram.org/.well-known/jwks.json').then((r) => r.json());
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || (jwks.keys || [])[0];
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sig = Uint8Array.from(fromB64url(parts[2]), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    sig,
    enc.encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) return null;

  const payload = JSON.parse(fromB64url(parts[1]));
  if (String(payload.aud) !== String(botId)) return null;
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

const SESSION = 'chords_session';

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const step = url.pathname.replace(/^\/api\/auth\/?/, '').replace(/\/$/, '');

  if (step === 'me') {
    const payload = await verifyJwt(cookie(request, SESSION), env.JWT_SECRET);
    return Response.json(
      payload ? { authed: true, name: payload.name ?? null } : { authed: false },
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
    const stash = await signJwt({ verifier, state }, env.JWT_SECRET, 600);

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

    const stash = await verifyJwt(cookie(request, 'oauth_stash'), env.JWT_SECRET);
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
    if (!tokenRes.ok) return fail('token_exchange');

    const { id_token: idToken } = await tokenRes.json();
    const claims = await verifyTelegramIdToken(idToken, env.TELEGRAM_BOT_ID);
    if (!claims) return fail('bad_token');

    // Only the owner. This is a private tool, not a public service.
    if (String(claims.sub) !== String(env.OWNER_SUB)) return fail('unauthorized');

    const session = await signJwt(
      { sub: claims.sub, name: claims.first_name || claims.username || 'Matthew' },
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
