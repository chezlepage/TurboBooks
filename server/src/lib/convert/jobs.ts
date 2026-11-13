/**
 * Ebook → audiobook job queue. One conversion runs at a time (the GPU is shared with Plex).
 * Every stage writes its output to data/conversions/<id>/, so a restart resumes where it left off.
 *
 *   queued → reading (EPUB → chapters) → casting (multi-voice only: who speaks)
 *          → annotating (per-chapter notes) → [needs_voices: manual mode, waits for the user's picks]
 *          → voicing (Kokoro, chapter by chapter) → done
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import { db, now } from '../../db.js';
import { safeName } from '../download.js';
import { addToLibrary, inLibrary } from '../library.js';
import { scanSingleDir } from '../scanner.js';
import { castRequest, costUsd, estimate, labelledLines, notesRequests, parseResult, segment } from './annotate.js';
import type { CastMember, ChapterNotes, SegChapter } from './annotate.js';
import { extractChapters } from './epubText.js';
import { getVoicePrefs } from '../../routes/prefs.js';
import { castVoices, listVoices, voiceChapter } from './tts.js';
import type { Span, Voice } from './tts.js';

export type Status =
  | 'queued'
  | 'reading'
  | 'casting'
  | 'annotating'
  | 'needs_voices'
  | 'voicing'
  | 'revoicing'
  | 'done'
  | 'failed'
  | 'canceled';
export type VoiceMode = 'auto' | 'manual';

/** Voice slots for characters Claude didn't list by name. */
export const MINOR_SLOTS = ['minor_female', 'minor_male'] as const;

export interface ConversionRow {
  id: number;
  user_id: number;
  ebook_id: number | null;
  title: string;
  voice: string;
  multi_voice: number;
  voice_mode: VoiceMode;
  /** JSON { character name | minor slot: voice id }, set by the user in manual mode. */
  voice_map: string | null;
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

/** Statuses the runner works on. */
const ACTIVE: Status[] = ['queued', 'reading', 'casting', 'annotating', 'voicing', 'revoicing'];
/** Still being made (not a voice change to a finished book), including paused for the user's voice picks. */
const OPEN: Status[] = ['queued', 'reading', 'casting', 'annotating', 'voicing', 'needs_voices'];
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
  if (/\.cb[zr]$/i.test(book.path)) return { ok: false, error: 'Comics and manga are pictures, so they can’t be read aloud' };
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

export async function startConversion(
  userId: number,
  ebookId: number,
  voice: string,
  multiVoice: boolean,
  voiceMode: VoiceMode = 'auto',
): Promise<ConversionRow> {
  if (!conversionsEnabled()) throw Object.assign(new Error('Audiobook conversion is not set up on this server'), { statusCode: 400 });
  const elig = checkEligible(userId, ebookId);
  if (!elig.ok) throw Object.assign(new Error(elig.error), { statusCode: 400 });
  const voices = await listVoices();
  if (!voices.some((v) => v.id === voice)) throw Object.assign(new Error('Unknown voice'), { statusCode: 400 });
  const mode: VoiceMode = multiVoice ? voiceMode : 'auto';

  // Same book, same voice settings already made (by anyone): just add it, no new cost.
  // Hand-picked casts are personal, so those are never shared or reused.
  const sourceId = `${ebookId}:${voice}:${multiVoice ? 1 : 0}`;
  const existing =
    mode === 'auto'
      ? (db.prepare("SELECT id FROM books WHERE source = 'tts' AND source_id = ?").get(sourceId) as { id: number } | undefined)
      : undefined;
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
    .prepare(`SELECT * FROM conversions WHERE user_id = ? AND ebook_id = ? AND status IN (${OPEN.map(() => '?').join(',')})`)
    .get(userId, ebookId, ...OPEN) as ConversionRow | undefined;
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
      `INSERT INTO conversions (user_id, ebook_id, title, voice, multi_voice, voice_mode, status, progress, detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 'Waiting to start', ?, ?)`,
    )
    .run(userId, ebookId, elig.book.title, voice, multiVoice ? 1 : 0, mode, t, t);
  void drain();
  return get(Number(info.lastInsertRowid))!;
}

