/** One-at-a-time download queue shared by all catalogs (LibriVox audio, Gutenberg ebooks). */
import { db, now } from '../db.js';
import { runArchiveImport } from './archive.js';
import { updateImport } from './download.js';
import { runGutenbergImport } from './gutenberg.js';

const HANDLERS: Record<string, (importId: number, sourceId: string) => Promise<void>> = {
  archive: runArchiveImport,
  gutenberg: runGutenbergImport,
};

let queueRunning = false;

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
      } catch (err) {
        console.warn(`[import] ${next.source}:${next.source_id} failed:`, err);
        updateImport(next.id, { status: 'failed', error: (err as Error).message });
      }
    }
  } finally {
    queueRunning = false;
  }
}

export function enqueueImport(source: string, sourceId: string, title: string, userId: number): number {
  const active = db
    .prepare("SELECT id FROM imports WHERE source = ? AND source_id = ? AND status IN ('queued', 'downloading')")
    .get(source, sourceId) as { id: number } | undefined;
  if (active) return active.id;
  const info = db
    .prepare(
      `INSERT INTO imports (source, source_id, title, status, progress, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
    )
    .run(source, sourceId, title, userId, now(), now());
  void drainQueue();
  return Number(info.lastInsertRowid);
}

/** Re-queues imports interrupted by a restart. Already-downloaded files are reused. */
export function resumeImports(): void {
  db.prepare("UPDATE imports SET status = 'queued' WHERE status = 'downloading'").run();
  void drainQueue();
}

export function retryImport(id: number): void {
  db.prepare("UPDATE imports SET status = 'queued', error = NULL WHERE id = ? AND status = 'failed'").run(id);
  void drainQueue();
}
