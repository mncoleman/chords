// Gate everything behind the Telegram session.
//
// The chord sheets come from Ultimate Guitar's private API. Personal use is one
// thing; an open endpoint that republishes their content to anyone who finds
// the URL is another. So the whole site — pages and API alike — requires a
// session, and only the owner's Telegram account can obtain one.

import { verifyJwt } from './api/auth/[[route]].js';

const SESSION = 'chords_session';

// The login route obviously cannot require a login. The icons and manifest are
// public so the browser can render the install prompt and the sign-in page.
// Anchored, every one of them. An unanchored /^\/favicon/ matched
// /faviconXYZ and served the app shell past the gate.
const OPEN = [
  /^\/api\/auth(\/|$)/,
  /^\/manifest\.webmanifest$/,
  /^\/icon-\d+\.png$/,
  /^\/favicon\.svg$/,
];

function cookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>chords</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#0b0b0c">
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100dvh;display:flex;flex-direction:column;align-items:center;
       justify-content:center;gap:1.1rem;background:#0b0b0c;color:#f4f4f5;
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;padding:2rem}
  h1{font-size:clamp(2.4rem,9vw,3.6rem);margin:0;letter-spacing:-.045em}
  p{color:#8b8b93;margin:0}
  a{display:inline-flex;align-items:center;gap:.5rem;margin-top:.6rem;padding:.85rem 1.4rem;
    border-radius:999px;background:#229ED9;color:#fff;text-decoration:none;font-weight:600}
  .err{color:#f87171;font-size:.86rem}
</style></head>
<body>
  <h1>chords</h1>
  <p>This is a private tool. Sign in to continue.</p>
  <a href="/api/auth/login">Continue with Telegram</a>
  <p class="err" id="e"></p>
  <script>
    const m={missing_params:'Login was interrupted. Try again.',bad_state:'That login expired. Try again.',
      token_exchange:'Telegram would not complete the sign-in.',bad_token:'Could not verify the Telegram response.',
      unauthorized:'That Telegram account is not permitted.'};
    const p=new URLSearchParams(location.search).get('auth_error');
    if(p) document.getElementById('e').textContent = m[p] || 'Sign-in failed.';
  </script>
</body></html>`;

export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);

  if (OPEN.some((re) => re.test(url.pathname))) return next();

  // Demand a session token that names a user. "Any valid JWT" was not enough:
  // the PKCE stash is also a valid JWT, and it is handed to anyone who asks.
  const payload = await verifyJwt(cookie(request, SESSION), env.JWT_SECRET, 'session');
  if (payload && payload.sub) return next();

  // An unauthenticated API call should get a machine-readable 401, not HTML —
  // otherwise the app's fetch() parses a login page as JSON and reports
  // something misleading.
  if (url.pathname.startsWith('/api/')) {
    return Response.json({ error: 'Not signed in' }, { status: 401 });
  }

  return new Response(LOGIN_PAGE, {
    status: 401,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
