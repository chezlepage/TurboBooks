/**
 * Send to e-reader: emails an EPUB to the user's device address. Works with Kindle (Amazon
 * converts it and delivers it over Wi-Fi) and PocketBook (Send-to-PocketBook, @pbsync.com).
 * The address lives in users.kindle_email whatever the device; the domain says which it is.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { requireUser } from '../lib/auth.js';
import { canAccessBook } from '../lib/library.js';

/** Amazon's limit for emailed documents. */
const MAX_BYTES = 50 * 1024 * 1024;

export type Ereader = 'kindle' | 'pocketbook';
const DEVICE_DOMAINS: Record<string, Ereader> = {
  'kindle.com': 'kindle',
  'free.kindle.com': 'kindle',
  'kindle.cn': 'kindle',
  'pbsync.com': 'pocketbook',
};
const DEVICE_NAMES: Record<Ereader, string> = { kindle: 'Kindle', pocketbook: 'PocketBook' };
const deviceOf = (email: string | null): Ereader | null => (email ? (DEVICE_DOMAINS[email.split('@')[1]] ?? null) : null);

const enabled = () => Boolean(config.smtpHost && config.smtpFrom);

let transporter: Transporter | null = null;
const mailer = () =>
  (transporter ??= nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  }));

/** Just the address part of SMTP_FROM, which may be `Name <addr>`. */
const senderAddress = () => config.smtpFrom.match(/<([^>]+)>/)?.[1] ?? config.smtpFrom;

const idParam = z.object({ id: z.coerce.number().int().positive() });
const emailBody = z.object({ email: z.string().trim().max(254) });

const getKindleEmail = (userId: number) =>
  (db.prepare('SELECT kindle_email FROM users WHERE id = ?').get(userId) as { kindle_email: string | null } | undefined)
    ?.kindle_email ?? null;

/** Safe attachment name; Amazon uses it as the title if the EPUB has none. */
const fileName = (title: string) =>
  `${title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'book'}.epub`;

export async function kindleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/me/kindle', async (request) => ({
    enabled: enabled(),
    sender: enabled() ? senderAddress() : null,
    email: getKindleEmail(request.user!.id),
    device: deviceOf(getKindleEmail(request.user!.id)),
  }));

  app.put('/api/me/kindle', async (request, reply) => {
    const body = emailBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Please enter an email address' });
    const email = body.data.email.toLowerCase();
    if (email) {
      if (!z.email().safeParse(email).success) {
        return reply
          .code(400)
          .send({ error: "That isn't a complete email address. It should look like yourname@kindle.com or yourname@pbsync.com." });
      }
      if (!deviceOf(email)) {
        return reply.code(400).send({
          error:
            "That isn't an e-reader address. A Kindle's ends in @kindle.com, a PocketBook's in @pbsync.com (see step 1).",
        });
      }
    }
    db.prepare('UPDATE users SET kindle_email = ? WHERE id = ?').run(email || null, request.user!.id);
    return { email: email || null, device: deviceOf(email || null) };
  });

  app.post(
    '/api/books/:id/send-to-kindle',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      if (!enabled()) return reply.code(400).send({ error: 'Sending to e-readers is not set up on this server' });
      const to = getKindleEmail(request.user!.id);
      if (!to) return reply.code(400).send({ error: "Add your e-reader's email address first" });
      const device = DEVICE_NAMES[deviceOf(to) ?? 'kindle'];

      const { id } = idParam.parse(request.params);
      if (!canAccessBook(request.user!, id)) return reply.code(404).send({ error: 'Ebook not found' });
      const book = db.prepare("SELECT title, path FROM books WHERE id = ? AND kind = 'ebook'").get(id) as
        | { title: string; path: string }
        | undefined;
      if (!book) return reply.code(404).send({ error: 'Ebook not found' });
      const comic = /\.cb[zr]$/i.test(book.path);
      // PocketBook reads CBZ/CBR itself; Amazon's email service doesn't take them.
      if (comic && deviceOf(to) !== 'pocketbook') {
        return reply.code(400).send({ error: "Kindles can't receive comic files by email. A PocketBook can." });
      }

      const size = (await fs.stat(book.path).catch(() => null))?.size;
      if (size === undefined) return reply.code(404).send({ error: 'The ebook file is missing' });
      if (size > MAX_BYTES) return reply.code(400).send({ error: `This book is too big to email to a ${device} (50 MB limit)` });

      try {
        const sent = await mailer().sendMail({
          from: config.smtpFrom,
          to,
          subject: book.title,
          text: `"${book.title}", sent from TurboBooks.`,
          attachments: [
            comic
              ? { filename: fileName(book.title).replace(/\.epub$/, path.extname(book.path).toLowerCase()), path: book.path, contentType: 'application/octet-stream' }
              : { filename: fileName(book.title), path: book.path, contentType: 'application/epub+zip' },
          ],
        });
        // Logged (not just errors) so "did it actually send?" can be answered from the server logs.
        console.log(
          `[kindle] ${request.user!.username} sent book ${id} to their ${device} (${(size / 1e6).toFixed(1)} MB), mail server said: ${sent.response}`,
        );
      } catch (err) {
        request.log.error({ err }, 'send to kindle failed');
        return reply
          .code(502)
          .send({ error: "The server couldn't send the email. Ask whoever runs TurboBooks to check the email settings." });
      }
      return { ok: true, to, device: deviceOf(to) };
    },
  );
}
