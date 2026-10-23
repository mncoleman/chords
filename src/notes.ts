// Notes on a chart, two ways: a drawer of typed notes beside it, and ink drawn
// straight onto it — pen, highlighter and text boxes, the way a pencilled
// rehearsal mark sits on a paper chart.
//
// Both belong to one person and one chart, and are kept by /api/notes. The
// drawing preferences (colour, width, text size, Pencil only) are one per
// person, for every chart.
//
// Ink is pinned to a LINE of the chart, not to the page. The chart reflows:
// transposing changes chord widths, two columns become one, Short drops whole
// lines. A mark stored as page coordinates would drift off the chorus it was
// written on; stored as an offset from that line, it moves with it. A mark
// whose line is not shown (a tab line on piano) is not shown either.

export interface NotesHost {
  signedOut(): void;
  /** The chart's chord changes arrived from the server and differ from the
   *  ones on screen: the chart needs drawing again. */
  chordsChanged(): void;
}

interface Stroke {
  k: 's';
  /** The line it is pinned to (data-src), or -1 for the chart's top corner. */
  a: number;
  c: string;
  w: number;
  /** Highlighter: wide and see-through. */
  h?: 1;
  /** x, y, x, y… from the line's top left. */
  p: number[];
}
interface TextBox {
  k: 't';
  a: number;
  c: string;
  s: number;
  x: number;
  y: number;
  t: string;
}
type Item = Stroke | TextBox;
interface Doc {
  text: string;
  ink: Item[];
  /** Chords swapped by the reader: "<line>:<chord index>" -> the new symbol,
   *  written in the chart's own key (before any transposing), so it moves
   *  with the rest when the key changes. */
  chords?: Record<string, string>;
  updated: number;
}
const hasContent = (d: Doc) => !!(d.text || d.ink.length || Object.keys(d.chords ?? {}).length);
interface Prefs {
  color: string;
  width: number;
  textSize: number;
  pencilOnly: boolean;
}
type Tool = 'pen' | 'hi' | 'text' | 'erase';

