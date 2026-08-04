/** A track as Spotify describes it. Titles never live in the catalogue — the
 *  chord data is keyed by id alone — so this always comes from /api/search or
 *  /api/track. */
export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  year: string | null;
  art: string | null;
}

/** One labelled run of chords, e.g. "Verse 1". Chordonomicon encodes section
 *  boundaries inline, so structure survives into the chart. */
export interface Section {
  label: string;
  /** Chord symbols in order, already normalised out of the dataset's ASCII
   *  spelling ("Cs" -> "C#", "Amin" -> "Am"). */
  progression: string[];
}

/** A chart as stored in a shard, plus the key inferred at render time. */
export interface Chart {
  id: string;
  sections: Section[];
  genre: string | null;
  released: string | null;
  /** Inferred from the progression — the dataset does not state a key. */
  key: string | null;
}

export interface CatalogueManifest {
  built: string;
  songs: number;
  chartShards: number;
  keyedBy: string;
  attribution: string;
}
