# Requests: Shelfarr, Prowlarr and qBittorrent

The **Request** tab lets anyone on your TurboBooks search for a book and ask for it. When it arrives, it appears on their shelf. Three open-source apps do the work, and `docker-compose.yml` already runs all of them:

| App | What it does |
| --- | --- |
| [Prowlarr](https://prowlarr.com) | Searches the indexers you add |
| [Shelfarr](https://github.com/Pedro-Revez-Silva/shelfarr) | Takes requests, picks a release, files the finished book |
| [qBittorrent](https://www.qbittorrent.org) | Downloads |

You set them up once, from inside TurboBooks, in about 10 minutes. You choose what these apps download and from where; only add sources you have the right to use.

## Set up

Sign in to TurboBooks as an admin and open **Settings → Requests**. Each app has an **Open** button.

1. **Prowlarr.** Click **Open**, go to **Indexers → Add Indexer**, and add the ones you want. Then copy the **API Key** from **Settings → General**.
2. **Shelfarr.** Click **Open** and sign up. The first account becomes Shelfarr's admin. A five-step wizard follows:

   | Step | What to enter |
   | --- | --- |
   | Prowlarr | `http://prowlarr:9696/apps/prowlarr`, plus the API key from step 1 |
   | qBittorrent | `http://qbittorrent:8090`, user `admin`, any password |
   | Folders | Keep the suggested ones |
   | Audiobookshelf | **Skip this step** |
   | Search | Your choice, then **Finish** |

3. **Connect TurboBooks.** In Shelfarr, click your name, go to **API tokens**, tick all three boxes and create a token. Copy it right away, because Shelfarr shows it only once. Paste it into **Settings → Requests** in TurboBooks and click **Connect**.

That's it: the Request tab works. Finished books land in `library/Requested/` and go onto the shelf of the person who asked for them.

## How it's kept safe

- **Only TurboBooks admins can open the three apps.** They are served through TurboBooks at `/apps/...`, behind its login. Their own ports are never opened on your network, so the address you use for TurboBooks (at home or through Cloudflare) is the only way in.
- **No separate logins for Prowlarr and qBittorrent.** The TurboBooks admin login already guards them, and nothing else can reach them. Shelfarr keeps its own accounts, because each one owns its requests and tokens.
- **Your TurboBooks session never reaches the apps.** TurboBooks strips its sign-in cookie before passing a request on. It also refuses changes sent to the apps from other websites.
- **Downloads.** qBittorrent's torrent port (6881) is the one port these apps open, because peers need it. Many people send qBittorrent's traffic through a VPN, for example a [gluetun](https://github.com/qdm12/gluetun) container.

## Good to know

- **Already run Shelfarr somewhere else?** Set `SHELFARR_URL=http://that-host:5056` in `.env` and paste a token from that Shelfarr in Settings. You can stop the bundled apps:
  ```sh
  docker compose stop shelfarr prowlarr qbittorrent
  ```
- **Don't want Requests at all?** Stop the three apps the same way. Everything else in TurboBooks keeps working; the Request tab just says it isn't set up.
- **Where things are stored.** Settings live in `data/shelfarr`, `data/prowlarr` and `data/qbittorrent`. Downloads go to `./downloads`; set `DOWNLOADS_PATH` in `.env` to move them.
- **Folder owner.** All three apps run as uid/gid 1000, the same as TurboBooks. If your library disk belongs to someone else, set `PUID` / `PGID` in `.env`.
