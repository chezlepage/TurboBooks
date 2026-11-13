/**
 * Discover → Comics: a hand-picked shelf of public-domain comics, scanned by libraries and
 * collectors on the Internet Archive.
 *
 * Hand-picked on purpose. The Archive's own "public domain" labels and dates are set by
 * uploaders and are often wrong for comics (modern series marked public domain, a 1990s comic
 * dated 1930), so a search there can't be trusted. Everything here was first published in
 * 1930 or earlier, which puts it in the US public domain as of 2026, and each item was checked
 * to be a scan of that work, not a modern reprint edition.
 *
 * Import builds a CBZ from the item's page images (the Archive serves every scanned page as a
 * JPEG), so it opens in the comic reader like any other comic.
 */
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Zip, ZipPassThrough } from 'fflate';
import { config } from '../config.js';
import type { SearchResult } from './archive.js';
import { sniffImage } from './comic.js';
import { USER_AGENT, libraryState, moveIntoLibrary, safeName, updateImport } from './download.js';
import { scanSingleDir } from './scanner.js';

export const SOURCE = 'pdcomics';
const ARCHIVE = 'https://archive.org';
/**
 * Asked-for page width. The Archive rounds up to its own scaling steps, so pages come back
 * 1200-2400px wide: sharp on tablets, under ~1 MB a page (asking for more doubles the size).
 */
const PAGE_WIDTH = 1200;
const MAX_PAGES = 1200;

interface Comic {
  id: string;
  title: string;
  author: string;
  year: number;
  category: 'strips' | 'stories';
  language?: string;
  about: string;
}

/** Checked by hand: first published ≤ 1930, and the Archive item is a scan of that publication. */
const SHELF: Comic[] = [
  {
    id: 'LittleNemo1905-14FromWinsorMccayAsCbz',
    title: 'Little Nemo in Slumberland (1905–1914)',
    author: 'Winsor McCay',
    year: 1905,
    category: 'strips',
    about: "The complete first run of McCay's Sunday pages: every week a little boy's dream grows stranger and grander until he falls out of bed. Some of the most beautiful comics ever drawn.",
  },
  {
    id: 'DreamsOfTheRarebitFiend_201804',
    title: 'Dreams of the Rarebit Fiend',
    author: 'Winsor McCay',
    year: 1905,
    category: 'strips',
    about: 'Grown-up nightmares, one strip at a time: each dreamer blames the cheese they ate before bed. Funny, surreal, and drawn by the creator of Little Nemo.',
  },
  {
    id: 'BusterBrownhisd00Outc',
    title: 'Buster Brown, His Dog Tige and Their Troubles',
    author: 'R. F. Outcault',
    year: 1904,
    category: 'strips',
    about: 'The original prankster and his grinning dog, collected in book form. Every page ends with Buster’s “Resolved” — a promise to behave that never lasts.',
  },
  {
    id: 'BusterBrownnewspaperStrip-Year1903',
    title: 'Buster Brown: The 1903 Newspaper Strips',
    author: 'R. F. Outcault',
    year: 1903,
    category: 'strips',
    about: "Buster Brown's mischief from the strip's first year in the papers.",
  },
  {
    id: 'foxy-grandpa-flip-flaps',
    title: 'Foxy Grandpa Flip Flaps',
    author: 'Carl E. Schultze (“Bunny”)',
    year: 1905,
    category: 'strips',
    about: 'Two boys try to trick their grandfather and he outfoxes them every time. A Sunday-funnies favourite from the 1900s.',
  },
  {
    id: 'foxy-grandpa-shows-the-boys-up-to-date-sports',
    title: 'Foxy Grandpa Shows the Boys Up-to-Date Sports',
    author: 'Carl E. Schultze (“Bunny”)',
    year: 1908,
    category: 'strips',
    about: 'Foxy Grandpa takes on the sports of the day, and the boys, again.',
  },
  {
    id: 'BringingUpFatherSeries1',
    title: 'Bringing Up Father, Series 1',
    author: 'George McManus',
    year: 1919,
    category: 'strips',
    about: 'Jiggs won a fortune but just wants corned beef and his old pals; his wife Maggie wants high society and a rolling pin within reach. The first book collection of the famous strip.',
  },
  {
    id: 'barneygooglehisf0000debe_d8b9',
    title: 'Barney Google and His Faithful Nag Spark Plug',
    author: 'Billy DeBeck',
    year: 1923,
    category: 'strips',
    about: "Barney Google, the man with the goo-goo-googly eyes, and his hopeless racehorse Spark Plug, at the height of the strip's 1920s craze.",
  },
  {
    id: 'barneygooglespar0000debe',
    title: 'Barney Google & Spark Plug (1926)',
    author: 'Billy DeBeck',
    year: 1926,
    category: 'strips',
    about: 'More schemes, races and disasters with Barney and Spark Plug.',
  },
  {
    id: 'JoePalooka1930Dailies',
    title: 'Joe Palooka: The 1930 Dailies',
    author: 'Ham Fisher',
    year: 1930,
    category: 'strips',
    about: 'The big-hearted boxing champ in the daily strips of 1930.',
  },
  {
    id: 'ally-slopers-summer-number-for-1886',
    title: "Ally Sloper's Summer Number for 1886",
    author: 'Charles H. Ross & Marie Duval',
    year: 1886,
    category: 'strips',
    about: "A seaside special of Victorian Britain's comic magazine, starring the work-shy schemer Ally Sloper, one of the first recurring comic characters.",
  },
  {
    id: 'englishstruwwelp00hoffrich',
    title: 'The English Struwwelpeter',
    author: 'Heinrich Hoffmann',
    year: 1909,
    category: 'stories',
    about: 'Pretty stories and funny pictures: the famous (and famously grim) cautionary tales for children, told in pictures and rhyme.',
  },
  {
    id: 'maxundmoritz17161gut',
    title: 'Max und Moritz',
    author: 'Wilhelm Busch',
    year: 1865,
    category: 'stories',
    language: 'German',
    about: 'Two rascals and their seven pranks, in pictures and verse: the 1865 German classic that inspired the Katzenjammer Kids and early newspaper comics.',
  },
];

