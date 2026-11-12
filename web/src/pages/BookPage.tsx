import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, coverUrl, formatDuration, formatTime } from '../api';
import type { BookDetail, KindleSettings } from '../api';
import { useAuth } from '../auth';
import { Cover } from '../components/Cover';
import { BooksIcon, ChevronLeftIcon, PauseIcon, PlayIcon } from '../components/Icons';
import { BookSkeleton } from '../components/Skeleton';
import { toast } from '../components/Toast';
import { chapterAt, useClock, usePlayer } from '../player/PlayerContext';
import { setBookHidden, usePrefs } from '../prefs';

const SOURCE_LABELS: Record<string, string> = {
  archive: 'LibriVox',
  gutenberg: 'Project Gutenberg',
};

export function BookPage() {
  const { id } = useParams();
  const bookId = Number(id);
  const navigate = useNavigate();
  const { user } = useAuth();
  const player = usePlayer();
  const { position: livePosition } = useClock();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAllText, setShowAllText] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [kindle, setKindle] = useState<KindleSettings | null>(null);
  const [sendingToKindle, setSendingToKindle] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [prefs] = usePrefs();

  const load = () =>
    api
      .book(bookId)
      .then((r) => setBook(r.book))
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  useEffect(() => {
    api.kindle().then(setKindle, () => undefined);
  }, []);

  // Close the "more" menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);

  if (error)
    return (
      <div className="page">
        <p className="error">{error}</p>
      </div>
    );
  if (!book) return <BookSkeleton />;

  const isEbook = book.kind === 'ebook';
  const isCurrent = !isEbook && player.book?.id === book.id;
  const position = isCurrent ? livePosition : book.progress && !book.progress.finished ? book.progress.position : 0;
  const currentChapter = chapterAt(book, position);
  const started = isEbook ? position > 0.005 : position > 5;
  const finished = !!book.progress?.finished;
  const fraction = finished ? 1 : isEbook ? position : position / Math.max(book.duration, 1);
  const remaining = book.duration - position;
  const description = book.description?.trim() ?? '';
  const longDescription = description.length > 280;

  const playFrom = (pos?: number) => {
    void player.open(book, { autoplay: true, position: pos });
    if (pos === undefined) navigate('/player');
  };

  const resetProgress = async () => {
    setMenuOpen(false);
    if (!confirm('Start this book over from the beginning?')) return;
    await api.resetProgress(book.id);
    if (isCurrent) player.seek(0);
    toast('Progress reset');
    void load();
  };

  const markFinished = async () => {
    setMenuOpen(false);
    await api.saveProgress(book.id, isEbook ? 1 : book.duration, true);
    if (isCurrent) player.close();
    toast('Marked as finished');
    void load();
  };

  const deleteBook = async () => {
    setMenuOpen(false);
    const what = isEbook ? 'its ebook file' : 'its audio files';
    if (!confirm(`Delete "${book.title}" and ${what} from the server? This can't be undone.`)) return;
    if (isCurrent) player.close();
    await api.deleteBook(book.id);
    toast('Book deleted');
    navigate('/');
  };

  const sendToKindle = async () => {
    // Not set up yet: the guided setup can send this book at the end.
    if (!kindle?.email) return navigate(`/kindle?book=${book.id}`);
    setSendingToKindle(true);
    try {
      await api.sendToKindle(book.id);
      toast('Sent! It should appear on your Kindle in a few minutes.');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setSendingToKindle(false);
    }
  };

  const chips = [
    isEbook ? 'Ebook' : formatDuration(book.duration),
    !isEbook && book.chapters.length > 1 ? `${book.chapters.length} chapters` : null,
    book.narrator ? `Read by ${book.narrator}` : null,
    book.source ? SOURCE_LABELS[book.source] ?? book.source : 'Your files',
  ].filter(Boolean) as string[];

  const isHidden = prefs.hiddenBooks.includes(book.id);
  const toggleHidden = () => {
    setMenuOpen(false);
    setBookHidden(book.id, !isHidden);
    toast(isHidden ? 'Visible on your profile again' : 'Hidden from your profile. Only you can see you have it.');
  };
  // Always available: the privacy toggle lives in this menu.
  const hasMenu = true;

  return (
    <div className="page book-page">
      <button className="back-link" onClick={() => navigate(-1)}>
        <ChevronLeftIcon size={20} /> Back
      </button>

      <div className="book-layout">
        <div className="book-cover-col">
          <Cover src={coverUrl(book)} title={book.title} author={book.author} className="book-hero-cover" />
        </div>

        <div className="book-info">
          <h1 className="book-title">{book.title}</h1>
          <p className="author">{book.author ?? 'Unknown author'}</p>

          <ul className="stat-chips">
            {chips.map((c) => (
              <li key={c}>{c}</li>
            ))}
            {isHidden && <li className="private-chip">Hidden from others</li>}
          </ul>

          {(started || finished) && (
            <div className="book-progress">
              <div className="progress-line">
                <div style={{ width: `${Math.round(fraction * 100)}%` }} />
              </div>
              <span className="muted small">
                {finished
                  ? 'Finished'
                  : isEbook
                    ? `${Math.round(fraction * 100)}% read`
                    : `${formatDuration(remaining)} left${currentChapter && book.chapters.length > 1 ? ` · ${currentChapter.title}` : ''}`}
              </span>
            </div>
          )}

          <div className="book-actions">
            {isEbook ? (
              <button className="btn btn-primary btn-lg" onClick={() => navigate(`/read/${book.id}`)}>
                <BooksIcon size={20} /> {started ? 'Continue reading' : finished ? 'Read again' : 'Start reading'}
              </button>
            ) : isCurrent && player.playing ? (
              <button className="btn btn-primary btn-lg" onClick={player.pause}>
                <PauseIcon size={20} /> Pause
              </button>
            ) : (
              <button className="btn btn-primary btn-lg" onClick={() => playFrom()}>
                <PlayIcon size={20} /> {started ? `Resume at ${formatTime(position)}` : finished ? 'Listen again' : 'Play'}
              </button>
            )}

            {isEbook && kindle?.enabled && (
              <button className="btn btn-lg btn-kindle" onClick={sendToKindle} disabled={sendingToKindle}>
                {sendingToKindle ? 'Sending…' : 'Send to Kindle'}
              </button>
            )}

            {hasMenu && (
              <div className="menu-wrap" ref={menuRef}>
                <button
                  className="btn btn-icon"
                  aria-label="More actions"
                  aria-expanded={menuOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(!menuOpen);
                  }}
                >
                  ⋯
                </button>
                {menuOpen && (
                  <div className="menu" role="menu">
                    <button role="menuitem" onClick={toggleHidden}>
                      {isHidden ? 'Show on my profile' : 'Hide from my profile'}
                    </button>
                    {(started || finished) && (
                      <button role="menuitem" onClick={resetProgress}>
                        Start over
                      </button>
                    )}
                    {!finished && (
                      <button role="menuitem" onClick={markFinished}>
                        Mark as finished
                      </button>
                    )}
                    {user?.isAdmin && (
                      <button role="menuitem" className="danger" onClick={deleteBook}>
                        Delete from server
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {description && (
            <div className="description-block">
              <p className={`description ${showAllText || !longDescription ? '' : 'clamped'}`}>{description}</p>
              {longDescription && (
                <button className="link-btn" onClick={() => setShowAllText(!showAllText)}>
                  {showAllText ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {book.chapters.length > 1 && (
        <section className="chapters">
          <h2 className="section-title">Chapters</h2>
          <ol className="chapter-list">
            {book.chapters.map((c) => {
              const current = currentChapter?.idx === c.idx && started;
              const done = started && c.end <= position;
              return (
                <li key={c.idx}>
                  <button className={`chapter-row ${current ? 'current' : ''} ${done ? 'done' : ''}`} onClick={() => playFrom(c.start)}>
                    <span className="chapter-num">{c.idx + 1}</span>
                    <span className="chapter-title">{c.title}</span>
                    <span className="muted small">{formatTime(c.end - c.start)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
