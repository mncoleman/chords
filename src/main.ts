import './style.css';
import {
  inferKey,
  intervalForSemitones,
  keyIsMinor,
  keyTonicOf,
  toNashville,
  transposeSymbol,
  writtenTonic,
} from './music';
import { layoutChords, parseSheet, type ChordAt, type SheetLine } from './ug';

/** Commit and build time, stamped in by vite. See buildStamp() there. */
declare const __BUILD__: string;
/** A function, not a constant: esc is declared further down and reading it here
 *  at module load would be a temporal-dead-zone error. */
const buildLine = () => `<p class="build screen-only">Build ${esc(__BUILD__)}</p>`;

// Chord sheets come from Ultimate Guitar's mobile API, proxied through
// /api/ug — UG sends no CORS headers, and the request has to be signed, so it
// cannot happen in the browser. Everything after that is local: parsing,
// transposition, Nashville numbers and printing.

interface Hit {
  id: number;
  song: string;
  artist: string;
  rating: number;
  votes: number;
  verified: boolean;
  url: string | null;
}

interface Sheet {
  id: number;
  song: string;
  artist: string;
  key: string | null;
  capo: number | null;
  tuning: string | null;
  rating: number | null;
  votes: number | null;
  url: string | null;
  content: string;
}

const main = document.getElementById('main')!;

let hits: Hit[] = [];
let sheet: Sheet | null = null;
let lines: SheetLine[] = [];
let semitones = 0;
let numbers = false;
/** Filled in when UG ships a chart with no tonality of its own. */
let inferredKey: string | null = null;
let condensed = false;
/** Settings that outlive the page. The app is installed to a home screen and
 *  reopened between songs, and having to set the columns and the spacing again
 *  every time is the kind of small tax that gets paid mid-service. */
function remembered<T>(key: string, fallback: T, ok: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(`chords.${key}`);
    if (raw === null) return fallback;
    const v = JSON.parse(raw);
    return ok(v) ? (v as T) : fallback;
  } catch {
    // Private browsing, or a value written by an older version.
    return fallback;
  }
}

function remember(key: string, value: unknown): void {
  try {
    localStorage.setItem(`chords.${key}`, JSON.stringify(value));
  } catch {
    /* storage is a convenience, never a requirement */
  }
}

/** Two columns is right on a desktop and in print; one is the only thing that
 *  fits a phone. Set from the viewport the first time, then owned by the toggle
 *  and kept. */
let columns: 1 | 2 = remembered<1 | 2>(
  'columns',
  window.matchMedia('(max-width: 640px)').matches ? 1 : 2,
  (v) => v === 1 || v === 2
);
/** Line spacing, screen and print alike. What decides whether a chart lands on
 *  one page or two, so it is worth a control rather than a constant. */
let lineHeight = remembered('lineHeight', 1.4, (v) => typeof v === 'number' && v >= 1 && v <= 2);
let searchSeq = 0;
let lastQuery = '';

interface Suggestion {
  id: string;
  title: string;
  artist: string;
  /** The credited artists separately. UG files a song under one of them. */
  artists?: string[];
  year: string | null;
  art: string | null;
}
let acItems: Suggestion[] = [];
/** The typed text the dropdown is currently open for; '' means closed. It is
 *  kept apart from acItems because the list stays open, showing the
 *  search-as-typed row, even when Spotify has nothing to offer. */
let acRaw = '';
/** -1 is the search-as-typed row at the top; 0+ index into acItems. */
let acIndex = -1;
let acTimer: number | undefined;
let acSeq = 0;

/** The session expired mid-use. Reload so the gate serves the sign-in page,
 *  rather than leaving a logged-out app that reports "Not signed in" as if it
 *  were a search failure. */
function signedOut(): void {
  location.replace('/');
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;
/** Its own copy: URL_RE is global, and .test() on a global regex is stateful. */
const hasUrl = (s: string) => /\bhttps?:\/\/[^\s<>"']+/.test(s);

/** Escape for HTML, but turn bare URLs into links.
 *
 *  UG charts routinely carry a preamble — BPM, release date, "YouTube link to
 *  the version tabbed: https://…" — and a URL you cannot click is just noise. */
function escLinks(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    // Trailing punctuation reads as sentence, not address.
    const href = m[0].replace(/[.,;:!?)\]]+$/, '');
    out += esc(s.slice(last, m.index));
    out += `<a class="ext" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(href)}</a>`;
    last = m.index + href.length;
  }
  return out + esc(s.slice(last));
}

// ---------------------------------------------------------------------------
// Chord display
// ---------------------------------------------------------------------------
/** The key UG gave us, or the one we worked out from the chords. */
function effectiveKey(): string | null {
  return sheet?.key || inferredKey;
}

function displayedTonic(): string | null {
  const tonic = keyTonicOf(effectiveKey());
  if (!tonic) return null;
  return transposeSymbol(tonic, intervalForSemitones(semitones)).split('/')[0];
}

function displayedKey(): string | null {
  const t = displayedTonic();
  if (!t) return null;
  return keyIsMinor(effectiveKey()) ? `${t}m` : t;
}

/** The capo the NUMBERS have to allow for.
 *
 *  UG names the key the song sounds in but prints the shapes you actually hold:
 *  "Key of B · Capo 4" over a chart of G, Em, D, C. Counting those shapes
 *  against B turned a plain 1 6m 5 4 into b6 4m b3 b2 — the numbers were being
 *  read in one frame and the chords written in another.
 *
 *  Only when UG gave the key. A key we inferred ourselves was read off the
 *  printed shapes, so it is already in their frame and must not be shifted
 *  again. */
function numberCapo(): number {
  return sheet?.key ? sheet.capo || 0 : 0;
}

/** The tonic the numbers count from: the key as the chart is written, not as it
 *  sounds. */
function numberTonic(): string | null {
  return writtenTonic(effectiveKey(), numberCapo(), semitones);
}

/** That tonic as a key name, for saying so on the header line. */
function numberKey(): string | null {
  const t = numberTonic();
  if (!t) return null;
  return keyIsMinor(effectiveKey()) ? `${t}m` : t;
}

