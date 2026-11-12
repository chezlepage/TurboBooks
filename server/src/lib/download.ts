/** Shared helpers for downloading books from public catalogs. */
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { db, now } from '../db.js';

export const USER_AGENT = 'TurboBooks/0.1 (self-hosted audiobook player)';

export async function getJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
  return (await res.json()) as T;
}

export async function download(url: string, dest: string, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${path.basename(dest)}`);
      const tmp = `${dest}.part`;
      await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(tmp));
      await fs.rename(tmp, dest);
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

export const safeName = (s: string) =>
  s
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 120) || 'Untitled';

export function updateImport(
  id: number,
  fields: { status?: string; progress?: number; error?: string | null; book_id?: number | null },
) {
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`);
  db.prepare(`UPDATE imports SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`).run({
    ...fields,
    updated_at: now(),
    id,
  });
}

/** Moves a finished download from <library>/.incoming into its final folder (replacing any old copy). */
export async function moveIntoLibrary(work: string, finalDir: string): Promise<void> {
  await fs.mkdir(path.dirname(finalDir), { recursive: true });
  await fs.rm(finalDir, { recursive: true, force: true });
  await fs.rename(work, finalDir);
}

/**
 * For marking search results: which of this source's books are in *this user's* library,
 * and the state of *this user's* downloads. Other people's libraries never leak in here.
 */
export function libraryState(source: string, userId: number) {
  const bookIds = new Map(
    (
      db
        .prepare(
          `SELECT b.id, b.source_id FROM books b
           JOIN library_entries le ON le.book_id = b.id AND le.user_id = ?
           WHERE b.source = ?`,
        )
        .all(userId, source) as { id: number; source_id: string }[]
    ).map((r) => [r.source_id, r.id]),
  );
  const imports = new Map(
    (
      db
        .prepare(
          `SELECT i.source_id, i.status FROM imports i
           JOIN import_waiters w ON w.import_id = i.id AND w.user_id = ?
           WHERE i.source = ? ORDER BY i.id`,
        )
        .all(userId, source) as { source_id: string; status: string }[]
    ).map((r) => [r.source_id, r.status]),
  );
  return { bookIds, imports };
}
