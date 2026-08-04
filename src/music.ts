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

/** Tonic of a key string that may carry a minor suffix ("Am" -> "A"). */
export function keyTonicOf(key: string | null): string | null {
  if (!key) return null;
  const m = key.match(ROOT_RE);
  return m ? m[1] : null;
}

/** Whether a key string names a minor key ("Am", "F#m", "Cmin"). */
export function keyIsMinor(key: string | null): boolean {
  if (!key) return false;
  const m = key.match(ROOT_RE);
  return !!m && /^m(?!aj)/.test(m[2]);
}