function renderSymbol(sym: string): string {
  if (/^N\.?C\.?$/.test(sym)) return sym;
  const t = transposeSymbol(sym, intervalForSemitones(semitones));
  return numbers ? toNashville(t, numberTonic()) : t;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function renderHome(msg?: string): void {
  main.innerHTML = `
    <div class="topbar" id="admin-link"></div>
    <section class="hero">
      <h1 class="wordmark">chords</h1>
      <p class="tag">Search a song. Transpose it, read it in numbers, print it.</p>
      <form class="hero-search" id="hero-form" role="search" autocomplete="off">
        <input id="q" type="search" autocomplete="off" autocapitalize="off" spellcheck="false"
               role="combobox" aria-expanded="false" aria-autocomplete="list"
               placeholder="Search for a song…" aria-label="Search for a song">
        <button type="submit" aria-label="Search">→</button>
      </form>
      <ul id="ac" class="autocomplete" role="listbox" hidden></ul>
      ${msg ? `<p class="muted note">${esc(msg)}</p>` : ''}
      <div id="results" class="results"></div>
    </section>
    ${buildLine()}`;
  wireSearch();
  void (async () => {
    try {
      const me = await (await fetch('/api/auth/me')).json();
      if (me.admin) {
        const el = document.getElementById('admin-link');
        if (el) el.innerHTML = '<a href="#/admin">Users</a>';
      }
    } catch {
      /* the link is a convenience; the page works without it */
    }
  })();
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
interface Person {
  sub?: string;
  id?: string;
  username?: string | null;
  name?: string | null;
  photo?: string | null;
  role?: string;
  status?: string;
  lastSeen?: string;
  requestedAt?: string;
  invitedAt?: string;
}

function avatar(p: Person): string {
  if (p.photo) return `<img class="av" src="${esc(p.photo)}" alt="">`;
  const initial = (p.name || p.username || '?').trim().charAt(0).toUpperCase();
  return `<span class="av av-blank">${esc(initial)}</span>`;
}

function personRow(p: Person, actions: string): string {
  const sub = p.sub ? `<span class="mono">${esc(p.sub)}</span>` : '';
  return `
    <li>
      ${avatar(p)}
      <span class="who">
        <strong>${esc(p.name || p.username || 'Unknown')}</strong>
        <span class="muted">${p.username ? '@' + esc(p.username) : sub}</span>
      </span>
      <span class="acts">${actions}</span>
    </li>`;
}

/** Grants made in this session that KV's list may not report back yet. */
const justSet = new Map<string, Person>();
/** Removals likewise: KV can keep listing a key it has already deleted. */
const justGone = new Set<string>();
/** The last server response, so a click can repaint without a round trip. */
let adminData: {
  me?: { sub?: string; name?: string | null; username?: string | null; profile?: Person | null };
  users?: Person[];
  invites?: Person[];
} | null = null;

/** Send an action that has ALREADY been drawn as done.
 *
 *  Every button repaints first and posts second. KV is eventually consistent,
 *  so re-reading the list right after a write often returns the old one — the
 *  UI then looked frozen, and the only way to see a change was to restart the
 *  app. On failure the local guess is dropped and the truth is fetched back. */
async function adminPost(body: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) return signedOut();
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      justSet.clear();
      justGone.clear();
      void refreshAdmin();
      return;
    }
  } catch {
    alert('That did not reach the server. Check your connection.');
    justSet.clear();
    justGone.clear();
  }
  void refreshAdmin();
}

async function refreshAdmin(): Promise<void> {
  const res = await fetch('/api/admin');
  if (res.status === 401) return signedOut();
  if (res.status === 403) {
    main.innerHTML = `<section class="hero"><h1>Admins only</h1><p><a href="#/">← Back</a></p></section>`;
    return;
  }
  adminData = await res.json();
  paintAdmin();
}

async function renderAdmin(): Promise<void> {
  document.title = 'Users · chords';
  if (adminData) paintAdmin(); // instant on a revisit; the fetch corrects it
  await refreshAdmin();
}

