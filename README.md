# chords

Search a song, get its chord chart, transpose it, read it in Nashville numbers, print it.

A private tool: the whole site sits behind Telegram sign-in.

## How it works

Two things happen server-side, both as Cloudflare Pages Functions, because
neither can happen in a browser:

- **`/api/search`** — Spotify autosuggest, so a half-typed or misspelled title
  still finds the song. Spotify's client-credentials flow needs a secret, and a
  secret cannot live in a bundle the browser downloads.
- **`/api/ug`** — chord sheets from Ultimate Guitar's mobile API. It sends no
  CORS headers and every request must be signed, so it is proxied.

Everything after that is local to the page: parsing the sheet, transposing,
converting to Nashville numbers, and printing.

## Chord handling

Chord sheets are plain text with alignment carried by spaces. Rendering that
verbatim is easy but dead — you cannot transpose it. So each chord line is
parsed back into `(symbol, column)` pairs and re-laid out on render, which
matters because transposition changes width: `C` becomes `C#m7`, and treating
the line as a string would shear everything after it.

Two details worth keeping:

- `tonal`'s `Chord.transpose` **drops the bass of a slash chord** — `G/B` up a
  tone gives `A/B`. The halves are transposed separately.
- Double accidentals from transposition are simplified, so `Db` up six
  semitones prints `G`, not `Abb`.

## Auth

Telegram OAuth (OIDC + PKCE) against the same bot mncoleman.com uses. The
`id_token` is verified against Telegram's JWKS — signature, audience and expiry
— and only the owner's Telegram `sub` is accepted. The session is an HS256 JWT
in an HttpOnly cookie.

## Develop

```bash
npm install
npm run dev
npm run build
```

Secrets, set in the Pages project (never committed):
`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `TELEGRAM_BOT_ID`,
`TELEGRAM_CLIENT_SECRET`, `JWT_SECRET`, `OWNER_SUB`.

## Note

Chord sheets are fetched from Ultimate Guitar's undocumented mobile API and are
their content, not ours. That is why this is access-controlled rather than
public. Charts are one person's interpretation of a recording; sources disagree.

## Licence

MIT — see [LICENSE](LICENSE).
