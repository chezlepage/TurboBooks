import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { requireUser } from '../lib/auth.js';
import {
  cancelConversion,
  checkEligible,
  conversionsEnabled,
  estimateFor,
  monthSpend,
  startConversion,
} from '../lib/convert/jobs.js';
import type { ConversionRow } from '../lib/convert/jobs.js';
import { listVoices, speak } from '../lib/convert/tts.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const voiceParam = z.object({ voice: z.string().regex(/^[a-z]{2}_[a-z0-9_]{1,40}$/) });
const startBody = z.object({ voice: z.string().max(60), multiVoice: z.boolean().default(false) });

/** Short original line used to preview voices. */
const SAMPLE_TEXT =
  'The lamp was low and the house was quiet. She turned the page, settled deeper into the pillows, and listened to the rain.';

const toConversion = (r: ConversionRow) => ({
  id: r.id,
  ebookId: r.ebook_id,
  title: r.title,
  voice: r.voice,
  multiVoice: r.multi_voice === 1,
  status: r.status,
  progress: r.progress,
  detail: r.detail,
  costUsd: Math.round(r.cost_usd * 100) / 100,
  audioBookId: r.audio_book_id,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function convertRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/api/convert/status', async () => {
    if (!conversionsEnabled()) return { enabled: false, reason: 'No Claude API key is set on the server' };
    try {
      await listVoices();
    } catch {
      return { enabled: false, reason: 'The voice engine (Kokoro) is not reachable' };
    }
    return { enabled: true, monthSpend: Math.round(monthSpend() * 100) / 100, budget: config.convertMonthlyBudgetUsd };
  });

  app.get('/api/convert/voices', async (_request, reply) => {
    try {
      return { voices: await listVoices() };
    } catch {
      return reply.code(503).send({ error: 'The voice engine is not reachable' });
    }
  });

  /** A few seconds of each voice, generated once and cached. */
  app.get('/api/convert/voices/:voice/sample', async (request, reply) => {
    const { voice } = voiceParam.parse(request.params);
    if (!(await listVoices().catch(() => [])).some((v) => v.id === voice)) return reply.code(404).send({ error: 'Unknown voice' });
    const file = path.join(config.dataDir, 'voice-samples', `${voice}.mp3`);
    let audio: Buffer;
    try {
      audio = await fs.readFile(file);
    } catch {
      audio = await speak(SAMPLE_TEXT, voice, 'mp3');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, audio);
    }
    return reply.header('Content-Type', 'audio/mpeg').header('Cache-Control', 'private, max-age=86400').send(audio);
  });

  app.post('/api/books/:id/convert/estimate', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ multiVoice: z.boolean().default(false) }).parse(request.body ?? {});
    const elig = checkEligible(request.user!.id, id);
    if (!elig.ok) return reply.code(400).send({ error: elig.error });
    return { estimate: await estimateFor(request.user!.id, id, body.multiVoice) };
  });

  app.post('/api/books/:id/convert', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = startBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Pick a voice' });
    try {
      return { conversion: toConversion(await startConversion(request.user!.id, id, body.data.voice, body.data.multiVoice)) };
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  /** My latest conversion of this ebook (any status), or null. */
  app.get('/api/books/:id/convert', async (request) => {
    const { id } = idParam.parse(request.params);
    const row = db
      .prepare('SELECT * FROM conversions WHERE user_id = ? AND ebook_id = ? ORDER BY id DESC LIMIT 1')
      .get(request.user!.id, id) as ConversionRow | undefined;
    return { conversion: row ? toConversion(row) : null };
  });

  app.get('/api/convert', async (request) => ({
    conversions: (
      db.prepare('SELECT * FROM conversions WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(request.user!.id) as ConversionRow[]
    ).map(toConversion),
  }));

  app.delete('/api/convert/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!(await cancelConversion(request.user!.id, id))) return reply.code(404).send({ error: 'Nothing to cancel' });
    return { ok: true };
  });
}