function paintAdmin(): void {
  const data = adminData ?? {};
  const keyOf = (p: Person) => p.username || p.id || p.sub || '';

  const serverUsers: Person[] = data.users ?? [];
  const serverInvites: Person[] = data.invites ?? [];

  // Once the server reports what we guessed, stop guessing.
  const known = new Set([...serverInvites, ...serverUsers].map(keyOf));
  for (const k of [...justSet.keys()]) if (known.has(k)) justSet.delete(k);
  for (const k of [...justGone]) if (!known.has(k)) justGone.delete(k);

  const users = serverUsers.filter((p) => !justGone.has(keyOf(p)));
  const invites: Person[] = [
    ...serverInvites.filter((p) => !justGone.has(keyOf(p))),
    ...justSet.values(),
  ];

  main.innerHTML = `
    <article class="chart admin">
      <div class="toolbar screen-only">
        <a class="back" href="#/" title="Back to search">←</a>
        <strong>Users</strong>
        <div class="spacer"></div>
      </div>

      <section class="panel">
        <h2>Add someone</h2>
        <p class="muted small"><strong>Find</strong> previews an account — which Telegram only
          allows for bots, channels, and people this bot has met. <strong>Set</strong> grants
          access to exactly what you type, with no preview: a @username, or a number, which is
          matched at sign-in against both their id and this app's own identifier for them.
          If they have no username, have them tap sign-in once — they are shown a code to send
          you, which you paste here.</p>
        <form id="lookup-form" class="row" autocomplete="off">
          <input id="lookup-q" placeholder="@username or id" aria-label="Telegram username or id">
          <button type="submit">Find</button>
          <button type="button" id="set-btn" title="Grant access to exactly what is typed">Set</button>
        </form>
        <div id="lookup-out"></div>
      </section>

      ${
        invites.length
          ? `<section class="panel">
              <h2>Invited, not signed in yet</h2>
              <ul class="people">
                ${invites
                  .map((p) =>
                    personRow(
                      { ...p, name: p.name || (p.username ? null : `id ${(p as { id?: string }).id}`) },
                      `<button class="danger" data-unset="${esc(p.username || (p as { id?: string }).id || '')}">Cancel</button>`
                    )
                  )
                  .join('')}
              </ul>
            </section>`
          : ''
      }

      <section class="panel">
        <h2>Has access</h2>
        <ul class="people">
          ${(() => {
            const me = data.me ?? {};
            const p: Person = me.profile ?? { name: me.name, username: me.username };
            return `<li>
              ${avatar(p)}
              <span class="who">
                <strong>${esc(p.name || 'You')} <span class="muted small">you</span></strong>
                <span class="muted">${p.username ? '@' + esc(p.username) : ''}${
                  (p as { telegramId?: string }).telegramId
                    ? ` · id ${esc((p as { telegramId?: string }).telegramId!)}`
                    : ''
                }</span>
                <span class="muted mono">${esc(String(me.sub ?? ''))}</span>
              </span>
              <span class="acts muted small">owner</span>
            </li>`;
          })()}
          ${
            users.length
              ? users
                  .map((p) =>
                    personRow(
                      p,
                      `${p.status === 'active' ? `<button data-revoke="${esc(p.sub || '')}">Revoke</button>` : `<button data-approve="${esc(p.sub || '')}">Restore</button>`}
                       <button class="danger" data-remove="${esc(p.sub || '')}">Remove</button>`
                    )
                  )
                  .join('')
              : '<li class="muted small">Nobody else yet.</li>'
          }
        </ul>
      </section>
    </article>`;

  const form = document.getElementById('lookup-form') as HTMLFormElement;
  const out = document.getElementById('lookup-out') as HTMLElement;

  // "Set" skips the preview and grants whatever was typed. A number is matched
  // at sign-in against their subject and against any id in their token, so it
  // works whichever kind of number you have.
  document.getElementById('set-btn')?.addEventListener('click', () => {
    const raw = (document.getElementById('lookup-q') as HTMLInputElement).value.trim();
    const v = raw.replace(/^@/, '');
    if (!v) return;
    // Show it immediately; the server call is what makes it true, but waiting
    // on KV's read-after-write lag reads as a button that did nothing.
    const key = /^\d{4,32}$/.test(v) ? v : v.toLowerCase();
    justSet.set(key, /^\d+$/.test(key) ? { id: key } : { username: key });
    justGone.delete(key);
    (document.getElementById('lookup-q') as HTMLInputElement).value = '';
    paintAdmin();
    void adminPost({ action: 'set', value: v });
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = (document.getElementById('lookup-q') as HTMLInputElement).value.trim();
    if (!q) return;
    out.innerHTML = '<p class="muted small">Looking…</p>';
    const r = await fetch(`/api/admin?lookup=${encodeURIComponent(q)}`);
    if (r.status === 401) return signedOut();
    const found = await r.json();
    if (found.error) {
      // A username cannot usually be previewed, but it can still be invited:
      // the matching happens against the username in their sign-in token. A
      // bare id cannot be invited at all — nothing in the sign-in token
      // carries it, so there would be nothing to match against.
      out.innerHTML = `
        <p class="muted small">${esc(found.error)}</p>
        ${
          found.username
            ? `<ul class="people">${personRow(
                { username: found.username },
                `<button id="grant">Invite @${esc(found.username)}</button>`
              )}</ul>`
            : `<p class="muted small">Ask them for their @username and invite that instead — it is
               the only thing their sign-in can be matched on.</p>`
        }`;
      document
        .getElementById('grant')
        ?.addEventListener('click', () => {
          justSet.set(found.username, { username: found.username });
          paintAdmin();
          void adminPost({ action: 'invite', username: found.username });
        });
      return;
    }
    if (!found.username) {
      out.innerHTML = `<ul class="people">${personRow(found, '')}</ul>
        <p class="muted small">Found them, but that account has no @username. Nothing in a
          Telegram sign-in identifies them, so they cannot be invited ahead of time — have
          them sign in once and approve the request that appears here.</p>`;
      return;
    }
    out.innerHTML = `<ul class="people">${personRow(found, '<button id="grant">Grant access</button>')}</ul>`;
    document.getElementById('grant')?.addEventListener('click', () => {
      if (!found.username) {
        alert('That account has no @username, so an invitation cannot be matched when they sign in.');
        return;
      }
      justSet.set(found.username, { username: found.username, name: found.name, photo: found.photo });
      paintAdmin();
      void adminPost({
        action: 'invite',
        username: found.username,
        name: found.name,
        photo: found.photo,
        telegramId: found.telegramId,
      });
    });
  });

  /** Change our own copy of a user, repaint, then tell the server. */
  const localStatus = (sub: string, status: string) => {
    const u = (adminData?.users ?? []).find((p) => p.sub === sub);
    if (u) u.status = status;
    paintAdmin();
  };

  main.querySelectorAll<HTMLElement>('[data-approve]').forEach((b) =>
    b.addEventListener('click', () => {
      localStatus(String(b.dataset.approve), 'active');
      void adminPost({ action: 'approve', sub: b.dataset.approve });
    })
  );
  main.querySelectorAll<HTMLElement>('[data-revoke]').forEach((b) =>
    b.addEventListener('click', () => {
      localStatus(String(b.dataset.revoke), 'revoked');
      void adminPost({ action: 'revoke', sub: b.dataset.revoke });
    })
  );
  main.querySelectorAll<HTMLElement>('[data-remove]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('Remove this person entirely?')) return;
      justGone.add(String(b.dataset.remove));
      paintAdmin();
      void adminPost({ action: 'remove', sub: b.dataset.remove });
    })
  );
  main.querySelectorAll<HTMLElement>('[data-unset]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = String(b.dataset.unset);
      justSet.delete(v);
      justGone.add(v);
      paintAdmin();
      void adminPost({ action: 'unset', value: v });
    })
  );
}

/** Spotify typeahead. It exists to fix the spelling and save the typing — the
 *  chosen title and artist are then handed to Ultimate Guitar, which is where
 *  the chords actually come from. */
async function suggest(q: string): Promise<void> {
  const seq = ++acSeq;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (res.status === 401) return signedOut();
    const data = await res.json();
    if (seq !== acSeq) return; // a later keystroke already won
    acItems = data.tracks ?? [];
  } catch {
    if (seq !== acSeq) return;
    acItems = [];
  }
  acIndex = -1;
  drawAutocomplete();
}

/** Put the dropdown away. */
function closeAutocomplete(): void {
  acItems = [];
  acRaw = '';
  acIndex = -1;
  drawAutocomplete();
}

function drawAutocomplete(): void {
  const ul = document.getElementById('ac');
  const input = document.getElementById('q') as HTMLInputElement | null;
  if (!ul) return;
  if (!acRaw) {
    ul.hidden = true;
    ul.innerHTML = '';
    input?.setAttribute('aria-expanded', 'false');
    return;
  }
  // Spotify's titles are the tidy way in, but it does not know everything —
  // hymns, worship songs, live arrangements. This row skips the tidying and
  // hands the typed words straight to Ultimate Guitar.
  const raw = `
    <li role="option" data-raw="1" class="raw ${acIndex === -1 ? 'on' : ''}" aria-selected="${acIndex === -1}">
      <span class="noart ic" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4.2-4.2"></path>
        </svg>
      </span>
      <span class="st">
        <span class="t">Search “${esc(acRaw)}”</span>
        <span class="a">Look it up on Ultimate Guitar as typed</span>
      </span>
    </li>`;
  ul.innerHTML =
    raw +
    acItems
      .map(
        (t, i) => `
      <li role="option" data-i="${i}" class="${i === acIndex ? 'on' : ''}" aria-selected="${i === acIndex}">
        ${t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : '<span class="noart"></span>'}
        <span class="st">
          <span class="t">${esc(t.title)}</span>
          <span class="a">${esc(t.artist)}${t.year ? ` · ${esc(t.year)}` : ''}</span>
        </span>
      </li>`
      )
      .join('');
  ul.hidden = false;
  input?.setAttribute('aria-expanded', 'true');
}

