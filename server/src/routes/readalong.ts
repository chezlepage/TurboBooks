import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../lib/auth.js';
import { canAccessBook } from '../lib/library.js';
import { readAlongChapter, readAlongEnabled, readAlongStatus, startReadAlong } from '../lib/readalong/index.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const chapterParam = idParam.extend({ n: z.coerce.number().int().min(0) });

/** Read along: an audiobook's ebook text, sentence by sentence, with when each is read aloud. */
export async function readAlongRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/books/:id/readalong', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!canAccessBook(request.user!, id)) return reply.code(404).send({ error: 'Book not found' });
    if (!readAlongEnabled()) return { state: 'off' };
    return readAlongStatus(request.user!, id);
  });

  app.post('/api/books/:id/readalong', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!canAccessBook(request.user!, id)) return reply.code(404).send({ error: 'Book not found' });
    if (!readAlongEnabled()) return reply.code(400).send({ error: 'Read along is not set up on this server' });
    if (!startReadAlong(request.user!, id)) return reply.code(400).send({ error: 'There is no ebook of this book to read along with' });
    return readAlongStatus(request.user!, id);
  });

  app.get('/api/books/:id/readalong/chapters/:n', async (request, reply) => {
    const { id, n } = chapterParam.parse(request.params);
    if (!canAccessBook(request.user!, id)) return reply.code(404).send({ error: 'Book not found' });
    const chapter = await readAlongChapter(request.user!, id, n);
    if (!chapter) return reply.code(404).send({ error: 'Not ready' });
    return chapter;
  });
}