const COLORS = ['#e5484d', '#f5a524', '#46a758', '#7dd3fc', '#a78bfa', '#f4f4f5'];
const WIDTHS = [2, 3.5, 6];
const DEFAULT_PREFS: Prefs = { color: COLORS[0], width: 3.5, textSize: 16, pencilOnly: false };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`chords.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function keep(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(`chords.${key}`);
    else localStorage.setItem(`chords.${key}`, JSON.stringify(value));
  } catch {
    /* storage is a convenience */
  }
}

let host: NotesHost = { signedOut: () => {}, chordsChanged: () => {} };
let chartId: string | null = null;
let chartTitle = '';
let doc: Doc = { text: '', ink: [], updated: 0 };
/** Changed here and not yet confirmed by the server. */
let dirty = false;
let saveTimer: number | undefined;
let saving: Promise<void> = Promise.resolve();
let status: 'saved' | 'saving' | 'offline' = 'saved';

let prefs: Prefs = { ...DEFAULT_PREFS, ...load<Partial<Prefs>>('notePrefs', {}) };
let prefsTimer: number | undefined;
let prefsLoaded = false;

let drawMode = false;
let tool: Tool = load<Tool>('inkTool', 'pen');
let undo: string[] = [];
let drawerOpen = load<boolean>('notesOpen', false);

let article: HTMLElement | null = null;
let layer: HTMLElement | null = null;
let observer: ResizeObserver | null = null;

export function initNotes(h: NotesHost): void {
  host = h;
  window.addEventListener('pagehide', () => flush(true));
  window.addEventListener('online', () => {
    if (dirty) scheduleSave(0);
  });
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const localKey = (id: string) => `notes.${id}`;

async function api(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (res.status === 401) {
    host.signedOut();
    throw new Error('signed out');
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `Failed (${res.status})`);
  return body;
}

/** Show this chart's notes, or none. Called whenever a chart is drawn, and
 *  with null on leaving the chart views. */
export function openChart(id: string | null, title = ''): void {
  chartTitle = title;
  if (id === chartId) {
    drawDrawer();
    return;
  }
  flush();
  chartId = id;
  undo = [];
  if (!id) {
    setDrawMode(false);
    document.getElementById('notes-drawer')?.remove();
    document.body.classList.remove('notes-docked');
    unmount();
    return;
  }
  const local = load<{ doc: Doc; dirty: boolean } | null>(localKey(id), null);
  doc = local?.doc ?? { text: '', ink: [], updated: 0 };
  dirty = local?.dirty ?? false;
  status = dirty ? 'offline' : 'saved';
  drawDrawer();
  if (!prefsLoaded) loadPrefs();

  const asked = id;
  api(`/api/notes?id=${encodeURIComponent(id)}`)
    .then((d) => {
      if (chartId !== asked) return;
      const server = d as Doc;
      // Unsent work made here wins over an older copy there; otherwise the
      // server's copy is the truth (it may come from another device).
      if (dirty && doc.updated >= server.updated) {
        scheduleSave(0);
        return;
      }
      if (server.updated >= doc.updated || !dirty) {
        const before = JSON.stringify(doc.chords ?? {});
        doc = { text: server.text || '', ink: server.ink || [], chords: server.chords || {}, updated: server.updated || 0 };
        dirty = false;
        keep(localKey(asked), hasContent(doc) ? { doc, dirty } : null);
        status = 'saved';
        if (JSON.stringify(doc.chords) !== before) host.chordsChanged();
        render();
        drawDrawer(true);
      }
    })
    .catch(() => {
      /* the local copy stands */
    });
}

function changed(): void {
  if (!chartId) return;
  doc.updated = Date.now();
  dirty = true;
  keep(localKey(chartId), { doc, dirty });
  scheduleSave(900);
  if (drawMode) drawPalette(); // undo and erase-all follow what there is
}

function scheduleSave(ms: number): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void save(), ms);
}

function save(leaving = false): Promise<void> {
  if (!chartId || !dirty) return saving;
  const id = chartId;
  const body = JSON.stringify(doc);
  const sentAt = doc.updated;
  status = 'saving';
  drawStatus();
  saving = saving.then(() =>
    api(`/api/notes?id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      // A page being closed can still send a small save; a big one is kept
      // locally and sent next time the chart is opened.
      keepalive: leaving && body.length < 60000,
    })
      .then(() => {
        if (chartId === id && doc.updated === sentAt) {
          dirty = false;
          keep(localKey(id), hasContent(doc) ? { doc, dirty } : null);
          status = 'saved';
        }
      })
      .catch((e) => {
        status = 'offline';
        if ((e as Error).message.startsWith('Too much ink')) alert((e as Error).message);
      })
      .finally(drawStatus)
  );
  return saving;
}

function flush(leaving = false): void {
  window.clearTimeout(saveTimer);
  if (dirty) void save(leaving);
}

function loadPrefs(): void {
  prefsLoaded = true;
  api('/api/notes?prefs=1')
    .then((p) => {
      prefs = { ...DEFAULT_PREFS, ...(p as Prefs) };
      keep('notePrefs', prefs);
      drawPalette();
    })
    .catch(() => {
      prefsLoaded = false;
    });
}

function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
  prefs[k] = v;
  keep('notePrefs', prefs);
  window.clearTimeout(prefsTimer);
  prefsTimer = window.setTimeout(() => {
    void api('/api/notes?prefs=1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    }).catch(() => {});
  }, 700);
  drawPalette();
  layer?.classList.toggle('pencil', prefs.pencilOnly);
}

// ---------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------

const PENCIL_SVG =
  '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/></svg>';
const NOTE_SVG =
  '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h4"/></svg>';

/** The two buttons under the title. */
export function notesButtons(): string {
  return `
    <button id="draw-btn" class="savebtn screen-only${drawMode ? ' on' : ''}" aria-pressed="${drawMode}"
            title="Draw on the chart">${PENCIL_SVG}<span>${drawMode ? 'Drawing' : 'Draw'}</span></button>
    <button id="notes-btn" class="savebtn screen-only${drawerOpen ? ' on' : ''}" aria-pressed="${drawerOpen}"
            title="Notes for this chart">${NOTE_SVG}<span>Notes</span></button>`;
}

