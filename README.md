# Chords

A fully static chord-chart library where every chart is built by **comparing multiple published sources** and keeping what they agree on — with the disagreements shown, not hidden.

**Live site:** https://mncoleman.github.io/chords/

## Features

- **Instant search** over the song library, entirely client-side — plus autosuggest for **any** song (iTunes Search API, one of the few music APIs that serves CORS). Picking a song that isn't in the library yet opens a pre-filled request that runs the lookup automatically.
- **Lead-sheet rendering** — chords positioned above lyric lines; a section/bar timeline for instrumentals.
- **Letters ↔ Nashville numbers** toggle (degree + accidental + the chord's own quality, e.g. `Am7` in G → `2m7`).
- **Transpose** up/down by semitone with sane enharmonic spelling. Slash chords are handled correctly: both halves of `G/B` are transposed independently (tonal's `Chord.transpose` drops the bass otherwise).
- **Print / save as PDF** — solid black on white, title/artist/key masthead, bold chords over lyrics, chord+lyric pairs kept together across page breaks. Use your browser's *Print → Save as PDF*.
- **Provenance** — every chart shows which sources were consulted, where they agreed or differed, and a confidence level.

## Architecture

A static page cannot search chord sites from the browser (no server, no CORS). So the search happens **offline**, and the site only ever reads its own committed data:

```
scripts/add-song.mjs ──(claude CLI + web search)──▶ public/data/charts/<slug>.json
                                                    public/data/index.json
                 git push ──▶ GitHub Actions ──▶ GitHub Pages (pure static)
```

- `public/data/index.json` — the searchable song index.
- `public/data/charts/<slug>.json` — one consensus chart per song (key, confidence, sources, consensus notes, chord-over-lyric lines).
- The app (Vite + vanilla TypeScript + [@tonaljs/tonal](https://github.com/tonaljs/tonal)) fetches those files relative to its own origin. No API keys in the client, no cross-origin calls, no backend.

## Adding a song

### From the site (requires a secret)

Search a song that isn't in the library and pick it — you land on a pre-filled GitHub issue. Submitting it triggers the `Chart request` workflow, which researches the chart, commits it, closes the issue, and the site redeploys. Like the manual workflow below, this needs the `ANTHROPIC_API_KEY` repository secret.

### Local script (default, no secrets needed)

Requires the [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) logged in on your machine:

```bash
npm install
npm run add-song -- "Wonderwall" "Oasis"
git add public/data && git commit -m "Add chart: Wonderwall" && git push
```

The script runs a headless Claude session with web search, compares several published chord sources, and writes the consensus chart JSON. Pushing to `main` redeploys the site automatically.

### GitHub Actions (requires a secret)

The **Add song** workflow (Actions tab → *Add song* → *Run workflow*) does the same lookup server-side and commits the result. It needs an `ANTHROPIC_API_KEY` repository secret (*Settings → Secrets and variables → Actions*) — a local subscription login does not transfer to CI. Until that secret is added, the workflow fails with a clear error; use the local script instead.

## Development

```bash
npm install
npm run dev       # local dev server
npm run build     # type-check + production build into dist/
npm run preview   # serve the production build locally
```

Deployment is automatic: every push to `main` builds and publishes via GitHub Actions (`.github/workflows/deploy.yml`).

## Chart data format

See `src/types.ts`. The essentials:

```jsonc
{
  "title": "…", "artist": "…", "key": "G", "confidence": "high",
  "mode": "lyrics",                    // or "timeline"
  "consensus": "UG and e-chords agree; Chordify hears Cadd9 for C…",
  "sources": [{ "name": "Ultimate Guitar", "url": "…", "agreement": "agrees" }],
  "lines": [{ "section": "Verse 1", "text": "…lyric…", "chords": [{ "symbol": "Em7", "at": 0 }] }],
  "sections": []                       // timeline mode: [{ label, repeats, progression: [{ symbol, bars }] }]
}
```

## Caveats

- Charts are AI-assisted consensus reconstructions of publicly published transcriptions — they can be wrong. The confidence badge and source list exist so you can judge for yourself.
- Lyric excerpts are included solely to position chords for personal practice use.

## License

[MIT](LICENSE)
