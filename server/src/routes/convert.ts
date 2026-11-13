import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { requireUser } from '../lib/auth.js';
import {
  cancelConversion,
  changeVoice,
  castFor,
  castReady,
  checkEligible,
  conversionsEnabled,
  estimateFor,
  heardVoices,
  monthSpend,
  setVoiceMap,
  startConversion,
} from '../lib/convert/jobs.js';
import type { ConversionRow } from '../lib/convert/jobs.js';
import { listVoices, recipeVoice, speak, speakWith } from '../lib/convert/tts.js';
import type { MixPart, Voice } from '../lib/convert/tts.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const voiceParam = z.object({ voice: z.string().regex(/^[a-z]{2}_[a-z0-9_]{1,40}$/) });
const startBody = z.object({
  voice: z.string().max(60),
  multiVoice: z.boolean().default(false),
  voiceMode: z.enum(['auto', 'manual']).default('auto'),
});
const changeBody = z.object({ part: z.string().max(200), voice: z.string().max(60), position: z.number().min(0).default(0) });
const picksBody = z.object({ voices: z.record(z.string().max(200), z.string().max(60)) });
/** A voice recipe: 1-3 different Kokoro voices with shares 1-9, read a little slower or faster. */
const recipeBody = z.object({
  parts: z
    .array(z.object({ voice: z.string().regex(/^[a-z]{2}_[a-z]{1,30}$/), weight: z.number().int().min(1).max(9) }))
    .min(1)
    .max(3)
    .refine((ps) => new Set(ps.map((p) => p.voice)).size === ps.length, 'Each voice can only be used once'),
  speed: z.number().min(0.8).max(1.25).transform((n) => Math.round(n * 20) / 20),
});
const customBody = recipeBody.extend({
  name: z.string().trim().min(1).max(40),
  gender: z.enum(['female', 'male']),
});
const MAX_CUSTOM_PER_USER = 40;

/** Recipes may only use Kokoro's own voices (not blends or other custom voices). */
async function checkParts(parts: MixPart[]): Promise<string | null> {
  const base = new Map((await listVoices()).filter((v) => v.kind === 'voice' || v.kind === 'accent').map((v) => [v.id, v]));
  const bad = parts.find((p) => !base.has(p.voice));
  return bad ? `Unknown voice: ${bad.voice}` : null;
}

const forClient = (v: Voice, userId: number, isAdmin: boolean) =>
  v.kind === 'custom' ? { ...v, mine: v.owner?.id === userId, canDelete: v.owner?.id === userId || isAdmin } : v;

/** Short original line used to preview voices. */
const SAMPLE_TEXT =
  'The lamp was low and the house was quiet. She turned the page, settled deeper into the pillows, and listened to the rain.';

const toConversion = (r: ConversionRow) => ({
  id: r.id,
  ebookId: r.ebook_id,
  title: r.title,
  voice: r.voice,
  multiVoice: r.multi_voice === 1,
  voiceMode: r.voice_mode,
  castReady: castReady(r),
  voicesPicked: r.voice_map !== null,
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

  app.get('/api/convert/voices', async (request, reply) => {
    try {
      return { voices: (await listVoices()).map((v) => forClient(v, request.user!.id, request.user!.isAdmin)) };
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

  /** Hear a mix before saving it. Not cached; rate-limited (it uses the shared GPU). */
  app.post('/api/convert/voices/preview', { config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (request, reply) => {
    const body = recipeBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Invalid mix' });
    const bad = await checkParts(body.data.parts).catch(() => 'The voice engine is not reachable');
    if (bad) return reply.code(400).send({ error: bad });
    const audio = await speakWith(SAMPLE_TEXT, recipeVoice(body.data.parts, body.data.speed), 'mp3');
    return reply.header('Content-Type', 'audio/mpeg').header('Cache-Control', 'no-store').send(audio);
  });

  /** Save a mix as a voice everyone here can pick. Its recipe never changes afterwards. */
  app.post('/api/convert/custom-voices', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (request, reply) => {
    const body = customBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Invalid voice' });
    const bad = await checkParts(body.data.parts).catch(() => 'The voice engine is not reachable');
    if (bad) return reply.code(400).send({ error: bad });
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM custom_voices WHERE user_id = ? AND deleted_at IS NULL').get(request.user!.id) as { n: number }
    ).n;
    if (count >= MAX_CUSTOM_PER_USER) return reply.code(400).send({ error: `You can keep up to ${MAX_CUSTOM_PER_USER} voices. Delete one first.` });
    const { lastInsertRowid } = db
      .prepare('INSERT INTO custom_voices (user_id, name, gender, parts, speed, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(request.user!.id, body.data.name, body.data.gender, JSON.stringify(body.data.parts), body.data.speed, Date.now());
    const voice = (await listVoices()).find((v) => v.id === `cv_${lastInsertRowid}`)!;
    return { voice: forClient(voice, request.user!.id, request.user!.isAdmin) };
  });

  /**
   * Hide a mixed voice from the pickers (its maker or an admin). Books that already use it keep
   * it, including when a chapter is re-recorded.
   */
  app.delete('/api/convert/custom-voices/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const row = db.prepare('SELECT user_id FROM custom_voices WHERE id = ? AND deleted_at IS NULL').get(id) as { user_id: number } | undefined;
    if (!row) return reply.code(404).send({ error: 'Voice not found' });
    if (row.user_id !== request.user!.id && !request.user!.isAdmin) return reply.code(403).send({ error: 'Only whoever made this voice can delete it' });
    db.prepare('UPDATE custom_voices SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
    return { ok: true };
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
      return { conversion: toConversion(await startConversion(request.user!.id, id, body.data.voice, body.data.multiVoice, body.data.voiceMode)) };
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

  /** Manual-voice conversions: who speaks (this is the part that can spoil the book), with suggestions. */
  app.get('/api/convert/:id/cast', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const cast = await castFor(request.user!.id, id);
    if (!cast) return reply.code(404).send({ error: 'No cast list for this audiobook yet' });
    return cast;
  });

  app.put('/api/convert/:id/voices', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = picksBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid voices' });
    try {
      const row = await setVoiceMap(request.user!.id, id, body.data.voices);
      if (!row) return reply.code(404).send({ error: 'This audiobook is not waiting for voices' });
      return { conversion: toConversion(row) };
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  /** While listening: the voices heard so far in this audiobook (never later ones), to change one. */
  app.get('/api/books/:id/voices', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { position } = z.object({ position: z.coerce.number().min(0).default(0) }).parse(request.query);
    const heard = await heardVoices(request.user!.id, id, position).catch(() => null);
    if (!heard) return reply.code(404).send({ error: 'Voices can only be changed on audiobooks made here' });
    return heard;
  });

  app.put('/api/books/:id/voices', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = changeBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Pick a voice' });
    try {
      const ok = await changeVoice(request.user!.id, id, body.data.part, body.data.voice, body.data.position);
      if (!ok) return reply.code(404).send({ error: 'Voices can only be changed on audiobooks made here' });
      return { ok: true };
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.delete('/api/convert/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!(await cancelConversion(request.user!.id, id))) return reply.code(404).send({ error: 'Nothing to cancel' });
    return { ok: true };
  });
}
