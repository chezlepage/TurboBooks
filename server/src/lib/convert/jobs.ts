/**
 * Ebook → audiobook job queue. One conversion runs at a time (the GPU is shared with Plex).
 * Every stage writes its output to data/conversions/<id>/, so a restart resumes where it left off.
 *
 *   queued → reading (EPUB → chapters) → casting (multi-voice only: who speaks)
 *          → annotating (per-chapter notes) → voicing (Kokoro, chapter by chapter) → done
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import { db, now } from '../../db.js';
import { safeName } from '../download.js';
import { addToLibrary, inLibrary } from '../library.js';
import { scanSingleDir } from '../scanner.js';
import { castRequest, costUsd, estimate, notesRequests, parseResult, segment } from './annotate.js';
import type { CastMember, ChapterNotes, SegChapter } from './annotate.js';
import { extractChapters } from './epubText.js';
import { castVoices, listVoices, voiceChapter } from './tts.js';

export type Status = 'queued' | 'reading' | 'casting' | 'annotating' | 'voicing' | 'done' | 'failed' | 'canceled';

export interface ConversionRow {
  id: number;
  user_id: number;
  ebook_id: number | null;
  title: string;
  voice: string;
  multi_voice: number;
  status: Status;
  progress: number;
  detail: string | null;
  batch_id: string | null;
  cost_usd: number;
  audio_book_id: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const ACTIVE: Status[] = ['queued', 'reading', 'casting', 'annotating', 'voicing'];
const workDir = (id: number) => path.join(config.dataDir, 'conversions', String(id));
const client = () => new Anthropic({ apiKey: config.anthropicApiKey });

export const conversionsEnabled = () => Boolean(config.anthropicApiKey);

function update(id: number, fields: Partial<Pick<ConversionRow, 'status' | 'progress' | 'detail' | 'batch_id' | 'audio_book_id' | 'error'>> & { addCost?: number }) {
  const { addCost, ...rest } = fields;
  const sets = Object.keys(rest).map((k) => `${k} = @${k}`);
  if (addCost) sets.push('cost_usd = cost_usd + @addCost');
  db.prepare(`UPDATE conversions SET ${[...sets, 'updated_at = @now'].join(', ')} WHERE id = @id`).run({
    ...rest,
    ...(addCost ? { addCost } : {}),
    now: now(),
    id,
  });
}

const get = (id: number) => db.prepare('SELECT * FROM conversions WHERE id = ?').get(id) as ConversionRow | undefined;

/** What Claude has cost this calendar month across all conversions. */
export function monthSpend(): number {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return (db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM conversions WHERE created_at >= ?').get(from) as { s: number }).s;
}

// ---------------------------------------------------------------------------
// Eligibility: any ebook in the user's own library (Discover, own files or Requests).
// ---------------------------------------------------------------------------

interface EbookRow {
  id: number;
  title: string;
  author: string | null;
  path: string;
  kind: string;
  source: string | null;
  cover_path: string | null;
  description: string | null;
}

export function checkEligible(userId: number, ebookId: number): { ok: true; book: EbookRow } | { ok: false; error: string } {
  const book = db.prepare('SELECT id, title, author, path, kind, source, cover_path, description FROM books WHERE id = ?').get(ebookId) as
    | EbookRow
    | undefined;
  if (!book || !inLibrary(userId, ebookId)) return { ok: false, error: 'Book not found' };
  if (book.kind !== 'ebook') return { ok: false, error: 'Only ebooks can be turned into audiobooks' };
  return { ok: true, book };
}

async function readBook(book: EbookRow) {
  const chapters = await extractChapters(book.path);
  if (chapters.length === 0) throw new Error('No readable text found in this ebook');
  return segment(chapters);
}

export async function estimateFor(userId: number, ebookId: number, multiVoice: boolean) {
  const elig = checkEligible(userId, ebookId);
  if (!elig.ok) throw Object.assign(new Error(elig.error), { statusCode: 400 });
  const { chapters, quotes } = await readBook(elig.book);
  return { ...estimate(chapters, quotes, multiVoice), monthSpend: Math.round(monthSpend() * 100) / 100, budget: config.convertMonthlyBudgetUsd };
}

export async function startConversion(userId: number, ebookId: number, voice: string, multiVoice: boolean): Promise<ConversionRow> {
  if (!conversionsEnabled()) throw Object.assign(new Error('Audiobook conversion is not set up on this server'), { statusCode: 400 });
  const elig = checkEligible(userId, ebookId);
  if (!elig.ok) throw Object.assign(new Error(elig.error), { statusCode: 400 });
  const voices = await listVoices();
  if (!voices.some((v) => v.id === voice)) throw Object.assign(new Error('Unknown voice'), { statusCode: 400 });

  // Same book, same voice settings already made (by anyone): just add it, no new cost.
  const sourceId = `${ebookId}:${voice}:${multiVoice ? 1 : 0}`;
  const existing = db.prepare("SELECT id FROM books WHERE source = 'tts' AND source_id = ?").get(sourceId) as { id: number } | undefined;
  const t = now();
  if (existing) {
    addToLibrary(userId, existing.id);
    const info = db
      .prepare(
        `INSERT INTO conversions (user_id, ebook_id, title, voice, multi_voice, status, progress, audio_book_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'done', 1, ?, ?, ?)`,
      )
      .run(userId, ebookId, elig.book.title, voice, multiVoice ? 1 : 0, existing.id, t, t);
    return get(Number(info.lastInsertRowid))!;
  }

  const active = db
    .prepare(`SELECT * FROM conversions WHERE user_id = ? AND ebook_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`)
    .get(userId, ebookId, ...ACTIVE) as ConversionRow | undefined;
  if (active) return active;

  const est = await estimateFor(userId, ebookId, multiVoice);
  if (monthSpend() + est.costHigh > config.convertMonthlyBudgetUsd) {
    throw Object.assign(
      new Error(`This would go over the monthly budget ($${config.convertMonthlyBudgetUsd}). Spent so far this month: $${est.monthSpend.toFixed(2)}.`),
      { statusCode: 400 },
    );
  }
  const info = db
    .prepare(
      `INSERT INTO conversions (user_id, ebook_id, title, voice, multi_voice, status, progress, detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 0, 'Waiting to start', ?, ?)`,
    )
    .run(userId, ebookId, elig.book.title, voice, multiVoice ? 1 : 0, t, t);
  void drain();
  return get(Number(info.lastInsertRowid))!;
}

export async function cancelConversion(userId: number, id: number): Promise<boolean> {
  const row = get(id);
  if (!row || row.user_id !== userId || !ACTIVE.includes(row.status)) return false;
  update(id, { status: 'canceled', detail: 'Canceled' });
  if (row.batch_id) await client().messages.batches.cancel(row.batch_id).catch(() => undefined);
  return true;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let running = false;
const isCanceled = (id: number) => get(id)?.status === 'canceled';

async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
}
async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Submits a batch (once) and waits for it; returns successful results keyed by custom_id. */
async function runBatch(
  id: number,
  requests: Anthropic.Messages.Batches.BatchCreateParams.Request[],
  label: string,
): Promise<Map<string, Anthropic.Message>> {
  const anthropic = client();
  if (!config.convertUseBatch) {
    // Direct calls: full price, but no waiting on the batch queue.
    const results = new Map<string, Anthropic.Message>();
    let cost = 0;
    for (let i = 0; i < requests.length; i++) {
      if (isCanceled(id)) throw new Error('canceled');
      update(id, { detail: `${label} (${i}/${requests.length})`, progress: i / requests.length });
      // Streaming is required by the SDK for requests that may run long (large max_tokens).
      const msg = await anthropic.messages.stream(requests[i].params as Anthropic.MessageCreateParamsNonStreaming).finalMessage();
      results.set(requests[i].custom_id, msg);
      cost += costUsd(msg.usage, false);
    }
    update(id, { addCost: cost });
    return results;
  }
  let row = get(id)!;
  if (!row.batch_id) {
    const batch = await anthropic.messages.batches.create({ requests });
    update(id, { batch_id: batch.id });
    row = get(id)!;
  }
  for (;;) {
    if (isCanceled(id)) throw new Error('canceled');
    const batch = await anthropic.messages.batches.retrieve(row.batch_id!);
    const c = batch.request_counts;
    const total = c.processing + c.succeeded + c.errored + c.canceled + c.expired;
    update(id, { detail: `${label} (${c.succeeded + c.errored}/${total})`, progress: total ? (c.succeeded + c.errored) / total : 0 });
    if (batch.processing_status === 'ended') break;
    await new Promise((r) => setTimeout(r, 30_000));
  }
  const results = new Map<string, Anthropic.Message>();
  let cost = 0;
  for await (const r of await anthropic.messages.batches.results(row.batch_id!)) {
    if (r.result.type === 'succeeded') {
      results.set(r.custom_id, r.result.message);
      cost += costUsd(r.result.message.usage);
    }
  }
  update(id, { batch_id: null, addCost: cost });
  return results;
}

async function runConversion(id: number): Promise<void> {
  const dir = workDir(id);
  let row = get(id)!;
  const book = db.prepare('SELECT id, title, author, path, kind, source, cover_path, description FROM books WHERE id = ?').get(row.ebook_id) as
    | EbookRow
    | undefined;
  if (!book) throw new Error('The ebook is no longer on the server');

  // 1. Read the ebook.
  let chapters = await readJson<SegChapter[]>(path.join(dir, 'chapters.json'));
  if (!chapters) {
    update(id, { status: 'reading', detail: 'Reading the ebook', progress: 0 });
    chapters = (await readBook(book)).chapters;
    await writeJson(path.join(dir, 'chapters.json'), chapters);
  }

  // 2. Cast list (multi-voice only).
  let cast: CastMember[] | null = null;
  if (row.multi_voice) {
    cast = await readJson<CastMember[]>(path.join(dir, 'cast.json'));
    if (!cast) {
      update(id, { status: 'casting', detail: 'Claude is meeting the characters', progress: 0 });
      const res = await runBatch(id, [castRequest(chapters, book.title)], 'Claude is meeting the characters');
      cast = parseResult<{ characters: CastMember[] }>(res.get('cast')!)?.characters ?? [];
      await writeJson(path.join(dir, 'cast.json'), cast);
    }
  }

  // 3. Per-chapter notes.
  let notes = await readJson<Record<string, ChapterNotes>>(path.join(dir, 'notes.json'));
  if (!notes) {
    update(id, { status: 'annotating', detail: 'Claude is reading the book', progress: 0 });
    const res = await runBatch(id, notesRequests(chapters, book.title, cast), 'Claude is reading the book');
    notes = {};
    for (const [key, msg] of res) {
      const n = parseResult<ChapterNotes>(msg);
      if (n) notes[key] = n;
    }
    await writeJson(path.join(dir, 'notes.json'), notes);
  }

  // 4. Voice it, chapter by chapter (skips chapters already done if we restarted).
  row = get(id)!;
  const voices = await listVoices();
  const characterVoices = cast && cast.length ? castVoices(cast, row.voice, voices) : null;
  const notesFor = (ch: SegChapter) => Object.entries(notes!).filter(([k]) => k.startsWith(`ch${ch.index}_`)).map(([, v]) => v);
  const kept = chapters.filter((ch) => !notesFor(ch).some((n) => n.skip));
  const pad = String(kept.length).length;
  const totalParas = kept.reduce((n, c) => n + c.paragraphs.length, 0) || 1;
  let donePara = 0;
  for (let i = 0; i < kept.length; i++) {
    const ch = kept[i];
    const out = path.join(dir, 'audio', `${String(i + 1).padStart(pad, '0')}.mp3`);
    const exists = await fs.stat(out).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await fs.mkdir(path.dirname(out), { recursive: true });
      await voiceChapter({
        chapter: ch,
        notes: notesFor(ch),
        narrator: row.voice,
        characterVoices,
        outFile: out,
        shouldStop: () => isCanceled(id),
        onProgress: (f) =>
          update(id, {
            status: 'voicing',
            detail: `Recording chapter ${i + 1} of ${kept.length}`,
            progress: (donePara + f * ch.paragraphs.length) / totalParas,
          }),
      });
    }
    donePara += ch.paragraphs.length;
  }

  // 5. Into the library.
  update(id, { detail: 'Adding to your library', progress: 1 });
  const voiceLabel = voices.find((v) => v.id === row.voice)?.label ?? row.voice;
  const finalDir = path.join(
    config.libraryDir,
    'Narrated',
    safeName(`${book.author ?? 'Unknown'} - ${book.title} (${voiceLabel}${row.multi_voice ? ', cast' : ''})`),
  );
  await fs.rm(finalDir, { recursive: true, force: true });
  await fs.mkdir(finalDir, { recursive: true });
  for (const f of await fs.readdir(path.join(dir, 'audio'))) {
    if (f.endsWith('.mp3') && !f.includes('.part')) await fs.copyFile(path.join(dir, 'audio', f), path.join(finalDir, f));
  }
  if (book.cover_path) await fs.copyFile(book.cover_path, path.join(finalDir, `cover${path.extname(book.cover_path) || '.jpg'}`)).catch(() => undefined);
  await fs.writeFile(
    path.join(finalDir, 'metadata.json'),
    JSON.stringify(
      {
        title: book.title,
        author: book.author ?? undefined,
        narrator: `${voiceLabel} (Kokoro)${row.multi_voice ? ' and cast' : ''}`,
        description: book.description ?? undefined,
        source: 'tts',
        sourceId: `${book.id}:${row.voice}:${row.multi_voice}`,
        trackTitles: kept.map((c) => c.title),
      },
      null,
      2,
    ),
  );
  const audioBookId = await scanSingleDir(finalDir);
  if (!audioBookId) throw new Error('The audiobook was made but could not be added to the library');
  addToLibrary(row.user_id, audioBookId);
  update(id, { status: 'done', detail: 'Ready', progress: 1, audio_book_id: audioBookId });
  await fs.rm(dir, { recursive: true, force: true });
}

async function drain(): Promise<void> {
  if (running || !conversionsEnabled()) return;
  running = true;
  try {
    for (;;) {
      const next = db
        .prepare(`SELECT id FROM conversions WHERE status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY id LIMIT 1`)
        .get(...ACTIVE) as { id: number } | undefined;
      if (!next) break;
      try {
        await runConversion(next.id);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg === 'canceled' || isCanceled(next.id)) {
          await fs.rm(workDir(next.id), { recursive: true, force: true });
        } else {
          console.warn(`[convert] ${next.id} failed:`, err);
          update(next.id, { status: 'failed', error: msg, detail: 'Failed' });
        }
      }
    }
  } finally {
    running = false;
  }
}

/** Picks up conversions interrupted by a restart. */
export function resumeConversions(): void {
  void drain();
}
