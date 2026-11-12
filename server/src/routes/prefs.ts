import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../db.js';
import { requireUser } from '../lib/auth.js';

/** How long a "you fell asleep here" mark is offered. */
export const SLEEP_MARK_TTL_MS = 18 * 60 * 60 * 1000;

const prefsSchema = z.object({
  autoSleep: z.union([z.literal('off'), z.literal('chapter'), z.number().int().min(1).max(240)]),
  autoSleepNightOnly: z.boolean(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });
const markBody = z.object({ position: z.number().min(0) });

export function getSleepMark(userId: number, bookId: number): { position: number; at: number } | null {
  const row = db
    .prepare('SELECT position, at FROM sleep_marks WHERE user_id = ? AND book_id = ? AND at > ?')
    .get(userId, bookId, now() - SLEEP_MARK_TTL_MS) as { position: number; at: number } | undefined;
  return row ?? null;
}

export async function prefsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  /** `prefs` is null until the user saves once, so a client can upload older device-local settings. */
  app.get('/api/me/prefs', async (request) => {
    const row = db.prepare('SELECT data FROM user_prefs WHERE user_id = ?').get(request.user!.id) as
      | { data: string }
      | undefined;
    if (!row) return { prefs: null };
    const parsed = prefsSchema.safeParse(JSON.parse(row.data));
    return { prefs: parsed.success ? parsed.data : null };
  });

  app.put('/api/me/prefs', async (request, reply) => {
    const body = prefsSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid preferences' });
    db.prepare(
      `INSERT INTO user_prefs (user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ).run(request.user!.id, JSON.stringify(body.data), now());
    return { prefs: body.data };
  });

  app.put('/api/books/:id/sleep-mark', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = markBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid position' });
    if (!db.prepare('SELECT 1 FROM books WHERE id = ?').get(id)) return reply.code(404).send({ error: 'Book not found' });
    const at = now();
    db.prepare(
      `INSERT INTO sleep_marks (user_id, book_id, position, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, book_id) DO UPDATE SET position = excluded.position, at = excluded.at`,
    ).run(request.user!.id, id, body.data.position, at);
    return { sleepMark: { position: body.data.position, at } };
  });

  app.delete('/api/books/:id/sleep-mark', async (request) => {
    const { id } = idParam.parse(request.params);
    db.prepare('DELETE FROM sleep_marks WHERE user_id = ? AND book_id = ?').run(request.user!.id, id);
    return { ok: true };
  });
}
