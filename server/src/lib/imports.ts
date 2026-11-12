/**
 * One-at-a-time download queue shared by all catalogs (LibriVox audio, Gutenberg ebooks).
 *
 * Files are stored once: if a book is already on the server it is simply added to the
 * requester's library, and if two people ask for the same book while it's downloading,
 * both get it when the single download finishes (import_waiters).
 */
import { db, now } from '../db.js';
import { runArchiveImport } from './archive.js';
import { updateImport } from './download.js';
import { runGutenbergImport } from './gutenberg.js';
import { addToLibrary } from './library.js';

const HANDLERS: Record<string, (importId: number, sourceId: string) => Promise<void>> = {
  archive: runArchiveImport,
  gutenberg: runGutenbergImport,
};

let queueRunning = false;

/** Puts a finished download's book into the library of everyone who asked for it. */
function deliver(importId: number): void {
  const row = db.prepare('SELECT book_id FROM imports WHERE id = ?').get(importId) as { book_id: number | null } | undefined;
  if (!row?.book_id) return;
  const waiters = db.prepare('SELECT user_id FROM import_waiters WHERE import_id = ?').all(importId) as { user_id: number }[];
  for (const w of waiters) addToLibrary(w.user_id, row.book_id);
}

async function drainQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    for (;;) {
      const next = db
        .prepare("SELECT id, source, source_id FROM imports WHERE status = 'queued' ORDER BY id LIMIT 1")
        .get() as { id: number; source: string; source_id: string } | undefined;
      if (!next) break;
      try {
        const handler = HANDLERS[next.source];
        if (!handler) throw new Error(`Unknown source ${next.source}`);
        updateImport(next.id, { status: 'downloading', progress: 0, error: null });
        await handler(next.id, next.source_id);
        deliver(next.id);
      } catch (err) {
        console.warn(`[import] ${next.source}:${next.source_id} failed:`, err);
        updateImport(next.id, { status: 'failed', error: (err as Error).message });
      }
    }
  } finally {
    queueRunning = false;
  }
}

export type EnqueueResult = { importId: number; bookId?: undefined } | { importId?: undefined; bookId: number };

export function enqueueImport(source: string, sourceId: string, title: string, userId: number): EnqueueResult {
  // Already on the server (someone else added it): no download, just add it to this library.
  const existing = db.prepare('SELECT id FROM books WHERE source = ? AND source_id = ?').get(source, sourceId) as
    | { id: number }
    | undefined;
  if (existing) {
    addToLibrary(userId, existing.id);
    return { bookId: existing.id };
  }

  const waitFor = (importId: number) =>
    db.prepare('INSERT OR IGNORE INTO import_waiters (import_id, user_id) VALUES (?, ?)').run(importId, userId);

  // Already downloading for someone: wait on that same download.
  const active = db
    .prepare("SELECT id FROM imports WHERE source = ? AND source_id = ? AND status IN ('queued', 'downloading')")
    .get(source, sourceId) as { id: number } | undefined;
  if (active) {
    waitFor(active.id);
    return { importId: active.id };
  }

  const info = db
    .prepare(
      `INSERT INTO imports (source, source_id, title, status, progress, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
    )
    .run(source, sourceId, title, userId, now(), now());
  const importId = Number(info.lastInsertRowid);
  waitFor(importId);
  void drainQueue();
  return { importId };
}

/** Re-queues imports interrupted by a restart. Already-downloaded files are reused. */
export function resumeImports(): void {
  db.prepare("UPDATE imports SET status = 'queued' WHERE status = 'downloading'").run();
  void drainQueue();
}

/** Only someone waiting on a download may retry it. */
export function retryImport(id: number, userId: number): void {
  db.prepare(
    `UPDATE imports SET status = 'queued', error = NULL
     WHERE id = ? AND status = 'failed' AND EXISTS (SELECT 1 FROM import_waiters WHERE import_id = ? AND user_id = ?)`,
  ).run(id, id, userId);
  void drainQueue();
}

/** Removes a finished/failed download from *my* list; the record goes once nobody is left on it. */
export function dismissImport(id: number, userId: number): void {
  db.transaction(() => {
    db.prepare(
      `DELETE FROM import_waiters WHERE import_id = ? AND user_id = ?
       AND EXISTS (SELECT 1 FROM imports WHERE id = ? AND status IN ('done', 'failed'))`,
    ).run(id, userId, id);
    db.prepare(
      `DELETE FROM imports WHERE id = ? AND status IN ('done', 'failed')
       AND NOT EXISTS (SELECT 1 FROM import_waiters WHERE import_id = ?)`,
    ).run(id, id);
  })();
}
