import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { BookLanguage, Edition, Release, WishRequest, WishResult } from '../api';
import { useAuth } from '../auth';
import { Cover } from '../components/Cover';
import {
  BookOpenIcon,
  CheckIcon,
  DownloadIcon,
  GlobeIcon,
  HeadphonesIcon,
  ImagesIcon,
  RetryIcon,
  SearchIcon,
  XIcon,
} from '../components/Icons';
import { toast } from '../components/Toast';
import '../styles-request.css';

type BookType = 'audiobook' | 'ebook';
type Tab = 'find' | 'mine';

const IN_FLIGHT = ['pending', 'searching', 'found', 'downloading', 'processing'];
const FAILED = ['failed', 'not_found'];

/** Friendly wording for Shelfarr's statuses. */
const STATUS_TEXT: Record<string, string> = {
  pending: 'Waiting in line',
  searching: 'Looking for a copy',
  found: 'Found a copy',
  downloading: 'Downloading',
  processing: 'Adding to your library',
  completed: 'In your library',
  not_found: "Couldn't find a copy",
  failed: 'Stopped',
};
const statusText = (s: string) => STATUS_TEXT[s] ?? s.replace(/_/g, ' ');

const needsPick = (r: WishRequest) => r.needsAttention && IN_FLIGHT.includes(r.status);

/** Indexer titles often contain HTML entities (&ndash;, &oacute;). Decode without executing anything. */
const decodeEntities = (s: string) => new DOMParser().parseFromString(s, 'text/html').documentElement.textContent ?? s;

