import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

export const db = new Database(path.join(config.dataDir, 'turbobooks.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const migrations: string[] = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE books (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    signature   TEXT NOT NULL,
    title       TEXT NOT NULL,
    author      TEXT,
    narrator    TEXT,
    description TEXT,
    duration    REAL NOT NULL DEFAULT 0,
    cover_path  TEXT,
    source      TEXT,
    source_id   TEXT,
    added_at    INTEGER NOT NULL
  );

  CREATE TABLE tracks (
    id           INTEGER PRIMARY KEY,
    book_id      INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx          INTEGER NOT NULL,
    path         TEXT NOT NULL,
    title        TEXT,
    duration     REAL NOT NULL,
    start_offset REAL NOT NULL,
    mime         TEXT NOT NULL
  );
  CREATE INDEX tracks_book ON tracks(book_id, idx);

  CREATE TABLE chapters (
    id      INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx     INTEGER NOT NULL,
    title   TEXT NOT NULL,
    start   REAL NOT NULL,
    end     REAL NOT NULL
  );
  CREATE INDEX chapters_book ON chapters(book_id, idx);

  CREATE TABLE progress (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    position   REAL NOT NULL,
    finished   INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
  );

  CREATE TABLE imports (
    id         INTEGER PRIMARY KEY,
    source     TEXT NOT NULL,
    source_id  TEXT NOT NULL,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL,          -- queued | downloading | done | failed
    progress   REAL NOT NULL DEFAULT 0,
    error      TEXT,
    book_id    INTEGER REFERENCES books(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v2: per-user preferences and sleep-timer marks, so they follow the user across devices.
  `
  CREATE TABLE user_prefs (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE sleep_marks (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    position REAL NOT NULL,
    at       INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
  );
  `,
  // v3: ebooks. Ebook progress is a 0..1 fraction in `position` plus a reader locator (EPUB CFI).
  `
  ALTER TABLE books ADD COLUMN kind TEXT NOT NULL DEFAULT 'audio';
  ALTER TABLE progress ADD COLUMN locator TEXT;
  `,
  // v4: cover art for Shelfarr requests (Shelfarr's API does not return it).
  `
  CREATE TABLE request_covers (
    request_id INTEGER PRIMARY KEY,
    cover_url  TEXT NOT NULL
  );
  `,
  // v5: each user's Send-to-Kindle address.
  `
  ALTER TABLE users ADD COLUMN kindle_email TEXT;
  `,
  // v6: personal libraries. Files are stored once; each user has their own list of books.
  `
  CREATE TABLE library_entries (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
  );
  CREATE INDEX library_entries_book ON library_entries(book_id);

  -- Everyone waiting on a download (the same book requested by two people downloads once).
  CREATE TABLE import_waiters (
    import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (import_id, user_id)
  );

  -- Existing books belong to whoever imported them, and to anyone who has started them.
  INSERT OR IGNORE INTO library_entries (user_id, book_id, added_at)
    SELECT created_by, book_id, updated_at FROM imports
    WHERE status = 'done' AND book_id IS NOT NULL AND created_by IS NOT NULL;
  INSERT OR IGNORE INTO library_entries (user_id, book_id, added_at)
    SELECT user_id, book_id, updated_at FROM progress;
  INSERT OR IGNORE INTO import_waiters (import_id, user_id)
    SELECT id, created_by FROM imports WHERE created_by IS NOT NULL;
  `,
  // v7: reading log beyond the library (Goodreads import, want-to-read) and ratings/notes.
  `
  CREATE TABLE shelf_items (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shelf         TEXT NOT NULL,              -- want | reading | read
    title         TEXT NOT NULL,
    author        TEXT,
    isbn13        TEXT,
    goodreads_id  TEXT,
    rating        INTEGER,                    -- 1..5, null = unrated
    review        TEXT,
    date_read     INTEGER,
    date_added    INTEGER NOT NULL,
    hidden        INTEGER NOT NULL DEFAULT 0, -- hidden from others on the profile
    book_id       INTEGER REFERENCES books(id) ON DELETE SET NULL, -- same book in this user's library
    free_ebook_id TEXT,                       -- Project Gutenberg id, if a free copy exists
    free_audio_id TEXT,                       -- LibriVox (archive.org) identifier
    free_checked_at INTEGER,
    UNIQUE (user_id, goodreads_id)
  );
  CREATE INDEX shelf_items_user ON shelf_items(user_id, shelf);

  CREATE TABLE book_ratings (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    rating     INTEGER,
    note       TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
  );
  `,
  // v8: who made each Shelfarr request. Shelfarr only knows TurboBooks' own account, so the
  // requester is tracked here: for per-user request lists and to add delivered books to their library.
  `
  CREATE TABLE request_owners (
    request_id INTEGER PRIMARY KEY,           -- Shelfarr request id
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    work_id    TEXT NOT NULL,
    book_type  TEXT NOT NULL,                 -- audiobook | ebook
    title      TEXT NOT NULL,
    author     TEXT,
    created_at INTEGER NOT NULL,
    dismissed  INTEGER NOT NULL DEFAULT 0,    -- removed from the user's list
    book_id    INTEGER REFERENCES books(id) ON DELETE SET NULL -- the delivered book, once found
  );
  CREATE INDEX request_owners_user ON request_owners(user_id);
  `,
  // v9: the language a book was requested in (Shelfarr searches for copies in that language).
  `
  ALTER TABLE request_owners ADD COLUMN language TEXT;
  `,
  // v10: remember that a book once belonged to someone, so that when its last owner removes it
  // it doesn't show up on the admin's "Unclaimed" shelf (which would reveal someone had it).
  `
  ALTER TABLE books ADD COLUMN ever_owned INTEGER NOT NULL DEFAULT 0;
  UPDATE books SET ever_owned = 1
    WHERE id IN (SELECT book_id FROM library_entries) OR id IN (SELECT book_id FROM progress);
  `,
  // v11: ebook → audiobook conversions (Claude prepares the text, Kokoro reads it).
  `
  CREATE TABLE conversions (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ebook_id      INTEGER REFERENCES books(id) ON DELETE SET NULL,
    title         TEXT NOT NULL,
    voice         TEXT NOT NULL,
    multi_voice   INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL,             -- queued | reading | casting | annotating | voicing | done | failed | canceled
    progress      REAL NOT NULL DEFAULT 0,
    detail        TEXT,
    batch_id      TEXT,
    cost_usd      REAL NOT NULL DEFAULT 0,
    audio_book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
    error         TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX conversions_user ON conversions(user_id, ebook_id);
  `,
];

const current = db.pragma('user_version', { simple: true }) as number;
for (let v = current; v < migrations.length; v++) {
  db.transaction(() => {
    db.exec(migrations[v]);
    db.pragma(`user_version = ${v + 1}`);
  })();
}

export const now = () => Date.now();
