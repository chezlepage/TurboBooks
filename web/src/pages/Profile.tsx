import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, coverUrl } from '../api';
import type { Activity, Person, PersonStats, PersonSummary } from '../api';
import { Cover } from '../components/Cover';
import { ChevronLeftIcon, GearIcon } from '../components/Icons';
import { GridSkeleton } from '../components/Skeleton';
import { toast } from '../components/Toast';
import { setBookHidden, usePrefs } from '../prefs';

// Privacy fields the server adds to profile responses.
type Item = Activity & { hidden?: boolean };
type Summary = Omit<PersonSummary, 'current' | 'stats'> & { private?: boolean; current: Item | null; stats: PersonStats | null };
type Profile = Omit<Person, 'current' | 'finished' | 'stats'> & {
  private?: boolean;
  sharing?: boolean;
  stats: PersonStats | null;
  current: Item[];
  finished: Item[];
};

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

const LockIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export function Profile() {
  const { id } = useParams();
  const [person, setPerson] = useState<Profile | null>(null);
  const [people, setPeople] = useState<Summary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = usePrefs();

  const load = () =>
    api
      .people()
      .then(async (r) => {
        const list = r.people as unknown as Summary[];
        setPeople(list);
        const targetId = id ? Number(id) : list.find((p) => p.isYou)?.id;
        if (targetId) setPerson((await api.person(targetId)).person as unknown as Profile);
      })
      .catch((e: Error) => setError(e.message));

  // Clear only when switching person; privacy changes refresh in place.
  useEffect(() => {
    setPerson(null);
  }, [id]);

  useEffect(() => {
    setError(null);
    void load();
    // Reload when my privacy choices change so the "hidden" markers stay right.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, prefs.shareActivity, prefs.hiddenBooks.length]);

  if (error)
    return (
      <div className="page">
        <p className="error">{error}</p>
      </div>
    );

  const others = (people ?? []).filter((p) => p.id !== person?.id);
  const hiddenCount = prefs.hiddenBooks.length;

  const toggleSharing = () => {
    const next = !prefs.shareActivity;
    setPrefs({ shareActivity: next });
    toast(next ? 'Your reading is visible to others' : 'Your reading is now private');
  };

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

          {person.private ? (
            <div className="empty-state">
              <LockIcon size={36} />
              <h2>{person.username} keeps their shelf private</h2>
              <p className="muted">What they read is just for them.</p>
            </div>
          ) : (
            <>
              {person.isYou && (
                <section className="privacy-card">
                  <label className="privacy-toggle">
                    <span>
                      <strong>Show my reading to others</strong>
                      <span className="muted small">
                        {prefs.shareActivity
                          ? hiddenCount > 0
                            ? `On, except ${hiddenCount} hidden book${hiddenCount === 1 ? '' : 's'}.`
                            : 'On. Hide any single book from its ⋯ menu.'
                          : 'Off. Nobody else sees what you read or your stats.'}
                      </span>
                    </span>
                    <input type="checkbox" role="switch" className="switch" checked={prefs.shareActivity} onChange={toggleSharing} />
                  </label>
                </section>
              )}

              {person.stats && (
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
              )}

              <section>
                <h2 className="section-title">{person.isYou ? 'On your nightstand' : 'Currently'}</h2>
                {person.current.length === 0 ? (
                  <p className="muted">Nothing in progress right now.</p>
                ) : (
                  <ul className="activity-list">
                    {person.current.map((a) => (
                      <ActivityRow key={a.id} a={a} mine={person.isYou} />
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
                          {a.hidden && (
                            <span className="kind-badge private-badge" title="Hidden from others">
                              <LockIcon size={11} /> Hidden
                            </span>
                          )}
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
                      {p.private ? (
                        'Private shelf'
                      ) : p.current ? (
                        <>
                          {verb(p.current)} <em>{p.current.title}</em> · {pct(p.current)}
                        </>
                      ) : (
                        `${p.stats?.finished ?? 0} finished`
                      )}
                    </div>
                  </div>
                  {p.current && <Cover src={coverUrl(p.current)} title={p.current.title} className="person-cover" />}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ActivityRow({ a, mine }: { a: Item; mine: boolean }) {
  return (
    <li className="activity-item">
      <Link to={`/book/${a.id}`} className="activity-row">
        <Cover src={coverUrl(a)} title={a.title} author={a.author} className="activity-cover" />
        <div className="activity-text">
          <div className="activity-kicker">
            {verb(a)}
            {a.hidden && (
              <span className="private-tag">
                <LockIcon size={11} /> Hidden from others
              </span>
            )}
          </div>
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
      {mine && (
        <button
          className="link-btn activity-hide"
          onClick={() => {
            setBookHidden(a.id, !a.hidden);
            toast(a.hidden ? `“${a.title}” is visible on your profile` : `“${a.title}” is hidden from others`);
          }}
        >
          {a.hidden ? 'Show to others' : 'Hide from others'}
        </button>
      )}
    </li>
  );
}
