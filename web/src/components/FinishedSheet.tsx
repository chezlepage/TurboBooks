import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { api, coverUrl } from '../api';
import { Cover } from './Cover';
import { Stars } from './Stars';
import { toast } from './Toast';

export interface FinishedBook {
  id: number;
  title: string;
  author: string | null;
  hasCover: boolean;
}

const listeners = new Set<(b: FinishedBook) => void>();
const celebrated = new Set<number>();

/** Shows the "You finished it!" sheet once per book per session. */
export function celebrateFinish(book: FinishedBook): void {
  if (celebrated.has(book.id)) return;
  celebrated.add(book.id);
  listeners.forEach((fn) => fn(book));
}

export function FinishedSheet() {
  const [book, setBook] = useState<FinishedBook | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    const show = (b: FinishedBook) => {
      setBook(b);
      setRating(null);
      setNote('');
    };
    listeners.add(show);
    return () => {
      listeners.delete(show);
    };
  }, []);

  if (!book) return null;

  const close = async (save: boolean) => {
    if (save && (rating || note.trim())) {
      try {
        await api.rateBook(book.id, rating, note.trim() || null);
        toast(rating ? `Rated ${rating} star${rating === 1 ? '' : 's'}` : 'Note saved');
      } catch {
        /* ignore */
      }
    }
    setBook(null);
  };

  return (
    <div className="sheet-backdrop finished-backdrop" onClick={() => void close(false)}>
      <div className="sheet finished-sheet" role="dialog" aria-label="Finished" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="finished-burst" aria-hidden>
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} style={{ '--i': i } as CSSProperties} />
          ))}
        </div>
        <div className="finished-cover">
          <Cover src={coverUrl(book)} title={book.title} author={book.author} />
        </div>
        <p className="kicker">The end</p>
        <h2 className="finished-title">You finished {book.title}</h2>
        {book.author && <p className="muted">{book.author}</p>}
        <p className="muted small">How was it?</p>
        <Stars value={rating} size={34} onChange={setRating} />
        {rating !== null && (
          <textarea
            className="rating-note"
            placeholder="A line to remember it by (optional)"
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
        <div className="finished-actions">
          <button className="btn btn-ghost" onClick={() => void close(false)}>
            Not now
          </button>
          <button className="btn btn-primary" onClick={() => void close(true)} disabled={rating === null && !note.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
