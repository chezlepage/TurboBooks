import { Suspense, lazy } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { BooksIcon, PlusIcon, SearchIcon, UserIcon } from './components/Icons';
import { MiniPlayer } from './components/MiniPlayer';
import { Toaster } from './components/Toast';
import { BookPage } from './pages/BookPage';
import { Discover } from './pages/Discover';
import { Request } from './pages/Request';
import { Library } from './pages/Library';
import { Login } from './pages/Login';
import { PlayerPage } from './pages/PlayerPage';
import { Profile } from './pages/Profile';
import { Settings } from './pages/Settings';
import { PlayerProvider } from './player/PlayerContext';

// The EPUB engine is large; only load it when someone opens an ebook.
const ReaderPage = lazy(() => import('./pages/ReaderPage').then((m) => ({ default: m.ReaderPage })));

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
  // Full-screen pages hide the tab bar and mini player.
  const onPlayer = location.pathname === '/player' || location.pathname.startsWith('/read/');
  return (
    <div className={`app ${onPlayer ? 'app-player' : ''}`}>
      <main>
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/book/:id" element={<BookPage />} />
          <Route path="/player" element={<PlayerPage />} />
          <Route
            path="/read/:id"
            element={
              <Suspense fallback={<div className="splash" />}>
                <ReaderPage />
              </Suspense>
            }
          />
          <Route path="/discover" element={<Discover />} />
          <Route path="/request" element={<Request />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/profile/:id" element={<Profile />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {!onPlayer && (
        <>
          {/* Mini player sits above the tabs on phones and along the bottom on desktop. */}
          <div className="bottom-dock">
            <MiniPlayer />
          </div>
          {/* Bottom tab bar on phones, left sidebar on wide screens. */}
          <nav className="tab-bar" aria-label="Main">
            <div className="brand">
              <img src="/icon.svg" alt="" />
              <span>TurboBooks</span>
            </div>
            <NavLink to="/" end>
              <BooksIcon size={22} />
              <span>Library</span>
            </NavLink>
            <NavLink to="/discover">
              <SearchIcon size={22} />
              <span>Discover</span>
            </NavLink>
            <NavLink to="/request">
              <PlusIcon size={22} />
              <span>Request</span>
            </NavLink>
            <NavLink to="/profile" className={({ isActive }) => (isActive || location.pathname === '/settings' ? 'active' : '')}>
              <UserIcon size={22} />
              <span>Profile</span>
            </NavLink>
          </nav>
        </>
      )}
      <Toaster />
    </div>
  );
}
