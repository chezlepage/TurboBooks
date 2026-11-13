import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { Conversion, ConvertCast, ConvertEstimate, TtsVoice, VoiceMode } from '../api';
import { usePrefs } from '../prefs';
import { toast } from './Toast';
import { VoiceSelect, shapeVoices, useVoicePreview } from './VoicePick';

const STAGE_TEXT: Record<Conversion['status'], string> = {
  queued: 'Waiting to start',
  reading: 'Reading the ebook',
  casting: 'Claude is meeting the characters',
  annotating: 'Claude is reading the book',
  needs_voices: 'Waiting for you to pick voices',
  voicing: 'Recording',
  revoicing: 'Changing a voice',
  done: 'Ready',
  failed: 'Failed',
  canceled: 'Canceled',
};
const ACTIVE: Conversion['status'][] = ['queued', 'reading', 'casting', 'annotating', 'needs_voices', 'voicing'];

/**
 * Ebook page section: shows conversion progress, or a button that opens the
 * "Make an audiobook" sheet (voice picker with previews, character voices, cost estimate).
 */
/** `autoOpen`: open the sheet straight away (arriving from a Request card), unless a conversion exists. */
export function MakeAudiobook({ bookId, autoOpen = false }: { bookId: number; autoOpen?: boolean }) {
  const [status, setStatus] = useState<{
    enabled: boolean;
    reason?: string;
  } | null>(null);
  const [conversion, setConversion] = useState<Conversion | null>(null);
  const [open, setOpen] = useState(false);
  const [castOpen, setCastOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);

  const refresh = () =>
    api
      .bookConversion(bookId)
      .then((r) => setConversion(r.conversion))
      .catch(() => undefined)
      .finally(() => setLoaded(true));

  useEffect(() => {
    api
      .convertStatus()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false }));
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Auto-open once, only when converting is available and this book has no running or finished conversion.
  useEffect(() => {
    if (!autoOpen || autoOpened || !loaded || !status?.enabled) return;
    setAutoOpened(true);
    const busy = conversion && (ACTIVE.includes(conversion.status) || conversion.status === 'done' || conversion.status === 'revoicing');
    if (!busy) setOpen(true);
  }, [autoOpen, autoOpened, loaded, status, conversion]);

  // Poll while a conversion is running (not while it waits for the user).
  const running = conversion && ACTIVE.includes(conversion.status);
  const polling = running && conversion.status !== 'needs_voices';
  useEffect(() => {
    if (!polling) return;
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling]);

  if (!status?.enabled) return null;

  const castSheet = castOpen && conversion && (
    <CastSheet
      conversion={conversion}
      onClose={() => setCastOpen(false)}
      onSaved={(c) => {
        setConversion(c);
        setCastOpen(false);
      }}
    />
  );

  if (conversion && running) {
    const waiting = conversion.status === 'needs_voices';
    const canPickEarly = conversion.castReady && !conversion.voicesPicked && !waiting;
    return (
      <>
        <section className={`convert-card ${waiting ? 'waiting' : ''}`}>
          <div className="convert-head">
            <strong>{waiting ? 'Your turn: pick the voices' : 'Making the audiobook'}</strong>
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
          {waiting ? (
            <>
              <p className="muted small">Claude has read the book. Choose a voice for each character and recording starts.</p>
              <button className="btn btn-primary btn-small convert-cast-btn" onClick={() => setCastOpen(true)}>
                Pick character voices
              </button>
            </>
          ) : (
            <>
              <div className="progress-line">
                <div
                  style={{
                    width: `${Math.max(3, Math.round(conversion.progress * 100))}%`,
                  }}
                />
              </div>
              <p className="muted small">
                {conversion.detail ?? STAGE_TEXT[conversion.status]}
                {conversion.status === 'annotating' || conversion.status === 'casting'
                  ? ' · usually under an hour, you can close the app'
                  : ''}
              </p>
              {canPickEarly && (
                <button className="link-btn small convert-cast-btn" onClick={() => setCastOpen(true)}>
                  The cast is ready: pick their voices now
                </button>
              )}
            </>
          )}
        </section>
        {castSheet}
      </>
    );
  }

  return (
    <>
      {conversion && (conversion.status === 'done' || conversion.status === 'revoicing') && conversion.audioBookId ? (
        <section className="convert-card done">
          <strong>{conversion.status === 'revoicing' ? 'Changing a voice…' : 'Audiobook ready'}</strong>
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
      {conversion?.status === 'done' && conversion.error && <p className="error small">{conversion.error}</p>}
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
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('auto');
  const [est, setEst] = useState<ConvertEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useVoicePreview();

  useEffect(() => {
    api
      .ttsVoices()
      .then((r) => {
        setVoices(r.voices);
        // Start on a voice the listener's list allows.
        const allowed = shapeVoices(r.voices, prefs);
        if (!allowed.some((v) => v.id === prefs.ttsVoice) || (prefs.voiceListMode === 'prefer' && !allowed.find((v) => v.id === prefs.ttsVoice)?.featured)) {
          const first = allowed.find((v) => v.featured) ?? allowed[0];
          if (first) setVoice(first.id);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    setEst(null);
    api
      .convertEstimate(bookId, multiVoice)
      .then((r) => setEst(r.estimate))
      .catch((e: Error) => setError(e.message));
  }, [bookId, multiVoice]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setPrefs({ ttsVoice: voice });
      const { conversion } = await api.startConversion(bookId, voice, multiVoice, voiceMode);
      toast(conversion.status === 'done' ? 'Already made, added to your library' : 'Started. We’ll keep working on it in the background');
      onStarted(conversion);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shown = shapeVoices(voices ?? [], prefs, voice).filter((v) => showAll || v.featured || v.id === voice);
  const overBudget = est ? est.monthSpend + est.costHigh > est.budget : false;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet convert-sheet" role="dialog" aria-label="Make an audiobook" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2>Make an audiobook</h2>
        <p className="muted small">
          Claude prepares the text (what to skip, how to say tricky words
          {multiVoice ? ', who is speaking' : ''}), then a voice on your server reads it.
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
                    preview.toggle(v.id);
                  }}
                  aria-label={`Preview ${v.label}`}
                >
                  {preview.playing === v.id ? '■' : '▶'}
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

        <div className="convert-multi">
          <label className="privacy-toggle">
            <span>
              <strong>Character voices</strong>
              <span className="muted small">Each speaking character gets their own voice; your pick stays the narrator.</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={multiVoice}
              onChange={(e) => setMultiVoice(e.target.checked)}
            />
          </label>
          {multiVoice && (
            <div className="voice-mode" role="radiogroup" aria-label="How character voices are chosen">
              <label className={`voice-mode-opt ${voiceMode === 'auto' ? 'active' : ''}`}>
                <input type="radio" name="voiceMode" checked={voiceMode === 'auto'} onChange={() => setVoiceMode('auto')} />
                <span>
                  <strong>Automatic voice assignment</strong>
                  <span className="muted small">
                    No spoilers: you never see who’s in the book. You can still change a voice while listening.
                  </span>
                </span>
              </label>
              <label className={`voice-mode-opt ${voiceMode === 'manual' ? 'active' : ''}`}>
                <input type="radio" name="voiceMode" checked={voiceMode === 'manual'} onChange={() => setVoiceMode('manual')} />
                <span>
                  <strong>Assign voices manually</strong>
                  <span className="muted small">
                    You’ll see the full list of speaking characters before recording. That can spoil who shows up later.
                  </span>
                </span>
              </label>
            </div>
          )}
        </div>

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

const MINOR_LABELS: Record<string, string> = {
  minor_female: 'Other women',
  minor_male: 'Other men',
};

/** Manual mode: a voice for every speaking character (this list is the spoiler the user opted into). */
function CastSheet({ conversion, onClose, onSaved }: { conversion: Conversion; onClose: () => void; onSaved: (c: Conversion) => void }) {
  const [cast, setCast] = useState<ConvertCast | null>(null);
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useVoicePreview();

  useEffect(() => {
    Promise.all([api.convertCast(conversion.id), api.ttsVoices()])
      .then(([c, v]) => {
        setCast(c);
        setVoices(v.voices);
        setPicks({ ...c.suggested, ...c.picked });
      })
      .catch((e: Error) => setError(e.message));
  }, [conversion.id]);

  const save = async (useSuggested: boolean) => {
    if (!cast) return;
    setBusy(true);
    setError(null);
    try {
      const chosen = useSuggested ? cast.suggested : picks;
      const parts = [...cast.cast.map((c) => c.name), ...Object.keys(MINOR_LABELS)];
      const body = Object.fromEntries(parts.filter((p) => chosen[p]).map((p) => [p, chosen[p]]));
      const { conversion: c } = await api.setConvertVoices(conversion.id, body);
      toast(c.status === 'voicing' ? 'Recording started' : 'Saved. Recording starts when Claude finishes reading');
      onSaved(c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const narratorLabel = voices?.find((v) => v.id === conversion.voice)?.label ?? conversion.voice;
  const rows = cast
    ? [
        ...cast.cast.map((c) => ({
          part: c.name,
          label: c.name,
          hint: [c.gender, c.age].filter((x) => x !== 'unknown').join(', '),
        })),
        ...Object.entries(MINOR_LABELS)
          .filter(([part]) => cast.suggested[part])
          .map(([part, label]) => ({
            part,
            label,
            hint: 'one-off characters',
          })),
      ]
    : [];

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet convert-sheet" role="dialog" aria-label="Character voices" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2>Character voices</h2>
        <p className="muted small">Narrator: {narratorLabel}. Every voice can still be changed later while listening.</p>
        {!cast && !error && <p className="muted small">Loading the cast…</p>}
        {cast && voices && (
          <ul className="cast-list">
            {rows.map((r) => (
              <li key={r.part} className="cast-row">
                <span className="cast-name">
                  <strong>{r.label}</strong>
                  {r.hint && <span className="muted small">{r.hint}</span>}
                </span>
                <VoiceSelect
                  voices={voices}
                  value={picks[r.part] ?? cast.suggested[r.part]}
                  onChange={(id) => setPicks((p) => ({ ...p, [r.part]: id }))}
                  preview={preview}
                  label={`Voice for ${r.label}`}
                />
              </li>
            ))}
          </ul>
        )}
        {error && <p className="error small">{error}</p>}
        <div className="finished-actions">
          <button className="btn btn-ghost" disabled={busy || !cast} onClick={() => void save(true)}>
            Use automatic
          </button>
          <button className="btn btn-primary" disabled={busy || !cast} onClick={() => void save(false)}>
            {busy ? 'Saving…' : 'Save voices'}
          </button>
        </div>
      </div>
    </div>
  );
}
