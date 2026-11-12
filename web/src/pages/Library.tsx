import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, coverUrl, formatDuration } from '../api';
import type { Book, BookDetail } from '../api';
import { Cover } from '../components/Cover';
import { BooksIcon, PlayIcon, SearchIcon } from '../components/Icons';
import { GridSkeleton } from '../components/Skeleton';
import { useAuth } from '../auth';
import { usePlayer } from '../player/PlayerContext';

type Shelf = 'all' | 'audio' | 'ebook' | 'reading' | 'finished';

const SHELVES: { id: Shelf; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'audio', label: 'Audiobooks' },
  { id: 'ebook', label: 'Ebooks' },
  { id: 'reading', label: 'In progress' },
  { id: 'finished', label: 'Finished' },
];
const LS_SHELF = 'tb.library.shelf';

const isStarted = (b: Book) => !!b.progress && !b.progress.finished && b.progress.position > (b.kind === 'ebook' ? 0.005 : 5);

/** "23 min left" for audio, "42% read" for ebooks. */
function progressLabel(b: Book): string {
  if (b.progress?.finished) return 'Finished';
  if (!isStarted(b)) return b.kind === 'ebook' ? 'Ebook' : formatDuration(b.duration);
  return b.kind === 'ebook'
    ? `${Math.round(b.progress!.position * 100)}% read`
    : `${formatDuration(b.duration - b.progress!.position)} left`;
}

const fraction = (b: Book) =>
  b.progress ? (b.progress.finished ? 1 : b.kind === 'ebook' ? b.progress.position : b.progress.position / Math.max(b.duration, 1)) : 0;

