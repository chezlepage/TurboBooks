# Deploying TurboBooks on ESXi with a Cloudflare Tunnel

```
Phone ──HTTPS──> Cloudflare (Access: only your 2 emails) ──tunnel──> cloudflared ──> turbobooks:8080
                                                                     └──── Ubuntu VM on ESXi ────┘
```

No ports are opened on your router. Cloudflare Access sits in front of the app login, so nobody but the two of you can even load the page.

## Already have a Docker host with cloudflared? (e.g. the Plex VM)

Skip the new VM and the second tunnel. Clone into e.g. `/opt/turbobooks`, and in `.env` set:

```sh
COMPOSE_FILE=docker-compose.shared-tunnel.yml
TUNNEL_NETWORK=mediastack_default   # the network your existing cloudflared container is on
```

Leave `CLOUDFLARE_TUNNEL_TOKEN` empty. In Zero Trust → Tunnels → *your existing tunnel* → Public hostname, add `books.yourdomain.com` → `HTTP` → `turbobooks:8080`. Then do steps 6–8 below.

## 1. Create the VM

In the ESXi web UI, create a VM:

- **Guest OS**: Ubuntu Server 24.04 LTS (64-bit)
- **CPU / RAM**: 2 vCPU, 2 GB (the app itself uses ~100 MB; the rest is headroom for ffprobe scans)
- **Disk**: 20 GB for the OS, plus room for books. LibriVox 64 kbps MP3 is ~29 MB per hour, so a 10-hour book is ~300 MB. A second virtual disk (e.g. 100 GB) mounted at `/srv/audiobooks` keeps books separate from the OS.

Install Ubuntu with OpenSSH enabled, then SSH in.

## 2. Install Docker

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out and back in afterwards
```

## 3. Get the code onto the VM

Push this repo to a **private** GitHub/Gitea repo and clone it, or copy it over:

```sh
# from your PC, in the TurboBooks folder
scp -r . user@vm-ip:~/turbobooks
```

## 4. Configure

```sh
cd ~/turbobooks
cp .env.example .env
nano .env
```

- `ADMIN_USERNAME` / `ADMIN_PASSWORD`: your account, created on first start.
- `LIBRARY_PATH=/srv/audiobooks` if you made a separate disk.
- `CLOUDFLARE_TUNNEL_TOKEN`: from step 5.

If you use a separate library disk, let the container user (uid 1000) write to it:

```sh
sudo mkdir -p /srv/audiobooks && sudo chown 1000:1000 /srv/audiobooks
mkdir -p data && sudo chown 1000:1000 data
```

## 5. Cloudflare Tunnel

1. Cloudflare dashboard → **Zero Trust** → **Networks → Tunnels** → **Create a tunnel** → *Cloudflared*.
2. Name it `turbobooks`. On the install screen choose **Docker** and copy the token (the long string after `--token`) into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. **Public hostname** tab → add:
   - Subdomain `books`, domain: pick one of yours
   - Service: **HTTP**, URL: `turbobooks:8080`

## 6. Cloudflare Access (strongly recommended)

1. Zero Trust → **Access → Applications** → **Add an application** → *Self-hosted*.
2. Domain: `books.yourdomain.com`. Session duration: **1 month** (so you aren't re-verifying at bedtime).
3. Policy: *Allow*, Include → **Emails** → your email and your wife's email.
4. Login method: *One-time PIN* (an emailed code) works out of the box. Google login is also an option.

The app's own login still applies behind this, so there are two locks.

## 7. Start it

```sh
docker compose up -d --build
docker compose logs -f turbobooks
```

Open `https://books.yourdomain.com`, pass the Cloudflare email check, and sign in with your admin account.

Then **Settings → Users → Add user** to create your wife's account. You can now delete `ADMIN_PASSWORD` from `.env`.

## 8. Put it on your phones

- **iPhone**: open the site in Safari → Share → **Add to Home Screen**.
- **Android**: Chrome → ⋮ → **Install app**.

It opens full screen like a normal app, and lock-screen controls work.

## Updating

```sh
cd ~/turbobooks
git pull        # or copy the new files over
docker compose up -d --build
```

## Backups

Everything that matters is in two places:

- `./data/turbobooks.db`: accounts and listening progress (small)
- the library folder: audio (re-downloadable for LibriVox books)

A nightly copy of `data/` is enough:

```sh
# crontab -e
0 4 * * * sqlite3 ~/turbobooks/data/turbobooks.db ".backup '/srv/backups/turbobooks-$(date +\%a).db'"
```

(`sudo apt install sqlite3` first; this keeps a rolling week.)

## Forgot a password?

```sh
docker compose exec -e TB_PASSWORD='new-password-here' turbobooks node dist/cli/create-user.js <username>
```

## Troubleshooting

- **Login works but you're logged out immediately**: `COOKIE_SECURE=true` needs HTTPS. Through Cloudflare that's automatic. For plain `http://vm-ip:8080` testing, set it to `false`.
- **Book not showing after copying files**: Settings → *Rescan library* (it also rescans automatically every 30 min).
- **Discover search fails**: the Internet Archive has occasional outages. Try again in a few minutes.
