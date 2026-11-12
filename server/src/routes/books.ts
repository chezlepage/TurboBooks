import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { addToLibrary, canAccessBook, removeFromLibrary } from '../lib/library.js';
import { sendFileWithRange } from '../lib/stream.js';
import { removeCoverFiles } from '../lib/scanner.js';
import { getSleepMark } from './prefs.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const progressBody = z.object({
  /** Seconds for audiobooks, 0..1 fraction for ebooks. */
  position: z.number().min(0),
  finished: z.boolean().optional(),
  /** Ebook reader location (EPUB CFI). */
  locator: z.string().max(4096).optional(),
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
  kind: 'audio' | 'ebook';
  position: number | null;
  finished: number | null;
  locator: string | null;
  progress_updated_at: number | null;
  in_library: number;
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
  kind: b.kind,
  /** In the current user's own library (vs. seen via someone's profile, or unclaimed). */
  inLibrary: b.in_library === 1,
  progress:
    b.position === null
      ? null
      : { position: b.position, finished: b.finished === 1, locator: b.locator, updatedAt: b.progress_updated_at! },
});

/** Books joined with the current user's (@uid) progress and library membership. */
const BOOK_SELECT = `
  SELECT b.id, b.title, b.author, b.narrator, b.description, b.duration, b.cover_path, b.source, b.added_at, b.kind,
         p.position, p.finished, p.locator, p.updated_at AS progress_updated_at,
         (le.user_id IS NOT NULL) AS in_library
  FROM books b
  LEFT JOIN progress p ON p.book_id = b.id AND p.user_id = @uid
  LEFT JOIN library_entries le ON le.book_id = b.id AND le.user_id = @uid`;

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

  /** The current user's own library. */
  app.get('/api/books', async (request) => {
    const rows = db
      .prepare(`${BOOK_SELECT} WHERE le.user_id IS NOT NULL ORDER BY b.title COLLATE NOCASE`)
      .all({ uid: request.user!.id }) as BookRow[];
    return { books: rows.map(toBook) };
  });

  /** Admin: files on the server that nobody has in their library yet (e.g. copied in by hand). */
  app.get('/api/books/unclaimed', { preHandler: requireAdmin }, async (request) => {
    const rows = db
      .prepare(
        `${BOOK_SELECT} WHERE NOT EXISTS (SELECT 1 FROM library_entries x WHERE x.book_id = b.id)
         ORDER BY b.added_at DESC`,
      )
      .all({ uid: request.user!.id }) as BookRow[];
    return { books: rows.map(toBook) };
  });

  app.get('/api/books/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    // 404 (not 403) for books you can't see, so nobody can probe what others have added.
    if (!canAccessBook(request.user!, id)) return reply.code(404).send({ error: 'Book not found' });
    const row = db.prepare(`${BOOK_SELECT} WHERE b.id = @id`).get({ uid: request.user!.id, id }) as BookRow | undefined;
    if (!row) return reply.code(404).send({ error: 'Book not found' });
    const tracks = db
      .prepare('SELECT id, idx, title, duration, start_offset AS start FROM tracks WHERE book_id = ? ORDER BY idx')
      .all(id);
    const chapters = db
      .prepare('SELECT idx, title, start, end FROM chapters WHERE book_id = ? ORDER BY idx')
      .all(id);
    return { book: { ...toBook(row), tracks, chapters, sleepMark: getSleepMark(request.user!.id, id) } };
  });

  /** Add a book that's already on the server to my library (no download needed). */
  app.post('/api/books/:id/library', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!canAccessBook(request.user!, id)) return reply.code(404).send({ error: 'Book not found' });
    addToLibrary(request.user!.id, id);
    return { ok: true };
  });

  /** Remove from my library only; the file stays for anyone else who has it. */
  app.delete('/api/books/:id/library', async (request) => {
    const { id } = idParam.parse(request.params);
    removeFromLibrary(request.user!.id, id);
    return { ok: true };
  });

  app.get('/api/books/:id/cover', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!canAccessBook(request.user!, id)) return reply.code(404).send({ error: 'No cover' });
    const row = db.prepare('SELECT cover_path FROM books WHERE id = ?').get(id) as { cover_path: string | null } | undefined;
    if (!row?.cover_path) return reply.code(404).send({ error: 'No cover' });
    const type = IMAGE_TYPES[path.extname(row.cover_path).toLowerCase()] ?? 'image/jpeg';
    return sendFileWithRange(request, reply, row.cover_path, type);
  });

  /** The EPUB file itself, for the in-browser reader. */
  app.get('/api/books/:id/file', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!canAccessBook(request.user!, id)) return reply.code(404).send({ error: 'Ebook not found' });
    const row = db.prepare("SELECT path FROM books WHERE id = ? AND kind = 'ebook'").get(id) as { path: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Ebook not found' });
    return sendFileWithRange(request, reply, row.path, 'application/epub+zip');
  });

  app.get('/api/tracks/:id/stream', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const row = db.prepare('SELECT path, mime, book_id FROM tracks WHERE id = ?').get(id) as
      | { path: string; mime: string; book_id: number }
      | undefined;
    if (!row || !canAccessBook(request.user!, row.book_id)) return reply.code(404).send({ error: 'Track not found' });
    return sendFileWithRange(request, reply, row.path, row.mime);
  });

  const saveProgress = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const { id } = idParam.parse(request.params);
    const body = progressBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid progress' });
    const book = db.prepare('SELECT duration, kind FROM books WHERE id = ?').get(id) as
      | { duration: number; kind: 'audio' | 'ebook' }
      | undefined;
    if (!book || !canAccessBook(request.user!, id)) return reply.code(404).send({ error: 'Book not found' });
    // Listening to or reading a book puts it in your library.
    addToLibrary(request.user!.id, id);
    const position = Math.min(body.data.position, book.duration);
    const finished = body.data.finished ?? (book.kind === 'ebook' ? position >= 0.995 : position >= book.duration - 5);
    const updatedAt = now();
    db.prepare(
      `INSERT INTO progress (user_id, book_id, position, finished, locator, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, book_id) DO UPDATE SET position = excluded.position, finished = excluded.finished,
         locator = COALESCE(excluded.locator, progress.locator), updated_at = excluded.updated_at`,
    ).run(request.user!.id, id, position, finished ? 1 : 0, body.data.locator ?? null, updatedAt);
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
    const row = db.prepare('SELECT path, kind FROM books WHERE id = ?').get(id) as { path: string; kind: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Book not found' });
    if (!isInside(row.path, config.libraryDir)) return reply.code(400).send({ error: 'Refusing to delete outside library' });
    await fs.rm(row.path, { recursive: true, force: true });
    if (row.kind === 'ebook') {
      // Imported ebooks live in their own folder next to a metadata file; remove the folder if that's all that's left.
      const dir = path.dirname(row.path);
      const left = await fs.readdir(dir).catch(() => ['?']);
      if (isInside(dir, config.libraryDir) && left.every((n) => n === 'metadata.ebook.json')) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
    await removeCoverFiles(id);
    db.prepare('DELETE FROM books WHERE id = ?').run(id);
    return { ok: true };
  });
}
