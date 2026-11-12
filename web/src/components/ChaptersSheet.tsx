import { useEffect, useRef } from 'react';
import { formatTime } from '../api';
import { chapterAt, useClock, usePlayer } from '../player/PlayerContext';

/** Swipe-up list of chapters; tap one to jump there. Scrolls the current chapter into view. */
export function ChaptersSheet({ onClose }: { onClose: () => void }) {
  const player = usePlayer();
  const { position } = useClock();
  const currentRef = useRef<HTMLButtonElement>(null);
  const book = player.book;
  const current = chapterAt(book, position);

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  if (!book) return null;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet chapters-sheet" role="dialog" aria-label="Chapters" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="chapters-sheet-head">
          <h2>Chapters</h2>
          <span className="muted small">
            {current ? `${current.idx + 1} of ${book.chapters.length}` : `${book.chapters.length} chapters`}
          </span>
        </div>
        <ol className="chapter-list chapters-sheet-list">
          {book.chapters.map((c) => {
            const isCurrent = current?.idx === c.idx;
            const done = c.end <= position;
            const inChapter = isCurrent ? Math.min(1, (position - c.start) / Math.max(c.end - c.start, 1)) : 0;
            return (
              <li key={c.idx}>
                <button
                  ref={isCurrent ? currentRef : undefined}
                  className={`chapter-row ${isCurrent ? 'current' : ''} ${done ? 'done' : ''}`}
                  onClick={() => {
                    player.seek(c.start);
                    onClose();
                  }}
                >
                  <span className="chapter-num">{c.idx + 1}</span>
                  <span className="chapter-title">
                    {c.title}
                    {isCurrent && (
                      <span className="chapter-progress">
                        <span style={{ width: `${inChapter * 100}%` }} />
                      </span>
                    )}
                  </span>
                  <span className="muted small">{formatTime(c.end - c.start)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
