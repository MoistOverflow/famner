// src/lib/server/collections.js — simple synced lists (groceries, …) in the calendar's
// SQLite database. Each list is a set of JSON items with ids. Like the calendar, every saved change
// gets the next revision number for that list and is broadcast to its live listeners.

import { getDb } from './calendarDb.js';
import { logActivity } from './activity.js';

/** The lists the API will serve. Add a name here to create another list. */
export const LIST_NAMES = new Set(['groceries']); // chores have their own module (chores.js)

const LIMITS = { items: 2000, itemBytes: 16 * 1024, idLength: 200 };

const prepared = new WeakSet();
function ensureSchema(db) {
  if (prepared.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS list_items (
      list       TEXT NOT NULL,
      id         TEXT NOT NULL,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (list, id)
    );
  `);
  prepared.add(db);
}

export function openLists(path) {
  const db = getDb(path);
  ensureSchema(db);
  return db;
}

// live listeners per list, kept on globalThis so they survive module reloads in `npm run dev`
const listeners = (globalThis.__listLiveListeners ??= new Map());

export function subscribeList(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name)?.delete(fn);
}

export function listRev(db, name) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(`rev:${name}`)?.value ?? 0;
}

/** `{"rev":N,"items":[…]}` as a JSON string. */
export function loadList(db, name) {
  const rows = db.prepare('SELECT data FROM list_items WHERE list = ?').all(name);
  return `{"rev":${listRev(db, name)},"items":[${rows.map((r) => r.data).join(',')}]}`;
}

export class ListValidationError extends Error {}
/** Not allowed for this user (a child changing something someone else added). */
export class ListForbiddenError extends Error {}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ListValidationError('Expected a JSON object.');
  const upsert = body.upsert ?? [];
  const del = body.delete ?? [];
  if (!Array.isArray(upsert) || !Array.isArray(del)) throw new ListValidationError('upsert and delete must be lists.');
  if (upsert.length + del.length > LIMITS.items) throw new ListValidationError(`Too many changes at once (max ${LIMITS.items}).`);
  const okId = (v) => typeof v === 'string' && v.length > 0 && v.length <= LIMITS.idLength;
  for (const item of upsert) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !okId(item.id)) throw new ListValidationError('Each item needs a text id.');
    if (item.qty != null && !(Number.isInteger(item.qty) && item.qty >= 1 && item.qty <= 99)) throw new ListValidationError('A quantity must be a whole number from 1 to 99.');
    if (item.aisle != null && !(typeof item.aisle === 'string' && /^[a-z]{1,20}$/.test(item.aisle))) throw new ListValidationError('Unknown aisle.');
  }
  for (const id of del) if (!okId(id)) throw new ListValidationError('Invalid id in the delete list.');
  return { upsert, delete: del };
}

/** What one item change means, for the activity log (null when it's only reordering etc.). */
function describe(prev, next) {
  const label = next?.name ?? prev?.name ?? '';
  if (!prev) return { kind: 'item.added', details: { name: label } };
  if (!next) return { kind: 'item.deleted', details: { name: label } };
  if (!prev.done && next.done) return { kind: 'item.checked', details: { name: label } };
  if (prev.done && !next.done) return { kind: 'item.unchecked', details: { name: label } };
  if ((prev.name ?? '') !== (next.name ?? '')) return { kind: 'item.renamed', details: { from: prev.name ?? '', name: label } };
  const { position: _a, ...p } = prev, { position: _b, ...n } = next;
  return JSON.stringify(p) === JSON.stringify(n) ? null : { kind: 'item.changed', details: { name: label } };
}

/**
 * Save changes `{ upsert: [items], delete: [ids] }` to a list, log them, then broadcast them
 * (with `added`: the ids of items that didn't exist before).
 * New items are stamped with `createdBy` (the user's id), which never changes afterwards.
 * Children can add items but only change or delete ones they added themselves.
 */
export function applyListChanges(db, name, body, origin = null, user = null) {
  const changes = validate(body);
  if (!changes.upsert.length && !changes.delete.length) return { rev: listRev(db, name) };
  const child = user?.role === 'child' || user?.role === 'kiosk'; // the shared tablet has a child's permissions
  const now = Date.now();
  const getItem = db.prepare('SELECT data FROM list_items WHERE list = ? AND id = ?');
  const up = db.prepare(`
    INSERT INTO list_items (list, id, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(list, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`);
  const del = db.prepare('DELETE FROM list_items WHERE list = ? AND id = ?');
  let rev;
  const added = []; // ids of items that are new (for "Mom added milk" notifications)
  db.exec('BEGIN IMMEDIATE');
  try {
    const log = [];
    changes.upsert = changes.upsert.map((rec) => {
      const item = { ...rec };
      const row = getItem.get(name, item.id);
      const prev = row ? JSON.parse(row.data) : null;
      if (child && prev && prev.createdBy !== user.id) throw new ListForbiddenError('You can only change items you added yourself.');
      if (prev) {
        if (prev.createdBy) item.createdBy = prev.createdBy;
        else delete item.createdBy;
      } else if (user && (child || !item.createdBy)) {
        item.createdBy = user.id;
      }
      if (!prev) added.push(item.id);
      const entry = describe(prev, item);
      if (entry) log.push(entry);
      return item;
    });
    for (const id of changes.delete) {
      const row = getItem.get(name, id);
      const prev = row ? JSON.parse(row.data) : null;
      if (child && prev && prev.createdBy !== user.id) throw new ListForbiddenError('You can only delete items you added yourself.');
      if (prev) log.push(describe(prev, null));
    }
    for (const item of changes.upsert) {
      const data = JSON.stringify(item);
      if (data.length > LIMITS.itemBytes) throw new ListValidationError('An item is too large.');
      up.run(name, item.id, data, now);
    }
    for (const id of changes.delete) del.run(name, id);
    logActivity(db, user, name, log);
    db.prepare(`INSERT INTO meta (key, value) VALUES (?, 1)
      ON CONFLICT(key) DO UPDATE SET value = value + 1`).run(`rev:${name}`);
    rev = listRev(db, name);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const message = { rev, origin, changes, added };
  for (const fn of listeners.get(name) ?? []) {
    try { fn(message); } catch (err) { console.error('List live listener failed:', err); }
  }
  return { rev };
}
