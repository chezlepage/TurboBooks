import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config.js';
import { db } from './db.js';
import { createUser, purgeExpiredSessions } from './lib/auth.js';
import { resumeImports } from './lib/archive.js';
import { scanLibrary } from './lib/scanner.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { bookRoutes } from './routes/books.js';
import { discoverRoutes } from './routes/discover.js';
import { prefsRoutes } from './routes/prefs.js';

const app = Fastify({
  trustProxy: config.trustProxy,
  // Request logs are at "info"; audio streaming makes many range requests, so default to "warn".
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  bodyLimit: 64 * 1024,
});

await app.register(cookie);
await app.register(rateLimit, {
  global: false,
  // Behind a Cloudflare Tunnel the real client IP arrives in CF-Connecting-IP.
  keyGenerator: (request) => (request.headers['cf-connecting-ip'] as string | undefined) ?? request.ip,
});

app.addHook('onSend', async (_request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: 'Invalid request' });
  const err = error as { statusCode?: number; message?: string };
  if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
  request.log.error(error);
  return reply.code(500).send({ error: 'Something went wrong' });
});

app.get('/api/health', async () => ({ ok: true }));

await app.register(authRoutes);
await app.register(bookRoutes);
await app.register(adminRoutes);
await app.register(discoverRoutes);
await app.register(prefsRoutes);

// Serve the built web app, with SPA fallback to index.html.
const hasWeb = fs.existsSync(path.join(config.webDir, 'index.html'));
if (hasWeb) {
  await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
}
app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/') || !hasWeb || request.method !== 'GET') {
    return reply.code(404).send({ error: 'Not found' });
  }
  return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
});

// First run: create the admin from env vars if there are no users yet.
const userCount = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
if (userCount === 0) {
  if (config.adminUsername && config.adminPassword) {
    await createUser(config.adminUsername, config.adminPassword, true);
    console.log(`Created admin user "${config.adminUsername}"`);
  } else {
    app.log.warn('No users exist. Set ADMIN_USERNAME and ADMIN_PASSWORD, or run: npm run create-user -- <name> --admin');
  }
}

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();

await app.listen({ port: config.port, host: config.host });
console.log(`TurboBooks listening on ${config.host}:${config.port}`);

void scanLibrary().then(resumeImports);
if (config.scanIntervalMinutes > 0) {
  setInterval(() => void scanLibrary(), config.scanIntervalMinutes * 60 * 1000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
