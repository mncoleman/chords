import './style.css';
import type { Chart, ChartLine, IndexEntry, SongIndex } from './types';
import { intervalForSemitones, keyIsMinor, keyTonicOf, toNashville, transposeSymbol } from './music';

const REPO_URL = 'https://github.com/mncoleman/chords';

const main = document.getElementById('main')!;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchResults = document.getElementById('search-results') as HTMLUListElement;

let index: IndexEntry[] = [];
let highlighted = -1;

/** Autosuggestions for songs NOT in the library, from the iTunes Search API
 *  (one of the few music search APIs that serves CORS to any origin). */
interface WebHit {
  title: string;
  artist: string;
}
let webHits: WebHit[] = [];
let webTimer: number | undefined;
let webSeq = 0;

// ---------------------------------------------------------------------------
// View state for the open chart
// ---------------------------------------------------------------------------
let chart: Chart | null = null;
let semitones = 0;
let numbers = false;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function matches(q: string): IndexEntry[] {
  const nq = norm(q).trim();
  if (!nq) return index;
  const terms = nq.split(/\s+/);
  return index.filter((e) => {
    const hay = norm(`${e.title} ${e.artist}`);
    return terms.every((t) => hay.includes(t));
  });
}

async function fetchWebHits(q: string): Promise<void> {
  const seq = ++webSeq;
  try {
    const res = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=6`
    );
    if (!res.ok) return;
    const data = await res.json();
    if (seq !== webSeq) return; // a newer query superseded this one
    const seen = new Set<string>();
    webHits = (data.results || [])
      .map((r: { trackName?: string; artistName?: string }) => ({
        title: r.trackName || '',
        artist: r.artistName || '',
      }))
      .filter((h: WebHit) => {
        if (!h.title || !h.artist) return false;
        const k = norm(`${h.title}|${h.artist}`);
        if (seen.has(k)) return false;
        seen.add(k);
        // Hide web suggestions the library already covers.
        return !index.some(
          (e) => norm(e.title) === norm(h.title) && norm(e.artist) === norm(h.artist)
        );
      })
      .slice(0, 5);
    renderSearchResults();
  } catch {
    /* suggestions are best-effort; the library search still works */
  }
}

function renderSearchResults(): void {
  const q = searchInput.value;
  const hits = q.trim() ? matches(q).slice(0, 8) : [];
  if (document.activeElement !== searchInput || !q.trim()) {
    searchResults.hidden = true;
    return;
  }
  const rows: string[] = [];
  const all: { kind: 'lib' | 'web'; idx: number }[] = [];
  hits.forEach((e, i) => {
    all.push({ kind: 'lib', idx: i });
    rows.push(`
      <li data-slug="${esc(e.slug)}" data-n="${all.length - 1}" class="${all.length - 1 === highlighted ? 'hl' : ''}" role="option">
        <span class="t">${esc(e.title)}</span>
        <span class="a">${esc(e.artist)}</span>
        <span class="k">${e.key ? esc(e.key) : ''}</span>
      </li>`);
  });
  if (webHits.length) {
    rows.push(`<li class="group-label">Not in the library yet — pick one to request it</li>`);
    webHits.forEach((h, i) => {
      all.push({ kind: 'web', idx: i });
      rows.push(`
        <li data-req="${esc(encodeURIComponent(h.title))}|${esc(encodeURIComponent(h.artist))}" data-n="${all.length - 1}" class="web ${all.length - 1 === highlighted ? 'hl' : ''}" role="option">
          <span class="t">${esc(h.title)}</span>
          <span class="a">${esc(h.artist)}</span>
          <span class="k">request</span>
        </li>`);
    });
  }
  if (!rows.length) {
    rows.push(`<li class="no-hit">Searching… — or see <a href="#/about">how songs get added</a></li>`);
  }
  searchResults.innerHTML = rows.join('');
  searchResults.hidden = false;
}

searchInput.addEventListener('input', () => {
  highlighted = -1;
  webHits = [];
  window.clearTimeout(webTimer);
  const q = searchInput.value.trim();
  if (q.length >= 2) {
    webTimer = window.setTimeout(() => void fetchWebHits(q), 300);
  }
  renderSearchResults();
});
function activate(li: HTMLLIElement): void {
  if (li.dataset.slug) {
    go(`#/s/${li.dataset.slug}`);
  } else if (li.dataset.req) {
    const [t, a] = li.dataset.req.split('|');
    go(`#/request/${t}/${a}`);
  }
}

