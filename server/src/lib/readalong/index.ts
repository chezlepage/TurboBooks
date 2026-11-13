/**
 * Read along: show an audiobook's ebook text, highlighting the sentence being read.
 *
 * The ebook and the audiobook are separate books in the library. We pair them (the ebook an
 * audiobook was made from, else the same title), transcribe the audio with Whisper (GPU
 * container, word timestamps), and line the transcript up with the ebook's sentences
 * (./align.ts). The result is one JSON file per pair; it's redone if either file changes
 * (e.g. a made audiobook gets a chapter re-recorded with a new voice).
 *
 * Transcripts are cached per audio file in 15-minute chunks, so a restart picks up where it
 * stopped and a re-recorded chapter only costs that chapter.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { db } from '../../db.js';
import type { User } from '../auth.js';
import { readEpubMeta } from '../epub.js';
import { canAccessBook, inLibrary } from '../library.js';
import { extractChapters } from '../convert/epubText.js';
import { norm, sentenceTimes } from './align.js';
import type { TimedWord } from './align.js';

export const readAlongEnabled = () => Boolean(config.whisperUrl);

const CHUNK_SECONDS = 15 * 60;
/** Below this share of sentences placed, the two files are probably not the same book. */
const MIN_MATCHED = 0.2;

interface BookRow {
  id: number;
  title: string;
  author: string | null;
  path: string;
  signature: string;
  kind: string;
  duration: number;
}
interface TrackRow {
  idx: number;
  path: string;
  duration: number;
  start_offset: number;
}

/** [text, seconds into the audiobook or null] */
export type TimedSentence = [string, number | null];
export interface SyncChapter {
  title: string;
  start: number | null;
  paras: TimedSentence[][];
}
interface SyncFile {
  v: 1;
  audioSig: string;
  ebookSig: string;
  matched: number;
  chapters: SyncChapter[];
}

