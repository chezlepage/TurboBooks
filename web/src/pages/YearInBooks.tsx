import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { coverUrl, formatDuration, isbnCoverUrl } from '../api';
import { Cover } from '../components/Cover';
import { ChevronLeftIcon } from '../components/Icons';
import { GridSkeleton } from '../components/Skeleton';
import { Stars } from '../components/Stars';

interface YearBook {
  source: 'library' | 'log';
  id: number;
  title: string;
  author: string | null;
  kind: 'audio' | 'ebook' | null;
  hasCover: boolean;
  isbn13: string | null;
  rating: number | null;
  finishedAt: number;
  durationSecs: number | null;
}

interface YearData {
  year: number;
  username: string;
  isYou?: boolean;
  private: boolean;
  total?: number;
  audiobooks?: number;
  ebooks?: number;
  elsewhere?: number;
  hoursListened?: number;
  byMonth?: number[];
  favourites?: YearBook[];
  longest?: YearBook | null;
  topAuthor?: { name: string; count: number } | null;
  goal?: number | null;
  books?: YearBook[];
}

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

const coverFor = (b: YearBook) => (b.source === 'library' ? coverUrl(b) : isbnCoverUrl(b.isbn13));

export function YearInBooks() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const year = Number(params.get('y')) || new Date().getFullYear();
  const [data, setData] = useState<YearData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    // My own year uses my id from /api/people; someone else's comes from the URL.
    (async () => {
      try {
        let personId = id ? Number(id) : null;
        if (!personId) {
          const r = await fetch('/api/people', { credentials: 'same-origin' }).then((x) => x.json());
          personId = r.people.find((p: { isYou: boolean }) => p.isYou)?.id;
        }
        const res = await fetch(`/api/people/${personId}/year?y=${year}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load');
        setData(await res.json());
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [id, year]);

  const backTo = id ? `/profile/${id}` : '/profile';
  const thisYear = new Date().getFullYear();

  return (
    <div className="page year-page">
      <Link className="back-link" to={backTo}>
        <ChevronLeftIcon size={20} /> Profile
      </Link>

      <header className="year-hero">
        <p className="kicker">{data?.isYou === false ? `${data.username}'s` : 'Your'} year in books</p>
        <div className="year-switch">
          <button className="icon-btn" onClick={() => setParams({ y: String(year - 1) })} aria-label="Previous year">
            ‹
          </button>
          <h1>{year}</h1>
          <button
            className="icon-btn"
            onClick={() => setParams({ y: String(year + 1) })}
            disabled={year >= thisYear}
            aria-label="Next year"
          >
            ›
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {!data && !error && <GridSkeleton count={6} />}

      {data?.private && (
        <div className="empty-state">
          <h2>{data.username} keeps their shelf private</h2>
        </div>
      )}

      {data && !data.private && data.total === 0 && (
        <div className="empty-state">
          <h2>No finished books in {year} yet</h2>
          <p className="muted">Finish something, or import your Goodreads history, and it'll show up here.</p>
        </div>
      )}

      {data && !data.private && !!data.total && (
        <>
          <ul className="year-stats">
            <li className="year-big">
              <strong>{data.total}</strong>
              <span>
                book{data.total === 1 ? '' : 's'} finished
                {data.goal ? ` of ${data.goal}` : ''}
              </span>
            </li>
            <li>
              <strong>{data.hoursListened}</strong>
              <span>hours listened</span>
            </li>
            <li>
              <strong>{data.audiobooks}</strong>
              <span>audiobooks</span>
            </li>
            <li>
              <strong>{(data.ebooks ?? 0) + (data.elsewhere ?? 0)}</strong>
              <span>read</span>
            </li>
          </ul>

          <section>
            <h2 className="section-title">Month by month</h2>
            <div className="year-months" role="img" aria-label="Books finished each month">
              {data.byMonth!.map((n, i) => {
                const max = Math.max(1, ...data.byMonth!);
                return (
                  <div key={i} className="year-month">
                    <span className="year-bar" style={{ height: `${(n / max) * 100}%` }} title={`${n}`}>
                      {n > 0 && <em>{n}</em>}
                    </span>
                    <span className="year-month-label">{MONTHS[i]}</span>
                  </div>
                );
              })}
            </div>
          </section>

          {(data.favourites!.length > 0 || data.longest || data.topAuthor) && (
            <section className="year-highlights">
              {data.favourites!.length > 0 && (
                <div className="year-card">
                  <h3>Favourites</h3>
                  {data.favourites!.map((b) => (
                    <div key={`${b.source}${b.id}`} className="year-fav">
                      <Cover src={coverFor(b)} title={b.title} author={b.author} className="year-fav-cover" />
                      <div>
                        <div className="year-fav-title">{b.title}</div>
                        <Stars value={b.rating} size={13} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {data.longest && (
                <div className="year-card">
                  <h3>Longest listen</h3>
                  <div className="year-fav">
                    <Cover src={coverFor(data.longest)} title={data.longest.title} className="year-fav-cover" />
                    <div>
                      <div className="year-fav-title">{data.longest.title}</div>
                      <div className="muted small">{formatDuration(data.longest.durationSecs!)}</div>
                    </div>
                  </div>
                </div>
              )}
              {data.topAuthor && (
                <div className="year-card">
                  <h3>Most-read author</h3>
                  <div className="year-author">{data.topAuthor.name}</div>
                  <div className="muted small">{data.topAuthor.count} books</div>
                </div>
              )}
            </section>
          )}

          <section>
            <h2 className="section-title">Every book</h2>
            <div className="year-wall">
              {data.books!.map((b) => {
                const cover = <Cover src={coverFor(b)} title={b.title} author={b.author} />;
                return b.source === 'library' ? (
                  <Link key={`l${b.id}`} to={`/book/${b.id}`} className="year-wall-item" title={b.title}>
                    {cover}
                  </Link>
                ) : (
                  <div key={`s${b.id}`} className="year-wall-item" title={b.title}>
                    {cover}
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