searchInput.addEventListener('focus', renderSearchResults);
searchInput.addEventListener('keydown', (ev) => {
  const items = searchResults.querySelectorAll<HTMLLIElement>('li[data-n]');
  if (ev.key === 'ArrowDown') {
    highlighted = Math.min(highlighted + 1, items.length - 1);
    renderSearchResults();
    ev.preventDefault();
  } else if (ev.key === 'ArrowUp') {
    highlighted = Math.max(highlighted - 1, -1);
    renderSearchResults();
    ev.preventDefault();
  } else if (ev.key === 'Enter') {
    const pick = highlighted >= 0 ? items[highlighted] : items[0];
    if (pick) activate(pick);
  } else if (ev.key === 'Escape') {
    searchResults.hidden = true;
    searchInput.blur();
  }
});
searchResults.addEventListener('mousedown', (ev) => {
  const li = (ev.target as HTMLElement).closest<HTMLLIElement>('li[data-n]');
  if (li) activate(li);
});
document.addEventListener('click', (ev) => {
  if (!(ev.target as HTMLElement).closest('.search')) searchResults.hidden = true;
});

function go(hash: string): void {
  searchResults.hidden = true;
  searchInput.blur();
  if (location.hash === hash) route();
  else location.hash = hash;
}

// ---------------------------------------------------------------------------
// Chart rendering
// ---------------------------------------------------------------------------
function renderSymbol(sym: string): string {
  const t = transposeSymbol(sym, intervalForSemitones(semitones));
  if (!numbers) return t;
  const tonic = displayedTonic();
  return toNashville(t, tonic);
}

function displayedTonic(): string | null {
  if (!chart?.key) return null;
  const tonic = keyTonicOf(chart.key);
  if (!tonic) return null;
  return transposeSymbol(tonic, intervalForSemitones(semitones)).split('/')[0];
}

function displayedKey(): string | null {
  const tonic = displayedTonic();
  if (!tonic) return null;
  return keyIsMinor(chart!.key) ? `${tonic}m` : tonic;
}

/** Lay chord symbols out above a lyric line at their character offsets. */
function chordRow(line: ChartLine): string {
  let row = '';
  for (const c of [...line.chords].sort((a, b) => a.at - b.at)) {
    const label = renderSymbol(c.symbol);
    const at = Math.max(0, Math.min(c.at, line.text.length));
    if (at < row.length) row += ' '; // never let two chords collide
    else row = row.padEnd(at, ' ');
    row += label;
  }
  return row;
}

function confidenceBadge(c: Chart['confidence']): string {
  const label = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' }[c];
  return `<span class="badge badge-${c}">${label}</span>`;
}

function agreementIcon(a: string): string {
  if (a === 'agrees') return '<span class="agree" title="Agrees with the consensus">●</span>';
  if (a === 'differs') return '<span class="differ" title="Differs from the consensus">●</span>';
  return '<span class="partial" title="Partially agrees">●</span>';
}

