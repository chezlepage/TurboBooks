# TurboBooks

A self-hosted audiobook player, ebook reader and comic reader, built for reading in bed. Each person gets their own account, shelf and progress, synced across phone, tablet and computer. Free public-domain books are one tap away.

It runs in Docker on a home server and installs on phones as an app (PWA).

## Quick start

You need a machine with [Docker](https://docs.docker.com/get-docker/) (Linux server, NAS, or a desktop).

```sh
git clone https://github.com/chezlepage/TurboBooks.git
cd TurboBooks
cp .env.example .env
```

Edit `.env` and set at least:

```sh
ADMIN_USERNAME=you
ADMIN_PASSWORD=something-long
```

Then pick how people will reach it.

**Try it on your home network.** Open `docker-compose.yml`, uncomment the `ports:` lines under `turbobooks`, and set `COOKIE_SECURE=false` in `.env`. Then:

```sh
docker compose up -d --build turbobooks
```

Open `http://<server-ip>:8080` and sign in with the admin account.

**Reach it from anywhere (recommended).** Use a Cloudflare Tunnel, so no router ports are opened. Put the tunnel token in `CLOUDFLARE_TUNNEL_TOKEN` and run `docker compose up -d --build`. [docs/DEPLOY.md](docs/DEPLOY.md) walks through it step by step, including Cloudflare Access, backups and updates.

After the first start, add other people under **Settings → Users** (there is no public sign-up). You can then remove `ADMIN_PASSWORD` from `.env`.

To install it on a phone: Safari → Share → **Add to Home Screen** (iPhone), or Chrome → ⋮ → **Install app** (Android).

## Features

### Listening
- **Audiobooks** from your own files: MP3, M4B, M4A, OGG or FLAC. M4B chapters are detected.
- **Sleep timer** for 5–90 min or to the end of the chapter. The volume fades out over the last 45 s on desktop and Android.
- **"Dozed off?"** After the timer stops, the player offers to jump back to where you set it. It also rewinds a little after the timer or a long pause.
- **Night screen**: a pitch-black overlay with one dim button.
- Lock-screen and headphone controls, 0.8–2× speed, and a chapter list.

### Reading
- **EPUB reader** with dark, black and sepia themes, adjustable font and size (OpenDyslexic included), and a table of contents.
- **Comics, manga and webtoons** (CBZ, CBR, and manga sold as EPUB). Manga reads right to left and webtoons as one long strip. Tablets and computers show two-page spreads.
- **Read along**: the ebook text scrolls with the narration and highlights the current sentence. Needs the optional Whisper container.
- **Send to Kindle / PocketBook**: one tap emails an ebook to a reader ([docs/KINDLE.md](docs/KINDLE.md)).

### Finding books
- **Discover**: free public-domain books in one tap, with a shelf for each kind of book.
  - Audiobooks come from LibriVox.
  - Ebooks come from Project Gutenberg.
  - Comics come from public-domain collections.
- **Requests** (optional): search for books and request them through a Shelfarr instance you run. Delivered books land on the shelf of the person who asked.
- **Make an audiobook** (optional): turn an ebook into an audiobook. Claude prepares the text and Kokoro TTS reads it.
  - You get 19 blended voices and 11 accents.
  - Characters can have their own voices, and texts are read by the person who sent them.
  - Each profile can set preferred, avoided and custom-mixed voices.
  - A monthly spend cap applies.

### People
- Each person has their own library and progress, synced across devices. Files are stored only once.
- Profiles show ratings, want-to-read lists, a yearly reading goal and a **Year in books** recap.
- **Goodreads import**: bring in your shelves and ratings. Free copies of want-to-read books are found automatically.
- Profiles and shelves are private by default, and individual books can be hidden.
- Sign-in uses argon2 password hashing, httpOnly cookies and a rate limit on attempts.

## Optional features

Each one stays off until you fill in its settings in `.env`. `.env.example` lists them all.

| Feature | Settings | Needs |
| --- | --- | --- |
| Requests | `SHELFARR_URL`, `SHELFARR_TOKEN` | A Shelfarr instance with an API token |
| Send to Kindle / PocketBook | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | An email account to send from, e.g. a Gmail app password ([guide](docs/KINDLE.md)) |
| Make an audiobook | `ANTHROPIC_API_KEY`, `KOKORO_URL` | A Claude API key and an NVIDIA GPU for Kokoro |
| Read along | `WHISPER_URL` | An NVIDIA GPU for Whisper |

The Kokoro and Whisper containers are defined in `docker-compose.shared-tunnel.yml`. That file is for a host that already runs `cloudflared` in another compose project ([docs/DEPLOY.md](docs/DEPLOY.md#already-have-a-docker-host-with-cloudflared-eg-the-plex-vm)). If you use the plain `docker-compose.yml`, copy those two services into it. GPU containers need the NVIDIA Container Toolkit on the host.

## Adding your own files

Drop files into the library folder (`./library`, or `LIBRARY_PATH` in `.env`). New files are picked up automatically, or use **Settings → Rescan library**.

```
library/
  Some Author - Some Book/       <- a folder of audio files = one audiobook
    01 Chapter One.mp3
    02 Chapter Two.mp3
    cover.jpg
  Standalone Book.m4b            <- a single audio file = one audiobook
  Any Book.epub                  <- every .epub = one ebook
  Some Comic #1.cbz              <- every .cbz / .cbr = one comic
```

Files are sorted naturally (`2` before `10`). An optional `metadata.json` in a book folder overrides the tags: `{ "title", "author", "narrator", "description", "trackTitles": [] }`. Folders starting with `.` are ignored.

## Development

You need Node 22+ and ffmpeg/ffprobe on your PATH.

```sh
npm install
cp .env.example .env     # set ADMIN_USERNAME / ADMIN_PASSWORD, and COOKIE_SECURE=false
npm run dev              # server on :8080, web on :5173 (proxies /api)
```

Open http://localhost:5173. Other scripts: `npm run typecheck`, `npm run build`, `npm run create-user -- <name> [--admin]`.

| Part | Tech |
| --- | --- |
| Server | Node 22, Fastify 5, TypeScript, SQLite (better-sqlite3), ffmpeg |
| Web | React 18, Vite, React Router |
| Deploy | Docker Compose with a Cloudflare Tunnel (Cloudflare Access recommended) |

```
server/src/
  index.ts, config.ts, db.ts   app setup, env config, schema + migrations
  lib/                         scanner, streaming, EPUB/comic parsing, Discover sources,
                               Shelfarr, Goodreads, convert/ (ebook → audiobook), readalong/
  routes/                      one file per API area
  cli/create-user.ts           create a user or reset a password
web/src/
  player/PlayerContext.tsx     audio engine: multi-file books, sleep timer, sync
  pages/                       Library, Book, Player, Reader, ComicReader, Discover, Request, Profile, Settings…
  components/                  sheets, cards, voice pickers
```

## Data and backups

Everything that matters is in `./data/turbobooks.db` (accounts, progress, settings) and the library folder. See [docs/DEPLOY.md](docs/DEPLOY.md#backups) for a nightly backup one-liner.
