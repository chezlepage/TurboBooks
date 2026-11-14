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
  /** Shelfarr base URL and API token (scopes: search, requests read + write). Enables the Request tab. */
  shelfarrUrl: (env.SHELFARR_URL ?? '').replace(/\/+$/, ''),
  shelfarrToken: env.SHELFARR_TOKEN ?? '',
  /**
   * Admin web pages of the bundled request apps, shown to TurboBooks admins at /apps/<name>/.
   * Unset = not offered. docker-compose.yml sets these; their ports are never published.
   */
  appUpstreams: {
    shelfarr: (env.APP_SHELFARR_URL ?? '').replace(/\/+$/, ''),
    prowlarr: (env.APP_PROWLARR_URL ?? '').replace(/\/+$/, ''),
    qbittorrent: (env.APP_QBITTORRENT_URL ?? '').replace(/\/+$/, ''),
  },
  /** Minutes between automatic library rescans. 0 disables. */
  scanIntervalMinutes: Number(env.SCAN_INTERVAL_MINUTES ?? 30),
  /** Outgoing email, used for Send to Kindle. Unset SMTP_HOST disables the feature. */
  smtpHost: env.SMTP_HOST ?? '',
  smtpPort: Number(env.SMTP_PORT ?? 587),
  smtpUser: env.SMTP_USER ?? '',
  smtpPass: env.SMTP_PASS ?? '',
  /** The address Kindle users add to Amazon's approved sender list. Defaults to SMTP_USER. */
  smtpFrom: env.SMTP_FROM || env.SMTP_USER || '',
  /** Ebook → audiobook: Claude API key (text prep), Kokoro TTS URL, monthly Claude spend cap. */
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
  kokoroUrl: (env.KOKORO_URL ?? 'http://kokoro:8880').replace(/\/+$/, ''),
  convertMonthlyBudgetUsd: Number(env.CONVERT_MONTHLY_BUDGET_USD ?? 100),
  /** Use the Batch API (half price, usually done within the hour). Off = direct calls, full price, faster. */
  convertUseBatch: (env.CONVERT_USE_BATCH ?? 'true') !== 'false',
  /** Read along: Whisper speech-to-text (whisper-asr-webservice) for syncing ebook text to audiobooks. Empty = off. */
  whisperUrl: (env.WHISPER_URL ?? '').replace(/\/+$/, ''),
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.libraryDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'covers'), { recursive: true });