export type JobState = 'queued' | 'working' | 'failed';
interface Job {
  audioId: number;
  ebookId: number;
  state: JobState;
  progress: number;
  detail: string;
  error?: string;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let busy = false;
const key = (audioId: number, ebookId: number) => `${audioId}:${ebookId}`;

const getBook = (id: number) =>
  db.prepare('SELECT id, title, author, path, signature, kind, duration FROM books WHERE id = ?').get(id) as BookRow | undefined;

const dirOf = (audioId: number) => path.join(config.dataDir, 'readalong', String(audioId));
const syncPath = (audioId: number, ebookId: number) => path.join(dirOf(audioId), `ebook-${ebookId}.json`);
const sigHash = (sig: string) => createHash('sha1').update(sig).digest('hex').slice(0, 10);

// ---------------------------------------------------------------------------
// Which ebook goes with this audiobook
// ---------------------------------------------------------------------------

/** "The Giver", "Fourth Wing: Fourth Wing, Book 1", "Dune (Deluxe Edition)" → "giver", "fourth wing", "dune". */
export const foldTitle = (t: string) =>
  t
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .split(/:|\s[-–—]\s/)[0]
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim();

/** The ebook to read along with, among those this user can open. */
export function ebookFor(user: User, audioId: number): BookRow | null {
  const audio = getBook(audioId);
  if (!audio || audio.kind !== 'audio') return null;
  // Comics (.cbz/.cbr) have no text to follow.
  const usable = (b: BookRow | undefined): b is BookRow =>
    !!b && b.kind === 'ebook' && !/\.cb[zr]$/i.test(b.path) && canAccessBook(user, b.id);

  // Made here from an ebook: that one.
  const made = db
    .prepare('SELECT ebook_id FROM conversions WHERE audio_book_id = ? AND ebook_id IS NOT NULL ORDER BY id DESC')
    .all(audioId) as { ebook_id: number }[];
  for (const m of made) {
    const b = getBook(m.ebook_id);
    if (usable(b)) return b;
  }

  const want = foldTitle(audio.title);
  if (!want) return null;
  const candidates = (
    db.prepare("SELECT id, title, author, path, signature, kind, duration FROM books WHERE kind = 'ebook'").all() as BookRow[]
  ).filter((b) => foldTitle(b.title) === want && usable(b));
  // Prefer one in the listener's own library, then one by the same author.
  const surname = (a: string | null) => (a ?? '').toLowerCase().split(/[;,&]/)[0].trim().split(/\s+/).pop() ?? '';
  const score = (b: BookRow) =>
    (inLibrary(user.id, b.id) ? 2 : 0) + (surname(b.author) && (audio.author ?? '').toLowerCase().includes(surname(b.author)) ? 1 : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const cache = new Map<string, SyncFile>();

async function readSync(audio: BookRow, ebook: BookRow): Promise<SyncFile | null> {
  const k = key(audio.id, ebook.id);
  let sync = cache.get(k) ?? null;
  if (!sync) {
    try {
      sync = JSON.parse(await fs.readFile(syncPath(audio.id, ebook.id), 'utf8')) as SyncFile;
    } catch {
      return null;
    }
  }
  if (sync.audioSig !== audio.signature || sync.ebookSig !== ebook.signature) {
    cache.delete(k);
    return null;
  }
  cache.set(k, sync);
  if (cache.size > 4) cache.delete(cache.keys().next().value!);
  return sync;
}

export async function readAlongStatus(user: User, audioId: number) {
  const audio = getBook(audioId);
  const ebook = ebookFor(user, audioId);
  if (!audio || !ebook) return { state: 'no_ebook' as const, ebook: null };
  const about = { ebook: { id: ebook.id, title: ebook.title }, minutes: Math.max(1, Math.round(audio.duration / 60 / 40)) };
  const sync = await readSync(audio, ebook);
  if (sync) {
    return {
      state: 'ready' as const,
      ...about,
      chapters: sync.chapters.map((c) => ({ title: c.title, start: c.start })),
    };
  }
  const job = jobs.get(key(audio.id, ebook.id));
  if (job) return { state: job.state, ...about, progress: job.progress, detail: job.detail, error: job.error ?? null };
  return { state: 'idle' as const, ...about };
}

export async function readAlongChapter(user: User, audioId: number, n: number): Promise<SyncChapter | null> {
  const audio = getBook(audioId);
  const ebook = ebookFor(user, audioId);
  if (!audio || !ebook) return null;
  return (await readSync(audio, ebook))?.chapters[n] ?? null;
}

export function startReadAlong(user: User, audioId: number): boolean {
  const ebook = ebookFor(user, audioId);
  if (!ebook) return false;
  const k = key(audioId, ebook.id);
  const existing = jobs.get(k);
  if (existing && existing.state !== 'failed') return true;
  const job: Job = { audioId, ebookId: ebook.id, state: 'queued', progress: 0, detail: 'Waiting for its turn' };
  jobs.set(k, job);
  queue.push(job);
  void drain();
  return true;
}

async function drain() {
  if (busy) return;
  busy = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      job.state = 'working';
      job.detail = 'Listening to the audiobook';
      const started = Date.now();
      try {
        await prepare(job);
        jobs.delete(key(job.audioId, job.ebookId));
        console.log(`[readalong] book ${job.audioId} + ebook ${job.ebookId} ready in ${Math.round((Date.now() - started) / 1000)}s`);
      } catch (err) {
        console.error(`[readalong] book ${job.audioId} + ebook ${job.ebookId} failed:`, err);
        job.state = 'failed';
        job.error = err instanceof Error && err.message.startsWith('!') ? err.message.slice(1) : 'Something went wrong. Try again later.';
      }
    }
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------------------
// The work
// ---------------------------------------------------------------------------

/** Audio from `start` for `seconds`, as 16 kHz mono FLAC (what Whisper wants, and small to send). */
function clip(file: string, start: number, seconds: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(config.ffmpegPath, [
      '-v', 'error', '-ss', String(start), '-t', String(seconds), '-i', file,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', '-f', 'flac', 'pipe:1',
    ]);
    const out: Buffer[] = [];
    let err = '';
    ff.stdout.on('data', (d: Buffer) => out.push(d));
    ff.stderr.on('data', (d) => (err += d));
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed: ${err.slice(0, 300)}`))));
  });
}

interface WhisperResult {
  segments?: { start: number; end: number; text: string; words?: { word: string; start: number; end: number }[] }[];
}

/** Words heard in the clip, with times relative to the clip. */
async function transcribe(audio: Buffer, language: string | null): Promise<[string, number][]> {
  const params = new URLSearchParams({ task: 'transcribe', output: 'json', word_timestamps: 'true', vad_filter: 'true', encode: 'true' });
  if (language) params.set('language', language);
  for (let attempt = 1; ; attempt++) {
    try {
      const form = new FormData();
      form.append('audio_file', new Blob([new Uint8Array(audio)], { type: 'audio/flac' }), 'clip.flac');
      const res = await fetch(`${config.whisperUrl}/asr?${params}`, { method: 'POST', body: form, signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok) throw new Error(`Whisper returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as WhisperResult;
      const out: [string, number][] = [];
      for (const s of body.segments ?? []) {
        if (s.words?.length) for (const w of s.words) out.push([w.word.trim(), w.start]);
        else {
          // No word timings: spread the segment's words evenly.
          const ws = s.text.trim().split(/\s+/).filter(Boolean);
          ws.forEach((w, i) => out.push([w, s.start + ((s.end - s.start) * i) / ws.length]));
        }
      }
      return out;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

/** Whole-audiobook transcript (cached per chunk). */
async function transcript(job: Job, audio: BookRow, language: string | null): Promise<TimedWord[]> {
  const tracks = db
    .prepare('SELECT idx, path, duration, start_offset FROM tracks WHERE book_id = ? ORDER BY idx')
    .all(audio.id) as TrackRow[];
  if (tracks.length === 0) throw new Error('!This audiobook has no audio files.');
  const dir = path.join(dirOf(audio.id), 'transcript');
  await fs.mkdir(dir, { recursive: true });
  const total = tracks.reduce((n, t) => n + t.duration, 0) || 1;
  let done = 0;
  const words: TimedWord[] = [];
  for (const track of tracks) {
    const pieces = Math.max(1, Math.ceil(track.duration / CHUNK_SECONDS - 0.25));
    const len = track.duration / pieces;
    // Keyed on the audio file itself, so re-recording one chapter only re-transcribes that file.
    const st = await fs.stat(track.path);
    const fileKey = sigHash(`${track.path}|${st.size}|${st.mtimeMs}`);
    for (let k = 0; k < pieces; k++) {
      const file = path.join(dir, `${fileKey}-${k}of${pieces}.json`);
      let heard: [string, number][];
      try {
        heard = JSON.parse(await fs.readFile(file, 'utf8')) as [string, number][];
      } catch {
        job.detail = 'Listening to the audiobook';
        // The last piece runs to the end of the file, whatever its exact length.
        heard = await transcribe(await clip(track.path, k * len, k === pieces - 1 ? len + 60 : len), language);
        await fs.writeFile(file, JSON.stringify(heard));
      }
      for (const [w, t] of heard) words.push({ w, t: track.start_offset + k * len + t });
      done += len;
      job.progress = Math.min(0.97, done / total);
    }
  }
  return words;
}

/** Sentences of a paragraph (Intl.Segmenter knows "Mr." doesn't end one, mostly). */
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const splitSentences = (para: string) =>
  [...segmenter.segment(para)].map((s) => s.segment.trim()).filter(Boolean);

async function prepare(job: Job) {
  const audio = getBook(job.audioId);
  const ebook = getBook(job.ebookId);
  if (!audio || !ebook) throw new Error('!The book is no longer on the server.');
  const language = ((await readEpubMeta(ebook.path).catch(() => null))?.language ?? '').slice(0, 2).toLowerCase() || null;
  const chapters = await extractChapters(ebook.path).catch(() => {
    throw new Error("!The ebook couldn't be read.");
  });

  const heard = await transcript(job, audio, language);
  job.detail = 'Matching the words to the book';
  job.progress = 0.98;

  const flat: string[] = [];
  const shaped = chapters.map((c) => ({ title: c.title, paras: c.paragraphs.map((p) => splitSentences(p).map((s) => (flat.push(s), s))) }));
  const times = sentenceTimes(
    flat,
    heard.map((h) => ({ w: norm(h.w), t: h.t })).filter((h) => h.w),
  );
  const matched = times.filter((t) => t !== null).length / (times.length || 1);
  console.log(`[readalong] book ${audio.id} + ebook ${ebook.id}: ${heard.length} words heard, ${(matched * 100).toFixed(0)}% of sentences placed`);
  if (matched < MIN_MATCHED) throw new Error("!The ebook and the audiobook don't seem to be the same book (or the same edition).");

  let i = 0;
  const out: SyncFile = {
    v: 1,
    audioSig: audio.signature,
    ebookSig: ebook.signature,
    matched,
    chapters: shaped.map((c) => {
      const paras = c.paras.map((sents) => sents.map((s): TimedSentence => [s, times[i++] ?? null]));
      const start = paras.flat().find((s) => s[1] !== null)?.[1] ?? null;
      return { title: c.title, start, paras };
    }),
  };
  const file = syncPath(audio.id, ebook.id);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(out));
  await fs.rename(`${file}.tmp`, file);
  cache.delete(key(audio.id, ebook.id));
}
