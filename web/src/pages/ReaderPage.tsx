import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ePub from 'epubjs';
import type { Contents, Book as EpubBook, NavItem, Rendition } from 'epubjs';
import { api, beaconProgress, ebookFileUrl } from '../api';
import type { BookDetail } from '../api';
import { celebrateFinish } from '../components/FinishedSheet';
import { ChevronLeftIcon, ListIcon } from '../components/Icons';
import { loadPrefs, usePrefs } from '../prefs';
import type { Prefs } from '../prefs';
import '../styles-reader.css';
import { READER_FONTS, READER_THEMES, applyBookFont, bookFontCss, ensureAppFontFaces } from '../readerFonts';
import type { ReaderFont } from '../readerFonts';

const THEMES = READER_THEMES;
const SAVE_DEBOUNCE_MS = 1500;
const FONT_MIN = 80;
const FONT_MAX = 200;

interface Relocated {
  start: { cfi: string; href: string; index: number; percentage?: number; displayed?: { page: number; total: number } };
  atEnd?: boolean;
}

/** Every book page currently on screen (epub.js returns an array, though its types say otherwise). */
const pagesOf = (r: Rendition): Contents[] => ([] as Contents[]).concat(r.getContents() as unknown as Contents | Contents[]);

const fileOf = (href: string) => decodeURIComponent(href.split('#')[0]).split('/').pop() ?? '';

/** Flattens a nested table of contents. */
const flatToc = (items: NavItem[], depth = 0): (NavItem & { depth: number })[] =>
  items.flatMap((i) => [{ ...i, depth }, ...flatToc(i.subitems ?? [], depth + 1)]);

