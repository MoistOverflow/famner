// src/lib/server/reset.js — factory reset: wipe everything and start over at /setup (admins only).
//
// Removes every account, sign-in, calendar, event, grocery item, chore, point, reward and log entry.
// A backup is made first (kind 'reset', in the backups folder, which isn't touched), so a reset can
// be undone by restoring that file (see DEPLOY.md). Only revision counters are kept, so devices
// that still have the app open see that everything changed.
import { verifyPassword, AuthError } from './auth.js';
import { makeBackup } from './backups.js';

export const RESET_WORD = 'RESET';

export async function factoryReset(db, dbPath, actor, { password, confirm }) {
  if (actor?.role !== 'admin') throw new AuthError('Only admins can reset the app.');
  if (String(confirm ?? '').trim() !== RESET_WORD) throw new AuthError(`Type ${RESET_WORD} to confirm.`);
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(actor.id);
  if (!row || !(await verifyPassword(String(password ?? ''), row.password_hash))) throw new AuthError('Your password isn’t right.');

  const backup = makeBackup(db, dbPath, 'reset');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'meta'").all().map((t) => t.name);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of tables) db.exec(`DELETE FROM "${t.replace(/"/g, '""')}"`);
    db.exec("UPDATE meta SET value = value + 1 WHERE key LIKE 'rev%'");
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  try { db.exec('VACUUM'); } catch { /* only tidies the file */ }
  return { backup: backup?.name ?? null, tables: tables.length };
}