export function wireNotesButtons(): void {
  document.getElementById('draw-btn')?.addEventListener('click', () => setDrawMode(!drawMode));
  document.getElementById('notes-btn')?.addEventListener('click', () => setDrawer(!drawerOpen));
}

function syncButtons(): void {
  const d = document.getElementById('draw-btn');
  if (d) {
    d.classList.toggle('on', drawMode);
    d.setAttribute('aria-pressed', String(drawMode));
    const lbl = d.querySelector('span');
    if (lbl) lbl.textContent = drawMode ? 'Drawing' : 'Draw';
  }
  const n = document.getElementById('notes-btn');
  if (n) {
    n.classList.toggle('on', drawerOpen);
    n.setAttribute('aria-pressed', String(drawerOpen));
  }
}

function setDrawer(open: boolean): void {
  drawerOpen = open;
  keep('notesOpen', open);
  const el = document.getElementById('notes-drawer');
  if (el) {
    el.style.transform = '';
    el.classList.toggle('open', open);
    el.querySelector('.nd-handle')?.setAttribute('aria-expanded', String(open));
  }
  document.body.classList.toggle('notes-docked', open && !!el);
  syncButtons();
  // Docking narrows the page, and the ink follows its lines.
  requestAnimationFrame(render);
}

function drawStatus(): void {
  const s = document.getElementById('nd-status');
  if (s) s.textContent = status === 'saving' ? 'Saving…' : status === 'offline' ? 'Not saved yet' : 'Saved';
}

/** Build the drawer, or bring it up to date. `fresh` replaces the text even
 *  if it is there already (new text arrived from the server), but never under
 *  someone typing in it. */
function drawDrawer(fresh = false): void {
  if (!chartId) return;
  let el = document.getElementById('notes-drawer');
  if (!el) {
    el = document.createElement('aside');
    el.id = 'notes-drawer';
    el.className = 'notes-drawer screen-only';
    el.innerHTML = `
      <button class="nd-handle" aria-label="Notes" aria-expanded="${drawerOpen}" aria-controls="nd-text">
        <span>Notes</span>
      </button>
      <div class="nd-body">
        <div class="nd-head">
          <div class="nd-title"><strong>Notes</strong><span class="muted small" id="nd-song"></span></div>
          <span class="muted small" id="nd-status"></span>
          <button class="nd-close" aria-label="Close notes" title="Close">×</button>
        </div>
        <textarea id="nd-text" placeholder="Notes for this chart: who starts, the tag at the end, the key change…"></textarea>
      </div>`;
    document.body.appendChild(el);
    wireDrawer(el);
    fresh = true;
  }
  el.classList.toggle('open', drawerOpen);
  document.body.classList.toggle('notes-docked', drawerOpen);
  const song = document.getElementById('nd-song');
  if (song) song.textContent = chartTitle;
  const ta = el.querySelector<HTMLTextAreaElement>('#nd-text')!;
  if ((fresh || ta.dataset.chart !== chartId) && document.activeElement !== ta) {
    ta.value = doc.text;
    ta.dataset.chart = chartId;
  }
  drawStatus();
}

