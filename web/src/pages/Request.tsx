import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { WishRequest, WishResult } from '../api';
import { Cover } from '../components/Cover';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting',
  searching: 'Searching',
  found: 'Found a source',
  downloading: 'Downloading',
  processing: 'Adding to library',
  completed: 'Done, appears in your library shortly',
  not_found: 'Not found',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const label = (s: string) => STATUS_LABEL[s] ?? s.replace(/_/g, ' ');
const IN_FLIGHT = ['pending', 'searching', 'found', 'downloading', 'processing'];
const RETRYABLE = ['failed', 'not_found'];

export function Request() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [params] = useSearchParams();
  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const [results, setResults] = useState<WishResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<WishRequest[]>([]);
  /** workId:type pairs requested this session, so the button flips immediately. */
  const [sent, setSent] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    api
      .wishlist()
      .then((r) => setRequests(r.requests))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .wishlistStatus()
      .then((r) => setEnabled(r.enabled))
      .catch(() => setEnabled(false));
  }, []);

  const busy = requests.some((r) => IN_FLIGHT.includes(r.status));
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = window.setInterval(refresh, busy ? 5000 : 20000);
    return () => window.clearInterval(id);
  }, [enabled, busy, refresh]);

  const runSearch = async (q: string) => {
    if (q.length < 2) return;
    setSearching(true);
    setError(null);
    try {
      setResults((await api.wishlistSearch(q)).results);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void runSearch(query.trim());
  };

  // Arriving from Discover with a search: run it straight away.
  useEffect(() => {
    if (enabled && query.trim().length >= 2 && results === null) void runSearch(query.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const request = async (r: WishResult, type: 'audiobook' | 'ebook') => {
    setError(null);
    try {
      await api.wishlistRequest(r, type);
      setSent((s) => new Set(s).add(`${r.workId}:${type}`));
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const act = (fn: () => Promise<unknown>) => () =>
    fn()
      .then(refresh)
      .catch((e: Error) => setError(e.message));

  if (enabled === null) return <div className="page" />;
  if (!enabled) {
    return (
      <div className="page">
        <h1>Request</h1>
        <p className="muted">
          Requests are not set up yet. An admin needs to set <code>SHELFARR_URL</code> and <code>SHELFARR_TOKEN</code> in the server's
          .env.
        </p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Request</h1>
      <p className="muted small">
        Can't find a book? Search any title and request it as an audiobook or ebook. It downloads automatically and shows up in your
        library.
      </p>

      <form className="search-row" onSubmit={submit}>
        <input
          className="search-input"
          type="search"
          placeholder="Search title or author"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn-primary" disabled={query.trim().length < 2 || searching}>
          Search
        </button>
      </form>

      {error && <p className="error">{error}</p>}
      {searching && <p className="muted center">Searching…</p>}

      {requests.length > 0 && (
        <section className="imports">
          <h2 className="section-title">Your requests</h2>
          {requests.slice(0, 15).map((r) => (
            <div key={r.id} className="import-row">
              <div className="import-text">
                <div className="import-title">
                  {r.title} <span className="muted small">({r.bookType})</span>
                </div>
                <div className="muted small">
                  {RETRYABLE.includes(r.status) ? <span className="error">{label(r.status)}</span> : label(r.status)}
                  {r.needsAttention && r.issue ? ` · ${r.issue}` : ''}
                </div>
                {IN_FLIGHT.includes(r.status) && (
                  <div className="bar">
                    <div style={{ width: '35%' }} />
                  </div>
                )}
              </div>
              {RETRYABLE.includes(r.status) && (
                <button className="btn btn-small" onClick={act(() => api.wishlistRetry(r.id))}>
                  Retry
                </button>
              )}
              {r.status !== 'completed' && r.status !== 'cancelled' && (
                <button className="icon-btn small-x" aria-label="Cancel request" onClick={act(() => api.wishlistCancel(r.id))}>
                  ×
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      {results && results.length === 0 && !searching && <p className="muted">Nothing found. Try the author's name or fewer words.</p>}

      {results && (
        <ul className="result-list">
          {results.map((r) => (
            <li key={r.workId} className="result">
              <Cover src={r.coverUrl} title={r.title} className="result-cover" />
              <div className="result-body">
                <div className="result-title">{r.title}</div>
                <div className="muted small">
                  {r.author}
                  {r.year ? ` · ${r.year}` : ''}
                  {r.series ? ` · ${r.series}` : ''}
                </div>
                <div className="request-actions">
                  {(['audiobook', 'ebook'] as const).map((t) => {
                    const done = sent.has(`${r.workId}:${t}`);
                    return (
                      <button key={t} className="btn btn-small" disabled={done} onClick={() => request(r, t)}>
                        {done ? 'Requested' : t === 'audiobook' ? 'Request audiobook' : 'Request ebook'}
                      </button>
                    );
                  })}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
