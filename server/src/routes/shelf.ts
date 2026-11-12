import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../db.js';
import { requireUser } from '../lib/auth.js';
import { checkFreeCopies, importGoodreadsCsv, isCheckingFree } from '../lib/goodreads.js';
import { canAccessBook } from '../lib/library.js';

/**
 * My shelves: books I want to read or have read outside the library (Goodreads import or
 * added by hand), plus ratings and notes on books in my library.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });
const shelfEnum = z.enum(['want', 'reading', 'read']);
const rating = z.number().int().min(1).max(5).nullable();

const addBody = z.object({
  title: z.string().trim().min(1).max(500),
  author: z.string().trim().max(300).optional(),
  shelf: shelfEnum.default('want'),
});
const patchBody = z.object({
  shelf: shelfEnum.optional(),
  hidden: z.boolean().optional(),
  rating: rating.optional(),
  review: z.string().max(10_000).nullable().optional(),
});
const ratingBody = z.object({ rating, note: z.string().max(10_000).nullable().optional() });

interface ShelfRow {
  id: number;
  shelf: 'want' | 'reading' | 'read';
  title: string;
  author: string | null;
  isbn13: string | null;
  rating: number | null;
  review: string | null;
  date_read: number | null;
  date_added: number;
  hidden: number;
  book_id: number | null;
  free_ebook_id: string | null;
  free_audio_id: string | null;
  free_checked_at: number | null;
}

export const toShelfItem = (r: ShelfRow) => ({
  id: r.id,
  shelf: r.shelf,
  title: r.title,
  author: r.author,
  isbn13: r.isbn13,
  rating: r.rating,
  review: r.review,
  dateRead: r.date_read,
  dateAdded: r.date_added,
  hidden: r.hidden === 1,
  bookId: r.book_id,
  freeEbookId: r.free_ebook_id,
  freeAudioId: r.free_audio_id,
  freeChecked: r.free_checked_at !== null,
});

export async function shelfRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/shelf', async (request) => {
    const rows = db
      .prepare('SELECT * FROM shelf_items WHERE user_id = ? ORDER BY COALESCE(date_read, date_added) DESC')
      .all(request.user!.id) as ShelfRow[];
    return { items: rows.map(toShelfItem), checkingFree: isCheckingFree(request.user!.id) };
  });

  /** Goodreads export CSV, sent as text. Big libraries can be a few MB. */
  app.post(
    '/api/shelf/import/goodreads',
    { bodyLimit: 15 * 1024 * 1024, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = z.object({ csv: z.string().min(1) }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'Choose your Goodreads export file' });
      try {
        return { summary: importGoodreadsCsv(request.user!.id, body.data.csv) };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post('/api/shelf/check-free', async (request) => {
    // Forget earlier results so this is a fresh look.
    db.prepare("UPDATE shelf_items SET free_checked_at = NULL WHERE user_id = ? AND shelf IN ('want','reading')").run(
      request.user!.id,
    );
    void checkFreeCopies(request.user!.id);
    return { ok: true };
  });

  app.post('/api/shelf', async (request, reply) => {
    const body = addBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'A title is required' });
    const info = db
      .prepare('INSERT INTO shelf_items (user_id, shelf, title, author, date_added) VALUES (?, ?, ?, ?, ?)')
      .run(request.user!.id, body.data.shelf, body.data.title, body.data.author || null, now());
    void checkFreeCopies(request.user!.id);
    return { id: Number(info.lastInsertRowid) };
  });

  app.patch('/api/shelf/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = patchBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid change' });
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, user: request.user!.id };
    if (body.data.shelf) {
      sets.push('shelf = @shelf');
      params.shelf = body.data.shelf;
      if (body.data.shelf === 'read') {
        sets.push('date_read = COALESCE(date_read, @now)');
        params.now = now();
      }
    }
    if (body.data.hidden !== undefined) {
      sets.push('hidden = @hidden');
      params.hidden = body.data.hidden ? 1 : 0;
    }
    if (body.data.rating !== undefined) {
      sets.push('rating = @rating');
      params.rating = body.data.rating;
    }
    if (body.data.review !== undefined) {
      sets.push('review = @review');
      params.review = body.data.review;
    }
    if (sets.length === 0) return { ok: true };
    const info = db.prepare(`UPDATE shelf_items SET ${sets.join(', ')} WHERE id = @id AND user_id = @user`).run(params);
    if (info.changes === 0) return reply.code(404).send({ error: 'Not found' });
    return { ok: true };
  });

  app.delete('/api/shelf/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    db.prepare('DELETE FROM shelf_items WHERE id = ? AND user_id = ?').run(id, request.user!.id);
    return { ok: true };
  });

  /** My rating and note for a book in the library. */
  app.put('/api/books/:id/rating', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!canAccessBook(request.user!, id)) return reply.code(404).send({ error: 'Book not found' });
    const body = ratingBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Rating must be 1 to 5 stars' });
    db.prepare(
      `INSERT INTO book_ratings (user_id, book_id, rating, note, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, book_id) DO UPDATE SET rating = excluded.rating, note = excluded.note, updated_at = excluded.updated_at`,
    ).run(request.user!.id, id, body.data.rating, body.data.note ?? null, now());
    return { ok: true };
  });
}

export function getMyRating(userId: number, bookId: number): { rating: number | null; note: string | null } | null {
  return (
    (db.prepare('SELECT rating, note FROM book_ratings WHERE user_id = ? AND book_id = ?').get(userId, bookId) as
      | { rating: number | null; note: string | null }
      | undefined) ?? null
  );
}
