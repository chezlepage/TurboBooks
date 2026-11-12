/**
 * Pulls readable chapters out of an EPUB: spine order, table-of-contents titles, plain-text
 * paragraphs. Project Gutenberg's license header/footer is cut deterministically (the
 * "*** START OF ..." / "*** END OF ..." markers), so we never pay to have it read or narrated.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

export interface Chapter {
  index: number;
  title: string;
  paragraphs: string[];
}

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))?.slice(2).find(Boolean);

/** XHTML → paragraphs of plain text. Block elements become paragraph breaks. */
export function htmlToParagraphs(html: string): string[] {
  const body = html.match(/<body[\s\S]*?>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const text = body
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    // Footnote/page markers like <sup>12</sup> or <span class="pagenum">[12]</span> are noise when read aloud.
    .replace(/<sup[\s\S]*?<\/sup>/gi, '')
    .replace(/<span[^>]*class="[^"]*pagenum[^"]*"[\s\S]*?<\/span>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|blockquote|tr|section|article|header|footer|pre|dd|dt|table)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decode(text)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0 && /[\p{L}\p{N}]/u.test(p));
}

const resolve = (base: string, href: string) =>
  path.posix.normalize(path.posix.join(path.posix.dirname(base), decodeURIComponent(href.split('#')[0])));

interface TocEntry {
  file: string;
  /** Element id the entry jumps to, if it points inside a file. */
  frag: string | null;
  label: string;
}

/** Table-of-contents entries in reading order (EPUB3 nav, else EPUB2 NCX). */
function tocEntries(
  files: Record<string, Uint8Array>,
  opfPath: string,
  opf: string,
  items: Map<string, { href: string; props: string; type: string }>,
): TocEntry[] {
  const out: TocEntry[] = [];
  const push = (base: string, href: string, rawLabel: string) => {
    const label = decode(rawLabel.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!label) return;
    out.push({ file: resolve(base, href), frag: href.includes('#') ? decodeURIComponent(href.split('#')[1]) : null, label });
  };
  const navItem = [...items.values()].find((i) => i.props.split(/\s+/).includes('nav'));
  if (navItem) {
    const navPath = resolve(opfPath, navItem.href);
    const nav = files[navPath] ? strFromU8(files[navPath]) : '';
    const tocNav = nav.match(/<nav[^>]*epub:type="toc"[\s\S]*?<\/nav>/i)?.[0] ?? nav;
    for (const m of tocNav.matchAll(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) push(navPath, m[1], m[2]);
  }
  if (out.length === 0) {
    const ncxId = attr(opf.match(/<spine\b[^>]*>/i)?.[0] ?? '', 'toc');
    const ncxItem = ncxId ? items.get(ncxId) : [...items.values()].find((i) => i.type === 'application/x-dtbncx+xml');
    if (ncxItem) {
      const ncxPath = resolve(opfPath, ncxItem.href);
      const ncx = files[ncxPath] ? strFromU8(files[ncxPath]) : '';
      for (const m of ncx.matchAll(/<navPoint[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content[^>]*src\s*=\s*"([^"]+)"/gi)) push(ncxPath, m[2], m[1]);
    }
  }
  return out;
}

/** Splits one content file at the TOC anchors inside it: [{label, html}] in document order. */
function splitAtAnchors(html: string, entries: TocEntry[]): { label: string | null; html: string }[] {
  const cuts = entries
    .map((e) => {
      if (!e.frag) return { label: e.label, pos: 0 };
      const esc = e.frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`<[a-z0-9]+\\b[^>]*\\bid\\s*=\\s*["']${esc}["']`, 'i').exec(html);
      return m ? { label: e.label, pos: m.index } : null;
    })
    .filter((c): c is { label: string; pos: number } => c !== null)
    .sort((a, b) => a.pos - b.pos)
    .filter((c, i, arr) => i === 0 || c.pos !== arr[i - 1].pos);
  if (cuts.length === 0) return [{ label: null, html }];
  const parts: { label: string | null; html: string }[] = [];
  if (cuts[0].pos > 0) parts.push({ label: null, html: html.slice(0, cuts[0].pos) });
  cuts.forEach((c, i) => parts.push({ label: c.label, html: html.slice(c.pos, cuts[i + 1]?.pos ?? html.length) }));
  return parts;
}

export async function extractChapters(epubPath: string): Promise<Chapter[]> {
  const files = unzipSync(new Uint8Array(await fs.readFile(epubPath)));
  const container = files['META-INF/container.xml'];
  if (!container) throw new Error('Not an EPUB');
  const opfPath = strFromU8(container).match(/full-path\s*=\s*"([^"]+)"/)?.[1];
  if (!opfPath || !files[opfPath]) throw new Error('EPUB has no package file');
  const opf = strFromU8(files[opfPath]);

  const items = new Map<string, { href: string; props: string; type: string }>();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = attr(m[0], 'id');
    const href = attr(m[0], 'href');
    if (id && href) items.set(id, { href, props: attr(m[0], 'properties') ?? '', type: attr(m[0], 'media-type') ?? '' });
  }
  const toc = tocEntries(files, opfPath, opf, items);

  let chapters: Chapter[] = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const item = items.get(attr(m[0], 'idref') ?? '');
    if (!item || !/html/.test(item.type)) continue;
    const file = resolve(opfPath, item.href);
    if (!files[file]) continue;
    for (const part of splitAtAnchors(strFromU8(files[file]), toc.filter((e) => e.file === file))) {
      const paragraphs = htmlToParagraphs(part.html);
      if (paragraphs.length === 0) continue;
      // Text before the first TOC anchor in a file continues the previous chapter.
      if (!part.label && chapters.length > 0) {
        chapters[chapters.length - 1].paragraphs.push(...paragraphs);
        continue;
      }
      chapters.push({ index: chapters.length, title: part.label ?? paragraphs[0].slice(0, 80), paragraphs });
    }
  }

  // Cut Project Gutenberg's license text: keep only what's between the START and END markers.
  const all = chapters.flatMap((c, ci) => c.paragraphs.map((p, pi) => ({ ci, pi, p })));
  const start = all.findIndex((x) => /\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG/i.test(x.p));
  const end = all.findIndex((x) => /\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i.test(x.p));
  if (start >= 0 || end >= 0) {
    const keep = new Set(all.filter((_, i) => (start < 0 || i > start) && (end < 0 || i < end)).map((x) => `${x.ci}:${x.pi}`));
    chapters = chapters
      .map((c) => ({ ...c, paragraphs: c.paragraphs.filter((_, pi) => keep.has(`${c.index}:${pi}`)) }))
      .filter((c) => c.paragraphs.length > 0)
      .map((c, i) => ({ ...c, index: i }));
  }
  // Fold tiny sections (title pages, "IN PROSE", one-line headings) into the next chapter so
  // they don't become 5-second tracks.
  const words = (c: Chapter) => c.paragraphs.join(' ').split(/\s+/).length;
  const merged: Chapter[] = [];
  let carry: string[] = [];
  for (const c of chapters) {
    if (words(c) < 40 && c !== chapters[chapters.length - 1]) {
      carry.push(...c.paragraphs);
      continue;
    }
    merged.push({ ...c, index: merged.length, paragraphs: [...carry, ...c.paragraphs] });
    carry = [];
  }
  if (carry.length && merged.length) merged[merged.length - 1].paragraphs.push(...carry);
  return merged;
}
