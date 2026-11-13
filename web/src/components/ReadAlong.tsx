import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { BookDetail, ReadAlongChapter, ReadAlongStatus } from '../api';
import { usePrefs } from '../prefs';
import { READER_FONTS, READER_THEMES, ensureAppFontFaces } from '../readerFonts';
import { useClock, usePlayer } from '../player/PlayerContext';
import { BackIcon, ChevronDownIcon, ForwardIcon, PauseIcon, PlayIcon } from './Icons';
import '../styles-readalong.css';

const FONT_MIN = 80;
const FONT_MAX = 200;

/**
 * Read along: the ebook's text over the player, the sentence being read highlighted and kept
 * in view. Tap a sentence to jump the audio there. Uses the ebook reader's colors and font.
 */
export function ReadAlong({ book, onClose }: { book: BookDetail; onClose: () => void }) {
  const [status, setStatus] = useState<ReadAlongStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    (start = false) =>
      (start ? api.startReadAlong(book.id) : api.readAlong(book.id))
        .then((s) => {
          setStatus(s);
          setError(null);
          return s;
        })
        .catch((e: Error) => {
          setError(e.message);
          return null;
        }),
    [book.id],
  );

  // First look: start preparing straight away if it's never been done.
  useEffect(() => {
    void refresh().then((s) => {
      if (s?.state === 'idle') void refresh(true);
    });
  }, [refresh]);

  const busy = status?.state === 'queued' || status?.state === 'working';
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(id);
  }, [busy, refresh]);

  return (
    <div className="readalong" role="dialog" aria-label="Read along">
      {status?.state === 'ready' ? (
        <SyncedText book={book} chapters={status.chapters} onClose={onClose} />
      ) : (
        <div className="readalong-wait">
          <header className="readalong-head">
            <button className="icon-btn" onClick={onClose} aria-label="Close read along">
              <ChevronDownIcon size={28} />
            </button>
            <span>Read along</span>
            <span />
          </header>
          <div className="readalong-wait-body">
            {error ? (
              <p className="error">{error}</p>
            ) : !status || status.state === 'idle' ? (
              <span className="spinner" />
            ) : status.state === 'off' ? (
              <p>Read along isn't turned on for this TurboBooks yet. Ask whoever runs it to add speech recognition (Whisper).</p>
            ) : status.state === 'no_ebook' ? (
              <>
                <h2>Needs the ebook too</h2>
                <p className="muted">
                  To read along, the ebook of <strong>{book.title}</strong> has to be in your library as well. Request
                  it from the Request tab, then come back here.
                </p>
              </>
            ) : status.state === 'failed' ? (
              <>
                <h2>Couldn't line up the text</h2>
                <p className="muted">{status.error}</p>
                <button className="btn btn-primary" onClick={() => void refresh(true)}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <h2>Getting the text ready</h2>
                <p className="muted">
                  Lining up <strong>{status.ebook.title}</strong> with the narration. This happens once per book and
                  takes about {status.minutes} minute{status.minutes === 1 ? '' : 's'}. Keep listening; you can close
                  this and come back.
                </p>
                <div className="readalong-bar" aria-label="Progress">
                  <div style={{ width: `${Math.round(status.progress * 100)}%` }} />
                </div>
                <p className="muted small">
                  {status.state === 'queued' ? 'Waiting for its turn' : `${status.detail} · ${Math.round(status.progress * 100)}%`}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SyncedText({
  book,
  chapters,
  onClose,
}: {
  book: BookDetail;
  chapters: { title: string; start: number | null }[];
  onClose: () => void;
}) {
  const player = usePlayer();
  const { position } = useClock();
  const [prefs, setPrefs] = usePrefs();
  const theme = READER_THEMES[prefs.readerTheme];
  const family = READER_FONTS[prefs.readerFont].family ?? "Georgia, 'Times New Roman', serif";
  useEffect(ensureAppFontFaces, []);

  // The chapter being read: the last one that has started.
  const current = useMemo(() => {
    let found = chapters.findIndex((c) => c.start !== null);
    chapters.forEach((c, i) => {
      if (c.start !== null && c.start <= position + 0.3) found = i;
    });
    return found;
  }, [chapters, position]);

  const [loaded, setLoaded] = useState<Map<number, ReadAlongChapter>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (current < 0) return;
    // This chapter, and the next so turning over is instant.
    for (const n of [current, current + 1]) {
      if (n >= chapters.length || loaded.has(n)) continue;
      api
        .readAlongChapter(book.id, n)
        .then((c) => setLoaded((m) => new Map(m).set(n, c)))
        .catch((e: Error) => n === current && setLoadError(e.message));
    }
  }, [book.id, chapters.length, current, loaded]);
  const chapter = loaded.get(current) ?? null;

  // The sentence being read: the last one in this chapter whose time has come.
  const active = useMemo(() => {
    if (!chapter) return null;
    let found: string | null = null;
    chapter.paras.forEach((p, pi) =>
      p.forEach(([, t], si) => {
        if (t !== null && t <= position + 0.15) found = `${pi}-${si}`;
      }),
    );
    return found;
  }, [chapter, position]);

  // Keep the sentence in view, unless the listener is scrolling around themselves.
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const scrollToActive = useCallback((smooth: boolean) => {
    const el = scroller.current?.querySelector('.ra-s.active');
    if (el) el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  }, []);
  const firstScroll = useRef(true);
  useLayoutEffect(() => {
    if (!following) return;
    scrollToActive(!firstScroll.current);
    if (active) firstScroll.current = false;
  }, [active, chapter, following, scrollToActive]);
  const userScrolled = () => setFollowing(false);
  const follow = () => {
    setFollowing(true);
    scrollToActive(true);
  };

  const changeSize = (delta: number) =>
    setPrefs({ readerFontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, prefs.readerFontSize + delta)) });

  return (
    <div className="readalong-synced" style={{ background: theme.bg, color: theme.fg, ['--ra-accent' as string]: theme.link }}>
      <header className="readalong-head">
        <button className="icon-btn" onClick={onClose} aria-label="Close read along">
          <ChevronDownIcon size={28} />
        </button>
        <span className="readalong-chapter">{chapter?.title ?? chapters[current]?.title ?? ''}</span>
        <span className="readalong-size">
          <button className="icon-btn" onClick={() => changeSize(-10)} disabled={prefs.readerFontSize <= FONT_MIN} aria-label="Smaller text">
            A−
          </button>
          <button className="icon-btn" onClick={() => changeSize(10)} disabled={prefs.readerFontSize >= FONT_MAX} aria-label="Larger text">
            A+
          </button>
        </span>
      </header>

      <div
        className="readalong-text"
        ref={scroller}
        onWheel={userScrolled}
        onTouchMove={userScrolled}
        style={{ fontFamily: family, fontSize: `${(prefs.readerFontSize / 100) * 1.15}rem` }}
      >
        {loadError && !chapter && <p className="error">{loadError}</p>}
        {!chapter && !loadError && <span className="spinner" />}
        {chapter &&
          chapter.paras.map((p, pi) => (
            <p key={pi}>
              {p.map(([text, t], si) => {
                const k = `${pi}-${si}`;
                return (
                  <span
                    key={si}
                    className={`ra-s ${t !== null ? 'timed' : ''} ${k === active ? 'active' : ''}`}
                    onClick={
                      t !== null
                        ? () => {
                            player.seek(t);
                            follow();
                          }
                        : undefined
                    }
                  >
                    {text}{' '}
                  </span>
                );
              })}
            </p>
          ))}
        {chapter && current + 1 >= chapters.length && <p className="readalong-end muted small">The end</p>}
      </div>

      {!following && (
        <button className="readalong-follow" onClick={follow}>
          Back to the narrator
        </button>
      )}

      <div className="readalong-controls">
        <button className="icon-btn" onClick={() => player.skip(-30)} aria-label="Back 30 seconds">
          <BackIcon size={32} seconds={30} />
        </button>
        <button className="readalong-play" onClick={player.toggle} aria-label={player.playing ? 'Pause' : 'Play'}>
          {player.playing ? <PauseIcon size={30} /> : <PlayIcon size={30} />}
        </button>
        <button className="icon-btn" onClick={() => player.skip(30)} aria-label="Forward 30 seconds">
          <ForwardIcon size={32} seconds={30} />
        </button>
      </div>
    </div>
  );
}
