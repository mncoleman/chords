#!/usr/bin/env node
// Build the static chord catalogue, keyed by Spotify track id.
//
// Chordonomicon anonymises its metadata — no title, no artist, just a
// spotify_song_id. Rather than translating 430k ids into names ahead of time,
// the browser gets the id from Spotify's own autosuggest and looks it up
// directly. The id is also a better key than a title: it disambiguates covers,
// remasters and live versions that share a name.
//
// Output (nothing here is generated at request time):
//   data/ch/<n>.json    chart shard, keyed by spotify id
//   data/catalogue.json manifest: song count, shard count, attribution
//
// Cloudflare Pages refuses a deployment of more than 20,000 files, so one file
// per song is impossible; charts are sharded by a hash of the id instead.
//
// Usage: node scripts/build-catalogue.mjs <chordonomicon.csv> [outDir]

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [csvPath, outDirArg] = process.argv.slice(2);
if (!csvPath) {
  console.error('Usage: build-catalogue.mjs <chordonomicon.csv> [outDir]');
  process.exit(2);
}
const outDir = outDirArg || path.join(process.cwd(), 'public', 'data');
const chDir = path.join(outDir, 'ch');

export const CHART_SHARDS = 2048;

/** FNV-1a. Must stay byte-for-byte identical to the copy in the browser, or
 *  every lookup misses. */
export function shardOf(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % CHART_SHARDS;
}

/** Chordonomicon encodes structure inline: "<verse_1> C F <chorus_1> G Amin". */
export function parseChords(raw) {
  const sections = [];
  let current = null;
  for (const tok of (raw || '').split(/\s+/)) {
    if (!tok) continue;
    const m = tok.match(/^<([a-z]+)_(\d+)>$/i);
    if (m) {
      current = { label: m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2], progression: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { label: 'Intro', progression: [] };
      sections.push(current);
    }
    current.progression.push(tidySymbol(tok));
  }
  return sections.filter((s) => s.progression.length);
}

/** The dataset ASCII-fies accidentals: "Cs" is C#, "Amin" is Am, "Fsmaj7" is F#maj7. */
export function tidySymbol(tok) {
  let s = tok;
  // 's' after the root letter means sharp — but NOT when it opens "sus", or
  // every Asus4 in the dataset silently becomes A#us4.
  s = s.replace(/^([A-G])s(?!us)/, '$1#');
  s = s.replace(/\/([A-G])s(?!us)/, '/$1#');
  s = s.replace(/min(?![a-z])/g, 'm');
  s = s.replace(/^([A-G][#b]?)maj(?![0-9])/, '$1');
  return s;
}

/** Minimal RFC4180 splitter — the chords column is quoted and full of commas. */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

async function main() {
  const charts = new Map();
  let rows = 0;
  let kept = 0;
  let dupes = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity });
  let header = null;
  let buf = '';

  for await (const line of rl) {
    if (!header) {
      header = line.split(',').map((h) => h.trim());
      continue;
    }
    buf = buf ? buf + '\n' + line : line;
    let q = 0;
    for (const c of buf) if (c === '"') q++;
    if (q % 2 !== 0) continue; // record spans lines; keep accumulating

    const cols = splitCsv(buf);
    buf = '';
    rows++;
    const row = Object.fromEntries(header.map((h, i) => [h, cols[i] ?? '']));

    const id = (row.spotify_song_id || '').trim();
    if (!id) continue;

    const sections = parseChords(row.chords);
    if (!sections.length) continue;

    const sh = shardOf(id);
    if (!charts.has(sh)) charts.set(sh, {});
    const bucket = charts.get(sh);
    if (bucket[id]) {
      // The dataset holds several tabs for some tracks. Keep the richest one
      // rather than whichever happened to come last.
      dupes++;
      const existing = bucket[id].sections.reduce((n, s) => n + s.progression.length, 0);
      const incoming = sections.reduce((n, s) => n + s.progression.length, 0);
      if (incoming <= existing) continue;
    } else {
      kept++;
    }

    bucket[id] = {
      id,
      sections,
      genre: (row.main_genre || '').trim() || null,
      released: (row.release_date || '').slice(0, 4) || null,
    };
  }

  fs.rmSync(chDir, { recursive: true, force: true });
  fs.mkdirSync(chDir, { recursive: true });
  for (const [sh, obj] of charts) {
    fs.writeFileSync(path.join(chDir, `${sh}.json`), JSON.stringify(obj));
  }

  fs.writeFileSync(
    path.join(outDir, 'catalogue.json'),
    JSON.stringify(
      {
        built: new Date().toISOString(),
        songs: kept,
        chartShards: CHART_SHARDS,
        keyedBy: 'spotify_track_id',
        attribution:
          'Chord progressions from the Chordonomicon dataset (CC BY-NC 4.0), ' +
          'Artificial Intelligence and Learning Systems Laboratory, NTUA. ' +
          'Search and track metadata from Spotify. Lyrics from LRCLIB.',
      },
      null,
      2
    )
  );

  console.log(`[rows]  ${rows} scanned`);
  console.log(`[built] ${kept} songs across ${charts.size} shards (${dupes} duplicate ids merged)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
