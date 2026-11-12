/** Rescans the library shortly after files appear in it (Shelfarr imports, manual copies, etc.). */
import fs from 'node:fs';
import { config } from '../config.js';
import { scanLibrary } from './scanner.js';

/** Wait this long after the last change, so a book that is still being copied is not scanned half-written. */
const QUIET_MS = 15_000;
/** But never postpone a scan longer than this, even if files keep changing. */
const MAX_WAIT_MS = 2 * 60_000;

export function watchLibrary(): void {
  let timer: NodeJS.Timeout | null = null;
  let firstChangeAt = 0;

  const schedule = () => {
    const now = Date.now();
    if (!timer) firstChangeAt = now;
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, Math.min(QUIET_MS, firstChangeAt + MAX_WAIT_MS - now));
    timer = setTimeout(() => {
      timer = null;
      scanLibrary()
        .then((r) => {
          if (r.added || r.updated || r.removed) console.log('[watch] library changed, scan:', r);
        })
        .catch((err) => console.warn('[watch] scan failed:', err));
    }, wait);
  };

  try {
    const watcher = fs.watch(config.libraryDir, { recursive: true }, (_event, filename) => {
      // Ignore hidden folders/files (Shelfarr's .shelfarr-staging, partial downloads, etc.).
      if (filename && filename.split(/[\/]/).some((part) => part.startsWith('.'))) return;
      schedule();
    });
    watcher.on('error', (err) => console.warn('[watch] stopped, falling back to the periodic scan:', err));
    watcher.unref();
  } catch (err) {
    // Recursive watching is not available everywhere; the periodic scan still covers it.
    console.warn('[watch] could not watch the library, using the periodic scan only:', err);
  }
}