// ---------------------------------------------------------------------------
// Manual character voices
// ---------------------------------------------------------------------------

const castFile = (id: number) => path.join(workDir(id), 'cast.json');
const timingFile = (id: number) => path.join(workDir(id), 'timing.json');
const redoFile = (id: number) => path.join(workDir(id), 'redo.json');
/** Per MP3 file: when each character speaks. */
type Timing = Record<string, Span[]>;

const trackFile = (i: number, count: number) => `${String(i + 1).padStart(String(count).length, '0')}.mp3`;
const notesFor = (notes: Record<string, ChapterNotes>, ch: SegChapter) =>
  Object.entries(notes)
    .filter(([k]) => k.startsWith(`ch${ch.index}_`))
    .map(([, v]) => v);
/** Chapters that get recorded (Claude marks front/back matter to skip). File N is kept[N-1]. */
const keptChapters = (chapters: SegChapter[], notes: Record<string, ChapterNotes>) =>
  chapters.filter((ch) => !notesFor(notes, ch).some((n) => n.skip));

/** Part → voice: automatic picks, overridden by anything the user chose. Null for single-voice books. */
function partVoices(row: ConversionRow, cast: CastMember[] | null, voices: Voice[]): Map<string, string> | null {
  if (!cast || cast.length === 0) return null;
  const map = castVoices(cast, row.voice, voices, getVoicePrefs(row.user_id));
  for (const [name, voice] of Object.entries(parseVoiceMap(row))) map.set(name, voice);
  return map;
}

/** True once Claude's cast list exists for a manual-voice conversion that still needs voices picked. */
export function castReady(row: ConversionRow): boolean {
  return row.voice_mode === 'manual' && OPEN.includes(row.status) && existsSync(castFile(row.id));
}

