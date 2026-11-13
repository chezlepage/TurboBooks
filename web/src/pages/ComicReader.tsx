import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, beaconProgress } from '../api';
import type { BookDetail, ComicInfo } from '../api';
import { celebrateFinish } from '../components/FinishedSheet';
import { ChevronLeftIcon } from '../components/Icons';
import '../styles-comic.css';

/** rtl: manga (right to left); ltr: western comics; scroll: webtoons (one long vertical strip). */
type Mode = 'rtl' | 'ltr' | 'scroll';
type Fit = 'screen' | 'width';

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'rtl', label: 'Manga ←' },
  { mode: 'ltr', label: 'Comic →' },
  { mode: 'scroll', label: 'Webtoon ↓' },
];
const SAVE_DEBOUNCE_MS = 1200;

const modeKey = (id: number) => `tb.comicMode.${id}`;
const fitKey = 'tb.comicFit';
const readLocal = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeLocal = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};

/** The page saved as "page:12" (or worked out from the saved fraction). */
function startPage(book: BookDetail, count: number): number {
  const p = book.progress;
  if (!p || p.finished) return 0;
  const m = p.locator?.match(/^page:(\d+)$/);
  const n = m ? Number(m[1]) : Math.round(p.position * count) - 1;
  return Math.min(Math.max(n, 0), count - 1);
}

/**
 * Comics, manga and webtoons (.cbz/.cbr). Paged (tap the sides or swipe; manga goes right to
 * left) or one long vertical strip for webtoons. Tap the middle for the controls. The reading
 * direction is guessed from the file and can be changed; the choice is remembered per book.
 */
