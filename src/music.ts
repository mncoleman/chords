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

/** How each semitone above the tonic is numbered when the spelling alone gives
 *  nonsense. */
const DEGREES = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7'];
/** Spellings a chart actually uses: the plain degrees plus the raised ones
 *  that come up in practice (#4 in a lydian line, #5 under an augmented). */
const WRITTEN_DEGREES = new Set([...DEGREES, '#1', '#2', '#4', '#5', '#6']);

/** Scale degree of a note against a tonic, with its accidental ("b7", "#4").
 *  Spelling usually decides, so a raised fourth stays #4. But a key spelled
 *  awkwardly (UG's "D#m" over a chart of D and C) makes intervals like a
 *  diminished octave, printed "b8", a "b4" or a double flat; no one numbers a
 *  chart that way, so those fall back to the plain degree for the semitone
 *  count. */
function degreeOf(keyTonic: string, note: string): string | null {
  const iv = Interval.get(Interval.distance(keyTonic, note));
  if (iv.empty) return null;
  const spelled = `${iv.alt < 0 ? 'b'.repeat(-iv.alt) : '#'.repeat(Math.max(0, iv.alt))}${iv.simple}`;
  if (WRITTEN_DEGREES.has(spelled)) return spelled;
  const k = Note.chroma(keyTonic);
  const n = Note.chroma(note);
  if (k === undefined || n === undefined) return null;
  return DEGREES[(n - k + 12) % 12];
}

/** Nashville numbers: scale degree of the chord root relative to the key,
 *  keeping the chord's own quality suffix ("Am7" in G becomes "2m7"). */
