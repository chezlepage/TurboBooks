import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { requireUser } from '../lib/auth.js';
import type { User } from '../lib/auth.js';
import { addToLibrary } from '../lib/library.js';
import { claimExisting, findExistingBook } from '../lib/requested.js';
import * as shelfarr from '../lib/shelfarr.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const createBody = z.object({
  workId: z.string().min(1).max(200),
  bookType: z.enum(['audiobook', 'ebook']),
  title: z.string().max(300),
  author: z.string().max(300).nullish(),
  coverUrl: z.string().url().max(1000).nullish(),
  year: z.union([z.number(), z.string().max(10)]).nullish(),
  /** Language to find copies in. Omitted: Shelfarr's default language. */
  language: z.enum(shelfarr.LANGUAGE_CODES).optional(),
});

interface OwnerRow {
  request_id: number;
  user_id: number;
  work_id: string;
  book_type: string;
  title: string;
  author: string | null;
  dismissed: number;
  book_id: number | null;
  language: string | null;
}

const getOwner = (requestId: number) =>
  db.prepare('SELECT * FROM request_owners WHERE request_id = ?').get(requestId) as OwnerRow | undefined;

const ownerRows = () =>
  new Map((db.prepare('SELECT * FROM request_owners').all() as OwnerRow[]).map((o) => [o.request_id, o]));

/**
 * Whether this user sees a Shelfarr request: their own, or (admins only) older requests
 * made before TurboBooks recorded who asked.
 */
const visibleTo = (user: User, owner: OwnerRow | undefined) => (owner ? owner.user_id === user.id : user.isAdmin);

/** A TurboBooks request this user may manage (the token can see all of Shelfarr's). */
async function ownRequest(id: number, user: User): Promise<shelfarr.ShelfarrRequest> {
  const { requests } = await shelfarr.listRequests();
  const found = requests.find((r) => r.id === id && r.request.external_source === 'turbobooks');
  if (!found || !visibleTo(user, getOwner(id))) throw new shelfarr.ShelfarrError('Request not found', 404);
  return found;
}

interface RequestInfo {
  workId: string;
  bookType: string;
  title: string;
  author?: string | null;
  language?: string | null;
}

