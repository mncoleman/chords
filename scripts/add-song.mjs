#!/usr/bin/env node
// Add (or refresh) a song's consensus chord chart.
//
// Usage:  node scripts/add-song.mjs "Title" "Artist"
//         npm run add-song -- "Title" "Artist"
//
// Runs the Claude CLI in headless mode with web search, compares several
// published chord sources, and writes the consensus chart to
// public/data/charts/<slug>.json plus an entry in public/data/index.json.
//
// Locally this uses your logged-in `claude` CLI — no API key needed.
// In CI it works the same way with ANTHROPIC_API_KEY set in the environment.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'public', 'data');
const chartsDir = path.join(dataDir, 'charts');

const [title, artist] = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!title || !artist) {
  console.error('Usage: node scripts/add-song.mjs "Title" "Artist"');
  process.exit(2);
}

const slug = `${title} ${artist}`
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  if (fs.existsSync(local)) return local;
  return 'claude'; // PATH (CI installs @anthropic-ai/claude-code globally)
}

// USER and TMPDIR are load-bearing: without them `claude -p` fails with a
// misleading "Not logged in".
function claudeEnv() {
  return {
    ...process.env,
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || os.userInfo().username,
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
  };
}

const prompt = [
  `Find the chord chart for the song "${title}" by ${artist} by comparing MULTIPLE published sources.`,
  '',
  'Search the web for at least two reputable chord sources (Ultimate Guitar, Chordify,',
  'e-chords, official songbooks, the artist’s own site, etc). Build a CONSENSUS chart:',
  'keep what the sources agree on, and note where they disagree.',
  '',
  'Respond with ONLY a JSON object, no prose and no markdown fence, of exactly this shape:',
  '{',
  '  "key": "<key of the consensus chart, e.g. G or Am, or null>",',
  '  "confidence": "high" | "medium" | "low",',
  '  "consensus": "<2-3 sentences: which sources agreed, where they differed, any capo>",',
  '  "sources": [',
  '    { "name": "<site or book>", "url": "<page url or omit>", "key": "<key that source uses, or omit>",',
  '      "agreement": "agrees" | "differs" | "partial", "detail": "<short note, or omit>" }',
  '  ],',
  '  "mode": "lyrics" | "timeline",',
  '  "lines": [',
  '    { "section": "Verse 1", "text": "<lyric line>", "chords": [ { "symbol": "G/B", "at": <char offset> } ] }',
  '  ],',
  '  "sections": [',
  '    { "label": "Intro", "repeats": 2, "progression": [ { "symbol": "Cm", "bars": 1 } ] }',
  '  ]',
  '}',
  '',
  'Rules:',
  '- Prefer "lyrics" mode: lyric lines in song order with chords above them. Put "section"',
  '  only on the FIRST line of each section (Intro / Verse 1 / Chorus / Bridge / Outro).',
  '- IMPORTANT — precision expected: do NOT invent a progression. If no published chart',
  '  exists for this exact song, set confidence "low", say so in "consensus", and return',
  '  empty lines and sections.',
  '- But DO apply a progression you found even when no source gives syllable-level placement.',
  '  Almost no published chart marks exact syllables; line-level placement (walk the',
  '  progression across the lines, "at": 0 is fine) is the normal, useful chart.',
  '  Returning empty lines when you DID find a progression is the wrong answer — use',
  '  "consensus" to say placement is approximate and set confidence "medium".',
  '- For instrumentals or when lyrics are unavailable, use "timeline" mode and fill',
  '  "sections" instead, covering the whole piece in order.',
  '- If a chart is written with a capo, transpose to concert pitch and mention the capo.',
  '- Chord symbols use standard notation: C, G/B, Am7, F#m, Bbmaj7.',
].join('\n');

function extractJson(raw) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
  throw new Error('could not parse a JSON chord chart from the response');
}

console.log(`Looking up "${title}" by ${artist} (slug: ${slug})…`);
console.log('This runs a real multi-source web search and can take a few minutes.');

