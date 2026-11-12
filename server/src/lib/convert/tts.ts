/**
 * Kokoro text-to-speech (Kokoro-FastAPI container on the GPU). We ask for raw 24 kHz PCM,
 * stitch segments with short pauses, and encode one MP3 per chapter with ffmpeg.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { config } from '../../config.js';
import type { CastMember, ChapterNotes, SegChapter } from './annotate.js';

export const SAMPLE_RATE = 24_000;

export interface Voice {
  id: string;
  label: string;
  accent: 'US' | 'UK';
  gender: 'female' | 'male';
  featured: boolean;
}

const FEATURED = new Set(['af_heart', 'af_bella', 'af_nicole', 'bf_emma', 'am_michael', 'am_fenrir', 'bm_george', 'bm_fable']);
const NICE_NAMES: Record<string, string> = { af_heart: 'Heart', af_nicole: 'Nicole (soft)', bm_fable: 'Fable' };

/** English voices Kokoro offers, labelled for people. Older "v0" duplicates are left out. */
export function describeVoices(ids: string[]): Voice[] {
  return ids
    .filter((id) => /^(af|am|bf|bm)_/.test(id) && !/_v0/.test(id))
    .map((id) => {
      const name = id.split('_').slice(1).filter((p) => p !== 'inno').join(' ');
      return {
        id,
        label: NICE_NAMES[id] ?? name.charAt(0).toUpperCase() + name.slice(1),
        accent: id.startsWith('b') ? ('UK' as const) : ('US' as const),
        gender: id[1] === 'f' ? ('female' as const) : ('male' as const),
        featured: FEATURED.has(id),
      };
    })
    .sort((a, b) => Number(b.featured) - Number(a.featured) || a.accent.localeCompare(b.accent) || a.label.localeCompare(b.label));
}

let voiceCache: { at: number; voices: Voice[] } | null = null;

export async function listVoices(): Promise<Voice[]> {
  if (voiceCache && Date.now() - voiceCache.at < 10 * 60_000) return voiceCache.voices;
  const res = await fetch(`${config.kokoroUrl}/v1/audio/voices`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Kokoro returned ${res.status}`);
  const body = (await res.json()) as { voices: (string | { id: string })[] };
  const voices = describeVoices(body.voices.map((v) => (typeof v === 'string' ? v : v.id)));
  voiceCache = { at: Date.now(), voices };
  return voices;
}

export async function speak(text: string, voice: string, format: 'pcm' | 'mp3' = 'pcm'): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${config.kokoroUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'kokoro', input: text, voice, response_format: format, speed: 1.0 }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`Kokoro returned ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const silence = (ms: number) => Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000) * 2);

/** Keeps each TTS request to a few sentences: better prosody, and a failure costs little. */
function sentences(text: string, max = 500): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]+["'”’)]*\s*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) {
      out.push(cur.trim());
      cur = '';
    }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function applyPronunciations(text: string, pron: { text: string; say: string }[]): string {
  let out = text;
  for (const p of pron) {
    if (!p.text || p.text.length > 80) continue;
    out = out.split(p.text).join(p.say);
  }
  return out;
}

/** Novelty voices that shouldn't be picked automatically for characters. */
const NOVELTY = /santa|_inno$/;

/** Picks a voice for every cast member: same accent as the narrator where possible, never the narrator's own voice. */
export function castVoices(cast: CastMember[], narrator: string, voices: Voice[]): Map<string, string> {
  const accent = narrator.startsWith('b') ? 'UK' : 'US';
  const usable = voices.filter((v) => v.id !== narrator && !NOVELTY.test(v.id));
  const sameAccent = (gender: 'female' | 'male') => usable.filter((v) => v.gender === gender && v.accent === accent).map((v) => v.id);
  const pool = (gender: 'female' | 'male') => [
    ...sameAccent(gender),
    ...usable.filter((v) => v.gender === gender && v.accent !== accent).map((v) => v.id),
  ];
  const female = pool('female');
  const male = pool('male');
  const map = new Map<string, string>();
  let fi = 0;
  let mi = 0;
  for (const c of cast) {
    // A first-person narrator speaks in the narrator's voice (Claude is told not to list them, but be safe).
    if (/^(the\s+)?narrator$/i.test(c.name.trim())) {
      map.set(c.name, narrator);
      continue;
    }
    const list = c.gender === 'female' ? female : c.gender === 'male' ? male : null;
    if (!list || list.length === 0) continue;
    const voice = c.gender === 'female' ? list[fi++ % list.length] : list[mi++ % list.length];
    map.set(c.name, voice);
  }
  // One-off characters: a voice in the narrator's accent, taken from the end of the list so it's
  // the least likely to collide with a main character.
  const used = new Set(map.values());
  const minor = (gender: 'female' | 'male', all: string[]) => {
    const same = sameAccent(gender);
    // From the end of the narrator's accent first (least likely to be a main character's), then any accent.
    const free = [...[...same].reverse(), ...[...all].reverse()].find((v) => !used.has(v));
    return free ?? (same.length ? same[same.length - 1] : all[all.length - 1]);
  };
  if (female.length) map.set('minor_female', minor('female', female));
  if (male.length) map.set('minor_male', minor('male', male));
  map.set('narrator', narrator);
  return map;
}

