import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../lib/auth.js';
import * as shelfarr from '../lib/shelfarr.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const createBody = z.object({
  workId: z.string().min(1).max(200),
  bookType: z.enum(['audiobook', 'ebook']),
  title: z.string().max(300),
  author: z.string().max(300).nullish(),
  coverUrl: z.string().url().max(1000).nullish(),
  year: z.union([z.number(), z.string().max(10)]).nullish(),
});

export async function requestRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  // Turn Shelfarr failures into clean messages for the UI.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof shelfarr.ShelfarrError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request' });
    throw error;
  });

  app.get('/api/wishlist/status', async () => ({ enabled: shelfarr.shelfarrEnabled() }));

  app.get(
    '/api/wishlist/search',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(request.query);
      const { results } = await shelfarr.search(q);
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

  app.get('/api/wishlist', async () => {
    const { requests } = await shelfarr.listRequests();
    return {
      requests: requests
        .filter((r) => r.request.external_source === 'turbobooks')
        .map((r) => ({
          id: r.id,
          status: r.status,
          needsAttention: r.attention_needed,
          issue: r.issue_description,
          title: r.book.title,
          author: r.book.author,
          bookType: r.book.book_type,
          createdAt: r.created_at,
        })),
    };
  });

  app.post(
    '/api/wishlist',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const b = createBody.parse(request.body);
      const res = await shelfarr.createRequest({
        work_id: b.workId,
        book_type: b.bookType,
        title: b.title,
        author: b.author ?? undefined,
        cover_url: b.coverUrl ?? undefined,
        year: b.year ?? undefined,
        external_user_id: String(request.user!.id),
      });
      if (res.errors?.length) return reply.code(422).send({ error: res.errors.join(', ') });
      return { ok: true };
    },
  );

  app.post('/api/wishlist/:id/retry', async (request) => {
    await shelfarr.retryRequest(idParam.parse(request.params).id);
    return { ok: true };
  });

  app.delete('/api/wishlist/:id', async (request) => {
    await shelfarr.cancelRequest(idParam.parse(request.params).id);
    return { ok: true };
  });
}
