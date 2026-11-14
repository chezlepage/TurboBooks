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
  /** Ebooks: 'epub', or 'cbz'/'cbr' for comics, manga and webtoons (null for audiobooks). */
  format?: 'epub' | 'cbz' | 'cbr' | null;
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

/** Read along: an audiobook's ebook text, synced sentence by sentence. */
export type ReadAlongStatus =
  | { state: 'off'; ebook?: undefined }
  | { state: 'no_ebook'; ebook: null }
  | { state: 'idle'; ebook: { id: number; title: string }; minutes: number }
  | {
      state: 'queued' | 'working' | 'failed';
      ebook: { id: number; title: string };
      minutes: number;
      progress: number;
      detail: string;
      error: string | null;
    }
  | {
      state: 'ready';
      ebook: { id: number; title: string };
      minutes: number;
      chapters: { title: string; start: number | null }[];
    };
/** [sentence, seconds into the audiobook (null: not read aloud / couldn't be placed)] */
export type ReadAlongSentence = [string, number | null];
export interface ReadAlongChapter {
  title: string;
  start: number | null;
  paras: ReadAlongSentence[][];
}

/** A comic/manga/webtoon's pages ([width, height] each) and how it's meant to be read. */
export interface ComicInfo {
  version: string;
  pages: [number, number][];
  direction: 'ltr' | 'rtl';
  layout: 'paged' | 'webtoon';
}

/** Comics, manga and webtoons are ebooks in .cbz/.cbr files. */
export const isComic = (b: Pick<Book, 'format'>) => b.format === 'cbz' || b.format === 'cbr';

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
  kind: DiscoverKind;
}

/** Discover's shelves: audiobooks, ebooks, and public-domain comics (ebooks once added). */
export type DiscoverKind = BookKind | 'comic';

export interface Category {
  id: string;
  label: string;
}

export interface SearchParams {
  kind?: DiscoverKind;
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
  /** Once delivered: the book in your library. */
  bookId: number | null;
  /** Language the book was requested in (null: Shelfarr's default). */
  language: string | null;
  /** An ebook requested to be turned into an audiobook once it arrives. */
  makeAudiobook: boolean;
}

