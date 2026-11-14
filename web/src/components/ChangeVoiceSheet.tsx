import { useEffect, useState } from 'react';
import { api } from '../api';
import type { HeardVoices, TtsVoice } from '../api';
import { useClock, usePlayer } from '../player/PlayerContext';
import { toast } from './Toast';
import { VoiceSelect, useVoicePreview } from './VoicePick';

/**
 * Change a voice while listening. Only lists voices already heard up to this point in the book,
 * so it never reveals characters who haven't shown up yet.
 */
export function ChangeVoiceSheet({ onClose }: { onClose: () => void }) {
  const player = usePlayer();
  const { position } = useClock();
  const [heard, setHeard] = useState<HeardVoices | null>(null);
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useVoicePreview();
  const bookId = player.book?.id;

  useEffect(() => {
    if (!bookId) return;
    // Position at opening time: the list shouldn't grow while the sheet is open.
    Promise.all([api.bookVoices(bookId, position), api.ttsVoices()])
      .then(([h, v]) => {
        setHeard(h);
        setVoices(v.voices);
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  if (!bookId) return null;

  const parts = heard
    ? [...heard.parts].sort((a, b) => Number(b.part === heard.lastSpeaker) - Number(a.part === heard.lastSpeaker))
    : [];
  const label = (id: string) => voices?.find((v) => v.id === id)?.label ?? id;

  const apply = async (part: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.changeBookVoice(bookId, part, choice, position);
      // Someone else has this audiobook too: you now have your own copy, same place in it.
      if (res.bookId && res.bookId !== bookId) await player.open(res.bookId, { autoplay: player.playing, position });
      player.watchVoiceChange();
      toast('Re-recording with the new voice, starting with this chapter');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet convert-sheet" role="dialog" aria-label="Change a voice" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2>Change a voice</h2>
        <p className="muted small">Only voices you’ve already heard are listed, so nothing gets spoiled.</p>
        {!heard && !error && <p className="muted small">Loading…</p>}
        {heard && heard.pendingTracks.length > 0 && (
          <p className="muted small">A voice change is still being recorded ({heard.pendingTracks.length} chapters left).</p>
        )}
        {heard && voices && (
          <ul className="cast-list">
            {parts.map((p) => (
              <li key={p.part} className={`cast-row ${editing === p.part ? 'active' : ''}`}>
                <span className="cast-name">
                  <strong>{p.label}</strong>
                  <span className="muted small">
                    {p.part === heard.lastSpeaker ? 'Just spoke · ' : ''}
                    {label(p.voice)}
                  </span>
                </span>
                {editing === p.part ? (
                  <span className="cast-edit">
                    <VoiceSelect voices={voices} value={choice} onChange={setChoice} preview={preview} label={`New voice for ${p.label}`} />
                    <button className="btn btn-small btn-primary" disabled={busy || choice === p.voice} onClick={() => void apply(p.part)}>
                      {busy ? 'Saving…' : 'Use it'}
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn btn-small"
                    onClick={() => {
                      setEditing(p.part);
                      setChoice(p.voice);
                    }}
                  >
                    Change
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {editing && (
          <p className="muted small">
            {editing === 'narrator' ? 'The whole book' : 'Every chapter this voice is in'} gets re-recorded on your server, starting where you
            are. You can keep listening: it switches over as each chapter is ready. Anyone else who has this audiobook keeps theirs as it is.
          </p>
        )}
        {error && <p className="error small">{error}</p>}
        <div className="finished-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
