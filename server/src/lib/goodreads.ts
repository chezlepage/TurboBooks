/**
 * Goodreads library import (the CSV from goodreads.com/review/import → "Export Library"),
 * plus a background check for which want-to-read books are free on Gutenberg/LibriVox.
 */
import { db, now } from '../db.js';
import * as archive from './archive.js';
import * as gutenberg from './gutenberg.js';

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** Goodreads writes ISBNs as ="0451526341" so spreadsheets keep leading zeros. */
const cleanIsbn = (s = '') => s.replace(/[="\s-]/g, '') || null;

/** "2023/05/14" → epoch ms. */
function parseDate(s = ''): number | null {
  const m = s.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isFinite(t) ? t : null;
}

/** Goodreads reviews can contain light HTML (<br/>, <i>). Keep it as plain text. */
const plainText = (s = '') =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
    .slice(0, 10_000);

const SHELF_MAP: Record<string, 'want' | 'reading' | 'read'> = {
  read: 'read',
  'currently-reading': 'reading',
  'to-read': 'want',
};

export const titleKey = (title: string) =>
  title
    .toLowerCase()
    .split(/[:(]/)[0] // drop subtitles and series info like "(Harry Potter, #1)"
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const lastName = (author = '') => author.trim().split(/\s+/).pop()?.toLowerCase().replace(/[^a-z]/g, '') ?? '';

export interface ImportSummary {
  total: number;
  added: number;
  updated: number;
  skipped: number;
  byShelf: Record<string, number>;
  linked: number;
}

export function importGoodreadsCsv(userId: number, csv: string): ImportSummary {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('That file looks empty.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const need = ['book id', 'title', 'author', 'exclusive shelf'];
  if (need.some((n) => col(n) < 0)) {
    throw new Error("That doesn't look like a Goodreads export. Use “Export Library” on goodreads.com/review/import.");
  }
  const get = (r: string[], name: string) => (col(name) >= 0 ? (r[col(name)] ?? '').trim() : '');

  // Books already in this user's library, to link imported entries to them.
  const libraryBooks = db
    .prepare(
      `SELECT b.id, b.title, b.author FROM books b
       JOIN library_entries le ON le.book_id = b.id AND le.user_id = ?`,
    )
    .all(userId) as { id: number; title: string; author: string | null }[];
  const findLibraryBook = (title: string, author: string) =>
    libraryBooks.find((b) => titleKey(b.title) === titleKey(title) && lastName(b.author ?? '') === lastName(author))?.id ?? null;

  const existing = db.prepare('SELECT id FROM shelf_items WHERE user_id = ? AND goodreads_id = ?');
  const insert = db.prepare(
    `INSERT INTO shelf_items (user_id, shelf, title, author, isbn13, goodreads_id, rating, review, date_read, date_added, book_id)
     VALUES (@user_id, @shelf, @title, @author, @isbn13, @goodreads_id, @rating, @review, @date_read, @date_added, @book_id)`,
  );
  const update = db.prepare(
    `UPDATE shelf_items SET shelf=@shelf, title=@title, author=@author, isbn13=@isbn13, rating=@rating, review=@review,
       date_read=@date_read, book_id=COALESCE(book_id, @book_id)
     WHERE id=@id`,
  );

  const summary: ImportSummary = { total: 0, added: 0, updated: 0, skipped: 0, byShelf: {}, linked: 0 };
  db.transaction(() => {
    for (const r of rows.slice(1)) {
      summary.total++;
      const goodreadsId = get(r, 'book id');
      const title = get(r, 'title');
      if (!goodreadsId || !title) {
        summary.skipped++;
        continue;
      }
      const author = get(r, 'author');
      const shelf = SHELF_MAP[get(r, 'exclusive shelf')] ?? 'want';
      const ratingNum = Number(get(r, 'my rating'));
      const bookId = findLibraryBook(title, author);
      const values = {
        user_id: userId,
        shelf,
        title: title.slice(0, 500),
        author: author.slice(0, 300) || null,
        isbn13: cleanIsbn(get(r, 'isbn13')) ?? cleanIsbn(get(r, 'isbn')),
        goodreads_id: goodreadsId,
        rating: ratingNum >= 1 && ratingNum <= 5 ? Math.round(ratingNum) : null,
        review: plainText(get(r, 'my review')) || null,
        date_read: parseDate(get(r, 'date read')),
        date_added: parseDate(get(r, 'date added')) ?? now(),
        book_id: bookId,
      };
      const prev = existing.get(userId, goodreadsId) as { id: number } | undefined;
      if (prev) {
        update.run({ ...values, id: prev.id });
        summary.updated++;
      } else {
        insert.run(values);
        summary.added++;
      }
      if (bookId) summary.linked++;
      summary.byShelf[shelf] = (summary.byShelf[shelf] ?? 0) + 1;
    }
  })();
  void checkFreeCopies(userId);
  return summary;
}

// ---------------------------------------------------------------------------
// "Free right now": look up want-to-read books in the public-domain catalogs.
// Runs in the background, one lookup at a time, and remembers results.
// ---------------------------------------------------------------------------

const RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
const running = new Set<number>();

export const isCheckingFree = (userId: number) => running.has(userId);

/** Same book? Titles equal, or one is the other plus a subtitle ("Moby Dick" vs "Moby Dick, or the Whale"); same author. */
function matches(r: { title: string; author: string }, item: { title: string; author: string | null }) {
  const a = titleKey(r.title);
  const b = titleKey(item.title);
  const sameTitle = a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
  return sameTitle && (!item.author || r.author.toLowerCase().includes(lastName(item.author)));
}

export async function checkFreeCopies(userId: number): Promise<void> {
  if (running.has(userId)) return;
  running.add(userId);
  try {
    const items = db
      .prepare(
        `SELECT id, title, author FROM shelf_items
         WHERE user_id = ? AND shelf IN ('want', 'reading') AND (free_checked_at IS NULL OR free_checked_at < ?)
         ORDER BY date_added DESC LIMIT 500`,
      )
      .all(userId, now() - RECHECK_MS) as { id: number; title: string; author: string | null }[];
    const save = db.prepare('UPDATE shelf_items SET free_ebook_id = ?, free_audio_id = ?, free_checked_at = ? WHERE id = ?');
    for (const item of items) {
      // Gutenberg's search covers titles and authors together; LibriVox's requires every word in
      // the title, so search it by title only and check the author on the results.
      // Distinctive words only: short words and apostrophe fragments ("alice s") trip up title search.
      const title = titleKey(item.title)
        .split(' ')
        .filter((w) => w.length > 3)
        .slice(0, 4)
        .join(' ') || titleKey(item.title);
      const withAuthor = `${title} ${lastName(item.author ?? '')}`.trim();
      let ebook: string | null = null;
      let audio: string | null = null;
      try {
        const [eb, au] = await Promise.all([
          gutenberg.search({ userId, text: withAuthor, english: false }).catch(() => ({ results: [] })),
          archive.search({ userId, text: title, english: false }).catch(() => ({ results: [] })),
        ]);
        ebook = eb.results.find((r) => matches(r, item))?.id ?? null;
        audio = au.results.find((r) => matches(r, item))?.id ?? null;
      } catch {
        continue; // network hiccup: try again next time
      }
      save.run(ebook, audio, now(), item.id);
      await new Promise((r) => setTimeout(r, 400)); // be gentle with the catalogs
    }
  } finally {
    running.delete(userId);
  }
}
