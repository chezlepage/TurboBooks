/** Thin client for Shelfarr's REST API (/api/v1). The token never leaves the server. */
import { config } from '../config.js';
import { getSetting } from '../db.js';

/** The token from .env wins; otherwise the one an admin pasted in Settings. */
export const shelfarrToken = () => config.shelfarrToken || getSetting('shelfarr_token') || '';

export class ShelfarrError extends Error {
  constructor(
    message: string,
    public status = 502,
    /** Shelfarr's own HTTP status, when it answered. */
    public upstream?: number,
  ) {
    super(message);
  }
}

export const shelfarrEnabled = () => Boolean(config.shelfarrUrl && shelfarrToken());

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!shelfarrEnabled()) throw new ShelfarrError('Requests are not set up on this server', 503);
  let res: Response;
  try {
    res = await fetch(`${config.shelfarrUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${shelfarrToken()}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ShelfarrError('Shelfarr is not responding');
  }
  const data = (await res.json().catch(() => null)) as { errors?: string[] } | null;
  if (!res.ok) {
    const msg = data?.errors?.join(', ') || `Shelfarr error (${res.status})`;
    throw new ShelfarrError(msg, res.status === 401 || res.status === 403 ? 502 : res.status, res.status);
  }
  return data as T;
}

/** Checks a token before saving it: 'ok', 'bad-token', or 'unreachable'. */
export async function checkToken(token: string): Promise<'ok' | 'bad-token' | 'unreachable'> {
  if (!config.shelfarrUrl) return 'unreachable';
  try {
    const res = await fetch(`${config.shelfarrUrl}/api/v1/requests`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return 'bad-token';
    return res.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export interface MetaResult {
  work_id: string;
  title: string;
  author: string | null;
  year: number | string | null;
  cover_url: string | null;
  has_audiobook?: boolean;
  has_ebook?: boolean;
  content_kind?: string;
  series_name?: string | null;
  source_name?: string;
  available_book_types?: string[];
}

export interface ShelfarrRequest {
  id: number;
  status: string;
  attention_needed: boolean;
  issue_description: string | null;
  created_at: string;
  updated_at: string;
  request: { external_source: string | null; created_via: string };
  book: { title: string; author: string | null; book_type: string; work_id?: string | null };
}

export const search = (q: string) =>
  call<{ results: MetaResult[] }>('GET', `/search?q=${encodeURIComponent(q)}&limit=20&content_kind=book`);

export const listRequests = () => call<{ requests: ShelfarrRequest[] }>('GET', '/requests?limit=100');

export const createRequest = (body: Record<string, unknown>) =>
  call<{ requests: ShelfarrRequest[]; errors: string[]; warnings: string[] }>('POST', '/requests', {
    ...body,
    external_source: 'turbobooks',
  });

export const retryRequest = (id: number) => call<ShelfarrRequest>('POST', `/requests/${id}/retry`);
export const cancelRequest = (id: number) => call<ShelfarrRequest>('DELETE', `/requests/${id}`);

export interface ShelfarrRelease {
  id: number;
  title: string;
  source: string | null;
  indexer: string | null;
  seeders: number | null;
  size_bytes: number | null;
  confidence_score: number | null;
  detected_language: string | null;
  status: string;
  downloadable: boolean;
  blocklisted: boolean;
}

export const releases = (id: number) =>
  call<{ search_results: ShelfarrRelease[] }>('GET', `/requests/${id}/search_results`);

export const grabRelease = (id: number, searchResultId: number) =>
  call<unknown>('POST', `/requests/${id}/grab`, { search_result_id: searchResultId });

export interface Edition {
  coverId: number;
  year: string | null;
  publisher: string | null;
  format: string | null;
}

/**
 * Book languages Shelfarr can search for (its ReleaseParserService::LANGUAGES), with their
 * own-language names for the picker and Open Library's MARC codes for edition covers.
 */
export const BOOK_LANGUAGES = [
  { code: 'en', name: 'English', marc: 'eng' },
  { code: 'fr', name: 'Français', marc: 'fre' },
  { code: 'es', name: 'Español', marc: 'spa' },
  { code: 'de', name: 'Deutsch', marc: 'ger' },
  { code: 'it', name: 'Italiano', marc: 'ita' },
  { code: 'pt', name: 'Português', marc: 'por' },
  { code: 'pt-BR', name: 'Português (Brasil)', marc: 'por' },
  { code: 'nl', name: 'Nederlands', marc: 'dut' },
  { code: 'sv', name: 'Svenska', marc: 'swe' },
  { code: 'da', name: 'Dansk', marc: 'dan' },
  { code: 'no', name: 'Norsk', marc: 'nor' },
  { code: 'fi', name: 'Suomi', marc: 'fin' },
  { code: 'pl', name: 'Polski', marc: 'pol' },
  { code: 'cs', name: 'Čeština', marc: 'cze' },
  { code: 'hu', name: 'Magyar', marc: 'hun' },
  { code: 'ro', name: 'Română', marc: 'rum' },
  { code: 'el', name: 'Ελληνικά', marc: 'gre' },
  { code: 'bg', name: 'Български', marc: 'bul' },
  { code: 'uk', name: 'Українська', marc: 'ukr' },
  { code: 'ru', name: 'Русский', marc: 'rus' },
  { code: 'tr', name: 'Türkçe', marc: 'tur' },
  { code: 'ar', name: 'العربية', marc: 'ara' },
  { code: 'he', name: 'עברית', marc: 'heb' },
  { code: 'hi', name: 'हिन्दी', marc: 'hin' },
  { code: 'th', name: 'ไทย', marc: 'tha' },
  { code: 'vi', name: 'Tiếng Việt', marc: 'vie' },
  { code: 'zh', name: '中文', marc: 'chi' },
  { code: 'ja', name: '日本語', marc: 'jpn' },
  { code: 'ko', name: '한국어', marc: 'kor' },
] as const;
export const LANGUAGE_CODES = BOOK_LANGUAGES.map((l) => l.code) as [string, ...string[]];

const editionCache = new Map<string, { at: number; editions: Edition[] }>();

/** Distinct cover images for a work's editions in one language, from Open Library (Shelfarr's search has no edition data). */
export async function editions(workId: string, lang = 'en'): Promise<Edition[]> {
  const m = /^openlibrary:(OL\d+W)$/.exec(workId);
  if (!m) return [];
  const marc = `/languages/${BOOK_LANGUAGES.find((l) => l.code === lang)?.marc ?? 'eng'}`;
  const key = `${m[1]}:${marc}`;
  const hit = editionCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.editions;
  let data: { entries?: Array<Record<string, unknown>> };
  try {
    const res = await fetch(`https://openlibrary.org/works/${m[1]}/editions.json?limit=100`, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(String(res.status));
    data = (await res.json()) as typeof data;
  } catch {
    throw new ShelfarrError('Could not load editions, try again in a bit');
  }
  const seen = new Set<number>();
  const out: Edition[] = [];
  for (const e of data.entries ?? []) {
    const covers = (e.covers as number[] | undefined)?.filter((c) => c > 0) ?? [];
    const langs = (e.languages as Array<{ key: string }> | undefined)?.map((l) => l.key) ?? [];
    if (!covers.length || seen.has(covers[0])) continue;
    if (langs.length && !langs.includes(marc)) continue; // editions in the chosen language only
    seen.add(covers[0]);
    out.push({
      coverId: covers[0],
      year: typeof e.publish_date === 'string' ? e.publish_date.match(/\d{4}/)?.[0] ?? null : null,
      publisher: (e.publishers as string[] | undefined)?.[0] ?? null,
      format: typeof e.physical_format === 'string' ? e.physical_format : null,
    });
    if (out.length >= 30) break;
  }
  editionCache.set(key, { at: Date.now(), editions: out });
  return out;
}