const formatSize = (b: number | null) =>
  b ? (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`) : null;

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const sameBook = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The book language each person last picked, remembered on this device. */
const langKey = (userId: number | undefined) => `tb.requestLang.${userId ?? 0}`;
function loadLang(userId: number | undefined): string {
  try {
    return localStorage.getItem(langKey(userId)) || 'en';
  } catch {
    return 'en';
  }
}
function saveLang(userId: number | undefined, lang: string) {
  try {
    localStorage.setItem(langKey(userId), lang);
  } catch {
    /* private mode: just don't remember */
  }
}

function TypeTag({ type }: { type: string }) {
  const audio = type === 'audiobook';
  return (
    <span className="rq-type">
      {audio ? <HeadphonesIcon size={13} /> : <BookOpenIcon size={13} />}
      {audio ? 'Audiobook' : 'Ebook'}
    </span>
  );
}

/** Bottom sheet (centered dialog on wide screens). Closes on backdrop tap or Escape. */
function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return (
    <div className="sheet-backdrop rq-backdrop" onClick={onClose}>
      <div className="sheet rq-sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <button className="rq-sheet-close" aria-label="Close" onClick={onClose}>
          <XIcon size={18} />
        </button>
        {children}
      </div>
    </div>
  );
}

/** Pick the cover art to use for a requested book from its editions. */
function CoverSheet({
  result,
  lang,
  langName,
  selected,
  onPick,
  onClose,
}: {
  result: WishResult;
  lang: string;
  langName: string;
  selected: string | null;
  onPick: (url: string) => void;
  onClose: () => void;
}) {
  const [editions, setEditions] = useState<Edition[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .wishlistEditions(result.workId, lang)
      .then((r) => setEditions(r.editions))
      .catch(() => setFailed(true));
  }, [result.workId, lang]);

  return (
    <Sheet label="Choose a cover" onClose={onClose}>
      <h2 className="rq-sheet-title">Choose a cover</h2>
      <p className="muted small rq-sheet-sub">{result.title}: pick the edition you like best.</p>
      {failed ? (
        <p className="muted">Couldn't load other covers. Try again in a bit.</p>
      ) : !editions ? (
        <div className="rq-cover-grid" aria-hidden>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skeleton rq-cover-option" />
          ))}
        </div>
      ) : editions.length === 0 ? (
        <p className="muted">No {langName} editions with a cover found for this book.</p>
      ) : (
        <div className="rq-cover-grid" role="listbox" aria-label="Covers">
          {editions.map((e) => {
            const active = (selected ?? result.coverUrl) === e.coverUrl;
            return (
              <button
                key={e.coverUrl}
                type="button"
                role="option"
                aria-selected={active}
                className={`rq-cover-option ${active ? 'active' : ''}`}
                onClick={() => {
                  onPick(e.coverUrl);
                  onClose();
                }}
                title={[e.publisher, e.year, e.format].filter(Boolean).join(' · ')}
              >
                <img src={e.thumbUrl} alt={[e.publisher, e.year].filter(Boolean).join(', ') || 'Edition cover'} loading="lazy" />
                {e.year && <span>{e.year}</span>}
                {active && (
                  <span className="rq-cover-check">
                    <CheckIcon size={14} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

/** Lets the user choose which download Shelfarr grabs when it couldn't pick one itself. */
// Only names that don't double as ordinary words (no "doc", "txt", "opus": "Doc Savage", "Magnum Opus").
const EBOOK_FORMATS = ['epub', 'pdf', 'mobi', 'azw3', 'azw', 'kfx', 'fb2', 'djvu', 'cbz', 'cbr'];
/** What TurboBooks opens: EPUB, and CBZ/CBR comics, manga and webtoons. */
const READABLE_EBOOK = ['epub', 'cbz', 'cbr'];
const AUDIO_FORMATS = ['m4b', 'mp3', 'm4a', 'flac'];
const FORMAT_RE = new RegExp(`(?:^|[^a-z0-9])(${[...EBOOK_FORMATS, ...AUDIO_FORMATS].join('|')})(?=$|[^a-z0-9])`, 'gi');

/**
 * File types named in a release title ("… [EPUB]", "….pdf", "(epub, mobi)"). Shelfarr doesn't say,
 * so the title is all there is; many torrents don't mention it at all.
 */
function releaseFormats(title: string): string[] {
  return [...new Set([...title.matchAll(FORMAT_RE)].map((m) => m[1].toLowerCase()))];
}

/** Will TurboBooks be able to open it? null when the title doesn't say. */
function releaseReadable(formats: string[], bookType: string): boolean | null {
  if (!formats.length) return null;
  return bookType === 'ebook' ? formats.some((f) => READABLE_EBOOK.includes(f)) : formats.some((f) => AUDIO_FORMATS.includes(f));
}

function FormatTag({ formats, readable, bookType }: { formats: string[]; readable: boolean | null; bookType: string }) {
  if (readable === null) return <span className="rq-tag">File type unknown</span>;
  const label = formats.map((f) => f.toUpperCase()).join(' · ');
  if (readable) return <span className="rq-tag good">{label}</span>;
  return (
    <span className="rq-tag bad" title={bookType === 'ebook' ? 'TurboBooks opens EPUB ebooks and CBZ/CBR comics (and only EPUB can go to Kindle from here)' : undefined}>
      {label} · won't open here
    </span>
  );
}

function ReleaseSheet({ request, onDone, onClose }: { request: WishRequest; onDone: () => void; onClose: () => void }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grabbing, setGrabbing] = useState<number | null>(null);

  useEffect(() => {
    api
      .wishlistReleases(request.id)
      .then((r) =>
        // Copies TurboBooks can't open (a PDF for an ebook request…) go last, so they're never "Best match".
        setReleases(
          [...r.releases].sort(
            (a, b) =>
              Number(releaseReadable(releaseFormats(a.title), request.bookType) === false) -
              Number(releaseReadable(releaseFormats(b.title), request.bookType) === false),
          ),
        ),
      )
      .catch((e: Error) => setError(e.message));
  }, [request.id, request.bookType]);

  const grab = async (r: Release) => {
    setGrabbing(r.id);
    try {
      await api.wishlistGrab(request.id, r.id);
      toast('Downloading now');
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setGrabbing(null);
    }
  };

  return (
    <Sheet label="Choose a download" onClose={onClose}>
      <div className="rq-sheet-book">
        <Cover src={request.coverUrl} title={request.title} author={request.author} className="rq-sheet-cover" />
        <div>
          <h2 className="rq-sheet-title">Choose a download</h2>
          <p className="muted small">
            {request.title}
            {request.author ? ` · ${request.author}` : ''}
          </p>
          <TypeTag type={request.bookType} />
        </div>
      </div>
      <p className="muted small rq-sheet-sub">
        Several copies matched. The best match is first. Direct downloads are usually fastest.
      </p>
      {error && <p className="error">{error}</p>}
      {!releases && !error && (
        <ul className="rq-releases" aria-hidden>
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="rq-release">
              <div className="rq-release-text">
                <div className="skeleton skeleton-line" />
                <div className="skeleton skeleton-line short" />
              </div>
            </li>
          ))}
        </ul>
      )}
      {releases?.length === 0 && <p className="muted">No downloadable copies right now. Try again later.</p>}
      {releases && releases.length > 0 && (
        <ul className="rq-releases">
          {releases.map((r, i) => {
            const dead = !r.direct && r.seeders === 0;
            const formats = releaseFormats(decodeEntities(r.title));
            const readable = releaseReadable(formats, request.bookType);
            const best = i === 0 && !dead && readable !== false;
            return (
              <li key={r.id} className={`rq-release ${best ? 'best' : ''} ${dead ? 'dead' : ''}`}>
                <div className="rq-release-text">
                  {best && <span className="rq-best">Best match</span>}
                  <div className="rq-release-title">{decodeEntities(r.title)}</div>
                  <div className="rq-release-tags">
                    <FormatTag formats={formats} readable={readable} bookType={request.bookType} />
                    {r.direct ? (
                      <span className="rq-tag good">Direct download</span>
                    ) : (
                      r.seeders != null && (
                        <span className={`rq-tag ${dead ? 'bad' : ''}`}>{dead ? 'No seeders' : `${r.seeders} seeders`}</span>
                      )
                    )}
                    {formatSize(r.sizeBytes) && <span className="rq-tag">{formatSize(r.sizeBytes)}</span>}
                    {r.confidence != null && <span className="rq-tag">{Math.round(r.confidence)}% match</span>}
                    {r.language && <span className="rq-tag">{r.language.toUpperCase()}</span>}
                    {r.source && <span className="rq-source">{r.source}</span>}
                  </div>
                </div>
                <button
                  className={`btn btn-small ${best ? 'btn-primary' : ''}`}
                  disabled={grabbing !== null}
                  onClick={() => grab(r)}
                  aria-label={`Download ${decodeEntities(r.title)}`}
                >
                  {grabbing === r.id ? 'Starting…' : <DownloadIcon size={16} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}

function RequestCard({
  r,
  convertEnabled,
  onPick,
  onRetry,
  onRemove,
  onEbookInstead,
}: {
  r: WishRequest;
  convertEnabled: boolean;
  onPick: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onEbookInstead: () => Promise<void>;
}) {
  const running = IN_FLIGHT.includes(r.status);
  const failed = FAILED.includes(r.status);
  const done = r.status === 'completed';
  const pick = needsPick(r);
  const tone = pick ? 'attention' : done ? 'done' : failed ? 'bad' : 'busy';
  const noAudiobook = failed && r.bookType === 'audiobook';
  const thenAudiobook = r.makeAudiobook && r.bookType === 'ebook' && convertEnabled;
  const [switching, setSwitching] = useState(false);

  return (
    <li className={`rq-card ${pick ? 'rq-card-attention' : ''}`}>
      <Cover src={r.coverUrl} title={r.title} author={r.author} className="rq-card-cover" />
      <div className="rq-card-body">
        <div className="rq-card-title">{r.title}</div>
        <div className="rq-card-meta">
          <TypeTag type={r.bookType} />
          {r.language && r.language !== 'en' && <span className="rq-type rq-lang-tag">{r.language.toUpperCase()}</span>}
          {r.author && <span className="muted">{r.author}</span>}
        </div>
        <div className={`rq-status ${tone}`}>
          <span className="rq-dot" />
          {pick ? 'Pick a download' : done && !r.bookId ? 'Arriving in your library shortly' : statusText(r.status)}
          <span className="rq-when">· {timeAgo(r.createdAt)}</span>
        </div>
        {thenAudiobook && !done && !failed && (
          <p className="rq-then">
            <HeadphonesIcon size={13} /> Then you can turn it into an audiobook
          </p>
        )}
        {r.issue && (pick || failed) && <p className="rq-issue">{r.issue}</p>}
        {noAudiobook && (
          <div className="rq-fallback">
            <p>
              {convertEnabled
                ? 'No audiobook out there. Get the ebook and TurboBooks can read it to you.'
                : 'No audiobook out there. You can still get the ebook.'}
            </p>
            <button
              className="btn btn-small btn-primary"
              disabled={switching}
              onClick={async () => {
                setSwitching(true);
                try {
                  await onEbookInstead();
                } finally {
                  setSwitching(false);
                }
              }}
            >
              {convertEnabled ? <HeadphonesIcon size={16} /> : <BookOpenIcon size={16} />}
              {switching ? 'Requesting…' : convertEnabled ? 'Get the ebook & make an audiobook' : 'Get the ebook instead'}
            </button>
          </div>
        )}
        {running && !pick && <div className="rq-progress" role="progressbar" aria-label={statusText(r.status)} />}
        {(pick || failed || (done && r.bookId)) && (
          <div className="rq-card-actions">
            {pick && (
              <button className="btn btn-small btn-primary" onClick={onPick}>
                <DownloadIcon size={16} /> Choose a download
              </button>
            )}
            {failed && (
              <button className="btn btn-small" onClick={onRetry}>
                <RetryIcon size={16} /> Try again
              </button>
            )}
            {done && r.bookId && thenAudiobook && (
              <Link className="btn btn-small btn-primary" to={`/book/${r.bookId}?audiobook=1`}>
                <HeadphonesIcon size={16} /> Make the audiobook
              </Link>
            )}
            {done && r.bookId && (
              <Link className={`btn btn-small ${thenAudiobook ? '' : 'btn-primary'}`} to={`/book/${r.bookId}`}>
                {r.bookType === 'audiobook' ? <HeadphonesIcon size={16} /> : <BookOpenIcon size={16} />}{' '}
                {thenAudiobook ? 'Read' : 'Open'}
              </Link>
            )}
          </div>
        )}
      </div>
      <button
        className="rq-remove"
        aria-label={running ? `Cancel request for ${r.title}` : `Remove ${r.title} from the list`}
        title={running ? 'Cancel request' : 'Remove from list'}
        onClick={onRemove}
      >
        <XIcon size={16} />
      </button>
    </li>
  );
}

function Group({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rq-group">
      <div className="rq-group-head">
        <h2 className="section-title">{title}</h2>
        {action}
      </div>
      <ul className="rq-cards">{children}</ul>
    </section>
  );
}

function ResultCard({
  r,
  cover,
  requestedTypes,
  onRequest,
  onCovers,
}: {
  r: WishResult;
  cover: string | null;
  requestedTypes: Set<BookType>;
  onRequest: (type: BookType) => Promise<void>;
  onCovers: (() => void) | null;
}) {
  const [busy, setBusy] = useState<BookType | null>(null);
  const run = async (t: BookType) => {
    setBusy(t);
    try {
      await onRequest(t);
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="rq-result">
      <div className="rq-result-cover">
        <Cover src={cover} title={r.title} author={r.author} className="rq-result-img" />
        {onCovers && (
          <button className="rq-cover-edit" onClick={onCovers} aria-label={`Choose a cover for ${r.title}`} title="Choose a cover">
            <ImagesIcon size={14} />
          </button>
        )}
      </div>
      <div className="rq-result-body">
        <div className="rq-result-title">{r.title}</div>
        <div className="rq-result-meta">{[r.author, r.year].filter(Boolean).join(' · ')}</div>
        {r.series && <div className="rq-result-series">{r.series}</div>}
        <div className="rq-formats">
          {(['audiobook', 'ebook'] as const).map((t) => {
            const done = requestedTypes.has(t);
            return (
              <button
                key={t}
                className={`rq-format ${done ? 'requested' : ''}`}
                disabled={done || busy !== null}
                onClick={() => run(t)}
                aria-label={done ? `${t} requested` : `Request ${t}`}
              >
                {done ? <CheckIcon size={16} /> : t === 'audiobook' ? <HeadphonesIcon size={16} /> : <BookOpenIcon size={16} />}
                <span>{busy === t ? 'Requesting…' : t === 'audiobook' ? 'Audiobook' : 'Ebook'}</span>
              </button>
            );
          })}
        </div>
      </div>
    </li>
  );
}

export function Request() {
  const { user } = useAuth();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const navigate = useNavigate();
  const [convertEnabled, setConvertEnabled] = useState(false);
  const [languages, setLanguages] = useState<BookLanguage[]>([{ code: 'en', name: 'English' }]);
  const [lang, setLangState] = useState(() => loadLang(user?.id));
  const setLang = (code: string) => {
    setLangState(code);
    saveLang(user?.id, code);
  };
  const langName = languages.find((l) => l.code === lang)?.name ?? lang;
  const [params] = useSearchParams();
  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const [results, setResults] = useState<WishResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<WishRequest[] | null>(null);
  const [tab, setTab] = useState<Tab>('find');
  /** workId:type pairs requested this session, so buttons flip immediately. */
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [coverFor, setCoverFor] = useState<WishResult | null>(null);
  const [pickFor, setPickFor] = useState<WishRequest | null>(null);

  const refresh = useCallback(() => {
    api
      .wishlist()
      .then((r) => setRequests(r.requests))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .wishlistStatus()
      .then((r) => {
        setEnabled(r.enabled);
        setConvertEnabled(!!r.convertEnabled);
        if (r.languages?.length) setLanguages(r.languages);
      })
      .catch(() => setEnabled(false));
  }, []);

  const list = useMemo(() => requests ?? [], [requests]);
  const busy = list.some((r) => IN_FLIGHT.includes(r.status));
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = window.setInterval(refresh, busy ? 5000 : 20000);
    return () => window.clearInterval(id);
  }, [enabled, busy, refresh]);

  const runSearch = async (q: string) => {
    if (q.length < 2) return;
    setTab('find');
    setSearching(true);
    setError(null);
    try {
      setResults((await api.wishlistSearch(q)).results);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur(); // close the phone keyboard
    void runSearch(query.trim());
  };

  // Arriving from Discover with a search: run it straight away.
  useEffect(() => {
    if (enabled && query.trim().length >= 2 && results === null) void runSearch(query.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const request = async (r: WishResult, type: BookType) => {
    try {
      const res = await api.wishlistRequest(r, type, covers[r.workId], lang);
      setSent((s) => new Set(s).add(`${r.workId}:${type}`));
      toast(
        res.addedToLibrary
          ? 'Already on the server: added to your library'
          : `Requested${lang === 'en' ? '' : ` in ${langName}`}. Follow it in My requests.`,
      );
      refresh();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const act = (fn: () => Promise<unknown>, done?: string) =>
    fn()
      .then(() => {
        if (done) toast(done);
        refresh();
      })
      .catch((e: Error) => toast(e.message));

  const remove = (r: WishRequest) => {
    const running = IN_FLIGHT.includes(r.status);
    if (running && !confirm(`Cancel the request for "${r.title}"?`)) return;
    setRequests((l) => l?.filter((x) => x.id !== r.id) ?? null); // optimistic
    void act(() => api.wishlistCancel(r.id), running ? 'Request cancelled' : undefined);
  };

  /** No audiobook anywhere: get the ebook instead (and, when set up, turn it into an audiobook). */
  const ebookInstead = async (r: WishRequest) => {
    try {
      const res = await api.wishlistEbookInstead(r.id, convertEnabled);
      if (res.bookId) {
        toast('The ebook was already here: added to your library');
        navigate(convertEnabled ? `/book/${res.bookId}?audiobook=1` : `/book/${res.bookId}`);
        return;
      }
      toast(
        convertEnabled
          ? 'Ebook requested. When it arrives, tap "Make the audiobook".'
          : 'Ebook requested. Follow it in My requests.',
      );
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const clearAll = (items: WishRequest[]) => {
    const ids = new Set(items.map((r) => r.id));
    setRequests((l) => l?.filter((x) => !ids.has(x.id)) ?? null);
    void act(() => Promise.all(items.map((r) => api.wishlistCancel(r.id))));
  };

  /** Types already requested for a search result: this session, or an open request with the same title. */
  const requestedTypes = (r: WishResult) => {
    const set = new Set<BookType>();
    for (const t of ['audiobook', 'ebook'] as const) {
      if (sent.has(`${r.workId}:${t}`)) set.add(t);
      else if (list.some((q) => q.bookType === t && sameBook(q.title, r.title) && !FAILED.includes(q.status))) set.add(t);
    }
    return set;
  };

  if (enabled === null) return <div className="page" />;
  if (!enabled) {
    return (
      <div className="page">
        <h1>Request</h1>
        <div className="card">
          <p>Requests aren't set up on this server yet.</p>
          <p className="muted small">
            An admin can set it up in <strong>Settings → Requests</strong>.
          </p>
        </div>
      </div>
    );
  }

  const picks = list.filter(needsPick);
  const running = list.filter((r) => IN_FLIGHT.includes(r.status) && !needsPick(r));
  const ready = list.filter((r) => r.status === 'completed');
  const failed = list.filter((r) => FAILED.includes(r.status));
  const card = (r: WishRequest) => (
    <RequestCard
      key={r.id}
      r={r}
      onPick={() => setPickFor(r)}
      convertEnabled={convertEnabled}
      onRetry={() => void act(() => api.wishlistRetry(r.id), 'Trying again')}
      onRemove={() => remove(r)}
      onEbookInstead={() => ebookInstead(r)}
    />
  );

  return (
    <div className="page rq-page">
      <header className="rq-head">
        <h1>Request</h1>
        <p className="muted">Find any book. It downloads by itself and shows up in your library.</p>
      </header>

      <form className="rq-search" onSubmit={submit} role="search">
        <SearchIcon size={20} className="rq-search-icon" />
        <input
          type="search"
          enterKeyHint="search"
          placeholder="Title, author or series"
          aria-label="Search for a book"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="rq-search-clear"
            aria-label="Clear search"
            onClick={() => {
              setQuery('');
              setResults(null);
            }}
          >
            <XIcon size={16} />
          </button>
        )}
        <button className="btn btn-primary rq-search-go" disabled={query.trim().length < 2 || searching}>
          {searching ? '…' : 'Search'}
        </button>
      </form>

      <div className="rq-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'find'} className={tab === 'find' ? 'active' : ''} onClick={() => setTab('find')}>
          Find
        </button>
        <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
          My requests
          {list.length > 0 && <span className={`rq-count ${picks.length ? 'attention' : ''}`}>{picks.length || list.length}</span>}
        </button>
      </div>

      {tab === 'find' && (
        <div role="tabpanel" aria-label="Find">
          <label className="rq-lang">
            <GlobeIcon size={16} />
            <span>Book language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Book language">
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>

          {picks.length > 0 && (
            <button className="rq-banner" onClick={() => setTab('mine')}>
              <DownloadIcon size={18} />
              <span>
                {picks.length === 1 ? `"${picks[0].title}" needs you to pick a download` : `${picks.length} requests need you to pick a download`}
              </span>
              <span className="rq-banner-go">Review</span>
            </button>
          )}

          {error && <p className="error">{error}</p>}

          {searching && (
            <ul className="rq-results" aria-hidden>
              {Array.from({ length: 4 }, (_, i) => (
                <li key={i} className="rq-result">
                  <div className="skeleton rq-result-img" />
                  <div className="rq-result-body">
                    <div className="skeleton skeleton-line" />
                    <div className="skeleton skeleton-line short" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {!searching && results && results.length === 0 && (
            <div className="rq-empty">
              <SearchIcon size={28} />
              <p>Nothing found for "{query.trim()}".</p>
              <p className="muted small">Try just the author's name, or fewer words.</p>
            </div>
          )}

          {!searching && results && results.length > 0 && (
            <ul className="rq-results">
              {results.map((r) => (
                <ResultCard
                  key={r.workId}
                  r={r}
                  cover={covers[r.workId] ?? r.coverUrl}
                  requestedTypes={requestedTypes(r)}
                  onRequest={(t) => request(r, t)}
                  onCovers={r.workId.startsWith('openlibrary:') ? () => setCoverFor(r) : null}
                />
              ))}
            </ul>
          )}

          {!searching && !results && (
            <div className="rq-empty">
              <BookOpenIcon size={28} />
              <p>What would you like to read or listen to?</p>
              <p className="muted small">
                Search a title, author or series, then choose audiobook or ebook. Copies are found in the book language above.
              </p>
            </div>
          )}
        </div>
      )}

      {tab === 'mine' && (
        <div role="tabpanel" aria-label="My requests">
          {requests === null && <p className="muted center">Loading…</p>}
          {requests !== null && list.length === 0 && (
            <div className="rq-empty">
              <DownloadIcon size={28} />
              <p>No requests yet.</p>
              <button className="btn btn-small" onClick={() => setTab('find')}>
                Find a book
              </button>
            </div>
          )}
          {picks.length > 0 && <Group title="Needs your pick">{picks.map(card)}</Group>}
          {running.length > 0 && <Group title="In progress">{running.map(card)}</Group>}
          {ready.length > 0 && (
            <Group
              title="Ready"
              action={
                ready.length > 1 && (
                  <button className="link-btn" onClick={() => clearAll(ready)}>
                    Clear all
                  </button>
                )
              }
            >
              {ready.map(card)}
            </Group>
          )}
          {failed.length > 0 && (
            <Group
              title="Didn't work"
              action={
                failed.length > 1 && (
                  <button className="link-btn" onClick={() => clearAll(failed)}>
                    Clear all
                  </button>
                )
              }
            >
              {failed.map(card)}
            </Group>
          )}
        </div>
      )}

      {coverFor && (
        <CoverSheet
          result={coverFor}
          lang={lang}
          langName={langName}
          selected={covers[coverFor.workId] ?? null}
          onPick={(url) => setCovers((c) => ({ ...c, [coverFor.workId]: url }))}
          onClose={() => setCoverFor(null)}
        />
      )}
      {pickFor && (
        <ReleaseSheet
          request={pickFor}
          onClose={() => setPickFor(null)}
          onDone={() => {
            setPickFor(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
