/**
 * Discover + import free audiobooks from the Internet Archive's LibriVox collection.
 *
 * The LibriVox API itself only supports exact/prefix title matches, so we search
 * archive.org (which hosts every LibriVox recording) and download from there.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { download, getJson, libraryState, moveIntoLibrary, safeName, updateImport } from './download.js';
import type { BookMetadataFile } from './scanner.js';
import { scanSingleDir } from './scanner.js';

const COLLECTION = 'librivoxaudio';
export const SOURCE = 'archive';

export const isValidIdentifier = (id: string) => /^[A-Za-z0-9._-]{1,100}$/.test(id);

export interface SearchResult {
  id: string;
  title: string;
  author: string;
  description: string;
  language: string;
  duration: string;
  durationSecs: number;
  coverUrl: string;
  sourceUrl: string;
  /** Set when this recording is already in the library. */
  bookId: number | null;
  importStatus: string | null;
  kind: 'audio' | 'ebook';
}

const LANGUAGES: Record<string, string> = {
  eng: 'English', English: 'English', ger: 'German', deu: 'German', fre: 'French', fra: 'French',
  spa: 'Spanish', ita: 'Italian', dut: 'Dutch', nld: 'Dutch', por: 'Portuguese', rus: 'Russian',
  chi: 'Chinese', zho: 'Chinese', jpn: 'Japanese', lat: 'Latin', gre: 'Greek', pol: 'Polish',
};

const stripHtml = (s = '') =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** IA fields can be a string or an array of strings. */
const first = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v));
const joined = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(', ') : first(v));

function parseRuntime(s: string): number {
  const parts = s.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return Number(s) || 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const paragraphs = (raw: string) =>
  raw
    .split(/\n\s*\n|<br\s*\/?>\s*<br\s*\/?>|<\/p>/i)
    .map((p) => stripHtml(p))
    .filter(Boolean);

/** Index just past the sentence that starts at `from`, not counting initials like "F." as sentence ends. */
function sentenceEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== '.') continue;
    const wordBefore = text.slice(from, i).split(/\s+/).pop() ?? '';
    const atEnd = i + 1 >= text.length || /\s/.test(text[i + 1]);
    if (atEnd && wordBefore.length > 1) return i + 1;
  }
  return text.length;
}

/**
 * Splits LibriVox boilerplate off a description. It shows up as
 * "LibriVox recording of TITLE by AUTHOR. Read [in English] by READER. Actual description..."
 * in one paragraph or spread over several.
 */
function splitBoilerplate(raw: string, author: string): { description: string; reader?: string } {
  const text = paragraphs(raw).join('\n\n');
  if (!/^librivox recording of/i.test(text)) return { description: text };
  let rest: string;
  const byAuthor = author ? text.toLowerCase().indexOf(` by ${author.toLowerCase()}`) : -1;
  if (byAuthor >= 0 && byAuthor < 400) {
    rest = text.slice(byAuthor + 4 + author.length).replace(/^[.,]?\s*/, '');
  } else {
    rest = text.slice(sentenceEnd(text, 0)).trimStart();
  }
  let reader: string | undefined;
  const readBy = rest.match(/^Read (?:in English )?by\s+/i);
  if (readBy) {
    const end = sentenceEnd(rest, readBy[0].length);
    const name = rest.slice(readBy[0].length, end).replace(/\.$/, '').trim();
    if (name.length > 0 && name.length <= 120) reader = name;
    rest = rest.slice(end).trimStart();
  }
  return { description: rest || text, reader };
}

const cleanDescription = (raw: string, author: string) =>
  splitBoilerplate(raw, author)
    .description // LibriVox pages often end with a download link that means nothing here.
    .replace(/\s*Download M4B\s*\([^)]*\)\s*$/i, '')
    .trim();
const readerFrom = (raw: string, author: string) => splitBoilerplate(raw, author).reader;

/** IA titles are sometimes "Title, by Author". */
function cleanTitle(title: string, author: string): string {
  if (!author) return title;
  const escaped = author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(`,?\\s+by\\s+${escaped}\\s*$`, 'i'), '').trim() || title;
}


