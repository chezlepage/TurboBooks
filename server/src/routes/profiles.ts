import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { requireUser } from '../lib/auth.js';
import { getPrivacy, getReadingGoal } from './prefs.js';

/**
 * Profiles: what each person on this server is reading or listening to, plus their
 * reading history from outside the library (Goodreads import), ratings and yearly goal.
 *
 * Privacy: people can turn sharing off entirely, or hide individual books. Hidden books
 * are left out of everything others see, including the counts, so totals can't give
 * them away. On your own profile you always see everything, with hidden books flagged.
 * Want-to-read lists are only ever shown to their owner.
 */

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Start of the current calendar year, in ms. */
const startOfYear = () => new Date(new Date().getFullYear(), 0, 1).getTime();

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
  rating: number | null;
  note: string | null;
}

const toActivity = (r: ActivityRow, hidden?: Set<number>) => ({
  id: r.id,
  title: r.title,
  author: r.author,
  kind: r.kind,
  hasCover: r.cover_path !== null,
  /** 0..1 */
  fraction: r.finished ? 1 : r.kind === 'ebook' ? r.position : Math.min(1, r.position / Math.max(r.duration, 1)),
  finished: r.finished === 1,
  updatedAt: r.updated_at,
  rating: r.rating,
  note: r.note,
  /** Only set on your own profile: this book is hidden from others. */
  hidden: hidden?.has(r.id) ?? false,
});

interface LogRow {
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
  free_ebook_id: string | null;
  free_audio_id: string | null;
}

/** A book from outside the library (imported or added by hand). */
const toLogItem = (r: LogRow, isOwner: boolean) => ({
  id: r.id,
  title: r.title,
  author: r.author,
  isbn13: r.isbn13,
  rating: r.rating,
  review: r.review,
  dateRead: r.date_read,
  dateAdded: r.date_added,
  hidden: isOwner ? r.hidden === 1 : false,
  freeEbookId: isOwner ? r.free_ebook_id : null,
  freeAudioId: isOwner ? r.free_audio_id : null,
});

/** SQL fragment + params that leave out the given book ids. */
function excluding(ids: Set<number>): [string, number[]] {
  if (ids.size === 0) return ['', []];
  const list = [...ids];
  return [` AND b.id NOT IN (${list.map(() => '?').join(',')})`, list];
}

/** What `viewerId` may see of `ownerId`'s activity. */
function visibility(ownerId: number, viewerId: number) {
  const privacy = getPrivacy(ownerId);
  const isOwner = ownerId === viewerId;
  return {
    isOwner,
    /** Owner chose not to share anything (owners still see their own). */
    closed: !isOwner && !privacy.share,
    /** Library books to leave out for this viewer. */
    exclude: isOwner ? new Set<number>() : privacy.hidden,
    /** Books to flag as hidden (owner's view only). */
    flag: isOwner ? privacy.hidden : undefined,
    /** For shelf items: hidden ones are left out unless you're the owner. */
    hiddenShelfSql: isOwner ? '' : ' AND s.hidden = 0',
    sharing: privacy.share,
  };
}

const ACTIVITY_SELECT = `
  SELECT b.id, b.title, b.author, b.kind, b.duration, b.cover_path, p.position, p.finished, p.updated_at,
         br.rating, br.note
  FROM progress p
  JOIN books b ON b.id = p.book_id
  JOIN library_entries le ON le.book_id = p.book_id AND le.user_id = p.user_id
  LEFT JOIN book_ratings br ON br.book_id = p.book_id AND br.user_id = p.user_id
  WHERE p.user_id = ?`;

/** Started = meaningfully into the book (a few seconds of audio, or half a percent of an ebook). */
const STARTED = `(p.finished = 0 AND ((b.kind = 'audio' AND p.position > 5) OR (b.kind = 'ebook' AND p.position > 0.005)))`;

/**
 * Shelf items that count as "read" on their own: not linked to a library book (those are
 * already counted through progress), so nothing is counted twice.
 */
const OUTSIDE_READ = `s.shelf = 'read' AND s.book_id IS NULL`;

