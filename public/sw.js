// Offline shell for chords.
//
// The app shell is cached so the search box opens instantly and works offline;
// chord sheets are NOT pre-cached (they come from a live API), but a sheet you
// have opened is kept so a chart you are mid-song with survives losing signal.

const SHELL = 'chords-shell-v2';
const SHEETS = 'chords-sheets-v2';
// Bounded, or a heavy user's device accumulates every sheet ever opened.
const SHEET_LIMIT = 200;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest'])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== SHEETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Chord sheets: network first so an updated tab wins, cache as the fallback.
  if (url.pathname.startsWith('/api/ug')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHEETS).then(async (c) => {
              await c.put(e.request, copy);
              const keys = await c.keys();
              // Oldest first; trim back to the cap.
              for (const k of keys.slice(0, Math.max(0, keys.length - SHEET_LIMIT))) await c.delete(k);
            });
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || Response.json({ error: 'Offline, and this chart is not cached.' }, { status: 503 })))
    );
    return;
  }

  // Navigations must always hit the network: a cached shell would paper over
  // the sign-in page and show a logged-out app that 401s on every call.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(
        () =>
          caches.match('./index.html').then(
            (hit) => hit || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
          )
      )
    );
    return;
  }

  // Shell assets: cache first, since they change only on deploy. Any failure
  // resolves to a Response — never a rejected promise, which surfaced in the
  // console as "FetchEvent resulted in a network error response".
  e.respondWith(
    caches
      .match(e.request)
      .then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok && res.type === 'basic') {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(e.request, copy));
            }
            return res;
          })
      )
      .catch(() => new Response('', { status: 504 }))
  );
});
