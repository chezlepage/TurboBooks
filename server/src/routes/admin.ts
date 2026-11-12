import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db.js';
import { createUser, requireAdmin, requireUser, revokeSessions, setPassword } from '../lib/auth.js';
import { isScanning, scanLibrary } from '../lib/scanner.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const newUserBody = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\w.@-]+$/, 'Username can only contain letters, numbers, and . _ @ -'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(256),
  isAdmin: z.boolean().default(false),
});

const resetBody = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters').max(256),
});

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);
  app.addHook('preHandler', requireAdmin);

  app.get('/api/admin/users', async () => ({
    users: db
      .prepare('SELECT id, username, is_admin AS isAdmin, created_at AS createdAt FROM users ORDER BY id')
      .all()
      .map((u) => ({ ...(u as object), isAdmin: (u as { isAdmin: number }).isAdmin === 1 })),
  }));

  app.post('/api/admin/users', async (request, reply) => {
    const body = newUserBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Invalid input' });
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(body.data.username);
    if (exists) return reply.code(409).send({ error: 'That username is taken' });
    const user = await createUser(body.data.username, body.data.password, body.data.isAdmin);
    return { user };
  });

  app.post('/api/admin/users/:id/password', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = resetBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Invalid input' });
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return reply.code(404).send({ error: 'User not found' });
    await setPassword(id, body.data.password);
    if (id !== request.user!.id) revokeSessions(id);
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (id === request.user!.id) return reply.code(400).send({ error: "You can't delete yourself" });
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  });

  app.get('/api/admin/scan', async () => ({ scanning: isScanning() }));

  app.post('/api/admin/scan', async () => {
    const result = await scanLibrary();
    return { result };
  });
}
