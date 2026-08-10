import { Chord, Interval, Note } from '@tonaljs/tonal';

export const ROOT_RE = /^([A-G][#b]*)(.*)$/;

/** Interval name for a semitone shift; direction carried by the sign.
 *  These spellings keep common keys sane (+1 from G is Ab, not G#♯-ish chaos). */
const NAMES = ['1P', '2m', '2M', '3m', '3M', '4P', '5d', '5P', '6m', '6M', '7m', '7M'];

export function intervalForSemitones(semitones: number): string {
  if (!semitones) return '1P';
  const abs = ((Math.abs(semitones) % 12) + 12) % 12;
  const name = NAMES[abs];
  return semitones < 0 && abs !== 0 ? `-${name}` : name;
}

/** Names nobody writes. Cb IS B and Fb IS E, but only ever appear as artefacts
 *  of transposition here — Bb up a semitone printed "Cb" across a whole chart. */
const ODD_SPELLINGS = new Set(['Cb', 'Fb', 'B#', 'E#']);

/** Collapse double accidentals a transposition can produce (Db +6st = Abb -> G),
 *  and the single-accidental spellings that are technically valid but wrong to
 *  read. */
function tidyRoot(note: string): string {
  const m = note.match(ROOT_RE);
  if (!m) return note;
  const [, root, rest] = m;
  if (root.length <= 2 && !ODD_SPELLINGS.has(root)) return note;
  const simple = Note.simplify(root);
  return simple ? simple + rest : note;
}

/** tonal's Chord.transpose DROPS the bass of a slash chord ("G/B" + M2 gives
 *  "A/B"), so the two halves must be transposed separately. */
export function transposeSymbol(symbol: string, interval: string): string {
  if (!interval || interval === '1P') return symbol;
  const [chordPart, bassPart] = symbol.split('/');
  const chord = tidyRoot(Chord.transpose(chordPart, interval) || chordPart);
  if (!bassPart) return chord;
  const bass = tidyRoot(Note.transpose(bassPart, interval) || bassPart);
  return `${chord}/${bass}`;
}

/** Nashville numbers: scale degree of the chord root relative to the key,
 *  keeping the chord's own quality suffix ("Am7" in G becomes "2m7"). */
export function toNashville(symbol: string, keyTonic: string | null): string {
  if (!keyTonic) return symbol;
  const [chordPart, bassPart] = symbol.split('/');
  const m = chordPart.match(ROOT_RE);
  if (!m) return symbol;
  const [, root, suffix] = m;
  const iv = Interval.get(Interval.distance(keyTonic, root));
  if (iv.empty) return symbol;
  const acc = iv.alt < 0 ? 'b'.repeat(-iv.alt) : iv.alt > 0 ? '#'.repeat(iv.alt) : '';
  const num = `${acc}${iv.simple}${suffix}`;
  if (!bassPart) return num;
  const bm = bassPart.match(ROOT_RE);
  if (!bm) return num;
  const biv = Interval.get(Interval.distance(keyTonic, bm[1]));
  if (biv.empty) return num;
  const bacc = biv.alt < 0 ? 'b'.repeat(-biv.alt) : biv.alt > 0 ? '#'.repeat(biv.alt) : '';
  return `${num}/${bacc}${biv.simple}`;
}

/** Diatonic triads of a scale: semitone offsets from the tonic and the quality
 *  normally built on each. 'd' is diminished. */
const MAJOR_SCALE = { steps: [0, 2, 4, 5, 7, 9, 11], quals: ['M', 'm', 'm', 'M', 'M', 'm', 'd'] };
const MINOR_SCALE = { steps: [0, 2, 3, 5, 7, 8, 10], quals: ['m', 'd', 'M', 'm', 'm', 'M', 'M'] };

/** What a chord suffix says about the triad underneath it. Suspensions name no
 *  third at all, so they are a wildcard rather than evidence either way. */
function qualityOf(suffix: string): 'M' | 'm' | 'd' | '*' {
  if (/^(?:m|min)(?!aj)/.test(suffix)) return 'm';
  if (/^(?:dim|°|o\b)/.test(suffix)) return 'd';
  if (/^sus/.test(suffix)) return '*';
  return 'M';
}

/** Guess the key from the chords themselves.
 *
 *  Ultimate Guitar often ships a chart with no tonality set, which used to
 *  leave Nashville numbers greyed out — the numbers need a tonic to count from.
 *  Scoring the chords against all 24 keys recovers one: chords that are
 *  diatonic score, chords that are not cost, and the chords a song starts and
 *  ends on break the ties, since both overwhelmingly tend to be the tonic. */
export function inferKey(symbols: string[]): string | null {
  const roots: { pc: number; qual: string }[] = [];
  for (const sym of symbols) {
    // The bass of a slash chord names an inversion, not a root.
    const m = sym.split('/')[0].match(ROOT_RE);
    if (!m) continue;
    const pc = Note.chroma(m[1]);
    if (pc === undefined) continue;
    roots.push({ pc, qual: qualityOf(m[2]) });
  }
  if (roots.length < 2) return null;

  const tally = new Map<number, number>();
  for (const r of roots) tally.set(r.pc, (tally.get(r.pc) || 0) + 1);
  const commonest = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const first = roots[0].pc;
  const last = roots[roots.length - 1].pc;

  let best: { name: string; score: number } | null = null;

  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [scale, minor] of [
      [MAJOR_SCALE, false],
      [MINOR_SCALE, true],
    ] as const) {
      let score = 0;
      for (const r of roots) {
        const deg = scale.steps.indexOf(((r.pc - tonic) % 12 + 12) % 12);
        if (deg < 0) {
          score -= 1; // out of key
          continue;
        }
        const want = scale.quals[deg];
        // A minor key almost always borrows the major V (harmonic minor).
        const ok = r.qual === '*' || r.qual === want || (minor && deg === 4 && r.qual === 'M');
        score += ok ? 2 : 0.5;
      }
      if (last === tonic) score += 3;
      if (first === tonic) score += 2;
      if (commonest === tonic) score += 1;

      if (!best || score > best.score) {
        const name = Note.pitchClass(Note.fromMidi(60 + tonic)) || '';
        best = { name: minor ? `${name}m` : name, score };
      }
    }
  }

  return best ? best.name : null;
}

/** Tonic of a key string that may carry a minor suffix ("Am" -> "A"). */
export function keyTonicOf(key: string | null): string | null {
  if (!key) return null;
  const m = key.match(ROOT_RE);
  return m ? m[1] : null;
}

/** The tonic Nashville numbers count from.
 *
 *  A capo chart names one key and prints another: UG ships "Key of B · Capo 4"
 *  over shapes of G, Em, D, C. Numbers taken against the sounding key turned an
 *  ordinary 1 6m 5 4 into b6 4m b3 b2, so the capo comes off the key first and
 *  the numbers are read in the frame the chart is written in. Any transposition
 *  the reader has applied moves with it. */
export function writtenTonic(key: string | null, capo: number, semitones: number): string | null {
  const tonic = keyTonicOf(key);
  if (!tonic) return null;
  return transposeSymbol(tonic, intervalForSemitones(semitones - capo)).split('/')[0];
}

/** Whether a key string names a minor key ("Am", "F#m", "Cmin"). */
export function keyIsMinor(key: string | null): boolean {
  if (!key) return false;
  const m = key.match(ROOT_RE);
  return !!m && /^m(?!aj)/.test(m[2]);
}
