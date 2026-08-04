import './style.css';
import {
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
function displayedTonic(): string | null {
  const tonic = keyTonicOf(sheet?.key ?? null);
  if (!tonic) return null;
  return transposeSymbol(tonic, intervalForSemitones(semitones)).split('/')[0];
}

function displayedKey(): string | null {
  const t = displayedTonic();
  if (!t) return null;
  return keyIsMinor(sheet!.key) ? `${t}m` : t;
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
        <button id="m-num" class="${numbers ? 'on' : ''}" ${sheet.key ? '' : 'disabled'} aria-label="Show chords as Nashville numbers"><span class="wide">Numbers</span><span class="narrow">123</span></button>
      </div>
      <div class="spacer"></div>
      <button id="print" class="primary" aria-label="Print or save as PDF"><span class="wide">Print / PDF</span><span class="narrow">PDF</span></button>
    </div>`;

  const meta = [
    key ? `Key of ${key}` : null,
    semitones ? `transposed ${shift}` : null,
    numbers ? 'Nashville numbers' : null,
    sheet.capo ? `Capo ${sheet.capo}` : null,
    sheet.tuning ? `Tuning ${sheet.tuning}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const body = lines
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
    if (sheet!.key) {
      numbers = true;
      drawSheet();
    }
  });
  on('print', () => window.print());
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
function route(): void {
  const h = location.hash || '#/';
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
