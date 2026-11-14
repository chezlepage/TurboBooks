/**
 * The admin pages of the bundled request apps (Shelfarr, Prowlarr, qBittorrent), served through
 * TurboBooks at /apps/<name>/ to TurboBooks admins only. Their own ports are never published, so
 * this login is the only way in, from the LAN or through the Cloudflare tunnel alike.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import httpProxy from '@fastify/http-proxy';
import { config } from '../config.js';
import { SESSION_COOKIE, userFromRequest } from './auth.js';

export interface AppInfo {
  id: keyof typeof config.appUpstreams;
  name: string;
  path: string;
}

/**
 * keepPrefix: Shelfarr and Prowlarr are told their base path (RAILS_RELATIVE_URL_ROOT, URLBASE) and get
 * the full path; qBittorrent knows nothing of it and gets the path with /apps/qbittorrent removed.
 * ownHost: qBittorrent rejects a Host whose port isn't its own (e.g. a LAN address on :8080), so it is
 * sent its own address, with Origin/Referer to match. The others build links from the browser's Host.
 */
const APPS: (AppInfo & { keepPrefix: boolean; ownHost: boolean })[] = [
  { id: 'prowlarr', name: 'Prowlarr', path: '/apps/prowlarr', keepPrefix: true, ownHost: false },
  { id: 'shelfarr', name: 'Shelfarr', path: '/apps/shelfarr', keepPrefix: true, ownHost: false },
  { id: 'qbittorrent', name: 'qBittorrent', path: '/apps/qbittorrent', keepPrefix: false, ownHost: true },
];

export const availableApps = (): AppInfo[] =>
  APPS.filter((a) => config.appUpstreams[a.id]).map(({ id, name, path }) => ({ id, name, path: `${path}/` }));

/** Drop TurboBooks' own session cookie so the apps never see it. */
function withoutSessionCookie(cookie: string | undefined): string | undefined {
  if (!cookie) return cookie;
  const kept = cookie
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${SESSION_COOKIE}=`));
  return kept.length ? kept.join('; ') : undefined;
}

const ownOrigin = (request: FastifyRequest) => `${request.protocol}://${request.headers.host ?? ''}`;

export async function appProxyRoutes(app: FastifyInstance) {
  for (const a of APPS) {
    const upstream = config.appUpstreams[a.id];
    if (!upstream) continue;
    const upstreamUrl = new URL(upstream);

    await app.register(httpProxy, {
      upstream,
      prefix: a.path,
      rewritePrefix: a.keepPrefix ? a.path : '',
      websocket: false,
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        const user = userFromRequest(request, reply);
        if (!user) return reply.redirect('/');
        if (!user.isAdmin) return reply.code(403).type('text/plain').send('Only TurboBooks admins can open this page.');
        // Relative links inside the apps need the trailing slash.
        if (request.url === a.path) return reply.redirect(`${a.path}/`);
        // Changes must come from these pages, not another site (on top of the SameSite session cookie).
        const origin = request.headers.origin;
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin && origin !== ownOrigin(request)) {
          return reply.code(403).type('text/plain').send('Cross-site request blocked.');
        }
      },
      replyOptions: {
        rewriteRequestHeaders: (request, headers) => {
          const out = { ...headers };
          const cookie = withoutSessionCookie(headers.cookie as string | undefined);
          if (cookie) out.cookie = cookie;
          else delete out.cookie;
          if (a.ownHost) {
            out.host = upstreamUrl.host;
            if (out.origin) out.origin = upstreamUrl.origin;
            if (typeof out.referer === 'string') out.referer = upstreamUrl.origin + '/';
            delete out['x-forwarded-host'];
            delete out['x-forwarded-for'];
            return out;
          }
          // The apps build absolute links and check CSRF against the address the browser used.
          out.host = request.headers.host ?? out.host;
          out['x-forwarded-host'] = request.headers.host ?? '';
          out['x-forwarded-proto'] = request.protocol;
          out['x-forwarded-for'] = request.ip;
          return out;
        },
      },
    });
  }
}