function statsFor(userId: number, exclude: Set<number>, hiddenShelfSql: string) {
  const [notIn, notInParams] = excluding(exclude);
  const yearStart = startOfYear();
  const lib = db
    .prepare(
      `SELECT
         SUM(CASE WHEN p.finished = 1 THEN 1 ELSE 0 END) AS finished,
         SUM(CASE WHEN p.finished = 1 AND p.updated_at >= ? THEN 1 ELSE 0 END) AS finishedThisYear,
         SUM(CASE WHEN ${STARTED} THEN 1 ELSE 0 END) AS inProgress,
         SUM(CASE WHEN b.kind = 'audio' THEN (CASE WHEN p.finished = 1 THEN b.duration ELSE p.position END) ELSE 0 END) AS listenedSecs
       FROM progress p
       JOIN books b ON b.id = p.book_id
       JOIN library_entries le ON le.book_id = p.book_id AND le.user_id = p.user_id
       WHERE p.user_id = ?${notIn}`,
    )
    .get(yearStart, userId, ...notInParams) as Record<string, number | null>;
  const outside = db
    .prepare(
      `SELECT COUNT(*) AS finished,
              SUM(CASE WHEN s.date_read >= ? THEN 1 ELSE 0 END) AS finishedThisYear
       FROM shelf_items s WHERE s.user_id = ? AND ${OUTSIDE_READ}${hiddenShelfSql}`,
    )
    .get(yearStart, userId) as Record<string, number | null>;
  return {
    finished: (lib.finished ?? 0) + (outside.finished ?? 0),
    finishedThisYear: (lib.finishedThisYear ?? 0) + (outside.finishedThisYear ?? 0),
    inProgress: lib.inProgress ?? 0,
    listenedHours: Math.round(((lib.listenedSecs ?? 0) / 3600) * 10) / 10,
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
        const v = visibility(u.id, request.user!.id);
        if (v.closed) {
          return { id: u.id, username: u.username, isYou: false, private: true, current: null, stats: null };
        }
        const [notIn, notInParams] = excluding(v.exclude);
        const current = db
          .prepare(`${ACTIVITY_SELECT} AND ${STARTED}${notIn} ORDER BY p.updated_at DESC LIMIT 1`)
          .get(u.id, ...notInParams) as ActivityRow | undefined;
        return {
          id: u.id,
          username: u.username,
          isYou: v.isOwner,
          private: false,
          current: current ? toActivity(current, v.flag) : null,
          stats: statsFor(u.id, v.exclude, v.hiddenShelfSql),
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
    const v = visibility(id, request.user!.id);
    const base = {
      id: user.id,
      username: user.username,
      isAdmin: user.is_admin === 1,
      isYou: v.isOwner,
      memberSince: user.created_at,
      /** Owner's own setting; only meaningful on your own profile. */
      sharing: v.isOwner ? v.sharing : undefined,
    };
    if (v.closed) {
      return {
        person: { ...base, private: true, stats: null, current: [], finished: [], readingElsewhere: [], readLog: [], want: [], goal: null },
      };
    }
    const [notIn, notInParams] = excluding(v.exclude);
    const current = db
      .prepare(`${ACTIVITY_SELECT} AND ${STARTED}${notIn} ORDER BY p.updated_at DESC LIMIT 12`)
      .all(id, ...notInParams) as ActivityRow[];
    const finished = db
      .prepare(`${ACTIVITY_SELECT} AND p.finished = 1${notIn} ORDER BY p.updated_at DESC LIMIT 30`)
      .all(id, ...notInParams) as ActivityRow[];
    const shelf = (where: string, order: string, limit: number) =>
      (
        db
          .prepare(`SELECT s.* FROM shelf_items s WHERE s.user_id = ? AND ${where}${v.hiddenShelfSql} ORDER BY ${order} LIMIT ${limit}`)
          .all(id) as LogRow[]
      ).map((r) => toLogItem(r, v.isOwner));

    const stats = statsFor(id, v.exclude, v.hiddenShelfSql);
    const year = new Date().getFullYear();
    const target = getReadingGoal(id, year);
    return {
      person: {
        ...base,
        private: false,
        stats,
        goal: target ? { year, target, done: stats.finishedThisYear } : null,
        current: current.map((r) => toActivity(r, v.flag)),
        finished: finished.map((r) => toActivity(r, v.flag)),
        /** Currently reading outside the library (e.g. imported "currently-reading"). */
        readingElsewhere: shelf(`s.shelf = 'reading' AND s.book_id IS NULL`, 's.date_added DESC', 12),
        /** Read history from outside the library, newest first. */
        readLog: shelf(OUTSIDE_READ, 'COALESCE(s.date_read, s.date_added) DESC', 60),
        /** Want-to-read: only ever shown to the owner. */
        want: v.isOwner ? shelf(`s.shelf = 'want'`, '(s.free_ebook_id IS NULL AND s.free_audio_id IS NULL), s.date_added DESC', 300) : [],
      },
    };
  });
}
