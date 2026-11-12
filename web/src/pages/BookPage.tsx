import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, coverUrl, formatDuration, formatTime } from '../api';
import type { BookDetail } from '../api';
import { useAuth } from '../auth';
import { Cover } from '../components/Cover';
import { BooksIcon, ChevronLeftIcon, PauseIcon, PlayIcon } from '../components/Icons';
import { chapterAt, useClock, usePlayer } from '../player/PlayerContext';

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

  const load = () =>
    api
      .book(bookId)
      .then((r) => setBook(r.book))
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!book) return <div className="page"><p className="muted">Loading…</p></div>;

  const isEbook = book.kind === 'ebook';
  const isCurrent = !isEbook && player.book?.id === book.id;
  const position = isCurrent ? livePosition : book.progress && !book.progress.finished ? book.progress.position : 0;
  const currentChapter = chapterAt(book, position);
  const started = isEbook ? position > 0.005 : position > 5;
  const readPct = Math.round(position * 100);
  const remaining = book.duration - position;

  const playFrom = (pos?: number) => {
    void player.open(book, { autoplay: true, position: pos });
    if (pos === undefined) navigate('/player');
  };

  const resetProgress = async () => {
    if (!confirm('Start this book over from the beginning?')) return;
    await api.resetProgress(book.id);
    if (isCurrent) player.seek(0);
    void load();
  };

  const markFinished = async () => {
    await api.saveProgress(book.id, isEbook ? 1 : book.duration, true);
    if (isCurrent) player.close();
    void load();
  };

  const deleteBook = async () => {
    if (!confirm(`Delete "${book.title}" and its audio files from the server? This can't be undone.`)) return;
    if (isCurrent) player.close();
    await api.deleteBook(book.id);
    navigate('/');
  };

  return (
    <div className="page book-page">
      <button className="back-link" onClick={() => navigate(-1)}>
        <ChevronLeftIcon size={20} /> Back
      </button>

      <div className="book-hero">
        <Cover src={coverUrl(book)} title={book.title} className="book-hero-cover" />
        <div className="book-hero-text">
          <h1>{book.title}</h1>
          {book.author && <p className="author">{book.author}</p>}
          {book.narrator && <p className="muted small">Read by {book.narrator}</p>}
          <p className="muted small">
            {isEbook ? 'Ebook' : formatDuration(book.duration)}
            {started && (isEbook ? ` · ${readPct}% read` : ` · ${formatDuration(remaining)} left`)}
            {book.progress?.finished && ' · Finished'}
          </p>
        </div>
      </div>

      <div className="book-actions">
        {isEbook ? (
          <button className="btn btn-primary btn-lg" onClick={() => navigate(`/read/${book.id}`)}>
            <BooksIcon size={20} /> {started ? `Continue reading · ${readPct}%` : 'Read'}
          </button>
        ) : isCurrent && player.playing ? (
          <button className="btn btn-primary btn-lg" onClick={player.pause}>
            <PauseIcon size={20} /> Pause
          </button>
        ) : (
          <button className="btn btn-primary btn-lg" onClick={() => playFrom()}>
            <PlayIcon size={20} /> {started ? `Resume · ${formatTime(position)}` : 'Play'}
          </button>
        )}
      </div>

      {book.description && (
        <p className={`description ${showAllText ? '' : 'clamped'}`} onClick={() => setShowAllText(!showAllText)}>
          {book.description}
        </p>
      )}

      {book.chapters.length > 1 && (
        <section>
          <h2 className="section-title">Chapters</h2>
          <ol className="chapter-list">
            {book.chapters.map((c) => (
              <li key={c.idx}>
                <button
                  className={`chapter-row ${currentChapter?.idx === c.idx && started ? 'current' : ''}`}
                  onClick={() => playFrom(c.start)}
                >
                  <span className="chapter-title">{c.title}</span>
                  <span className="muted small">{formatTime(c.end - c.start)}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="book-footer">
        {(started || book.progress?.finished) && (
          <button className="btn btn-ghost" onClick={resetProgress}>
            Start over
          </button>
        )}
        {!book.progress?.finished && started && (
          <button className="btn btn-ghost" onClick={markFinished}>
            Mark finished
          </button>
        )}
        {user?.isAdmin && (
          <button className="btn btn-ghost danger" onClick={deleteBook}>
            Delete book
          </button>
        )}
      </div>
    </div>
  );
}
