// Parse Ultimate Guitar chord sheets into something transposable.
//
// UG ships a plain text block: a line of chords, then the lyric line it sits
// above, with alignment carried purely by spaces. Rendering that verbatim is
// easy but dead — you cannot transpose it or switch it to Nashville numbers.
//
// So each chord line is parsed back into (symbol, column) pairs. Re-rendering
// then repositions symbols by column, which matters because transposition
// changes width: C becomes C#m7 and everything after it would drift if the line
// were treated as a string.

export interface ChordAt {
  symbol: string;
  at: number;
}

export interface SheetLine {
  /** Section heading, e.g. "Chorus", when this line opens one. */
  section?: string;
  chords: ChordAt[];
  lyric: string;
}

/** Chord symbols, including slash chords, extensions and the odd N.C.
 *  Deliberately strict: a loose pattern classifies lyric lines as chords and
 *  the whole sheet falls apart. */
const CHORD_RE =
  /^(N\.?C\.?|[A-G][#b]?(?:maj|min|m|dim|aug|sus|add|M)?[0-9]*(?:[#b]?[0-9]+)*(?:sus[24])?(?:add[0-9]+)?(?:\/[A-G][#b]?)?)$/;

export function isChordToken(tok: string): boolean {
  return CHORD_RE.test(tok);
}

/** A chord line is one whose visible tokens are all chords. Lyrics occasionally
 *  contain a bare "A" or "I", so require at least one token with an accidental,
 *  a quality or a slash — something no ordinary word has. */
export function isChordLine(line: string): boolean {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  if (!toks.every(isChordToken)) return false;
  return toks.some((t) => /[#b/0-9]|maj|min|dim|aug|sus|m$/.test(t)) || toks.length >= 3;
}

/** Column positions of each chord in a chord line. */
export function parseChordLine(line: string): ChordAt[] {
  const out: ChordAt[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (isChordToken(m[0])) out.push({ symbol: m[0], at: m.index });
  }
  return out;
}

const SECTION_RE = /^\s*\[([^\]]{1,40})\]\s*$/;

export function parseSheet(content: string): SheetLine[] {
  const raw = content.replace(/\r\n/g, '\n').split('\n');
  const lines: SheetLine[] = [];
  let pending: string | undefined;

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];

    const sec = line.match(SECTION_RE);
    if (sec) {
      pending = sec[1].trim();
      continue;
    }

    if (isChordLine(line)) {
      const chords = parseChordLine(line);
      const next = raw[i + 1];
      // A chord line is usually followed by its lyric. When the next line is
      // another chord line (an instrumental run), emit this one on its own.
      if (next !== undefined && next.trim() && !isChordLine(next) && !SECTION_RE.test(next)) {
        lines.push({ section: pending, chords, lyric: next });
        pending = undefined;
        i++;
      } else {
        lines.push({ section: pending, chords, lyric: '' });
        pending = undefined;
      }
      continue;
    }

    if (line.trim()) {
      lines.push({ section: pending, chords: [], lyric: line });
      pending = undefined;
    } else if (lines.length && lines[lines.length - 1].lyric !== '') {
      // Preserve blank lines as separators, but never lead with one.
      lines.push({ chords: [], lyric: '' });
    }
  }

  return lines;
}

/** Re-lay a chord line after the symbols have changed width.
 *  Positions are honoured where possible; when a longer symbol would overrun
 *  its neighbour, the neighbour is pushed right rather than overwritten. */
export function layoutChords(chords: ChordAt[], render: (s: string) => string): string {
  let row = '';
  for (const c of [...chords].sort((a, b) => a.at - b.at)) {
    const label = render(c.symbol);
    if (c.at < row.length) row += ' ';
    else row = row.padEnd(c.at, ' ');
    row += label;
  }
  return row;
}
