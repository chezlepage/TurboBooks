import fs from 'node:fs';
import path from 'node:path';

// Load .env from the server dir or repo root if present (Node >= 21.7).
for (const candidate of ['.env', '../.env']) {
  if (fs.existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      /* ignore malformed env file */
    }
    break;
  }
}

const env = process.env;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(value.toLowerCase());
}

export const config = {
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  libraryDir: path.resolve(env.LIBRARY_DIR ?? './library'),
  webDir: path.resolve(env.WEB_DIR ?? '../web/dist'),
  /** Set to false only for plain-http local development. */
  cookieSecure: bool(env.COOKIE_SECURE, true),
  sessionDays: Number(env.SESSION_DAYS ?? 60),
  adminUsername: env.ADMIN_USERNAME,
  adminPassword: env.ADMIN_PASSWORD,
  trustProxy: bool(env.TRUST_PROXY, true),
  ffprobePath: env.FFPROBE_PATH ?? 'ffprobe',
  ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
  /** Minutes between automatic library rescans. 0 disables. */
  scanIntervalMinutes: Number(env.SCAN_INTERVAL_MINUTES ?? 30),
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.libraryDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'covers'), { recursive: true });
