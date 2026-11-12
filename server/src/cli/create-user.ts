/**
 * Create a user or reset a password from the command line.
 *
 *   npm run create-user -- <username> [--admin]
 *
 * The password is read from the TB_PASSWORD env var, or prompted for.
 */
import readline from 'node:readline/promises';
import { db } from '../db.js';
import { createUser, revokeSessions, setPassword } from '../lib/auth.js';

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith('--'));
const isAdmin = args.includes('--admin');

if (!username) {
  console.error('Usage: npm run create-user -- <username> [--admin]');
  process.exit(1);
}

let password = process.env.TB_PASSWORD;
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question(`Password for ${username}: `);
  rl.close();
}
if (!password || password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
if (existing) {
  await setPassword(existing.id, password);
  if (isAdmin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
  revokeSessions(existing.id);
  console.log(`Updated password for "${username}".`);
} else {
  await createUser(username, password, isAdmin);
  console.log(`Created ${isAdmin ? 'admin ' : ''}user "${username}".`);
}
db.close();