function wireDrawer(el: HTMLElement): void {
  const ta = el.querySelector<HTMLTextAreaElement>('#nd-text')!;
  ta.addEventListener('input', () => {
    if (ta.dataset.chart !== chartId) return;
    doc.text = ta.value;
    changed();
  });
  el.querySelector('.nd-close')?.addEventListener('click', () => setDrawer(false));

  // The handle slides the drawer: a tap opens or closes it, a drag pulls it
  // out or pushes it back and it settles whichever way it was going.
  const handle = el.querySelector<HTMLElement>('.nd-handle')!;
  let x0 = 0;
  let moved = false;
  let width = 0;
  let last = { x: 0, t: 0 };
  let speed = 0;
  handle.addEventListener('pointerdown', (e) => {
    x0 = e.clientX;
    moved = false;
    width = el.querySelector<HTMLElement>('.nd-body')!.offsetWidth;
    last = { x: e.clientX, t: e.timeStamp };
    speed = 0;
    handle.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - x0;
    if (Math.abs(dx) > 4) moved = true;
    if (!moved) return;
    const start = drawerOpen ? 0 : width;
    const off = Math.max(0, Math.min(width, start + dx));
    el.style.transform = `translateX(${off}px)`;
    const dt = e.timeStamp - last.t;
    if (dt > 0) speed = (e.clientX - last.x) / dt;
    last = { x: e.clientX, t: e.timeStamp };
  });
  const end = (e: PointerEvent) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    handle.releasePointerCapture(e.pointerId);
    el.classList.remove('dragging');
    if (!moved) return setDrawer(!drawerOpen);
    const start = drawerOpen ? 0 : width;
    const off = Math.max(0, Math.min(width, start + e.clientX - x0));
    // A flick decides; otherwise wherever more of it is.
    const open = Math.abs(speed) > 0.4 ? speed < 0 : off < width / 2;
    setDrawer(open);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------------------
// Chord changes
// ---------------------------------------------------------------------------

/** A chart's chord changes. The open chart's come from its live notes; any
 *  other chart's (a set's neighbours, a set's PDF) from this device's copy,
 *  if it has one. */
export function chordEdits(id: string): Record<string, string> {
  if (id === chartId) return doc.chords ?? {};
  return load<{ doc: Doc } | null>(localKey(id), null)?.doc?.chords ?? {};
}

/** Swap one chord of the open chart, or (null) put the original back. */
export function setChordEdit(key: string, symbol: string | null): void {
  if (!chartId) return;
  const next = { ...(doc.chords ?? {}) };
  if (symbol) next[key] = symbol;
  else delete next[key];
  doc.chords = next;
  changed();
}

// ---------------------------------------------------------------------------
// Ink: where things go
// ---------------------------------------------------------------------------

interface Pt {
  x: number;
  y: number;
}

/** Each shown line's box, relative to the chart. Measured once per pass. */
function measure(): Map<number, DOMRect> {
  const out = new Map<number, DOMRect>();
  if (!article) return out;
  const base = article.getBoundingClientRect();
  article.querySelectorAll<HTMLElement>('.sheet .pair[data-src]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.height) return;
    out.set(Number(el.dataset.src), new DOMRect(r.left - base.left, r.top - base.top, r.width, r.height));
  });
  return out;
}

function originOf(a: number, boxes: Map<number, DOMRect>): Pt | null {
  if (a === -1) return { x: 0, y: 0 };
  const r = boxes.get(a);
  return r ? { x: r.x, y: r.y } : null;
}

/** The line a mark starting here belongs to: the one under it, in the column
 *  under it, or the nearest one above. Above the first line it is the top. */
function anchorAt(p: Pt, boxes: Map<number, DOMRect>): number {
  let best = -1;
  let bestTop = -Infinity;
  for (const [src, r] of boxes) {
    if (p.x < r.left - 24 || p.x > r.right + 24) continue;
    if (r.top <= p.y && r.top > bestTop) {
      best = src;
      bestTop = r.top;
    }
  }
  return best;
}

function pathD(pts: number[], ox: number, oy: number): string {
  const n = pts.length / 2;
  const X = (i: number) => (pts[i * 2] + ox).toFixed(1);
  const Y = (i: number) => (pts[i * 2 + 1] + oy).toFixed(1);
  if (n === 1) return `M${X(0)} ${Y(0)}l0.01 0`;
  let d = `M${X(0)} ${Y(0)}`;
  // Through the midpoints, with each sample as the control point: smooth
  // without wandering from where the pen actually went.
  for (let i = 1; i < n - 1; i++) {
    const mx = ((pts[i * 2] + pts[i * 2 + 2]) / 2 + ox).toFixed(1);
    const my = ((pts[i * 2 + 1] + pts[i * 2 + 3]) / 2 + oy).toFixed(1);
    d += `Q${X(i)} ${Y(i)} ${mx} ${my}`;
  }
  return d + `L${X(n - 1)} ${Y(n - 1)}`;
}

const strokeWidth = (s: { w: number; h?: 1 }) => (s.h ? s.w * 4 : s.w);

