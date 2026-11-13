import { useEffect } from 'react';
import { usePrefs } from '../prefs';
import type { Prefs } from '../prefs';
import { READER_FONTS, READER_THEMES, ensureAppFontFaces } from '../readerFonts';
import type { ReaderFont } from '../readerFonts';
import '../styles-reader.css';

/** Same limits as the reader's A− / A+. */
const FONT_MIN = 80;
const FONT_MAX = 200;
/** Rough size of the reader's body text at 100%, so the preview matches what books look like. */
const BASE_REM = 1.05;

const SAMPLE = [
  'The lamp was low and the house was quiet. Rain tapped at the window, patient as a cat that knows the door will open eventually.',
  '“One more chapter,” she said, to no one in particular, and turned the page.',
];

/**
 * Settings → Reading: the font, text size and colours every ebook opens with (and read along in
 * the player). The same settings as the reader's Aa sheet, so changing either changes both.
 */
export function ReadingPrefs() {
  const [prefs, setPrefs] = usePrefs();
  useEffect(ensureAppFontFaces, []);
  const theme = READER_THEMES[prefs.readerTheme];
  const size = (n: number) => setPrefs({ readerFontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, n)) });

  return (
    <div className="card reading-prefs">
      <h2>Reading</h2>
      <p className="muted small">
        How ebooks look when you open them, and the text in read along. Saved to your account, so every device reads the same way.
        You can still change it inside a book with <strong>Aa</strong>.
      </p>

      <div
        className="reading-preview"
        style={{
          background: theme.bg,
          color: theme.fg,
          fontFamily: READER_FONTS[prefs.readerFont].family ?? "Georgia, 'Times New Roman', serif",
          fontSize: `${(prefs.readerFontSize / 100) * BASE_REM}rem`,
        }}
        aria-label="Preview"
      >
        {SAMPLE.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>

      <h3 className="reader-sub">Text size</h3>
      <div className="reading-size">
        <button className="btn" onClick={() => size(prefs.readerFontSize - 10)} disabled={prefs.readerFontSize <= FONT_MIN} aria-label="Smaller text">
          A−
        </button>
        <input
          type="range"
          min={FONT_MIN}
          max={FONT_MAX}
          step={10}
          value={prefs.readerFontSize}
          onChange={(e) => size(Number(e.target.value))}
          aria-label="Text size"
        />
        <button className="btn" onClick={() => size(prefs.readerFontSize + 10)} disabled={prefs.readerFontSize >= FONT_MAX} aria-label="Larger text">
          A+
        </button>
        <span className="reading-size-value">{prefs.readerFontSize}%</span>
      </div>

      <h3 className="reader-sub">Font</h3>
      <div className="reader-fonts" role="radiogroup" aria-label="Font">
        {(Object.keys(READER_FONTS) as ReaderFont[]).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={prefs.readerFont === k}
            className={`reader-font ${prefs.readerFont === k ? 'active' : ''}`}
            onClick={() => setPrefs({ readerFont: k })}
          >
            <span className="reader-font-sample" style={{ fontFamily: READER_FONTS[k].family ?? "Georgia, 'Times New Roman', serif" }}>
              Aa
            </span>
            <span className="reader-font-name">{READER_FONTS[k].label}</span>
            <span className="reader-font-hint">{READER_FONTS[k].hint}</span>
          </button>
        ))}
      </div>
      <p className="muted small">“Original” uses each book's own fonts; the preview shows a typical book serif.</p>

      <h3 className="reader-sub">Colors</h3>
      <div className="chips tight">
        {(Object.keys(READER_THEMES) as Prefs['readerTheme'][]).map((k) => (
          <button
            key={k}
            className={`chip theme-chip ${prefs.readerTheme === k ? 'chip-active' : ''}`}
            onClick={() => setPrefs({ readerTheme: k })}
            aria-pressed={prefs.readerTheme === k}
          >
            <span className="theme-swatch" style={{ background: READER_THEMES[k].bg, color: READER_THEMES[k].fg }}>
              Aa
            </span>
            {READER_THEMES[k].label}
          </button>
        ))}
      </div>
    </div>
  );
}
