import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { MixPart, TtsVoice } from '../api';
import { toast } from './Toast';
import type { useVoicePreview } from './VoicePick';

const MAX_PARTS = 3;
const speedLabel = (s: number) => (s < 0.97 ? `${Math.round((1 - s) * 100)}% slower` : s > 1.03 ? `${Math.round((s - 1) * 100)}% faster` : 'Normal speed');

/**
 * Mixed voices on your profile: the ones people here have made (anyone can use them; whoever
 * made one can delete it), and a mixer to make your own from up to 3 voices plus a speed.
 */
export function VoiceMixer({
  voices,
  preview,
  onChanged,
}: {
  voices: TtsVoice[];
  preview: ReturnType<typeof useVoicePreview>;
  onChanged: () => Promise<unknown>;
}) {
  const custom = voices.filter((v) => v.kind === 'custom');
  const [open, setOpen] = useState(false);

  const remove = async (v: TtsVoice) => {
    if (!window.confirm(`Delete "${v.label}"? Books already made with it keep it.`)) return;
    try {
      await api.deleteCustomVoice(v.id);
      await onChanged();
      toast('Voice deleted');
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="mixer">
      <h3 className="voice-list-group">Mixed voices</h3>
      {custom.length === 0 ? (
        <p className="muted small">Nobody has mixed a voice yet. Blend two or three voices to make a new one for everyone here.</p>
      ) : (
        <ul className="voice-list">
          {custom.map((v) => (
            <li key={v.id} className="voice-row mixer-row">
              <span className="voice-name">{v.label}</span>
              <span className="muted small">
                {v.gender === 'female' ? 'Woman' : 'Man'} · {v.accent} · by {v.mine ? 'you' : v.owner?.name}
              </span>
              <button type="button" className="btn btn-small voice-play" onClick={() => preview.toggle(v.id)} aria-label={`Preview ${v.label}`}>
                {preview.playing === v.id ? '■' : '▶'}
              </button>
              {v.canDelete ? (
                <button type="button" className="btn btn-small btn-ghost" onClick={() => void remove(v)} aria-label={`Delete ${v.label}`}>
                  ✕
                </button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <MixerForm
          voices={voices}
          onCancel={() => setOpen(false)}
          onSaved={async () => {
            await onChanged();
            setOpen(false);
          }}
        />
      ) : (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Mix a new voice
        </button>
      )}
    </div>
  );
}

function MixerForm({ voices, onCancel, onSaved }: { voices: TtsVoice[]; onCancel: () => void; onSaved: () => Promise<void> }) {
  const base = voices.filter((v) => v.kind === 'voice' || v.kind === 'accent');
  const [parts, setParts] = useState<MixPart[]>([
    { voice: 'af_bella', weight: 5 },
    { voice: 'af_sky', weight: 5 },
  ]);
  const [speed, setSpeed] = useState(1);
  const [name, setName] = useState('');
  const [gender, setGender] = useState<'female' | 'male'>('female');
  const [genderTouched, setGenderTouched] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);

  const total = parts.reduce((n, p) => n + p.weight, 0);
  const setPart = (i: number, next: Partial<MixPart>) => {
    const ps = parts.map((p, k) => (k === i ? { ...p, ...next } : p));
    setParts(ps);
    // Until you pick one, the gender follows the main voice.
    if (!genderTouched) {
      const main = [...ps].sort((a, b) => b.weight - a.weight)[0];
      const g = base.find((v) => v.id === main.voice)?.gender;
      if (g) setGender(g);
    }
  };
  const unused = (keep: string) => base.filter((v) => v.id === keep || !parts.some((p) => p.voice === v.id));

  const hear = async () => {
    setBusy('preview');
    setError(null);
    try {
      const blob = await api.previewMix({ parts, speed });
      audio.current?.pause();
      const a = new Audio(URL.createObjectURL(blob));
      audio.current = a;
      await a.play();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!name.trim()) {
      setError('Give your voice a name');
      return;
    }
    setBusy('save');
    setError(null);
    try {
      await api.createCustomVoice({ name: name.trim(), gender, parts, speed });
      toast(`"${name.trim()}" saved. Everyone here can pick it now.`);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mixer-form">
      {parts.map((p, i) => (
        <div key={i} className="mixer-part">
          <select value={p.voice} onChange={(e) => setPart(i, { voice: e.target.value })} aria-label={`Voice ${i + 1}`}>
            {(['female', 'male'] as const).map((g) => (
              <optgroup key={g} label={g === 'female' ? 'Women' : 'Men'}>
                {unused(p.voice)
                  .filter((v) => v.gender === g)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} · {v.accent}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          {parts.length > 1 && (
            <>
              <input
                type="range"
                min={1}
                max={9}
                value={p.weight}
                onChange={(e) => setPart(i, { weight: Number(e.target.value) })}
                aria-label={`How much of voice ${i + 1}`}
              />
              <span className="mixer-share">{Math.round((p.weight / total) * 100)}%</span>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => setParts(parts.filter((_, k) => k !== i))}
                aria-label={`Remove voice ${i + 1}`}
              >
                ✕
              </button>
            </>
          )}
        </div>
      ))}
      {parts.length < MAX_PARTS && (
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            const next = unused('').find((v) => v.gender === gender);
            if (next) setParts([...parts, { voice: next.id, weight: 5 }]);
          }}
        >
          + Add another voice
        </button>
      )}

      <label className="mixer-speed">
        <span>Speed: {speedLabel(speed)}</span>
        <input type="range" min={0.8} max={1.25} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
      </label>

      <div className="mixer-meta">
        <input type="text" placeholder="Name it, e.g. Grandma" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} aria-label="Voice name" />
        <div className="segmented" role="radiogroup" aria-label="Woman or man">
          {(['female', 'male'] as const).map((g) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={gender === g}
              className={gender === g ? 'active' : ''}
              onClick={() => {
                setGender(g);
                setGenderTouched(true);
              }}
            >
              {g === 'female' ? 'Woman' : 'Man'}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">Woman or man decides which characters it can be given. Once saved, a voice can't be changed (books made with it stay the same), only deleted.</p>

      {error && <p className="error">{error}</p>}
      <div className="row-actions">
        <button type="button" className="btn" onClick={() => void hear()} disabled={busy !== null}>
          {busy === 'preview' ? 'Mixing…' : '▶ Hear it'}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : 'Save voice'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
