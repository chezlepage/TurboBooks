/**
 * Claude's part of ebook → audiobook: it never rewrites the book. It returns small notes
 * per chapter (what to skip, how to pronounce things, who speaks each quote) and, for
 * multi-voice books, a cast list. Requests go through the Message Batches API (50% off).
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Chapter } from './epubText.js';

export const MODEL = 'claude-opus-5-5';
/** Opus 5.5 list price per million tokens; batches bill at half. */
const PRICE_IN = 4;
const PRICE_OUT = 20;
const BATCH_DISCOUNT = 0.5;

export const costUsd = (
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null },
  batch = true,
) =>
  ((usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1) * PRICE_IN +
    usage.output_tokens * PRICE_OUT) /
  1e6 *
  (batch ? BATCH_DISCOUNT : 1);

// ---------------------------------------------------------------------------
// Segmentation: paragraphs → narration and numbered quotes, done on our side so
// Claude only has to name speakers, never reproduce text.
// ---------------------------------------------------------------------------

export interface Segment {
  kind: 'narration' | 'quote';
  text: string;
  /** Book-wide quote id (quotes only). */
  q?: number;
}
export interface SegChapter {
  index: number;
  title: string;
  paragraphs: Segment[][];
}

const QUOTE_PAIRS: [string, string][] = [
  ['“', '”'], // “ ”
  ['"', '"'],
];

function splitQuotes(text: string, nextQ: () => number): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let buf = '';
  while (i < text.length) {
    const pair = QUOTE_PAIRS.find(([open]) => text.startsWith(open, i));
    if (pair) {
      const close = text.indexOf(pair[1], i + 1);
      // An opening quote with no close in this paragraph runs to its end (multi-paragraph speech).
      const end = close === -1 ? text.length : close + 1;
      if (buf.trim()) out.push({ kind: 'narration', text: buf.trim() });
      buf = '';
      const quoted = text.slice(i, end).trim();
      if (quoted.replace(/["“”]/g, '').trim()) out.push({ kind: 'quote', text: quoted, q: nextQ() });
      i = end;
      continue;
    }
    buf += text[i];
    i++;
  }
  if (buf.trim()) out.push({ kind: 'narration', text: buf.trim() });
  return out;
}

export function segment(chapters: Chapter[]): { chapters: SegChapter[]; quotes: number } {
  let q = 0;
  const nextQ = () => ++q;
  return {
    chapters: chapters.map((c) => ({ index: c.index, title: c.title, paragraphs: c.paragraphs.map((p) => splitQuotes(p, nextQ)) })),
    quotes: q,
  };
}

// ---------------------------------------------------------------------------
// Prompts and schemas
// ---------------------------------------------------------------------------

export interface CastMember {
  name: string;
  aliases: string[];
  gender: 'female' | 'male' | 'unknown';
  age: 'child' | 'adult' | 'elderly' | 'unknown';
}
export interface ChapterNotes {
  skip: boolean;
  skip_paragraphs: number[];
  speakers: { q: number; speaker: string }[];
  pronounce: { text: string; say: string }[];
}

const CAST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['characters'],
  properties: {
    characters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'aliases', 'gender', 'age'],
        properties: {
          name: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
          gender: { type: 'string', enum: ['female', 'male', 'unknown'] },
          age: { type: 'string', enum: ['child', 'adult', 'elderly', 'unknown'] },
        },
      },
    },
  },
} as const;

const NOTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['skip', 'skip_paragraphs', 'speakers', 'pronounce'],
  properties: {
    skip: { type: 'boolean' },
    skip_paragraphs: { type: 'array', items: { type: 'integer' } },
    speakers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['q', 'speaker'],
        properties: { q: { type: 'integer' }, speaker: { type: 'string' } },
      },
    },
    pronounce: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'say'],
        properties: { text: { type: 'string' }, say: { type: 'string' } },
      },
    },
  },
} as const;

const SYSTEM_NOTES = `You prepare book chapters to be read aloud by a text-to-speech engine for an audiobook.
You never rewrite or repeat the book's text; you only return short notes as JSON.

The chapter arrives as numbered paragraphs like [p12]. Quoted speech is wrapped as ⟦q34⟧…⟦/q34⟧.

Return:
- skip: true only if the whole chunk is not part of the story to be narrated: tables of contents, lists of illustrations, indexes, publisher/transcriber notes, copyright or license text. A preface, dedication or introduction written by the author is NOT skipped.
- skip_paragraphs: numbers of individual paragraphs that make no sense read aloud: page numbers, "[Illustration]" markers, footnote reference lists, decorative separators, stage-direction tables that are pure layout.
- speakers: only when a cast list is provided. For every quote id, who says it, using the exact name from the cast list; "narrator" for lines spoken by a first-person narrator and for quoted text that is not speech (titles, signs, letters read by the narrator); "minor_female" / "minor_male" for one-off characters not in the cast; "unknown" if it truly can't be told. Use the surrounding narration and turn-taking in unattributed back-and-forth dialogue.
- pronounce: things a speech engine will misread, with what to say instead: abbreviations ("Mr." is fine, but "&c." → "et cetera", "Dr" in a street name → "Drive"), Roman numerals used as numbers ("Chapter IV" → "Chapter Four", "Henry VIII" → "Henry the Eighth"), unusual names or foreign words with a plain phonetic respelling, dates and money in old formats ("£5 10s." → "five pounds ten shillings"). Only include items that actually appear in this chunk; keep the list short and skip anything an English speech engine handles well.`;

