import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TtsVoice } from '../api';
import { usePrefs } from '../prefs';
import type { Prefs } from '../prefs';
import { VoiceSelect, voiceDescription, useVoicePreview } from './VoicePick';

const MODES: { mode: Prefs['voiceListMode']; label: string }[] = [
  { mode: 'off', label: 'Any voice' },
  { mode: 'prefer', label: 'Only these' },
  { mode: 'avoid', label: 'Avoid these' },
];

/**
 * Your own profile: which voices audiobooks you make may use. "Only these" is a whitelist,
 * "Avoid these" a blacklist; both lists are kept, so switching back and forth loses nothing.
 * Only shown when this server can make audiobooks.
 */
export function VoiceListCard() {
  const [prefs, setPrefs] = usePrefs();
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const preview = useVoicePreview();

  useEffect(() => {
    let live = true;
    api
      .convertStatus()
      .then((s) => (s.enabled ? api.ttsVoices() : null))
      .then((r) => live && r && setVoices(r.voices))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!voices) return null;

  const mode = prefs.voiceListMode;
  const key = mode === 'prefer' ? 'preferredVoices' : 'avoidedVoices';
  const chosen = new Set(mode === 'off' ? [] : prefs[key]);
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPrefs({ [key]: [...next] } as Partial<Prefs>);
  };
  const count = (g: TtsVoice['gender']) => voices.filter((v) => v.gender === g && chosen.has(v.id)).length;

  return (
    <section className="import-card voice-list-card">
      <h2 className="section-title">Audiobook voices</h2>
      <p className="muted small">
        Used when you make an audiobook from an ebook. Books already made keep their voices.
      </p>

      <h3 className="voice-list-group">Default narrator</h3>
      <VoiceSelect
        voices={voices}
        value={prefs.ttsVoice}
        onChange={(id) => setPrefs({ ttsVoice: id })}
        preview={preview}
        label="Default narrator"
      />

      <h3 className="voice-list-group">Character voices</h3>
      <div className="segmented" role="radiogroup" aria-label="Voice list">
        {MODES.map((m) => (
          <button
            key={m.mode}
            role="radio"
            aria-checked={mode === m.mode}
            className={mode === m.mode ? 'active' : ''}
            onClick={() => setPrefs({ voiceListMode: m.mode })}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode !== 'off' && (
        <>
          <p className="muted small voice-list-hint">
            {mode === 'prefer'
              ? `Characters only get voices you tick (${count('female')} women, ${count('male')} men so far). If a book has more characters than that, some share a voice; if you tick no men (or no women), any voice is used for them.`
              : `Characters never get a voice you tick (${chosen.size} so far). You can still pick one by hand.`}
          </p>
          {(['female', 'male'] as const).map((g) => (
            <div key={g}>
              <h3 className="voice-list-group">{g === 'female' ? 'Women' : 'Men'}</h3>
              <ul className="voice-list">
                {voices
                  .filter((v) => v.gender === g)
                  .map((v) => (
                    <li key={v.id}>
                      <label className={`voice-row ${chosen.has(v.id) ? 'active' : ''}`}>
                        <input type="checkbox" checked={chosen.has(v.id)} onChange={() => toggle(v.id)} />
                        <span className="voice-name">{v.label}</span>
                        <span className="muted small">
                          {v.kind === 'mix' ? `${v.accent} · mixed` : v.accent}
                        </span>
                        <button
                          type="button"
                          className="btn btn-small voice-play"
                          onClick={(e) => {
                            e.preventDefault();
                            preview.toggle(v.id);
                          }}
                          aria-label={`Preview ${voiceDescription(v)}`}
                        >
                          {preview.playing === v.id ? '■' : '▶'}
                        </button>
                      </label>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
