// Chordie, the fallback when Ultimate Guitar has nothing usable.
//
// Chordie aggregates charts from other sites and, unlike most chord sites,
// answers a plain server-side fetch. It is a safety net, not a peer of UG: its
// search is fuzzy (it returns songs that merely share a word), so every hit has
// to clear a title check before it is shown.
//
// A chart's id here is "c" plus the hex of its Chordie path, so the id alone is
// enough to fetch it again; nothing is stored.

const BASE = 'https://www.chordie.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const toHex = (s) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new TextDecoder().decode(new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16))));

export const isChordieId = (id) => /^c(?:[0-9a-f]{2}){4,400}$/.test(id);

const entities = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');

const strip = (s) => entities(s.replace(/<[^>]*>/g, ''));

/** Search. Returns {id, song, artist} rows, unranked. */
export async function chordieSearch(query) {
  const res = await fetch(`${BASE}/results.php?q=${encodeURIComponent(query)}&np=0&hp=1&sp=0`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const out = [];
  const seen = new Set();
  const re =
    /<a href="(\/chord\.pere\/[^"]+)"><span[^>]*>([^<]+)<\/span>\s*(?:&nbsp;)*\s*<span[^>]*>([^<]*)<\/span><\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1]) || m[1].length > 400) continue;
    seen.add(m[1]);
    out.push({ id: `c${toHex(m[1])}`, song: entities(m[2]).trim(), artist: entities(m[3]).trim() });
  }
  return out;
}

/** One chart, as UG-style text: a line of chords, then the lyric it sits above,
 *  alignment carried by spaces. */
export async function chordieChart(id) {
  const path = fromHex(id.slice(1));
  if (!path.startsWith('/chord.pere/')) return null;
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const bytes = await res.arrayBuffer();
  // Some of the sites it mirrors are Latin-1, and a © decoded as UTF-8 is a tofu.
  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    html = new TextDecoder('windows-1252').decode(bytes);
  }

  const title = entities((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '')
    .replace(/\s*Chords and Lyrics.*$/i, '')
    .trim();

  const lines = [];
  const re = /<div class="(chordline|textline)">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] === 'textline') {
      const t = strip(m[2]).trim();
      // "Chorus:" and "Verse 1" become the section marker the parser knows.
      const sec = t.match(/^(intro|verse|chorus|pre-?chorus|bridge|tag|outro|interlude|instrumental|ending|refrain)\b[^:]{0,20}:?$/i);
      lines.push(sec ? `[${t.replace(/:$/, '')}]` : t);
      continue;
    }
    // Walk the line: text advances the column; a chord is placed at the column
    // of the syllable that follows it.
    let chordLine = '';
    let lyric = '';
    const parts = m[2].split(/<span class="bracket">\[<\/span><span class="relc"><span class="absc [^"]*">([^<]*)<\/span><\/span><span class="bracket">\]<\/span>/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        lyric += i === 0 ? strip(parts[i]).replace(/^ /, '') : strip(parts[i]);
      } else {
        const sym = entities(parts[i]).trim();
        // Two chords over the same syllable would collide; keep them apart.
        if (chordLine.length > lyric.length) lyric = lyric.padEnd(chordLine.length, ' ');
        chordLine = chordLine.padEnd(lyric.length, ' ') + sym + ' ';
      }
    }
    lines.push(chordLine.trimEnd(), lyric.trimEnd());
  }
  const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!content) return null;
  return { title, content, url: `${BASE}${path}` };
}
