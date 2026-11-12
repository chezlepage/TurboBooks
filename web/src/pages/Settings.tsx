import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import type { AdminUser } from '../api';
import { useAuth } from '../auth';

export function Settings() {
  const { user, logout } = useAuth();
  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="muted">
        Signed in as <strong>{user?.username}</strong>
        {user?.isAdmin && ' (admin)'}
      </p>
      <ChangePassword />
      {user?.isAdmin && <AdminPanel />}
      <button className="btn btn-ghost btn-block" onClick={() => void logout()}>
        Sign out
      </button>
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.changePassword(current, next);
      setMsg({ ok: true, text: 'Password changed. Other devices were signed out.' });
      setCurrent('');
      setNext('');
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Change password</h2>
      <input
        type="password"
        placeholder="Current password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        required
      />
      <input
        type="password"
        placeholder="New password (8+ characters)"
        autoComplete="new-password"
        minLength={8}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        required
      />
      {msg && <p className={msg.ok ? 'success' : 'error'}>{msg.text}</p>}
      <button className="btn">Update password</button>
    </form>
  );
}

function AdminPanel() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  const load = () =>
    api
      .users()
      .then((r) => setUsers(r.users))
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.createUser(username.trim(), password, isAdmin);
      setMsg({ ok: true, text: `Created ${username}.` });
      setUsername('');
      setPassword('');
      setIsAdmin(false);
      void load();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  };

  const reset = async (u: AdminUser) => {
    const pw = prompt(`New password for ${u.username} (8+ characters):`);
    if (!pw) return;
    try {
      await api.resetUserPassword(u.id, pw);
      setMsg({ ok: true, text: `Password reset for ${u.username}.` });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  };

  const remove = async (u: AdminUser) => {
    if (!confirm(`Delete user ${u.username}? Their listening progress will be lost.`)) return;
    await api.deleteUser(u.id).catch((err: Error) => setMsg({ ok: false, text: err.message }));
    void load();
  };

  const scan = async () => {
    setScanMsg('Scanning…');
    try {
      const { result } = await api.scan();
      setScanMsg(`Done: ${result.added} added, ${result.updated} updated, ${result.removed} removed${result.failed ? `, ${result.failed} failed` : ''}.`);
    } catch (err) {
      setScanMsg((err as Error).message);
    }
  };

  return (
    <>
      <div className="card">
        <h2>Users</h2>
        <ul className="user-list">
          {users.map((u) => (
            <li key={u.id}>
              <span>
                {u.username}
                {u.isAdmin && <span className="badge">admin</span>}
              </span>
              <span className="user-actions">
                <button className="btn btn-small btn-ghost" onClick={() => reset(u)}>
                  Reset password
                </button>
                {u.id !== me?.id && (
                  <button className="btn btn-small btn-ghost danger" onClick={() => remove(u)}>
                    Delete
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
        <form onSubmit={create} className="stack">
          <h3>Add user</h3>
          <input
            placeholder="Username"
            autoCapitalize="none"
            autoCorrect="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Password (8+ characters)"
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <label className="checkbox">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> Admin (can manage
            users and delete books)
          </label>
          {msg && <p className={msg.ok ? 'success' : 'error'}>{msg.text}</p>}
          <button className="btn">Create user</button>
        </form>
      </div>

      <div className="card">
        <h2>Library</h2>
        <p className="muted small">
          Books are rescanned automatically. Rescan now after copying files into the library folder.
        </p>
        <button className="btn" onClick={scan}>
          Rescan library
        </button>
        {scanMsg && <p className="muted small">{scanMsg}</p>}
      </div>
    </>
  );
}
