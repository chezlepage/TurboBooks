import { useState } from 'react';
import { usePrefs } from '../prefs';
import { toast } from './Toast';

interface Props {
  /** Server-computed goal for the profile being viewed (null when none set). */
  goal: { year: number; target: number; done: number } | null;
  /** Books finished this year (used when you're setting a goal for the first time). */
  doneThisYear: number;
  editable: boolean;
}

/** "12 of 20 books in 2026" with a progress ring. Editable on your own profile. */
export function GoalCard({ goal, doneThisYear, editable }: Props) {
  const [prefs, setPrefs] = usePrefs();
  const [editing, setEditing] = useState(false);
  const year = new Date().getFullYear();
  const target = editable ? prefs.readingGoals[String(year)] ?? goal?.target ?? null : goal?.target ?? null;
  const done = goal?.done ?? doneThisYear;
  const [draft, setDraft] = useState(String(target ?? 12));

  if (!target && !editable) return null;

  const save = () => {
    const n = Math.round(Number(draft));
    const goals = { ...prefs.readingGoals };
    if (!n || n < 1) delete goals[String(year)];
    else goals[String(year)] = Math.min(n, 1000);
    setPrefs({ readingGoals: goals });
    setEditing(false);
    toast(n >= 1 ? `Goal set: ${n} books in ${year}` : 'Goal removed');
  };

  if (editable && (editing || !target)) {
    return (
      <section className="goal-card">
        <div className="goal-text">
          <strong>{target ? `Change your ${year} goal` : `Set a reading goal for ${year}`}</strong>
          <span className="muted small">Audiobooks, ebooks and anything you log from outside count.</span>
        </div>
        <div className="goal-edit">
          <input
            type="number"
            min={1}
            max={1000}
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Books this year"
          />
          <span className="muted small">books</span>
          <button className="btn btn-primary btn-small" onClick={save}>
            Save
          </button>
          {target && (
            <button className="btn btn-ghost btn-small" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </div>
      </section>
    );
  }

  const pct = Math.min(1, done / target!);
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <section className="goal-card">
      <svg className="goal-ring" width="64" height="64" viewBox="0 0 64 64" aria-hidden>
        <circle cx="32" cy="32" r={r} className="goal-ring-bg" />
        <circle cx="32" cy="32" r={r} className="goal-ring-fg" strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 32 32)" />
      </svg>
      <div className="goal-text">
        <strong>
          {done} of {target} books in {year}
        </strong>
        <span className="muted small">
          {done >= target! ? 'Goal reached!' : `${target! - done} to go`}
        </span>
      </div>
      {editable && (
        <button className="link-btn" onClick={() => setEditing(true)}>
          Edit
        </button>
      )}
    </section>
  );
}
