import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { readEpubMeta } from './epub.js';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, extractCover, probe } from './media.js';

/**
 * Library layout rules:
 *  - Every directory that directly contains audio files is one book (all its audio files, natural-sorted).
 *  - Audio files sitting directly in the library root are one book each.
 *  - Every .epub file is one ebook. A metadata.ebook.json next to it overrides its metadata.
 *  - Directories starting with "." are ignored (used for in-progress imports).
 *  - An optional metadata.json in a book directory overrides tags:
 *    { title, author, narrator, description, source, sourceId, trackTitles: string[] }
 */

export interface BookMetadataFile {
  title?: string;
  author?: string;
  narrator?: string;
  description?: string;
  source?: string;
  sourceId?: string;
  trackTitles?: string[];
}

interface Candidate {
  kind: 'audio' | 'ebook';
  /** Unique key: a directory path, or a file path for root-level loose files and ebooks. */
  key: string;
  dir: string;
  audioFiles: string[];
  imageFiles: string[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

async function findCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  async function walk(dir: string, isRoot: boolean) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const audio: string[] = [];
    const images: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, false);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext in AUDIO_EXTENSIONS) audio.push(full);
        else if (IMAGE_EXTENSIONS.has(ext)) images.push(full);
        else if (ext === '.epub') out.push({ kind: 'ebook', key: full, dir, audioFiles: [], imageFiles: [] });
      }
    }
    audio.sort((a, b) => collator.compare(path.basename(a), path.basename(b)));
    if (isRoot) {
      for (const file of audio) out.push({ kind: 'audio', key: file, dir, audioFiles: [file], imageFiles: [] });
    } else if (audio.length > 0) {
      out.push({ kind: 'audio', key: dir, dir, audioFiles: audio, imageFiles: images });
    }
  }
  await walk(config.libraryDir, true);
  return out;
}

async function signatureOf(candidate: Candidate): Promise<string> {
  const h = crypto.createHash('sha1');
  const files =
    candidate.kind === 'ebook'
      ? [candidate.key, path.join(candidate.dir, 'metadata.ebook.json')]
      : [...candidate.audioFiles, ...candidate.imageFiles];
  if (candidate.kind === 'audio' && candidate.key === candidate.dir) files.push(path.join(candidate.dir, 'metadata.json'));
  for (const file of files) {
    try {
      const st = await fs.stat(file);
      h.update(`${file}|${st.size}|${st.mtimeMs}\n`);
    } catch {
      h.update(`${file}|missing\n`);
    }
  }
  return h.digest('hex');
}

async function readMetadataFile(dir: string): Promise<BookMetadataFile> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8')) as BookMetadataFile;
  } catch {
    return {};
  }
}

function pickCover(images: string[]): string | undefined {
  const preferred = ['cover', 'folder', 'front'];
  for (const name of preferred) {
    const hit = images.find((img) => path.parse(img).name.toLowerCase() === name);
    if (hit) return hit;
  }
  return images[0];
}

