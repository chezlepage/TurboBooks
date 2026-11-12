/**
 * Personal libraries. Book files are stored once on the server; each user has their own
 * list of books (library_entries). Nobody sees which books other people have added,
 * except what they choose to show on their profile.
 */
import { db, now } from '../db.js';
import type { User } from './auth.js';
import { getPrivacy } from '../routes/prefs.js';

export function addToLibrary(userId: number, bookId: number): void {
  db.prepare('INSERT OR IGNORE INTO library_entries (user_id, book_id, added_at) VALUES (?, ?, ?)').run(userId, bookId, now());
}

export function removeFromLibrary(userId: number, bookId: number): void {
  db.prepare('DELETE FROM library_entries WHERE user_id = ? AND book_id = ?').run(userId, bookId);
}

export function inLibrary(userId: number, bookId: number): boolean {
  return !!db.prepare('SELECT 1 FROM library_entries WHERE user_id = ? AND book_id = ?').get(userId, bookId);
}

/** Books on disk that nobody has in their library (e.g. files copied into the folder by hand). */
export function isUnclaimed(bookId: number): boolean {
  return !db.prepare('SELECT 1 FROM library_entries WHERE book_id = ? LIMIT 1').get(bookId);
}

/**
 * Whether someone else shows this book on their profile: it's in their library, they have
 * started or finished it, they share their reading, and they haven't hidden this book.
 */
export function visibleOnSomeonesProfile(bookId: number, viewerId: number): boolean {
  const owners = db
    .prepare(
      `SELECT le.user_id FROM library_entries le
       JOIN progress p ON p.user_id = le.user_id AND p.book_id = le.book_id
       WHERE le.book_id = ? AND le.user_id != ?`,
    )
    .all(bookId, viewerId) as { user_id: number }[];
  return owners.some(({ user_id }) => {
    const privacy = getPrivacy(user_id);
    return privacy.share && !privacy.hidden.has(bookId);
  });
}

/** Who may open a book: its owners, anyone it's shown to via a profile, and admins for unclaimed files. */
export function canAccessBook(user: User, bookId: number): boolean {
  if (inLibrary(user.id, bookId)) return true;
  if (user.isAdmin && isUnclaimed(bookId)) return true;
  return visibleOnSomeonesProfile(bookId, user.id);
}