export interface BookLanguage {
  code: string;
  /** In its own language, e.g. "Français". */
  name: string;
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

export type Ereader = 'kindle' | 'pocketbook';

/** Display names, for "Send to Kindle" / "Send to PocketBook". */
export const EREADER_NAMES: Record<Ereader, string> = { kindle: 'Kindle', pocketbook: 'PocketBook' };

/** Send to e-reader (Kindle or PocketBook, by email). */
export interface KindleSettings {
  /** False until the server admin sets up outgoing email. */
  enabled: boolean;
  /** The address TurboBooks sends from (Amazon's approved sender list; PocketBook asks to confirm it). */
  sender: string | null;
  /** The e-reader's own address (…@kindle.com or …@pbsync.com). */
  email: string | null;
  /** Which kind of e-reader that address belongs to. */
  device: Ereader | null;
}

export interface TtsVoice {
  id: string;
  label: string;
  /** "US", "UK", or e.g. "French accent". */
  accent: string;
  gender: 'female' | 'male';
  featured: boolean;
  /** voice: a Kokoro voice; mix: two blended; accent: another language's voice reading English; custom: mixed by someone here. */
  kind: 'voice' | 'mix' | 'accent' | 'custom';
  /** Custom voices only. */
  owner?: { id: number; name: string };
  parts?: MixPart[];
  speed?: number;
  mine?: boolean;
  canDelete?: boolean;
}

/** One ingredient of a mixed voice: a Kokoro voice and its share (1-9). */
export interface MixPart {
  voice: string;
  weight: number;
}
export interface MixRecipe {
  parts: MixPart[];
  speed: number;
}

export interface Conversion {
  id: number;
  ebookId: number | null;
  title: string;
  voice: string;
  multiVoice: boolean;
  status: 'queued' | 'reading' | 'casting' | 'annotating' | 'needs_voices' | 'voicing' | 'revoicing' | 'done' | 'failed' | 'canceled';
  voiceMode: VoiceMode;
  /** Manual mode: Claude's cast list is ready, voices can be picked. */
  castReady: boolean;
  voicesPicked: boolean;
  progress: number;
  detail: string | null;
  costUsd: number;
  audioBookId: number | null;
  error: string | null;
}

export type VoiceMode = 'auto' | 'manual';

export interface ConvertCast {
  narrator: string;
  cast: { name: string; gender: 'female' | 'male' | 'unknown'; age: string }[];
  /** Automatic pick for every part (character names, minor_female, minor_male, narrator). */
  suggested: Record<string, string>;
  picked: Record<string, string>;
}

export interface HeardVoices {
  parts: { part: string; label: string; gender: 'female' | 'male' | 'unknown' | null; voice: string }[];
  lastSpeaker: string | null;
  /** Track indexes still being re-recorded with a new voice. */
  pendingTracks: number[];
}

export interface ConvertEstimate {
  words: number;
  chapters: number;
  quotes: number;
  audioHours: number;
  costLow: number;
  costHigh: number;
  monthSpend: number;
  budget: number;
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
  setKindleEmail: (email: string) =>
    request<{ email: string | null; device: Ereader | null }>('PUT', '/api/me/kindle', { email }),
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
  convertStatus: () =>
    request<{ enabled: boolean; reason?: string; monthSpend?: number; budget?: number }>('GET', '/api/convert/status'),
  ttsVoices: () => request<{ voices: TtsVoice[] }>('GET', '/api/convert/voices'),
  /** A few seconds of an unsaved mix, as an MP3 blob. */
  previewMix: async (recipe: MixRecipe): Promise<Blob> => {
    const res = await fetch('/api/convert/voices/preview', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recipe),
    });
    if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Request failed (${res.status})`, res.status);
    return res.blob();
  },
  createCustomVoice: (voice: MixRecipe & { name: string; gender: 'female' | 'male' }) =>
    request<{ voice: TtsVoice }>('POST', '/api/convert/custom-voices', voice),
  deleteCustomVoice: (id: string) => request<{ ok: true }>('DELETE', `/api/convert/custom-voices/${id.replace(/^cv_/, '')}`),
  convertEstimate: (bookId: number, multiVoice: boolean) =>
    request<{ estimate: ConvertEstimate }>('POST', `/api/books/${bookId}/convert/estimate`, { multiVoice }),
  startConversion: (bookId: number, voice: string, multiVoice: boolean, voiceMode: VoiceMode = 'auto') =>
    request<{ conversion: Conversion }>('POST', `/api/books/${bookId}/convert`, { voice, multiVoice, voiceMode }),
  bookConversion: (bookId: number) => request<{ conversion: Conversion | null }>('GET', `/api/books/${bookId}/convert`),
  cancelConversion: (id: number) => request('DELETE', `/api/convert/${id}`),
  convertCast: (id: number) => request<ConvertCast>('GET', `/api/convert/${id}/cast`),
  setConvertVoices: (id: number, voices: Record<string, string>) =>
    request<{ conversion: Conversion }>('PUT', `/api/convert/${id}/voices`, { voices }),
  bookVoices: (bookId: number, position: number) =>
    request<HeardVoices>('GET', `/api/books/${bookId}/voices?position=${Math.floor(position)}`),
  changeBookVoice: (bookId: number, part: string, voice: string, position: number) =>
    request<{ ok: true }>('PUT', `/api/books/${bookId}/voices`, { part, voice, position }),
  /** Admin: files on the server nobody has added yet. */
  comic: (bookId: number) => request<ComicInfo>('GET', `/api/books/${bookId}/comic`),
  readAlong: (bookId: number) => request<ReadAlongStatus>('GET', `/api/books/${bookId}/readalong`),
  startReadAlong: (bookId: number) => request<ReadAlongStatus>('POST', `/api/books/${bookId}/readalong`, {}),
  readAlongChapter: (bookId: number, n: number) =>
    request<ReadAlongChapter>('GET', `/api/books/${bookId}/readalong/chapters/${n}`),
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
  categories: (kind: DiscoverKind) => request<{ categories: Category[] }>('GET', `/api/discover/categories?kind=${kind}`),
  importBook: (kind: DiscoverKind, id: string, title: string) =>
    // bookId: it was already on the server and is now in your library (no download needed).
    request<{ importId?: number; bookId?: number }>('POST', '/api/discover/import', { kind, id, title }),
  imports: () => request<{ imports: ImportJob[] }>('GET', '/api/imports'),
  retryImport: (id: number) => request('POST', `/api/imports/${id}/retry`, {}),
  dismissImport: (id: number) => request('DELETE', `/api/imports/${id}`),

  wishlistStatus: () =>
    request<{ enabled: boolean; languages: BookLanguage[]; convertEnabled: boolean }>('GET', '/api/wishlist/status'),
  wishlistSearch: (q: string) =>
    request<{ results: WishResult[] }>('GET', `/api/wishlist/search?q=${encodeURIComponent(q)}`),
  wishlist: () => request<{ requests: WishRequest[] }>('GET', '/api/wishlist'),
  wishlistRequest: (r: WishResult, bookType: 'audiobook' | 'ebook', coverUrl?: string | null, language?: string) =>
    request<{ ok: true; addedToLibrary?: number }>('POST', '/api/wishlist', {
      workId: r.workId,
      bookType,
      title: r.title,
      author: r.author,
      coverUrl: coverUrl ?? r.coverUrl,
      year: r.year,
      language,
    }),
  wishlistEditions: (workId: string, lang = 'en') =>
    request<{ editions: Edition[] }>(
      'GET',
      `/api/wishlist/editions?workId=${encodeURIComponent(workId)}&lang=${encodeURIComponent(lang)}`,
    ),
  wishlistReleases: (id: number) => request<{ releases: Release[] }>('GET', `/api/wishlist/${id}/releases`),
  wishlistGrab: (id: number, releaseId: number) => request('POST', `/api/wishlist/${id}/grab`, { releaseId }),
  wishlistRetry: (id: number) => request('POST', `/api/wishlist/${id}/retry`, {}),
  wishlistCancel: (id: number) => request('DELETE', `/api/wishlist/${id}`),
  /** Request the ebook in place of an audiobook nobody had; `bookId` when it was already on the server. */
  wishlistEbookInstead: (id: number, audiobook: boolean) =>
    request<{ ok: true; bookId?: number }>('POST', `/api/wishlist/${id}/ebook-instead`, { audiobook }),

  people: () => request<{ people: PersonSummary[] }>('GET', '/api/people'),
  person: (id: number) => request<{ person: Person }>('GET', `/api/people/${id}`),
  users: () => request<{ users: AdminUser[] }>('GET', '/api/admin/users'),
  createUser: (username: string, password: string, isAdmin: boolean) =>
    request('POST', '/api/admin/users', { username, password, isAdmin }),
  resetUserPassword: (id: number, password: string) => request('POST', `/api/admin/users/${id}/password`, { password }),
  deleteUser: (id: number) => request('DELETE', `/api/admin/users/${id}`),
  scan: () => request<{ result: { added: number; updated: number; removed: number; failed: number } }>('POST', '/api/admin/scan', {}),
  requestsSetup: () => request<RequestsSetup>('GET', '/api/admin/requests'),
  setShelfarrToken: (token: string) => request<{ connected: boolean }>('PUT', '/api/admin/requests/token', { token }),
};

/** Settings → Requests: the bundled apps' admin pages, and whether TurboBooks is connected to Shelfarr. */
export interface RequestsSetup {
  apps: { id: 'shelfarr' | 'prowlarr' | 'qbittorrent'; name: string; path: string }[];
  shelfarr: { configured: boolean; connected: boolean; tokenInEnv: boolean };
}

export const coverUrl = (book: { id: number; hasCover: boolean }) => (book.hasCover ? `/api/books/${book.id}/cover` : null);
/** `version` changes when the file does (e.g. re-recorded with a new voice), so a cached copy is never reused. */
export const streamUrl = (trackId: number, version?: number) => `/api/tracks/${trackId}/stream${version ? `?v=${version}` : ''}`;
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
