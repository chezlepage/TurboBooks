/**
 * Discover + import free ebooks from Project Gutenberg using its official
 * OPDS catalog (Atom XML; fast, sorted by popularity) and EPUB downloads.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { SearchResult } from './archive.js';
import { USER_AGENT, download, libraryState, moveIntoLibrary, safeName, updateImport } from './download.js';
import { displayName } from './epub.js';
import { scanSingleDir } from './scanner.js';

export const SOURCE = 'gutenberg';
const BASE = 'https://www.gutenberg.org';
const PAGE_SIZE = 25;

export const isValidGutenbergId = (id: string) => /^\d{1,7}$/.test(id);

/** Values are Gutenberg search terms; "s." searches subjects. */
export const CATEGORIES: Record<string, { label: string; query?: string }> = {
  popular: { label: 'Popular' },
  bedtime: { label: 'Bedtime & children', query: 's.children' },
  short: { label: 'Short stories', query: 's.short stories' },
  mystery: { label: 'Mystery', query: 's.detective' },
  adventure: { label: 'Adventure', query: 's.adventure' },
  fantasy: { label: 'Fantasy', query: 's.fantasy' },
  scifi: { label: 'Sci-fi', query: 's.science fiction' },
  humor: { label: 'Humor', query: 's.humor' },
  horror: { label: 'Spooky', query: 's.ghost' },
  romance: { label: 'Romance', query: 's.love stories' },
};

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

const text = (s: string) => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Gutenberg titles often carry a subtitle after a semicolon or newline. */
const shortTitle = (t: string) => t.split(/\r?\n|;\s/)[0].trim();

const titleKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Project Gutenberg returned ${res.status}`);
  return res.text();
}

const cache = new Map<string, { at: number; xml: string }>();
const CACHE_MS = 60 * 60 * 1000;

async function feed(url: string): Promise<string> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.xml;
  const xml = await getText(url);
  cache.set(url, { at: Date.now(), xml });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return xml;
}

export async function search(opts: { text?: string; category?: string; english?: boolean; page?: number }) {
  const terms: string[] = [];
  if (opts.text) terms.push(opts.text.replace(/[^\p{L}\p{N}\s'.-]/gu, ' ').trim().slice(0, 100));
  else if (opts.category && CATEGORIES[opts.category]?.query) terms.push(CATEGORIES[opts.category].query!);
  if (opts.english !== false) terms.push('l.en');

  const url = new URL(`${BASE}/ebooks/search.opds/`);
  if (terms.length) url.searchParams.set('query', terms.join(' '));
  url.searchParams.set('sort_order', 'downloads');
  const page = Math.max(0, opts.page ?? 0);
  if (page > 0) url.searchParams.set('start_index', String(page * PAGE_SIZE + 1));

  const xml = await feed(url.toString());
  const { bookIds, imports } = libraryState(SOURCE);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = entry.match(/<id>[^<]*\/ebooks\/(\d+)\.opds<\/id>/)?.[1];
    if (!id) continue; // "N subjects match" style entries
    const title = shortTitle(text(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''));
    const author = text(entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? '') || 'Unknown';
    const key = `${titleKey(title)}|${author.toLowerCase()}`;
    if (seen.has(key) && !bookIds.has(id)) continue; // same book in several editions; first is most popular
    seen.add(key);
    results.push({
      id,
      title,
      author,
      description: '',
      language: '',
      duration: '',
      durationSecs: 0,
      coverUrl: `${BASE}/cache/epub/${id}/pg${id}.cover.medium.jpg`,
      sourceUrl: `${BASE}/ebooks/${id}`,
      bookId: bookIds.get(id) ?? null,
      importStatus: imports.get(id) ?? null,
      kind: 'ebook',
    });
  }
  return { results, hasMore: /rel="next"/.test(xml) };
}

/** Title, author and summary from a book's own catalog page. */
async function bookInfo(id: string) {
  const xml = await getText(`${BASE}/ebooks/${id}.opds`);
  const content = xml.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? '';
  const field = (name: string) => {
    const m = content.match(new RegExp(`<p>\\s*${name}:\\s*([\\s\\S]*?)</p>`, 'i'));
    return m ? text(m[1]) : undefined;
  };
  const title = field('Title') ?? text(xml.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
  const authorRaw = field('Author');
  const summary = field('Summary')?.replace(/\s*\(This is an automatically generated summary\.\)\s*$/i, '');
  return { title: shortTitle(title), author: authorRaw ? displayName(authorRaw) : undefined, summary };
}

export async function runGutenbergImport(importId: number, id: string): Promise<void> {
  const info = await bookInfo(id).catch(() => ({ title: undefined, author: undefined, summary: undefined }));
  const work = path.join(config.libraryDir, '.incoming', `gutenberg-${id}`);
  await fs.mkdir(work, { recursive: true });
  // epub3.images is the modern EPUB with illustrations; fall back to the plain one.
  await download(`${BASE}/ebooks/${id}.epub3.images`, path.join(work, 'book.epub'), 2).catch(() =>
    download(`${BASE}/ebooks/${id}.epub.noimages`, path.join(work, 'book.epub')),
  );
  updateImport(importId, { progress: 0.9 });

  await fs.writeFile(
    path.join(work, 'metadata.ebook.json'),
    JSON.stringify({ title: info.title, author: info.author, description: info.summary, source: SOURCE, sourceId: id }, null, 2),
  );
  const finalDir = path.join(config.libraryDir, 'Ebooks', safeName(`${info.author ?? 'Unknown'} - ${info.title ?? id}`));
  await moveIntoLibrary(work, finalDir);
  const bookId = await scanSingleDir(path.join(finalDir, 'book.epub'));
  updateImport(importId, { status: 'done', progress: 1, book_id: bookId });
}
