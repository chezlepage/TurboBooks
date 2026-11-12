import { useEffect, useState } from 'react';

/** Per-device preferences (each phone can be set up differently). */
export interface Prefs {
  /** Start a sleep timer automatically when playback starts. */
  autoSleep: 'off' | 'chapter' | number;
  /** Only auto-start the timer at night (8 pm – 6 am). */
  autoSleepNightOnly: boolean;
}

const KEY = 'tb.prefs';
const DEFAULTS: Prefs = { autoSleep: 'off', autoSleepNightOnly: true };
const listeners = new Set<(p: Prefs) => void>();

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: still applies for this session via listeners */
  }
  listeners.forEach((fn) => fn(next));
  return next;
}

export const isNight = (d = new Date()) => d.getHours() >= 20 || d.getHours() < 6;

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => {
    listeners.add(setPrefs);
    return () => {
      listeners.delete(setPrefs);
    };
  }, []);
  return [prefs, savePrefs];
}
