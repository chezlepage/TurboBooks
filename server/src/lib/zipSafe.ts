/**
 * Unzipping book files (EPUBs) without letting a broken or booby-trapped file eat the server's memory.
 * fflate inflates each entry into a buffer of its *declared* size and stops there, so capping the
 * declared sizes (per entry and in total) and the entry count bounds the memory one file can take.
 */
import fs from 'node:fs/promises';
import { unzipSync } from 'fflate';
import type { Unzipped, UnzipFileInfo } from 'fflate';

export interface ZipLimits {
  /** Largest single file inside, unpacked. */
  maxEntryBytes: number;
  /** All the files we unpack from one archive, together. */
  maxTotalBytes: number;
  /** Files listed in the archive (including ones we skip). */
  maxEntries: number;
}

export const BOOK_ZIP_LIMITS: ZipLimits = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
};

/** Book files bigger than this on disk aren't read whole into memory. */
export const MAX_BOOK_FILE_BYTES = 1024 * 1024 * 1024;

export class BookFileError extends Error {
  statusCode = 400;
}

export async function readBookFile(file: string, maxBytes = MAX_BOOK_FILE_BYTES): Promise<Uint8Array> {
  const { size } = await fs.stat(file);
  if (size > maxBytes) throw new BookFileError('This book file is too big to open');
  return new Uint8Array(await fs.readFile(file));
}

/** Unzips the entries `want` picks, refusing archives that would unpack to more than the limits. */
export function unzipLimited(
  data: Uint8Array,
  want: (f: UnzipFileInfo) => boolean = () => true,
  limits: ZipLimits = BOOK_ZIP_LIMITS,
): Unzipped {
  let count = 0;
  let total = 0;
  return unzipSync(data, {
    filter: (f) => {
      if (++count > limits.maxEntries) throw new BookFileError('This book has too many files inside');
      if (!want(f)) return false;
      if (f.originalSize > limits.maxEntryBytes) throw new BookFileError('A file inside this book is too big to open');
      total += f.originalSize;
      if (total > limits.maxTotalBytes) throw new BookFileError('This book is too big to open');
      return true;
    },
  });
}
