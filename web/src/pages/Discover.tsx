import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDuration } from '../api';
import type { ImportJob, SearchResult } from '../api';
import { Cover } from '../components/Cover';
import { CheckIcon, PlusIcon } from '../components/Icons';

const SUGGESTIONS = ['Sherlock Holmes', 'Jane Austen', 'Dracula', 'Jules Verne', 'Winnie', 'Fairy tales', 'Lovecraft', 'Dickens'];

export function Discover() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imports, setImports] = useState<ImportJob[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

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

  const runSearch = async (q: string) => {
    if (q.trim().length < 2) return;
    setQuery(q);
    setSearching(true);
    setError(null);
    try {
      setResults((await api.search(q)).results);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void runSearch(query);
  };

  const add = async (r: SearchResult) => {
    try {
      await api.importBook(r.id, r.title);
      setResults((rs) => rs?.map((x) => (x.id === r.id ? { ...x, importStatus: 'queued' } : x)) ?? null);
      refreshImports();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const statusFor = (r: SearchResult) => {
    const job = imports.find((i) => i.sourceId === r.id && i.status !== 'failed');
    if (r.inLibrary || job?.status === 'done') return 'done';
    if (job) return 'busy';
    return null;
  };

  const visibleImports = imports.slice(0, 8);

  return (
    <div className="page">
      <h1>Discover</h1>
      <p className="muted small">
        Free public-domain audiobooks from <a href="https://librivox.org" target="_blank" rel="noreferrer">LibriVox</a>,
        read by volunteers, downloaded from the Internet Archive. Most popular first.
      </p>

      <form className="search-row" onSubmit={submit}>
        <input
          className="search-input"
          type="search"
          placeholder="Title or author"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn-primary" disabled={searching || query.trim().length < 2}>
          {searching ? '…' : 'Search'}
        </button>
      </form>

      {!results && !searching && (
        <div className="chips">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => void runSearch(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

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
                  {job.status === 'done' && 'In your library'}
                  {job.status === 'failed' && <span className="error">Failed: {job.error}</span>}
                </div>
                {job.status === 'downloading' && (
                  <div className="bar">
                    <div style={{ width: `${Math.max(3, job.progress * 100)}%` }} />
                  </div>
                )}
              </div>
              {job.status === 'done' && job.bookId && (
                <Link className="btn btn-small" to={`/book/${job.bookId}`}>
                  Open
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
      {searching && <p className="muted">Searching…</p>}

      {results && !searching && (
        <section>
          <h2 className="section-title">
            {results.length} result{results.length === 1 ? '' : 's'}
          </h2>
          {results.length === 0 && <p className="muted">Nothing found. Try fewer words or just the author's name.</p>}
          <ul className="result-list">
            {results.map((r) => {
              const status = statusFor(r);
              const open = expanded === r.id;
              return (
                <li key={r.id} className="result">
                  <Cover src={r.coverUrl} title={r.title} className="result-cover" />
                  <div className="result-body">
                    <div className="result-title">{r.title}</div>
                    <div className="muted small">
                      {r.author}
                      {r.durationSecs > 0 && ` · ${formatDuration(r.durationSecs)}`}
                      {r.language && r.language !== 'English' && ` · ${r.language}`}
                    </div>
                    {r.description && (
                      <p className={`result-desc ${open ? '' : 'clamped'}`} onClick={() => setExpanded(open ? null : r.id)}>
                        {r.description}
                      </p>
                    )}
                  </div>
                  <div className="result-action">
                    {status === 'done' ? (
                      <span className="added" aria-label="In library">
                        <CheckIcon size={22} />
                      </span>
                    ) : status === 'busy' ? (
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
        </section>
      )}
    </div>
  );
}
