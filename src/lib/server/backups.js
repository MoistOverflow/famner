// src/lib/server/backups.js — copies of the database file.
//
// • An automatic backup is made when none has been made in the last 24 hours (checked hourly while
//   the server runs, and at start-up). The newest 14 automatic ones are kept.
// • Admins can make one any time ("Back up now", the newest 10 of those are kept) and download any
//   backup from the admin panel.
// Backups go in a "backups" folder next to the database (set BACKUP_DIR to put them elsewhere —
// ideally another disk). Each one is a complete, standalone SQLite file. To restore, see DEPLOY.md.

import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';

const KEEP = { auto: 14, manual: 10, reset: 5 }; // 'reset': made just before a factory reset
const NAME = /^backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-(auto|manual|reset)\.db$/;
const DAY = 86400000;

export function backupDir(dbPath) {
  return resolve(process.env.BACKUP_DIR || join(dirname(dbPath), 'backups'));
}

/** All backups, newest first: { name, kind, at, size }. */
export function listBackups(dbPath) {
  const dir = backupDir(dbPath);
  let files = [];
  try { files = readdirSync(dir); } catch { return []; }
  return files
    .map((name) => {
      const m = name.match(NAME);
      if (!m) return null;
      const [d, t] = m[1].split('T');
      const at = Date.parse(`${d}T${t.replace(/-/g, ':').replace(/:Z$/, 'Z')}`);
      let size = 0;
      try { size = statSync(join(dir, name)).size; } catch {}
      return { name, kind: m[2], at, size };
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
}

/** Make a backup now. Returns its details. */
export function makeBackup(db, dbPath, kind = 'manual') {
  const dir = backupDir(dbPath);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  const name = `backup-${stamp}-${kind}.db`;
  const target = join(dir, name);
  // VACUUM INTO writes a consistent, compacted copy while the app keeps running
  if (!existsSync(target)) db.prepare('VACUUM INTO ?').run(target); // (same second: it's already there)
  for (const k of Object.keys(KEEP)) {
    for (const old of listBackups(dbPath).filter((b) => b.kind === k).slice(KEEP[k])) {
      try { unlinkSync(join(dir, old.name)); } catch {}
    }
  }
  return listBackups(dbPath).find((b) => b.name === name);
}

/** The full path of a backup, or null if the name isn't one of ours (no path tricks). */
export function backupFile(dbPath, name) {
  if (!NAME.test(String(name))) return null;
  const dir = backupDir(dbPath);
  const full = resolve(dir, name);
  if (!full.startsWith(dir + sep)) return null;
  try { statSync(full); } catch { return null; }
  return full;
}

/** Make an automatic backup when the last one is more than a day old. */
export function backupIfDue(db, dbPath) {
  const last = listBackups(dbPath).find((b) => b.kind === 'auto');
  if (last && Date.now() - last.at < DAY) return null;
  try {
    return makeBackup(db, dbPath, 'auto');
  } catch (err) {
    console.error('Automatic backup failed:', err);
    return null;
  }
}

/** Check hourly (once per server process). */
export function startBackupSchedule(db, dbPath) {
  if (globalThis.__backupTimer) return;
  backupIfDue(db, dbPath);
  globalThis.__backupTimer = setInterval(() => backupIfDue(db, dbPath), 3600000);
  globalThis.__backupTimer.unref?.();
}
