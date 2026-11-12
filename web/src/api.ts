export interface User {
  id: number;
  username: string;
  isAdmin: boolean;
}

export type BookKind = 'audio' | 'ebook';

export interface Progress {
  /** Seconds for audiobooks, 0..1 fraction for ebooks. */
  position: number;
  finished: boolean;
  /** Ebook reader location (EPUB CFI). */
  locator?: string | null;
  updatedAt: number;
}

export interface Book {
  id: number;
  title: string;
  author: string | null;
  narrator: string | null;
  description: string | null;
  duration: number;
  hasCover: boolean;
  source: string | null;
  addedAt: number;
  kind: BookKind;
  /** In my own library (false when seen via someone's profile, or an unclaimed file for admins). */
  inLibrary: boolean;
  progress: Progress | null;
}

export interface Track {
  id: number;
  idx: number;
  title: string | null;
  duration: number;
  start: number;
}

export interface Chapter {
  idx: number;
  title: string;
  start: number;
  end: number;
}

export interface BookDetail extends Book {
  tracks: Track[];
  chapters: Chapter[];
  /** Where this user last set a sleep timer that then stopped playback (recent only). */
  sleepMark: { position: number; at: number } | null;
  /** My stars (1-5) and private-to-profile note for this book. */
  myRating: { rating: number | null; note: string | null } | null;
}

/** A book on my shelves from outside the library (Goodreads import or added by hand). */
export interface ShelfItem {
  id: number;
  shelf: 'want' | 'reading' | 'read';
  title: string;
  author: string | null;
  isbn13: string | null;
  rating: number | null;
  review: string | null;
  dateRead: number | null;
  dateAdded: number;
  hidden: boolean;
  bookId?: number | null;
  /** Project Gutenberg id when a free ebook exists. */
  freeEbookId: string | null;
  /** LibriVox (archive.org) id when a free audiobook exists. */
  freeAudioId: string | null;
}

export interface GoodreadsImportSummary {
  total: number;
  added: number;
  updated: number;
  skipped: number;
  byShelf: Record<string, number>;
  linked: number;
}

/** Cover from Open Library by ISBN (falls back to a placeholder when there's none). */
export const isbnCoverUrl = (isbn: string | null) =>
  isbn ? `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-M.jpg?default=false` : null;

export interface SearchResult {
  id: string;
  title: string;
  author: string;
  description: string;
  language: string;
  duration: string;
  durationSecs: number;
  coverUrl: string;
  sourceUrl: string;
  /** Set when this recording is already in the library. */
  bookId: number | null;
  importStatus: string | null;
  kind: BookKind;
}

export interface Category {
  id: string;
  label: string;
}

export interface SearchParams {
  kind?: BookKind;
  q?: string;
  category?: string;
  english?: boolean;
  page?: number;
}

export interface ImportJob {
  id: number;
  source: string;
  sourceId: string;
  title: string;
  status: 'queued' | 'downloading' | 'done' | 'failed';
  progress: number;
  error: string | null;
  bookId: number | null;
  updatedAt: number;
}

export interface AdminUser {
  id: number;
  username: string;
  isAdmin: boolean;
  createdAt: number;
}

export interface WishResult {
  workId: string;
  title: string;
  author: string | null;
  year: number | string | null;
  coverUrl: string | null;
  series: string | null;
}
export interface Edition {
  thumbUrl: string;
  coverUrl: string;
  year: string | null;
  publisher: string | null;
  format: string | null;
}
export interface Release {
  id: number;
  title: string;
  source: string | null;
  direct: boolean;
  seeders: number | null;
  sizeBytes: number | null;
  confidence: number | null;
  language: string | null;
}
export interface WishRequest {
  id: number;
  status: string;
  needsAttention: boolean;
  issue: string | null;
  title: string;
  author: string | null;
  bookType: string;
  coverUrl: string | null;
  createdAt: string;
}