export function toNashville(symbol: string, keyTonic: string | null): string {
  if (!keyTonic) return symbol;
  const [chordPart, bassPart] = symbol.split('/');
  const m = chordPart.match(ROOT_RE);
  if (!m) return symbol;
  const [, root, suffix] = m;
  const deg = degreeOf(keyTonic, root);
  if (!deg) return symbol;
  const num = `${deg}${suffix}`;
  if (!bassPart) return num;
  const bm = bassPart.match(ROOT_RE);
  if (!bm) return num;
  const bdeg = degreeOf(keyTonic, bm[1]);
  return bdeg ? `${num}/${bdeg}` : num;
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

type Root = { pc: number; qual: string };

/** Chord roots and triad qualities, in order. The bass of a slash chord names an
 *  inversion, not a root. */
function rootsOf(symbols: string[]): Root[] {
  const roots: Root[] = [];
  for (const sym of symbols) {
    const m = sym.split('/')[0].match(ROOT_RE);
    if (!m) continue;
    const pc = Note.chroma(m[1]);
    if (pc === undefined) continue;
    roots.push({ pc, qual: qualityOf(m[2]) });
  }
  return roots;
}

/** How well a set of chords sits in one key: chords that are diatonic score,
 *  chords that are not cost, and a song that starts or ends on the key's own
 *  chord counts toward that key, since both overwhelmingly tend to be the
 *  tonic.
 *
 *  A major key and its relative minor share every chord, so the ending used to
 *  settle it, and worship songs love to end on the 6m: Way Maker in B was read
 *  as G#m, and a chart of 1 5 6m 4 came out b3 b7 1m b6. A minor key now has
 *  to show the chord that marks one, the major V (E in A minor); without it
 *  the relative major is the safer reading, since it numbers the same chords
 *  without a flat in sight. */
function keyScore(roots: Root[], tonic: number, minor: boolean): number {
  const scale = minor ? MINOR_SCALE : MAJOR_SCALE;
  const tally = new Map<number, number>();
  for (const r of roots) tally.set(r.pc, (tally.get(r.pc) || 0) + 1);
  const commonest = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const isTonic = (r: Root) => r.pc === tonic && (r.qual === (minor ? 'm' : 'M') || r.qual === '*');

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
  if (isTonic(roots[roots.length - 1])) score += 3;
  if (isTonic(roots[0])) score += 2;
  if (commonest === tonic) score += 1;
  if (minor && !roots.some((r) => r.pc === (tonic + 7) % 12 && r.qual === 'M')) score -= 4;
  return score;
}

/** One spelling per key, the way keys are usually named. */
const TONICS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_TONICS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

/** Guess the key from the chords themselves.
 *
 *  Ultimate Guitar often ships a chart with no tonality set, which used to
 *  leave Nashville numbers greyed out — the numbers need a tonic to count from.
 *  Scoring the chords against all 24 keys recovers one. Keys are spelled the
 *  way they are named (G#m, not Abm): a tonic spelled against the chart's
 *  sharps numbered every chord with a sharp. */
export function inferKey(symbols: string[]): string | null {
  const roots = rootsOf(symbols);
  if (roots.length < 2) return null;

  let best: { name: string; score: number } | null = null;

  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const score = keyScore(roots, tonic, minor);
      if (!best || score > best.score) {
        best = { name: minor ? `${MINOR_TONICS[tonic]}m` : TONICS[tonic], score };
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

/** The tonic Nashville numbers count from, in the frame the chart is written
 *  in (before any transposition the reader applies).
 *
 *  A capo chart names one key and prints another: UG ships "Key of B · Capo 4"
 *  over shapes of G, Em, D, C. Numbers taken against the sounding key turned an
 *  ordinary 1 6m 5 4 into b6 4m b3 b2, so the capo normally comes off the key.
 *
 *  But UG is not consistent about which key it names. Plenty of capo charts
 *  list the key of the shapes, and taking the capo off that as well threw the
 *  numbers a second time: Goodness of God, "Key of G · Capo 1" over shapes of
 *  G, counted from F# and printed every chord flat (b2 b5 b6/1 b7m). So both
 *  readings are scored against the chords and the better one wins, the
 *  capo-off reading on a tie.
 *
 *  Some charts name a key that fits neither: Reckless Love filed in D#m over
 *  Em, D, C and G, which numbered the whole song b2m b8 bb7 b4. The sign is
 *  that the named key's own tonic chord, major or minor to match, never turns
 *  up, and only then does the best-fitting tonic in the same mode take
 *  over. Scoring every tonic regardless overrode keys that were right: songs
 *  that lean on their IV or a borrowed bVII (Sweet Home Alabama, Way Maker)
 *  fit a neighbouring key slightly better on paper, but a borrowed chord is
 *  still numbered b7, not 4. */
export function writtenTonic(key: string | null, capo: number, symbols: string[]): string | null {
  const tonic = keyTonicOf(key);
  if (!tonic) return null;
  const minor = keyIsMinor(key);
  const candidates = [
    ...(capo ? [transposeSymbol(tonic, intervalForSemitones(-capo)).split('/')[0]] : []),
    tonic,
  ];
  const roots = rootsOf(symbols);
  if (roots.length < 2) return candidates[0];

  let best = { name: candidates[0], score: -Infinity };
  const consider = (name: string) => {
    const pc = Note.chroma(name);
    if (pc === undefined) return;
    const score = keyScore(roots, pc, minor);
    if (score > best.score) best = { name, score };
  };
  candidates.forEach(consider);
  const bestPc = Note.chroma(best.name);
  const tonicChord = minor ? 'm' : 'M';
  const heard = roots.some((r) => r.pc === bestPc && (r.qual === tonicChord || r.qual === '*'));
  if (!heard) for (const name of minor ? MINOR_TONICS : TONICS) consider(name);
  return spelledAsWritten(best.name, symbols);
}

/** The tonic spelled the way the chart spells that note. UG's "Abm" over a
 *  chart written in G#m numbered E, B and F# as #5 #2 #6 where anyone would
 *  write b6 b3 b7. */
function spelledAsWritten(tonic: string, symbols: string[]): string {
  const pc = Note.chroma(tonic);
  const seen = new Map<string, number>();
  for (const sym of symbols) {
    for (const part of sym.split('/')) {
      const m = part.match(ROOT_RE);
      if (m && Note.chroma(m[1]) === pc) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    }
  }
  if (!seen.size || seen.has(tonic)) return tonic;
  return [...seen.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Whether a key string names a minor key ("Am", "F#m", "Cmin"). */
export function keyIsMinor(key: string | null): boolean {
  if (!key) return false;
  const m = key.match(ROOT_RE);
  return !!m && /^m(?!aj)/.test(m[2]);
}
