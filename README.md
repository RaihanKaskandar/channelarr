<div align="center">

<img src="web/public/favicon.svg" width="96" alt="Channelarr icon" />

# Channelarr

</div>

Channelarr turns an **Xtream Codes** IPTV account into exactly the channels you want, with a
**guide that matches**, ready for **Jellyfin Live TV**:

- `playlist.m3u`: your selected channels with names, numbers, groups and logos.
- `epg.xml`: an XMLTV guide that uses the same channel ids, so Jellyfin maps every channel by itself.

Streams are **not proxied**. Each stream link answers with a `302` redirect to the provider, so
Jellyfin pulls the original stream directly and does the playing and transcoding itself.
Your provider password stays inside Channelarr and never ends up in Jellyfin's config.

Channelarr doesn't come with any channels: you need your own IPTV subscription with an Xtream Codes login.

> [!WARNING]
> **This project is entirely vibe coded.**
> I built Channelarr for myself, to get my own IPTV channels and guide into Jellyfin, and it was written with an AI
> assistant rather than carefully coded by hand. I decided to put it online in case it is useful to someone else too.
>
> That means: no promise it won't break or that it will stay secure. Feel free to use it, but do so at your own risk.
> Back up your data, and expect rough edges. Issues and pull requests are welcome, but I can't promise a fast reply.

## How the guide is built

For every included channel, Channelarr tries these in order:

1. **Manual pick:** a guide channel you chose on the EPG page.
2. **tvg-id:** the provider's `epg_channel_id`, looked up as a channel id in the guides.
3. **Name:** the channel name without country prefixes and quality tags (`UK: BBC One FHD` → `bbcone`),
   matched against the guides' display names.
4. **Per-channel EPG:** the provider API (`get_simple_data_table`, base64 decoded) for channels no guide covers.
5. **Placeholder:** repeating blocks titled with the channel name, so the channel still shows up in the guide and can be played.

Guides come from the provider's `xmltv.php` and from any extra XMLTV URLs you add
(for example epgshare01 or iptv-org). They are parsed as a stream, so large (gzipped) files are fine.
Only programmes for channels in use are stored.

## Run

```sh
git clone https://github.com/RaihanKaskandar/channelarr.git
cd channelarr
docker compose up -d --build
```

Open `http://<host>:9292`, choose an admin password, and add your Xtream login on **IPTV source**.
Then switch on whole categories or single channels on **Channels**.

| Variable     | Default | Meaning                                                          |
|--------------|---------|------------------------------------------------------------------|
| `PORT`       | `9292`  | HTTP port                                                        |
| `DATA_DIR`   | `/data` | SQLite database and cached guides                                |
| `PUBLIC_URL` | –       | Base URL written into the links (otherwise taken from the request) |

Everything is stored in the `channelarr-data` Docker volume, so it survives updates and restarts. To update, pull the
latest code and run `docker compose up -d --build` again. To back up, copy the data out of the container:

```sh
docker compose cp channelarr:/data ./channelarr-backup
```

On Unraid, `unraid/my-channelarr.xml` is a template you can copy to `/boot/config/plugins/dockerMan/templates-user/`.
Build the image on the server first (`docker build -t channelarr:latest .`).

## Add to Jellyfin

1. **Dashboard → Live TV → Tuner devices → + → M3U Tuner:** paste the playlist link from the Overview page.
   Set **Simultaneous stream limit** to your provider's max connections.
2. **TV guide data providers → + → XMLTV:** paste the guide link and enable it for that tuner.
3. Run **Refresh Guide** under Scheduled Tasks.

## Develop

```sh
npm install
npm run dev     # server on :9292 (data in ./data), UI on Vite's dev server with a proxy
npm test        # unit tests + end-to-end test against a mock Xtream panel
npm run build
```

- **Server:** Fastify, Node 24's built-in `node:sqlite`, and a streaming XMLTV parser (saxes).
- **UI:** React, TanStack Query and Tailwind.

## Author

Created by **Raihan Kaskandar** ([@RaihanKaskandar](https://github.com/RaihanKaskandar)), who engineered the requirements,
designed the full-stack architecture and the user interface, and directed the AI. The code itself was written by Claude,
an AI coding assistant.

## Credits and license

The approach follows [Dispatcharr](https://github.com/Dispatcharr/Dispatcharr), a great IPTV manager that showed how to
do this well ❤️. No code is copied from it. Channelarr is licensed under the [MIT license](LICENSE).
