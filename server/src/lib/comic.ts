/**
 * Comics, manga and webtoons: .cbz (a zip of images) and .cbr (a rar of images). They live in
 * the library as ebooks; the file extension says they're comics.
 *
 * Pages are the archive's images in natural name order ("page 2" before "page 10"). CBZ pages
 * are read straight out of the zip by offset; CBR pages are unpacked once into a cache folder
 * under names we make up (page numbers), never the archive's own paths. Archives come from
 * downloads, so sizes and counts are capped, and images are only served as a type we
 * recognised from their first bytes.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Inflate } from 'fflate';
import { createExtractorFromData } from 'node-unrar-js';
import { config } from '../config.js';
import type { EpubMeta } from './epub.js';

export const COMIC_EXTENSIONS = new Set(['.cbz', '.cbr']);
export const isComicPath = (p: string) => COMIC_EXTENSIONS.has(path.extname(p).toLowerCase());

const MAX_PAGES = 5000;
const MAX_PAGE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const IMAGE_NAME = /\.(jpe?g|png|webp|gif|avif)$/i;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const isPageName = (name: string) =>
  IMAGE_NAME.test(name) && !name.split(/[\\/]/).some((part) => part === '__MACOSX' || part.startsWith('.'));

// ---------------------------------------------------------------------------
// Images: what they are (from their bytes) and how big
// ---------------------------------------------------------------------------

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/avif';

export function sniffImage(b: Uint8Array): ImageType | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp' && /avi[fs]/.test(ascii(8, 12))) return 'image/avif';
  return null;
}

/** Width × height from the image header (0×0 if it can't be read). */
export function imageSize(b: Uint8Array, type: ImageType): [number, number] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (type === 'image/png') return [dv.getUint32(16), dv.getUint32(20)];
    if (type === 'image/gif') return [dv.getUint16(6, true), dv.getUint16(8, true)];
    if (type === 'image/webp') {
      const chunk = String.fromCharCode(...b.subarray(12, 16));
      if (chunk === 'VP8 ') return [dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff];
      if (chunk === 'VP8L') {
        const bits = dv.getUint32(21, true);
        return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
      }
      if (chunk === 'VP8X') return [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))];
    }
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = b[i + 1];
        // Start-of-frame markers (not DHT/JPG/DAC) carry the size.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return [dv.getUint16(i + 7), dv.getUint16(i + 5)];
        }
        i += 2 + dv.getUint16(i + 2);
      }
    }
    if (type === 'image/avif') {
      const at = Buffer.from(b.buffer, b.byteOffset, Math.min(b.byteLength, 4096)).indexOf('ispe');
      if (at > 0) return [dv.getUint32(at + 8), dv.getUint32(at + 12)];
    }
  } catch {
    /* truncated header */
  }
  return [0, 0];
}

// ---------------------------------------------------------------------------
// CBZ: read the zip's central directory, then single entries by offset
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

