import { useEffect, useRef, useState } from 'react';
import type { TtsVoice } from '../api';

/** Plays the cached sample of a voice; tapping the same voice again stops it. */
export function useVoicePreview() {
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const toggle = (id: string) => {
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
  return { playing, toggle };
}

export const voiceDescription = (v: TtsVoice) => `${v.label} · ${v.gender === 'female' ? 'Female' : 'Male'} · ${v.accent}`;

/** Compact voice choice: a dropdown (featured voices first) plus a preview button. */
export function VoiceSelect({
  voices,
  value,
  onChange,
  preview,
  label,
}: {
  voices: TtsVoice[];
  value: string;
  onChange: (id: string) => void;
  preview: ReturnType<typeof useVoicePreview>;
  label: string;
}) {
  const featured = voices.filter((v) => v.featured);
  const groups: [string, TtsVoice[]][] = [
    ['More voices', voices.filter((v) => !v.featured && v.kind === 'voice')],
    ['Mixed voices (two blended)', voices.filter((v) => !v.featured && v.kind === 'mix')],
    ['Accents', voices.filter((v) => !v.featured && v.kind === 'accent')],
  ];
  return (
    <span className="voice-select">
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <optgroup label="Favourites">
          {featured.map((v) => (
            <option key={v.id} value={v.id}>
              {voiceDescription(v)}
            </option>
          ))}
        </optgroup>
        {groups
          .filter(([, list]) => list.length > 0)
          .map(([name, list]) => (
            <optgroup key={name} label={name}>
              {list.map((v) => (
                <option key={v.id} value={v.id}>
                  {voiceDescription(v)}
                </option>
              ))}
            </optgroup>
          ))}
      </select>
      <button
        type="button"
        className="btn btn-small voice-play"
        onClick={() => preview.toggle(value)}
        aria-label={`Preview ${voices.find((v) => v.id === value)?.label ?? 'voice'}`}
      >
        {preview.playing === value ? '■' : '▶'}
      </button>
    </span>
  );
}
