import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { BooksIcon, GearIcon, SearchIcon } from './components/Icons';
import { MiniPlayer } from './components/MiniPlayer';
import { BookPage } from './pages/BookPage';
import { Discover } from './pages/Discover';
import { Library } from './pages/Library';
import { Login } from './pages/Login';
import { PlayerPage } from './pages/PlayerPage';
import { Settings } from './pages/Settings';
import { PlayerProvider } from './player/PlayerContext';

export function App() {
  const { user, checking } = useAuth();
  if (checking) return <div className="splash" />;
  if (!user) return <Login />;
  // Keyed by user so switching accounts resets the player.
  return (
    <PlayerProvider key={user.id}>
      <Shell />
    </PlayerProvider>
  );
}

function Shell() {
  const location = useLocation();
  const onPlayer = location.pathname === '/player';
  return (
    <div className={`app ${onPlayer ? 'app-player' : ''}`}>
      <main>
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/book/:id" element={<BookPage />} />
          <Route path="/player" element={<PlayerPage />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {!onPlayer && (
        <div className="bottom-dock">
          <MiniPlayer />
          <nav className="tab-bar">
            <NavLink to="/" end>
              <BooksIcon size={22} />
              <span>Library</span>
            </NavLink>
            <NavLink to="/discover">
              <SearchIcon size={22} />
              <span>Discover</span>
            </NavLink>
            <NavLink to="/settings">
              <GearIcon size={22} />
              <span>Settings</span>
            </NavLink>
          </nav>
        </div>
      )}
    </div>
  );
}
