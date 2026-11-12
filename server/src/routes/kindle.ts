/**
 * Send to Kindle: emails an EPUB to the user's Kindle address. Amazon converts it
 * and delivers it to their Kindle (and the Kindle apps) over Wi-Fi.
 */
import fs from 'node:fs/promises';
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
const KINDLE_DOMAINS = ['kindle.com', 'free.kindle.com', 'kindle.cn'];

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
  }));

  app.put('/api/me/kindle', async (request, reply) => {
    const body = emailBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Please enter an email address' });
    const email = body.data.email.toLowerCase();
    if (email) {
      if (!z.email().safeParse(email).success) {
        return reply.code(400).send({ error: "That isn't a complete email address. It should look like yourname@kindle.com." });
      }
      if (!KINDLE_DOMAINS.includes(email.split('@')[1])) {
        return reply.code(400).send({
          error: "That isn't a Kindle address. Your Kindle's address ends in @kindle.com (see step 1).",
        });
      }
    }
    db.prepare('UPDATE users SET kindle_email = ? WHERE id = ?').run(email || null, request.user!.id);
    return { email: email || null };
  });

  app.post(
    '/api/books/:id/send-to-kindle',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      if (!enabled()) return reply.code(400).send({ error: 'Send to Kindle is not set up on this server' });
      const to = getKindleEmail(request.user!.id);
      if (!to) return reply.code(400).send({ error: 'Add your Kindle email address first' });

      const { id } = idParam.parse(request.params);
      if (!canAccessBook(request.user!, id)) return reply.code(404).send({ error: 'Ebook not found' });
      const book = db.prepare("SELECT title, path FROM books WHERE id = ? AND kind = 'ebook'").get(id) as
        | { title: string; path: string }
        | undefined;
      if (!book) return reply.code(404).send({ error: 'Ebook not found' });

      const size = (await fs.stat(book.path).catch(() => null))?.size;
      if (size === undefined) return reply.code(404).send({ error: 'The ebook file is missing' });
      if (size > MAX_BYTES) return reply.code(400).send({ error: 'This book is too big for Kindle email (50 MB limit)' });

      try {
        await mailer().sendMail({
          from: config.smtpFrom,
          to,
          subject: book.title,
          text: `"${book.title}", sent from TurboBooks.`,
          attachments: [{ filename: fileName(book.title), path: book.path, contentType: 'application/epub+zip' }],
        });
      } catch (err) {
        request.log.error({ err }, 'send to kindle failed');
        return reply
          .code(502)
          .send({ error: "The server couldn't send the email. Ask whoever runs TurboBooks to check the email settings." });
      }
      return { ok: true, to };
    },
  );
}