function recordOwner(requestId: number, userId: number, b: RequestInfo, dismissed = false) {
  db.prepare(
    `INSERT OR REPLACE INTO request_owners (request_id, user_id, work_id, book_type, title, author, language, created_at, dismissed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(requestId, userId, b.workId, b.bookType, b.title, b.author ?? null, b.language ?? null, Date.now(), dismissed ? 1 : 0);
}

/** Hide a request from its owner's list. Older requests with no owner row get one, owned by whoever dismissed them. */
function dismiss(req: shelfarr.ShelfarrRequest, userId: number) {
  const updated = db.prepare('UPDATE request_owners SET dismissed = 1 WHERE request_id = ?').run(req.id);
  if (updated.changes === 0) {
    const info = { workId: req.book.work_id ?? '', bookType: req.book.book_type, title: req.book.title, author: req.book.author };
    recordOwner(req.id, userId, info, true);
  }
}

/**
 * Pasted titles carry typographic punctuation (Neighbor’s, “Quotes”, en dashes) that book
 * databases don't match: Open Library finds nothing for "Her Neighbor’s Wife: …" but finds
 * it with a plain apostrophe. Straighten it before searching.
 */
export function normalizeQuery(q: string): string {
  return q
    .normalize('NFKC')
    .replace(/[‘’‚‛′ʼ`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/** Statuses where Shelfarr has nothing left to stop. */
const SETTLED = ['completed', 'failed', 'not_found'];

/** Creates the request in Shelfarr. Duplicate/validation problems come back as `errors`, not a throw. */
async function createInShelfarr(b: RequestInfo & { coverUrl?: string | null; year?: number | string | null }, userId: number) {
  try {
    return await shelfarr.createRequest({
      work_id: b.workId,
      book_type: b.bookType,
      title: b.title,
      author: b.author ?? undefined,
      cover_url: b.coverUrl ?? undefined,
      year: b.year ?? undefined,
      // English is left unset, as before the language picker existed: Shelfarr then uses its own
      // default, which may filter less (an explicit language also filters Z-Library/Anna's Archive
      // by their language tag, and self-published books are often untagged).
      language: b.language && b.language !== 'en' ? b.language : undefined,
      external_user_id: String(userId),
    });
  } catch (err) {
    if (err instanceof shelfarr.ShelfarrError && err.status === 422) return { requests: [], errors: [err.message], warnings: [] };
    throw err;
  }
}

export async function requestRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // Turn Shelfarr failures into clean messages for the UI.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof shelfarr.ShelfarrError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request' });
    throw error;
  });

  app.get('/api/wishlist/status', async () => ({
    enabled: shelfarr.shelfarrEnabled(),
    languages: shelfarr.BOOK_LANGUAGES.map(({ code, name }) => ({ code, name })),
  }));

  app.get(
    '/api/wishlist/search',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { q } = z.object({ q: z.string().trim().min(2).max(200) }).parse(request.query);
      const query = normalizeQuery(q);
      let { results } = await shelfarr.search(query);
      // Long "Title: Subtitle" searches often match nothing; retry with just the title.
      const short = query.split(/\s*[:–—]\s+|\s+-\s+/)[0];
      if (results.length === 0 && short.length >= 2 && short !== query) ({ results } = await shelfarr.search(short));
      return {
        results: results.map((r) => ({
          workId: r.work_id,
          title: r.title,
          author: r.author,
          year: r.year,
          coverUrl: r.cover_url,
          series: r.series_name ?? null,
        })),
      };
    },
  );

  app.get('/api/wishlist/editions', async (request) => {
    const { workId, lang } = z
      .object({ workId: z.string().max(100), lang: z.enum(shelfarr.LANGUAGE_CODES).default('en') })
      .parse(request.query);
    const list = await shelfarr.editions(workId, lang);
    return {
      editions: list.map((e) => ({
        thumbUrl: `https://covers.openlibrary.org/b/id/${e.coverId}-M.jpg`,
        coverUrl: `https://covers.openlibrary.org/b/id/${e.coverId}-L.jpg`,
        year: e.year,
        publisher: e.publisher,
        format: e.format,
      })),
    };
  });

  /** The signed-in user's own requests (admins also see older requests that have no recorded owner). */
  app.get('/api/wishlist', async (request) => {
    const user = request.user!;
    const { requests } = await shelfarr.listRequests();
    const owners = ownerRows();
    const covers = new Map(
      (db.prepare('SELECT request_id AS id, cover_url AS url FROM request_covers').all() as Array<{ id: number; url: string }>).map(
        (c) => [c.id, c.url],
      ),
    );
    return {
      requests: requests
        .filter((r) => {
          if (r.request.external_source !== 'turbobooks') return false;
          const owner = owners.get(r.id);
          return visibleTo(user, owner) && !owner?.dismissed;
        })
        .map((r) => {
          const owner = owners.get(r.id);
          // Delivered: the book now in the requester's library (linked by the scanner, or found now).
          const bookId = owner && r.status === 'completed' ? (owner.book_id ?? claimExisting(r.id)) : null;
          return {
            id: r.id,
            status: r.status,
            needsAttention: r.attention_needed,
            issue: r.issue_description,
            title: r.book.title,
            author: r.book.author,
            bookType: r.book.book_type,
            coverUrl: covers.get(r.id) ?? null,
            createdAt: r.created_at,
            language: owner?.language ?? null,
            bookId,
          };
        }),
    };
  });

  app.post(
    '/api/wishlist',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const b = createBody.parse(request.body);
      const userId = request.user!.id;
      const res = await createInShelfarr(b, userId);
      if (res.errors?.length) {
        // Shelfarr already has it (e.g. someone else requested it). If it's on this server, add it to this user's library.
        if (res.errors.some((e) => /already in your library/i.test(e))) {
          const bookId = findExistingBook(b.bookType, b.title, b.author ?? null);
          if (bookId) {
            addToLibrary(userId, bookId);
            return { ok: true, addedToLibrary: bookId };
          }
        }
        return reply.code(422).send({ error: res.errors.join(', ') });
      }
      for (const created of res.requests) recordOwner(created.id, userId, b);
      if (b.coverUrl) {
        const save = db.prepare('INSERT OR REPLACE INTO request_covers (request_id, cover_url) VALUES (?, ?)');
        for (const created of res.requests) save.run(created.id, b.coverUrl);
      }
      return { ok: true };
    },
  );

  app.get('/api/wishlist/:id/releases', async (request) => {
    const { id } = idParam.parse(request.params);
    await ownRequest(id, request.user!);
    const { search_results } = await shelfarr.releases(id);
    return {
      releases: search_results
        .filter((r) => r.downloadable && !r.blocklisted)
        // Dead torrents (0 seeders) last; otherwise best match first, then most seeded.
        // Direct downloads have no seeder count (null) and are never treated as dead.
        .sort(
          (x, y) =>
            Number(x.seeders === 0) - Number(y.seeders === 0) ||
            (y.confidence_score ?? 0) - (x.confidence_score ?? 0) ||
            (y.seeders ?? 0) - (x.seeders ?? 0),
        )
        .map((r) => ({
          id: r.id,
          title: r.title,
          source: r.indexer ?? r.source,
          // Torrents/Usenet come through Prowlarr; Z-Library, Anna's Archive etc. are plain file downloads.
          direct: r.source !== 'prowlarr',
          seeders: r.seeders,
          sizeBytes: r.size_bytes,
          confidence: r.confidence_score,
          language: r.detected_language,
        })),
    };
  });

  app.post('/api/wishlist/:id/grab', async (request) => {
    const { id } = idParam.parse(request.params);
    const { releaseId } = z.object({ releaseId: z.number().int().positive() }).parse(request.body);
    await ownRequest(id, request.user!);
    await shelfarr.grabRelease(id, releaseId);
    return { ok: true };
  });

  app.post('/api/wishlist/:id/retry', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const user = request.user!;
    const req = await ownRequest(id, user);
    try {
      await shelfarr.retryRequest(id);
      return { ok: true };
    } catch (err) {
      // Retrying needs Shelfarr's admin scope. Without it, make a fresh request for the same book instead.
      if (!(err instanceof shelfarr.ShelfarrError) || err.upstream !== 403) throw err;
    }
    const owner = getOwner(id);
    const workId = owner?.work_id || req.book.work_id;
    if (!workId) {
      return reply.code(422).send({ error: 'This request is too old to retry. Search for the book and request it again.' });
    }
    const fresh = {
      workId,
      bookType: req.book.book_type,
      title: req.book.title,
      author: req.book.author,
      language: owner?.language ?? null,
    };
    const res = await createInShelfarr(fresh, user.id);
    if (res.errors?.length) return reply.code(422).send({ error: res.errors.join(', ') });
    const cover = db.prepare('SELECT cover_url FROM request_covers WHERE request_id = ?').get(id) as { cover_url: string } | undefined;
    for (const created of res.requests) {
      recordOwner(created.id, user.id, fresh);
      if (cover) db.prepare('INSERT OR REPLACE INTO request_covers (request_id, cover_url) VALUES (?, ?)').run(created.id, cover.cover_url);
    }
    dismiss(req, user.id);
    return { ok: true };
  });

  /** Cancel (if still running) and remove from the list. Shelfarr marks cancelled requests "failed", so hide them here. */
  app.delete('/api/wishlist/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const user = request.user!;
    const req = await ownRequest(id, user);
    if (!SETTLED.includes(req.status)) await shelfarr.cancelRequest(id);
    dismiss(req, user.id);
    return { ok: true };
  });
}
