import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import * as archive from '../lib/archive.js';
import { requireUser } from '../lib/auth.js';
import * as gutenberg from '../lib/gutenberg.js';
import * as pdcomics from '../lib/pdcomics.js';
import { dismissImport, enqueueImport, retryImport } from '../lib/imports.js';

/** Each kind of book comes from its own free catalog. */
const CATALOGS = {
  audio: {
    source: archive.SOURCE,
    name: 'The Internet Archive',
    categories: archive.CATEGORIES,
    search: archive.search,
    isValidId: archive.isValidIdentifier,
  },
  ebook: {
    source: gutenberg.SOURCE,
    name: 'Project Gutenberg',
    categories: gutenberg.CATEGORIES,
    search: gutenberg.search,
    isValidId: gutenberg.isValidGutenbergId,
  },
  comic: {
    source: pdcomics.SOURCE,
    name: 'The Internet Archive',
    categories: pdcomics.CATEGORIES,
    search: pdcomics.search,
    isValidId: pdcomics.isValidId,
  },
} as const;

const kindSchema = z.enum(['audio', 'ebook', 'comic']).default('audio');

const searchQuery = z
  .object({
    kind: kindSchema,
    q: z.string().trim().max(100).optional(),
    category: z.string().optional(),
    english: z.enum(['0', '1']).default('1'),
    page: z.coerce.number().int().min(0).max(50).default(0),
  })
  .refine((v) => (v.q && v.q.length >= 2) || (v.category && v.category in CATALOGS[v.kind].categories), {
    message: 'Type at least 2 characters',
  });

const importBody = z
  .object({
    kind: kindSchema,
    id: z.string().max(100),
    title: z.string().max(300).default('Untitled'),
  })
  .refine((v) => CATALOGS[v.kind].isValidId(v.id));

const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function discoverRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get(
    '/api/discover/search',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = searchQuery.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'Type at least 2 characters' });
      const { kind, q, category, english, page } = query.data;
      const catalog = CATALOGS[kind];
      try {
        return await catalog.search({
          userId: request.user!.id,
          text: q || undefined,
          category: q ? undefined : category,
          english: english === '1',
          page,
        });
      } catch (err) {
        request.log.warn(err, `${catalog.name} search failed`);
        return reply.code(503).send({ error: `${catalog.name} is not responding, try again in a bit` });
      }
    },
  );

  app.get('/api/discover/categories', async (request) => {
    const kind = kindSchema.catch('audio').parse((request.query as { kind?: string }).kind);
    return {
      categories: Object.entries(CATALOGS[kind].categories).map(([id, c]) => ({ id, label: c.label })),
    };
  });

  app.post('/api/discover/import', async (request, reply) => {
    const body = importBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid book id' });
    // { bookId } when the book was already on the server (added instantly), else { importId }.
    return enqueueImport(CATALOGS[body.data.kind].source, body.data.id, body.data.title, request.user!.id);
  });

  /** My downloads only (including ones I'm waiting on that someone else started). */
  app.get('/api/imports', async (request) => ({
    imports: db
      .prepare(
        `SELECT i.id, i.source, i.source_id AS sourceId, i.title, i.status, i.progress, i.error, i.book_id AS bookId,
                i.created_at AS createdAt, i.updated_at AS updatedAt
         FROM imports i JOIN import_waiters w ON w.import_id = i.id AND w.user_id = ?
         ORDER BY i.id DESC LIMIT 30`,
      )
      .all(request.user!.id),
  }));

  app.post('/api/imports/:id/retry', async (request) => {
    const { id } = idParam.parse(request.params);
    retryImport(id, request.user!.id);
    return { ok: true };
  });

  app.delete('/api/imports/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    dismissImport(id, request.user!.id);
    return { ok: true };
  });
}
