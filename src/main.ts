import './style.css';
import {
  inferKey,
  intervalForSemitones,
  keyIsMinor,
  keyTonicOf,
  toNashville,
  transposeSymbol,
} from './music';
import { layoutChords, parseSheet, type ChordAt, type SheetLine } from './ug';

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
let searchSeq = 0;
let lastQuery = '';

interface Suggestion {
  id: string;
  title: string;
  artist: string;
  year: string | null;
  art: string | null;
}
let acItems: Suggestion[] = [];
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

function renderSymbol(sym: string): string {
  if (/^N\.?C\.?$/.test(sym)) return sym;
  const t = transposeSymbol(sym, intervalForSemitones(semitones));
  return numbers ? toNashville(t, displayedTonic()) : t;
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
    </section>`;
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

async function adminPost(body: Record<string, unknown>): Promise<void> {
  const res = await fetch('/api/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) return signedOut();
  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }
  void renderAdmin();
}

async function renderAdmin(): Promise<void> {
  document.title = 'Users · chords';
  const res = await fetch('/api/admin');
  if (res.status === 401) return signedOut();
  if (res.status === 403) {
    main.innerHTML = `<section class="hero"><h1>Admins only</h1><p><a href="#/">← Back</a></p></section>`;
    return;
  }
  const data = await res.json();

  const users: Person[] = data.users ?? [];
  const pending: Person[] = data.pending ?? [];
  const invites: Person[] = data.invites ?? [];

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
          If you have neither, have them sign in once and approve the request that appears here.</p>
        <form id="lookup-form" class="row" autocomplete="off">
          <input id="lookup-q" placeholder="@username or id" aria-label="Telegram username or id">
          <button type="submit">Find</button>
          <button type="button" id="set-btn" title="Grant access to exactly what is typed">Set</button>
        </form>
        <div id="lookup-out"></div>
      </section>

      ${
        pending.length
          ? `<section class="panel">
              <h2>Waiting for approval</h2>
              <ul class="people">
                ${pending
                  .map((p) =>
                    personRow(
                      p,
                      `<button data-approve="${esc(p.sub || '')}">Approve</button>
                       <button class="danger" data-remove="${esc(p.sub || '')}">Dismiss</button>`
                    )
                  )
                  .join('')}
              </ul>
            </section>`
          : ''
      }

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
    const v = (document.getElementById('lookup-q') as HTMLInputElement).value.trim();
    if (!v) return;
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
        ?.addEventListener('click', () => void adminPost({ action: 'invite', username: found.username }));
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
      void adminPost({
        action: 'invite',
        username: found.username,
        name: found.name,
        photo: found.photo,
        telegramId: found.telegramId,
      });
    });
  });

  main.querySelectorAll<HTMLElement>('[data-approve]').forEach((b) =>
    b.addEventListener('click', () => void adminPost({ action: 'approve', sub: b.dataset.approve }))
  );
  main.querySelectorAll<HTMLElement>('[data-revoke]').forEach((b) =>
    b.addEventListener('click', () => void adminPost({ action: 'revoke', sub: b.dataset.revoke }))
  );
  main.querySelectorAll<HTMLElement>('[data-remove]').forEach((b) =>
    b.addEventListener('click', () => {
      if (confirm('Remove this person entirely?')) void adminPost({ action: 'remove', sub: b.dataset.remove });
    })
  );
  main.querySelectorAll<HTMLElement>('[data-unset]').forEach((b) =>
    b.addEventListener('click', () => void adminPost({ action: 'unset', value: b.dataset.unset }))
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

function drawAutocomplete(): void {
  const ul = document.getElementById('ac');
  const input = document.getElementById('q') as HTMLInputElement | null;
  if (!ul) return;
  if (!acItems.length) {
    ul.hidden = true;
    ul.innerHTML = '';
    input?.setAttribute('aria-expanded', 'false');
    return;
  }
  ul.innerHTML = acItems
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

function pickSuggestion(i: number): void {
  const t = acItems[i];
  if (!t) return;
  const input = document.getElementById('q') as HTMLInputElement | null;
  // Fill the box with the corrected spelling, then go straight to the chords.
  if (input) input.value = `${t.title} ${t.artist}`;
  acItems = [];
  drawAutocomplete();
  void search(`${t.title} ${t.artist}`);
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
      acItems = [];
      drawAutocomplete();
      return;
    }
    acTimer = window.setTimeout(() => void suggest(q), 200);
  });

  input.addEventListener('keydown', (ev) => {
    if (!acItems.length || (ul as HTMLElement)?.hidden) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      acIndex =
        ev.key === 'ArrowDown'
          ? Math.min(acItems.length - 1, acIndex + 1)
          : Math.max(-1, acIndex - 1);
      drawAutocomplete();
    } else if (ev.key === 'Enter' && acIndex >= 0) {
      ev.preventDefault();
      pickSuggestion(acIndex);
    } else if (ev.key === 'Escape') {
      acItems = [];
      drawAutocomplete();
    }
  });

  ul?.addEventListener('mousedown', (ev) => {
    const li = (ev.target as HTMLElement).closest('li');
    if (li?.dataset.i) {
      ev.preventDefault();
      pickSuggestion(Number(li.dataset.i));
    }
  });

  document.addEventListener('click', (ev) => {
    if (!(ev.target as HTMLElement).closest('.hero-search, .autocomplete')) {
      acItems = [];
      drawAutocomplete();
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
      acItems = [];
      drawAutocomplete();
      void search(q);
    }
  });
}

async function search(q: string): Promise<void> {
  lastQuery = q;
  const seq = ++searchSeq;
  const box = document.getElementById('results');
  if (box) box.innerHTML = `<p class="muted loading">Searching…</p>`;

  try {
    const res = await fetch(`/api/ug?q=${encodeURIComponent(q)}`);
    if (res.status === 401) return signedOut();
    const data = await res.json();
    if (seq !== searchSeq) return;
    if (data.error) throw new Error(data.error);
    hits = data.results ?? [];
  } catch (e) {
    if (seq !== searchSeq) return;
    const box2 = document.getElementById('results');
    if (box2) box2.innerHTML = `<p class="muted">Search failed: ${esc((e as Error).message)}</p>`;
    return;
  }
  renderResults();
}

function renderResults(): void {
  const box = document.getElementById('results');
  if (!box) return;
  if (!hits.length) {
    box.innerHTML = `<p class="muted">Nothing found. Try the artist name as well.</p>`;
    return;
  }
  box.innerHTML = `
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
        `<span class="ct">${esc(c.text)}</span></span>`
    )
    .join('');
}

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
        <span class="shift">${shift}</span>
        <button id="tr-up" aria-label="Transpose up">+</button>
        <button id="tr-reset" ${semitones ? '' : 'disabled'} aria-label="Reset transpose"><span class="wide">reset</span><span class="narrow">↺</span></button>
      </div>
      <div class="ctl seg">
        <button id="m-let" class="${numbers ? '' : 'on'}" aria-label="Show chords as letters"><span class="wide">Letters</span><span class="narrow">ABC</span></button>
        <button id="m-num" class="${numbers ? 'on' : ''}" ${effectiveKey() ? '' : 'disabled'} aria-label="Show chords as Nashville numbers"><span class="wide">Numbers</span><span class="narrow">123</span></button>
      </div>
      <button id="cond" class="${condensed ? 'on' : ''}" aria-pressed="${condensed}" aria-label="Condense repeated sections" title="Chords once per section; later verses keep their words only"><span class="wide">${condensed ? 'Condensed' : 'Full chart'}</span><span class="narrow">${condensed ? 'Short' : 'Full'}</span></button>
      <div class="spacer"></div>
      <button id="print" class="primary" aria-label="Print or save as PDF"><span class="wide">Print / PDF</span><span class="narrow">PDF</span></button>
    </div>`;

  const meta = [
    key ? `Key of ${key}${!sheet.key && inferredKey ? ' (detected)' : ''}` : null,
    semitones ? `transposed ${shift}` : null,
    numbers ? 'Nashville numbers' : null,
    sheet.capo ? `Capo ${sheet.capo}` : null,
    sheet.tuning ? `Tuning ${sheet.tuning}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const body = (condensed ? condense(lines) : lines)
    .map((l) => {
      const row = l.chords.length ? layoutChords(l.chords, renderSymbol) : '';
      if (!row && !l.lyric.trim() && !l.section) return '<div class="gap"></div>';
      // Two renderings of the same line: the exact <pre> pair for wide screens
      // and for print, and a wrapping one for phones. CSS picks.
      const flow = renderFlow(toCells(l.chords, l.lyric));
      return `
      <div class="pair">
        ${l.section ? `<div class="section">${esc(l.section)}</div>` : ''}
        <div class="fixed">
          ${row.trim() ? `<pre class="chords">${esc(row)}</pre>` : ''}
          ${l.lyric.trim() ? `<pre class="lyric">${esc(l.lyric)}</pre>` : ''}
        </div>
        <div class="flow">${flow}</div>
      </div>`;
    })
    .join('');

  main.innerHTML = `
    <article class="chart">
      ${toolbar}
      <header class="masthead">
        <h1>${esc(sheet.song)}</h1>
        <p class="byline">${esc(sheet.artist)}</p>
        ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
      </header>
      <div class="sheet">${body}</div>
      <footer class="credit">
        Chart from Ultimate Guitar${sheet.rating ? ` · ${sheet.rating.toFixed(1)}★ from ${sheet.votes?.toLocaleString()} votes` : ''}.
        Chords are an interpretation; recordings vary.
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
  on('cond', () => {
    condensed = !condensed;
    drawSheet();
  });
  on('print', () => window.print());
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