/** Search exactly what was typed, ignoring the suggestions. */
function searchRaw(): void {
  const q = acRaw || (document.getElementById('q') as HTMLInputElement | null)?.value.trim() || '';
  if (q.length < 2) return;
  closeAutocomplete();
  void search(q);
}

function pickSuggestion(i: number): void {
  const t = acItems[i];
  if (!t) return;
  const input = document.getElementById('q') as HTMLInputElement | null;
  // Fill the box with the corrected spelling, then go straight to the chords.
  if (input) input.value = `${t.title} ${t.artist}`;
  closeAutocomplete();
  // Title and artist go separately, and only the first credited artist goes at
  // all. Joined into one string they were searched as a song TITLE, so every
  // collaboration asked Ultimate Guitar for a song called "The Blessing Kari
  // Jobe, Cody Carnes, Elevation Worship" and got nothing.
  void search({ title: t.title, artist: t.artists?.[0] || t.artist.split(',')[0].trim() });
}

function wireSearch(): void {
  const form = document.getElementById('hero-form') as HTMLFormElement | null;
  const input = document.getElementById('q') as HTMLInputElement | null;
  const ul = document.getElementById('ac');
  if (!form || !input) return;

  // Ready to type the moment the page opens — that is the whole interaction.
  input.focus();
  if (lastQuery) {
    input.value = lastQuery;
    input.select();
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    window.clearTimeout(acTimer);
    if (q.length < 2) {
      closeAutocomplete();
      return;
    }
    // Open on the search-as-typed row straight away; the Spotify rows land
    // underneath it when the debounced lookup comes back.
    acRaw = q;
    acIndex = -1;
    drawAutocomplete();
    acTimer = window.setTimeout(() => void suggest(q), 200);
  });

  input.addEventListener('keydown', (ev) => {
    if (!acRaw || (ul as HTMLElement)?.hidden) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      // -1 is the search-as-typed row, so arrowing up off the list lands there.
      acIndex =
        ev.key === 'ArrowDown'
          ? Math.min(acItems.length - 1, acIndex + 1)
          : Math.max(-1, acIndex - 1);
      drawAutocomplete();
    } else if (ev.key === 'Enter' && acIndex >= 0) {
      ev.preventDefault();
      pickSuggestion(acIndex);
    } else if (ev.key === 'Escape') {
      closeAutocomplete();
    }
  });

  ul?.addEventListener('mousedown', (ev) => {
    const li = (ev.target as HTMLElement).closest('li');
    if (!li) return;
    if (li.dataset.raw) {
      ev.preventDefault();
      searchRaw();
    } else if (li.dataset.i) {
      ev.preventDefault();
      pickSuggestion(Number(li.dataset.i));
    }
  });

  document.addEventListener('click', (ev) => {
    if (!(ev.target as HTMLElement).closest('.hero-search, .autocomplete')) {
      closeAutocomplete();
    }
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    // Enter with a highlighted suggestion takes it; otherwise search what was typed.
    if (acIndex >= 0 && acItems[acIndex]) {
      pickSuggestion(acIndex);
      return;
    }
    const q = input.value.trim();
    if (q.length >= 2) {
      closeAutocomplete();
      void search(q);
    }
  });
}

/** What was asked for: a suggestion picked from the dropdown carries its title
 *  and artist apart, and anything typed by hand is just text. */
interface Ask {
  q?: string;
  title?: string;
  artist?: string;
}

/** Which rung of the server's fallback answered, when it was not the first. */
let searchNote: string | null = null;

function askUrl(ask: Ask): string {
  const p = new URLSearchParams();
  if (ask.title) p.set('title', ask.title);
  if (ask.artist) p.set('artist', ask.artist);
  if (ask.q) p.set('q', ask.q);
  return `/api/ug?${p}`;
}

async function search(ask: Ask | string): Promise<void> {
  const a: Ask = typeof ask === 'string' ? { q: ask } : ask;
  lastQuery = a.q || [a.title, a.artist].filter(Boolean).join(' ');
  const seq = ++searchSeq;
  const box = document.getElementById('results');
  if (box) box.innerHTML = `<p class="muted loading">Searching…</p>`;
  searchNote = null;

  try {
    let res = await fetch(askUrl(a));
    if (res.status === 401) return signedOut();
    let data = await res.json();
    if (seq !== searchSeq) return;
    if (data.error) throw new Error(data.error);

    // Nothing at all for something typed by hand. Ultimate Guitar tolerates a
    // truncated word but not a misspelt one — "goodnes of god" finds the song,
    // "grattitude" finds nothing — while Spotify corrects spelling for a
    // living. So ask Spotify what the words were meant to be and search again.
    if (!(data.results ?? []).length && a.q) {
      const fixed = await correctSpelling(a.q);
      if (seq !== searchSeq) return;
      if (fixed) {
        res = await fetch(askUrl(fixed.ask));
        if (res.status === 401) return signedOut();
        const second = await res.json();
        if (seq !== searchSeq) return;
        if ((second.results ?? []).length) {
          data = second;
          searchNote = `Nothing for “${a.q}”. Showing ${fixed.label}.`;
        }
      }
    }

    hits = data.results ?? [];
    // The song was found, but not by the artist asked for — which is the usual
    // case for a cover: UG files the song under whoever wrote it.
    if (hits.length && !searchNote && a.artist && (data.matched === 'title' || data.matched === 'normalized-title')) {
      searchNote = `No Ultimate Guitar chart credited to ${a.artist}. Showing this song by other artists.`;
    }
  } catch (e) {
    if (seq !== searchSeq) return;
    const box2 = document.getElementById('results');
    if (box2) box2.innerHTML = `<p class="muted">Search failed: ${esc((e as Error).message)}</p>`;
    return;
  }
  renderResults();
}

/** Spotify's best guess at what a misspelt query meant. */
async function correctSpelling(q: string): Promise<{ ask: Ask; label: string } | null> {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const top: Suggestion | undefined = (data.tracks ?? [])[0];
    if (!top) return null;
    const artist = top.artists?.[0] || top.artist.split(',')[0].trim();
    return { ask: { title: top.title, artist }, label: `“${top.title}” by ${artist}` };
  } catch {
    return null;
  }
}

