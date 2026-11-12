import { useRef, useState } from 'react';
import { api } from '../api';
import type { GoodreadsImportSummary } from '../api';
import { toast } from './Toast';

/** Upload a Goodreads "Export Library" CSV. Re-importing updates existing entries. */
export function GoodreadsImport({ onDone }: { onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<GoodreadsImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { summary: s } = await api.importGoodreads(await file.text());
      setSummary(s);
      toast(`Imported ${s.added + s.updated} books from Goodreads`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <section className="import-card">
      <div className="import-head">
        <div>
          <strong>Bring your Goodreads shelves</strong>
          <p className="muted small">Your want-to-read list, reading history and ratings.</p>
        </div>
        <button className="btn btn-small" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Close' : 'Import'}
        </button>
      </div>
      {open && (
        <div className="import-steps">
          <ol>
            <li>
              On a computer, open{' '}
              <a href="https://www.goodreads.com/review/import" target="_blank" rel="noreferrer">
                goodreads.com/review/import
              </a>
              .
            </li>
            <li>Click <strong>Export Library</strong>, wait a moment, then download the file it makes.</li>
            <li>Choose that file here.</li>
          </ol>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          <button className="btn btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Importing…' : 'Choose Goodreads file'}
          </button>
          <p className="muted small">
            Only you see your want-to-read list. Read books show on your profile like the rest of your reading, and you can
            hide any of them. Importing again later updates what's already here.
          </p>
          {error && <p className="error">{error}</p>}
          {summary && (
            <p className="success small">
              {summary.added} added, {summary.updated} updated
              {summary.byShelf.want ? ` · ${summary.byShelf.want} want to read` : ''}
              {summary.byShelf.read ? ` · ${summary.byShelf.read} read` : ''}
              {summary.byShelf.reading ? ` · ${summary.byShelf.reading} reading` : ''}
              {summary.linked ? ` · ${summary.linked} matched books already in your library` : ''}. Checking which are free…
            </p>
          )}
        </div>
      )}
    </section>
  );
}
