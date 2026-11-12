/** Reads title/author/description/cover from an EPUB's package (OPF) file. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

export interface EpubMeta {
  title?: string;
  author?: string;
  description?: string;
  language?: string;
  cover?: { data: Uint8Array; ext: string };
}

const decodeEntities = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const stripTags = (s: string) =>
  decodeEntities(s.replace(/<[^>]*>/g, ' '))
    .replace(/<[^>]*>/g, ' ') // descriptions are often escaped HTML
    .replace(/\s+/g, ' ')
    .trim();

function tagText(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:dc:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:dc:)?${tag}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => stripTags(m[1])).filter(Boolean);
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

/** "Stoker, Bram" -> "Bram Stoker" (only for the simple one-comma form). */
export function displayName(name: string): string {
  const cleaned = name.replace(/,?\s*\d{3,4}\??-\d{0,4}\??$/, '').trim();
  const parts = cleaned.split(',').map((p) => p.trim());
  return parts.length === 2 && parts[0] && parts[1] && !/\s(jr|sr)\.?$/i.test(parts[1]) ? `${parts[1]} ${parts[0]}` : cleaned;
}

const IMAGE_EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

export async function readEpubMeta(file: string): Promise<EpubMeta> {
  const buf = new Uint8Array(await fs.readFile(file));
  const containerZip = unzipSync(buf, { filter: (f) => f.name === 'META-INF/container.xml' });
  const container = containerZip['META-INF/container.xml'];
  if (!container) throw new Error('not an EPUB (no META-INF/container.xml)');
  const opfPath = strFromU8(container).match(/full-path\s*=\s*"([^"]+)"/)?.[1];
  if (!opfPath) throw new Error('EPUB container has no package file');

  const opfZip = unzipSync(buf, { filter: (f) => f.name === opfPath });
  const opfBytes = opfZip[opfPath];
  if (!opfBytes) throw new Error('EPUB package file missing');
  const opf = strFromU8(opfBytes);

  const meta: EpubMeta = {
    title: tagText(opf, 'title')[0],
    author: tagText(opf, 'creator').map(displayName).join(', ') || undefined,
    description: tagText(opf, 'description')[0],
    language: tagText(opf, 'language')[0],
  };

  // Cover: EPUB3 properties="cover-image", else EPUB2 <meta name="cover" content="id">, else an image named like "cover".
  const items = [...opf.matchAll(/<item\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const coverId = [...opf.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0])).find((a) => a.name === 'cover')?.content;
  const isImage = (i: Record<string, string>) => (i['media-type'] ?? '') in IMAGE_EXT;
  const coverItem =
    items.find((i) => (i.properties ?? '').split(/\s+/).includes('cover-image')) ??
    items.find((i) => i.id === coverId && isImage(i)) ??
    items.find((i) => isImage(i) && /cover/i.test(`${i.id} ${i.href}`));
  if (coverItem?.href) {
    const href = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(coverItem.href)));
    const coverZip = unzipSync(buf, { filter: (f) => f.name === href });
    const data = coverZip[href];
    if (data && data.length > 0) meta.cover = { data, ext: IMAGE_EXT[coverItem['media-type']] ?? path.extname(href) };
  }
  return meta;
}
