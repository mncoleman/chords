// Follow: listen to the chart being played and keep up with it.
//
// Entirely in the browser, and free: the microphone's spectrum is folded into
// a chroma vector (how much of each of the 12 pitch classes is sounding, the
// same feature open-source chord recognisers like Meyda and essentia.js use),
// and that is compared with the notes of the chords the chart says come next.
//
// Naming an unknown chord from a room's sound is hard. Deciding whether the
// band has moved from the chord the chart is on to the one it says comes next
// is far easier, and that is all this does: it only ever weighs the current
// chord against the next two.

import { Chord, Note } from '@tonaljs/tonal';

/** One chord change in the chart, in playing order. */
export interface Step {
  /** Index of the chart line it sits on, for highlighting and scrolling. */
  li: number;
  symbol: string;
  tpl: number[];
}

/** The pitch classes of a chord, weighted: root, third and fifth fully, any
 *  extension less, a slash bass a little. Null for anything tonal cannot read. */
export function chordChroma(symbol: string): number[] | null {
  const [head, bass] = symbol.split('/');
  const c = Chord.get(head);
  if (c.empty || !c.notes.length) return null;
  const v = new Array(12).fill(0);
  c.notes.forEach((n, i) => {
    const pc = Note.chroma(n);
    if (pc === undefined) return;
    v[pc] = Math.max(v[pc], i < 3 ? 1 : 0.5);
  });
  if (bass) {
    const b = Note.chroma(bass);
    if (b !== undefined) v[b] = Math.max(v[b], 0.6);
  }
  return v;
}

/** The chart as a sequence of changes. A chord that repeats straight after
 *  itself is one step: nothing in the sound marks the second one. */
export function buildSteps(chords: { li: number; symbol: string }[]): Step[] {
  const steps: Step[] = [];
  for (const c of chords) {
    const tpl = chordChroma(c.symbol);
    if (!tpl) continue;
    const prev = steps[steps.length - 1];
    if (prev && prev.tpl.join() === tpl.join()) continue;
    steps.push({ li: c.li, symbol: c.symbol, tpl });
  }
  return steps;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < 12; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** How long the next chord has to be clearly ahead before the page moves on,
 *  and by how much. Long enough that a passing note does not turn the page. */
const HOLD_MS = 280;
const MARGIN = 0.05;
/** Quieter than this is silence, or talking: hold the place. */
const MIN_LEVEL = 0.008;

export class Follower {
  pos = 0;
  private steps: Step[];
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private timer = 0;
  private chroma = new Array(12).fill(0);
  private leader = -1;
  private since = 0;

  constructor(
    steps: Step[],
    private onStep: (pos: number) => void,
    private onLevel: (level: number, heard: string | null) => void
  ) {
    this.steps = steps;
  }

  /** New steps (the chart was transposed or redrawn), keeping the place. */
  setSteps(steps: Step[]): void {
    this.steps = steps;
    this.pos = Math.min(this.pos, Math.max(0, steps.length - 1));
  }

  jump(pos: number): void {
    this.pos = Math.max(0, Math.min(this.steps.length - 1, pos));
    this.leader = -1;
    this.onStep(this.pos);
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Raw: echo cancellation and noise suppression treat sustained
      // instruments as noise to be removed.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    // ~5.9 Hz per bin at 48 kHz: fine enough to tell neighbouring notes apart
    // down to about the G below middle C's octave.
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.6;
    src.connect(this.analyser);
    this.onStep(this.pos);
    this.timer = window.setInterval(() => this.tick(), 60);
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.stream = null;
  }

  private tick(): void {
    const a = this.analyser;
    const ctx = this.ctx;
    if (!a || !ctx || !this.steps.length) return;

    const time = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(time);
    let sq = 0;
    for (const x of time) sq += x * x;
    const level = Math.sqrt(sq / time.length);

    const spec = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(spec);
    const hz = ctx.sampleRate / a.fftSize;
    const now = new Array(12).fill(0);
    // C2 to C7: below that bins are too coarse, above it is mostly overtones.
    const lo = Math.ceil(65 / hz);
    const hi = Math.min(spec.length - 1, Math.floor(2100 / hz));
    for (let k = lo; k <= hi; k++) {
      const mag = Math.pow(10, spec[k] / 20);
      const midi = 69 + 12 * Math.log2((k * hz) / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      now[pc] += mag;
    }
    const max = Math.max(...now);
    if (max > 0) for (let i = 0; i < 12; i++) this.chroma[i] = 0.6 * this.chroma[i] + 0.4 * (now[i] / max);

    if (level < MIN_LEVEL) {
      this.leader = -1;
      this.onLevel(level, null);
      return;
    }

    // The current chord against the next two; the one after next allows for
    // a chord the band played too briefly to register.
    const i = this.pos;
    let best = i;
    let bestScore = cosine(this.chroma, this.steps[i].tpl);
    const here = bestScore;
    for (const j of [i + 1, i + 2]) {
      if (j >= this.steps.length) break;
      const s = cosine(this.chroma, this.steps[j].tpl) - (j === i + 2 ? 0.03 : 0);
      if (s > bestScore) {
        best = j;
        bestScore = s;
      }
    }
    this.onLevel(level, this.steps[best].symbol);
    if (best === i || bestScore - here < MARGIN) {
      this.leader = -1;
      return;
    }
    const t = performance.now();
    if (this.leader !== best) {
      this.leader = best;
      this.since = t;
      return;
    }
    if (t - this.since >= HOLD_MS) {
      this.pos = best;
      this.leader = -1;
      this.onStep(this.pos);
    }
  }
}