function renderResults(): void {
  const box = document.getElementById('results');
  if (!box) return;
  if (!hits.length) {
    box.innerHTML = `<p class="muted">Nothing on Ultimate Guitar for that${
      lastQuery ? ` — searched for “${esc(lastQuery)}”` : ''
    }. Try fewer words, or the song title on its own.</p>`;
    return;
  }
  box.innerHTML = `
    ${searchNote ? `<p class="muted note searchnote">${esc(searchNote)}</p>` : ''}
    <ul class="hitlist">
      ${hits
        .map(
          (h) => `
        <li>
          <a href="#/t/${h.id}">
            <span class="st">
              <span class="t">${esc(h.song)}</span>
              <span class="a">${esc(h.artist)}</span>
            </span>
            <span class="rt">
              ${h.verified ? '<span class="ver" title="Verified by Ultimate Guitar">✓</span>' : ''}
              <span class="stars">${h.rating ? h.rating.toFixed(1) : '—'}★</span>
              <span class="votes">${h.votes.toLocaleString()}</span>
            </span>
          </a>
        </li>`
        )
        .join('')}
    </ul>`;
}

async function renderSheet(id: string): Promise<void> {
  main.innerHTML = `<p class="muted loading">Loading chart…</p>`;
  try {
    const res = await fetch(`/api/ug?id=${encodeURIComponent(id)}`);
    if (res.status === 401) return signedOut();
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    sheet = data as Sheet;
    lines = parseSheet(sheet.content);
    inferredKey = sheet.key ? null : inferKey(lines.flatMap((l) => l.chords.map((c) => c.symbol)));
    semitones = 0;
    numbers = false;
    document.title = `${sheet.song} — ${sheet.artist} · chords`;
    drawSheet();
  } catch (e) {
    main.innerHTML = `
      <section class="hero">
        <h1>Couldn't load that chart</h1>
        <p class="muted">${esc((e as Error).message)}</p>
        <p><a href="#/">← Search again</a></p>
      </section>`;
  }
}

/** ASCII tablature — six pitch rows of dashes and fret numbers. Faithful, but
 *  it costs a third of a page and repeats what the chord symbols already say. */
const TAB_LINE_RE = /^\s*[eBGDAE]\s*\|[-0-9|~/\\hpbrx*\s]*$/;

/** "Verse 2" and "Verse 3" carry the same chords as "Verse 1"; only the words
 *  change. Strip the number so they group. */
function sectionBase(section: string | undefined): string {
  return (section || '').replace(/\s*\d+\s*$/, '').trim().toLowerCase();
}

/** Drop everything that repeats, so a song fits on one page.
 *
 *  The first verse, chorus and bridge keep their chords. Later verses keep
 *  their words but lose the chord line, because it is the same chord line —
 *  which is exactly what you already know by the second verse. Tablature and
 *  instrumental runs inside a repeat go entirely. */
function condense(all: SheetLine[]): SheetLine[] {
  const charted = new Set<string>();
  const out: SheetLine[] = [];
  // Decided once per section HEADING, not per line: every line of the first
  // chorus keeps its chords, and every line of the second loses them.
  let repeat = false;

  for (const l of all) {
    if (l.section !== undefined) {
      const base = sectionBase(l.section);
      repeat = charted.has(base);
      charted.add(base);
    }
    if (TAB_LINE_RE.test(l.lyric)) continue;

    if (!repeat) {
      out.push(l);
      continue;
    }

    // A repeat with no words of its own is pure instrumental — nothing to keep.
    if (!l.lyric.trim()) {
      if (l.section) out.push({ section: l.section, chords: [], lyric: '' });
      continue;
    }
    out.push({ section: l.section, chords: [], lyric: l.lyric });
  }

  // Condensing leaves runs of blank lines behind; collapse them.
  return out.filter(
    (l, i) =>
      l.section ||
      l.chords.length ||
      l.lyric.trim() ||
      (i > 0 && (out[i - 1].lyric.trim() || out[i - 1].chords.length))
  );
}

/** One chord sitting above one run of lyric text. */
interface Cell {
  chord: string;
  text: string;
}

/** Re-cut a chord line + its lyric into cells that can WRAP.
 *
 *  The <pre> pair is exact but rigid: on a phone it scrolls sideways, which
 *  makes a chart unreadable while playing. Cells carry their own alignment, so
 *  the line can break at a space and the chord still sits over its syllable.
 *
 *  The lyric is cut at each chord column — that keeps placement faithful — and
 *  each piece is then cut again at spaces so a long run can still break. Only
 *  the first piece of a run carries the chord. */
function toCells(chords: ChordAt[], lyric: string): Cell[] {
  const cols = [...chords].sort((a, b) => a.at - b.at);

  // A line of chords with no lyric under it (an intro or turnaround).
  if (!lyric.trim()) return cols.map((c) => ({ chord: renderSymbol(c.symbol), text: '' }));

  const cells: Cell[] = [];
  // Text before the first chord belongs to nobody.
  let cursor = 0;
  const push = (chord: string, text: string) => {
    // Split on spaces, keeping them, so the row can break between words.
    const parts = text.split(/(\s+)/).filter((p) => p !== '');
    if (!parts.length) {
      cells.push({ chord, text: '' });
      return;
    }
    parts.forEach((p, i) => cells.push({ chord: i === 0 ? chord : '', text: p }));
  };

  if (cols.length && cols[0].at > 0) {
    push('', lyric.slice(0, cols[0].at));
    cursor = cols[0].at;
  }

  for (let i = 0; i < cols.length; i++) {
    const start = Math.max(cursor, cols[i].at);
    const end = i + 1 < cols.length ? Math.max(start, cols[i + 1].at) : lyric.length;
    push(renderSymbol(cols[i].symbol), lyric.slice(start, end));
    cursor = end;
  }

  if (!cols.length) push('', lyric);
  else if (cursor < lyric.length) push('', lyric.slice(cursor));

  return cells;
}

function renderFlow(cells: Cell[]): string {
  // No whitespace between the spans: they are inline-block, so a newline in the
  // source would render as a real gap in the lyric.
  return cells
    .map(
      (c) =>
        `<span class="cw"><span class="cc">${c.chord ? esc(c.chord) : ''}</span>` +
        `<span class="ct">${escLinks(c.text)}</span></span>`
    )
    .join('');
}

/** Lift the chart's opening facts out of the body and into the masthead.
 *
 *  UG charts open with loose notes — "BPM: 140", "Single released: 13 Oct
 *  2023" — set as ordinary lines, which costs a quarter of the first column
 *  before a single chord appears. They belong beside the key.
 *
 *  Only the plain ones move: a line carrying a URL stays in the body, where it
 *  stays clickable and out of the printed page. */
/** Does this preamble line only repeat what the masthead already shows?
 *
 *  Compared on words rather than as text, because UG writes it loosely:
 *  "Gratitude by Brandon Lake", "Song: Gratitude", "Capo: 4th fret". */
