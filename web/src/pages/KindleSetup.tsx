import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { BookDetail, KindleSettings } from '../api';
import { useAuth } from '../auth';
import { ChevronLeftIcon } from '../components/Icons';
import { toast } from '../components/Toast';

const AMAZON_SETTINGS_URL = 'https://www.amazon.com/myk';

/**
 * Step-by-step Send to Kindle setup, written for people who have never touched
 * Amazon's settings. Opened from Settings, or from a book (?book=ID) so the
 * last step can send that book right away.
 */
export function KindleSetup() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const bookId = Number(params.get('book')) || null;
  const [settings, setSettings] = useState<KindleSettings | null>(null);
  const [book, setBook] = useState<BookDetail | null>(null);
  const [email, setEmail] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api
      .kindle()
      .then((s) => {
        setSettings(s);
        setEmail(s.email ?? '');
      })
      .catch((e: Error) => setError(e.message));
    if (bookId) api.book(bookId).then((r) => setBook(r.book), () => undefined);
  }, [bookId]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // People often type only the first part; finish it for them.
      const typed = email.trim();
      const full = typed && !typed.includes('@') ? `${typed}@kindle.com` : typed;
      const r = await api.setKindleEmail(full);
      setSettings((s) => (s ? { ...s, email: r.email } : s));
      setEmail(r.email ?? '');
      setEditing(false);
      toast(r.email ? 'Kindle address saved' : 'Kindle address removed');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const send = async () => {
    if (!book) return;
    setSending(true);
    try {
      await api.sendToKindle(book.id);
      toast('Sent! It should appear on your Kindle in a few minutes.');
      navigate(`/book/${book.id}`);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const back = (
    <button className="back-link" onClick={() => navigate(-1)}>
      <ChevronLeftIcon size={20} /> Back
    </button>
  );

  if (!settings)
    return (
      <div className="page kindle-page">
        {back}
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );

  if (!settings.enabled)
    return (
      <div className="page kindle-page">
        {back}
        <h1>Send to Kindle</h1>
        <div className="card">
          <p>Sending books to a Kindle isn't turned on for this TurboBooks yet.</p>
          {user?.isAdmin ? (
            <p className="muted small">
              You're the admin: the server needs an email account to send from. Follow <code>docs/KINDLE.md</code> (about
              5 minutes with a Gmail account), then come back here.
            </p>
          ) : (
            <p className="muted small">Ask whoever runs TurboBooks to switch it on. It takes them about 5 minutes.</p>
          )}
        </div>
      </div>
    );

  const saved = settings.email;
  const showForm = !saved || editing;

  return (
    <div className="page kindle-page">
      {back}
      <h1>Send to Kindle</h1>
      <p className="muted">
        Read TurboBooks ebooks on your Kindle. You only have to do this once, and it takes about 5 minutes. You'll need
        your Amazon password.
      </p>

      <ol className="setup-steps">
        <li className={`card setup-step ${saved ? 'done' : ''}`}>
          <h2>
            <span className="step-num">{saved ? '✓' : '1'}</span> Find your Kindle's email address
          </h2>
          <p>
            Every Kindle has its own secret email address. Anything emailed there shows up on the Kindle. It looks like{' '}
            <strong>something@kindle.com</strong>.
          </p>
          <details className="how-to">
            <summary>Where do I find it?</summary>
            <p>
              <strong>On the Kindle itself:</strong> tap the top of the screen, then <em>All Settings</em> →{' '}
              <em>Your Account</em> → <em>Send-to-Kindle Email</em>.
            </p>
            <p>
              <strong>Or on a phone or computer:</strong> open{' '}
              <a href={AMAZON_SETTINGS_URL} target="_blank" rel="noreferrer">
                Amazon's "Manage Your Content and Devices" page
              </a>{' '}
              and sign in. Tap <em>Preferences</em>, then <em>Personal Document Settings</em>. Your Kindle's address is
              listed under <em>Send-to-Kindle Email Settings</em>.
            </p>
            <p className="muted small">
              Shop on a different Amazon site (amazon.co.uk, amazon.ca…)? Sign in there instead; the menus are the same.
            </p>
          </details>

          {showForm ? (
            <form className="stack" onSubmit={save}>
              <label htmlFor="kindle-email">Your Kindle's email address</label>
              <input
                id="kindle-email"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="yourname@kindle.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required={!saved}
              />
              {error && <p className="error">{error}</p>}
              <div className="row-actions">
                <button className="btn btn-primary" disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                {saved && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setEditing(false);
                      setEmail(saved);
                      setError(null);
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          ) : (
            <p className="saved-line">
              Saved: <strong>{saved}</strong>{' '}
              <button className="link-btn" onClick={() => setEditing(true)}>
                Change
              </button>
            </p>
          )}
        </li>

        <li className="card setup-step">
          <h2>
            <span className="step-num">2</span> Tell Amazon to accept books from TurboBooks
          </h2>
          <p>
            To stop spam, Amazon throws away emails from addresses it doesn't know. Add TurboBooks' address to your list
            of approved senders:
          </p>
          <CopyBox text={settings.sender!} />
          <ol className="sub-steps">
            <li>
              Open{' '}
              <a href={AMAZON_SETTINGS_URL} target="_blank" rel="noreferrer">
                Amazon's "Manage Your Content and Devices" page
              </a>{' '}
              → <em>Preferences</em> → <em>Personal Document Settings</em>.
            </li>
            <li>
              Scroll to <em>Approved Personal Document E-mail List</em> and tap{' '}
              <em>Add a new approved e-mail address</em>.
            </li>
            <li>
              Paste the address above and tap <em>Add Address</em>.
            </li>
          </ol>
          <p className="muted small">This step can only be done on Amazon's website, not on the Kindle.</p>
        </li>

        <li className="card setup-step">
          <h2>
            <span className="step-num">3</span> Send a book
          </h2>
          <p>
            Open any ebook in TurboBooks and tap <strong>Send to Kindle</strong>. Make sure your Kindle is on Wi-Fi. The
            book usually appears within a few minutes.
          </p>
          {book && saved && (
            <button className="btn btn-primary" onClick={send} disabled={sending}>
              {sending ? 'Sending…' : `Send "${book.title}" now`}
            </button>
          )}
          <p className="muted small">
            The first time, Amazon may email you asking you to confirm. Open that email and tap <em>Verify Request</em>.
          </p>
        </li>
      </ol>

      <div className="card">
        <h2>Book didn't show up?</h2>
        <ul className="tips">
          <li>Wait 10 minutes. Amazon is sometimes slow.</li>
          <li>
            Check the Kindle is on Wi-Fi, then make it check for new books: <em>All Settings</em> →{' '}
            <em>Sync Your Kindle</em>.
          </li>
          <li>
            Check your email (the one you use for Amazon). Amazon may be asking you to confirm, or telling you why it
            couldn't deliver the book.
          </li>
          <li>Check step 2: the approved address must match the one above exactly.</li>
          <li>Check step 1: the Kindle address must be your Kindle's, not your personal email.</li>
        </ul>
        <p className="muted small">
          Good to know: your place in the book on the Kindle stays on the Kindle. It doesn't sync back to TurboBooks.
        </p>
      </div>
    </div>
  );
}

function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (e.g. plain http): select the text so a long-press copies it.
      const el = document.getElementById('kindle-sender');
      if (el) window.getSelection()?.selectAllChildren(el);
    }
  };
  return (
    <div className="copy-box">
      <code id="kindle-sender">{text}</code>
      <button type="button" className="btn btn-small" onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}