export const CATEGORIES: Record<string, { label: string; query?: string; maxSecs?: number }> = {
  popular: { label: 'Popular' },
  bedtime: { label: 'Bedtime & children', query: 'subject:(children OR "fairy tales" OR fairy OR fables OR nursery)' },
  short: { label: 'Under 90 min', maxSecs: 90 * 60 },
  mystery: { label: 'Mystery', query: 'subject:(mystery OR detective OR crime)' },
  adventure: { label: 'Adventure', query: 'subject:(adventure)' },
  fantasy: { label: 'Fantasy', query: 'subject:(fantasy)' },
  scifi: { label: 'Sci-fi', query: 'subject:("science fiction")' },
  humor: { label: 'Humor', query: 'subject:(humor OR humorous OR comedy)' },
  horror: { label: 'Spooky', query: 'subject:(horror OR ghost OR supernatural)' },
};

interface QueryOptions {
  /** Whose library to mark results against. */
  userId: number;
  text?: string;
  category?: string;
  english?: boolean;
  page?: number;
}

const PAGE_SIZE = 30;
const cache = new Map<string, { at: number; docs: Record<string, unknown>[] }>();
const CACHE_MS = 60 * 60 * 1000;

async function fetchDocs(q: string, rows: number, page: number): Promise<Record<string, unknown>[]> {
  const url = new URL('https://archive.org/advancedsearch.php');
  url.searchParams.set('q', q);
  for (const f of ['identifier', 'title', 'creator', 'description', 'runtime', 'language']) url.searchParams.append('fl[]', f);
  url.searchParams.append('sort[]', 'downloads desc');
  url.searchParams.set('rows', String(rows));
  url.searchParams.set('page', String(page + 1));
  url.searchParams.set('output', 'json');
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.docs;
  const json = await getJson<{ response?: { docs?: Record<string, unknown>[] } }>(key);
  const docs = json.response?.docs ?? [];
  cache.set(key, { at: Date.now(), docs });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return docs;
}