/** A book as it appears on someone's profile. */
export interface Activity {
  id: number;
  title: string;
  author: string | null;
  kind: BookKind;
  hasCover: boolean;
  fraction: number;
  finished: boolean;
  updatedAt: number;
}

export interface PersonStats {
  finished: number;
  finishedThisYear: number;
  inProgress: number;
  listenedHours: number;
}

export interface PersonSummary {
  id: number;
  username: string;
  isYou: boolean;
  current: Activity | null;
  stats: PersonStats;
}

export interface Person {
  id: number;
  username: string;
  isAdmin: boolean;
  isYou: boolean;
  memberSince: number;
  stats: PersonStats;
  current: Activity[];
  finished: Activity[];
}

export interface KindleSettings {
  /** False until the server admin sets up outgoing email. */
  enabled: boolean;
  /** The address users must add to Amazon's approved sender list. */
  sender: string | null;
  email: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Called when any request comes back 401 so the app can show the login screen. */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !url.startsWith('/api/auth/login')) onUnauthorized();
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const api = {
  me: () => request<{ user: User }>('GET', '/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: User }>('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout', {}),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('POST', '/api/auth/password', { currentPassword, newPassword }),

  books: () => request<{ books: Book[] }>('GET', '/api/books'),
  book: (id: number) => request<{ book: BookDetail }>('GET', `/api/books/${id}`),
  saveProgress: (id: number, position: number, finished?: boolean, locator?: string) =>
    request<{ ok: true; updatedAt: number }>('PUT', `/api/books/${id}/progress`, { position, finished, locator }),
  setSleepMark: (id: number, position: number) =>
    request<{ sleepMark: { position: number; at: number } }>('PUT', `/api/books/${id}/sleep-mark`, { position }),
  clearSleepMark: (id: number) => request('DELETE', `/api/books/${id}/sleep-mark`),
  getPrefs: () => request<{ prefs: import('./prefs').Prefs | null }>('GET', '/api/me/prefs'),
  putPrefs: (prefs: import('./prefs').Prefs) => request('PUT', '/api/me/prefs', prefs),
  kindle: () => request<KindleSettings>('GET', '/api/me/kindle'),
  setKindleEmail: (email: string) => request<{ email: string | null }>('PUT', '/api/me/kindle', { email }),
  sendToKindle: (id: number) => request<{ ok: true; to: string }>('POST', `/api/books/${id}/send-to-kindle`, {}),
  resetProgress: (id: number) => request('DELETE', `/api/books/${id}/progress`),
  deleteBook: (id: number) => request('DELETE', `/api/books/${id}`),
  addToLibrary: (id: number) => request('POST', `/api/books/${id}/library`, {}),
  rateBook: (id: number, rating: number | null, note?: string | null) =>
    request('PUT', `/api/books/${id}/rating`, { rating, note }),
  shelf: () => request<{ items: ShelfItem[]; checkingFree: boolean }>('GET', '/api/shelf'),
  importGoodreads: (csv: string) =>
    request<{ summary: GoodreadsImportSummary }>('POST', '/api/shelf/import/goodreads', { csv }),
  checkFree: () => request('POST', '/api/shelf/check-free', {}),
  addToShelf: (title: string, author: string, shelf: ShelfItem['shelf'] = 'want') =>
    request<{ id: number }>('POST', '/api/shelf', { title, author, shelf }),
  updateShelfItem: (id: number, patch: Partial<Pick<ShelfItem, 'shelf' | 'hidden' | 'rating' | 'review'>>) =>
    request('PATCH', `/api/shelf/${id}`, patch),
  removeShelfItem: (id: number) => request('DELETE', `/api/shelf/${id}`),
  removeFromLibrary: (id: number) => request('DELETE', `/api/books/${id}/library`),
  /** Admin: files on the server nobody has added yet. */
  unclaimedBooks: () => request<{ books: Book[] }>('GET', '/api/books/unclaimed'),

  search: (p: SearchParams) => {
    const qs = new URLSearchParams();
    qs.set('kind', p.kind ?? 'audio');
    if (p.q) qs.set('q', p.q);
    if (p.category) qs.set('category', p.category);
    qs.set('english', p.english === false ? '0' : '1');
    qs.set('page', String(p.page ?? 0));
    return request<{ results: SearchResult[]; hasMore: boolean }>('GET', `/api/discover/search?${qs}`);
  },
  categories: (kind: BookKind) => request<{ categories: Category[] }>('GET', `/api/discover/categories?kind=${kind}`),
  importBook: (kind: BookKind, id: string, title: string) =>
    // bookId: it was already on the server and is now in your library (no download needed).
    request<{ importId?: number; bookId?: number }>('POST', '/api/discover/import', { kind, id, title }),
  imports: () => request<{ imports: ImportJob[] }>('GET', '/api/imports'),
  retryImport: (id: number) => request('POST', `/api/imports/${id}/retry`, {}),
  dismissImport: (id: number) => request('DELETE', `/api/imports/${id}`),

  wishlistStatus: () => request<{ enabled: boolean }>('GET', '/api/wishlist/status'),
  wishlistSearch: (q: string) =>
    request<{ results: WishResult[] }>('GET', `/api/wishlist/search?q=${encodeURIComponent(q)}`),
  wishlist: () => request<{ requests: WishRequest[] }>('GET', '/api/wishlist'),
  wishlistRequest: (r: WishResult, bookType: 'audiobook' | 'ebook', coverUrl?: string | null) =>
    request('POST', '/api/wishlist', {
      workId: r.workId,
      bookType,
      title: r.title,
      author: r.author,
      coverUrl: coverUrl ?? r.coverUrl,
      year: r.year,
    }),
  wishlistEditions: (workId: string) =>
    request<{ editions: Edition[] }>('GET', `/api/wishlist/editions?workId=${encodeURIComponent(workId)}`),
  wishlistReleases: (id: number) => request<{ releases: Release[] }>('GET', `/api/wishlist/${id}/releases`),
  wishlistGrab: (id: number, releaseId: number) => request('POST', `/api/wishlist/${id}/grab`, { releaseId }),
  wishlistRetry: (id: number) => request('POST', `/api/wishlist/${id}/retry`, {}),
  wishlistCancel: (id: number) => request('DELETE', `/api/wishlist/${id}`),

  people: () => request<{ people: PersonSummary[] }>('GET', '/api/people'),
  person: (id: number) => request<{ person: Person }>('GET', `/api/people/${id}`),
  users: () => request<{ users: AdminUser[] }>('GET', '/api/admin/users'),
  createUser: (username: string, password: string, isAdmin: boolean) =>
    request('POST', '/api/admin/users', { username, password, isAdmin }),
  resetUserPassword: (id: number, password: string) => request('POST', `/api/admin/users/${id}/password`, { password }),
  deleteUser: (id: number) => request('DELETE', `/api/admin/users/${id}`),
  scan: () => request<{ result: { added: number; updated: number; removed: number; failed: number } }>('POST', '/api/admin/scan', {}),
};

export const coverUrl = (book: { id: number; hasCover: boolean }) => (book.hasCover ? `/api/books/${book.id}/cover` : null);
export const streamUrl = (trackId: number) => `/api/tracks/${trackId}/stream`;
export const ebookFileUrl = (bookId: number) => `/api/books/${bookId}/file`;

/** Fire-and-forget progress save that survives the page being closed. */
export function beaconProgress(id: number, position: number, locator?: string): void {
  const payload = JSON.stringify({ position, locator });
  const body = new Blob([payload], { type: 'application/json' });
  if (!navigator.sendBeacon?.(`/api/books/${id}/progress`, body)) {
    void fetch(`/api/books/${id}/progress`, {
      method: 'PUT',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }).catch(() => undefined);
  }
}

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s > 0 && s < 60) return '<1 min';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
