import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { requireUser } from '../lib/auth.js';

/**
 * Profiles: what each person on this server is reading or listening to.
 * Everyone signed in can see everyone's activity (it's a household server).
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

interface ActivityRow {
  id: number;
  title: string;
  author: string | null;
  kind: 'audio' | 'ebook';
  duration: number;
  cover_path: string | null;
  position: number;
  finished: number;
  updated_at: number;
}

const toActivity = (r: ActivityRow) => ({
  id: r.id,
  title: r.title,
  author: r.author,
  kind: r.kind,
  hasCover: r.cover_path !== null,
  /** 0..1 */
  fraction: r.finished ? 1 : r.kind === 'ebook' ? r.position : Math.min(1, r.position / Math.max(r.duration, 1)),
  finished: r.finished === 1,
  updatedAt: r.updated_at,
});

const ACTIVITY_SELECT = `
  SELECT b.id, b.title, b.author, b.kind, b.duration, b.cover_path, p.position, p.finished, p.updated_at
  FROM progress p JOIN books b ON b.id = p.book_id
  WHERE p.user_id = ?`;

/** Started = meaningfully into the book (a few seconds of audio, or half a percent of an ebook). */
const STARTED = `(p.finished = 0 AND ((b.kind = 'audio' AND p.position > 5) OR (b.kind = 'ebook' AND p.position > 0.005)))`;

function statsFor(userId: number) {
  const s = db
    .prepare(
      `SELECT
         SUM(CASE WHEN p.finished = 1 THEN 1 ELSE 0 END) AS finished,
         SUM(CASE WHEN p.finished = 1 AND p.updated_at > ? THEN 1 ELSE 0 END) AS finishedThisYear,
         SUM(CASE WHEN ${STARTED} THEN 1 ELSE 0 END) AS inProgress,
         SUM(CASE WHEN b.kind = 'audio' THEN (CASE WHEN p.finished = 1 THEN b.duration ELSE p.position END) ELSE 0 END) AS listenedSecs
       FROM progress p JOIN books b ON b.id = p.book_id
       WHERE p.user_id = ?`,
    )
    .get(Date.now() - YEAR_MS, userId) as Record<string, number | null>;
  return {
    finished: s.finished ?? 0,
    finishedThisYear: s.finishedThisYear ?? 0,
    inProgress: s.inProgress ?? 0,
    listenedHours: Math.round(((s.listenedSecs ?? 0) / 3600) * 10) / 10,
  };
}

export async function profileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  /** Everyone on the server, with what they're on right now. */
  app.get('/api/people', async (request) => {
    const users = db.prepare('SELECT id, username FROM users ORDER BY username COLLATE NOCASE').all() as {
      id: number;
      username: string;
    }[];
    return {
      people: users.map((u) => {
        const current = db.prepare(`${ACTIVITY_SELECT} AND ${STARTED} ORDER BY p.updated_at DESC LIMIT 1`).get(u.id) as
          | ActivityRow
          | undefined;
        return {
          id: u.id,
          username: u.username,
          isYou: u.id === request.user!.id,
          current: current ? toActivity(current) : null,
          stats: statsFor(u.id),
        };
      }),
    };
  });

  app.get('/api/people/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const user = db.prepare('SELECT id, username, is_admin, created_at FROM users WHERE id = ?').get(id) as
      | { id: number; username: string; is_admin: number; created_at: number }
      | undefined;
    if (!user) return reply.code(404).send({ error: 'Person not found' });
    const current = db.prepare(`${ACTIVITY_SELECT} AND ${STARTED} ORDER BY p.updated_at DESC LIMIT 12`).all(id) as ActivityRow[];
    const finished = db.prepare(`${ACTIVITY_SELECT} AND p.finished = 1 ORDER BY p.updated_at DESC LIMIT 30`).all(id) as ActivityRow[];
    return {
      person: {
        id: user.id,
        username: user.username,
        isAdmin: user.is_admin === 1,
        isYou: user.id === request.user!.id,
        memberSince: user.created_at,
        stats: statsFor(id),
        current: current.map(toActivity),
        finished: finished.map(toActivity),
      },
    };
  });
}