const prettyName = (p: string) =>
  path
    .parse(p)
    .name.replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function indexBook(candidate: Candidate, signature: string, existingId?: number): Promise<number> {
  const isDirBook = candidate.key === candidate.dir;
  const meta = isDirBook ? await readMetadataFile(candidate.dir) : {};

  const probes = [];
  for (const file of candidate.audioFiles) {
    try {
      probes.push({ file, info: await probe(file) });
    } catch (err) {
      console.warn(`[scan] ffprobe failed for ${file}:`, (err as Error).message);
    }
  }
  if (probes.length === 0) throw new Error('no playable audio files');

  const firstTags = probes[0].info.tags;
  const title =
    meta.title ??
    (probes.length > 1 ? firstTags.album : firstTags.album ?? firstTags.title) ??
    prettyName(candidate.key);
  const author = meta.author ?? firstTags.album_artist ?? firstTags.artist ?? firstTags.author ?? null;
  const narrator = meta.narrator ?? firstTags.composer ?? firstTags.narrator ?? null;
  const description = meta.description ?? firstTags.description ?? firstTags.comment ?? null;

  // Build tracks with cumulative offsets, and chapters.
  let offset = 0;
  const tracks = probes.map(({ file, info }, idx) => {
    const track = {
      idx,
      path: file,
      title: meta.trackTitles?.[idx] ?? (probes.length > 1 ? info.tags.title : undefined) ?? prettyName(file),
      duration: info.duration,
      offset,
      mime: AUDIO_EXTENSIONS[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      chapters: info.chapters,
    };
    offset += info.duration;
    return track;
  });
  const duration = offset;

  const chapters: { title: string; start: number; end: number }[] = [];
  for (const track of tracks) {
    if (track.chapters.length > 0) {
      for (const c of track.chapters) {
        chapters.push({ title: c.title, start: track.offset + c.start, end: track.offset + c.end });
      }
    } else {
      chapters.push({ title: track.title, start: track.offset, end: track.offset + track.duration });
    }
  }

  const write = db.transaction((coverPath: string | null) => {
    let bookId = existingId;
    const fields = [signature, title, author, narrator, description, duration, coverPath, meta.source ?? null, meta.sourceId ?? null];
    if (bookId) {
      db.prepare(
        `UPDATE books SET signature=?, title=?, author=?, narrator=?, description=?, duration=?, cover_path=?, source=?, source_id=?
         WHERE id=?`,
      ).run(...fields, bookId);
      db.prepare('DELETE FROM tracks WHERE book_id = ?').run(bookId);
      db.prepare('DELETE FROM chapters WHERE book_id = ?').run(bookId);
    } else {
      const info = db
        .prepare(
          `INSERT INTO books (signature, title, author, narrator, description, duration, cover_path, source, source_id, path, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...fields, candidate.key, now());
      bookId = Number(info.lastInsertRowid);
    }
    const insTrack = db.prepare(
      'INSERT INTO tracks (book_id, idx, path, title, duration, start_offset, mime) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const t of tracks) insTrack.run(bookId, t.idx, t.path, t.title, t.duration, t.offset, t.mime);
    const insChapter = db.prepare('INSERT INTO chapters (book_id, idx, title, start, end) VALUES (?, ?, ?, ?, ?)');
    chapters.forEach((c, i) => insChapter.run(bookId, i, c.title, c.start, c.end));
    return bookId!;
  });

  // Cover: image file in the folder, else embedded art extracted to the data dir.
  let coverPath: string | null = pickCover(candidate.imageFiles) ?? null;
  const bookId = write(coverPath);
  if (!coverPath) {
    const withArt = probes.find((p) => p.info.hasCover);
    if (withArt) {
      const out = path.join(config.dataDir, 'covers', `${bookId}.jpg`);
      if (await extractCover(withArt.file, out)) {
        coverPath = out;
        db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(coverPath, bookId);
      }
    }
  }
  return bookId;
}

/** Removes any extracted cover (any extension) for a book id. */
export async function removeCoverFiles(bookId: number): Promise<void> {
  const dir = path.join(config.dataDir, 'covers');
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.filter((n) => path.parse(n).name === String(bookId)).map((n) => fs.rm(path.join(dir, n), { force: true })));
}

async function indexEbook(candidate: Candidate, signature: string, existingId?: number): Promise<number> {
  const file = candidate.key;
  const meta = await readEpubMeta(file);
  let override: BookMetadataFile = {};
  try {
    override = JSON.parse(await fs.readFile(path.join(candidate.dir, 'metadata.ebook.json'), 'utf8')) as BookMetadataFile;
  } catch {
    /* none */
  }
  const title = override.title ?? meta.title ?? prettyName(file);
  const author = override.author ?? meta.author ?? null;
  const description = override.description || meta.description || null;
  const fields = [signature, title, author, null, description, 1, null, override.source ?? null, override.sourceId ?? null];

  let bookId = existingId;
  if (bookId) {
    db.prepare(
      `UPDATE books SET signature=?, title=?, author=?, narrator=?, description=?, duration=?, cover_path=?, source=?, source_id=?, kind='ebook'
       WHERE id=?`,
    ).run(...fields, bookId);
  } else {
    const info = db
      .prepare(
        `INSERT INTO books (signature, title, author, narrator, description, duration, cover_path, source, source_id, path, added_at, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ebook')`,
      )
      .run(...fields, file, now());
    bookId = Number(info.lastInsertRowid);
  }
  await removeCoverFiles(bookId);
  if (meta.cover) {
    const out = path.join(config.dataDir, 'covers', `${bookId}${meta.cover.ext}`);
    await fs.writeFile(out, meta.cover.data);
    db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(out, bookId);
  }
  return bookId;
}

export interface ScanResult {
  added: number;
  updated: number;
  removed: number;
  failed: number;
}

let running: Promise<ScanResult> | null = null;

/** Scans the library. Concurrent calls share the same in-flight scan. */
export function scanLibrary(): Promise<ScanResult> {
  running ??= doScan().finally(() => {
    running = null;
  });
  return running;
}

export const isScanning = () => running !== null;

async function doScan(): Promise<ScanResult> {
  const started = Date.now();
  const result: ScanResult = { added: 0, updated: 0, removed: 0, failed: 0 };
  const candidates = await findCandidates();
  const existing = new Map(
    (db.prepare('SELECT id, path, signature FROM books').all() as { id: number; path: string; signature: string }[]).map(
      (b) => [b.path, b],
    ),
  );

  for (const candidate of candidates) {
    const prev = existing.get(candidate.key);
    existing.delete(candidate.key);
    const signature = await signatureOf(candidate);
    if (prev && prev.signature === signature) continue;
    try {
      if (candidate.kind === 'ebook') await indexEbook(candidate, signature, prev?.id);
      else await indexBook(candidate, signature, prev?.id);
      if (prev) result.updated++;
      else result.added++;
    } catch (err) {
      result.failed++;
      console.warn(`[scan] failed to index ${candidate.key}:`, (err as Error).message);
    }
  }

  // Anything left in `existing` is gone from disk.
  for (const gone of existing.values()) {
    db.prepare('DELETE FROM books WHERE id = ?').run(gone.id);
    await removeCoverFiles(gone.id);
    result.removed++;
  }

  console.log(`[scan] done in ${Date.now() - started}ms`, result);
  return result;
}

/** Scans a single directory (used right after an import finishes). */
export async function scanSingleDir(dir: string): Promise<number | null> {
  // An in-flight scan may have started before `dir` existed, so wait for it and scan again.
  if (running) await running.catch(() => undefined);
  await scanLibrary();
  const row = db.prepare('SELECT id FROM books WHERE path = ?').get(dir) as { id: number } | undefined;
  return row?.id ?? null;
}