function restatesMasthead(line: string): boolean {
  if (!sheet) return false;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const said = new Set([
    ...norm(sheet.song),
    ...norm(sheet.artist),
    // The words a preamble uses to join them up, none of which carry anything.
    ...['by', 'song', 'title', 'artist', 'band', 'chords', 'tab', 'key', 'of'],
    ...(sheet.capo ? ['capo', String(sheet.capo), 'fret', 'st', 'nd', 'rd', 'th'] : []),
    ...(sheet.key ? ['key', ...norm(sheet.key)] : []),
    ...(sheet.tuning ? ['tuning', ...norm(sheet.tuning)] : []),
  ]);
  const w = norm(line);
  // A word the masthead does not already carry makes the line worth keeping.
  return w.length > 0 && w.every((x) => said.has(x));
}

function splitPreamble(all: SheetLine[]): { facts: string[]; chart: SheetLine[] } {
  const facts: string[] = [];
  let i = 0;
  // Counted apart from facts: a preamble line that only repeats the masthead is
  // dropped rather than kept, and it still has to leave the body. Testing
  // facts.length instead put every one of them back into the chart the moment
  // they were all duplicates, which is exactly the charts this is for.
  let lifted = 0;
  for (; i < all.length; i++) {
    const l = all[i];
    // The preamble ends at the first section heading or the first chord.
    if (l.section !== undefined || l.chords.length) break;
    if (!l.lyric.trim()) continue;
    if (hasUrl(l.lyric)) break;
    lifted++;
    // "BPM:      140" is column-aligned for a monospace block it has now left.
    const fact = l.lyric.trim().replace(/\s{2,}/g, ' ');
    // UG preambles open by naming the song, the artist and the capo — all three
    // of which the masthead has already said in larger type directly above.
    // Printed, the duplicate cost four lines at the top of every chart.
    if (!restatesMasthead(fact)) facts.push(fact);
  }
  // Nothing lifted means nothing to skip — keep the body exactly as it was.
  return lifted ? { facts, chart: all.slice(i) } : { facts: [], chart: all };
}

// ---------------------------------------------------------------------------
// Two-column print
// ---------------------------------------------------------------------------
// WebKit switches CSS multi-column layout OFF in paged media — bug 15546, filed
// in 2007 and still open — so `columns: 2` is honoured on an iPhone's screen and
// silently ignored on its paper. Blink fixed the same bug years ago, which is
// why this only ever showed up printing from a phone. No stylesheet can turn a
// feature back on that the engine has disabled, so for print the columns are
// built as real elements instead: sections are measured, packed into two columns
// a page, and emitted as one row per page. The screen keeps using multicol,
// which works there.

/** CSS pixels per millimetre. Paper is measured in mm, so the packing is too —
 *  it makes every constant below a length you can hold a ruler against. */
const MM = 96 / 25.4;
/** A4 is the narrower common paper and Letter the shorter, so taking one
 *  dimension from each means the packing fits whichever is loaded. Guessing
 *  wrong only ever costs white space; guessing generous costs a stray page. */
const PAPER_W = 210;
const PAPER_H = 279.4;
/** @page gives 6mm a side and .chart another 6mm. */
const SIDE_MM = 12;
/** @page gives 14mm top and bottom. MEASURED off a PDF printed from the phone:
 *  the masthead sat 28mm tall and 211mm of column ran below it, which puts the
 *  content box at 239mm — the arithmetic here was right all along, and the
 *  content that went missing was never a question of height. */
const VERT_MM = 14 * 2 + 12;
/** The 16pt gutter between the columns. */
const GUTTER_MM = (16 / 72) * 25.4;
/** Slack. A page of columns is a flex row, and a flex row does not split: if it
 *  overruns its page by a millimetre the whole row moves to the next one and
 *  leaves the page it came from empty. Erring short costs white space; erring
 *  long costs a blank page. */
const SLACK_MM = 8;

function printColWidthMm(): number {
  return (PAPER_W - 2 * SIDE_MM - GUTTER_MM) / 2;
}

/** How much of the first page the masthead takes.
 *
 *  Measured, not assumed. It was assumed at 46mm, and a masthead taller than
 *  that overran the first page — so its row of columns, which cannot be split,
 *  moved to the second page and left the first one blank. */
function mastheadHeightMm(): number {
  const mast = main.querySelector('.masthead');
  if (!mast) return 0;
  const rig = document.createElement('div');
  // No .chart: its padding would narrow the measure and overstate the height.
  rig.className = 'rehearse rehearse-mast';
  rig.style.width = `${PAPER_W - 2 * SIDE_MM}mm`;
  rig.appendChild(mast.cloneNode(true));
  document.body.appendChild(rig);
  const h = rig.getBoundingClientRect().height / MM;
  rig.remove();
  // A little over rather than a little under: the first row of columns cannot be
  // split, so a first page that is one millimetre short does not lose a line, it
  // loses the whole page.
  return h + 6;
}

/** Height of each section at the width and type size it will print at.
 *
 *  Measured rather than estimated: how a lyric wraps inside a 93mm column is
 *  the whole question, and counting characters guesses at it. The rig is a real
 *  element laid out at the real width, just parked off-screen. */
function measureBlocks(blocks: HTMLElement[]): number[] {
  const rig = document.createElement('div');
  rig.className = 'sheet rehearse';
  rig.style.width = `${printColWidthMm()}mm`;
  rig.style.setProperty('--lh', String(lineHeight));
  const clones = blocks.map((b) => b.cloneNode(true) as HTMLElement);
  for (const c of clones) rig.appendChild(c);
  document.body.appendChild(rig);
  const heights = clones.map((c) => c.getBoundingClientRect().height);
  rig.remove();
  return heights;
}

/** Fill a column, then the one beside it, then start a page. Column order, not
 *  row order: a chart is read down one column and then down the next, and any
 *  other packing reorders the song. */
function packColumns(heights: number[], mastheadMm: number): number[][][] {
  const full = (PAPER_H - VERT_MM - SLACK_MM) * MM;
  const first = full - mastheadMm * MM;

  const pages: number[][][] = [];
  let page: number[][] = [[], []];
  let col = 0;
  let used = 0;

  for (let i = 0; i < heights.length; i++) {
    const limit = pages.length ? full : first;
    // Never leave a column empty: a section taller than a whole column has to
    // overflow somewhere, and starting a fresh column with it just moves the
    // overflow along.
    if (used > 0 && used + heights[i] > limit) {
      if (col === 0) {
        col = 1;
      } else {
        pages.push(page);
        page = [[], []];
        col = 0;
      }
      used = 0;
    }
    page[col].push(i);
    used += heights[i];
  }
  pages.push(page);
  return pages;
}