const SYSTEM_CAST = `You read a whole book and list the characters who speak, so each can be given a distinct voice in an audiobook.
Return only characters who have quoted dialogue. Merge every way the text refers to the same person into one entry: the canonical name plus aliases (titles, nicknames, surnames, "the Doctor"). Give gender and rough age from the text; use "unknown" when the text doesn't say. Limit to the 24 most talkative characters, most talkative first.
If the book is told in the first person, do NOT list the narrator: their spoken lines are read in the narrator's voice.`;

const render = (ch: SegChapter, from: number, to: number) =>
  ch.paragraphs
    .slice(from, to)
    .map((segs, k) => `[p${from + k}] ${segs.map((s) => (s.kind === 'quote' ? `⟦q${s.q}⟧${s.text}⟦/q${s.q}⟧` : s.text)).join(' ')}`)
    .join('\n');

/** Splits long chapters so each request stays a comfortable size (~12k words). */
export function chunkChapter(ch: SegChapter, maxWords = 12_000): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  let words = 0;
  ch.paragraphs.forEach((segs, i) => {
    words += segs.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
    if (words >= maxWords && i + 1 < ch.paragraphs.length) {
      ranges.push([start, i + 1]);
      start = i + 1;
      words = 0;
    }
  });
  ranges.push([start, ch.paragraphs.length]);
  return ranges;
}

type BatchRequest = Anthropic.Messages.Batches.BatchCreateParams.Request;

export function castRequest(chapters: SegChapter[], title: string): BatchRequest {
  const text = chapters.map((c) => `## ${c.title}\n${render(c, 0, c.paragraphs.length)}`).join('\n\n');
  return {
    custom_id: 'cast',
    params: {
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_CAST,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: CAST_SCHEMA } },
      messages: [{ role: 'user', content: `Book: ${title}\n\n${text}` }],
    } as BatchRequest['params'],
  };
}

export function notesRequests(chapters: SegChapter[], title: string, cast: CastMember[] | null): BatchRequest[] {
  const castText = cast
    ? `Cast list (use these exact names):\n${cast.map((c) => `- ${c.name}${c.aliases.length ? ` (also: ${c.aliases.join(', ')})` : ''}`).join('\n')}\n\n`
    : 'No cast list: return an empty speakers array.\n\n';
  const reqs: BatchRequest[] = [];
  for (const ch of chapters) {
    for (const [from, to] of chunkChapter(ch)) {
      reqs.push({
        custom_id: `ch${ch.index}_${from}`,
        params: {
          model: MODEL,
          max_tokens: 32000,
          // The instructions are the same for every chunk: cache them.
          system: [{ type: 'text', text: SYSTEM_NOTES, cache_control: { type: 'ephemeral' } }],
          output_config: { effort: cast ? 'medium' : 'low', format: { type: 'json_schema', schema: NOTES_SCHEMA } },
          messages: [
            {
              role: 'user',
              content: `Book: ${title}\nChapter: ${ch.title}\n\n${castText}${render(ch, from, to)}`,
            },
          ],
        } as BatchRequest['params'],
      });
    }
  }
  return reqs;
}

/** Rough cost range for the confirmation screen (Opus 5.5 batch pricing). */
export function estimate(chapters: SegChapter[], quotes: number, multiVoice: boolean) {
  const words = chapters.reduce((n, c) => n + c.paragraphs.flat().reduce((m, s) => m + s.text.split(/\s+/).length, 0), 0);
  const bookTokens = Math.round(words * 1.45); // words → tokens, incl. markup
  const chunks = chapters.reduce((n, c) => n + chunkChapter(c).length, 0);
  const inTok = bookTokens + chunks * 1200 + (multiVoice ? bookTokens + chunks * 400 : 0);
  const outLow = chunks * (multiVoice ? 2500 : 700) + (multiVoice ? quotes * 10 + 3000 : 0);
  const outHigh = outLow * 2.5;
  const price = (o: number) => ((inTok * PRICE_IN + o * PRICE_OUT) / 1e6) * BATCH_DISCOUNT;
  return {
    words,
    chapters: chapters.length,
    quotes,
    audioHours: Math.round((words / 155 / 60) * 10) / 10, // ~155 spoken words per minute
    costLow: Math.round(price(outLow) * 100) / 100,
    costHigh: Math.round(price(outHigh) * 100) / 100,
  };
}

/** Reads the JSON a batch result returned; null when it was refused, cut off or unparseable. */
export function parseResult<T>(message: Anthropic.Message): T | null {
  if (message.stop_reason !== 'end_turn') return null;
  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