function renderChart(): void {
  if (!chart) return;
  const key = displayedKey();
  const shift = semitones > 0 ? `+${semitones}` : `${semitones}`;

  const toolbar = `
    <div class="toolbar screen-only">
      <div class="ctl">
        <span class="lbl">Key</span>
        <strong class="key">${key ? esc(key) : '—'}</strong>
        <button id="tr-down" title="Transpose down a semitone" aria-label="Transpose down">−</button>
        <span class="shift">${shift}</span>
        <button id="tr-up" title="Transpose up a semitone" aria-label="Transpose up">+</button>
        <button id="tr-reset" title="Reset transposition" ${semitones ? '' : 'disabled'}>reset</button>
      </div>
      <div class="ctl seg">
        <button id="mode-letters" class="${numbers ? '' : 'on'}">Letters</button>
        <button id="mode-numbers" class="${numbers ? 'on' : ''}" ${chart.key ? '' : 'disabled title="Needs a known key"'}>Numbers</button>
      </div>
      <div class="spacer"></div>
      ${confidenceBadge(chart.confidence)}
      <button id="print-btn" class="primary" title="Print or save as PDF">Print / PDF</button>
    </div>`;

  const masthead = `
    <header class="masthead">
      <h1>${esc(chart.title)}</h1>
      <p class="byline">${esc(chart.artist)}</p>
      <p class="meta">
        ${key ? `Key of ${esc(key)}` : 'Key unknown'}${
          semitones ? ` (transposed ${shift})` : ''
        }${numbers ? ' · Nashville numbers' : ''}
      </p>
    </header>`;

  let body = '';
  if (chart.mode === 'lyrics' && chart.lines.length) {
    body = `<div class="sheet">${chart.lines
      .map((line) => {
        const row = chordRow(line);
        return `
        <div class="pair">
          ${line.section ? `<div class="section">${esc(line.section)}</div>` : ''}
          ${row.trim() ? `<pre class="chords">${esc(row)}</pre>` : ''}
          <pre class="lyric">${esc(line.text) || ' '}</pre>
        </div>`;
      })
      .join('')}</div>`;
  } else if (chart.sections.length) {
    body = `<div class="sheet timeline">${chart.sections
      .map((s) => {
        const bars = s.progression
          .map((p) => {
            const n = Math.max(1, Math.min(p.bars ?? 1, 32));
            return Array(n).fill(renderSymbol(p.symbol)).join(' | ');
          })
          .join(' | ');
        const rep = (s.repeats ?? 1) > 1 ? `  ×${s.repeats}` : '';
        return `
        <div class="pair">
          <div class="section">${esc(s.label)}${rep}</div>
          <pre class="chords">| ${esc(bars)} |</pre>
        </div>`;
      })
      .join('')}</div>`;
  } else {
    body = `<p class="muted">This chart has no content — the lookup may have found no published progression.</p>`;
  }

  const sources = `
    <section class="provenance screen-only">
      <h2>Sources &amp; consensus</h2>
      ${chart.consensus ? `<p class="consensus">${esc(chart.consensus)}</p>` : ''}
      <ul class="sources">
        ${chart.sources
          .map(
            (s) => `
          <li>
            ${agreementIcon(s.agreement)}
            ${s.url ? `<a href="${esc(s.url)}" rel="noopener nofollow">${esc(s.name)}</a>` : esc(s.name)}
            ${s.key ? `<span class="src-key">key: ${esc(s.key)}</span>` : ''}
            ${s.detail ? `<span class="src-detail">${esc(s.detail)}</span>` : ''}
          </li>`
          )
          .join('')}
      </ul>
      <p class="fine">Consensus chart generated ${esc(new Date(chart.generatedAt).toLocaleDateString())}. Chords are an interpretation; sources may transcribe the recording differently.</p>
    </section>`;

  main.innerHTML = `<article class="chart">${toolbar}${masthead}${body}${sources}</article>`;

  document.getElementById('tr-down')!.addEventListener('click', () => {
    semitones = Math.max(-11, semitones - 1);
    renderChart();
  });
  document.getElementById('tr-up')!.addEventListener('click', () => {
    semitones = Math.min(11, semitones + 1);
    renderChart();
  });
  document.getElementById('tr-reset')!.addEventListener('click', () => {
    semitones = 0;
    renderChart();
  });
  document.getElementById('mode-letters')!.addEventListener('click', () => {
    numbers = false;
    renderChart();
  });
  document.getElementById('mode-numbers')!.addEventListener('click', () => {
    if (chart!.key) {
      numbers = true;
      renderChart();
    }
  });
  document.getElementById('print-btn')!.addEventListener('click', () => window.print());
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
function renderHome(): void {
  const rows = [...index]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(
      (e) => `
      <a class="song-card" href="#/s/${esc(e.slug)}">
        <span class="t">${esc(e.title)}</span>
        <span class="a">${esc(e.artist)}</span>
        <span class="k">${e.key ? `Key of ${esc(e.key)}` : ''}</span>
      </a>`
    )
    .join('');
  main.innerHTML = `
    <section class="home">
      <h1>Chord charts, by consensus</h1>
      <p class="tag">Every chart here was built by comparing multiple published sources and keeping what they agree on — with the disagreements shown, not hidden.</p>
      <div class="song-grid">${rows || '<p class="muted">The library is empty. See below for how songs get added.</p>'}</div>
      <p class="add-hint">Missing a song? <a href="#/about">Here is how one gets added.</a></p>
    </section>`;
}

function renderAbout(): void {
  main.innerHTML = `
    <section class="about">
      <h1>Adding a song</h1>
      <p>This site is fully static — there is no server to search chord sites on demand. New charts are researched offline and committed into the library:</p>
      <ol>
        <li><strong>From the search bar:</strong> search any song — suggestions beyond the library appear automatically. Picking one gives you a pre-filled request that kicks off the lookup on GitHub; the chart appears here a few minutes later.</li>
        <li><strong>Local script:</strong> clone <a href="${REPO_URL}" rel="noopener">the repo</a> and run <code>npm run add-song -- "Title" "Artist"</code>. It uses the Claude CLI with web search to compare several published sources, writes the consensus chart JSON, and you push the commit.</li>
        <li><strong>GitHub Actions:</strong> run the <em>Add song</em> workflow from the repo's Actions tab. The Actions paths require an <code>ANTHROPIC_API_KEY</code> repository secret.</li>
      </ol>
      <p>Either way the chart lands in <code>public/data/charts/</code>, the index updates, and the site redeploys automatically.</p>
      <p><a href="#/">← Back to the library</a></p>
    </section>`;
}

function renderRequest(title: string, artist: string): void {
  const issueUrl =
    `${REPO_URL}/issues/new?template=chart-request.yml` +
    `&title=${encodeURIComponent(`Chart request: ${title} — ${artist}`)}` +
    `&song-title=${encodeURIComponent(title)}` +
    `&artist=${encodeURIComponent(artist)}`;
  main.innerHTML = `
    <section class="about request">
      <h1>${esc(title)} <span class="muted">— ${esc(artist)}</span></h1>
      <p>This song isn't in the library yet. The site is fully static, so charts are researched by a background worker that compares multiple published sources — it can't happen live in the browser.</p>
      <p><a class="cta" href="${esc(issueUrl)}" rel="noopener">Request this chart on GitHub →</a></p>
      <p class="muted">That opens a pre-filled request; submitting it kicks off the lookup automatically, and the chart appears here a few minutes later once it's committed. (The repository needs its <code>ANTHROPIC_API_KEY</code> secret configured for this to run.)</p>
      <p>Have the repo cloned? The zero-setup path is the local script:</p>
      <pre class="cmd">npm run add-song -- "${esc(title)}" "${esc(artist)}"</pre>
      <p><a href="#/">← Back to the library</a></p>
    </section>`;
}

async function renderSong(slug: string): Promise<void> {
  main.innerHTML = `<p class="muted loading">Loading…</p>`;
  try {
    const res = await fetch(`data/charts/${encodeURIComponent(slug)}.json`);
    if (!res.ok) throw new Error(`${res.status}`);
    chart = (await res.json()) as Chart;
    semitones = 0;
    numbers = false;
    document.title = `${chart.title} — ${chart.artist} · Chords`;
    renderChart();
  } catch {
    main.innerHTML = `
      <section class="about">
        <h1>Chart not found</h1>
        <p>No chart is stored for <code>${esc(slug)}</code>. <a href="#/about">How songs get added</a> · <a href="#/">library</a></p>
      </section>`;
  }
}

function route(): void {
  const h = location.hash || '#/';
  const song = h.match(/^#\/s\/([\w-]+)/);
  if (song) {
    void renderSong(song[1]);
    return;
  }
  const req = h.match(/^#\/request\/([^/]+)\/([^/]+)/);
  if (req) {
    chart = null;
    document.title = 'Request a chart · Chords';
    renderRequest(decodeURIComponent(req[1]), decodeURIComponent(req[2]));
    return;
  }
  chart = null;
  document.title = 'Chords';
  if (h.startsWith('#/about')) renderAbout();
  else renderHome();
}

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot(): Promise<void> {
  try {
    const res = await fetch('data/index.json');
    const data = (await res.json()) as SongIndex;
    index = data.songs ?? [];
  } catch {
    index = [];
  }
  route();
}

void boot();
