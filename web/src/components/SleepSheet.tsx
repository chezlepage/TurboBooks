import { formatTime } from '../api';
import { useClock, usePlayer } from '../player/PlayerContext';

const OPTIONS = [5, 10, 15, 20, 30, 45, 60, 90];

export function SleepSheet({ onClose }: { onClose: () => void }) {
  const { sleep, setSleep, addSleepMinutes, book } = usePlayer();
  const { sleepRemaining } = useClock();

  const pick = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Sleep timer" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2>Sleep timer</h2>
        {sleep && sleepRemaining !== null && (
          <p className="sheet-status">
            Stopping in <strong>{formatTime(sleepRemaining)}</strong>
            {sleep.kind === 'chapter' ? ' (end of chapter)' : ''}
          </p>
        )}
        <div className="sleep-grid">
          {OPTIONS.map((m) => (
            <button key={m} className="chip" onClick={() => pick(() => setSleep({ kind: 'minutes', minutes: m }))}>
              {m} min
            </button>
          ))}
          {book && book.chapters.length > 0 && (
            <button className="chip chip-wide" onClick={() => pick(() => setSleep({ kind: 'chapter' }))}>
              End of chapter
            </button>
          )}
        </div>
        {sleep && (
          <div className="sheet-actions">
            {sleep.kind === 'minutes' && (
              <button className="btn" onClick={() => pick(() => addSleepMinutes(10))}>
                +10 min
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => pick(() => setSleep(null))}>
              Turn off
            </button>
          </div>
        )}
        <p className="hint">The volume fades out gently before it stops, and rewinds a minute next time you press play.</p>
      </div>
    </div>
  );
}
