import { useNavigate } from 'react-router-dom';
import { coverUrl } from '../api';
import { chapterAt, useClock, usePlayer } from '../player/PlayerContext';
import { Cover } from './Cover';
import { MoonIcon, PauseIcon, PlayIcon } from './Icons';

export function MiniPlayer() {
  const { book, playing, toggle, sleep } = usePlayer();
  const { position } = useClock();
  const navigate = useNavigate();
  if (!book) return null;

  const chapter = chapterAt(book, position);
  const pct = book.duration > 0 ? (position / book.duration) * 100 : 0;

  return (
    <div className="mini-player">
      <div className="mini-progress" style={{ width: `${pct}%` }} />
      <button className="mini-main" onClick={() => navigate('/player')} aria-label="Open player">
        <Cover src={coverUrl(book)} title={book.title} className="mini-cover" />
        <div className="mini-text">
          <div className="mini-title">{book.title}</div>
          <div className="mini-sub">
            {sleep && <MoonIcon size={12} className="inline-icon accent" />}
            {chapter && book.chapters.length > 1 ? chapter.title : book.author}
          </div>
        </div>
      </button>
      <button className="icon-btn mini-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <PauseIcon size={26} /> : <PlayIcon size={26} />}
      </button>
    </div>
  );
}