function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 5 || h >= 21) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function Library() {
  const [books, setBooks] = useState<Book[] | null>(null);
  /** Admins: files on the server nobody has added to their library yet. */
  const [unclaimed, setUnclaimed] = useState<Book[]>([]);
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [shelf, setShelfState] = useState<Shelf>(() => {
    try {
      const s = localStorage.getItem(LS_SHELF) as Shelf | null;
      return s && SHELVES.some((x) => x.id === s) ? s : 'all';
    } catch {
      return 'all';
    }
  });
  const player = usePlayer();

  const setShelf = (s: Shelf) => {
    setShelfState(s);
    try {
      localStorage.setItem(LS_SHELF, s);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    api
      .books()
      .then((r) => setBooks(r.books))
      .catch((e: Error) => setError(e.message));
    if (user?.isAdmin) {
      api
        .unclaimedBooks()
        .then((r) => setUnclaimed(r.books))
        .catch(() => undefined);
    }
    // Refetch when the playing book changes so progress is fresh.
  }, [player.book?.id]);

  const inProgress = useMemo(
    () => (books ?? []).filter(isStarted).sort((a, b) => b.progress!.updatedAt - a.progress!.updatedAt),
    [books],
  );
  const recentlyAdded = useMemo(
    () => [...(books ?? [])].filter((b) => !b.progress).sort((a, b) => b.addedAt - a.addedAt).slice(0, 12),
    [books],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (books ?? []).filter((b) => {
      if (q && !`${b.title} ${b.author ?? ''}`.toLowerCase().includes(q)) return false;
      switch (shelf) {
        case 'audio':
          return b.kind === 'audio';
        case 'ebook':
          return b.kind === 'ebook';
        case 'reading':
          return isStarted(b);
        case 'finished':
          return !!b.progress?.finished;
        default:
          return true;
      }
    });
  }, [books, query, shelf]);

  if (error) {
    return (
      <div className="page">
        <p className="error">{error}</p>
      </div>
    );
  }

  const hero = inProgress[0];
  const browsing = query.trim() !== '';

  return (
    <div className="page library">
      <header className="page-header">
        <p className="kicker">{greeting()}</p>
        <h1>Library</h1>
      </header>

      {!books && <GridSkeleton />}

      {books && books.length === 0 && (
        <div className="empty-state">
          <BooksIcon size={40} />
          <h2>Your shelves are empty</h2>
          <p className="muted">Add free classics from Discover, audiobooks or ebooks. Files you copy into the library folder show up here too.</p>
          <Link className="btn btn-primary" to="/discover">
            Find something to read
          </Link>
        </div>
      )}

      {books && books.length > 0 && (
        <>
          {hero && !browsing && <ContinueCard book={hero} />}

          {!browsing && inProgress.length > 1 && (
            <section>
              <h2 className="section-title">Also in progress</h2>
              <div className="shelf">
                {inProgress.slice(1).map((b) => (
                  <BookCard key={b.id} book={b} />
                ))}
              </div>
            </section>
          )}

          {!browsing && recentlyAdded.length > 0 && books.length > 6 && (
            <section>
              <h2 className="section-title">Recently added</h2>
              <div className="shelf">
                {recentlyAdded.map((b) => (
                  <BookCard key={b.id} book={b} />
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="library-tools">
              <h2 className="section-title">All books</h2>
              <label className="search-field">
                <SearchIcon size={18} />
                <input
                  type="search"
                  placeholder="Search your library"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search your library"
                />
              </label>
            </div>
            <div className="shelf-chips" role="tablist" aria-label="Filter">
              {SHELVES.map((s) => (
                <button
                  key={s.id}
                  role="tab"
                  aria-selected={shelf === s.id}
                  className={`chip ${shelf === s.id ? 'chip-active' : ''}`}
                  onClick={() => setShelf(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="grid">
              {shown.map((b) => (
                <BookCard key={b.id} book={b} />
              ))}
            </div>
            {shown.length === 0 && <p className="muted center empty-inline">Nothing here yet.</p>}
          </section>
        </>
      )}
      {unclaimed.length > 0 && (
        <section className="unclaimed">
          <h2 className="section-title">Unclaimed on the server</h2>
          <p className="muted small">
            Files on the server that nobody has added yet (only admins see this). Open one and tap “Add to my library”.
          </p>
          <div className="shelf">
            {unclaimed.map((b) => (
              <BookCard key={b.id} book={b} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Big "pick up where you left off" card for the most recent book. */
function ContinueCard({ book }: { book: Book }) {
  const navigate = useNavigate();
  const player = usePlayer();
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const isEbook = book.kind === 'ebook';
  const isLoaded = !isEbook && player.book?.id === book.id;

  // Fetch the audio details ahead of time so tapping Resume can start playback immediately
  // (iOS only allows audio to start directly from a tap).
  useEffect(() => {
    if (isEbook || isLoaded) return;
    let live = true;
    api
      .book(book.id)
      .then((r) => live && setDetail(r.book))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [book.id, isEbook, isLoaded]);

  const resume = () => {
    if (isEbook) return navigate(`/read/${book.id}`);
    if (isLoaded) player.play();
    else void player.open(detail ?? book.id, { autoplay: true });
    navigate('/player');
  };

  return (
    <section className="continue-card">
      <Link to={`/book/${book.id}`} className="continue-cover" aria-label={`${book.title} details`}>
        <Cover src={coverUrl(book)} title={book.title} author={book.author} />
      </Link>
      <div className="continue-body">
        <p className="kicker">{isEbook ? 'Continue reading' : 'Continue listening'}</p>
        <h2 className="continue-title">{book.title}</h2>
        {book.author && <p className="muted">{book.author}</p>}
        <div className="progress-line" aria-label={progressLabel(book)}>
          <div style={{ width: `${Math.round(fraction(book) * 100)}%` }} />
        </div>
        <p className="muted small">{progressLabel(book)}</p>
        <button className="btn btn-primary" onClick={resume}>
          {isEbook ? <BooksIcon size={18} /> : <PlayIcon size={18} />} {isEbook ? 'Read' : 'Resume'}
        </button>
      </div>
    </section>
  );
}

function BookCard({ book }: { book: Book }) {
  const pct = Math.round(fraction(book) * 100);
  return (
    <Link to={`/book/${book.id}`} className="book-card">
      <div className="book-card-cover">
        <Cover src={coverUrl(book)} title={book.title} author={book.author} />
        {book.kind === 'ebook' && <span className="kind-badge">Ebook</span>}
        {pct > 0 && (
          <div className="card-progress">
            <div style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="book-card-title">{book.title}</div>
      <div className="book-card-sub">
        {book.author ?? 'Unknown author'} · {progressLabel(book)}
      </div>
    </Link>
  );
}
