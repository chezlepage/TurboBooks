import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, isbnCoverUrl } from '../api';
import type { ShelfItem } from '../api';
import { Cover } from './Cover';
import { toast } from './Toast';

/**
 * My want-to-read list (only I see it). Books that are free right now get one-tap
 * "Add ebook" / "Add audiobook" buttons that put them in my library.
 */
export function WantToRead({ items, onChange }: { items: ShelfItem[]; onChange: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const free = items.filter((i) => i.freeEbookId || i.freeAudioId);
  const shown = showAll ? items : items.slice(0, 12);

  const addFree = async (item: ShelfItem, kind: 'ebook' | 'audio') => {
    const id = kind === 'ebook' ? item.freeEbookId! : item.freeAudioId!;
    try {
      const res = await api.importBook(kind, id, item.title);
      toast(res.bookId ? `“${item.title}” is in your library` : `Adding “${item.title}” to your library`);
      if (res.bookId) navigate(`/book/${res.bookId}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const addManual = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await api.addToShelf(title.trim(), author.trim());
    toast(`“${title.trim()}” added to want to read`);
    setTitle('');
    setAuthor('');
    setAdding(false);
    onChange();
  };

  const markRead = async (item: ShelfItem) => {
    await api.updateShelfItem(item.id, { shelf: 'read' });
    toast(`Moved “${item.title}” to read`);
    onChange();
  };

  const remove = async (item: ShelfItem) => {
    await api.removeShelfItem(item.id);
    onChange();
  };

  return (
    <section>
      <div className="section-row">
        <h2 className="section-title">Want to read · only you</h2>
        <button className="link-btn" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : '+ Add a book'}
        </button>
      </div>
      {adding && (
        <form className="want-add" onSubmit={addManual}>
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          <input placeholder="Author (optional)" value={author} onChange={(e) => setAuthor(e.target.value)} />
          <button className="btn btn-primary">Add</button>
        </form>
      )}
      {free.length > 0 && (
        <p className="free-banner">
          <strong>{free.length}</strong> of these {free.length === 1 ? 'is' : 'are'} free right now. Tap to add.
        </p>
      )}
      {items.length === 0 ? (
        <p className="muted">Nothing yet. Import from Goodreads or add a book you'd like to read.</p>
      ) : (
        <ul className="want-list">
          {shown.map((item) => (
            <li key={item.id} className="want-row">
              <Cover src={isbnCoverUrl(item.isbn13)} title={item.title} author={item.author} className="want-cover" />
              <div className="want-text">
                <div className="want-title">{item.title}</div>
                {item.author && <div className="muted small">{item.author}</div>}
                {(item.freeEbookId || item.freeAudioId) && (
                  <div className="want-free">
                    {item.freeEbookId && (
                      <button className="btn btn-small btn-primary" onClick={() => void addFree(item, 'ebook')}>
                        Add free ebook
                      </button>
                    )}
                    {item.freeAudioId && (
                      <button className="btn btn-small btn-primary" onClick={() => void addFree(item, 'audio')}>
                        Add free audiobook
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="want-actions">
                <button className="link-btn small" onClick={() => void markRead(item)}>
                  Read it
                </button>
                <button className="link-btn small muted" onClick={() => void remove(item)} aria-label={`Remove ${item.title}`}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {items.length > 12 && (
        <button className="btn btn-ghost btn-block" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}
