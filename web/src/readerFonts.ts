/// <reference types="vite/client" />
/**
 * Reader fonts. The book is drawn inside an iframe that doesn't see the app's fonts, so the
 * @font-face rules are injected into every page of the book (and once into the app, so the
 * font picker can show each font in its own face).
 */
import atkinson400 from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2?url';
import atkinson400i from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-italic.woff2?url';
import atkinson700 from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2?url';
import atkinson700i from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-italic.woff2?url';
import literata from '@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url';
import literataI from '@fontsource-variable/literata/files/literata-latin-wght-italic.woff2?url';
import dyslexic400 from '@fontsource/opendyslexic/files/opendyslexic-latin-400-normal.woff2?url';
import dyslexic400i from '@fontsource/opendyslexic/files/opendyslexic-latin-400-italic.woff2?url';
import dyslexic700 from '@fontsource/opendyslexic/files/opendyslexic-latin-700-normal.woff2?url';
import dyslexic700i from '@fontsource/opendyslexic/files/opendyslexic-latin-700-italic.woff2?url';

export type ReaderFont = 'book' | 'literata' | 'atkinson' | 'opendyslexic';

export const READER_FONTS: Record<ReaderFont, { label: string; hint: string; family: string | null }> = {
  book: { label: 'Original', hint: "The book's own fonts", family: null },
  literata: { label: 'Literata', hint: 'Classic book serif', family: "'TB Literata', Georgia, serif" },
  atkinson: { label: 'Atkinson', hint: 'Clear, easy-to-tell letters', family: "'TB Atkinson', system-ui, sans-serif" },
  opendyslexic: { label: 'OpenDyslexic', hint: 'Made for readers with dyslexia', family: "'TB OpenDyslexic', sans-serif" },
};

/** Reader colors (also used by read-along in the player). */
export const READER_THEMES: Record<'dark' | 'black' | 'sepia', { bg: string; fg: string; link: string; label: string }> = {
  dark: { bg: '#0b0b10', fg: '#d2cdc0', link: '#f2b45a', label: 'Dark' },
  black: { bg: '#000000', fg: '#9c968a', link: '#b48748', label: 'Black' },
  sepia: { bg: '#17120b', fg: '#c7b28c', link: '#d9a55a', label: 'Sepia' },
};

export const isReaderFont = (v: unknown): v is ReaderFont => typeof v === 'string' && v in READER_FONTS;

// Book pages are loaded from blob: URLs, where relative URLs don't resolve: use absolute ones.
const abs = (url: string) => new URL(url, window.location.href).href;

const face = (family: string, url: string, weight: string, style: string) =>
  `@font-face{font-family:'${family}';src:url('${abs(url)}') format('woff2');font-weight:${weight};font-style:${style};font-display:swap}`;

const FACES = [
  face('TB Literata', literata, '200 900', 'normal'),
  face('TB Literata', literataI, '200 900', 'italic'),
  face('TB Atkinson', atkinson400, '400', 'normal'),
  face('TB Atkinson', atkinson400i, '400', 'italic'),
  face('TB Atkinson', atkinson700, '700', 'normal'),
  face('TB Atkinson', atkinson700i, '700', 'italic'),
  face('TB OpenDyslexic', dyslexic400, '400', 'normal'),
  face('TB OpenDyslexic', dyslexic400i, '400', 'italic'),
  face('TB OpenDyslexic', dyslexic700, '700', 'normal'),
  face('TB OpenDyslexic', dyslexic700i, '700', 'italic'),
].join('\n');

/**
 * CSS for a book page: the font faces, plus one rule per font keyed on a class on <html>, so
 * switching fonts is a class change (no reload, no lost place). Code keeps its monospace.
 */
export function bookFontCss(): string {
  const rules = (Object.keys(READER_FONTS) as ReaderFont[])
    .filter((k) => READER_FONTS[k].family)
    .map(
      (k) =>
        `html.tb-font-${k} body, html.tb-font-${k} body *:not(code):not(pre):not(kbd):not(samp):not(tt){font-family:${READER_FONTS[k].family} !important}`,
    );
  return `${FACES}\n${rules.join('\n')}`;
}

/** Point a book page's <html> at the chosen font. */
export function applyBookFont(doc: Document, font: ReaderFont): void {
  const root = doc.documentElement;
  for (const k of Object.keys(READER_FONTS)) root.classList.remove(`tb-font-${k}`);
  if (READER_FONTS[font].family) root.classList.add(`tb-font-${font}`);
}

/** Load the faces into the app itself too (for previews in the font picker). Idempotent. */
export function ensureAppFontFaces(): void {
  if (document.getElementById('tb-reader-fonts')) return;
  const style = document.createElement('style');
  style.id = 'tb-reader-fonts';
  style.textContent = FACES;
  document.head.appendChild(style);
}
