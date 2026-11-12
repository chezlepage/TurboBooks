import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, coverUrl } from '../api';
import type { Activity, Person, PersonSummary } from '../api';
import { Cover } from '../components/Cover';
import { ChevronLeftIcon, GearIcon } from '../components/Icons';
import { GridSkeleton } from '../components/Skeleton';

/** "2 h ago", "yesterday", "3 days ago". */
export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const initials = (name: string) => name.slice(0, 2).toUpperCase();

/** A stable soft color per person for their avatar. */
function avatarStyle(name: string) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return { background: `hsl(${hue} 35% 28%)`, color: `hsl(${hue} 60% 85%)` };
}

const verb = (a: Activity) => (a.kind === 'ebook' ? 'Reading' : 'Listening to');
const pct = (a: Activity) => `${Math.round(a.fraction * 100)}%`;

export function Profile() {
  const { id } = useParams();
  const [person, setPerson] = useState<Person | null>(null);
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPerson(null);
    setError(null);
    api
      .people()
      .then(async (r) => {
        setPeople(r.people);
        const targetId = id ? Number(id) : r.people.find((p) => p.isYou)?.id;
        if (targetId) setPerson((await api.person(targetId)).person);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error)
    return (
      <div className="page">
        <p className="error">{error}</p>
      </div>
    );

  const others = (people ?? []).filter((p) => p.id !== person?.id);

  return (
    <div className="page profile">
      {id && (
        <Link className="back-link" to="/profile">
          <ChevronLeftIcon size={20} /> Your profile
        </Link>
      )}

      {!person ? (
        <GridSkeleton count={4} />
      ) : (
        <>
          <header className="profile-head">
            <div className="avatar avatar-lg" style={avatarStyle(person.username)}>
              {initials(person.username)}
            </div>
            <div className="profile-name">
              <h1>{person.isYou ? 'You' : person.username}</h1>
              <p className="muted small">
                {person.isYou ? `${person.username} · ` : ''}Here since{' '}
                {new Date(person.memberSince).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </p>
            </div>
            {person.isYou && (
              <Link className="btn btn-icon" to="/settings" aria-label="Settings">
                <GearIcon size={20} />
              </Link>
            )}
          </header>

          <ul className="stats-row">
            <li>
              <strong>{person.stats.finished}</strong>
              <span>finished</span>
            </li>
            <li>
              <strong>{person.stats.finishedThisYear}</strong>
              <span>this year</span>
            </li>
            <li>
              <strong>{person.stats.inProgress}</strong>
              <span>in progress</span>
            </li>
            <li>
              <strong>{person.stats.listenedHours}</strong>
              <span>hours listened</span>
            </li>
          </ul>

          <section>
            <h2 className="section-title">{person.isYou ? 'On your nightstand' : 'Currently'}</h2>
            {person.current.length === 0 ? (
              <p className="muted">Nothing in progress right now.</p>
            ) : (
              <ul className="activity-list">
                {person.current.map((a) => (
                  <ActivityRow key={a.id} a={a} />
                ))}
              </ul>
            )}
          </section>

          {person.finished.length > 0 && (
            <section>
              <h2 className="section-title">Finished</h2>
              <div className="shelf">
                {person.finished.map((a) => (
                  <Link key={a.id} to={`/book/${a.id}`} className="book-card">
                    <div className="book-card-cover">
                      <Cover src={coverUrl(a)} title={a.title} author={a.author} />
                    </div>
                    <div className="book-card-title">{a.title}</div>
                    <div className="book-card-sub">{timeAgo(a.updatedAt)}</div>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {others.length > 0 && (
        <section>
          <h2 className="section-title">{person?.isYou ? 'Others on this shelf' : 'Everyone'}</h2>
          <ul className="people-list">
            {others.map((p) => (
              <li key={p.id}>
                <Link to={p.isYou ? '/profile' : `/profile/${p.id}`} className="person-row">
                  <div className="avatar" style={avatarStyle(p.username)}>
                    {initials(p.username)}
                  </div>
                  <div className="person-text">
                    <div className="person-name">{p.isYou ? 'You' : p.username}</div>
                    <div className="muted small">
                      {p.current ? (
                        <>
                          {verb(p.current)} <em>{p.current.title}</em> · {pct(p.current)}
                        </>
                      ) : (
                        `${p.stats.finished} finished`
                      )}
                    </div>
                  </div>
                  {p.current && (
                    <Cover src={coverUrl(p.current)} title={p.current.title} className="person-cover" />
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ActivityRow({ a }: { a: Activity }) {
  return (
    <li>
      <Link to={`/book/${a.id}`} className="activity-row">
        <Cover src={coverUrl(a)} title={a.title} author={a.author} className="activity-cover" />
        <div className="activity-text">
          <div className="activity-kicker">{verb(a)}</div>
          <div className="activity-title">{a.title}</div>
          {a.author && <div className="muted small">{a.author}</div>}
          <div className="progress-line">
            <div style={{ width: pct(a) }} />
          </div>
          <div className="muted small">
            {pct(a)} · {timeAgo(a.updatedAt)}
          </div>
        </div>
      </Link>
    </li>
  );
}