function parseVoiceMap(row: ConversionRow): Record<string, string> {
  try {
    return row.voice_map ? (JSON.parse(row.voice_map) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The cast list, the automatic suggestion for each part, and anything the user already picked. */
export async function castFor(userId: number, id: number) {
  const row = get(id);
  if (!row || row.user_id !== userId || !castReady(row)) return null;
  const cast = (await readJson<CastMember[]>(castFile(id))) ?? [];
  const suggested = Object.fromEntries(castVoices(cast, row.voice, await listVoices(), getVoicePrefs(row.user_id)));
  return {
    narrator: row.voice,
    cast: cast.map((c) => ({ name: c.name, gender: c.gender, age: c.age })),
    suggested,
    picked: parseVoiceMap(row),
  };
}

/** Saves the user's voice picks; a conversion paused for them carries on recording. */
export async function setVoiceMap(userId: number, id: number, picks: Record<string, string>): Promise<ConversionRow | null> {
  const row = get(id);
  if (!row || row.user_id !== userId || !castReady(row)) return null;
  const cast = (await readJson<CastMember[]>(castFile(id))) ?? [];
  const parts = new Set<string>([...cast.map((c) => c.name), ...MINOR_SLOTS]);
  const voiceIds = new Set((await listVoices()).map((v) => v.id));
  const clean: Record<string, string> = {};
  for (const [name, voice] of Object.entries(picks)) {
    if (!parts.has(name)) continue;
    if (!voiceIds.has(voice)) throw Object.assign(new Error('Unknown voice'), { statusCode: 400 });
    clean[name] = voice;
  }
  db.prepare('UPDATE conversions SET voice_map = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(clean), now(), id);
  if (row.status === 'needs_voices') {
    update(id, { status: 'voicing', detail: 'Recording', progress: 0 });
    void drain();
  }
  return get(id)!;
}

export async function cancelConversion(userId: number, id: number): Promise<boolean> {
  const row = get(id);
  if (!row || row.user_id !== userId || !OPEN.includes(row.status)) return false;
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
    for (let i = 0; i < requests.length; i++) {
      if (isCanceled(id)) throw new Error('canceled');
      update(id, { detail: `${label} (${i}/${requests.length})`, progress: i / requests.length });
      // Streaming is required by the SDK for requests that may run long (large max_tokens).
      const msg = await anthropic.messages.stream(requests[i].params as Anthropic.MessageCreateParamsNonStreaming).finalMessage();
      results.set(requests[i].custom_id, msg);
      // Count each call as it's paid for, so a cancel part-way still shows in the monthly spend.
      update(id, { addCost: costUsd(msg.usage, false) });
    }
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

  // 4. Manual mode: wait for the user to pick character voices (they may already have, while Claude read).
  row = get(id)!;
  if (row.voice_mode === 'manual' && cast && cast.length && row.voice_map === null) {
    update(id, { status: 'needs_voices', detail: 'Pick a voice for each character', progress: 0 });
    return;
  }

  // 5. Voice it, chapter by chapter (skips chapters already done if we restarted).
  const voices = await listVoices();
  const characterVoices = partVoices(row, cast, voices);
  if (characterVoices) {
    // Record exactly who got which voice, so the book stays described correctly even if automatic picks change later.
    const frozen = Object.fromEntries([...characterVoices].filter(([part]) => part !== 'narrator'));
    db.prepare('UPDATE conversions SET voice_map = ? WHERE id = ?').run(JSON.stringify(frozen), id);
  }
  const kept = keptChapters(chapters, notes);
  const timing = (await readJson<Timing>(timingFile(id))) ?? {};
  const totalParas = kept.reduce((n, c) => n + c.paragraphs.length, 0) || 1;
  let donePara = 0;
  for (let i = 0; i < kept.length; i++) {
    const ch = kept[i];
    const file = trackFile(i, kept.length);
    const out = path.join(dir, 'audio', file);
    if (!existsSync(out) || !timing[file]) {
      await fs.mkdir(path.dirname(out), { recursive: true });
      timing[file] = await voiceChapter({
        chapter: ch,
        notes: notesFor(notes, ch),
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
      await writeJson(timingFile(id), timing);
    }
    donePara += ch.paragraphs.length;
  }

  // 6. Into the library. Hand-picked casts get their own folder and id so they never replace another version.
  update(id, { detail: 'Adding to your library', progress: 1 });
  const voiceLabel = voices.find((v) => v.id === row.voice)?.label ?? row.voice;
  const manual = row.voice_mode === 'manual';
  const castLabel = row.multi_voice ? (manual ? `, cast #${id}` : ', cast') : '';
  const finalDir = path.join(config.libraryDir, 'Narrated', safeName(`${book.author ?? 'Unknown'} - ${book.title} (${voiceLabel}${castLabel})`));
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
        sourceId: `${book.id}:${row.voice}:${row.multi_voice}${manual ? `:manual-${id}` : ''}`,
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
  // The audio now lives in the library. Keep the text, notes and timing (small) so a voice can be changed later.
  await fs.rm(path.join(dir, 'audio'), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Changing a voice after the audiobook is made (re-records only the chapters that part speaks in)
// ---------------------------------------------------------------------------

const PART_LABELS: Record<string, string> = { narrator: 'Narrator', minor_female: 'Other women', minor_male: 'Other men' };

/** Chapters waiting to be re-recorded (file → when it was asked for), worked from the listener's chapter onwards. */
interface Redo {
  from: number;
  files: Record<string, number>;
}
// Sync on purpose: a read-modify-write of this file must not interleave between the runner and a request.
function readRedo(id: number): Redo | null {
  try {
    return JSON.parse(readFileSync(redoFile(id), 'utf8')) as Redo;
  } catch {
    return null;
  }
}
const writeRedo = (id: number, redo: Redo) => writeFileSync(redoFile(id), JSON.stringify(redo));

/** The conversion that made this audiobook and still has its notes (null for anything else). */
function sourceConversion(audioBookId: number): ConversionRow | null {
  const rows = db.prepare('SELECT * FROM conversions WHERE audio_book_id = ? ORDER BY id').all(audioBookId) as ConversionRow[];
  return rows.find((r) => (r.status === 'done' || r.status === 'revoicing') && existsSync(timingFile(r.id))) ?? null;
}

interface TrackRow {
  idx: number;
  path: string;
  start_offset: number;
  duration: number;
}
const tracksOf = (bookId: number) =>
  db.prepare('SELECT idx, path, start_offset, duration FROM tracks WHERE book_id = ? ORDER BY idx').all(bookId) as TrackRow[];

/**
 * The voices heard up to `position` in this audiobook, and who spoke last. Never anyone later in the
 * book, so changing a voice can't spoil who turns up.
 */
export async function heardVoices(userId: number, audioBookId: number, position: number) {
  if (!inLibrary(userId, audioBookId)) return null;
  const row = sourceConversion(audioBookId);
  if (!row) return null;
  const timing = (await readJson<Timing>(timingFile(row.id))) ?? {};
  const cast = row.multi_voice ? ((await readJson<CastMember[]>(castFile(row.id))) ?? []) : [];
  const map = partVoices(row, cast, await listVoices());
  const tracks = tracksOf(audioBookId);
  const heard = new Set<string>(['narrator']);
  let last: { part: string; at: number } | null = null;
  for (const t of tracks) {
    for (const span of timing[path.basename(t.path)] ?? []) {
      const at = t.start_offset + span.start;
      if (at > position) break;
      heard.add(span.part);
      last = { part: span.part, at };
    }
  }
  const gender = new Map(cast.map((c) => [c.name, c.gender]));
  const pending = readRedo(row.id)?.files ?? {};
  return {
    parts: [...heard].map((part) => ({
      part,
      label: PART_LABELS[part] ?? part,
      gender: part === 'minor_female' ? 'female' : part === 'minor_male' ? 'male' : (gender.get(part) ?? null),
      voice: part === 'narrator' ? row.voice : (map?.get(part) ?? row.voice),
    })),
    /** Who spoke most recently (within the last two minutes), so "that voice" is one tap away. */
    lastSpeaker: last && position - last.at < 120 ? last.part : null,
    pendingTracks: tracks.filter((t) => path.basename(t.path) in pending).map((t) => t.idx),
  };
}

/** Changes one part's voice for everyone who has this audiobook, and re-records the chapters it speaks in. */
export async function changeVoice(userId: number, audioBookId: number, part: string, voice: string, position: number): Promise<boolean> {
  if (!inLibrary(userId, audioBookId)) return false;
  const row = sourceConversion(audioBookId);
  if (!row) return false;
  const voices = await listVoices();
  if (!voices.some((v) => v.id === voice)) throw Object.assign(new Error('Unknown voice'), { statusCode: 400 });
  const cast = row.multi_voice ? ((await readJson<CastMember[]>(castFile(row.id))) ?? []) : [];
  const parts = new Set<string>(['narrator', ...(cast.length ? [...cast.map((c) => c.name), ...MINOR_SLOTS] : [])]);
  if (!parts.has(part)) throw Object.assign(new Error('Unknown part'), { statusCode: 400 });

  // Freeze every current pick first: automatic picks depend on the narrator and must not shift.
  const map = partVoices(row, cast, voices);
  const frozen: Record<string, string> = {};
  for (const [name, v] of map ?? []) if (name !== 'narrator') frozen[name] = v;
  const narrator = part === 'narrator' ? voice : row.voice;
  if (part === 'narrator' ? voice === row.voice : map?.get(part) === voice) return true;
  if (part !== 'narrator') frozen[part] = voice;
  db.prepare('UPDATE conversions SET voice = ?, voice_map = ?, updated_at = ? WHERE id = ?').run(narrator, JSON.stringify(frozen), now(), row.id);

  const timing = (await readJson<Timing>(timingFile(row.id))) ?? {};
  const files = Object.keys(timing).filter((f) => part === 'narrator' || timing[f].some((s) => s.part === part));
  let from = 0;
  for (const t of tracksOf(audioBookId)) if (t.start_offset <= position + 0.01) from = parseInt(path.basename(t.path), 10) - 1;
  const redo = readRedo(row.id) ?? { from, files: {} };
  redo.from = from;
  const at = Date.now();
  for (const f of files) redo.files[f] = at;
  writeRedo(row.id, redo);

  // A changed book is no longer the shared automatic version of this ebook.
  const book = db.prepare('SELECT path FROM books WHERE id = ?').get(audioBookId) as { path: string } | undefined;
  if (book) {
    const metaFile = path.join(book.path, 'metadata.json');
    const meta = await readJson<Record<string, unknown>>(metaFile);
    if (meta && typeof meta.sourceId === 'string' && !meta.sourceId.includes(':custom-')) {
      meta.sourceId = `${meta.sourceId}:custom-${row.id}`;
      await fs.writeFile(metaFile, JSON.stringify(meta, null, 2));
    }
  }
  if (row.status !== 'revoicing') update(row.id, { status: 'revoicing', detail: 'Changing a voice', progress: 0, error: null });
  void drain();
  return true;
}

async function runRevoice(id: number): Promise<void> {
  const dir = workDir(id);
  const bookId = get(id)!.audio_book_id!;
  const finalDir = (db.prepare('SELECT path FROM books WHERE id = ?').get(bookId) as { path: string } | undefined)?.path;
  if (!finalDir) throw new Error('The audiobook is no longer in the library');
  const chapters = (await readJson<SegChapter[]>(path.join(dir, 'chapters.json')))!;
  const notes = (await readJson<Record<string, ChapterNotes>>(path.join(dir, 'notes.json')))!;
  const cast = await readJson<CastMember[]>(castFile(id));
  const kept = keptChapters(chapters, notes);
  const voices = await listVoices();
  const n = kept.length;
  const idxOf = (f: string) => parseInt(f, 10) - 1;
  let done = 0;
  for (;;) {
    const redo = readRedo(id);
    const files = Object.keys(redo?.files ?? {}).filter((f) => idxOf(f) >= 0 && idxOf(f) < n);
    if (!redo || files.length === 0) break;
    // The listener's chapter first, then the ones after it, then the ones already heard.
    files.sort((a, b) => ((idxOf(a) - redo.from + n) % n) - ((idxOf(b) - redo.from + n) % n));
    const file = files[0];
    const i = idxOf(file);
    const startedAt = Date.now();
    const row = get(id)!;
    update(id, { detail: `Re-recording chapter ${i + 1} (${files.length} left)`, progress: done / (done + files.length) });
    const out = path.join(dir, 'audio', file);
    await fs.mkdir(path.dirname(out), { recursive: true });
    const spans = await voiceChapter({
      chapter: kept[i],
      notes: notesFor(notes, kept[i]),
      narrator: row.voice,
      characterVoices: partVoices(row, cast, voices),
      outFile: out,
    });
    // Swap it into the library in one step, so a player never reads a half-written file.
    const swap = path.join(finalDir, `.${file}.swap`);
    await fs.copyFile(out, swap);
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.rename(swap, path.join(finalDir, file));
        break;
      } catch (err) {
        // Some filesystems refuse to replace a file a player has open; it's usually free again shortly.
        if (attempt >= 10) throw err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    await fs.rm(out, { force: true });
    const timing = (await readJson<Timing>(timingFile(id))) ?? {};
    timing[file] = spans;
    await writeJson(timingFile(id), timing);
    await rescanKeepingPlace(bookId, finalDir);
    const after = readRedo(id);
    if (after && after.files[file] !== undefined && after.files[file] <= startedAt) {
      delete after.files[file];
      writeRedo(id, after);
    }
    done++;
  }
  await fs.rm(redoFile(id), { force: true });
  await fs.rm(path.join(dir, 'audio'), { recursive: true, force: true });
  update(id, { status: 'done', detail: 'Ready', progress: 1, error: null });
}

/** Rescans a re-recorded audiobook; everyone's place moves to the same spot in the same chapter. */
async function rescanKeepingPlace(bookId: number, dir: string): Promise<void> {
  const before = tracksOf(bookId);
  await scanSingleDir(dir);
  const after = tracksOf(bookId);
  if (after.length !== before.length || before.length === 0) return;
  const remap = (pos: number) => {
    let i = 0;
    for (let k = 0; k < before.length; k++) if (before[k].start_offset <= pos + 0.01) i = k;
    const frac = before[i].duration > 0 ? Math.min(1, Math.max(0, (pos - before[i].start_offset) / before[i].duration)) : 0;
    return after[i].start_offset + frac * after[i].duration;
  };
  db.transaction(() => {
    for (const table of ['progress', 'sleep_marks']) {
      const rows = db.prepare(`SELECT user_id, position FROM ${table} WHERE book_id = ?`).all(bookId) as { user_id: number; position: number }[];
      const set = db.prepare(`UPDATE ${table} SET position = ? WHERE user_id = ? AND book_id = ?`);
      for (const r of rows) set.run(remap(r.position), r.user_id, bookId);
    }
  })();
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
        if (get(next.id)!.status === 'revoicing') await runRevoice(next.id);
        else await runConversion(next.id);
      } catch (err) {
        const msg = (err as Error).message;
        if (get(next.id)?.status === 'revoicing') {
          // The audiobook itself is fine: keep it and its notes, just report the failed change.
          // Chapters still to re-record stay listed and are retried on the next start.
          console.warn(`[convert] ${next.id} voice change failed:`, err);
          update(next.id, { status: 'done', detail: 'Ready', error: `Changing a voice didn't finish (${msg}). It will try again when the server restarts.` });
        } else if (msg === 'canceled' || isCanceled(next.id)) {
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

/**
 * One-time upgrade for multi-voice books made before text-message lines ("Jess: on my way") were
 * recognised: those paragraphs become labelled quotes, so the character's voice reads them. They
 * get new quote ids after the existing ones, so Claude's notes still match; who says them comes
 * from the label (see voiceChapter). Only the chapters containing them are re-recorded, through
 * the same queue as a voice change. Returns whether anything was queued.
 */
async function upgradeLabelledLines(row: ConversionRow): Promise<boolean> {
  const dir = workDir(row.id);
  const flag = path.join(dir, 'labelled-lines.v1');
  if (!row.multi_voice || existsSync(flag)) return false;
  const chapters = await readJson<SegChapter[]>(path.join(dir, 'chapters.json'));
  const notes = await readJson<Record<string, ChapterNotes>>(path.join(dir, 'notes.json'));
  if (!chapters || !notes || !existsSync(castFile(row.id))) return false;

  const text = (segs: { text: string }[]) => segs.map((x) => x.text).join(' ');
  const lines = labelledLines(chapters.map((c) => c.paragraphs.map(text)));
  let q = Math.max(0, ...chapters.flatMap((c) => c.paragraphs.flat().map((x) => x.q ?? 0)));
  const changed = new Set<number>();
  chapters.forEach((c, ci) =>
    c.paragraphs.forEach((segs, pi) => {
      const line = lines[ci][pi];
      if (!line || segs.some((x) => x.label)) return;
      c.paragraphs[pi] = [{ kind: 'quote', text: line.text, q: ++q, label: line.label }];
      changed.add(c.index);
    }),
  );
  if (changed.size > 0) {
    const kept = keptChapters(chapters, notes);
    const files = kept.map((c, i) => (changed.has(c.index) ? trackFile(i, kept.length) : null)).filter((f): f is string => f !== null);
    await fs.copyFile(path.join(dir, 'chapters.json'), path.join(dir, 'chapters.before-labelled-lines.json'));
    await writeJson(path.join(dir, 'chapters.json'), chapters);
    if (files.length) {
      const redo = readRedo(row.id) ?? { from: 0, files: {} };
      const at = Date.now();
      for (const f of files) redo.files[f] = at;
      writeRedo(row.id, redo);
      console.log(`[convert] ${row.id}: text-message lines now voiced by their characters; re-recording ${files.length} chapter(s)`);
    }
  }
  writeFileSync(flag, '');
  return changed.size > 0;
}

/** Picks up conversions interrupted by a restart. */
export async function resumeConversions(): Promise<void> {
  for (const r of db.prepare("SELECT * FROM conversions WHERE status = 'done' AND audio_book_id IS NOT NULL").all() as ConversionRow[]) {
    await upgradeLabelledLines(r).catch((err) => console.warn(`[convert] ${r.id} labelled-lines upgrade failed:`, err));
  }
  // Voice changes that didn't finish: pick them up again.
  for (const r of db.prepare("SELECT * FROM conversions WHERE status = 'done' AND audio_book_id IS NOT NULL").all() as ConversionRow[]) {
    const pending = readRedo(r.id);
    if (pending && Object.keys(pending.files).length) update(r.id, { status: 'revoicing', detail: 'Changing a voice', error: null });
  }
  void drain();
}