export function ComicReader() {
  const { id } = useParams();
  const bookId = Number(id);
  const navigate = useNavigate();

  const [book, setBook] = useState<BookDetail | null>(null);
  const [comic, setComic] = useState<ComicInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [mode, setModeState] = useState<Mode>('ltr');
  const [fit, setFitState] = useState<Fit>(() => (readLocal(fitKey) === 'width' ? 'width' : 'screen'));
  const [chrome, setChrome] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const count = comic?.pages.length ?? 0;
  const pageUrl = (n: number) => `/api/books/${bookId}/comic/pages/${n}?v=${comic?.version ?? ''}`;

  // ---- open -------------------------------------------------------------------
  useEffect(() => {
    let live = true;
    Promise.all([api.book(bookId), api.comic(bookId)])
      .then(([{ book: b }, c]) => {
        if (!live) return;
        setBook(b);
        setComic(c);
        setPage(startPage(b, c.pages.length));
        const saved = readLocal(modeKey(bookId));
        setModeState(saved === 'rtl' || saved === 'ltr' || saved === 'scroll' ? saved : c.layout === 'webtoon' ? 'scroll' : c.direction);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [bookId]);

  const setMode = (m: Mode) => {
    setModeState(m);
    writeLocal(modeKey(bookId), m);
  };
  const setFit = (f: Fit) => {
    setFitState(f);
    writeLocal(fitKey, f);
  };

  // ---- progress -----------------------------------------------------------------
  const pageRef = useRef(0);
  const lastSaved = useRef<number | null>(null);
  const saveTimer = useRef<number>();
  const finishedRef = useRef(false);
  const save = useCallback(
    (beacon = false) => {
      if (!count) return;
      const n = pageRef.current;
      const finished = finishedRef.current;
      if (n === lastSaved.current && !finished) return;
      lastSaved.current = n;
      const fraction = finished ? 1 : (n + 1) / count;
      if (beacon) beaconProgress(bookId, fraction, `page:${n}`);
      else api.saveProgress(bookId, fraction, finished || undefined, `page:${n}`).catch(() => undefined);
    },
    [bookId, count],
  );
  useEffect(() => {
    if (!count) return;
    pageRef.current = page;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => save(), SAVE_DEBOUNCE_MS);
  }, [page, count, save]);
  useEffect(() => {
    const flush = () => save(true);
    const onHide = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      window.clearTimeout(saveTimer.current);
      save();
    };
  }, [save]);

  const finish = useCallback(() => {
    if (finishedRef.current || !book) return;
    finishedRef.current = true;
    save();
    celebrateFinish(book);
  }, [book, save]);

  // ---- paged navigation -----------------------------------------------------------
  const atEndRef = useRef(false);
  const showEnd = (v: boolean) => {
    atEndRef.current = v;
    setAtEnd(v);
  };
  const go = useCallback(
    (delta: number) => {
      if (!count) return;
      if (atEndRef.current) {
        if (delta < 0) showEnd(false);
        return;
      }
      const next = pageRef.current + delta;
      if (next >= count) {
        finish();
        showEnd(true);
        return;
      }
      pageRef.current = Math.max(0, next);
      setPage(pageRef.current);
    },
    [count, finish],
  );

  useEffect(() => {
    if (mode === 'scroll') return;
    const onKey = (e: KeyboardEvent) => {
      const forward = mode === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const back = mode === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === forward || e.key === ' ' || e.key === 'PageDown') go(1);
      else if (e.key === back || e.key === 'PageUp') go(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, mode]);

  // Load the next pages before they're needed.
  useEffect(() => {
    if (!comic || mode === 'scroll') return;
    for (const n of [page + 1, page + 2, page - 1]) {
      if (n >= 0 && n < count) new Image().src = pageUrl(n);
    }
  }, [page, comic, mode]);

  // Taps: the outer thirds turn the page (which side is "next" depends on the direction), the middle shows controls.
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d || e.pointerType === 'mouse' && e.button !== 0) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const forwardSign = mode === 'rtl' ? 1 : -1; // manga: drag to the right for the next page
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      go(Math.sign(dx) === forwardSign ? 1 : -1);
      return;
    }
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10 || Date.now() - d.t > 600) return;
    const third = window.innerWidth / 3;
    if (e.clientX < third) go(mode === 'rtl' ? 1 : -1);
    else if (e.clientX > third * 2) go(mode === 'rtl' ? -1 : 1);
    else setChrome((c) => !c);
  };

  // ---- webtoon scrolling --------------------------------------------------------------
  const strip = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (mode !== 'scroll' || !comic || restored.current) return;
    const el = strip.current?.querySelector<HTMLElement>(`[data-page="${pageRef.current}"]`);
    if (el) {
      el.scrollIntoView({ block: 'start' });
      restored.current = true;
    }
  }, [mode, comic]);
  useEffect(() => {
    restored.current = false;
  }, [mode]);
  const onScroll = () => {
    const box = strip.current;
    if (!box) return;
    const probe = box.scrollTop + box.clientHeight * 0.3;
    let current = 0;
    for (const el of box.querySelectorAll<HTMLElement>('[data-page]')) {
      if (el.offsetTop <= probe) current = Number(el.dataset.page);
      else break;
    }
    if (current !== pageRef.current) setPage(current);
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) finish();
  };
  const jump = (n: number) => {
    showEnd(false);
    setPage(n);
    pageRef.current = n;
    if (mode === 'scroll') strip.current?.querySelector<HTMLElement>(`[data-page="${n}"]`)?.scrollIntoView({ block: 'start' });
  };

  if (error) {
    return (
      <div className="comic comic-message">
        <p className="error">{error}</p>
        <button className="btn" onClick={() => navigate(`/book/${bookId}`)}>
          Back to the book
        </button>
      </div>
    );
  }
  if (!comic || !book) return <div className="comic comic-message"><span className="spinner" /></div>;

  const ratio = (n: number): CSSProperties => {
    const [w, h] = comic.pages[n] ?? [0, 0];
    return w > 0 && h > 0 ? { aspectRatio: `${w} / ${h}` } : {};
  };

  return (
    <div className={`comic comic-${mode}`}>
      {mode === 'scroll' ? (
        <div className="comic-strip" ref={strip} onScroll={onScroll} onClick={() => setChrome((c) => !c)}>
          {comic.pages.map((_, n) => (
            <img
              key={n}
              data-page={n}
              src={pageUrl(n)}
              alt={`Page ${n + 1}`}
              loading={Math.abs(n - page) < 3 ? 'eager' : 'lazy'}
              decoding="async"
              style={ratio(n)}
            />
          ))}
          <div className="comic-strip-end">The end</div>
        </div>
      ) : (
        <div className={`comic-pages fit-${fit}`} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
          {atEnd ? (
            <div className="comic-end" onPointerUp={(e) => e.stopPropagation()}>
              <h2>The end</h2>
              <p className="muted">{book.title}</p>
              <button className="btn btn-primary" onClick={() => navigate(`/book/${bookId}`)}>
                Back to the book
              </button>
              <button className="btn btn-ghost" onClick={() => showEnd(false)}>
                Last page
              </button>
            </div>
          ) : (
            <img key={page} src={pageUrl(page)} alt={`Page ${page + 1}`} draggable={false} style={fit === 'width' ? ratio(page) : undefined} />
          )}
        </div>
      )}

      {chrome && (
        <>
          <header className="comic-top">
            <button className="icon-btn" onClick={() => navigate(`/book/${bookId}`)} aria-label="Close">
              <ChevronLeftIcon size={26} />
            </button>
            <span className="comic-title">{book.title}</span>
            <span className="comic-count">
              {Math.min(page + 1, count)} / {count}
            </span>
          </header>
          <footer className="comic-bottom">
            <input
              type="range"
              min={0}
              max={count - 1}
              value={page}
              onChange={(e) => jump(Number(e.target.value))}
              aria-label="Page"
              // Manga: page 1 on the right, like the book.
              dir={mode === 'rtl' ? 'rtl' : 'ltr'}
            />
            <div className="comic-options">
              <div className="segmented" role="radiogroup" aria-label="Reading direction">
                {MODES.map((m) => (
                  <button key={m.mode} role="radio" aria-checked={mode === m.mode} className={mode === m.mode ? 'active' : ''} onClick={() => setMode(m.mode)}>
                    {m.label}
                  </button>
                ))}
              </div>
              {mode !== 'scroll' && (
                <div className="segmented" role="radiogroup" aria-label="Page size">
                  <button role="radio" aria-checked={fit === 'screen'} className={fit === 'screen' ? 'active' : ''} onClick={() => setFit('screen')}>
                    Whole page
                  </button>
                  <button role="radio" aria-checked={fit === 'width'} className={fit === 'width' ? 'active' : ''} onClick={() => setFit('width')}>
                    Fit width
                  </button>
                </div>
              )}
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