export const CATEGORIES: Record<string, { label: string }> = {
  all: { label: 'All' },
  strips: { label: 'Comic strips' },
  stories: { label: 'Picture stories' },
};

export const isValidId = (id: string) => SHELF.some((c) => c.id === id);

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export async function search(opts: { userId: number; text?: string; category?: string; english?: boolean; page?: number }) {
  const { bookIds, imports } = libraryState(SOURCE, opts.userId);
  const words = fold(opts.text ?? '').split(/\s+/).filter(Boolean);
  const hits = SHELF.filter((c) => {
    if (opts.english !== false && c.language && c.language !== 'English') return false;
    if (words.length) return words.every((w) => fold(`${c.title} ${c.author} ${c.about}`).includes(w));
    return !opts.category || opts.category === 'all' || c.category === opts.category;
  });
  const results: SearchResult[] = (opts.page ?? 0) > 0 ? [] : hits.map((c) => ({
    id: c.id,
    title: c.title,
    author: c.author,
    description: c.about,
    language: c.language ?? 'English',
    duration: '',
    durationSecs: 0,
    coverUrl: `${ARCHIVE}/services/img/${c.id}`,
    sourceUrl: `${ARCHIVE}/details/${c.id}`,
    bookId: bookIds.get(c.id) ?? null,
    importStatus: imports.get(c.id) ?? null,
    kind: 'comic',
  }));
  return { results, hasMore: false };
}

async function fetchOk(url: string, timeoutMs = 60_000): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`The Internet Archive returned ${res.status}`);
      return res;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

/** Number of scanned pages: the entries of the item's page-image zip. */
async function pageCount(id: string): Promise<number> {
  const meta = (await (await fetchOk(`${ARCHIVE}/metadata/${encodeURIComponent(id)}`)).json()) as { files?: { name: string }[] };
  const jp2 = meta.files?.find((f) => f.name.endsWith('_jp2.zip'))?.name;
  if (!jp2) throw new Error('This item has no page scans');
  const listing = await (await fetchOk(`${ARCHIVE}/download/${encodeURIComponent(id)}/${encodeURIComponent(jp2)}/`)).text();
  const pages = new Set(listing.match(/href="[^"]*\.jp2"/g) ?? []).size;
  if (pages === 0) throw new Error('This item has no page scans');
  return Math.min(pages, MAX_PAGES);
}

/** Writes a CBZ (pages stored as-is: they're already JPEGs) without holding the book in memory. */
function cbzWriter(file: string) {
  const out = createWriteStream(file);
  let failed: Error | null = null;
  const done = new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.on('finish', () => (failed ? reject(failed) : resolve()));
  });
  const zip = new Zip((err, chunk, final) => {
    if (err) failed = err;
    else out.write(chunk);
    if (final || err) out.end();
  });
  return {
    add(name: string, data: Uint8Array) {
      const entry = new ZipPassThrough(name);
      zip.add(entry);
      entry.push(data, true);
    },
    async finish() {
      zip.end();
      await done;
    },
  };
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function runImport(importId: number, id: string): Promise<void> {
  const comic = SHELF.find((c) => c.id === id);
  if (!comic) throw new Error('Not on the comics shelf');
  const count = await pageCount(id);
  const work = path.join(config.libraryDir, '.incoming', `pdcomics-${id}`);
  await fs.mkdir(work, { recursive: true });
  const file = path.join(work, `${safeName(comic.title)}.cbz`);
  const cbz = cbzWriter(file);
  cbz.add(
    'ComicInfo.xml',
    new TextEncoder().encode(
      `<?xml version="1.0"?><ComicInfo><Title>${xmlEscape(comic.title)}</Title><Writer>${xmlEscape(comic.author)}</Writer>` +
        `<Year>${comic.year}</Year><Summary>${xmlEscape(comic.about)}</Summary><Manga>No</Manga></ComicInfo>`,
    ),
  );
  for (let n = 0; n < count; n++) {
    const res = await fetchOk(`${ARCHIVE}/download/${encodeURIComponent(id)}/page/n${n}_w${PAGE_WIDTH}.jpg`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (sniffImage(data) !== 'image/jpeg') throw new Error(`Page ${n + 1} didn't download as an image`);
    cbz.add(`${String(n + 1).padStart(4, '0')}.jpg`, data);
    updateImport(importId, { progress: ((n + 1) / count) * 0.95 });
  }
  await cbz.finish();
  await fs.writeFile(
    path.join(work, 'metadata.ebook.json'),
    JSON.stringify({ title: comic.title, author: comic.author, description: comic.about, source: SOURCE, sourceId: id }, null, 2),
  );
  const finalDir = path.join(config.libraryDir, 'Comics', safeName(`${comic.author} - ${comic.title}`));
  await moveIntoLibrary(work, finalDir);
  const bookId = await scanSingleDir(path.join(finalDir, path.basename(file)));
  updateImport(importId, { status: 'done', progress: 1, book_id: bookId });
}
