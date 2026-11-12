# TurboBooks

Self-hosted audiobook player built for falling asleep. Two (or more) accounts, each with their own progress, free public-domain books one tap away.

## Features

- **Discover**: browse shelves (Bedtime & children, Under 90 min, Mystery, Sci-fi…) or search the LibriVox collection on the Internet Archive, most popular version first, and add books with one tap. The server downloads them in the background.
- **Bring your own files**: drop MP3/M4B/M4A/OGG/FLAC into the library folder. Each folder is one book; M4B chapters are detected.
- **Sleep timer**: 5–90 min or end of chapter. Volume fades out over the last 45 s (desktop/Android; iOS ignores web volume, so it stops without fading).
- **Auto-rewind**: 60 s after the sleep timer stops it, 5–30 s after a long pause.
- **"Dozed off?"**: after the timer stops playback, the player offers to jump back to where you set the timer.
- **Auto sleep timer**: optionally start a timer every time you press play (Settings → Bedtime), at night only if you like.
- **Night screen**: pitch-black overlay with one dim play button, no glare in a dark room.
- **Per-user progress** synced to the server every 10 s and on pause/close. Resume on any device.
- Lock-screen and headphone controls (Media Session), 0.8–2× speed, chapter skip.
- Installable PWA with a dark, dim UI meant for a dark bedroom.
- Login with argon2-hashed passwords, httpOnly session cookies, rate-limited sign-in, and admin-managed accounts (no public sign-up).

## Stack

| Part | Tech |
| --- | --- |
| Server | Node 22, Fastify 5, TypeScript, SQLite (better-sqlite3), ffprobe |
| Web | React 18, Vite, React Router |
| Deploy | Docker Compose + Cloudflare Tunnel (+ Cloudflare Access recommended) |

```
server/src/
  index.ts           app setup, static web, first-run admin
  config.ts          env config
  db.ts              schema + migrations
  lib/auth.ts        passwords, sessions
  lib/scanner.ts     library scan (folders -> books/tracks/chapters)
  lib/archive.ts     Internet Archive search + download queue
  lib/stream.ts      HTTP range streaming
  routes/            auth, books, admin, discover
  cli/create-user.ts
web/src/
  player/PlayerContext.tsx   audio engine: multi-file books, sleep timer, rewind, sync
  pages/                     Library, Book, Player, Discover, Settings, Login
```

## Develop

Needs Node 22+ and ffmpeg/ffprobe on PATH.

```sh
npm install
cp .env.example .env     # set ADMIN_USERNAME / ADMIN_PASSWORD, and COOKIE_SECURE=false for http://localhost
npm run dev              # server :8080, web :5173 (proxies /api)
```

Open http://localhost:5173. Data goes to `server/data`, audio to `server/library` unless `DATA_DIR` / `LIBRARY_DIR` are set.

Other scripts: `npm run typecheck`, `npm run build`, `npm run create-user -- <name> [--admin]`.

## Deploy

See [docs/DEPLOY.md](docs/DEPLOY.md) for ESXi VM + Docker + Cloudflare Tunnel/Access.

## Library layout

```
library/
  LibriVox/Margery Williams - The Velveteen Rabbit/   <- added by Discover
    01.mp3 ... cover.jpg metadata.json
  Some Author - Some Book/                             <- your own files
    01 Chapter One.mp3
    02 Chapter Two.mp3
    cover.jpg
  Standalone Book.m4b                                  <- single file = one book
```

Any folder that directly contains audio files is a book. Files are natural-sorted (`2` before `10`). An optional `metadata.json` overrides tags: `{ "title", "author", "narrator", "description", "trackTitles": [] }`. Folders starting with `.` are ignored.
