/** Thin client for Shelfarr's REST API (/api/v1). The token never leaves the server. */
import { config } from '../config.js';

export class ShelfarrError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

export const shelfarrEnabled = () => Boolean(config.shelfarrUrl && config.shelfarrToken);

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!shelfarrEnabled()) throw new ShelfarrError('Requests are not set up on this server', 503);
  let res: Response;
  try {
    res = await fetch(`${config.shelfarrUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.shelfarrToken}`,
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
    throw new ShelfarrError(msg, res.status === 401 || res.status === 403 ? 502 : res.status);
  }
  return data as T;
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
  book: { title: string; author: string | null; book_type: string };
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
