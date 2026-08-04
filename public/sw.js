// Offline shell for chords.
//
// The app shell is cached so the search box opens instantly and works offline;
// chord sheets are NOT pre-cached (they come from a live API), but a sheet you
// have opened is kept so a chart you are mid-song with survives losing signal.

const SHELL = 'chords-shell-v1';
const SHEETS = 'chords-sheets-v1';

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
            caches.open(SHEETS).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || Response.json({ error: 'Offline, and this chart is not cached.' }, { status: 503 })))
    );
    return;
  }

  // Shell: cache first, since it changes only on deploy.
  e.respondWith(
    caches.match(e.request).then(
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
  );
});