async function zipEntries(file: string): Promise<ZipEntry[]> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('Not a zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('This comic is too big to open (zip64)');
    if (count > MAX_PAGES * 2) throw new Error('Too many files in this comic');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8);
      const nameLen = cd.readUInt16LE(p + 28);
      const raw = cd.subarray(p + 46, p + 46 + nameLen);
      out.push({
        name: flags & 0x800 ? raw.toString('utf8') : raw.toString('latin1'),
        method: cd.readUInt16LE(p + 10),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        localOffset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Inflates, refusing to produce more than `limit` bytes (zip bombs). */
function inflateCapped(data: Uint8Array, limit: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inf = new Inflate((chunk) => {
    total += chunk.length;
    if (total > limit) throw new Error('A page in this comic is too big');
    chunks.push(chunk);
  });
  // Small input pieces, so a bomb is stopped after a few MB of output (deflate expands ≤ ~1000×).
  const STEP = 4096;
  for (let i = 0; i < data.length; i += STEP) inf.push(data.subarray(i, i + STEP), i + STEP >= data.length);
  if (data.length === 0) inf.push(data, true);
  return Buffer.concat(chunks);
}

async function zipRead(file: string, e: ZipEntry): Promise<Uint8Array> {
  if (e.size > MAX_PAGE_BYTES || e.compressedSize > MAX_PAGE_BYTES) throw new Error('A page in this comic is too big');
  const fh = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, e.localOffset);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('Damaged comic file');
    const start = e.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const data = Buffer.alloc(e.compressedSize);
    await fh.read(data, 0, e.compressedSize, start);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateCapped(data, Math.min(MAX_PAGE_BYTES, Math.max(e.size, 1)));
    throw new Error('This comic uses a zip compression we can’t read');
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// CBR: unpack once into a cache folder, pages named by number
// ---------------------------------------------------------------------------

async function rarExtractor(file: string) {
  const data = await fs.readFile(file);
  return createExtractorFromData({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer });
}

async function rarPageNames(file: string): Promise<string[]> {
  const ex = await rarExtractor(file);
  const names = [...ex.getFileList().fileHeaders]
    .filter((h) => !h.flags.directory && !h.flags.encrypted && isPageName(h.name))
    .map((h) => h.name);
  if (names.length > MAX_PAGES) throw new Error('Too many pages in this comic');
  return names.sort(collator.compare);
}

/** Unpacks every page of a .cbr into `dir` as 0000.img, 0001.img… (in reading order). */
async function unpackRar(file: string, dir: string): Promise<number> {
  const order = await rarPageNames(file);
  const index = new Map(order.map((n, i) => [n, i]));
  const ex = await rarExtractor(file);
  let total = 0;
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const { files } = ex.extract({
    files: (h) => {
      if (!index.has(h.name)) return false;
      if (h.unpSize > MAX_PAGE_BYTES) throw new Error('A page in this comic is too big');
      total += h.unpSize;
      if (total > MAX_TOTAL_BYTES) throw new Error('This comic is too big to open');
      return true;
    },
  });
  for (const f of files) {
    const i = index.get(f.fileHeader.name);
    if (i === undefined || !f.extraction) continue;
    await fs.writeFile(path.join(dir, `${String(i).padStart(4, '0')}.img`), f.extraction);
  }
  return order.length;
}

// ---------------------------------------------------------------------------
// ComicInfo.xml (the common metadata file inside comic archives)
// ---------------------------------------------------------------------------

interface ComicInfo {
  title?: string;
  series?: string;
  number?: string;
  volume?: string;
  writer?: string;
  summary?: string;
  manga?: string;
  language?: string;
}

function parseComicInfo(xml: string): ComicInfo {
  const tag = (name: string) => {
    const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))?.[1];
    return m
      ?.replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .trim() || undefined;
  };
  return {
    title: tag('Title'),
    series: tag('Series'),
    number: tag('Number'),
    volume: tag('Volume'),
    writer: tag('Writer'),
    summary: tag('Summary'),
    manga: tag('Manga'),
    language: tag('LanguageISO'),
  };
}

function displayTitle(info: ComicInfo): string | undefined {
  if (!info.series) return info.title;
  const parts = [info.series, info.volume ? `Vol. ${info.volume}` : null, info.number ? `#${info.number}` : null].filter(Boolean).join(' ');
  return info.title && info.title !== info.series ? `${parts}: ${info.title}` : parts;
}

// ---------------------------------------------------------------------------
// Opening a comic (cached per file version)
// ---------------------------------------------------------------------------

export interface ComicIndex {
  /** Changes when the file does. */
  version: string;
  pages: { type: ImageType | null; w: number; h: number }[];
  /** Manga reads right to left. */
  direction: 'ltr' | 'rtl';
  /** Webtoons are tall strips read by scrolling. */
  layout: 'paged' | 'webtoon';
}

interface Opened extends ComicIndex {
  read: (n: number) => Promise<Uint8Array>;
}

const cacheDir = (version: string) => path.join(config.dataDir, 'comics', version);
const opened = new Map<string, Promise<Opened>>();

async function versionOf(file: string): Promise<string> {
  const st = await fs.stat(file);
  return createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
}

async function load(file: string, version: string): Promise<Opened> {
  let read: (n: number) => Promise<Uint8Array>;
  let count: number;
  let info: ComicInfo = {};
  if (path.extname(file).toLowerCase() === '.cbz') {
    const entries = await zipEntries(file);
    const pages = entries.filter((e) => isPageName(e.name)).sort((a, b) => collator.compare(a.name, b.name));
    if (pages.length > MAX_PAGES) throw new Error('Too many pages in this comic');
    if (pages.reduce((n, e) => n + e.size, 0) > MAX_TOTAL_BYTES) throw new Error('This comic is too big to open');
    const ci = entries.find((e) => /(^|\/)comicinfo\.xml$/i.test(e.name));
    if (ci && ci.size < 1_000_000) info = parseComicInfo(Buffer.from(await zipRead(file, ci)).toString('utf8'));
    count = pages.length;
    read = (n) => zipRead(file, pages[n]);
  } else {
    const dir = cacheDir(version);
    const done = path.join(dir, 'pages.json');
    try {
      count = (JSON.parse(await fs.readFile(done, 'utf8')) as { count: number }).count;
    } catch {
      count = await unpackRar(file, dir);
      await fs.writeFile(done, JSON.stringify({ count }));
    }
    read = (n) => fs.readFile(path.join(dir, `${String(n).padStart(4, '0')}.img`));
  }
  if (count === 0) throw new Error('No pages found in this comic');

  // Page sizes (for steady scrolling and the webtoon guess), kept next to the cache.
  const sizesFile = path.join(config.dataDir, 'comics', `${version}.json`);
  let pages: ComicIndex['pages'];
  try {
    pages = JSON.parse(await fs.readFile(sizesFile, 'utf8')) as ComicIndex['pages'];
    if (pages.length !== count) throw new Error('stale');
  } catch {
    pages = [];
    for (let n = 0; n < count; n++) {
      // One broken or oversized page shouldn't stop the rest of the comic opening.
      const b = await read(n).catch(() => null);
      const type = b ? sniffImage(b) : null;
      const [w, h] = b && type ? imageSize(b, type) : [0, 0];
      pages.push({ type, w, h });
    }
    await fs.mkdir(path.dirname(sizesFile), { recursive: true });
    await fs.writeFile(sizesFile, JSON.stringify(pages));
  }
  const ratios = pages.filter((p) => p.w > 0).map((p) => p.h / p.w).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)] ?? 1.5;
  return {
    version,
    pages,
    direction: /righttoleft/i.test(info.manga ?? '') ? 'rtl' : 'ltr',
    layout: median > 2.2 ? 'webtoon' : 'paged',
    read,
  };
}

