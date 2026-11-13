import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, EREADER_NAMES } from '../api';
import type { BookDetail, Ereader, KindleSettings } from '../api';
import { useAuth } from '../auth';
import { ChevronLeftIcon } from '../components/Icons';
import { toast } from '../components/Toast';

const AMAZON_SETTINGS_URL = 'https://www.amazon.com/myk';
const DOMAIN: Record<Ereader, string> = { kindle: 'kindle.com', pocketbook: 'pbsync.com' };
const deviceOf = (email: string | null): Ereader | null =>
  email?.endsWith('@pbsync.com') ? 'pocketbook' : email ? 'kindle' : null;

/**
 * Step-by-step "send ebooks to my e-reader" setup (Kindle or PocketBook), written for people
 * who have never touched their e-reader's settings. Opened from Settings, or from a book
 * (?book=ID) so the last step can send that book right away. ?device=pocketbook preselects.
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
  const [device, setDevice] = useState<Ereader>(params.get('device') === 'pocketbook' ? 'pocketbook' : 'kindle');
  const name = EREADER_NAMES[device];

  useEffect(() => {
    api
      .kindle()
      .then((s) => {
        setSettings(s);
        setEmail(s.email ?? '');
        if (s.device) setDevice(s.device);
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
      const full = typed && !typed.includes('@') ? `${typed}@${DOMAIN[device]}` : typed;
      const r = await api.setKindleEmail(full);
      setSettings((s) => (s ? { ...s, email: r.email, device: r.device } : s));
      setEmail(r.email ?? '');
      setEditing(false);
      if (r.device) setDevice(r.device);
      toast(r.email ? `${EREADER_NAMES[r.device ?? device]} address saved` : 'Address removed');
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
      toast(`Sent! It should appear on your ${name} in a few minutes.`);
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
        <h1>Send to e-reader</h1>
        <div className="card">
          <p>Sending books to a Kindle or PocketBook isn't turned on for this TurboBooks yet.</p>
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

  // An address saved for the other kind of e-reader doesn't count on this tab.
  const saved = deviceOf(settings.email) === device ? settings.email : null;
  const showForm = !saved || editing;

  const addressForm = showForm ? (
    <form className="stack" onSubmit={save}>
      <label htmlFor="ereader-email">Your {name}'s email address</label>
      <input
        id="ereader-email"
        type="email"
        inputMode="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder={`yourname@${DOMAIN[device]}`}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required={!saved}
      />
      {settings.email && !saved && (
        <p className="muted small">
          This replaces your {EREADER_NAMES[deviceOf(settings.email)!]} address ({settings.email}). TurboBooks sends to
          one e-reader at a time.
        </p>
      )}
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
  );

  const sendNow = book && saved && (
    <button className="btn btn-primary" onClick={send} disabled={sending}>
      {sending ? 'Sending…' : `Send "${book.title}" now`}
    </button>
  );

  const pickDevice = (d: Ereader) => {
    setDevice(d);
    setEditing(false);
    setError(null);
    setEmail(deviceOf(settings.email) === d ? (settings.email ?? '') : '');
  };

  return (
    <div className="page kindle-page">
      {back}
      <h1>Send to {name}</h1>
      <div className="segmented ereader-pick" role="tablist" aria-label="Which e-reader?">
        {(['kindle', 'pocketbook'] as Ereader[]).map((d) => (
          <button
            key={d}
            role="tab"
            aria-selected={device === d}
            className={device === d ? 'active' : ''}
            onClick={() => pickDevice(d)}
          >
            {EREADER_NAMES[d]}
          </button>
        ))}
      </div>
      {device === 'kindle' ? (
        <KindleSteps sender={settings.sender!} saved={saved} addressForm={addressForm} sendNow={sendNow} />
      ) : (
        <PocketBookSteps sender={settings.sender!} saved={saved} addressForm={addressForm} sendNow={sendNow} />
      )}
    </div>
  );
}

interface StepsProps {
  sender: string;
  saved: string | null;
  addressForm: ReactNode;
  sendNow: ReactNode;
}

function KindleSteps({ sender, saved, addressForm, sendNow }: StepsProps) {
  return (
    <>
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
          {addressForm}
        </li>

        <li className="card setup-step">
          <h2>
            <span className="step-num">2</span> Tell Amazon to accept books from TurboBooks
          </h2>
          <p>
            To stop spam, Amazon throws away emails from addresses it doesn't know. Add TurboBooks' address to your list
            of approved senders:
          </p>
          <CopyBox text={sender} />
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
          {sendNow}
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
    </>
  );
}

function PocketBookSteps({ sender, saved, addressForm, sendNow }: StepsProps) {
  return (
    <>
      <p className="muted">
        Read TurboBooks ebooks on your PocketBook. Books arrive over Wi-Fi through PocketBook's free{' '}
        <strong>Send-to-PocketBook</strong> service. You only have to do this once, and it takes about 5 minutes.
      </p>

      <ol className="setup-steps">
        <li className={`card setup-step ${saved ? 'done' : ''}`}>
          <h2>
            <span className="step-num">{saved ? '✓' : '1'}</span> Get your PocketBook's email address
          </h2>
          <p>
            Send-to-PocketBook gives your e-reader its own email address. Anything emailed there downloads to the
            PocketBook. It looks like <strong>something@pbsync.com</strong>.
          </p>
          <details className="how-to">
            <summary>Where do I find it?</summary>
            <p>
              <strong>On the PocketBook:</strong> connect to Wi-Fi, then open <em>Settings</em> →{' '}
              <em>Accounts and synchronization</em> → <em>Send-to-PocketBook</em>.
            </p>
            <p>
              <strong>Never used it?</strong> The same screen lets you sign up: enter your own email address, then open
              the email PocketBook sends you and confirm. Your new @pbsync.com address then shows on that screen, and in
              PocketBook's welcome email.
            </p>
            <p className="muted small">Menu names can differ slightly between PocketBook models.</p>
          </details>
          {addressForm}
        </li>

        <li className="card setup-step">
          <h2>
            <span className="step-num">2</span> Send a book, and approve TurboBooks once
          </h2>
          <p>
            Open any ebook in TurboBooks and tap <strong>Send to PocketBook</strong>.
          </p>
          {sendNow}
          <p>
            The very first time, PocketBook emails <em>you</em> (the address you signed up with) to ask whether to accept
            books from TurboBooks' address:
          </p>
          <CopyBox text={sender} />
          <p>
            Open that email and confirm. From then on, books from TurboBooks arrive without asking. If the first book
            doesn't show up after you confirm, send it again.
          </p>
        </li>

        <li className="card setup-step">
          <h2>
            <span className="step-num">3</span> Find it on the PocketBook
          </h2>
          <p>
            Keep the PocketBook on Wi-Fi. New books download by themselves within a few minutes and appear in your{' '}
            <em>Library</em>, usually in a <em>Send-to-PocketBook</em> folder.
          </p>
        </li>
      </ol>

      <div className="card">
        <h2>Book didn't show up?</h2>
        <ul className="tips">
          <li>Wait a few minutes, then turn the PocketBook's Wi-Fi off and on so it checks for new books.</li>
          <li>
            Check your email (the one you signed up to Send-to-PocketBook with). PocketBook may still be waiting for you
            to approve TurboBooks (step 2).
          </li>
          <li>Check step 1: the address must be your PocketBook's @pbsync.com address, not your personal email.</li>
        </ul>
        <p className="muted small">
          Good to know: your place in the book on the PocketBook stays on the PocketBook. It doesn't sync back to
          TurboBooks.
        </p>
      </div>
    </>
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
      const el = document.getElementById('ereader-sender');
      if (el) window.getSelection()?.selectAllChildren(el);
    }
  };
  return (
    <div className="copy-box">
      <code id="ereader-sender">{text}</code>
      <button type="button" className="btn btn-small" onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}
