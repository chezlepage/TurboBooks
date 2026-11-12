import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, beaconProgress, coverUrl, streamUrl } from '../api';
import type { BookDetail, Chapter } from '../api';
import { celebrateFinish } from '../components/FinishedSheet';
import { isNight, loadPrefs, syncPrefs } from '../prefs';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const SAVE_EVERY_MS = 10_000;
/** Volume fades to zero over this many seconds before the sleep timer stops playback. */
const FADE_SECONDS = 45;
/** Rewind after the sleep timer stopped playback (you were probably asleep already). */
const REWIND_AFTER_SLEEP = 60;
/** Rewind after a long manual pause, so you can catch the thread again. */
const rewindForPause = (pausedMs: number) => (pausedMs > 30 * 60_000 ? 30 : pausedMs > 5 * 60_000 ? 15 : pausedMs > 60_000 ? 5 : 0);

export const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const LS_LAST_BOOK = 'tb.lastBook';
const LS_RATE = 'tb.rate';
export interface SleepMark {
  bookId: number;
  /** Book position when the sleep timer was set (you were still awake). */
  position: number;
  /** When playback was stopped by the timer. */
  at: number;
}


const lsGet = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const lsSet = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
};

export type SleepSetting = { kind: 'minutes'; minutes: number } | { kind: 'chapter' };

interface SleepState {
  kind: 'minutes' | 'chapter';
  /** For 'minutes': play-time left in ms. Only counts down while playing. */
  remainingMs: number;
  /** For 'chapter': book position (seconds) to stop at. */
  stopAt: number;
}