/** Build the printable pages beside the chart. Idempotent: printing twice, or a
 *  browser that fires beforeprint as well as the button being pressed, rebuilds
 *  rather than doubling. */
function buildPrintPages(): void {
  clearPrintPages();
  const article = main.querySelector('.chart');
  const sheetEl = main.querySelector<HTMLElement>('.sheet');
  // One column prints correctly as it is; there is nothing to lay out.
  if (!article || !sheetEl || columns !== 2) return;

  const blocks = [...sheetEl.querySelectorAll<HTMLElement>('.blk')];
  if (!blocks.length) return;

  const heights = measureBlocks(blocks);
  const mastMm = mastheadHeightMm();
  const paged = document.createElement('div');
  paged.className = 'paged';
  paged.style.setProperty('--lh', String(lineHeight));

  const pages = packColumns(heights, mastMm);
  // What the packing believed, printed small at the foot of the chart. Paper is
  // the only place this can be checked — there is no way to lay out a printed
  // page here and measure it — so the page has to say what it assumed and be
  // held against the sheet that comes out of the printer.
  const tallest = pages.map((p) =>
    Math.round(Math.max(...p.map((col) => col.reduce((sum, i) => sum + heights[i], 0))) / MM)
  );

  const fullMm = PAPER_H - VERT_MM - SLACK_MM;
  for (const [n, page] of pages.entries()) {
    const pageEl = document.createElement('div');
    pageEl.className = 'ppage';
    // A box of a known height. The columns inside are positioned absolutely and
    // so are out of flow entirely — there is nothing left for the engine to
    // fragment, which is what kept losing whole sections.
    pageEl.style.height = `${(n === 0 ? fullMm - mastMm : fullMm).toFixed(1)}mm`;
    for (const col of page) {
      const colEl = document.createElement('div');
      colEl.className = 'pcol';
      for (const i of col) colEl.appendChild(blocks[i].cloneNode(true));
      pageEl.appendChild(colEl);
    }
    paged.appendChild(pageEl);
  }

  const budget = Math.round(((PAPER_H - VERT_MM - SLACK_MM) * MM) / MM);
  const note = document.createElement('p');
  note.className = 'packinfo';
  note.textContent =
    `pack ${blocks.length} sections · col ${printColWidthMm().toFixed(0)}mm · ` +
    `masthead ${mastMm.toFixed(0)}mm · budget ${budget}mm/page · ` +
    `pages ${tallest.map((h, i) => `${i + 1}:${h}mm`).join(' ')} · lh ${lineHeight}`;
  paged.appendChild(note);

  article.appendChild(paged);
  // A class rather than a sibling selector, so the rule that hides the original
  // chart needs nothing newer than the phones this has to print from.
  article.classList.add('paginated');
}

function clearPrintPages(): void {
  main.querySelector('.paged')?.remove();
  main.querySelector('.chart')?.classList.remove('paginated');
}

/** Lay the pages out, print, and take them away again. They are built at the
 *  moment of printing because line spacing, transposition and the chart's own
 *  length can all change between one print and the next. */
function printChart(): void {
  buildPrintPages();
  window.print();
}

/** One group per section, so a section can be kept whole across a break. */
function groupBySection(all: SheetLine[]): SheetLine[][] {
  const blocks: SheetLine[][] = [];
  for (const l of all) {
    if (l.section !== undefined || !blocks.length) blocks.push([]);
    blocks[blocks.length - 1].push(l);
  }
  return blocks;
}

/** The controls exist twice, once per breakpoint: in the sticky toolbar on a
 *  desktop, and in the masthead on a phone, where that row is full at four
 *  groups and a fifth wrapped it onto a second line. Same markup, different id
 *  suffix; CSS shows one, and both are wired. */
const colSeg = (sfx: string) => `
  <div class="ctl seg cols" role="group" aria-label="Columns">
    <span class="lbl">Columns</span>
    <button id="col-1${sfx}" class="${columns === 1 ? 'on' : ''}" title="One column">1</button>
    <button id="col-2${sfx}" class="${columns === 2 ? 'on' : ''}" title="Two columns">2</button>
  </div>`;

const lhCtl = (sfx: string) => `
  <div class="ctl lh">
    <span class="lbl">Line</span>
    <input id="lh${sfx}" type="range" min="1.05" max="1.9" step="0.05"
           value="${lineHeight}" aria-label="Line spacing" title="Line spacing">
  </div>`;