/** Someone other than the narrator speaking, in seconds from the start of the chapter's MP3. */
export interface Span {
  part: string;
  start: number;
  end: number;
}

const seconds = (bytes: number) => bytes / 2 / SAMPLE_RATE;

/**
 * Synthesizes one chapter to MP3. `onProgress` gets 0..1. Returns when each character speaks,
 * so a listener can later change one voice without seeing the rest of the cast.
 */
export async function voiceChapter(opts: {
  chapter: SegChapter;
  notes: ChapterNotes[];
  narrator: string;
  /** Part (character name, minor slot, "narrator") → voice id. */
  characterVoices: Map<string, string> | null;
  outFile: string;
  onProgress?: (fraction: number) => void;
  shouldStop?: () => boolean;
}): Promise<Span[]> {
  const skip = new Set(opts.notes.flatMap((n) => n.skip_paragraphs));
  const pron = opts.notes.flatMap((n) => n.pronounce);
  const speakers = new Map(opts.notes.flatMap((n) => n.speakers).map((s) => [s.q, s.speaker]));
  const partFor = (q?: number) => {
    if (!opts.characterVoices || q === undefined) return 'narrator';
    const who = speakers.get(q);
    return who && who !== 'narrator' && opts.characterVoices.has(who) ? who : 'narrator';
  };
  const voiceOf = (part: string) => (part === 'narrator' ? opts.narrator : (opts.characterVoices?.get(part) ?? opts.narrator));

  const pcm: Buffer[] = [];
  let bytes = 0;
  const push = (b: Buffer) => {
    pcm.push(b);
    bytes += b.length;
  };
  const spans: Span[] = [];

  push(await speak(applyPronunciations(opts.chapter.title, pron), opts.narrator));
  push(silence(900));
  const paras = opts.chapter.paragraphs;
  for (let i = 0; i < paras.length; i++) {
    if (opts.shouldStop?.()) throw new Error('canceled');
    if (skip.has(i)) continue;
    // Merge neighbouring segments spoken by the same part into one run.
    const runs: { part: string; text: string }[] = [];
    for (const seg of paras[i]) {
      const part = seg.kind === 'quote' ? partFor(seg.q) : 'narrator';
      const last = runs[runs.length - 1];
      if (last && last.part === part) last.text += ` ${seg.text}`;
      else runs.push({ part, text: seg.text });
    }
    for (const run of runs) {
      const start = seconds(bytes);
      for (const sentence of sentences(applyPronunciations(run.text, pron))) {
        push(await speak(sentence, voiceOf(run.part)));
        push(silence(90));
      }
      if (run.part !== 'narrator') spans.push({ part: run.part, start, end: seconds(bytes) });
    }
    push(silence(380));
    opts.onProgress?.((i + 1) / paras.length);
  }
  push(silence(1200));
  await encodeMp3(Buffer.concat(pcm), opts.outFile);
  return spans;
}

async function encodeMp3(raw: Buffer, outFile: string): Promise<void> {
  const tmp = `${outFile}.part.mp3`;
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(config.ffmpegPath, [
      '-y', '-v', 'error',
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libmp3lame', '-b:a', '64k', tmp,
    ]);
    let err = '';
    ff.stderr.on('data', (d) => (err += d));
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.slice(0, 300)}`))));
    ff.stdin.end(raw);
  });
  await fs.rename(tmp, outFile);
}