/** "The Time Machine (version 3)" and "The Time Machine" are the same book. */
const titleKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/\((dramatic reading|version \d+|abridged|unabridged)[^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export async function search(opts: QueryOptions): Promise<{ results: SearchResult[]; hasMore: boolean }> {
  const parts = [`collection:${COLLECTION}`, 'mediatype:audio'];
  if (opts.english !== false) parts.push('language:(eng OR English)');

  if (opts.text) {
    // Keep only words; Lucene special characters would otherwise break or widen the query.
    const words = opts.text
      .replace(/[+\-&|!(){}[\]^"~*?:\/]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8);
    if (words.length === 0) return { results: [], hasMore: false };
    const terms = words.join(' AND ');
    parts.push(`(title:(${terms}) OR creator:(${terms}))`);
  }
  const category = opts.category ? CATEGORIES[opts.category] : undefined;
  if (category?.query) parts.push(`(${category.query})`);

  // Runtime can't be filtered by the search API, so for the "short" shelf fetch a big page and filter here.
  const rows = category?.maxSecs ? 300 : PAGE_SIZE;
  const page = Math.max(0, opts.page ?? 0);
  const docs = await fetchDocs(parts.join(' AND '), rows, page);

  const { bookIds: libraryIds, imports } = libraryState(SOURCE, opts.userId);

  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const d of docs) {
    const id = first(d.identifier);
    if (!isValidIdentifier(id)) continue;
    const author = stripHtml(joined(d.creator)) || 'Unknown';
    const title = cleanTitle(stripHtml(first(d.title)) || id, author);
    const runtime = first(d.runtime);
    const durationSecs = parseRuntime(runtime);
    if (category?.maxSecs && (durationSecs <= 0 || durationSecs > category.maxSecs)) continue;
    // Results are sorted by popularity, so the first version of a title is the one people liked most.
    const key = `${titleKey(title)}|${author.toLowerCase()}`;
    if (seen.has(key) && !libraryIds.has(id)) continue;
    seen.add(key);
    const lang = first(d.language);
    results.push({
      id,
      title,
      author,
      description: cleanDescription(first(d.description), author).slice(0, 800),
      language: LANGUAGES[lang] ?? lang,
      duration: runtime,
      durationSecs,
      coverUrl: `https://archive.org/services/img/${encodeURIComponent(id)}`,
      sourceUrl: `https://archive.org/details/${encodeURIComponent(id)}`,
      bookId: libraryIds.get(id) ?? null,
      importStatus: imports.get(id) ?? null,
      kind: 'audio',
    });
  }
  return { results, hasMore: docs.length === rows };
}

// ---------------------------------------------------------------------------
// Import: downloads into <library>/.incoming, then moves it into
// <library>/LibriVox/<Author> - <Title> and rescans. Queued by imports.ts.
// ---------------------------------------------------------------------------

interface IaFile {
  name: string;
  format?: string;
  title?: string;
  track?: string;
  length?: string;
  size?: string;
}

interface IaMetadata {
  metadata?: Record<string, unknown>;
  files?: IaFile[];
}

/** LibriVox items carry several encodings of the same audio; take one set. */
const AUDIO_FORMATS = ['64Kbps MP3', 'VBR MP3', '128Kbps MP3', 'MP3'];

function pickAudioFiles(files: IaFile[]): IaFile[] {
  for (const format of AUDIO_FORMATS) {
    const hits = files.filter((f) => f.format === format);
    if (hits.length > 0) {
      const trackNo = (f: IaFile) => Number.parseInt(f.track ?? '', 10);
      const collator = new Intl.Collator(undefined, { numeric: true });
      return hits.sort((a, b) => {
        const ta = trackNo(a);
        const tb = trackNo(b);
        if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
        return collator.compare(a.name, b.name);
      });
    }
  }
  return [];
}

function pickCover(files: IaFile[]): IaFile | undefined {
  return files
    .filter((f) => f.format === 'JPEG' || f.format === 'PNG')
    .filter((f) => !/(_thumb|spectrogram|__ia_thumb)/i.test(f.name))
    .sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0))[0];
}

const fileUrl = (id: string, name: string) =>
  `https://archive.org/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`;

export async function runArchiveImport(importId: number, identifier: string): Promise<void> {
  const meta = await getJson<IaMetadata>(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
  const files = meta.files ?? [];
  const audio = pickAudioFiles(files);
  if (audio.length === 0) throw new Error('No MP3 files found for this book');

  const m = meta.metadata ?? {};
  const author = stripHtml(joined(m.creator)) || 'Unknown';
  const title = cleanTitle(stripHtml(first(m.title)) || identifier, author);
  const work = path.join(config.libraryDir, '.incoming', `archive-${identifier}`);
  await fs.mkdir(work, { recursive: true });

  const totalBytes = audio.reduce((sum, f) => sum + Number(f.size ?? 0), 0) || audio.length;
  let doneBytes = 0;
  const pad = String(audio.length).length;
  for (let i = 0; i < audio.length; i++) {
    const f = audio[i];
    const file = path.join(work, `${String(i + 1).padStart(pad, '0')}.mp3`);
    const exists = await fs.stat(file).then(
      () => true,
      () => false,
    );
    if (!exists) await download(fileUrl(identifier, f.name), file);
    doneBytes += Number(f.size ?? 0) || 1;
    updateImport(importId, { progress: Math.min(0.99, doneBytes / totalBytes) });
  }

  const cover = pickCover(files);
  const coverSrc = cover ? fileUrl(identifier, cover.name) : `https://archive.org/services/img/${encodeURIComponent(identifier)}`;
  const coverExt = cover?.format === 'PNG' ? '.png' : '.jpg';
  await download(coverSrc, path.join(work, `cover${coverExt}`), 2).catch(() => undefined);

  const description = first(m.description);
  const reader = readerFrom(description, author);
  const metadata: BookMetadataFile = {
    title,
    author,
    narrator: reader,
    description: cleanDescription(description, author),
    source: SOURCE,
    sourceId: identifier,
    trackTitles: audio.map((f, i) => stripHtml(f.title ?? '') || `Part ${i + 1}`),
  };
  await fs.writeFile(path.join(work, 'metadata.json'), JSON.stringify(metadata, null, 2));

  const finalDir = path.join(config.libraryDir, 'LibriVox', safeName(`${author} - ${title}`));
  await moveIntoLibrary(work, finalDir);

  const bookId = await scanSingleDir(finalDir);
  updateImport(importId, { status: 'done', progress: 1, book_id: bookId });
}