export function chapterAt(book: BookDetail | null, position: number): Chapter | null {
  if (!book || book.chapters.length === 0) return null;
  let found = book.chapters[0];
  for (const c of book.chapters) {
    if (c.start <= position + 0.01) found = c;
    else break;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Contexts: "player" changes rarely, "clock" ticks several times a second.
// Splitting them keeps the library pages from re-rendering on every tick.
// ---------------------------------------------------------------------------
interface PlayerApi {
  book: BookDetail | null;
  playing: boolean;
  loading: boolean;
  error: string | null;
  rate: number;
  sleep: { kind: 'minutes' | 'chapter' } | null;
  /** Pass the BookDetail when you have it: playing without an await keeps iOS happy (user-gesture rule). */
  open: (book: number | BookDetail, opts?: { autoplay?: boolean; position?: number }) => Promise<void>;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (position: number) => void;
  skip: (seconds: number) => void;
  nextChapter: () => void;
  prevChapter: () => void;
  setRate: (rate: number) => void;
  setSleep: (setting: SleepSetting | null) => void;
  addSleepMinutes: (minutes: number) => void;
  /** Where the last sleep timer was set, if it stopped playback recently. */
  sleepMark: SleepMark | null;
  jumpToSleepMark: () => void;
  dismissSleepMark: () => void;
  close: () => void;
}

interface Clock {
  position: number;
  /** Seconds until the sleep timer stops playback (in real time), or null. */
  sleepRemaining: number | null;
}

const PlayerContext = createContext<PlayerApi | null>(null);
const ClockContext = createContext<Clock>({ position: 0, sleepRemaining: null });

export const usePlayer = () => {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer outside PlayerProvider');
  return ctx;
};
export const useClock = () => useContext(ClockContext);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);

  const [book, setBook] = useState<BookDetail | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRateState] = useState(() => Number(lsGet(LS_RATE)) || 1);
  const [sleepKind, setSleepKind] = useState<'minutes' | 'chapter' | null>(null);
  const [clock, setClock] = useState<Clock>({ position: 0, sleepRemaining: null });
  const [sleepMark, setSleepMark] = useState<SleepMark | null>(null);

  // Mutable mirrors so audio event handlers never see stale state.
  const bookRef = useRef<BookDetail | null>(null);
  const trackIdxRef = useRef(0);
  const pendingSeekRef = useRef<number | null>(null);
  const rateRef = useRef(rate);
  const sleepRef = useRef<SleepState | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const stoppedBySleepRef = useRef(false);
  const lastSaveRef = useRef(0);
  /** Position last written to the server; idle devices skip saving so they never clobber newer progress. */
  const lastSavedPosRef = useRef<number | null>(null);
  /** Server timestamp of the newest progress this device knows about. */
  const serverUpdatedAtRef = useRef(0);
  /** Book position when the current sleep timer was started. */
  const sleepStartRef = useRef<number | null>(null);

  // ---- position helpers ---------------------------------------------------
  const currentPosition = useCallback(() => {
    const b = bookRef.current;
    const audio = audioRef.current;
    if (!b || !audio) return 0;
    const track = b.tracks[trackIdxRef.current];
    if (!track) return 0;
    return track.start + (pendingSeekRef.current ?? audio.currentTime ?? 0);
  }, []);

  const trackIndexFor = (b: BookDetail, position: number) => {
    let idx = 0;
    for (let i = 0; i < b.tracks.length; i++) if (b.tracks[i].start <= position + 0.01) idx = i;
    return idx;
  };

  const save = useCallback(
    (opts: { finished?: boolean; beacon?: boolean } = {}) => {
      const b = bookRef.current;
      if (!b) return;
      const position = currentPosition();
      lastSaveRef.current = Date.now();
      const unchanged = lastSavedPosRef.current !== null && Math.abs(position - lastSavedPosRef.current) < 1;
      if (unchanged && opts.finished === undefined) return;
      lastSavedPosRef.current = position;
      if (opts.beacon) beaconProgress(b.id, position);
      else
        api
          .saveProgress(b.id, position, opts.finished)
          .then((r) => {
            serverUpdatedAtRef.current = Math.max(serverUpdatedAtRef.current, r.updatedAt);
          })
          .catch(() => undefined);
    },
    [currentPosition],
  );

  const loadTrack = useCallback((idx: number, offset: number, autoplay: boolean) => {
    const b = bookRef.current;
    const audio = audioRef.current;
    if (!b || !audio) return;
    const track = b.tracks[idx];
    trackIdxRef.current = idx;
    pendingSeekRef.current = Math.max(0, offset);
    audio.src = streamUrl(track.id);
    audio.defaultPlaybackRate = rateRef.current;
    audio.playbackRate = rateRef.current;
    audio.load();
    if (autoplay) {
      audio.play().catch((e: Error) => {
        if (e.name !== 'AbortError') setError('Playback was blocked. Tap play.');
      });
    }
  }, []);

  // ---- sleep timer ----------------------------------------------------------
  const clearSleep = useCallback(() => {
    sleepRef.current = null;
    sleepStartRef.current = null;
    setSleepKind(null);
    if (audioRef.current) audioRef.current.volume = 1;
  }, []);

  const stopForSleep = useCallback(() => {
    const audio = audioRef.current;
    const b = bookRef.current;
    if (b && sleepStartRef.current !== null) {
      const mark: SleepMark = { bookId: b.id, position: sleepStartRef.current, at: Date.now() };
      setSleepMark(mark);
      api.setSleepMark(b.id, mark.position).catch(() => undefined);
    }
    clearSleep();
    stoppedBySleepRef.current = true;
    audio?.pause();
  }, [clearSleep]);

  /** Seconds of real time left on the sleep timer, or null. */
  const sleepRemaining = useCallback(() => {
    const s = sleepRef.current;
    if (!s) return null;
    if (s.kind === 'minutes') return s.remainingMs / 1000;
    return Math.max(0, (s.stopAt - currentPosition()) / rateRef.current);
  }, [currentPosition]);

  const setSleep = useCallback(
    (setting: SleepSetting | null) => {
      if (!setting) return clearSleep();
      if (setting.kind === 'minutes') {
        sleepRef.current = { kind: 'minutes', remainingMs: setting.minutes * 60_000, stopAt: 0 };
      } else {
        const b = bookRef.current;
        const ch = chapterAt(b, currentPosition());
        if (!b || !ch) return;
        sleepRef.current = { kind: 'chapter', remainingMs: 0, stopAt: ch.end };
      }
      setSleepKind(setting.kind);
      sleepStartRef.current = currentPosition();
      if (audioRef.current) audioRef.current.volume = 1;
    },
    [clearSleep, currentPosition],
  );

  const addSleepMinutes = useCallback((minutes: number) => {
    const s = sleepRef.current;
    if (s?.kind === 'minutes') s.remainingMs += minutes * 60_000;
    else {
      sleepRef.current = { kind: 'minutes', remainingMs: minutes * 60_000, stopAt: 0 };
      sleepStartRef.current = currentPosition();
      setSleepKind('minutes');
    }
    if (audioRef.current) audioRef.current.volume = 1;
  }, [currentPosition]);

  /** Starts the timer from Settings → Bedtime, unless one is already running. */
  const maybeAutoSleep = useCallback(() => {
    if (sleepRef.current) return;
    const prefs = loadPrefs();
    if (prefs.autoSleep === 'off' || (prefs.autoSleepNightOnly && !isNight())) return;
    setSleep(prefs.autoSleep === 'chapter' ? { kind: 'chapter' } : { kind: 'minutes', minutes: prefs.autoSleep });
  }, [setSleep]);



  // One loop drives the clock display, the sleep countdown + fade, and periodic saves.
  useEffect(() => {
    let last = performance.now();
    const id = window.setInterval(() => {
      const nowTs = performance.now();
      const elapsed = nowTs - last;
      last = nowTs;
      const audio = audioRef.current;
      const isPlaying = !!audio && !audio.paused;

      const s = sleepRef.current;
      if (s && isPlaying) {
        if (s.kind === 'minutes') s.remainingMs -= elapsed;
        const remaining = sleepRemaining() ?? 0;
        if (remaining <= 0.2) {
          stopForSleep();
        } else if (audio) {
          audio.volume = remaining < FADE_SECONDS ? Math.max(0.02, remaining / FADE_SECONDS) : 1;
        }
      }

      if (isPlaying && Date.now() - lastSaveRef.current > SAVE_EVERY_MS) save();

      const position = currentPosition();
      const remaining = sleepRemaining();
      setClock((c) =>
        Math.abs(c.position - position) < 0.05 && c.sleepRemaining === remaining ? c : { position, sleepRemaining: remaining },
      );
    }, 250);
    return () => window.clearInterval(id);
  }, [currentPosition, save, sleepRemaining, stopForSleep]);

  // ---- audio element events -------------------------------------------------
  useEffect(() => {
    const audio = audioRef.current!;
    const onLoaded = () => {
      if (pendingSeekRef.current !== null) {
        audio.currentTime = pendingSeekRef.current;
        pendingSeekRef.current = null;
      }
      audio.playbackRate = rateRef.current;
      setLoading(false);
    };
    const onPlay = () => {
      setPlaying(true);
      setError(null);
    };
    const onPause = () => {
      setPlaying(false);
      pausedAtRef.current = Date.now();
      save();
    };
    const onWaiting = () => setLoading(true);
    const onPlaying = () => setLoading(false);
    const onError = () => {
      setLoading(false);
      if (audio.src) setError('Could not load audio. Check your connection.');
    };
    const onEnded = () => {
      const b = bookRef.current;
      if (!b) return;
      const s = sleepRef.current;
      const track = b.tracks[trackIdxRef.current];
      if (s?.kind === 'chapter' && s.stopAt <= track.start + track.duration + 1) {
        // Chapter ended exactly at a file boundary: stop here, start of next file next time.
        if (trackIdxRef.current + 1 < b.tracks.length) loadTrack(trackIdxRef.current + 1, 0, false);
        stopForSleep();
        return;
      }
      if (trackIdxRef.current + 1 < b.tracks.length) {
        loadTrack(trackIdxRef.current + 1, 0, true);
      } else {
        setPlaying(false);
        clearSleep();
        save({ finished: true });
        celebrateFinish(b);
      }
    };

    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('error', onError);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('ended', onEnded);
    };
  }, [clearSleep, loadTrack, save, stopForSleep]);

  // Save when the app is backgrounded or closed.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') save({ beacon: true });
    };
    const onPageHide = () => save({ beacon: true });
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [save]);

  // ---- actions --------------------------------------------------------------
  const seek = useCallback(
    (position: number) => {
      const b = bookRef.current;
      const audio = audioRef.current;
      if (!b || !audio) return;
      const target = Math.min(Math.max(0, position), Math.max(0, b.duration - 0.5));
      const idx = trackIndexFor(b, target);
      const offset = target - b.tracks[idx].start;
      if (idx === trackIdxRef.current && pendingSeekRef.current !== null) {
        pendingSeekRef.current = offset; // track still loading; applied on loadedmetadata
      } else if (idx === trackIdxRef.current && audio.readyState > 0) {
        audio.currentTime = offset;
      } else {
        loadTrack(idx, offset, !audio.paused);
      }
      setClock((c) => ({ ...c, position: target }));
    },
    [loadTrack],
  );

  const play = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !bookRef.current) return;
    // Auto-rewind: you probably dozed off or lost the thread.
    let rewind = 0;
    if (stoppedBySleepRef.current) rewind = REWIND_AFTER_SLEEP;
    else if (pausedAtRef.current) rewind = rewindForPause(Date.now() - pausedAtRef.current);
    stoppedBySleepRef.current = false;
    pausedAtRef.current = null;
    if (rewind > 0) seek(currentPosition() - rewind);
    audio.volume = 1;
    maybeAutoSleep();
    audio.play().catch((e: Error) => {
      if (e.name !== 'AbortError') setError('Playback was blocked. Tap play again.');
    });
  }, [currentPosition, maybeAutoSleep, seek]);

  const pause = useCallback(() => audioRef.current?.pause(), []);

  const toggle = useCallback(() => {
    if (audioRef.current?.paused) play();
    else pause();
  }, [pause, play]);

  const skip = useCallback((seconds: number) => seek(currentPosition() + seconds), [currentPosition, seek]);

  const nextChapter = useCallback(() => {
    const b = bookRef.current;
    if (!b) return;
    const pos = currentPosition();
    const next = b.chapters.find((c) => c.start > pos + 0.5);
    if (next) seek(next.start);
  }, [currentPosition, seek]);

  const prevChapter = useCallback(() => {
    const b = bookRef.current;
    if (!b) return;
    const pos = currentPosition();
    const current = chapterAt(b, pos);
    if (!current) return;
    // Like a CD player: restart the chapter, or go back one if we're near its start.
    if (pos - current.start > 3 || current.idx === 0) seek(current.start);
    else seek(b.chapters[current.idx - 1].start);
  }, [currentPosition, seek]);

  const setRate = useCallback((r: number) => {
    rateRef.current = r;
    setRateState(r);
    lsSet(LS_RATE, String(r));
    if (audioRef.current) {
      audioRef.current.defaultPlaybackRate = r;
      audioRef.current.playbackRate = r;
    }
  }, []);

  const open = useCallback(
    async (target: number | BookDetail, opts: { autoplay?: boolean; position?: number } = {}) => {
      const audio = audioRef.current;
      const bookId = typeof target === 'number' ? target : target.id;
      if (bookRef.current?.id === bookId) {
        if (opts.position !== undefined) {
          // Explicit jump (e.g. chapter tap): don't auto-rewind past it.
          pausedAtRef.current = null;
          stoppedBySleepRef.current = false;
          seek(opts.position);
        }
        if (opts.autoplay) play();
        return;
      }
      if (bookRef.current) save();
      setError(null);
      setLoading(true);
      try {
        const detail = typeof target === 'number' ? (await api.book(bookId)).book : target;
        if (detail.tracks.length === 0) throw new Error('This book has no audio files');
        const start =
          opts.position ?? (detail.progress && !detail.progress.finished ? detail.progress.position : 0);
        audio?.pause();
        clearSleep();
        stoppedBySleepRef.current = false;
        pausedAtRef.current = null;
        bookRef.current = detail;
        setBook(detail);
        setSleepMark(detail.sleepMark ? { bookId: detail.id, ...detail.sleepMark } : null);
        lastSavedPosRef.current = start;
        serverUpdatedAtRef.current = detail.progress?.updatedAt ?? 0;
        lsSet(LS_LAST_BOOK, String(bookId));
        const idx = trackIndexFor(detail, start);
        loadTrack(idx, start - detail.tracks[idx].start, !!opts.autoplay);
        setClock({ position: start, sleepRemaining: null });
        if (opts.autoplay) maybeAutoSleep();
        if (!opts.autoplay) setLoading(false);
      } catch (e) {
        setLoading(false);
        setError((e as Error).message);
        if ((e as { status?: number }).status === 404) lsSet(LS_LAST_BOOK, null);
      }
    },
    [clearSleep, loadTrack, maybeAutoSleep, play, save, seek],
  );

  const dismissSleepMark = useCallback(() => {
    const b = bookRef.current;
    setSleepMark(null);
    if (b) api.clearSleepMark(b.id).catch(() => undefined);
  }, []);

  const jumpToSleepMark = useCallback(() => {
    const mark = sleepMark;
    if (!mark || bookRef.current?.id !== mark.bookId) return;
    // An explicit jump: no extra auto-rewind on the next play.
    stoppedBySleepRef.current = false;
    pausedAtRef.current = null;
    seek(mark.position);
    dismissSleepMark();
  }, [dismissSleepMark, seek, sleepMark]);

  const close = useCallback(() => {
    const audio = audioRef.current;
    save();
    audio?.pause();
    audio?.removeAttribute('src');
    audio?.load();
    clearSleep();
    bookRef.current = null;
    setBook(null);
    setPlaying(false);
    lsSet(LS_LAST_BOOK, null);
  }, [clearSleep, save]);

  // Stop audio if the provider unmounts (e.g. logout); a detached <audio> keeps playing otherwise.
  useEffect(() => {
    const audio = audioRef.current;
    return () => audio?.pause();
  }, []);

  // Restore the last book (paused) after a reload.
  useEffect(() => {
    const last = Number(lsGet(LS_LAST_BOOK));
    if (last) void open(last, { autoplay: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- cross-device sync ----------------------------------------------------
  // When the app comes back to the foreground, pick up progress (and sleep marks / prefs)
  // made on another device, but only while paused, so we never yank someone mid-listen.
  useEffect(() => {
    void syncPrefs();
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      void syncPrefs();
      const b = bookRef.current;
      const audio = audioRef.current;
      if (!b || !audio || !audio.paused) return;
      try {
        const { book: fresh } = await api.book(b.id);
        if (bookRef.current?.id !== fresh.id || !audio.paused) return;
        setSleepMark(fresh.sleepMark ? { bookId: fresh.id, ...fresh.sleepMark } : null);
        const p = fresh.progress;
        if (!p || p.updatedAt <= serverUpdatedAtRef.current) return;
        serverUpdatedAtRef.current = p.updatedAt;
        const target = p.finished ? 0 : p.position;
        if (Math.abs(target - currentPosition()) > 5) {
          // Someone listened elsewhere: this is a fresh starting point, not a pause to rewind from.
          pausedAtRef.current = null;
          stoppedBySleepRef.current = false;
          lastSavedPosRef.current = target;
          seek(target);
        }
      } catch {
        /* offline: keep local position */
      }
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [currentPosition, seek]);

  // ---- lock screen / headphone controls (Media Session API) ----------------
  const chapterTitle = chapterAt(book, clock.position)?.title;
  // Lock screen shows the sleep countdown, refreshed once a minute (cheap, and enough at bedtime).
  const sleepMinutes = clock.sleepRemaining !== null ? Math.max(1, Math.ceil(clock.sleepRemaining / 60)) : null;
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (!book) {
      ms.metadata = null;
      return;
    }
    const cover = coverUrl(book);
    ms.metadata = new MediaMetadata({
      title: chapterTitle && book.chapters.length > 1 ? chapterTitle : book.title,
      artist: sleepMinutes ? `Sleep in ${sleepMinutes} min · ${book.author ?? book.title}` : book.author ?? '',
      album: book.title,
      artwork: cover ? [{ src: new URL(cover, location.href).href, sizes: '512x512' }] : [],
    });
  }, [book, chapterTitle, sleepMinutes]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => play()],
      ['pause', () => pause()],
      ['seekbackward', (d) => skip(-(d.seekOffset ?? 30))],
      ['seekforward', (d) => skip(d.seekOffset ?? 30)],
      ['previoustrack', () => prevChapter()],
      ['nexttrack', () => nextChapter()],
      ['seekto', (d) => d.seekTime !== undefined && seek(d.seekTime)],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* action unsupported */
      }
    }
  }, [nextChapter, pause, play, prevChapter, seek, skip]);

  useEffect(() => {
    if (!('mediaSession' in navigator) || !book) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    try {
      navigator.mediaSession.setPositionState({
        duration: Math.max(book.duration, 1),
        playbackRate: rate,
        position: Math.min(clock.position, book.duration),
      });
    } catch {
      /* ignore */
    }
    // Only refresh on coarse changes; the OS extrapolates in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, playing, rate, Math.floor(clock.position / 15)]);

  const value = useMemo<PlayerApi>(
    () => ({
      book,
      playing,
      loading,
      error,
      rate,
      sleep: sleepKind ? { kind: sleepKind } : null,
      open,
      play,
      pause,
      toggle,
      seek,
      skip,
      nextChapter,
      prevChapter,
      setRate,
      setSleep,
      addSleepMinutes,
      sleepMark,
      jumpToSleepMark,
      dismissSleepMark,
      close,
    }),
    [book, playing, loading, error, rate, sleepKind, open, play, pause, toggle, seek, skip, nextChapter, prevChapter, setRate, setSleep, addSleepMinutes, sleepMark, jumpToSleepMark, dismissSleepMark, close],
  );

  return (
    <PlayerContext.Provider value={value}>
      <ClockContext.Provider value={clock}>
        {children}
        <audio ref={audioRef} preload="auto" />
      </ClockContext.Provider>
    </PlayerContext.Provider>
  );
}
