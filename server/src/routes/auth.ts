import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  checkCredentials,
  endSession,
  requireUser,
  revokeSessions,
  setPassword,
  startSession,
} from '../lib/auth.js';

const loginBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(256),
});

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = loginBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'Username and password required' });
      const user = await checkCredentials(body.data.username, body.data.password);
      if (!user) return reply.code(401).send({ error: 'Wrong username or password' });
      startSession(reply, user.id);
      return { user };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    endSession(request, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (request) => ({ user: request.user }));

  app.post(
    '/api/auth/password',
    { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = passwordBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Invalid input' });
      const user = request.user!;
      const ok = await checkCredentials(user.username, body.data.currentPassword);
      if (!ok) return reply.code(401).send({ error: 'Current password is wrong' });
      await setPassword(user.id, body.data.newPassword);
      // Log out every other device.
      revokeSessions(user.id, request.cookies[SESSION_COOKIE]);
      return { ok: true };
    },
  );
}
