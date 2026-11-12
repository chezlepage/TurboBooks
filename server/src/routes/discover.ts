import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { requireUser } from '../lib/auth.js';
import { enqueueImport, isValidIdentifier, retryImport, search } from '../lib/archive.js';

const searchQuery = z.object({ q: z.string().trim().min(2).max(100) });
const importBody = z.object({
  id: z.string().refine(isValidIdentifier),
  title: z.string().max(300).default('Audiobook'),
});
const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function discoverRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get(
    '/api/discover/search',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = searchQuery.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'Type at least 2 characters' });
      try {
        return { results: await search(query.data.q) };
      } catch (err) {
        request.log.warn(err, 'Internet Archive search failed');
        return reply.code(502).send({ error: 'The Internet Archive is not responding, try again in a bit' });
      }
    },
  );

  app.post('/api/discover/import', async (request, reply) => {
    const body = importBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid book id' });
    const id = enqueueImport(body.data.id, body.data.title, request.user!.id);
    return { importId: id };
  });

  app.get('/api/imports', async () => ({
    imports: db
      .prepare(
        `SELECT id, source, source_id AS sourceId, title, status, progress, error, book_id AS bookId,
                created_at AS createdAt, updated_at AS updatedAt
         FROM imports ORDER BY id DESC LIMIT 30`,
      )
      .all(),
  }));

  app.post('/api/imports/:id/retry', async (request) => {
    const { id } = idParam.parse(request.params);
    retryImport(id);
    return { ok: true };
  });

  app.delete('/api/imports/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    db.prepare("DELETE FROM imports WHERE id = ? AND status IN ('done', 'failed')").run(id);
    return { ok: true };
  });
}
