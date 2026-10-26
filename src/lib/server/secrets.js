// src/lib/server/secrets.js — encrypts passwords Famner has to keep (e.g. the iCloud app-specific
// password), so a copy of the database or a backup on its own doesn't give them away.
//
// The key comes from FAMNER_SECRET (any long random text) or, if that isn't set, from a file
// `secret.key` next to the database, made on first use. Backups don't include that file: keep it
// with the database when moving the app (it's in the same folder, /data in Docker). Without it,
// the saved passwords can't be read and each person has to connect again.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const keys = new Map();

function keyFor(dbPath) {
  const fromEnv = process.env.FAMNER_SECRET;
  if (fromEnv) return createHash('sha256').update(fromEnv).digest();
  const file = join(dirname(dbPath), 'secret.key');
  if (!keys.has(file)) {
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    }
    keys.set(file, createHash('sha256').update(readFileSync(file, 'utf8').trim()).digest());
  }
  return keys.get(file);
}

/** Text → "v1:<iv>:<tag>:<data>" (AES-256-GCM). */
export function encryptSecret(dbPath, text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(dbPath), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** The text back, or null if it can't be read (a different key, or damaged). */
export function decryptSecret(dbPath, stored) {
  const [v, iv, tag, data] = String(stored ?? '').split(':');
  if (v !== 'v1' || !data) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', keyFor(dbPath), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
