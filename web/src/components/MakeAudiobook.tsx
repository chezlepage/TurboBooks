import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { Conversion, ConvertEstimate, TtsVoice } from '../api';
import { usePrefs } from '../prefs';
import { toast } from './Toast';

const STAGE_TEXT: Record<Conversion['status'], string> = {
  queued: 'Waiting to start',
  reading: 'Reading the ebook',
  casting: 'Claude is meeting the characters',
  annotating: 'Claude is reading the book',
  voicing: 'Recording',
  done: 'Ready',
  failed: 'Failed',
  canceled: 'Canceled',
};
const ACTIVE: Conversion['status'][] = ['queued', 'reading', 'casting', 'annotating', 'voicing'];

/**
 * Ebook page section: shows conversion progress, or a button that opens the
 * "Make an audiobook" sheet (voice picker with previews, character voices, cost estimate).
 */
export function MakeAudiobook({ bookId }: { bookId: number }) {
  const [status, setStatus] = useState<{ enabled: boolean; reason?: string } | null>(null);
  const [conversion, setConversion] = useState<Conversion | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = () =>
    api
      .bookConversion(bookId)
      .then((r) => setConversion(r.conversion))
      .catch(() => undefined);

  useEffect(() => {
    api
      .convertStatus()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false }));
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Poll while a conversion is running.
  const running = conversion && ACTIVE.includes(conversion.status);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  if (!status?.enabled) return null;

  if (conversion && running) {
    return (
      <section className="convert-card">
        <div className="convert-head">
          <strong>Making the audiobook</strong>
          <button
            className="link-btn small"
            onClick={async () => {
              if (!confirm('Stop making this audiobook?')) return;
              await api.cancelConversion(conversion.id);
              void refresh();
            }}
          >
            Cancel
          </button>
        </div>
        <div className="progress-line">
          <div style={{ width: `${Math.max(3, Math.round(conversion.progress * 100))}%` }} />
        </div>
        <p className="muted small">
          {conversion.detail ?? STAGE_TEXT[conversion.status]}
          {conversion.status === 'annotating' || conversion.status === 'casting'
            ? ' · usually under an hour, you can close the app'
            : ''}
        </p>
      </section>
    );
  }

  return (
    <>
      {conversion?.status === 'done' && conversion.audioBookId ? (
        <section className="convert-card done">
          <strong>Audiobook ready</strong>
          <Link className="btn btn-small btn-primary" to={`/book/${conversion.audioBookId}`}>
            Listen
          </Link>
          <button className="link-btn small" onClick={() => setOpen(true)}>
            Make another version
          </button>
        </section>
      ) : (
        <button className="btn btn-block convert-open" onClick={() => setOpen(true)}>
          🎧 Make an audiobook
        </button>
      )}
      {conversion?.status === 'failed' && <p className="error small">Last attempt failed: {conversion.error}</p>}
      {open && (
        <ConvertSheet
          bookId={bookId}
          onClose={() => setOpen(false)}
          onStarted={(c) => {
            setConversion(c);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function ConvertSheet({ bookId, onClose, onStarted }: { bookId: number; onClose: () => void; onStarted: (c: Conversion) => void }) {
  const [prefs, setPrefs] = usePrefs();
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [voice, setVoice] = useState(prefs.ttsVoice);
  const [showAll, setShowAll] = useState(false);
  const [multiVoice, setMultiVoice] = useState(false);
  const [est, setEst] = useState<ConvertEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    api
      .ttsVoices()
      .then((r) => setVoices(r.voices))
      .catch((e: Error) => setError(e.message));
    return () => audio.current?.pause();
  }, []);

  useEffect(() => {
    setEst(null);
    api
      .convertEstimate(bookId, multiVoice)
      .then((r) => setEst(r.estimate))
      .catch((e: Error) => setError(e.message));
  }, [bookId, multiVoice]);

  const preview = (id: string) => {
    audio.current?.pause();
    if (playing === id) {
      setPlaying(null);
      return;
    }
    const a = new Audio(`/api/convert/voices/${id}/sample`);
    audio.current = a;
    setPlaying(id);
    a.onended = () => setPlaying(null);
    a.onerror = () => setPlaying(null);
    void a.play().catch(() => setPlaying(null));
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setPrefs({ ttsVoice: voice });
      const { conversion } = await api.startConversion(bookId, voice, multiVoice);
      toast(conversion.status === 'done' ? 'Already made, added to your library' : 'Started. We’ll keep working on it in the background');
      onStarted(conversion);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shown = (voices ?? []).filter((v) => showAll || v.featured || v.id === voice);
  const overBudget = est ? est.monthSpend + est.costHigh > est.budget : false;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet convert-sheet" role="dialog" aria-label="Make an audiobook" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2>Make an audiobook</h2>
        <p className="muted small">
          Claude prepares the text (what to skip, how to say tricky words{multiVoice ? ', who is speaking' : ''}), then a voice on
          your server reads it.
        </p>

        <h3 className="section-title">Narrator</h3>
        {!voices && !error && <p className="muted small">Loading voices…</p>}
        <ul className="voice-list">
          {shown.map((v) => (
            <li key={v.id}>
              <label className={`voice-row ${voice === v.id ? 'active' : ''}`}>
                <input type="radio" name="voice" checked={voice === v.id} onChange={() => setVoice(v.id)} />
                <span className="voice-name">{v.label}</span>
                <span className="muted small">
                  {v.gender === 'female' ? 'Female' : 'Male'} · {v.accent}
                </span>
                <button
                  type="button"
                  className="btn btn-small voice-play"
                  onClick={(e) => {
                    e.preventDefault();
                    preview(v.id);
                  }}
                  aria-label={`Preview ${v.label}`}
                >
                  {playing === v.id ? '■' : '▶'}
                </button>
              </label>
            </li>
          ))}
        </ul>
        {voices && voices.length > shown.length && (
          <button className="link-btn" onClick={() => setShowAll(true)}>
            More voices ({voices.length - shown.length})
          </button>
        )}

        <label className="privacy-toggle convert-multi">
          <span>
            <strong>Character voices</strong>
            <span className="muted small">Each speaking character gets their own voice; your pick stays the narrator.</span>
          </span>
          <input type="checkbox" role="switch" className="switch" checked={multiVoice} onChange={(e) => setMultiVoice(e.target.checked)} />
        </label>

        <div className="convert-estimate">
          {est ? (
            <>
              <span>
                About <strong>{est.audioHours} h</strong> of audio · {est.chapters} chapters
              </span>
              <span>
                Claude cost about{' '}
                <strong>
                  ${est.costLow.toFixed(2)}–${est.costHigh.toFixed(2)}
                </strong>
              </span>
              <span className="muted small">
                This month: ${est.monthSpend.toFixed(2)} of ${est.budget}
              </span>
            </>
          ) : (
            <span className="muted small">Working out the cost…</span>
          )}
        </div>
        {overBudget && <p className="error small">This would go over the monthly budget.</p>}
        {error && <p className="error small">{error}</p>}

        <div className="finished-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !est || overBudget || !voices} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Make it'}
          </button>
        </div>
      </div>
    </div>
  );
}
