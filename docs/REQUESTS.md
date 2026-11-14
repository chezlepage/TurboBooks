# Requests: Shelfarr, Prowlarr and qBittorrent

The **Request** tab lets anyone on your TurboBooks search for a book and ask for it. When it arrives, it appears on their shelf. Three open-source apps do the work, and `docker-compose.yml` already runs all of them:

| App | What it does | Admin page |
| --- | --- | --- |
| [Shelfarr](https://github.com/Pedro-Revez-Silva/shelfarr) | Takes requests, picks a release, files the finished book | `http://<server>:5056` |
| [Prowlarr](https://prowlarr.com) | Searches the indexers you add | `http://<server>:9696` |
| [qBittorrent](https://www.qbittorrent.org) | Downloads | `http://<server>:8090` |

The folders are already wired up. qBittorrent and Shelfarr share `./downloads`, and Shelfarr files finished books into `library/Requested/`, where TurboBooks picks them up. What's left is the part only you can decide: accounts, passwords and which indexers to use. Plan on about 10 minutes.

You choose what these apps download and from where. Only add sources you have the right to use.

## 1. Start everything

```sh
docker compose up -d --build
```

## 2. qBittorrent

1. Find its temporary password:
   ```sh
   docker compose logs qbittorrent | grep -i password
   ```
2. Open `http://<server>:8090` and sign in as `admin` with that password.
3. Go to **Tools → Options → Web UI** and set your own password. The temporary one changes on every restart.

Downloads already go to `/downloads`, the folder Shelfarr watches. Many people route qBittorrent through a VPN, for example a [gluetun](https://github.com/qdm12/gluetun) container. If you do, keep Shelfarr able to reach it.

## 3. Prowlarr

1. Open `http://<server>:9696`. On the first visit, it asks you to choose a login. Do that.
2. Go to **Indexers → Add Indexer** and add the ones you want to use.
3. Go to **Settings → General** and copy the **API Key**.

## 4. Shelfarr

1. Open `http://<server>:5056` and **sign up right away**. The first account becomes the admin. Passwords need an uppercase letter, a lowercase letter and a number.
2. A five-step setup wizard opens. Fill in each step:

| Step | What to enter |
| --- | --- |
| **1. Prowlarr** | URL `http://prowlarr:9696`, plus the API key from step 3 |
| **2. qBittorrent** | URL `http://qbittorrent:8090`, plus the username and password from step 2 |
| **3. Folders** | Leave the defaults: `/audiobooks`, `/ebooks`, `/downloads` |
| **4. Audiobookshelf** | **Skip this step** (TurboBooks is your library) |
| **5. Search** | Your choice, then **Finish** |

If you skipped the wizard, open it again from **Setup** in Shelfarr's top bar.

## 5. Connect TurboBooks

1. In Shelfarr, click your name, then go to **API tokens**.
2. Name the token `TurboBooks`, tick all three boxes (**Search**, **Read requests**, **Create/cancel requests**) and click **Create API Token**.
3. **Copy the token now.** It starts with `shf_` and is shown only once; later, the list shows only its first few characters.
4. Add it to `.env`:
   ```sh
   SHELFARR_TOKEN=shf_...
   ```
5. Restart TurboBooks so it picks up the token:
   ```sh
   docker compose up -d turbobooks
   ```

The Request tab now searches. Finished books land in `library/Requested/Audiobooks` or `library/Requested/Ebooks`, and each one goes onto the shelf of the person who asked for it.

## Good to know

- **Admin pages and public IPs.** The three admin pages are open on every network interface by default. That's fine at home. On a server with a public IP, set `ADMIN_UI_BIND=127.0.0.1` in `.env` and reach the pages over SSH:
  ```sh
  ssh -L 5056:localhost:5056 -L 9696:localhost:9696 -L 8090:localhost:8090 you@server
  ```
- **Already run Shelfarr somewhere else?** Set `SHELFARR_URL=http://that-host:5056` in `.env`. You can then stop the bundled apps:
  ```sh
  docker compose stop shelfarr prowlarr qbittorrent
  ```
- **Don't want Requests at all?** Stop the three apps the same way. Everything else in TurboBooks keeps working; the Request tab just says it isn't set up.
- **Where things are stored.** Their settings live in `data/shelfarr`, `data/prowlarr` and `data/qbittorrent`. Downloads go to `./downloads`; set `DOWNLOADS_PATH` in `.env` to move them.
- **Folder owner.** All three run as uid/gid 1000, the same as TurboBooks. If your library disk belongs to someone else, set `PUID` / `PGID` in `.env`.