function drawSheet(): void {
  if (!sheet) return;
  const key = displayedKey();
  const shift = semitones > 0 ? `+${semitones}` : `${semitones}`;

  const toolbar = `
    <div class="toolbar screen-only">
      <a class="back" href="#/" title="Back to search">←</a>
      <div class="ctl">
        <span class="lbl">Key</span>
        <strong class="key">${key ? esc(key) : '—'}</strong>
        <button id="tr-down" aria-label="Transpose down">−</button>
        <button id="tr-reset" class="shift" ${semitones ? '' : 'disabled'}
                aria-label="Reset transpose" title="Back to the original key">${shift}</button>
        <button id="tr-up" aria-label="Transpose up">+</button>
      </div>
      <div class="ctl seg">
        <button id="m-let" class="${numbers ? '' : 'on'}" aria-label="Show chords as letters"><span class="wide">Letters</span><span class="narrow">ABC</span></button>
        <button id="m-num" class="${numbers ? 'on' : ''}" ${effectiveKey() ? '' : 'disabled'} aria-label="Show chords as Nashville numbers"><span class="wide">Numbers</span><span class="narrow">123</span></button>
      </div>
      <div class="ctl seg" role="group" aria-label="Chart length">
        <button id="c-full" class="${condensed ? '' : 'on'}" title="Every section with its chords">Full</button>
        <button id="c-short" class="${condensed ? 'on' : ''}" title="Chords once per section; later verses keep their words only">Short</button>
      </div>
      ${lhCtl('')}
      ${colSeg('')}
      <div class="spacer"></div>
      <button id="print" class="primary" aria-label="Print or save as PDF">Print / PDF</button>
    </div>`;

  const meta = [
    key ? `Key of ${key}${!sheet.key && inferredKey ? ' (detected)' : ''}` : null,
    semitones ? `transposed ${shift}` : null,
    // With a capo the numbers count from the shapes' key, not the sounding one
    // named alongside it. Two keys on one line is confusing unless the line says
    // which is which.
    numbers
      ? numberCapo() && numberKey()
        ? `Nashville numbers from ${numberKey()}`
        : 'Nashville numbers'
      : null,
    sheet.capo ? `Capo ${sheet.capo}` : null,
    sheet.tuning ? `Tuning ${sheet.tuning}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // The tab this chart came from, when UG named it. Only an absolute http(s)
  // URL is offered as a link — anything else is not something to point at.
  const tabUrl = sheet.url && /^https?:\/\//i.test(sheet.url) ? sheet.url : null;

  const all = condensed ? condense(lines) : lines;
  const { facts, chart } = splitPreamble(all);

  const renderLine = (l: SheetLine): string => {
    const row = l.chords.length ? layoutChords(l.chords, renderSymbol) : '';
    if (!row && !l.lyric.trim() && !l.section) return '<div class="gap"></div>';
    // Two renderings of the same line: the exact <pre> pair for wide screens
    // and for print, and a wrapping one for phones. CSS picks.
    const flow = renderFlow(toCells(l.chords, l.lyric));
    // A line that is only a citation — UG's "YouTube link to the version
    // tabbed" — is worth a tap on screen and nothing at all on paper.
    // A line with no chords of its own reserves no room for them: that empty
    // row is what double-spaced every repeated verse in the short version.
    const cls = `pair${hasUrl(l.lyric) ? ' weblink' : ''}${l.chords.length ? '' : ' bare'}`;
    return `
      <div class="${cls}">
        ${l.section ? `<div class="section">${esc(l.section)}</div>` : ''}
        <div class="fixed">
          ${row.trim() ? `<pre class="chords">${esc(row)}</pre>` : ''}
          ${l.lyric.trim() ? `<pre class="lyric">${escLinks(l.lyric)}</pre>` : ''}
        </div>
        <div class="flow">${flow}</div>
      </div>`;
  };

  // Grouped by section, because a break has to be allowed BETWEEN sections and
  // forbidden inside one — and that is a property of a box, not of a line. A
  // chorus split down the middle by a column or a page is unplayable.
  const body = groupBySection(chart)
    .map((blk) => `<section class="blk">${blk.map(renderLine).join('')}</section>`)
    .join('');

  main.innerHTML = `
    <article class="chart">
      ${toolbar}
      <header class="masthead">
        <div class="mh-tools screen-only">
          ${lhCtl('-m')}
          ${colSeg('-m')}
          <button id="print-m" class="primary" aria-label="Print or save as PDF">Print / PDF</button>
        </div>
        <h1>${esc(sheet.song)}</h1>
        <p class="byline">${esc(sheet.artist)}</p>
        <div class="headline">
          <div>
            ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
            ${
              tabUrl
                ? // Screen only: on paper a link is just underlined text.
                  `<p class="meta screen-only"><a class="ext" href="${esc(tabUrl)}" target="_blank"
                     rel="noopener noreferrer">Ultimate Guitar tab</a></p>`
                : ''
            }
          </div>
          ${
            facts.length
              ? `<div class="facts">${facts.map((f) => `<p class="meta">${esc(f)}</p>`).join('')}</div>`
              : ''
          }
        </div>
      </header>
      <div class="sheet${columns === 2 ? ' cols-2' : ''}" style="--lh:${lineHeight}">${body}</div>
      <footer class="credit">
        Chart from Ultimate Guitar${sheet.rating ? ` · ${sheet.rating.toFixed(1)}★ from ${sheet.votes?.toLocaleString()} votes` : ''}.
        Chords are an interpretation; recordings vary.
        ${buildLine()}
      </footer>
    </article>`;

  const on = (id: string, fn: () => void) =>
    document.getElementById(id)?.addEventListener('click', fn);
  on('tr-down', () => {
    semitones = Math.max(-11, semitones - 1);
    drawSheet();
  });
  on('tr-up', () => {
    semitones = Math.min(11, semitones + 1);
    drawSheet();
  });
  on('tr-reset', () => {
    semitones = 0;
    drawSheet();
  });
  on('m-let', () => {
    numbers = false;
    drawSheet();
  });
  on('m-num', () => {
    if (effectiveKey()) {
      numbers = true;
      drawSheet();
    }
  });
  on('c-full', () => {
    if (!condensed) return;
    condensed = false;
    drawSheet();
  });
  on('c-short', () => {
    if (condensed) return;
    condensed = true;
    drawSheet();
  });
  // Two sliders, one per breakpoint — the toolbar on a desktop, the masthead on
  // a phone, where that row has no width left. Applied to the element rather
  // than redrawn: a redraw per tick would take the slider out from under the
  // pointer mid-drag. The other slider is set too, so they never disagree.
  for (const id of ['lh', 'lh-m']) {
    document.getElementById(id)?.addEventListener('input', (e) => {
      lineHeight = Number((e.target as HTMLInputElement).value);
      remember('lineHeight', lineHeight);
      main.querySelector<HTMLElement>('.sheet')?.style.setProperty('--lh', String(lineHeight));
      for (const other of ['lh', 'lh-m']) {
        const el = document.getElementById(other) as HTMLInputElement | null;
        if (el && el !== e.target) el.value = String(lineHeight);
      }
    });
  }
  for (const sfx of ['', '-m']) {
    on(`col-1${sfx}`, () => {
      if (columns === 1) return;
      columns = 1;
      remember('columns', columns);
      drawSheet();
    });
    on(`col-2${sfx}`, () => {
      if (columns === 2) return;
      columns = 2;
      remember('columns', columns);
      drawSheet();
    });
  }
  // Two buttons, one per breakpoint: in the toolbar on a desktop, under the
  // title on a phone, where the toolbar has no width to spare. CSS shows one.
  on('print', printChart);
  on('print-m', printChart);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
function route(): void {
  const h = location.hash || '#/';
  if (h.startsWith('#/admin')) {
    void renderAdmin();
    return;
  }
  const m = h.match(/^#\/t\/(\d{1,12})/);
  if (m) {
    void renderSheet(m[1]);
    return;
  }
  sheet = null;
  document.title = 'chords';
  renderHome();
  if (hits.length) renderResults();
}

window.addEventListener('hashchange', route);

// Print reached by keyboard or by the browser's own menu rather than the app's
// button. Building twice is harmless — buildPrintPages() clears first — and the
// pages are cleared afterwards so nothing but the print view ever sees them.
window.addEventListener('beforeprint', buildPrintPages);
window.addEventListener('afterprint', clearPrintPages);

// Keep the search a keystroke away from anywhere.
window.addEventListener('keydown', (ev) => {
  if (ev.key === '/' && !/^(INPUT|TEXTAREA)$/.test((ev.target as HTMLElement).tagName)) {
    ev.preventDefault();
    if (location.hash && location.hash !== '#/') location.hash = '#/';
    else (document.getElementById('q') as HTMLInputElement | null)?.focus();
  }
});

route();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline support is a bonus, never a requirement */
    });
  });
}
