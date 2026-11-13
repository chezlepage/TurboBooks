# Turning on Send to Kindle / PocketBook

With this on, a **Send to Kindle** (or **Send to PocketBook**) button appears on every ebook. TurboBooks emails the EPUB to the reader's device address and it arrives over Wi-Fi:

- **Kindle**: the reader's `@kindle.com` address; Amazon delivers it.
- **PocketBook**: the reader's `@pbsync.com` address from PocketBook's free Send-to-PocketBook service. The first book from a new sender makes PocketBook email the reader to confirm it; after that, books go straight through.

You set up the sending email account once, for the whole server. Each reader then follows the guided setup in the app (**Profile → Settings → Kindle or PocketBook**). It has a Kindle / PocketBook switch and walks them through finding their device address and approving the sender, with no technical steps. One e-reader per person.

## 1. Pick an email account to send from

The easiest choice is a **Gmail account made just for TurboBooks**, e.g. `ourturbobooks@gmail.com`. Any account works, but keep in mind:

- Readers will paste this address into their Amazon settings. A dedicated account keeps your personal address out of it.
- If you change it later, everyone has to approve the new address in Amazon again.

## 2. Make a Gmail app password

Gmail won't let apps sign in with your normal password. Create a separate one:

1. Sign in to the Gmail account and turn on **2-Step Verification** (Google Account → Security). App passwords need it.
2. Go to <https://myaccount.google.com/apppasswords>.
3. Name it `TurboBooks` and click **Create**.
4. Copy the 16-letter password it shows. You won't see it again.

## 3. Add the settings to `.env`

On the server, open `.env` (next to `docker-compose.yml`) and add:

```sh
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=ourturbobooks@gmail.com
SMTP_PASS=abcdefghijklmnop        # the app password, spaces removed
# Optional: shown as the sender name. Defaults to SMTP_USER.
# SMTP_FROM=TurboBooks <ourturbobooks@gmail.com>
```

Then restart:

```sh
docker compose up -d
```

### Sending from your own domain (e.g. `kindle@yourdomain.com`)

Use an email-sending service such as [Resend](https://resend.com) (free for 3,000 emails/month):

1. Resend → **Domains → Add Domain** → your root domain (not the `books.` subdomain the tunnel uses).
2. Add the DNS records it shows in Cloudflare, all set to **DNS only** (grey cloud), then click **Verify**.
3. Resend → **API Keys** → create a key with **Sending access** only.
4. In `.env`:

   ```sh
   SMTP_HOST=smtp.resend.com
   SMTP_PORT=465
   SMTP_USER=resend
   SMTP_PASS=re_...                       # the sending key
   SMTP_FROM=TurboBooks <kindle@yourdomain.com>
   ```

The `kindle@` address doesn't need a real mailbox. To see Amazon's delivery notices, forward it to your inbox with Cloudflare **Email → Email Routing**.

### Other providers

Any provider with SMTP works. Fill in the provider's server, port, username and password:

| Provider | `SMTP_HOST` | `SMTP_PORT` |
| --- | --- | --- |
| Gmail | `smtp.gmail.com` | `587` |
| Outlook / Hotmail | `smtp-mail.outlook.com` | `587` |
| iCloud Mail | `smtp.mail.me.com` | `587` |
| Fastmail | `smtp.fastmail.com` | `465` |

Port `465` uses implicit TLS. Any other port upgrades with STARTTLS.

## 4. Try it

1. In TurboBooks, go to **Profile → Settings → Kindle → Set up Send to Kindle** and follow the three steps for your own Kindle.
2. Open an ebook and tap **Send to Kindle**. It should appear on the Kindle within a few minutes.

If the app says *"The server couldn't send the email"*, the SMTP settings are wrong. Check the server log:

```sh
docker compose logs turbobooks | grep -i "send to kindle"
```

The usual cause is `Invalid login`, meaning the app password is wrong or 2-Step Verification is off.

## Limits

- Amazon rejects files over 50 MB. Gutenberg books are far smaller.
- Each user can send 20 books per hour.
- Gmail allows about 500 emails a day, which is plenty.
- Your reading position on the Kindle doesn't sync back to TurboBooks. Amazon doesn't let other apps read it.