function strokeEl(s: Stroke, o: Pt, i: number): string {
  return `<path data-i="${i}" d="${pathD(s.p, o.x, o.y)}" stroke="${s.c}" stroke-width="${strokeWidth(s)}"${
    s.h ? ' stroke-opacity="0.35" class="hi"' : ''
  }/>`;
}

/** Draw every mark where its line now is. */
function render(): void {
  if (!layer || !article) return;
  const boxes = measure();
  const svg = layer.querySelector('svg')!;
  const texts = layer.querySelector<HTMLElement>('.ink-texts')!;
  let paths = '';
  let boxesHtml = '';
  doc.ink.forEach((it, i) => {
    const o = originOf(it.a, boxes);
    if (!o) return;
    if (it.k === 's') paths += strokeEl(it, o, i);
    else
      boxesHtml += `<div class="ink-text" data-i="${i}" style="left:${it.x + o.x}px;top:${it.y + o.y}px;color:${it.c};font-size:${it.s}px">${esc(it.t)}</div>`;
  });
  svg.innerHTML = paths;
  // An open editor is left alone; it is committed when it loses focus.
  const editing = texts.querySelector('.ink-text.editing');
  texts.innerHTML = boxesHtml;
  if (editing) texts.appendChild(editing);
}

// ---------------------------------------------------------------------------
// Ink: the layer and the pen
// ---------------------------------------------------------------------------

function unmount(): void {
  observer?.disconnect();
  observer = null;
  layer = null;
  article = null;
}