const args = ['-p', prompt, '--allowedTools', 'WebSearch,WebFetch', '--output-format', 'text'];
const child = spawn(claudeBin(), args, {
  env: claudeEnv(),
  cwd: os.tmpdir(),
  // Close stdin explicitly: left open, `claude -p` waits for piped input.
  stdio: ['ignore', 'pipe', 'inherit'],
});

let out = '';
child.stdout.on('data', (d) => {
  out += d.toString();
});

child.on('error', (e) => {
  console.error(`Failed to start claude CLI: ${e.message}`);
  console.error('Install it (npm i -g @anthropic-ai/claude-code) or set CLAUDE_BIN.');
  process.exit(1);
});

child.on('close', (code) => {
  if (code !== 0) {
    console.error(`claude exited ${code}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = extractJson(out);
  } catch (e) {
    console.error(e.message);
    console.error('--- raw output ---');
    console.error(out.slice(0, 2000));
    process.exit(1);
  }

  const lines = (parsed.lines || [])
    .filter((l) => typeof l?.text === 'string')
    .map((l) => ({
      ...(typeof l.section === 'string' && l.section ? { section: l.section } : {}),
      text: l.text,
      chords: (l.chords || [])
        .filter((c) => typeof c?.symbol === 'string')
        .map((c) => ({ symbol: String(c.symbol), at: Math.max(0, Number(c.at) || 0) })),
    }));

  const sections = (parsed.sections || [])
    .filter((s) => typeof s?.label === 'string' && Array.isArray(s?.progression))
    .map((s) => ({
      label: s.label,
      ...(Number(s.repeats) > 1 ? { repeats: Math.min(Number(s.repeats), 64) } : {}),
      progression: s.progression
        .filter((p) => typeof p?.symbol === 'string')
        .map((p) => ({ symbol: String(p.symbol), ...(Number(p.bars) > 1 ? { bars: Math.min(Number(p.bars), 32) } : {}) })),
    }));

  if (!lines.length && !sections.length) {
    console.error('The lookup returned an empty chart (no published progression found?). Nothing written.');
    console.error(`Note from the model: ${parsed.consensus || parsed.note || '(none)'}`);
    process.exit(1);
  }

  const chart = {
    slug,
    title,
    artist,
    key: typeof parsed.key === 'string' ? parsed.key : null,
    confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    mode: parsed.mode === 'timeline' || !lines.length ? 'timeline' : 'lyrics',
    consensus: typeof parsed.consensus === 'string' ? parsed.consensus : null,
    sources: (parsed.sources || [])
      .filter((s) => typeof s?.name === 'string')
      .map((s) => ({
        name: s.name,
        ...(typeof s.url === 'string' && /^https?:\/\//.test(s.url) ? { url: s.url } : {}),
        ...(typeof s.key === 'string' && s.key ? { key: s.key } : {}),
        agreement: ['agrees', 'differs', 'partial'].includes(s.agreement) ? s.agreement : 'partial',
        ...(typeof s.detail === 'string' && s.detail ? { detail: s.detail } : {}),
      })),
    lines,
    sections,
    generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(chartsDir, { recursive: true });
  const chartPath = path.join(chartsDir, `${slug}.json`);
  fs.writeFileSync(chartPath, JSON.stringify(chart, null, 2) + '\n', 'utf8');

  const indexPath = path.join(dataDir, 'index.json');
  let index = { songs: [] };
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {}
  index.songs = (index.songs || []).filter((s) => s.slug !== slug);
  index.songs.push({
    slug,
    title,
    artist,
    key: chart.key,
    confidence: chart.confidence,
    addedAt: chart.generatedAt,
  });
  index.songs.sort((a, b) => a.title.localeCompare(b.title));
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');

  console.log(`Wrote ${path.relative(root, chartPath)}`);
  console.log(`  key: ${chart.key}  confidence: ${chart.confidence}  mode: ${chart.mode}`);
  console.log(`  ${lines.length} lyric lines, ${sections.length} sections, ${chart.sources.length} sources`);
  console.log('Commit and push to deploy.');
});
