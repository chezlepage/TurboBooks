/**
 * Books requested through Shelfarr arrive via the folder scanner with no owner. Shelfarr
 * doesn't tell us which files belong to which request, so new books are matched to open
 * requests by type, title and author, and added to the requester's library.
 */
import { db } from '../db.js';
import { addToLibrary } from './library.js';

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** "The Hobbit: or There and Back Again (Unabridged)" -> "hobbit". */
const normTitle = (s: string) => fold(s.split(/[:([]/)[0]).replace(/^(the|a|an) /, '');

export function titlesMatch(a: string, b: string): boolean {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // One title contains the other (e.g. series prefixes), but only for titles long enough to be distinctive.
  return Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x));
}

/** True when either author is unknown, or they share a name part ("J.R.R. Tolkien" vs "Tolkien, J. R. R."). */
export function authorsCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  const parts = (s: string) => fold(s).split(' ').filter((t) => t.length > 2);
  const left = new Set(parts(a));
  const right = parts(b);
  if (!left.size || !right.length) return true; // nothing usable to compare (e.g. initials only)
  return right.some((t) => left.has(t));
}

const kindOf = (bookType: string) => (bookType === 'ebook' ? 'ebook' : 'audio');

interface OwnerRow {
  request_id: number;
  user_id: number;
  book_type: string;
  title: string;
  author: string | null;
  book_id: number | null;
}

interface BookRow {
  id: number;
  title: string;
  author: string | null;
  path: string;
}

const OWNER_COLUMNS = 'request_id, user_id, book_type, title, author, book_id';

/**
 * Shelfarr saves every download in a folder named after the request ("Ebooks/<author>/<request title>/"),
 * whatever the files inside are called. So a book under that folder came from that request: this is how
 * every book of a multi-book pack ("Stormlight Archive, Books 1-4") reaches the person who asked for it.
 */
function inRequestFolder(row: OwnerRow, bookPath: string): boolean {
  const want = fold(row.title);
  return !!want && bookPath.split(/[\\/]/).some((segment) => fold(segment) === want);
}

/** Add the book to the requester's library; the request's own book id is the first one that arrived. */
function claim(row: OwnerRow, bookId: number): void {
  addToLibrary(row.user_id, bookId);
  db.prepare('UPDATE request_owners SET book_id = COALESCE(book_id, ?) WHERE request_id = ?').run(bookId, row.request_id);
  row.book_id ??= bookId;
}

/** Scanner hook: a book was just added to the server. Give it to whoever requested it. */
export function claimNewBook(bookId: number): void {
  const book = db.prepare('SELECT title, author, kind, path FROM books WHERE id = ?').get(bookId) as
    | { title: string; author: string | null; kind: string; path: string }
    | undefined;
  if (!book) return;
  const candidates = (db.prepare(`SELECT ${OWNER_COLUMNS} FROM request_owners`).all() as OwnerRow[]).filter(
    (row) => kindOf(row.book_type) === book.kind && authorsCompatible(row.author, book.author),
  );
  // The download folder is the strongest evidence, and it also covers requests that already got a book
  // (the other books of a pack). Only without it, fall back to matching titles against open requests.
  const byFolder = candidates.filter((row) => inRequestFolder(row, book.path));
  const matches = byFolder.length
    ? byFolder
    : candidates.filter((row) => row.book_id === null && titlesMatch(row.title, book.title));
  for (const row of matches) claim(row, bookId);
}

/** A book already on the server matching this title, author and type, if any. */
export function findExistingBook(bookType: string, title: string, author: string | null): number | null {
  const books = db.prepare('SELECT id, title, author FROM books WHERE kind = ?').all(kindOf(bookType)) as Array<{
    id: number;
    title: string;
    author: string | null;
  }>;
  return books.find((b) => titlesMatch(title, b.title) && authorsCompatible(author, b.author))?.id ?? null;
}

/**
 * Catch-up for a completed request whose book hasn't been linked yet (e.g. the file arrived while
 * the server was restarting, or before folder matching existed). Returns the book id if found.
 */
export function claimExisting(requestId: number): number | null {
  const row = db.prepare(`SELECT ${OWNER_COLUMNS} FROM request_owners WHERE request_id = ?`).get(requestId) as
    | OwnerRow
    | undefined;
  if (!row) return null;
  const books = db.prepare('SELECT id, title, author, path FROM books WHERE kind = ? ORDER BY id').all(kindOf(row.book_type)) as BookRow[];
  const inFolder = books.filter((b) => authorsCompatible(row.author, b.author) && inRequestFolder(row, b.path));
  for (const b of inFolder) claim(row, b.id);
  if (row.book_id) return row.book_id;
  const bookId = findExistingBook(row.book_type, row.title, row.author);
  if (bookId) claim(row, bookId);
  return bookId;
}
