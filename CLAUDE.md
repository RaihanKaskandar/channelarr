# Channelarr

Filters an Xtream Codes IPTV account into an M3U plus a matching XMLTV EPG for Jellyfin. Streams are 302-redirected to the provider, never proxied. See README.md for the feature overview.

## Layout
- `server/src`: Fastify app (`app.ts`) and SQLite through `node:sqlite` (`db.ts`; migrations are an append-only array).
  - `xtream/`: provider API client and stored source.
  - `sync/playlist.ts`: imports categories and streams.
  - `filter/channels.ts`: decides inclusion (manual toggle > exclude rule > include rule > category switch) and numbering.
  - `epg/`: download, streaming parse, matching and the per-channel fallback (`refresh.ts`).
  - `output/export.ts`: builds the M3U and XMLTV.
- `web/src`: React UI, one file per page in `pages/`.
- `server/test`: vitest. `e2e.test.ts` runs the whole pipeline against `mock-xtream.ts`.

## Rules
- The output channel id is `ch<stream_id>` in both the M3U `tvg-id` and the XMLTV `<channel id>`. Never change one without the other.
- Never log or return provider credentials or the output token. Use `redact()` for error text. `publicSource()` is what the UI sees.
- Programmes are stored only for guide channels in use. `SHORT_EPG_SOURCE_ID` (0) holds the per-channel API data.

## Commands
- `npm test`, `npm run build`, `npm run typecheck`, and `npm run dev`. The dev server needs `npm run dev -w server` on :9292.
