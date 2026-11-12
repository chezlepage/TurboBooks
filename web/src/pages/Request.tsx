import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { Edition, Release, WishRequest, WishResult } from '../api';
import { Cover } from '../components/Cover';
import { toast } from '../components/Toast';

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

/** Indexer titles often contain HTML entities (&ndash;, &oacute;). Decode without executing anything. */
const decodeEntities = (s: string) => new DOMParser().parseFromString(s, 'text/html').documentElement.textContent ?? s;

const formatSize = (b: number | null) =>
  b ? (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`) : '';

/** Strip of cover art for the different editions of a book; tapping one selects it. */
function EditionStrip({ workId, selected, onPick }: { workId: string; selected: string | null; onPick: (url: string) => void }) {
  const [editions, setEditions] = useState<Edition[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .wishlistEditions(workId)
      .then((r) => setEditions(r.editions))
      .catch(() => setFailed(true));
  }, [workId]);

  if (failed) return <p className="muted small">Couldn't load other covers.</p>;
  if (!editions) return <p className="muted small">Loading covers…</p>;
  if (editions.length === 0) return <p className="muted small">No other covers found for this book.</p>;
  return (
    <div className="edition-strip" role="listbox" aria-label="Covers">
      {editions.map((e) => (
        <button
          key={e.coverUrl}
          type="button"
          role="option"
          aria-selected={selected === e.coverUrl}
          className={`edition ${selected === e.coverUrl ? 'edition-active' : ''}`}
          onClick={() => onPick(e.coverUrl)}
          title={[e.publisher, e.year, e.format].filter(Boolean).join(' · ')}
        >
          <img src={e.thumbUrl} alt="" loading="lazy" />
          <span className="small muted">{e.year ?? ''}</span>
        </button>
      ))}
    </div>
  );
}

/** Lets the user choose which release Shelfarr downloads when it did not pick one itself. */
function ReleasePicker({ id, onDone, onError }: { id: number; onDone: () => void; onError: (m: string) => void }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [grabbing, setGrabbing] = useState<number | null>(null);

  useEffect(() => {
    api
      .wishlistReleases(id)
      .then((r) => setReleases(r.releases))
      .catch((e: Error) => {
        onError(e.message);
        setReleases([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const grab = async (r: Release) => {
    setGrabbing(r.id);
    try {
      await api.wishlistGrab(id, r.id);
      onDone();
    } catch (e) {
      onError((e as Error).message);
      setGrabbing(null);
    }
  };

  if (!releases) return <p className="muted small">Loading options…</p>;
  if (releases.length === 0) return <p className="muted small">No downloadable options.</p>;
  return (
    <ul className="release-list">
      {releases.map((r) => (
        <li key={r.id} className="release">
          <div className="release-text">
            <div className="release-title">{decodeEntities(r.title)}</div>
            <div className="muted small">
              {r.direct && <span className="badge-direct">Direct download</span>}
              {[
                r.source,
                formatSize(r.sizeBytes),
                !r.direct && r.seeders != null ? `${r.seeders} seeders` : '',
                r.language,
                r.confidence != null ? `${Math.round(r.confidence)}% match` : '',
              ]
                .filter(Boolean)
                .join(' · ')
                .replace(/^/, r.direct ? ' · ' : '')}
            </div>
          </div>
          <button className="btn btn-small btn-primary" disabled={grabbing !== null} onClick={() => grab(r)}>
            {grabbing === r.id ? '…' : 'Download'}
          </button>
        </li>
      ))}
    </ul>
  );
}

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
  /** Request whose release list is open. */
  const [picking, setPicking] = useState<number | null>(null);
  /** Cover chosen per work, and which result has its covers strip open. */
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [coversOpen, setCoversOpen] = useState<string | null>(null);

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
      const res = await api.wishlistRequest(r, type, covers[r.workId]);
      if (res.addedToLibrary) toast('Already on the server, added to your library');
      setSent((s) => new Set(s).add(`${r.workId}:${type}`));
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Errors also go to a toast: the error line sits at the top of the page, often scrolled out of view.
  const act = (fn: () => Promise<unknown>, done?: string) => () =>
    fn()
      .then(() => {
        if (done) toast(done);
        refresh();
      })
      .catch((e: Error) => {
        setError(e.message);
        toast(e.message);
      });

  const cancel = (r: WishRequest) => {
    const running = IN_FLIGHT.includes(r.status);
    if (running && !confirm(`Cancel the request for "${r.title}"?`)) return;
    // Optimistic: drop it from the list straight away.
    setRequests((list) => list.filter((x) => x.id !== r.id));
    act(() => api.wishlistCancel(r.id), running ? 'Request cancelled' : 'Removed from the list')();
  };

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
            <div key={r.id} className={`import-row ${picking === r.id ? 'import-row-wide' : ''}`}>
              <Cover src={r.coverUrl} title={r.title} className="request-cover" />
              <div className="import-text">
                <div className="import-title">
                  {r.title} <span className="muted small">({r.bookType})</span>
                </div>
                <div className="muted small">
                  {RETRYABLE.includes(r.status) ? <span className="error">{label(r.status)}</span> : label(r.status)}
                  {r.needsAttention && r.issue ? ` · ${r.issue}` : ''}
                </div>
                {IN_FLIGHT.includes(r.status) && !r.needsAttention && (
                  <div className="bar">
                    <div style={{ width: '35%' }} />
                  </div>
                )}
              </div>
              {r.needsAttention && IN_FLIGHT.includes(r.status) && (
                <button className="btn btn-small btn-primary" onClick={() => setPicking(picking === r.id ? null : r.id)}>
                  {picking === r.id ? 'Hide' : 'Choose'}
                </button>
              )}
              {RETRYABLE.includes(r.status) && (
                <button className="btn btn-small" onClick={act(() => api.wishlistRetry(r.id), 'Trying again')}>
                  Retry
                </button>
              )}
              {r.bookId && (
                <Link className="btn btn-small btn-primary" to={`/book/${r.bookId}`}>
                  Open
                </Link>
              )}
              <button
                className="icon-btn small-x"
                aria-label={IN_FLIGHT.includes(r.status) ? 'Cancel request' : 'Remove from list'}
                title={IN_FLIGHT.includes(r.status) ? 'Cancel request' : 'Remove from list'}
                onClick={() => cancel(r)}
              >
                ×
              </button>
              {picking === r.id && (
                <div className="import-picker">
                  <ReleasePicker
                    id={r.id}
                    onError={setError}
                    onDone={() => {
                      setPicking(null);
                      refresh();
                    }}
                  />
                </div>
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
              <Cover src={covers[r.workId] ?? r.coverUrl} title={r.title} className="result-cover" />
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
                  {r.workId.startsWith('openlibrary:') && (
                    <button
                      className="btn btn-small btn-ghost"
                      onClick={() => setCoversOpen(coversOpen === r.workId ? null : r.workId)}
                    >
                      {coversOpen === r.workId ? 'Hide covers' : 'Covers'}
                    </button>
                  )}
                </div>
                {coversOpen === r.workId && (
                  <EditionStrip
                    workId={r.workId}
                    selected={covers[r.workId] ?? null}
                    onPick={(url) => setCovers((c) => ({ ...c, [r.workId]: url }))}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