export function ReaderPage() {
  const { id } = useParams();
  const bookId = Number(id);
  const navigate = useNavigate();
  const [prefs, setPrefs] = usePrefs();
  const viewerRef = useRef<HTMLDivElement>(null);
  const epubRef = useRef<EpubBook | null>(null);
  const renditionRef = useRef<Rendition | null>(null);

  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [panel, setPanel] = useState<'none' | 'toc' | 'text'>('none');
  const [toc, setToc] = useState<(NavItem & { depth: number })[]>([]);
  const [percent, setPercent] = useState(0);
  const [chapterLabel, setChapterLabel] = useState('');

  // Latest location, kept in refs for save handlers.
  const cfiRef = useRef<string | null>(null);
  const fractionRef = useRef(0);
  const atEndRef = useRef(false);
  const saveTimer = useRef<number>();
  const lastSavedCfi = useRef<string | null>(null);
  const serverUpdatedAt = useRef(0);
  const tocRef = useRef<(NavItem & { depth: number })[]>([]);

  const save = useCallback(
    (beacon = false) => {
      const cfi = cfiRef.current;
      if (!cfi || cfi === lastSavedCfi.current) return;
      lastSavedCfi.current = cfi;
      const fraction = atEndRef.current ? 1 : fractionRef.current;
      if (beacon) beaconProgress(bookId, fraction, cfi);
      else
        api
          .saveProgress(bookId, fraction, atEndRef.current || undefined, cfi)
          .then((r) => {
            serverUpdatedAt.current = Math.max(serverUpdatedAt.current, r.updatedAt);
          })
          .catch(() => undefined);
    },
    [bookId],
  );

  // ---- open the book ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let epub: EpubBook | null = null;
    (async () => {
      try {
        const { book } = await api.book(bookId);
        if (cancelled) return;
        if (book.kind !== 'ebook') throw new Error('This is not an ebook');
        setDetail(book);
        serverUpdatedAt.current = book.progress?.updatedAt ?? 0;
        const startAt = book.progress && !book.progress.finished ? book.progress.locator ?? undefined : undefined;
        lastSavedCfi.current = startAt ?? null;

        epub = ePub(ebookFileUrl(bookId), { openAs: 'epub' });
        epubRef.current = epub;
        const rendition = epub.renderTo(viewerRef.current!, {
          width: '100%',
          height: '100%',
          flow: 'paginated',
          spread: 'none',
          allowScriptedContent: false,
        });
        renditionRef.current = rendition;
        for (const [name, t] of Object.entries(THEMES)) {
          rendition.themes.register(name, {
            'html, body': { background: `${t.bg} !important`, color: `${t.fg} !important` },
            'body *': { color: 'inherit !important', background: 'transparent !important', 'border-color': `${t.fg}33 !important` },
            a: { color: `${t.link} !important` },
            img: { opacity: '0.85' },
            p: { 'line-height': '1.6 !important' },
          });
        }

        // Fonts: each book page gets the font faces and the reader's choice as it loads.
        rendition.hooks.content.register((contents: Contents) => {
          void contents.addStylesheetCss(bookFontCss(), 'tb-fonts');
          applyBookFont(contents.document, loadPrefs().readerFont);
        });

        // Apply colors before the first page renders so there's no bright flash.
        rendition.themes.select(loadPrefs().readerTheme);
        rendition.themes.fontSize(`${loadPrefs().readerFontSize}%`);

        rendition.on('relocated', (loc: Relocated) => {
          cfiRef.current = loc.start.cfi;
          atEndRef.current = !!loc.atEnd;
          if (loc.atEnd) celebrateFinish(book);
          const fromLocations = epub!.locations.length() > 0 ? epub!.locations.percentageFromCfi(loc.start.cfi) : null;
          fractionRef.current = fromLocations ?? loc.start.index / Math.max(1, (epub!.spine as unknown as { length: number }).length);
          setPercent(Math.round((loc.atEnd ? 1 : fractionRef.current) * 100));
          // Name the chapter only when exactly one contents entry points at this file; several chapters
          // can share a file, and guessing would show the wrong one. Otherwise show the page in this section.
          const file = fileOf(loc.start.href);
          const hits = tocRef.current.filter((t) => fileOf(t.href) === file);
          const shown = loc.start.displayed;
          setChapterLabel(
            hits.length === 1 ? hits[0].label.trim() : shown && shown.total > 1 ? `Page ${shown.page} of ${shown.total} in this section` : '',
          );
          window.clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(() => save(), SAVE_DEBOUNCE_MS);
        });
        // Keyboard paging also works while focus is inside the book iframe.
        rendition.on('keyup', (e: KeyboardEvent) => {
          if (e.key === 'ArrowRight') void rendition.next();
          if (e.key === 'ArrowLeft') void rendition.prev();
        });

        await epub.ready;
        const nav = await epub.loaded.navigation;
        tocRef.current = flatToc(nav.toc);
        setToc(tocRef.current);
        await rendition.display(startAt);
        if (cancelled) return;
        setReady(true);

        // Exact percentages need a location index; cache it per book since it takes a moment to build.
        const cacheKey = `tb.locations.${bookId}`;
        let cached: string | null = null;
        try {
          cached = localStorage.getItem(cacheKey);
        } catch {
          /* ignore */
        }
        if (cached) epub.locations.load(cached);
        else {
          await epub.locations.generate(1600);
          try {
            localStorage.setItem(cacheKey, epub.locations.save());
          } catch {
            /* storage full: fine, just regenerate next time */
          }
        }
        if (!cancelled && cfiRef.current) {
          fractionRef.current = epub.locations.percentageFromCfi(cfiRef.current);
          setPercent(Math.round(fractionRef.current * 100));
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'Could not open this book');
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(saveTimer.current);
      save(true);
      renditionRef.current = null;
      epubRef.current = null;
      epub?.destroy();
    };
  }, [bookId, save]);

  // ---- theme + font size --------------------------------------------------------
  useEffect(() => {
    const r = renditionRef.current;
    if (!r || !ready) return;
    r.themes.select(prefs.readerTheme);
    r.themes.fontSize(`${prefs.readerFontSize}%`);
  }, [prefs.readerTheme, prefs.readerFontSize, ready]);

  // ---- typeface -------------------------------------------------------------------
  useEffect(ensureAppFontFaces, []);
  useEffect(() => {
    const r = renditionRef.current;
    if (!r || !ready) return;
    for (const page of pagesOf(r)) applyBookFont(page.document, prefs.readerFont);
    // The text reflows with the new font: go back to the same spot rather than a shifted page.
    if (cfiRef.current) void r.display(cfiRef.current);
  }, [prefs.readerFont, ready]);

  // ---- save on hide; pick up progress from other devices on return ---------------
  useEffect(() => {
    const onVisibility = async () => {
      if (document.visibilityState === 'hidden') {
        save(true);
        return;
      }
      try {
        const { book } = await api.book(bookId);
        const p = book.progress;
        if (p?.locator && p.updatedAt > serverUpdatedAt.current && p.locator !== cfiRef.current) {
          serverUpdatedAt.current = p.updatedAt;
          lastSavedCfi.current = p.locator;
          await renditionRef.current?.display(p.locator);
        }
      } catch {
        /* offline */
      }
    };
    const onPageHide = () => save(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [bookId, save]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') void renditionRef.current?.next();
      if (e.key === 'ArrowLeft') void renditionRef.current?.prev();
    };
    window.addEventListener('keyup', onKey);
    return () => window.removeEventListener('keyup', onKey);
  }, []);

  // ---- touch: tap left/right third to turn pages, middle to toggle bars; swipe works too ---
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent) => {
    touchStart.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || panel !== 'none') return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const r = renditionRef.current;
    if (!r) return;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      void (dx < 0 ? r.next() : r.prev());
      return;
    }
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    const w = (e.currentTarget as HTMLElement).clientWidth;
    if (e.clientX < w / 3) void r.prev();
    else if (e.clientX > (w * 2) / 3) void r.next();
    else setChrome((c) => !c);
  };

  const theme = THEMES[prefs.readerTheme];
  const goTo = (href: string) => {
    setPanel('none');
    void renditionRef.current?.display(href);
  };
  const changeFont = (delta: number) =>
    setPrefs({ readerFontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, prefs.readerFontSize + delta)) });

  return (
    <div className="reader" style={{ background: theme.bg, color: theme.fg }}>
      <header className={`reader-bar reader-top ${chrome ? '' : 'hidden'}`}>
        <button className="icon-btn" onClick={() => navigate(-1)} aria-label="Close book">
          <ChevronLeftIcon size={24} />
        </button>
        <span className="reader-title">{detail?.title}</span>
        <button className="icon-btn reader-aa" onClick={() => setPanel(panel === 'text' ? 'none' : 'text')} aria-label="Text settings">
          Aa
        </button>
        <button className="icon-btn" onClick={() => setPanel(panel === 'toc' ? 'none' : 'toc')} aria-label="Contents" disabled={!toc.length}>
          <ListIcon size={22} />
        </button>
      </header>

      <div className="reader-stage">
        <div ref={viewerRef} className="reader-viewer" />
        {/* Gesture layer sits over the book iframe, which would otherwise swallow taps. */}
        <div className="reader-gestures" onPointerDown={onPointerDown} onPointerUp={onPointerUp} />
        {!ready && !error && <p className="reader-msg">Opening book…</p>}
        {error && <p className="reader-msg error">{error}</p>}
      </div>

      <footer className={`reader-bar reader-bottom ${chrome ? '' : 'hidden'}`}>
        <span className="reader-chapter">{chapterLabel}</span>
        <span className="reader-pct">{percent}%</span>
      </footer>
      <div className="reader-progress" style={{ width: `${percent}%`, background: theme.link }} />

      {panel !== 'none' && (
        <div className="sheet-backdrop" onClick={() => setPanel('none')}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            {panel === 'text' ? (
              <>
                <h2>Text</h2>
                <div className="reader-font-row">
                  <button className="btn" onClick={() => changeFont(-10)} disabled={prefs.readerFontSize <= FONT_MIN} aria-label="Smaller text">
                    A−
                  </button>
                  <span>{prefs.readerFontSize}%</span>
                  <button className="btn" onClick={() => changeFont(10)} disabled={prefs.readerFontSize >= FONT_MAX} aria-label="Larger text">
                    A+
                  </button>
                </div>
                <h3 className="reader-sub">Font</h3>
                <div className="reader-fonts" role="radiogroup" aria-label="Font">
                  {(Object.keys(READER_FONTS) as ReaderFont[]).map((k) => (
                    <button
                      key={k}
                      role="radio"
                      aria-checked={prefs.readerFont === k}
                      className={`reader-font ${prefs.readerFont === k ? 'active' : ''}`}
                      onClick={() => setPrefs({ readerFont: k })}
                    >
                      <span className="reader-font-sample" style={{ fontFamily: READER_FONTS[k].family ?? 'inherit' }}>
                        Aa
                      </span>
                      <span className="reader-font-name">{READER_FONTS[k].label}</span>
                      <span className="reader-font-hint">{READER_FONTS[k].hint}</span>
                    </button>
                  ))}
                </div>
                <h3 className="reader-sub">Colors</h3>
                <div className="chips tight">
                  {(Object.keys(THEMES) as Prefs['readerTheme'][]).map((k) => (
                    <button
                      key={k}
                      className={`chip theme-chip ${prefs.readerTheme === k ? 'chip-active' : ''}`}
                      onClick={() => setPrefs({ readerTheme: k })}
                      aria-pressed={prefs.readerTheme === k}
                    >
                      <span className="theme-swatch" style={{ background: THEMES[k].bg, color: THEMES[k].fg }}>
                        Aa
                      </span>
                      {THEMES[k].label}
                    </button>
                  ))}
                </div>
                <p className="hint">Saved to your account, so every device reads the same way.</p>
              </>
            ) : (
              <>
                <h2>Contents</h2>
                <ol className="toc-list">
                  {toc.map((t, i) => (
                    <li key={`${t.href}-${i}`}>
                      <button
                        className={`chapter-row ${t.label.trim() === chapterLabel ? 'current' : ''}`}
                        style={{ paddingLeft: `${0.25 + t.depth}rem` }}
                        onClick={() => goTo(t.href)}
                      >
                        <span className="chapter-title">{t.label.trim()}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
