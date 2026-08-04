/** One chord symbol placed above a lyric line at a character offset. */
export interface ChordHit {
  /** Chord symbol as published, e.g. "C", "G/B", "Am7". */
  symbol: string;
  /** Index into the lyric line the chord sits above; 0 = start of line. */
  at: number;
}

export interface ChartLine {
  /** Section label rendered above this line, e.g. "Verse 1". Only on the first line of a section. */
  section?: string;
  text: string;
  chords: ChordHit[];
}

/** One consulted source and what it said. */
export interface ChartSource {
  name: string;
  url?: string;
  /** Key that source gives the song in, if stated. */
  key?: string;
  /** 'agrees' with the consensus, 'differs', or 'partial'. */
  agreement: 'agrees' | 'differs' | 'partial';
  detail?: string;
}

/** A run of chords for songs/sections without lyric alignment. */
export interface ChartSection {
  label: string;
  repeats?: number;
  progression: { symbol: string; bars?: number }[];
}

export interface Chart {
  slug: string;
  title: string;
  artist: string;
  /** Key of the consensus chart, e.g. "G" or "Am". */
  key: string | null;
  confidence: 'high' | 'medium' | 'low';
  /** 'lyrics' = lead sheet over lyric lines; 'timeline' = section/bar structure only. */
  mode: 'lyrics' | 'timeline';
  /** One-paragraph summary of where the sources agreed and disagreed. */
  consensus: string | null;
  sources: ChartSource[];
  lines: ChartLine[];
  sections: ChartSection[];
  generatedAt: string;
}

export interface IndexEntry {
  slug: string;
  title: string;
  artist: string;
  key: string | null;
  confidence: Chart['confidence'];
  addedAt: string;
}

export interface SongIndex {
  songs: IndexEntry[];
}
