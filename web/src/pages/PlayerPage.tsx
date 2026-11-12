import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { coverUrl, formatDuration, formatTime } from '../api';
import { Cover } from '../components/Cover';
import {
  BackIcon,
  ChevronDownIcon,
  DimIcon,
  ForwardIcon,
  ListIcon,
  MoonIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
} from '../components/Icons';
import { SleepSheet } from '../components/SleepSheet';
import { SPEEDS, chapterAt, useClock, usePlayer } from '../player/PlayerContext';

export function PlayerPage() {
  const player = usePlayer();
  const { position, sleepRemaining } = useClock();
  const navigate = useNavigate();
  const [sleepOpen, setSleepOpen] = useState(false);
  const [night, setNight] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const { book } = player;

  if (!book) {
    return (
      <div className="page">
        <p className="muted">Nothing playing.</p>
        <Link to="/" className="btn">
          Go to library
        </Link>
      </div>
    );
  }

  const chapter = chapterAt(book, position);
  const hasChapters = book.chapters.length > 1;
  // The scrubber covers the current chapter (or the whole book if there are none).
  const segStart = hasChapters && chapter ? chapter.start : 0;
  const segEnd = hasChapters && chapter ? chapter.end : book.duration;
  const segLength = Math.max(segEnd - segStart, 1);
  const shown = scrub ?? position;
  const inSeg = Math.min(Math.max(shown - segStart, 0), segLength);
  const bookLeft = (book.duration - position) / player.rate;

  const cycleSpeed = () => {
    const i = SPEEDS.indexOf(player.rate);
    player.setRate(SPEEDS[(i + 1) % SPEEDS.length] ?? 1);
  };

  return (
    <div className="player-page">
      <header className="player-header">
        <button className="icon-btn" onClick={() => navigate(-1)} aria-label="Close player">
          <ChevronDownIcon size={28} />
        </button>
        <span className="muted small">{hasChapters && chapter ? `Chapter ${chapter.idx + 1} of ${book.chapters.length}` : ''}</span>
        <span className="header-actions">
          <button className="icon-btn" onClick={() => setNight(true)} aria-label="Night screen">
            <DimIcon size={22} />
          </button>
          <Link className="icon-btn" to={`/book/${book.id}`} aria-label="Chapters and details">
            <ListIcon size={24} />
          </Link>
        </span>
      </header>

      <div className="player-art">
        <Cover src={coverUrl(book)} title={book.title} className="player-cover" />
      </div>

      <div className="player-meta">
        <h1>{hasChapters && chapter ? chapter.title : book.title}</h1>
        <p className="muted">{hasChapters ? book.title : book.author}</p>
      </div>

      <div className="scrubber">
        <input
          type="range"
          min={0}
          max={segLength}
          step={1}
          value={inSeg}
          onChange={(e) => setScrub(segStart + Number(e.target.value))}
          onPointerUp={() => {
            if (scrub !== null) player.seek(scrub);
            setScrub(null);
          }}
          onKeyUp={() => {
            if (scrub !== null) player.seek(scrub);
            setScrub(null);
          }}
          aria-label="Seek"
          style={{ '--pct': `${(inSeg / segLength) * 100}%` } as CSSProperties}
        />
        <div className="scrubber-times">
          <span>{formatTime(inSeg)}</span>
          <span className="muted">{formatTime(bookLeft)} left in book</span>
          <span>-{formatTime(segLength - inSeg)}</span>
        </div>
      </div>

      {player.sleepMark && position - player.sleepMark.position > 60 && (
        <div className="mark-banner">
          <button className="mark-jump" onClick={player.jumpToSleepMark}>
            <MoonIcon size={18} />
            <span>
              Dozed off? <strong>Go back {formatDuration(position - player.sleepMark.position)}</strong> to where you set the timer
            </span>
          </button>
          <button className="icon-btn small-x" onClick={player.dismissSleepMark} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {player.error && <p className="error center">{player.error}</p>}

      <div className="transport">
        <button className="icon-btn" onClick={player.prevChapter} aria-label="Previous chapter" disabled={!hasChapters}>
          <PrevIcon size={26} />
        </button>
        <button className="icon-btn" onClick={() => player.skip(-30)} aria-label="Back 30 seconds">
          <BackIcon size={38} seconds={30} />
        </button>
        <button className="play-btn" onClick={player.toggle} aria-label={player.playing ? 'Pause' : 'Play'}>
          {player.loading && player.playing ? (
            <span className="spinner" />
          ) : player.playing ? (
            <PauseIcon size={38} />
          ) : (
            <PlayIcon size={38} />
          )}
        </button>
        <button className="icon-btn" onClick={() => player.skip(30)} aria-label="Forward 30 seconds">
          <ForwardIcon size={38} seconds={30} />
        </button>
        <button className="icon-btn" onClick={player.nextChapter} aria-label="Next chapter" disabled={!hasChapters}>
          <NextIcon size={26} />
        </button>
      </div>

      <div className="player-extras">
        <button className="pill" onClick={cycleSpeed} aria-label="Playback speed">
          {player.rate}×
        </button>
        <button className={`pill ${player.sleep ? 'pill-active' : ''}`} onClick={() => setSleepOpen(true)}>
          <MoonIcon size={18} />
          {player.sleep && sleepRemaining !== null ? formatTime(sleepRemaining) : 'Sleep'}
        </button>
      </div>

      {sleepOpen && <SleepSheet onClose={() => setSleepOpen(false)} />}

      {night && (
        <div className="night" role="dialog" aria-label="Night screen">
          <button className="night-exit" onClick={() => setNight(false)}>
            Tap to exit night screen
          </button>
          <div className="night-controls">
            <button className="night-small" onClick={() => player.skip(-30)} aria-label="Back 30 seconds">
              <BackIcon size={34} seconds={30} />
            </button>
            <button className="night-play" onClick={player.toggle} aria-label={player.playing ? 'Pause' : 'Play'}>
              {player.playing ? <PauseIcon size={56} /> : <PlayIcon size={56} />}
            </button>
            <button className="night-small" onClick={() => setSleepOpen(true)} aria-label="Sleep timer">
              <MoonIcon size={30} />
            </button>
          </div>
          <div className="night-status">
            {player.sleep && sleepRemaining !== null ? `Sleep in ${formatTime(sleepRemaining)}` : player.playing ? '' : 'Paused'}
          </div>
        </div>
      )}
    </div>
  );
}
