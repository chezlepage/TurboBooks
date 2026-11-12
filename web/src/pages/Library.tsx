import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, coverUrl, formatDuration } from '../api';
import type { Book } from '../api';
import { Cover } from '../components/Cover';
import { usePlayer } from '../player/PlayerContext';

type Filter = 'all' | 'unstarted' | 'finished';

export function Library() {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const { book: current } = usePlayer();

  useEffect(() => {
    api
      .books()
      .then((r) => setBooks(r.books))
      .catch((e: Error) => setError(e.message));
    // Refetch when the playing book changes so progress bars are fresh.
  }, [current?.id]);

  const inProgress = useMemo(
    () =>
      (books ?? [])
        .filter((b) => b.progress && !b.progress.finished && b.progress.position > 5)
        .sort((a, b) => b.progress!.updatedAt - a.progress!.updatedAt),
    [books],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (books ?? []).filter((b) => {
      if (q && !`${b.title} ${b.author ?? ''}`.toLowerCase().includes(q)) return false;
      if (filter === 'unstarted') return !b.progress;
      if (filter === 'finished') return !!b.progress?.finished;
      return true;
    });
  }, [books, query, filter]);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!books) return <div className="page"><p className="muted">Loading…</p></div>;

  if (books.length === 0) {
    return (
      <div className="page">
        <h1>Library</h1>
        <div className="empty">
          <p>Your library is empty.</p>
          <p className="muted">Find free classics on LibriVox, or drop audio files in the library folder on the server.</p>
          <Link className="btn btn-primary" to="/discover">
            Find books
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Library</h1>

      {inProgress.length > 0 && !query && (
        <section>
          <h2 className="section-title">Continue listening</h2>
          <div className="shelf">
            {inProgress.map((b) => (
              <BookCard key={b.id} book={b} />
            ))}
          </div>
        </section>
      )}

      <div className="toolbar">
        <input
          className="search-input"
          placeholder="Search your library"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          type="search"
        />
        <div className="segmented">
          {(['all', 'unstarted', 'finished'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'unstarted' ? 'New' : 'Done'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid">
        {shown.map((b) => (
          <BookCard key={b.id} book={b} />
        ))}
      </div>
      {shown.length === 0 && <p className="muted center">Nothing matches.</p>}
    </div>
  );
}

function BookCard({ book }: { book: Book }) {
  const pct = book.progress ? (book.progress.finished ? 100 : (book.progress.position / Math.max(book.duration, 1)) * 100) : 0;
  return (
    <Link to={`/book/${book.id}`} className="book-card">
      <div className="book-card-cover">
        <Cover src={coverUrl(book)} title={book.title} />
        {pct > 0 && (
          <div className="card-progress">
            <div style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="book-card-title">{book.title}</div>
      <div className="book-card-sub">
        {book.author ?? 'Unknown'} · {formatDuration(book.duration)}
      </div>
    </Link>
  );
}
