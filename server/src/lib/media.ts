import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const run = promisify(execFile);

export const AUDIO_EXTENSIONS: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4b': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
};

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export interface ProbeResult {
  duration: number;
  tags: Record<string, string>;
  chapters: { title: string; start: number; end: number }[];
  hasCover: boolean;
}

interface FfprobeJson {
  format?: { duration?: string; tags?: Record<string, string> };
  chapters?: { start_time: string; end_time: string; tags?: Record<string, string> }[];
  streams?: { codec_type?: string; disposition?: { attached_pic?: number } }[];
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run(
    config.ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_chapters', '-show_streams', file],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const json = JSON.parse(stdout) as FfprobeJson;
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(json.format?.tags ?? {})) tags[key.toLowerCase()] = value;
  return {
    duration: Number(json.format?.duration ?? 0) || 0,
    tags,
    chapters: (json.chapters ?? []).map((c, i) => ({
      title: c.tags?.title ?? `Chapter ${i + 1}`,
      start: Number(c.start_time),
      end: Number(c.end_time),
    })),
    hasCover: (json.streams ?? []).some((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1),
  };
}

/** Extracts an embedded cover image. Returns false if it could not. */
export async function extractCover(file: string, outFile: string): Promise<boolean> {
  try {
    await run(config.ffmpegPath, ['-y', '-v', 'error', '-i', file, '-an', '-frames:v', '1', outFile]);
    return true;
  } catch {
    return false;
  }
}
