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
}

function claim(row: OwnerRow, bookId: number): void {
  addToLibrary(row.user_id, bookId);
  db.prepare('UPDATE request_owners SET book_id = ? WHERE request_id = ?').run(bookId, row.request_id);
}

/** Scanner hook: a book was just added to the server. Give it to whoever requested it. */
export function claimNewBook(bookId: number): void {
  const book = db.prepare('SELECT title, author, kind FROM books WHERE id = ?').get(bookId) as
    | { title: string; author: string | null; kind: string }
    | undefined;
  if (!book) return;
  const open = db
    .prepare('SELECT request_id, user_id, book_type, title, author FROM request_owners WHERE book_id IS NULL')
    .all() as OwnerRow[];
  for (const row of open) {
    if (kindOf(row.book_type) === book.kind && titlesMatch(row.title, book.title) && authorsCompatible(row.author, book.author)) {
      claim(row, bookId);
    }
  }
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
 * Catch-up for a completed request whose book hasn't been linked yet (e.g. the file
 * arrived while the server was restarting). Returns the book id if found.
 */
export function claimExisting(requestId: number): number | null {
  const row = db
    .prepare('SELECT request_id, user_id, book_type, title, author FROM request_owners WHERE request_id = ? AND book_id IS NULL')
    .get(requestId) as OwnerRow | undefined;
  if (!row) return null;
  const bookId = findExistingBook(row.book_type, row.title, row.author);
  if (bookId) claim(row, bookId);
  return bookId;
}
