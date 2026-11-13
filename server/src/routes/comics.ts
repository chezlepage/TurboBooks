import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { requireUser } from '../lib/auth.js';
import { comicPage, isComicPath, openComic } from '../lib/comic.js';
import { canAccessBook } from '../lib/library.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const pageParam = idParam.extend({ n: z.coerce.number().int().min(0).max(100_000) });

const comicPath = (id: number) => {
  const row = db.prepare("SELECT path FROM books WHERE id = ? AND kind = 'ebook'").get(id) as { path: string } | undefined;
  return row && isComicPath(row.path) ? row.path : null;
};

/** Comics, manga and webtoons (.cbz/.cbr): page list, then one image per request. */
export async function comicRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/books/:id/comic', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const file = canAccessBook(request.user!, id) ? comicPath(id) : null;
    if (!file) return reply.code(404).send({ error: 'Comic not found' });
    try {
      const c = await openComic(file);
      return {
        version: c.version,
        pages: c.pages.map((p) => [p.w, p.h]),
        direction: c.direction,
        layout: c.layout,
      };
    } catch (err) {
      request.log.warn({ err }, 'comic open failed');
      return reply.code(422).send({ error: err instanceof Error ? err.message : "This comic couldn't be opened" });
    }
  });

  app.get('/api/books/:id/comic/pages/:n', async (request, reply) => {
    const { id, n } = pageParam.parse(request.params);
    const file = canAccessBook(request.user!, id) ? comicPath(id) : null;
    if (!file) return reply.code(404).send({ error: 'Comic not found' });
    const page = await comicPage(file, n).catch(() => null);
    if (!page) return reply.code(404).send({ error: 'Page not found' });
    return reply
      .header('Content-Type', page.type)
      .header('X-Content-Type-Options', 'nosniff')
      // The URL carries the file version (?v=), so a page can be cached for good.
      .header('Cache-Control', 'private, max-age=604800, immutable')
      .send(Buffer.from(page.data.buffer, page.data.byteOffset, page.data.byteLength));
  });
}
