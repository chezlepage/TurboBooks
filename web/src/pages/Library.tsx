import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, coverUrl, formatDuration } from '../api';
import type { Book, BookDetail } from '../api';
import { Cover } from '../components/Cover';
import { BooksIcon, PlayIcon, SearchIcon } from '../components/Icons';
import { GridSkeleton } from '../components/Skeleton';
import { useAuth } from '../auth';
import { celebrateFinish } from '../components/FinishedSheet';
import { toast } from '../components/Toast';
import { usePlayer } from '../player/PlayerContext';
import { setBookHidden, usePrefs } from '../prefs';

type Shelf = 'all' | 'audio' | 'ebook' | 'reading' | 'finished';

const SHELVES: { id: Shelf; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'audio', label: 'Audiobooks' },
  { id: 'ebook', label: 'Ebooks' },
  { id: 'reading', label: 'In progress' },
  { id: 'finished', label: 'Finished' },
];
const LS_SHELF = 'tb.library.shelf';
const LS_SORT = 'tb.library.sort';

type Sort = 'recent' | 'added' | 'title' | 'author';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'recent', label: 'Recently played' },
  { id: 'added', label: 'Recently added' },
  { id: 'title', label: 'Title' },
  { id: 'author', label: 'Author' },
];

/** "The Tale of..." sorts under T-a-l-e; authors sort by last name. */
const sortTitle = (t: string) =>
  t
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '') // leading quotes/punctuation
    .replace(/^(the|a|an)\s+/, '');
const sortAuthor = (a: string | null) => (a ?? '').trim().split(/\s+/).pop()?.toLowerCase() ?? '';

function sortBooks(list: Book[], sort: Sort): Book[] {
  const out = [...list];
  switch (sort) {
    case 'recent':
      return out.sort((a, b) => (b.progress?.updatedAt ?? 0) - (a.progress?.updatedAt ?? 0) || b.addedAt - a.addedAt);
    case 'added':
      return out.sort((a, b) => b.addedAt - a.addedAt);
    case 'author':
      return out.sort((a, b) => sortAuthor(a.author).localeCompare(sortAuthor(b.author)) || sortTitle(a.title).localeCompare(sortTitle(b.title)));
    default:
      return out.sort((a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title)));
  }
}

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
  const [sort, setSortState] = useState<Sort>(() => {
    try {
      const v = localStorage.getItem(LS_SORT) as Sort | null;
      return v && SORTS.some((x) => x.id === v) ? v : 'recent';
    } catch {
      return 'recent';
    }
  });
  const setSort = (v: Sort) => {
    setSortState(v);
    try {
      localStorage.setItem(LS_SORT, v);
    } catch {
      /* ignore */
    }
  };
  /** Book whose quick-actions sheet is open (long-press or right-click). */
  const [actionBook, setActionBook] = useState<Book | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = () => setReloadTick((t) => t + 1);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.book?.id, reloadTick]);

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
    const filtered = (books ?? []).filter((b) => {
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
    return sortBooks(filtered, sort);
  }, [books, query, shelf, sort]);

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
                  <BookCard key={b.id} book={b} onActions={setActionBook} />
                ))}
              </div>
            </section>
          )}

          {!browsing && recentlyAdded.length > 0 && books.length > 6 && (
            <section>
              <h2 className="section-title">Recently added</h2>
              <div className="shelf">
                {recentlyAdded.map((b) => (
                  <BookCard key={b.id} book={b} onActions={setActionBook} />
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
              <label className="sort-field">
                <span className="muted small">Sort</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort books">
                  {SORTS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
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
                <BookCard key={b.id} book={b} onActions={setActionBook} />
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
              <BookCard key={b.id} book={b} onActions={setActionBook} />
            ))}
          </div>
        </section>
      )}
      {actionBook && <QuickActions book={actionBook} onClose={() => setActionBook(null)} onChanged={reload} />}
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

/** Long-press (phones) or right-click (desktop) opens quick actions instead of the book. */
function useLongPress(onLongPress: () => void, ms = 480) {
  const timer = useRef<number>();
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const cancel = () => window.clearTimeout(timer.current);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(12);
        onLongPress();
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      // Scrolling the shelf shouldn't count as a long-press.
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      cancel();
      fired.current = true;
      onLongPress();
    },
    /** Swallow the click that follows a long-press so it doesn't also open the book. */
    onClickCapture: (e: ReactMouseEvent) => {
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
      }
    },
  };
}

function BookCard({ book, onActions }: { book: Book; onActions?: (b: Book) => void }) {
  const pct = Math.round(fraction(book) * 100);
  const press = useLongPress(() => onActions?.(book));
  return (
    <Link to={`/book/${book.id}`} className="book-card" {...(onActions ? press : {})}>
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

/** Quick actions for a book, without opening it. */
function QuickActions({ book, onClose, onChanged }: { book: Book; onClose: () => void; onChanged: () => void }) {
  const navigate = useNavigate();
  const player = usePlayer();
  const [prefs] = usePrefs();
  const isEbook = book.kind === 'ebook';
  const hidden = prefs.hiddenBooks.includes(book.id);
  const finished = !!book.progress?.finished;

  const run = async (fn: () => Promise<void> | void) => {
    onClose();
    await fn();
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet quick-sheet" role="dialog" aria-label={`${book.title} actions`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="quick-head">
          <Cover src={coverUrl(book)} title={book.title} author={book.author} className="quick-cover" />
          <div>
            <div className="quick-title">{book.title}</div>
            <div className="muted small">
              {book.author ?? 'Unknown author'} · {progressLabel(book)}
            </div>
          </div>
        </div>
        <div className="quick-actions">
          <button
            className="btn btn-primary btn-block"
            onClick={() =>
              void run(() => {
                if (isEbook) navigate(`/read/${book.id}`);
                else {
                  void player.open(book.id, { autoplay: true });
                  navigate('/player');
                }
              })
            }
          >
            {isEbook ? (isStarted(book) ? 'Continue reading' : 'Read') : isStarted(book) ? 'Resume' : 'Play'}
          </button>
          <button className="btn btn-block" onClick={() => void run(() => navigate(`/book/${book.id}`))}>
            Details
          </button>
          {!finished && (
            <button
              className="btn btn-block"
              onClick={() =>
                void run(async () => {
                  await api.saveProgress(book.id, isEbook ? 1 : book.duration, true);
                  if (player.book?.id === book.id) player.close();
                  celebrateFinish(book);
                  onChanged();
                })
              }
            >
              Mark as finished
            </button>
          )}
          <button
            className="btn btn-block"
            onClick={() =>
              void run(() => {
                setBookHidden(book.id, !hidden);
                toast(hidden ? 'Visible on your profile again' : 'Hidden from your profile');
              })
            }
          >
            {hidden ? 'Show on my profile' : 'Hide from my profile'}
          </button>
          <button
            className="btn btn-block btn-ghost danger"
            onClick={() =>
              void run(async () => {
                if (!confirm(`Remove "${book.title}" from your library?`)) return;
                if (player.book?.id === book.id) player.close();
                await api.removeFromLibrary(book.id);
                toast('Removed from your library');
                onChanged();
              })
            }
          >
            Remove from my library
          </button>
        </div>
      </div>
    </div>
  );
}
