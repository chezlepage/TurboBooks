import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { sendFileWithRange } from '../lib/stream.js';
import { getSleepMark } from './prefs.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const progressBody = z.object({
  position: z.number().min(0),
  finished: z.boolean().optional(),
});

interface BookRow {
  id: number;
  title: string;
  author: string | null;
  narrator: string | null;
  description: string | null;
  duration: number;
  cover_path: string | null;
  source: string | null;
  added_at: number;
  position: number | null;
  finished: number | null;
  progress_updated_at: number | null;
}

const toBook = (b: BookRow) => ({
  id: b.id,
  title: b.title,
  author: b.author,
  narrator: b.narrator,
  description: b.description,
  duration: b.duration,
  hasCover: b.cover_path !== null,
  source: b.source,
  addedAt: b.added_at,
  progress:
    b.position === null
      ? null
      : { position: b.position, finished: b.finished === 1, updatedAt: b.progress_updated_at! },
});

const BOOK_SELECT = `
  SELECT b.id, b.title, b.author, b.narrator, b.description, b.duration, b.cover_path, b.source, b.added_at,
         p.position, p.finished, p.updated_at AS progress_updated_at
  FROM books b
  LEFT JOIN progress p ON p.book_id = b.id AND p.user_id = ?`;

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export async function bookRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/books', async (request) => {
    const rows = db.prepare(`${BOOK_SELECT} ORDER BY b.title COLLATE NOCASE`).all(request.user!.id) as BookRow[];
    return { books: rows.map(toBook) };
  });

  app.get('/api/books/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const row = db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(request.user!.id, id) as BookRow | undefined;
    if (!row) return reply.code(404).send({ error: 'Book not found' });
    const tracks = db
      .prepare('SELECT id, idx, title, duration, start_offset AS start FROM tracks WHERE book_id = ? ORDER BY idx')
      .all(id);
    const chapters = db
      .prepare('SELECT idx, title, start, end FROM chapters WHERE book_id = ? ORDER BY idx')
      .all(id);
    return { book: { ...toBook(row), tracks, chapters, sleepMark: getSleepMark(request.user!.id, id) } };
  });

  app.get('/api/books/:id/cover', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const row = db.prepare('SELECT cover_path FROM books WHERE id = ?').get(id) as { cover_path: string | null } | undefined;
    if (!row?.cover_path) return reply.code(404).send({ error: 'No cover' });
    const type = IMAGE_TYPES[path.extname(row.cover_path).toLowerCase()] ?? 'image/jpeg';
    return sendFileWithRange(request, reply, row.cover_path, type);
  });

  app.get('/api/tracks/:id/stream', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const row = db.prepare('SELECT path, mime FROM tracks WHERE id = ?').get(id) as { path: string; mime: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Track not found' });
    return sendFileWithRange(request, reply, row.path, row.mime);
  });

  const saveProgress = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const { id } = idParam.parse(request.params);
    const body = progressBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid progress' });
    const book = db.prepare('SELECT duration FROM books WHERE id = ?').get(id) as { duration: number } | undefined;
    if (!book) return reply.code(404).send({ error: 'Book not found' });
    const position = Math.min(body.data.position, book.duration);
    const finished = body.data.finished ?? position >= book.duration - 5;
    const updatedAt = now();
    db.prepare(
      `INSERT INTO progress (user_id, book_id, position, finished, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, book_id) DO UPDATE SET position = excluded.position, finished = excluded.finished, updated_at = excluded.updated_at`,
    ).run(request.user!.id, id, position, finished ? 1 : 0, updatedAt);
    return { ok: true, updatedAt };
  };
  app.put('/api/books/:id/progress', saveProgress);
  // POST variant so the browser can use navigator.sendBeacon when the page is closed.
  app.post('/api/books/:id/progress', saveProgress);

  app.delete('/api/books/:id/progress', async (request) => {
    const { id } = idParam.parse(request.params);
    db.prepare('DELETE FROM progress WHERE user_id = ? AND book_id = ?').run(request.user!.id, id);
    return { ok: true };
  });

  /** Admin: delete a book and its files from disk. */
  app.delete('/api/books/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const row = db.prepare('SELECT path FROM books WHERE id = ?').get(id) as { path: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Book not found' });
    if (!isInside(row.path, config.libraryDir)) return reply.code(400).send({ error: 'Refusing to delete outside library' });
    await fs.rm(row.path, { recursive: true, force: true });
    await fs.rm(path.join(config.dataDir, 'covers', `${id}.jpg`), { force: true });
    db.prepare('DELETE FROM books WHERE id = ?').run(id);
    return { ok: true };
  });
}
