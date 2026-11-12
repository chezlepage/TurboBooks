import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, formatDuration } from '../api';
import type { BookKind, Category, ImportJob, SearchParams, SearchResult } from '../api';
import { Cover } from '../components/Cover';
import { ListSkeleton } from '../components/Skeleton';
import { toast } from '../components/Toast';
import { CheckIcon, PlusIcon } from '../components/Icons';

const LS_ENGLISH = 'tb.discover.english';
const LS_KIND = 'tb.discover.kind';
const RECENT_DONE_MS = 30 * 60 * 1000;

/** Import-queue source name for a search result's catalog. */
const sourceOf = (r: SearchResult) => (r.kind === 'ebook' ? 'gutenberg' : 'archive');

const readEnglish = () => {
  try {
    return localStorage.getItem(LS_ENGLISH) !== '0';
  } catch {
    return true;
  }
};

export function Discover() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<BookKind>(() => {
    try {
      return localStorage.getItem(LS_KIND) === 'ebook' ? 'ebook' : 'audio';
    } catch {
      return 'audio';
    }
  });
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState('bedtime');
  const [query, setQuery] = useState('');
  /** The search actually shown (the input can change without searching). */
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  const [english, setEnglish] = useState(readEnglish);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imports, setImports] = useState<ImportJob[]>([]);
  /** Result shown in the preview sheet. */
  const [preview, setPreview] = useState<SearchResult | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    api
      .categories(kind)
      .then((r) => setCategories(r.categories))
      .catch(() => undefined);
  }, [kind]);

  const pickKind = (k: BookKind) => {
    if (k === kind) return;
    setKind(k);
    setResults(null);
    try {
      localStorage.setItem(LS_KIND, k);
    } catch {
      /* ignore */
    }
  };

  const refreshImports = useCallback(() => {
    api
      .imports()
      .then((r) => setImports(r.imports))
      .catch(() => undefined);
  }, []);

  // Poll faster while something is downloading.
  const active = imports.some((i) => i.status === 'queued' || i.status === 'downloading');
  useEffect(() => {
    refreshImports();
    const id = window.setInterval(refreshImports, active ? 2000 : 15000);
    return () => window.clearInterval(id);
  }, [active, refreshImports]);

  const load = useCallback(async (params: SearchParams, append: boolean) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api.search(params);
      if (id !== requestId.current) return; // a newer request superseded this one
      setResults((prev) => {
        if (!append || !prev) return r.results;
        const have = new Set(prev.map((x) => x.id));
        return [...prev, ...r.results.filter((x) => !have.has(x.id))];
      });
      setHasMore(r.hasMore);
      setPage(params.page ?? 0);
    } catch (e) {
      if (id === requestId.current) setError((e as Error).message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  const currentParams = (pageNo: number): SearchParams =>
    activeQuery ? { kind, q: activeQuery, english, page: pageNo } : { kind, category, english, page: pageNo };

  // Reload when the shelf, search, or language filter changes.
  useEffect(() => {
    void load(currentParams(0), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, category, activeQuery, english, load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q.length >= 2) setActiveQuery(q);
  };

  const clearSearch = () => {
    setQuery('');
    setActiveQuery(null);
  };

  const pickCategory = (id: string) => {
    clearSearch();
    setCategory(id);
  };

  const toggleEnglish = () => {
    const next = !english;
    setEnglish(next);
    try {
      localStorage.setItem(LS_ENGLISH, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const add = async (r: SearchResult) => {
    try {
      const res = await api.importBook(r.kind, r.id, r.title);
      if (res.bookId) {
        // Already on the server: it's in your library right away.
        toast(`“${r.title}” is in your library`);
        setResults((rs) => rs?.map((x) => (x.id === r.id ? { ...x, bookId: res.bookId! } : x)) ?? null);
        return;
      }
      toast(`Adding “${r.title}” to your library`);
      setResults((rs) => rs?.map((x) => (x.id === r.id ? { ...x, importStatus: 'queued' } : x)) ?? null);
      refreshImports();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Library id if this recording is (now) in the library. */
  const bookIdFor = (r: SearchResult) =>
    r.bookId ?? imports.find((i) => i.source === sourceOf(r) && i.sourceId === r.id && i.status === 'done')?.bookId ?? null;
  const isBusy = (r: SearchResult) =>
    imports.some((i) => i.source === sourceOf(r) && i.sourceId === r.id && (i.status === 'queued' || i.status === 'downloading'));

  // Show running and failed jobs, plus ones that finished recently; one row per book.
  const visibleImports = imports
    .filter((i, idx) => imports.findIndex((j) => j.sourceId === i.sourceId) === idx)
    .filter((i) => i.status !== 'done' || Date.now() - i.updatedAt < RECENT_DONE_MS)
    .slice(0, 6);

  return (
    <div className="page">
      <h1>Discover</h1>
      <div className="segmented kind-filter" role="tablist">
        <button role="tab" aria-selected={kind === 'audio'} className={kind === 'audio' ? 'active' : ''} onClick={() => pickKind('audio')}>
          Audiobooks
        </button>
        <button role="tab" aria-selected={kind === 'ebook'} className={kind === 'ebook' ? 'active' : ''} onClick={() => pickKind('ebook')}>
          Ebooks
        </button>
      </div>
      <p className="muted small">
        {kind === 'audio' ? (
          <>
            Free public-domain audiobooks from{' '}
            <a href="https://librivox.org" target="_blank" rel="noreferrer">
              LibriVox
            </a>
            , read by volunteers.
          </>
        ) : (
          <>
            Free public-domain ebooks from{' '}
            <a href="https://www.gutenberg.org" target="_blank" rel="noreferrer">
              Project Gutenberg
            </a>
            .
          </>
        )}{' '}
        Most popular first.
      </p>

      <form className="search-row" onSubmit={submit}>
        <input
          className="search-input"
          type="search"
          placeholder="Search title or author"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value) setActiveQuery(null);
          }}
        />
        <button className="btn btn-primary" disabled={query.trim().length < 2}>
          Search
        </button>
      </form>

      <div className="shelf-chips" role="tablist" aria-label="Categories">
        {categories.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={!activeQuery && category === c.id}
            className={`chip ${!activeQuery && category === c.id ? 'chip-active' : ''}`}
            onClick={() => pickCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <label className="checkbox small">
        <input type="checkbox" checked={english} onChange={toggleEnglish} /> English only
      </label>

      {visibleImports.length > 0 && (
        <section className="imports">
          <h2 className="section-title">Downloads</h2>
          {visibleImports.map((job) => (
            <div key={job.id} className="import-row">
              <div className="import-text">
                <div className="import-title">{job.title}</div>
                <div className="muted small">
                  {job.status === 'queued' && 'Waiting…'}
                  {job.status === 'downloading' && `Downloading ${Math.round(job.progress * 100)}%`}
                  {job.status === 'done' && 'Ready in your library'}
                  {job.status === 'failed' && <span className="error">Failed: {job.error}</span>}
                </div>
                {(job.status === 'downloading' || job.status === 'queued') && (
                  <div className="bar">
                    <div style={{ width: `${Math.max(3, job.progress * 100)}%` }} />
                  </div>
                )}
              </div>
              {job.status === 'done' && job.bookId && (
                <Link className="btn btn-small btn-primary" to={`/book/${job.bookId}`}>
                  {job.source === 'gutenberg' ? 'Read' : 'Listen'}
                </Link>
              )}
              {job.status === 'failed' && (
                <button className="btn btn-small" onClick={() => api.retryImport(job.id).then(refreshImports)}>
                  Retry
                </button>
              )}
              {(job.status === 'done' || job.status === 'failed') && (
                <button
                  className="icon-btn small-x"
                  aria-label="Dismiss"
                  onClick={() => api.dismissImport(job.id).then(refreshImports)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      {error && <p className="error">{error}</p>}

      {activeQuery && (
        <div className="search-label">
          <span>
            Results for <strong>“{activeQuery}”</strong>
          </span>
          <button className="btn btn-small btn-ghost" onClick={clearSearch}>
            Clear
          </button>
        </div>
      )}

      {results && results.length === 0 && !loading && (
        <p className="muted">
          Nothing found. Discover only has free public-domain books. Try fewer words, or turn off "English only".
          {activeQuery && (
            <>
              {' '}
              <Link to={`/request?q=${encodeURIComponent(activeQuery)}`}>Request “{activeQuery}” instead</Link> (any book, audiobook or
              ebook).
            </>
          )}
        </p>
      )}

      {results && (
        <ul className="result-list">
          {results.map((r) => {
            const bookId = bookIdFor(r);
            const busy = isBusy(r);
            return (
              <li key={r.id} className="result">
                <button className="result-open" onClick={() => setPreview(r)} aria-label={`Preview ${r.title}`}>
                  <Cover src={r.coverUrl} title={r.title} className="result-cover" />
                  <div className="result-body">
                    <div className="result-title">{r.title}</div>
                    <div className="muted small">
                      {r.author}
                      {r.durationSecs > 0 && ` · ${formatDuration(r.durationSecs)}`}
                      {r.language && r.language !== 'English' && ` · ${r.language}`}
                    </div>
                    {r.description && <p className="result-desc clamped">{r.description}</p>}
                  </div>
                </button>
                <div className="result-action">
                  {bookId ? (
                    <button className="icon-btn added" onClick={() => navigate(`/book/${bookId}`)} aria-label={`Open ${r.title}`}>
                      <CheckIcon size={22} />
                    </button>
                  ) : busy ? (
                    <span className="spinner small" aria-label="Downloading" />
                  ) : (
                    <button className="icon-btn add-btn" onClick={() => add(r)} aria-label={`Add ${r.title}`}>
                      <PlusIcon size={22} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {preview && (
        <PreviewSheet
          r={preview}
          bookId={bookIdFor(preview)}
          busy={isBusy(preview)}
          onAdd={() => void add(preview)}
          onOpen={(id) => navigate(`/book/${id}`)}
          onClose={() => setPreview(null)}
        />
      )}

      {loading && (!results || results.length === 0) && <ListSkeleton />}
      {loading && results && results.length > 0 && <p className="muted center">Loading…</p>}
      {!loading && hasMore && results && results.length > 0 && (
        <div className="center load-more">
          <button className="btn" onClick={() => void load(currentParams(page + 1), true)}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

/** A closer look at a search result before adding it. */
function PreviewSheet({
  r,
  bookId,
  busy,
  onAdd,
  onOpen,
  onClose,
}: {
  r: SearchResult;
  bookId: number | null;
  busy: boolean;
  onAdd: () => void;
  onOpen: (id: number) => void;
  onClose: () => void;
}) {
  const facts = [
    r.kind === 'ebook' ? 'Ebook' : 'Audiobook',
    r.durationSecs > 0 ? formatDuration(r.durationSecs) : null,
    r.language || null,
    r.kind === 'ebook' ? 'Project Gutenberg' : 'LibriVox',
  ].filter(Boolean) as string[];
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet preview-sheet" role="dialog" aria-label={r.title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="preview-head">
          <Cover src={r.coverUrl} title={r.title} author={r.author} className="preview-cover" />
          <div className="preview-meta">
            <h2 className="preview-title">{r.title}</h2>
            <p className="author">{r.author}</p>
            <ul className="stat-chips">
              {facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        </div>
        {r.description ? (
          <p className="preview-desc">{r.description}</p>
        ) : (
          <p className="muted small">No description available.</p>
        )}
        <div className="preview-actions">
          {bookId ? (
            <button className="btn btn-primary btn-block" onClick={() => onOpen(bookId)}>
              In your library: open
            </button>
          ) : busy ? (
            <button className="btn btn-block" disabled>
              Downloading…
            </button>
          ) : (
            <button
              className="btn btn-primary btn-block"
              onClick={() => {
                onAdd();
                onClose();
              }}
            >
              Add to my library
            </button>
          )}
          <a className="btn btn-ghost btn-block" href={r.sourceUrl} target="_blank" rel="noreferrer">
            View on {r.kind === 'ebook' ? 'Project Gutenberg' : 'the Internet Archive'}
          </a>
        </div>
      </div>
    </div>
  );
}
