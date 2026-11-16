import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db, setSetting } from '../db.js';
import { availableApps } from '../lib/apps.js';
import { checkToken, shelfarrEnabled } from '../lib/shelfarr.js';
import { conversionsEnabled, monthSpend, userBudget } from '../lib/convert/jobs.js';
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

const tokenBody = z.object({ token: z.string().trim().max(512) });
const budgetBody = z.object({ usd: z.number().min(0).max(100_000) });

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);
  app.addHook('preHandler', requireAdmin);

  /** What the Settings → Requests card shows: the app pages, and whether TurboBooks reaches Shelfarr. */
  app.get('/api/admin/requests', async () => ({
    apps: availableApps(),
    shelfarr: {
      configured: Boolean(config.shelfarrUrl),
      connected: shelfarrEnabled(),
      tokenInEnv: Boolean(config.shelfarrToken),
    },
  }));

  /** Save (or with an empty token, remove) the Shelfarr API token, after checking that it works. */
  app.put('/api/admin/requests/token', async (request, reply) => {
    if (config.shelfarrToken) return reply.code(409).send({ error: 'The token is set in .env; change it there.' });
    const { token } = tokenBody.parse(request.body);
    if (!token) {
      setSetting('shelfarr_token', null);
      return { connected: false };
    }
    if (!/^shf_[\w-]{16,}$/.test(token)) {
      return reply.code(400).send({
        error: "That doesn't look like a Shelfarr token. It starts with shf_ and is shown once, right after you create it.",
      });
    }
    const check = await checkToken(token);
    if (check === 'bad-token') {
      return reply.code(400).send({ error: "Shelfarr didn't accept that token. Create a new one and paste it right away." });
    }
    if (check === 'unreachable') return reply.code(503).send({ error: "Can't reach Shelfarr right now. Is it running?" });
    setSetting('shelfarr_token', token);
    return { connected: true };
  });

  app.get('/api/admin/users', async () => {
    const rows = db.prepare('SELECT id, username, is_admin AS isAdmin, created_at AS createdAt FROM users ORDER BY id').all() as {
      id: number;
      username: string;
      isAdmin: number;
      createdAt: number;
    }[];
    const convert = conversionsEnabled();
    return {
      // Claude spend for making audiobooks, shown only when that's set up.
      convertEnabled: convert,
      users: rows.map((u) => ({
        ...u,
        isAdmin: u.isAdmin === 1,
        ...(convert ? { convertBudget: userBudget(u.id), convertSpent: Math.round(monthSpend(u.id) * 100) / 100 } : {}),
      })),
    };
  });

  /** Someone's monthly Claude budget for making audiobooks. */
  app.put('/api/admin/users/:id/budget', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = budgetBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Enter an amount in dollars' });
    const res = db.prepare('UPDATE users SET convert_budget_usd = ? WHERE id = ?').run(body.data.usd, id);
    if (res.changes === 0) return reply.code(404).send({ error: 'User not found' });
    return { ok: true };
  });

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