/** Put the ink over a freshly drawn chart. */
export function mountInk(art: HTMLElement | null): void {
  unmount();
  if (!art || !chartId) return;
  article = art;
  art.classList.add('inkable');
  layer = document.createElement('div');
  layer.className = `ink${drawMode ? ' drawing' : ''}${prefs.pencilOnly ? ' pencil' : ''} tool-${tool}`;
  layer.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke-linecap="round" stroke-linejoin="round"></svg><div class="ink-texts"></div>`;
  art.appendChild(layer);
  wirePen(layer);
  render();
  // Fonts landing, a rotation, the drawer docking: anything that moves the
  // lines moves the ink with them.
  let frame = 0;
  observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  });
  observer.observe(art);
  void document.fonts?.ready.then(render);
}

/** Whether a touch on the chart is the pen's, so a set's swipe should leave
 *  it alone. A finger in Pencil-only mode still swipes. */
export function inkWantsTouch(e: TouchEvent): boolean {
  if (!drawMode) return false;
  if (!prefs.pencilOnly) return true;
  const t = e.touches[0] as Touch & { touchType?: string };
  return t?.touchType === 'stylus';
}

function setDrawMode(on: boolean): void {
  if (on && !chartId) return;
  drawMode = on;
  layer?.classList.toggle('drawing', on);
  if (!on) commitEditor();
  syncButtons();
  drawPalette();
}

function pushUndo(): void {
  undo.push(JSON.stringify(doc.ink));
  if (undo.length > 60) undo.shift();
}

function wirePen(el: HTMLElement): void {
  // Pencil only: a stylus touch must not scroll the page, or the stroke is
  // cancelled the moment it starts. Fingers are left to scroll and tap.
  el.addEventListener(
    'touchstart',
    (e) => {
      if (!drawMode) return;
      const t = e.touches[0] as Touch & { touchType?: string };
      if (prefs.pencilOnly ? t?.touchType === 'stylus' : true) e.preventDefault();
    },
    { passive: false }
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      if (!drawMode) return;
      const t = e.touches[0] as Touch & { touchType?: string };
      if (prefs.pencilOnly ? t?.touchType === 'stylus' : e.touches.length === 1) e.preventDefault();
    },
    { passive: false }
  );

  let live: { id: number; s: Stroke; o: Pt; path: SVGPathElement; abs: number[] } | null = null;
  let erasing: number | null = null;
  let tap: { id: number; x: number; y: number } | null = null;
  /** Two fingers scroll, when fingers draw: there is no other way down. */
  const fingers = new Map<number, number>();
  let panY: number | null = null;

  const point = (e: PointerEvent): Pt => {
    const base = article!.getBoundingClientRect();
    return { x: e.clientX - base.left, y: e.clientY - base.top };
  };
  const accepts = (e: PointerEvent) => drawMode && (!prefs.pencilOnly || e.pointerType === 'pen');

  el.addEventListener('pointerdown', (e) => {
    if (!accepts(e) || !article) return;
    if ((e.target as Element).closest('.ink-text.editing')) return;
    if (e.pointerType === 'touch') {
      fingers.set(e.pointerId, e.clientY);
      if (fingers.size === 2) {
        // A second finger: this was a scroll, not a stroke.
        if (live) {
          live.path.remove();
          live = null;
        }
        tap = null;
        panY = [...fingers.values()].reduce((a, b) => a + b) / 2;
        return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
    commitEditor();
    el.setPointerCapture(e.pointerId);
    const p = point(e);
    if (tool === 'text') {
      tap = { id: e.pointerId, x: p.x, y: p.y };
      return;
    }
    if (tool === 'erase') {
      erasing = e.pointerId;
      pushUndo();
      eraseAt(p);
      return;
    }
    const boxes = measure();
    const a = anchorAt(p, boxes);
    const o = originOf(a, boxes) ?? { x: 0, y: 0 };
    const s: Stroke = {
      k: 's',
      a,
      c: prefs.color,
      w: prefs.width,
      ...(tool === 'hi' ? { h: 1 as const } : {}),
      p: [p.x - o.x, p.y - o.y],
    };
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('stroke', s.c);
    path.setAttribute('stroke-width', String(strokeWidth(s)));
    if (s.h) path.setAttribute('stroke-opacity', '0.35');
    el.querySelector('svg')!.appendChild(path);
    live = { id: e.pointerId, s, o, path, abs: [p.x, p.y] };
    path.setAttribute('d', pathD(live.abs, 0, 0));
  });

  el.addEventListener('pointermove', (e) => {
    if (panY !== null && fingers.has(e.pointerId)) {
      fingers.set(e.pointerId, e.clientY);
      const y = [...fingers.values()].reduce((a, b) => a + b) / fingers.size;
      window.scrollBy(0, panY - y);
      panY = y;
      return;
    }
    if (erasing === e.pointerId) {
      for (const ev of e.getCoalescedEvents?.() ?? [e]) eraseAt(point(ev));
      return;
    }
    if (!live || live.id !== e.pointerId) return;
    e.preventDefault();
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      const p = point(ev);
      const n = live.abs.length;
      // Samples closer than a pixel add weight, not shape.
      if (Math.hypot(p.x - live.abs[n - 2], p.y - live.abs[n - 1]) < 1) continue;
      live.abs.push(p.x, p.y);
      live.s.p.push(p.x - live.o.x, p.y - live.o.y);
    }
    live.path.setAttribute('d', pathD(live.abs, 0, 0));
  });

  const end = (e: PointerEvent) => {
    fingers.delete(e.pointerId);
    if (fingers.size < 2) panY = null;
    if (erasing === e.pointerId) {
      erasing = null;
      // Nothing was erased: the undo step is empty.
      if (undo[undo.length - 1] === JSON.stringify(doc.ink)) undo.pop();
      return;
    }
    if (tap && tap.id === e.pointerId) {
      const t = tap;
      tap = null;
      if (e.type === 'pointerup') textAt({ x: t.x, y: t.y }, e);
      return;
    }
    if (!live || live.id !== e.pointerId) return;
    const s = live.s;
    live = null;
    if (e.type === 'pointercancel' && s.p.length < 6) return render();
    s.p = s.p.map((v) => Math.round(v * 10) / 10);
    pushUndo();
    doc.ink.push(s);
    changed();
    render();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/** Rub out whatever the eraser is over: any stroke passing within reach, any
 *  text box it touches. */
function eraseAt(p: Pt): void {
  if (!article || !layer) return;
  const boxes = measure();
  const before = doc.ink.length;
  const textHits = new Set<number>();
  layer.querySelectorAll<HTMLElement>('.ink-text[data-i]').forEach((el) => {
    const r = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    if (p.x >= r.x - 6 && p.x <= r.x + r.w + 6 && p.y >= r.y - 6 && p.y <= r.y + r.h + 6) textHits.add(Number(el.dataset.i));
  });
  doc.ink = doc.ink.filter((it, i) => {
    if (it.k === 't') return !textHits.has(i);
    const o = originOf(it.a, boxes);
    if (!o) return true;
    const reach = strokeWidth(it) / 2 + 10;
    for (let j = 0; j < it.p.length; j += 2) {
      const ax = it.p[j] + o.x;
      const ay = it.p[j + 1] + o.y;
      const bx = (it.p[j + 2] ?? it.p[j]) + o.x;
      const by = (it.p[j + 3] ?? it.p[j + 1]) + o.y;
      if (segDist(p, ax, ay, bx, by) <= reach) return false;
    }
    return true;
  });
  if (doc.ink.length !== before) {
    changed();
    render();
  }
}

function segDist(p: Pt, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len)) : 0;
  return Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy));
}

// ---------------------------------------------------------------------------
// Text boxes
// ---------------------------------------------------------------------------

/** A tap with the text tool: edit the box under it, or start a new one. */
function textAt(p: Pt, e: PointerEvent): void {
  if (!layer || !article) return;
  const hit = document
    .elementsFromPoint(e.clientX, e.clientY)
    .find((el) => el.classList.contains('ink-text') && (el as HTMLElement).dataset.i) as HTMLElement | undefined;
  if (hit) {
    const i = Number(hit.dataset.i);
    const it = doc.ink[i];
    if (it?.k === 't') return openEditor(hit, i);
  }
  const boxes = measure();
  const a = anchorAt(p, boxes);
  const o = originOf(a, boxes) ?? { x: 0, y: 0 };
  const el = document.createElement('div');
  el.className = 'ink-text';
  // Centred on the tap vertically, so the first letter lands where the pen did.
  const y = p.y - prefs.textSize * 0.7;
  el.style.cssText = `left:${p.x}px;top:${y}px;color:${prefs.color};font-size:${prefs.textSize}px`;
  el.dataset.new = JSON.stringify({ a, x: p.x - o.x, y: y - o.y, c: prefs.color, s: prefs.textSize });
  layer.querySelector('.ink-texts')!.appendChild(el);
  openEditor(el, -1);
}

function openEditor(el: HTMLElement, i: number): void {
  el.classList.add('editing');
  el.dataset.edit = String(i);
  el.contentEditable = 'plaintext-only';
  // Firefox before 136 has no plaintext-only; true still edits.
  if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
  el.addEventListener('blur', commitEditor, { once: true });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') (ev.target as HTMLElement).blur();
  });
  el.focus();
  const sel = window.getSelection();
  sel?.selectAllChildren(el);
  sel?.collapseToEnd();
}

/** Keep what was typed in the open text box, if there is one. */
function commitEditor(): void {
  const el = layer?.querySelector<HTMLElement>('.ink-text.editing');
  if (!el) return;
  el.classList.remove('editing');
  const text = (el.innerText || '').replace(/\n+$/, '');
  const i = Number(el.dataset.edit);
  if (i >= 0) {
    const it = doc.ink[i];
    if (it?.k === 't' && it.t !== text) {
      pushUndo();
      if (text.trim()) it.t = text;
      else doc.ink.splice(i, 1);
      changed();
    }
  } else if (text.trim() && el.dataset.new) {
    pushUndo();
    doc.ink.push({ k: 't', ...JSON.parse(el.dataset.new), t: text });
    changed();
  }
  el.remove();
  render();
}

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

const TOOLS: { id: Tool; label: string; svg: string }[] = [
  { id: 'pen', label: 'Pen', svg: '<path d="M4 20l1-5L16 4l4 4L9 19z"/>' },
  { id: 'hi', label: 'Highlighter', svg: '<path d="M9 15l-4 5h6l2-2"/><path d="M9 15l8-11 4 3-8 11z"/>' },
  { id: 'text', label: 'Text', svg: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>' },
  { id: 'erase', label: 'Eraser', svg: '<path d="M8 20h12"/><path d="M4 15l9-11 7 6-8 10H8z"/>' },
];

function drawPalette(): void {
  let el = document.getElementById('ink-palette');
  if (!drawMode) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'ink-palette';
    el.className = 'ink-palette screen-only';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Drawing tools');
    document.body.appendChild(el);
    wirePalette(el);
  }
  const settingsOpen = !!el.querySelector('.ip-settings:not([hidden])');
  el.innerHTML = `
    <div class="ip-row">
      ${TOOLS.map(
        (t) => `<button data-tool="${t.id}" class="${tool === t.id ? 'on' : ''}" aria-pressed="${tool === t.id}" title="${t.label}" aria-label="${t.label}">
          <svg viewBox="0 0 24 24" aria-hidden="true">${t.svg}</svg></button>`
      ).join('')}
      <span class="ip-sep"></span>
      ${COLORS.map(
        (c) => `<button data-color="${c}" class="sw${prefs.color === c ? ' on' : ''}" style="--sw:${c}" aria-label="Colour ${c}" aria-pressed="${prefs.color === c}"></button>`
      ).join('')}
      <span class="ip-sep"></span>
      ${
        tool === 'text'
          ? `<button data-ts="-1" aria-label="Smaller text" title="Smaller text">A−</button>
             <span class="ip-val">${prefs.textSize}</span>
             <button data-ts="1" aria-label="Larger text" title="Larger text">A+</button>`
          : WIDTHS.map(
              (w) => `<button data-width="${w}" class="${prefs.width === w ? 'on' : ''}" aria-label="Width ${w}" aria-pressed="${prefs.width === w}" title="Line width">
                <span class="dot" style="width:${w * 2 + 2}px;height:${w * 2 + 2}px"></span></button>`
            ).join('')
      }
      <span class="ip-sep"></span>
      <button data-act="undo" ${undo.length ? '' : 'disabled'} aria-label="Undo" title="Undo">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/></svg></button>
      <button data-act="settings" class="${settingsOpen ? 'on' : ''}" aria-label="Drawing settings" title="Settings" aria-expanded="${settingsOpen}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>
      <button data-act="done" class="ip-done">Done</button>
    </div>
    <div class="ip-settings" ${settingsOpen ? '' : 'hidden'}>
      <label class="ip-check">
        <input type="checkbox" data-act="pencil" ${prefs.pencilOnly ? 'checked' : ''}>
        <span><strong>Only draw with Apple Pencil</strong>
          <span class="muted small">Fingers scroll and tap as usual while drawing is on.</span></span>
      </label>
      <button data-act="clear" class="danger" ${doc.ink.length ? '' : 'disabled'}>Erase everything on this chart</button>
    </div>`;
}

function wirePalette(el: HTMLElement): void {
  el.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button, input');
    if (!b) return;
    if (b.dataset.tool) {
      commitEditor();
      tool = b.dataset.tool as Tool;
      keep('inkTool', tool);
      layer?.classList.remove('tool-pen', 'tool-hi', 'tool-text', 'tool-erase');
      layer?.classList.add(`tool-${tool}`);
      return drawPalette();
    }
    if (b.dataset.color) return setPref('color', b.dataset.color);
    if (b.dataset.width) return setPref('width', Number(b.dataset.width));
    if (b.dataset.ts) return setPref('textSize', Math.max(10, Math.min(40, prefs.textSize + Number(b.dataset.ts) * 2)));
    switch (b.dataset.act) {
      case 'undo': {
        const prev = undo.pop();
        if (prev === undefined) return;
        doc.ink = JSON.parse(prev);
        changed();
        render();
        return drawPalette();
      }
      case 'settings': {
        const s = el.querySelector<HTMLElement>('.ip-settings');
        if (s) s.hidden = !s.hidden;
        return drawPalette();
      }
      case 'pencil':
        return setPref('pencilOnly', (b as HTMLInputElement).checked);
      case 'clear':
        if (!confirm('Erase all the ink on this chart? Typed notes are kept.')) return;
        pushUndo();
        doc.ink = [];
        changed();
        render();
        return drawPalette();
      case 'done':
        return setDrawMode(false);
    }
  });
  // The palette is not the chart: nothing pressed on it should draw or swipe.
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
}