export async function openComic(file: string): Promise<Opened> {
  const version = await versionOf(file);
  let p = opened.get(version);
  if (!p) {
    p = load(file, version);
    opened.set(version, p);
    p.catch(() => opened.delete(version));
    if (opened.size > 8) opened.delete(opened.keys().next().value!);
  }
  return p;
}

/** One page's image, only if it really is an image type we serve. */
export async function comicPage(file: string, n: number): Promise<{ data: Uint8Array; type: ImageType } | null> {
  const comic = await openComic(file);
  if (!Number.isInteger(n) || n < 0 || n >= comic.pages.length) return null;
  const data = await comic.read(n);
  const type = sniffImage(data);
  return type ? { data, type } : null;
}

// ---------------------------------------------------------------------------
// Scanning: title, author and a cover, without unpacking the whole thing
// ---------------------------------------------------------------------------

/** A cover from the first page: 600px wide, cropped to book shape from the top (webtoon strips are tall). */
function coverFrom(image: Uint8Array): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const ff = spawn(config.ffmpegPath, [
      '-v', 'error', '-i', 'pipe:0', '-frames:v', '1',
      '-vf', "scale=600:-2,crop=600:'min(ih,900)':0:0", '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1',
    ]);
    const out: Buffer[] = [];
    ff.stdout.on('data', (d: Buffer) => out.push(d));
    ff.on('error', () => resolve(null));
    ff.on('close', (code) => resolve(code === 0 && out.length ? Buffer.concat(out) : null));
    ff.stdin.on('error', () => undefined);
    ff.stdin.end(image);
  });
}

export async function readComicMeta(file: string): Promise<EpubMeta> {
  let info: ComicInfo = {};
  let first: Uint8Array | null = null;
  if (path.extname(file).toLowerCase() === '.cbz') {
    const entries = await zipEntries(file);
    const ci = entries.find((e) => /(^|\/)comicinfo\.xml$/i.test(e.name));
    if (ci && ci.size < 1_000_000) info = parseComicInfo(Buffer.from(await zipRead(file, ci)).toString('utf8'));
    const page = entries.filter((e) => isPageName(e.name)).sort((a, b) => collator.compare(a.name, b.name))[0];
    if (page) first = await zipRead(file, page);
  } else {
    const names = await rarPageNames(file);
    const ex = await rarExtractor(file);
    const all = [...ex.getFileList().fileHeaders].filter((h) => !h.flags.directory);
    const ciName = all.find((h) => /(^|[\\/])comicinfo\.xml$/i.test(h.name) && h.unpSize < 1_000_000)?.name;
    const wanted = [names[0], ciName].filter((n): n is string => !!n);
    const sizes = new Map(all.map((h) => [h.name, h.unpSize]));
    if (wanted.every((n) => (sizes.get(n) ?? 0) <= MAX_PAGE_BYTES)) {
      for (const f of (await rarExtractor(file)).extract({ files: wanted }).files) {
        if (!f.extraction) continue;
        if (f.fileHeader.name === names[0]) first = f.extraction;
        else info = parseComicInfo(Buffer.from(f.extraction).toString('utf8'));
      }
    }
  }
  const cover = first && sniffImage(first) ? await coverFrom(first) : null;
  return {
    title: displayTitle(info),
    author: info.writer,
    description: info.summary,
    language: info.language,
    cover: cover ? { data: cover, ext: '.jpg' } : undefined,
  };
}
