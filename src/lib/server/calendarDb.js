// src/lib/server/calendarDb.js — SQLite storage for the calendar (server only).
// Requires: npm install better-sqlite3
//
// Each calendar and event is stored as its JSON (so new fields need no migrations), plus a few
// columns for lookups. The browser sends only what changed; see applyChanges().
// Every saved change set gets the next revision number and is broadcast to subscribe() listeners
// (the /api/calendar/live stream), so open calendars update instantly. Private calendars are
// filtered out per user, both when loading (loadAll) and on the live stream (messageFor).

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logActivity, eventFields, newExdates, calendarFields } from './activity.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS calendars (
    id         TEXT PRIMARY KEY,
    position   INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    calendar_id TEXT NOT NULL,
    start_at    TEXT NOT NULL,
    end_at      TEXT NOT NULL,
    data        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_by_calendar ON events (calendar_id);
  CREATE INDEX IF NOT EXISTS events_by_time ON events (start_at, end_at);
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO meta (key, value) VALUES ('rev', 0);
`;

const LIMITS = { items: 5000, eventBytes: 64 * 1024, idLength: 200 };

const dbs = new Map();

// Live listeners. Kept on globalThis so they survive module reloads during `npm run dev`.
// (In-process only: run one server process, e.g. adapter-node, for live updates to reach everyone.)
const listeners = (globalThis.__calendarLiveListeners ??= new Set());

/** Call `fn({ rev, origin, changes, privacy })` after every saved change set (filter it with messageFor). */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function currentRev(db) {
  return db.prepare("SELECT value FROM meta WHERE key = 'rev'").get().value;
}

/** Close every open database (on shutdown, so the write-ahead log is folded back into the file). */
export function closeAll() {
  for (const [path, db] of dbs) {
    try { db.close(); } catch {}
    dbs.delete(path);
  }
}

/** Open (once) the database file, creating it and its tables if needed. */
export function getDb(path = 'data/calendar.db') {
  let db = dbs.get(path);
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  dbs.set(path, db);
  return db;
}

// ---------- who can see a calendar ----------
// A calendar is seen by everyone in the household, unless it has `private: true`: then only its
// `owner` (a user id) and the people in its `sharedWith` list (user ids) see it and its events.
// Only the owner chooses who (admins for older calendars without an owner). Calls with
// `user = null` are internal and see everything.

/** Calendars not shared with everyone → { owner, sharedWith }. */
const access = (c) => ({ owner: c.owner ?? null, sharedWith: Array.isArray(c.sharedWith) ? c.sharedWith : [] });
function privateOwners(db) {
  const map = new Map();
  for (const r of db.prepare('SELECT id, data FROM calendars').all()) {
    const c = JSON.parse(r.data);
    if (c.private) map.set(r.id, access(c));
  }
  return map;
}

const visibleTo = (owners, calId, userId) => {
  const a = owners.get(calId);
  return !a || (userId != null && (a.owner === userId || a.sharedWith.includes(userId)));
};

/** Who can see a calendar, for comparing: 'everyone' or the sorted list of extra people. */
const visibilityKey = (c) => (c?.private ? JSON.stringify([...(c.sharedWith ?? [])].sort()) : 'everyone');

export function privateCalendarCount(db, userId) {
  return [...privateOwners(db)].filter(([, a]) => a.owner === userId).length;
}

/** Delete a user's private calendars and their events (when the user is removed). Returns how many. */
export function deletePrivateCalendarsOf(db, userId) {
  const ids = [...privateOwners(db)].filter(([, a]) => a.owner === userId).map(([id]) => id);
  if (ids.length) applyChanges(db, { deleteCalendars: ids });
  return ids.length;
}

/** Everything `user` may see, as a JSON string: { rev, calendars: [...], events: [...] }. */
export function loadAll(db, user = null) {
  const rev = currentRev(db);
  const owners = user ? privateOwners(db) : new Map();
  const ok = (calId) => !user || visibleTo(owners, calId, user.id);
  const cals = db.prepare('SELECT id, data FROM calendars ORDER BY position, rowid').all().filter((r) => ok(r.id));
  const evs = db.prepare('SELECT calendar_id, data FROM events').all().filter((r) => ok(r.calendar_id));
  return `{"rev":${rev},"calendars":[${cals.map((r) => r.data).join(',')}],"events":[${evs.map((r) => r.data).join(',')}]}`;
}

/**
 * The part of a live message `userId` may see. Calendars that just became hidden from them arrive
 * as deletions; ones that just became visible ask the browser to reload (`resync`) to get their events.
 */
export function messageFor(msg, userId) {
  const p = msg.privacy;
  if (!p) return msg;
  const before = new Map(Object.entries(p.before));
  const after = new Map(Object.entries(p.after));
  const seeBefore = (id) => visibleTo(before, id, userId);
  const seeAfter = (id) => visibleTo(after, id, userId);
  const ch = msg.changes;
  const out = { upsertCalendars: [], deleteCalendars: [], upsertEvents: [], deleteEvents: [] };
  let resync = false;
  for (const c of ch.upsertCalendars) {
    const existed = p.existed.includes(c.id);
    if (seeAfter(c.id)) {
      out.upsertCalendars.push(c);
      if (existed && !seeBefore(c.id)) resync = true;
    } else if (existed && seeBefore(c.id)) {
      out.deleteCalendars.push(c.id);
    }
  }
  for (const id of ch.deleteCalendars) if (p.existed.includes(id) && seeBefore(id)) out.deleteCalendars.push(id);
  for (const e of ch.upsertEvents) {
    const prev = p.eventCals[String(e.id)];
    if (seeAfter(e.calendar)) out.upsertEvents.push(e);
    else if (prev != null && seeBefore(prev)) out.deleteEvents.push(e.id);
  }
  for (const id of ch.deleteEvents) {
    const prev = p.eventCals[String(id)];
    if (prev != null && seeBefore(prev)) out.deleteEvents.push(id);
  }
  return { rev: msg.rev, origin: msg.origin, changes: out, ...(resync ? { resync: true } : {}) };
}

export class ValidationError extends Error {}
/** The change isn't allowed for this user (a child, or someone else's private calendar). */
export class ForbiddenError extends Error {}

const isId = (v) =>
  (typeof v === 'string' && v.length > 0 && v.length <= LIMITS.idLength) || (Number.isFinite(v) && typeof v === 'number');
const isIsoDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function list(body, key) {
  const v = body[key] ?? [];
  if (!Array.isArray(v)) throw new ValidationError(`${key} must be a list.`);
  if (v.length > LIMITS.items) throw new ValidationError(`Too many items in ${key} (max ${LIMITS.items} per request).`);
  return v;
}

/** Check a change set from the browser; throws ValidationError with a readable message. */
export function validateChanges(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Expected a JSON object.');
  const changes = {
    upsertCalendars: list(body, 'upsertCalendars'),
    deleteCalendars: list(body, 'deleteCalendars'),
    upsertEvents: list(body, 'upsertEvents'),
    deleteEvents: list(body, 'deleteEvents')
  };
  for (const c of changes.upsertCalendars) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !isId(c.id)) throw new ValidationError('Each calendar needs a text id.');
    if (typeof c.label !== 'string' || typeof c.color !== 'string') throw new ValidationError(`Calendar “${c.id}” needs a label and color.`);
  }
  for (const e of changes.upsertEvents) {
    if (!e || typeof e !== 'object' || !isId(e.id)) throw new ValidationError('Each event needs an id.');
    if (typeof e.calendar !== 'string') throw new ValidationError(`Event ${e.id} needs a calendar.`);
    if (!isIsoDate(e.start) || !isIsoDate(e.end)) throw new ValidationError(`Event ${e.id} has an invalid start or end.`);
  }
  for (const id of [...changes.deleteCalendars, ...changes.deleteEvents]) {
    if (!isId(id)) throw new ValidationError('Invalid id in a delete list.');
  }
  return changes;
}

/**
 * Apply a change set in one transaction, log it, then broadcast it.
 * `origin` identifies the browser that sent it, so it can ignore its own echo.
 * `user` ({ id, name, role }) is who's making the change:
 *   • nobody can touch another person's private calendar, and only a calendar's owner can make it
 *     private or shared again (admins can make older calendars without an owner private, becoming
 *     their owner);
 *   • children can't change shared calendars; they can create calendars of their own, which are
 *     always private. They can add events to shared calendars (not subscribed ones) and their own,
 *     and can only change or delete events they added themselves.
 * Log entries for private calendars leave out titles, except a child's private calendar, whose
 * titles are kept but marked `blur` (the admin panel shows them blurred until clicked).
 * Every new event is stamped with `createdBy` (the user's id); it never changes afterwards.
 * Calls without a user are internal (e.g. removing an account) and aren't checked or logged.
 * Returns { rev, calendars, events } (counts).
 */
export function applyChanges(db, body, origin = null, user = null) {
  const ch = validateChanges(body);
  const total = ch.upsertCalendars.length + ch.deleteCalendars.length + ch.upsertEvents.length + ch.deleteEvents.length;
  if (!total) return { rev: currentRev(db), calendars: 0, events: 0 };
  const child = user?.role === 'child' || user?.role === 'kiosk'; // the shared tablet has a child's permissions
  // The kiosk: `user` is the person it's unlocked as (role 'kiosk'). It can add events and change that
  // person's, in shared calendars only, and can't change calendars.
  const kiosk = user?.role === 'kiosk';
  if (kiosk && (ch.upsertCalendars.length || ch.deleteCalendars.length)) throw new ForbiddenError('Calendars can’t be changed on the kiosk.');
  const now = Date.now();
  let rev, privacy;
  const upCal = db.prepare(`
    INSERT INTO calendars (id, position, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET position = excluded.position, data = excluded.data, updated_at = excluded.updated_at`);
  const delCal = db.prepare('DELETE FROM calendars WHERE id = ?');
  const delCalEvents = db.prepare('DELETE FROM events WHERE calendar_id = ?');
  const countCalEvents = db.prepare('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?');
  const upEv = db.prepare(`
    INSERT INTO events (id, calendar_id, start_at, end_at, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET calendar_id = excluded.calendar_id, start_at = excluded.start_at,
      end_at = excluded.end_at, data = excluded.data, updated_at = excluded.updated_at`);
  const delEv = db.prepare('DELETE FROM events WHERE id = ?');
  const getEvent = db.prepare('SELECT data FROM events WHERE id = ?');

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = new Map(db.prepare('SELECT id, data FROM calendars').all().map((r) => [r.id, JSON.parse(r.data)]));
    const before = new Map([...existing].filter(([, c]) => c.private).map(([id, c]) => [id, access(c)]));
    const userIds = new Set(user ? db.prepare('SELECT id FROM users').all().map((u) => u.id) : []);
    const after = new Map(before);
    const may = (owners, calId) => !user || visibleTo(owners, calId, user.id);
    // a private calendar shared with someone is only for looking at: only its owner changes it
    const notOwner = (owners, calId) => !!user && !!owners.get(calId)?.owner && owners.get(calId).owner !== user.id;
    const nameOf = (id) => existing.get(id)?.label ?? id;
    const log = [];

    // how private a calendar is, for the log: 'shared', 'blur' (a child's private calendar) or 'hidden'
    const calAfter = new Map(existing);
    const roles = new Map();
    const roleOf = (id) => {
      if (!roles.has(id)) {
        let r = null;
        try { r = db.prepare('SELECT role FROM users WHERE id = ?').get(id)?.role ?? null; } catch { /* no accounts table */ }
        roles.set(id, r);
      }
      return roles.get(id);
    };
    const privacyOf = (...ids) => {
      let mode = 'shared';
      for (const id of ids) {
        if (id == null) continue;
        const a = calAfter.get(id), b = existing.get(id);
        if (!(a?.private || b?.private)) continue;
        if (['child', 'kiosk'].includes(roleOf((a ?? b).owner))) mode = 'blur';
        else return 'hidden';
      }
      return mode;
    };

    // calendars: settle ownership and privacy
    ch.upsertCalendars = ch.upsertCalendars.map((rec) => {
      const c = { ...rec };
      const prev = existing.get(c.id);
      if (child) {
        if (c.source) throw new ForbiddenError('Only parents can subscribe to calendars.');
        if (prev && prev.owner !== user.id) throw new ForbiddenError('Only parents can change shared calendars.');
      }
      // who it's shared with: real accounts only, never the owner, no duplicates
      if (c.private) {
        if (c.sharedWith != null && !Array.isArray(c.sharedWith)) throw new ValidationError('sharedWith must be a list of people.');
        c.sharedWith = [...new Set((c.sharedWith ?? []).map(String))].filter((id) => (!user || userIds.has(id))).sort();
      } else {
        delete c.private;
        delete c.sharedWith;
      }
      if (user) {
        if (prev && (!may(before, c.id) || (prev.private && prev.owner && prev.owner !== user.id))) {
          throw new ForbiddenError(`You can’t change someone else’s private calendar.`);
        }
        if (prev) {
          if (prev.owner) c.owner = prev.owner;
          else delete c.owner;
          if (visibilityKey(prev) !== visibilityKey(c)) {
            const allowed = prev.owner ? prev.owner === user.id : user.role === 'admin';
            if (!allowed) throw new ForbiddenError(`Only the person who created “${nameOf(c.id)}” can change who sees it.`);
            if (!prev.owner && c.private) c.owner = user.id;
          }
        } else {
          c.owner = user.id;
        }
      }
      if (c.private) c.sharedWith = c.sharedWith.filter((id) => id !== c.owner);
      if (c.private && !c.sharedWith.length) delete c.sharedWith;
      if (c.private) after.set(c.id, access(c));
      else after.delete(c.id);
      const { position, ...stored } = c;
      calAfter.set(c.id, stored);
      // log: new calendars and real changes (not reordering or a subscription's sync status)
      const mode = privacyOf(c.id);
      const hidden = mode === 'hidden';
      const flags = { private: mode !== 'shared' || undefined, blur: mode === 'blur' || undefined };
      if (!prev) log.push({ kind: 'calendar.added', details: { name: hidden ? null : c.label, ...flags, subscribed: !!c.source || undefined } });
      else {
        const fields = calendarFields(prev, stored);
        if (fields.length) log.push({ kind: 'calendar.changed', details: { name: hidden ? null : stored.label, from: fields.includes('name') && !hidden ? prev.label : undefined, fields, ...flags } });
      }
      return c;
    });
    for (const id of ch.deleteCalendars) {
      const prev = existing.get(id);
      if (prev && (!may(before, id) || (user && prev.private && prev.owner && prev.owner !== user.id))) throw new ForbiddenError(`You can’t delete someone else’s private calendar.`);
      if (child && prev && prev.owner !== user.id) throw new ForbiddenError('Only parents can remove shared calendars.');
      const mode = privacyOf(id);
      after.delete(id);
      calAfter.delete(id);
      if (prev) {
        log.push({ kind: 'calendar.deleted', details: {
          name: mode === 'hidden' ? null : prev.label, private: mode !== 'shared' || undefined, blur: mode === 'blur' || undefined,
          subscribed: !!prev.source || undefined, events: countCalEvents.get(id).n
        } });
      }
    }

    // events: both the old and the new calendar must be visible to the user (and, for children, theirs)
    const eventCals = {};
    const calLabel = (id) => calAfter.get(id)?.label ?? existing.get(id)?.label ?? id;
    const isSubscribed = (id) => !!(calAfter.get(id)?.source || existing.get(id)?.source);
    ch.upsertEvents = ch.upsertEvents.map((rec) => {
      const e = { ...rec };
      const row = getEvent.get(String(e.id));
      const prev = row ? JSON.parse(row.data) : null;
      eventCals[String(e.id)] = prev?.calendar ?? null;
      if (!may(after, e.calendar) || (prev && !may(before, prev.calendar)) || notOwner(after, e.calendar) || (prev && notOwner(before, prev.calendar))) {
        throw new ForbiddenError('You can’t change events in someone else’s private calendar.');
      }
      if (kiosk && (!visibleTo(after, e.calendar, user.kioskId) || (prev && !visibleTo(before, prev.calendar, user.kioskId)))) {
        throw new ForbiddenError('That calendar isn’t shared with the tablet.');
      }
      if (child) {
        if (prev && prev.createdBy !== user.id) throw new ForbiddenError(kiosk ? 'Only the person who added an event can change it (with their PIN).' : 'You can only change events you added yourself.');
        if (!calAfter.has(e.calendar)) throw new ForbiddenError('That calendar doesn’t exist.');
        if (isSubscribed(e.calendar)) throw new ForbiddenError('Events can’t be added to a subscribed calendar.');
      }
      // who added it: fixed once set; children can only ever add as themselves
      if (prev) {
        if (prev.createdBy) e.createdBy = prev.createdBy;
        else delete e.createdBy;
      } else if (user && (child || !e.createdBy)) {
        e.createdBy = user.id;
      }
      // log (not for subscribed calendars, which refresh by themselves)
      if (user && !isSubscribed(e.calendar) && !(prev && isSubscribed(prev.calendar))) {
        const mode = privacyOf(e.calendar, prev?.calendar);
        const hidden = mode === 'hidden';
        const base = hidden ? { private: true }
          : { title: e.title ?? '', calendar: calLabel(e.calendar), ...(mode === 'blur' ? { private: true, blur: true } : {}) };
        if (!prev) log.push({ kind: 'event.added', details: { ...base, start: hidden ? undefined : e.start, allDay: hidden ? undefined : e.allDay || undefined } });
        else {
          const fields = eventFields(prev, e);
          const skipped = newExdates(prev, e);
          if (fields.length) {
            log.push({ kind: 'event.changed', details: {
              ...base, fields,
              ...(hidden ? {} : {
                from: fields.includes('title') ? prev.title : undefined,
                fromCalendar: fields.includes('calendar') ? calLabel(prev.calendar) : undefined,
                start: fields.includes('time') ? e.start : undefined,
                allDay: fields.includes('time') ? e.allDay || undefined : undefined
              })
            } });
          } else if (skipped.length) {
            log.push({ kind: 'event.skipped', details: { ...base, dates: hidden ? undefined : skipped } });
          }
        }
      }
      return e;
    });
    for (const id of ch.deleteEvents) {
      const row = getEvent.get(String(id));
      const prev = row ? JSON.parse(row.data) : null;
      eventCals[String(id)] = prev?.calendar ?? null;
      if (prev && (!may(before, prev.calendar) || notOwner(before, prev.calendar))) throw new ForbiddenError('You can’t change events in someone else’s private calendar.');
      if (kiosk && prev && !visibleTo(before, prev.calendar, user.kioskId)) throw new ForbiddenError('That calendar isn’t shared with the tablet.');
      if (child && prev && prev.createdBy !== user.id) throw new ForbiddenError(kiosk ? 'Only the person who added an event can delete it (with their PIN).' : 'You can only delete events you added yourself.');
      if (prev && user && !isSubscribed(prev.calendar)) {
        const mode = privacyOf(prev.calendar);
        log.push({ kind: 'event.deleted', details: mode === 'hidden' ? { private: true }
          : { title: prev.title ?? '', calendar: calLabel(prev.calendar), ...(mode === 'blur' ? { private: true, blur: true } : {}) } });
      }
    }

    for (const c of ch.upsertCalendars) {
      const { position = 0, ...cal } = c;
      upCal.run(cal.id, Number(position) || 0, JSON.stringify(cal), now);
    }
    for (const e of ch.upsertEvents) {
      const data = JSON.stringify(e);
      if (data.length > LIMITS.eventBytes) throw new ValidationError(`Event ${e.id} is too large.`);
      upEv.run(String(e.id), e.calendar, e.start, e.end, data, now);
    }
    for (const id of ch.deleteEvents) delEv.run(String(id));
    for (const id of ch.deleteCalendars) {
      delCalEvents.run(String(id));
      delCal.run(String(id));
    }
    db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'rev'").run();
    rev = currentRev(db);
    logActivity(db, user, 'calendar', log);
    db.exec('COMMIT');
    privacy = {
      before: Object.fromEntries(before),
      after: Object.fromEntries(after),
      existed: [...ch.upsertCalendars.map((c) => c.id), ...ch.deleteCalendars].filter((id) => existing.has(id)),
      eventCals
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const message = { rev, origin, changes: ch, privacy };
  for (const fn of listeners) {
    try { fn(message); } catch (err) { console.error('Calendar live listener failed:', err); }
  }
  return {
    rev,
    calendars: ch.upsertCalendars.length + ch.deleteCalendars.length,
    events: ch.upsertEvents.length + ch.deleteEvents.length
  };
}
