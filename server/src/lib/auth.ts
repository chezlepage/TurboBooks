import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { db, now } from '../db.js';

export const SESSION_COOKIE = 'tb_session';
const DAY = 24 * 60 * 60 * 1000;

export interface User {
  id: number;
  username: string;
  isAdmin: boolean;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  is_admin: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  isAdmin: row.is_admin === 1,
});

export const hashPassword = (password: string) => hash(password);

// Used so that login with an unknown username takes as long as a wrong password.
let dummyHash: Promise<string> | undefined;

export async function checkCredentials(username: string, password: string): Promise<User | null> {
  const row = db
    .prepare('SELECT id, username, password_hash, is_admin FROM users WHERE username = ?')
    .get(username) as UserRow | undefined;
  if (!row) {
    dummyHash ??= hash('not-a-real-password');
    await verify(await dummyHash, password).catch(() => false);
    return null;
  }
  const ok = await verify(row.password_hash, password).catch(() => false);
  return ok ? toUser(row) : null;
}

export async function createUser(username: string, password: string, isAdmin: boolean): Promise<User> {
  const passwordHash = await hashPassword(password);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, isAdmin ? 1 : 0, now());
  return { id: Number(info.lastInsertRowid), username, isAdmin };
}

export async function setPassword(userId: number, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function startSession(reply: FastifyReply, userId: number): void {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = now() + config.sessionDays * DAY;
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now(),
    expires,
  );
  setSessionCookie(reply, token, expires);
}

export function endSession(request: FastifyRequest, reply: FastifyReply): void {
  const token = request.cookies[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Deletes all sessions for a user, optionally keeping the current one. */
export function revokeSessions(userId: number, keepToken?: string): void {
  if (keepToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(keepToken));
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

function setSessionCookie(reply: FastifyReply, token: string, expires: number) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    expires: new Date(expires),
  });
}

export function userFromRequest(request: FastifyRequest, reply?: FastifyReply): User | null {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.password_hash, u.is_admin, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as (UserRow & { expires_at: number }) | undefined;
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  // Sliding expiry: extend the session (and cookie) at most once a day.
  const fullExpiry = now() + config.sessionDays * DAY;
  if (reply && fullExpiry - row.expires_at > DAY) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(fullExpiry, tokenHash);
    setSessionCookie(reply, token, fullExpiry);
  }
  return toUser(row);
}

export function purgeExpiredSessions(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = userFromRequest(request, reply);
  if (!user) return reply.code(401).send({ error: 'Not logged in' });
  request.user = user;
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user?.isAdmin) return reply.code(403).send({ error: 'Admins only' });
}
