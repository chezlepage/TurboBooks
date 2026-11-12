import { useEffect, useState } from 'react';
import { api } from './api';

/** Per-user preferences, stored on the server and cached locally for instant/offline use. */
export interface Prefs {
  /** Start a sleep timer automatically when playback starts. */
  autoSleep: 'off' | 'chapter' | number;
  /** Only auto-start the timer at night (8 pm – 6 am, device time). */
  autoSleepNightOnly: boolean;
  /** Ebook reader colors. */
  readerTheme: 'dark' | 'black' | 'sepia';
  /** Ebook text size in percent. */
  readerFontSize: number;
  /** Show my reading activity to other people on this server. */
  shareActivity: boolean;
  /** Books that never appear on my profile for others. */
  hiddenBooks: number[];
  /** Yearly reading goals, e.g. { "2026": 20 }. */
  readingGoals: Record<string, number>;
}

const KEY = 'tb.prefs';
export const DEFAULT_PREFS: Prefs = {
  autoSleep: 'off',
  autoSleepNightOnly: true,
  readerTheme: 'dark',
  readerFontSize: 110,
  shareActivity: true,
  hiddenBooks: [],
  readingGoals: {},
};

/** Hide or show one book on my profile. */
export function setBookHidden(bookId: number, hidden: boolean): void {
  const current = new Set(loadPrefs().hiddenBooks);
  if (hidden) current.add(bookId);
  else current.delete(bookId);
  savePrefs({ hiddenBooks: [...current] });
}
const listeners = new Set<(p: Prefs) => void>();

function readLocal(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let cache: Prefs = readLocal();

function setCache(next: Prefs) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((fn) => fn(next));
}

export const loadPrefs = (): Prefs => cache;

export function savePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...cache, ...patch };
  setCache(next);
  api.putPrefs(next).catch(() => undefined);
  return next;
}

/**
 * Pulls the user's prefs from the server. If the server has none yet, uploads
 * whatever this device had (settings from before prefs were synced).
 */
export async function syncPrefs(): Promise<void> {
  try {
    const { prefs } = await api.getPrefs();
    if (prefs) setCache({ ...DEFAULT_PREFS, ...prefs });
    else if (JSON.stringify(cache) !== JSON.stringify(DEFAULT_PREFS)) await api.putPrefs(cache);
  } catch {
    /* offline: keep the cached copy */
  }
}

export const isNight = (d = new Date()) => d.getHours() >= 20 || d.getHours() < 6;

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => {
    listeners.add(setPrefs);
    setPrefs(loadPrefs());
    return () => {
      listeners.delete(setPrefs);
    };
  }, []);
  return [prefs, savePrefs];
}
