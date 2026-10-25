// src/lib/server/chores.js — chores, reviews, points and rewards (server only).
//
// • Admins and parents create chores for one person, with a deadline, an optional repeat and a
//   point value. Repeating chores are one at a time: when one is finished the next becomes due.
// • The assigned person marks a chore done. A child's goes to "waiting for review"; an admin or
//   parent then approves it (full points), gives reduced points, or denies it, with a reason.
//   Adults' own chores, and a child's chore marked done by a parent, count straight away.
// • Points are an append-only history (gains and spends), so a balance is always explainable.
//   Anyone can spend points on a reward; a parent then marks it given, or refunds it.
//
// Every change bumps a revision and notifies live listeners (the /api/chores/live stream), and is
// written to the activity log.

import { randomUUID } from 'node:crypto';
import { getDb } from './calendarDb.js';
import { logActivity } from './activity.js';

export class ChoreError extends Error {}
/** Not allowed for this user. */
export class ChoreForbidden extends ChoreError {}

const ADULT = new Set(['admin', 'parent']);
export const isAdult = (user) => ADULT.has(user?.role);
export const REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly', 'custom'];
const HISTORY_DAYS = 30;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chores (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    notes        TEXT NOT NULL DEFAULT '',
    assignee     TEXT NOT NULL,
    points       INTEGER NOT NULL DEFAULT 0,
    due          INTEGER NOT NULL,
    repeat       TEXT,
    tz           TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    submitted_at INTEGER,
    created_by   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS chore_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chore_id    TEXT NOT NULL,
    title       TEXT NOT NULL,
    assignee    TEXT NOT NULL,
    due         INTEGER NOT NULL,
    done_at     INTEGER NOT NULL,
    outcome     TEXT NOT NULL,
    points      INTEGER NOT NULL,
    possible    INTEGER NOT NULL,
    reason      TEXT,
    reviewed_by TEXT,
    at          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chore_history_by_time ON chore_history (at);
  CREATE TABLE IF NOT EXISTS points (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    delta   INTEGER NOT NULL,
    kind    TEXT NOT NULL,
    ref     TEXT,
    note    TEXT,
    by_user TEXT,
    at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS points_by_user ON points (user_id);
  CREATE TABLE IF NOT EXISTS rewards (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    cost       INTEGER NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS redemptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    reward_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    cost       INTEGER NOT NULL,
    user_id    TEXT NOT NULL,
    at         INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    handled_by TEXT,
    handled_at INTEGER
  );
  INSERT OR IGNORE INTO meta (key, value) VALUES ('rev:chores', 0);
`;

const prepared = new WeakSet();
export function choresDb(path) {
  const db = getDb(path);
  if (!prepared.has(db)) {
    db.exec(SCHEMA);
    prepared.add(db);
  }
  return db;
}

// ---------- live updates ----------
const listeners = (globalThis.__choreListeners ??= new Set());
export function subscribeChores(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const choresRev = (db) => db.prepare("SELECT value FROM meta WHERE key = 'rev:chores'").get()?.value ?? 0;

/** Run `fn` in a transaction, then bump the revision, log, and tell listeners. */
function change(db, actor, fn) {
  db.exec('BEGIN IMMEDIATE');
  let result, rev;
  try {
    const log = [];
    result = fn(log);
    db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'rev:chores'").run();
    rev = choresRev(db);
    logActivity(db, actor, 'chores', log);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (const l of listeners) {
    try { l({ rev }); } catch (err) { console.error('Chores live listener failed:', err); }
  }
  return result;
}

// ---------- time zones and repeats ----------
// Deadlines are instants; repeats are worked out on the household's wall clock (`tz`, sent by the
// browser that created the chore), so "every weekday at 7 PM" stays 7 PM across DST and servers.
function wallParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}

function zoneOffset(tz, ms) {
  const w = wallParts(ms, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) - Math.floor(ms / 60000) * 60000;
}

function fromWall({ y, m, d, h, mi }, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = zoneOffset(tz, guess);
  let t = guess - off;
  const off2 = zoneOffset(tz, t);
  if (off2 !== off) t = guess - off2;
  return t;
}

const validZone = (tz) => {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};
const serverZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function addDays({ y, m, d, h, mi }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h, mi };
}
const weekday = ({ y, m, d }) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

// A repeat rule (stored as JSON on the chore):
//   { freq: 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly',
//     interval: 1,                         every N days / weeks / months / years
//     days: [0-6],                         weekly: which weekdays
//     monthBy: 'day' | 'nth' | 'last',     monthly: on day 15 / the 3rd Tuesday / the last Friday
//     monthDay, nth, weekday,              (worked out from the first deadline)
//     anchor: 'YYYY-MM-DD',                the first deadline's date (for "every 2 weeks" etc.)
//     from: 'schedule' | 'done',           'done': the next one is due N after it was done
//     until: 'YYYY-MM-DD' | count: N,      ends on a date (inclusive) or after N times
//     seq: 1 }                             which time this is (for count)
// Older rules ({ freq } with days/monthDay) still work: interval 1, on the schedule.
const ymdOf = ({ y, m, d }) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const parseYmdW = (s) => { const [y, m, d] = String(s).split('-').map(Number); return { y, m, d }; };
const dayNumber = ({ y, m, d }) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);
const lastOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function addMonths(w, n) {
  const i = w.y * 12 + (w.m - 1) + n;
  return { ...w, y: Math.floor(i / 12), m: (i % 12) + 1 };
}
/** The nth (1–4) or last (-1) `weekday` of a month. */
function nthWeekday(y, m, nth, wd) {
  if (nth === -1) {
    const last = lastOfMonth(y, m);
    const lw = weekday({ y, m, d: last });
    return last - ((lw - wd + 7) % 7);
  }
  const first = weekday({ y, m, d: 1 });
  return 1 + ((wd - first + 7) % 7) + (nth - 1) * 7;
}

function step(w, repeat) {
  const n = Math.max(1, repeat.interval ?? 1);
  switch (repeat.freq) {
    case 'daily': return addDays(w, n);
    case 'weekdays': {
      let x = addDays(w, 1);
      while (weekday(x) === 0 || weekday(x) === 6) x = addDays(x, 1);
      return x;
    }
    case 'weekly': {
      const days = new Set(repeat.days?.length ? repeat.days : [weekday(w)]);
      // weeks count from the Sunday of the first deadline's week
      const anchor = repeat.anchor ? parseYmdW(repeat.anchor) : w;
      const week0 = dayNumber(anchor) - weekday(anchor);
      let x = addDays(w, 1);
      for (let i = 0; i < 7 * n + 7; i++, x = addDays(x, 1)) {
        const weekIndex = Math.floor((dayNumber(x) - weekday(x) - week0) / 7);
        if (days.has(weekday(x)) && weekIndex % n === 0) return x;
      }
      return null;
    }
    case 'monthly': {
      const t = addMonths(w, n);
      const by = repeat.monthBy ?? 'day';
      if (by === 'nth' || by === 'last') return { ...t, d: nthWeekday(t.y, t.m, by === 'last' ? -1 : repeat.nth, repeat.weekday) };
      return { ...t, d: Math.min(repeat.monthDay ?? w.d, lastOfMonth(t.y, t.m)) };
    }
    case 'yearly': {
      const day = repeat.monthDay ?? w.d;
      const t = { ...w, y: w.y + n };
      return { ...t, d: Math.min(day, lastOfMonth(t.y, t.m)) };
    }
    default: return null;
  }
}

/** The next deadline of a repeating chore after `after` (ms), or null if it doesn't repeat (or has ended). */
export function nextDue(due, repeat, tz, after) {
  if (!repeat || repeat.freq === 'none') return null;
  let w = wallParts(due, tz);
  for (let i = 0; i < 4000; i++) {
    w = step(w, repeat);
    if (!w) return null;
    if (repeat.until && ymdOf(w) > repeat.until) return null;
    const t = fromWall(w, tz);
    if (t > after) return t;
  }
  return null;
}

/**
 * Where a repeating chore goes after one is finished or skipped: { due, repeat } for the next one,
 * or null when it has ended. `doneAt` matters for "N after it's done" rules.
 */
export function advance(row, doneAt, after) {
  const repeat = row.repeat ? (typeof row.repeat === 'string' ? JSON.parse(row.repeat) : row.repeat) : null;
  if (!repeat) return null;
  const seq = (repeat.seq ?? 1) + 1;
  if (repeat.count && seq > repeat.count) return null;
  let due;
  if (repeat.from === 'done') {
    // N days / weeks / months after the day it was done, at the usual time of day
    const time = wallParts(row.due, row.tz);
    const doneDay = wallParts(doneAt, row.tz);
    let w = { ...doneDay, h: time.h, mi: time.mi };
    const n = Math.max(1, repeat.interval ?? 1);
    w = repeat.freq === 'weekly' ? addDays(w, 7 * n) : repeat.freq === 'monthly' ? addMonths(w, n)
      : repeat.freq === 'yearly' ? addMonths(w, 12 * n) : addDays(w, n);
    if (repeat.freq === 'monthly' || repeat.freq === 'yearly') w.d = Math.min(w.d, lastOfMonth(w.y, w.m));
    if (repeat.until && ymdOf(w) > repeat.until) return null;
    due = fromWall(w, row.tz);
  } else {
    due = nextDue(row.due, repeat, row.tz, after);
  }
  if (due == null) return null;
  return { due, repeat: { ...repeat, seq } };
}

/** Turn the form's repeat fields into a rule (null for "doesn't repeat"). */
export function readRepeat(input, due, tz) {
  const w = wallParts(due, tz);
  let freq = String(input.repeat ?? 'none');
  if (freq === 'none' || !freq) return null;
  const rule = { anchor: ymdOf(w) };
  let interval = 1;
  if (freq === 'custom') {
    freq = ['daily', 'weekly', 'monthly', 'yearly'].includes(input.unit) ? input.unit : 'daily';
    interval = whole(input.interval ?? 1, '“Every”', 1, 365);
    rule.from = input.from === 'done' ? 'done' : 'schedule';
  } else if (!['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(freq)) {
    throw new ChoreError('Pick how the chore repeats.');
  }
  rule.freq = freq;
  if (interval > 1) rule.interval = interval;
  if (rule.from !== 'done') {
    delete rule.from;
    if (freq === 'weekly') {
      const days = [...new Set((Array.isArray(input.days) ? input.days : [input.days]).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
      rule.days = days.length ? days : [weekday(w)];
    }
    if (freq === 'monthly') {
      const by = ['day', 'nth', 'last'].includes(input.monthBy) ? input.monthBy : 'day';
      rule.monthBy = by;
      if (by === 'day') rule.monthDay = w.d;
      else {
        rule.weekday = weekday(w);
        if (by === 'nth') {
          rule.nth = Math.ceil(w.d / 7);
          if (rule.nth > 4) throw new ChoreError('There isn’t a 5th one every month. Choose “the last” instead.');
        } else if (w.d + 7 <= lastOfMonth(w.y, w.m)) throw new ChoreError('The first deadline isn’t the last one of its month.');
      }
    }
    if (freq === 'yearly') rule.monthDay = w.d;
  } else {
    rule.from = 'done';
  }
  if (input.ends === 'on') {
    const until = String(input.until ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new ChoreError('Pick the date the repeat ends.');
    if (until < rule.anchor) throw new ChoreError('The repeat ends before the first deadline.');
    rule.until = until;
  } else if (input.ends === 'after') {
    rule.count = whole(input.count, 'The number of times', 1, 999);
    rule.seq = 1;
  }
  return rule;
}

// ---------- reading ----------
const names = (db) => new Map(db.prepare('SELECT id, name, role FROM users').all().map((u) => [u.id, u]));

function choreOut(r) {
  return {
    id: r.id, title: r.title, notes: r.notes, assignee: r.assignee, points: r.points, due: r.due,
    repeat: r.repeat ? JSON.parse(r.repeat) : null, tz: r.tz, status: r.status, submittedAt: r.submitted_at,
    createdBy: r.created_by
  };
}

export function balanceOf(db, userId) {
  return db.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM points WHERE user_id = ?').get(userId).n;
}

/**
 * Everything the chores pages need for `user`. Children only get their own chores, history,
 * rewards and points; adults get everyone's, plus what's waiting for review.
 */
export function getState(db, user) {
  const adult = isAdult(user) || user?.role === 'kiosk'; // the kiosk shows the whole household
  const since = Date.now() - HISTORY_DAYS * 86400000;
  const mine = (sql) => (adult ? sql : `${sql} AND assignee = ?`);
  const args = (...a) => (adult ? a : [...a, user.id]);

  const chores = db.prepare(mine('SELECT * FROM chores WHERE active = 1') + ' ORDER BY due').all(...args()).map(choreOut);
  const history = db.prepare(mine('SELECT * FROM chore_history WHERE at > ?') + ' ORDER BY at DESC LIMIT 200').all(...args(since))
    .map((h) => ({ id: h.id, choreId: h.chore_id, title: h.title, assignee: h.assignee, due: h.due, doneAt: h.done_at,
      outcome: h.outcome, points: h.points, possible: h.possible, reason: h.reason, reviewedBy: h.reviewed_by, at: h.at }));
  const rewards = db.prepare('SELECT id, name, cost FROM rewards WHERE active = 1 ORDER BY cost, name').all();
  const ledger = db.prepare('SELECT id, delta, kind, note, by_user, at FROM points WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(user.id)
    .map((p) => ({ id: p.id, delta: p.delta, kind: p.kind, note: p.note, by: p.by_user, at: p.at }));
  const balances = {};
  for (const r of db.prepare('SELECT user_id, SUM(delta) AS n FROM points GROUP BY user_id').all()) {
    if (adult || r.user_id === user.id) balances[r.user_id] = r.n;
  }
  if (!(user.id in balances)) balances[user.id] = 0;
  const redemptions = db.prepare(
    adult
      ? "SELECT * FROM redemptions WHERE status = 'pending' OR at > ? ORDER BY at DESC LIMIT 200"
      : "SELECT * FROM redemptions WHERE user_id = ? AND (status = 'pending' OR at > ?) ORDER BY at DESC LIMIT 200"
  ).all(...(adult ? [since] : [user.id, since]))
    .map((r) => ({ id: r.id, rewardId: r.reward_id, name: r.name, cost: r.cost, userId: r.user_id, at: r.at,
      status: r.status, handledBy: r.handled_by, handledAt: r.handled_at }));
  return {
    rev: choresRev(db),
    chores,
    history,
    rewards,
    ledger,
    balances,
    redemptions,
    toReview: adult ? chores.filter((c) => c.status === 'submitted').length : 0,
    toHandOut: adult ? redemptions.filter((r) => r.status === 'pending').length : 0
  };
}

/**
 * Everyone's chores that are overdue or due in the next two days (for the wall tablet's Today view,
 * which shows the whole household's day whoever is signed in). No notes or history.
 */
export function householdChores(db) {
  return db.prepare('SELECT id, title, assignee, points, due, status FROM chores WHERE active = 1 AND due < ? ORDER BY due')
    .all(Date.now() + 2 * 86400000)
    .map((c) => ({ id: c.id, title: c.title, assignee: c.assignee, points: c.points, due: c.due, status: c.status }));
}

// ---------- validating input ----------
function text(v, label, max, required = true) {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (required && !s) throw new ChoreError(`Enter ${label}.`);
  if (s.length > max) throw new ChoreError(`${label[0].toUpperCase()}${label.slice(1)} can be at most ${max} characters.`);
  return s;
}
function whole(v, label, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ChoreError(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

function readChoreInput(db, input) {
  const title = text(input.title, 'a name for the chore', 100);
  const notes = String(input.notes ?? '').trim().slice(0, 500);
  const points = whole(input.points ?? 0, 'Points', 0, 10000);
  const assignee = String(input.assignee ?? '');
  const person = db.prepare('SELECT id, disabled, role FROM users WHERE id = ?').get(assignee);
  if (!person || person.role === 'kiosk') throw new ChoreError('Pick who the chore is for.');
  if (person.disabled) throw new ChoreError('That person’s account is turned off.');
  const due = Date.parse(input.due);
  if (!Number.isFinite(due)) throw new ChoreError('Pick a deadline.');
  const tz = validZone(input.tz) ? input.tz : serverZone();
  const repeat = readRepeat(input, due, tz);
  return { title, notes, points, assignee, due, tz, repeat };
}

function requireAdult(user, what = 'do that') {
  if (!isAdult(user)) throw new ChoreForbidden(`Only parents can ${what}.`);
}

const getChore = (db, id) => db.prepare('SELECT * FROM chores WHERE id = ? AND active = 1').get(String(id ?? ''));
const nameOf = (db, id) => names(db).get(id)?.name ?? 'someone';

// ---------- chores ----------
export function createChore(db, actor, input) {
  requireAdult(actor, 'add chores');
  const c = readChoreInput(db, input);
  return change(db, actor, (log) => {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO chores (id, title, notes, assignee, points, due, repeat, tz, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, c.title, c.notes, c.assignee, c.points, c.due, c.repeat ? JSON.stringify(c.repeat) : null, c.tz, actor.id, now, now);
    log.push({ kind: 'chore.added', details: { title: c.title, for: nameOf(db, c.assignee), points: c.points, due: new Date(c.due).toISOString(), repeat: c.repeat?.freq } });
    return id;
  });
}

export function updateChore(db, actor, id, input) {
  requireAdult(actor, 'change chores');
  const row = getChore(db, id);
  if (!row) throw new ChoreError('That chore no longer exists.');
  const c = readChoreInput(db, input);
  const old = row.repeat ? JSON.parse(row.repeat) : null;
  if (c.repeat?.count && old?.count === c.repeat.count && old.seq) c.repeat.seq = old.seq; // same "after N times": keep counting
  if (c.repeat && old?.anchor && old.freq === c.repeat.freq && old.interval === c.repeat.interval) c.repeat.anchor = old.anchor; // keep the week/month rhythm
  const sameRule = (a, b) => JSON.stringify({ ...a, seq: 0, anchor: 0 }) === JSON.stringify({ ...b, seq: 0, anchor: 0 });
  return change(db, actor, (log) => {
    db.prepare(`UPDATE chores SET title = ?, notes = ?, assignee = ?, points = ?, due = ?, repeat = ?, tz = ?, updated_at = ?,
                status = CASE WHEN assignee = ? THEN status ELSE 'open' END WHERE id = ?`)
      .run(c.title, c.notes, c.assignee, c.points, c.due, c.repeat ? JSON.stringify(c.repeat) : null, c.tz, Date.now(), c.assignee, row.id);
    const fields = [];
    if (row.title !== c.title) fields.push('name');
    if (row.assignee !== c.assignee) fields.push('person');
    if (row.points !== c.points) fields.push('points');
    if (row.due !== c.due) fields.push('deadline');
    if (!!old !== !!c.repeat || (old && !sameRule(old, c.repeat))) fields.push('repeat');
    if (row.notes !== c.notes) fields.push('notes');
    if (fields.length) log.push({ kind: 'chore.changed', details: { title: c.title, from: row.title !== c.title ? row.title : undefined, fields, for: nameOf(db, c.assignee) } });
  });
}

export function deleteChore(db, actor, id) {
  requireAdult(actor, 'remove chores');
  const row = getChore(db, id);
  if (!row) throw new ChoreError('That chore no longer exists.');
  change(db, actor, (log) => {
    db.prepare('UPDATE chores SET active = 0, updated_at = ? WHERE id = ?').run(Date.now(), row.id);
    log.push({ kind: 'chore.deleted', details: { title: row.title, for: nameOf(db, row.assignee) } });
  });
}

/** Record the result, award points, and move a repeating chore to its next deadline. */
function finalize(db, row, { outcome, points, reason = null, reviewer = null, doneAt }) {
  const now = Date.now();
  db.prepare(`INSERT INTO chore_history (chore_id, title, assignee, due, done_at, outcome, points, possible, reason, reviewed_by, at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.title, row.assignee, row.due, doneAt, outcome, points, row.points, reason, reviewer, now);
  if (points > 0) {
    db.prepare("INSERT INTO points (user_id, delta, kind, ref, note, by_user, at) VALUES (?, ?, 'chore', ?, ?, ?, ?)")
      .run(row.assignee, points, row.id, row.title, reviewer, now);
  }
  const next = advance(row, doneAt ?? now, Math.max(now, row.due));
  if (next) db.prepare("UPDATE chores SET due = ?, repeat = ?, status = 'open', submitted_at = NULL, updated_at = ? WHERE id = ?").run(next.due, JSON.stringify(next.repeat), now, row.id);
  else db.prepare("UPDATE chores SET status = 'done', active = 0, updated_at = ? WHERE id = ?").run(now, row.id);
  return next?.due ?? null;
}

/**
 * The assigned person (or a parent) marks a chore done. A child's goes to review.
 * `ownOnly` (the kiosk): only the person it's for can mark it done; a parent can still approve one
 * that's waiting for review.
 */
export function completeChore(db, actor, id, { ownOnly = false } = {}) {
  const row = getChore(db, id);
  if (!row) throw new ChoreError('That chore no longer exists.');
  if (ownOnly && row.status !== 'submitted' && row.assignee !== actor.id) {
    throw new ChoreForbidden(`On the tablet, only ${names(db).get(row.assignee)?.name ?? 'the person it’s for'} can mark this done, with their PIN.`);
  }
  const adult = isAdult(actor);
  if (!adult && row.assignee !== actor.id) throw new ChoreForbidden('You can only finish your own chores.');
  if (!adult && row.status === 'submitted') throw new ChoreError('That’s already waiting for a parent to check.');
  const people = names(db);
  return change(db, actor, (log) => {
    const now = Date.now();
    const childChore = people.get(row.assignee)?.role === 'child';
    if (!adult) {
      db.prepare("UPDATE chores SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.id);
      log.push({ kind: 'chore.submitted', details: { title: row.title, late: now > row.due || undefined } });
      return { status: 'submitted' };
    }
    const doneAt = row.status === 'submitted' ? row.submitted_at : now;
    const outcome = childChore ? 'approved' : 'done';
    finalize(db, row, { outcome, points: row.points, reviewer: actor.id, doneAt });
    log.push({ kind: childChore ? 'chore.reviewed' : 'chore.done', details: {
      title: row.title, for: people.get(row.assignee)?.name, outcome, points: row.points, possible: row.points,
      self: row.assignee === actor.id || undefined
    } });
    return { status: outcome };
  });
}

/** A child takes back "done" before it's been reviewed. */
export function unsubmitChore(db, actor, id) {
  const row = getChore(db, id);
  if (!row || row.status !== 'submitted') throw new ChoreError('That chore isn’t waiting for review.');
  if (row.assignee !== actor.id && !isAdult(actor)) throw new ChoreForbidden('You can only change your own chores.');
  change(db, actor, (log) => {
    db.prepare("UPDATE chores SET status = 'open', submitted_at = NULL, updated_at = ? WHERE id = ?").run(Date.now(), row.id);
    log.push({ kind: 'chore.unsubmitted', details: { title: row.title } });
  });
}

/**
 * A parent finalizes a child's finished chore: 'approve' (full points), 'adjust' (more or fewer
 * points than the chore is worth, reason required: a bonus or a reduction) or 'deny' (no points,
 * reason required). 'reduce' is accepted as another name for 'adjust'.
 */
export function reviewChore(db, actor, id, { decision, points, reason }) {
  requireAdult(actor, 'review chores');
  const row = getChore(db, id);
  if (!row || row.status !== 'submitted') throw new ChoreError('That chore isn’t waiting for review any more.');
  const why = String(reason ?? '').trim().replace(/\s+/g, ' ').slice(0, 300);
  let award, outcome;
  if (decision === 'approve') { award = row.points; outcome = 'approved'; }
  else if (decision === 'adjust' || decision === 'reduce') {
    award = whole(points, 'Points', 0, 10000);
    if (award === row.points) { outcome = 'approved'; }
    else {
      outcome = award > row.points ? 'bonus' : 'reduced';
      if (!why) throw new ChoreError(award > row.points ? 'Say what earned the extra points.' : 'Say why the points were reduced.');
    }
  } else if (decision === 'deny') {
    award = 0; outcome = 'denied';
    if (!why) throw new ChoreError('Say why it wasn’t accepted.');
  } else throw new ChoreError('Choose approve, change points or don’t accept.');
  const people = names(db);
  change(db, actor, (log) => {
    finalize(db, row, { outcome, points: award, reason: why || null, reviewer: actor.id, doneAt: row.submitted_at });
    log.push({ kind: 'chore.reviewed', details: {
      title: row.title, for: people.get(row.assignee)?.name, outcome, points: award, possible: row.points, reason: why || undefined
    } });
  });
}

/** A parent skips one occurrence of a repeating chore (a holiday, a sick day): no points, next one becomes due. */
export function skipChore(db, actor, id, reason) {
  requireAdult(actor, 'skip chores');
  const row = getChore(db, id);
  if (!row) throw new ChoreError('That chore no longer exists.');
  if (!row.repeat) throw new ChoreError('Only repeating chores can be skipped. Remove it instead.');
  const why = String(reason ?? '').trim().replace(/\s+/g, ' ').slice(0, 300);
  const people = names(db);
  return change(db, actor, (log) => {
    const now = Date.now();
    // the very next one, even if that's already past ("after it's done" rules count from today)
    const nx = advance(row, now, row.due);
    const next = nx?.due ?? null;
    db.prepare(`INSERT INTO chore_history (chore_id, title, assignee, due, done_at, outcome, points, possible, reason, reviewed_by, at)
                VALUES (?, ?, ?, ?, ?, 'skipped', 0, ?, ?, ?, ?)`).run(row.id, row.title, row.assignee, row.due, now, row.points, why || null, actor.id, now);
    if (nx) db.prepare("UPDATE chores SET due = ?, repeat = ?, status = 'open', submitted_at = NULL, updated_at = ? WHERE id = ?").run(nx.due, JSON.stringify(nx.repeat), now, row.id);
    else db.prepare("UPDATE chores SET status = 'done', active = 0, updated_at = ? WHERE id = ?").run(now, row.id);
    log.push({ kind: 'chore.skipped', details: { title: row.title, for: people.get(row.assignee)?.name, due: new Date(row.due).toISOString(), reason: why || undefined } });
    return { next };
  });
}

/**
 * A parent changes the points of a chore they already reviewed (within 14 days), e.g. after a mistake.
 * The difference is added or taken away; a reason is needed unless it's back to full points.
 */
export function reviseReview(db, actor, historyId, { points, reason }) {
  requireAdult(actor, 'change reviews');
  const h = db.prepare('SELECT * FROM chore_history WHERE id = ?').get(Number(historyId));
  if (!h || !['approved', 'reduced', 'bonus', 'denied', 'done'].includes(h.outcome)) throw new ChoreError('That result can’t be changed.');
  if (Date.now() - h.at > 14 * 86400000) throw new ChoreError('Results older than 14 days can’t be changed. An admin can correct points instead.');
  const award = whole(points, 'Points', 0, 10000);
  const why = String(reason ?? '').trim().replace(/\s+/g, ' ').slice(0, 300);
  if (award === h.points) throw new ChoreError('That’s the same number of points as before.');
  if (award !== h.possible && !why) throw new ChoreError('Say why the points changed.');
  const people = names(db);
  return change(db, actor, (log) => {
    const delta = award - h.points;
    if (delta < 0) {
      const balance = balanceOf(db, h.assignee);
      if (balance + delta < 0) throw new ChoreError(`${people.get(h.assignee)?.name ?? 'They'} already spent some of those points (${balance} left), so at most ${balance} can be taken back. An admin can correct the rest.`);
    }
    const outcome = award === 0 ? 'denied' : award === h.possible ? 'approved' : award > h.possible ? 'bonus' : 'reduced';
    db.prepare('UPDATE chore_history SET points = ?, outcome = ?, reason = ?, reviewed_by = ? WHERE id = ?')
      .run(award, outcome, why || null, actor.id, h.id);
    db.prepare("INSERT INTO points (user_id, delta, kind, ref, note, by_user, at) VALUES (?, ?, 'chore', ?, ?, ?, ?)")
      .run(h.assignee, delta, h.chore_id, `${h.title} (changed)`, actor.id, Date.now());
    log.push({ kind: 'chore.revised', details: { title: h.title, for: people.get(h.assignee)?.name, from: h.points, points: award, possible: h.possible, reason: why || undefined } });
    return { delta };
  });
}

/**
 * What needs this person's attention, for badges and reminders: their open chores, results of their
 * chores reviewed in the last 2 days, and (for parents) what's waiting for review or hand-out.
 */
export function attentionSummary(db, user) {
  const adult = isAdult(user);
  const now = Date.now();
  const mine = db.prepare("SELECT id, title, due, status FROM chores WHERE active = 1 AND assignee = ? ORDER BY due").all(user.id);
  const results = db.prepare("SELECT id, title, outcome, points, possible, reviewed_by, reason, at FROM chore_history WHERE assignee = ? AND at > ? AND outcome != 'done' ORDER BY id DESC LIMIT 20")
    .all(user.id, now - 2 * 86400000)
    .map((h) => ({ id: h.id, title: h.title, outcome: h.outcome, points: h.points, possible: h.possible, reviewedBy: h.reviewed_by, reason: h.reason, at: h.at }));
  const submitted = adult
    ? db.prepare("SELECT id, title, assignee, submitted_at FROM chores WHERE active = 1 AND status = 'submitted' ORDER BY submitted_at").all()
      .map((c) => ({ id: c.id, title: c.title, assignee: c.assignee, at: c.submitted_at }))
    : [];
  const handOut = adult ? db.prepare("SELECT COUNT(*) AS n FROM redemptions WHERE status = 'pending'").get().n : 0;
  return {
    rev: choresRev(db),
    mine: mine.map((c) => ({ id: c.id, title: c.title, due: c.due, status: c.status })),
    results,
    submitted,
    handOut
  };
}

// ---------- correcting points (admins) ----------
/**
 * Add (positive) or take away (negative) points, e.g. to fix a mistake. Admins only, a reason is
 * required, and a balance can't go below zero.
 */
export function adjustPoints(db, actor, userId, delta, reason) {
  if (actor?.role !== 'admin') throw new ChoreForbidden('Only admins can correct points.');
  const person = db.prepare('SELECT id, name FROM users WHERE id = ?').get(String(userId ?? ''));
  if (!person) throw new ChoreError('That person no longer exists.');
  const n = Number(delta);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 100000) throw new ChoreError('Enter a whole number of points to add (like 5) or take away (like -5).');
  const why = text(reason, 'a reason for the correction', 200);
  return change(db, actor, (log) => {
    const balance = balanceOf(db, person.id);
    if (balance + n < 0) throw new ChoreError(`${person.name} only has ${balance} point${balance === 1 ? '' : 's'}, so you can take away at most ${balance}.`);
    db.prepare("INSERT INTO points (user_id, delta, kind, ref, note, by_user, at) VALUES (?, ?, 'adjust', NULL, ?, ?, ?)")
      .run(person.id, n, why, actor.id, Date.now());
    log.push({ kind: 'points.adjusted', details: { for: person.name, delta: n, reason: why, balance: balance + n } });
    return { balance: balance + n };
  });
}

/** Each person's balance and their most recent point changes, for the admin panel. */
export function pointsSummary(db, recent = 8) {
  const balances = Object.fromEntries(db.prepare('SELECT user_id, SUM(delta) AS n FROM points GROUP BY user_id').all().map((r) => [r.user_id, r.n]));
  const rows = db.prepare(`
    SELECT * FROM (SELECT p.*, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id DESC) AS rn FROM points p) WHERE rn <= ? ORDER BY id DESC`).all(recent);
  const history = {};
  for (const r of rows) (history[r.user_id] ??= []).push({ id: r.id, delta: r.delta, kind: r.kind, note: r.note, by: r.by_user, at: r.at });
  return { balances, history };
}

// ---------- rewards ----------
export function addReward(db, actor, { name, cost }) {
  requireAdult(actor, 'add rewards');
  const n = text(name, 'a name for the reward', 60);
  const c = whole(cost, 'The cost', 1, 100000);
  return change(db, actor, (log) => {
    const id = randomUUID();
    db.prepare('INSERT INTO rewards (id, name, cost, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, n, c, actor.id, Date.now());
    log.push({ kind: 'reward.added', details: { name: n, cost: c } });
    return id;
  });
}

export function removeReward(db, actor, id) {
  requireAdult(actor, 'remove rewards');
  const r = db.prepare('SELECT * FROM rewards WHERE id = ? AND active = 1').get(String(id ?? ''));
  if (!r) throw new ChoreError('That reward no longer exists.');
  change(db, actor, (log) => {
    db.prepare('UPDATE rewards SET active = 0 WHERE id = ?').run(r.id);
    log.push({ kind: 'reward.removed', details: { name: r.name } });
  });
}

/** Spend points on a reward. A parent then marks it given (or refunds it). */
export function redeemReward(db, actor, id) {
  const r = db.prepare('SELECT * FROM rewards WHERE id = ? AND active = 1').get(String(id ?? ''));
  if (!r) throw new ChoreError('That reward isn’t available any more.');
  return change(db, actor, (log) => {
    const balance = balanceOf(db, actor.id); // checked inside the transaction, so it can't be spent twice
    if (balance < r.cost) throw new ChoreError(`You need ${r.cost - balance} more point${r.cost - balance === 1 ? '' : 's'} for that.`);
    const now = Date.now();
    const rid = db.prepare('INSERT INTO redemptions (reward_id, name, cost, user_id, at) VALUES (?, ?, ?, ?, ?)').run(r.id, r.name, r.cost, actor.id, now).lastInsertRowid;
    db.prepare("INSERT INTO points (user_id, delta, kind, ref, note, by_user, at) VALUES (?, ?, 'reward', ?, ?, ?, ?)")
      .run(actor.id, -r.cost, String(rid), r.name, actor.id, now);
    log.push({ kind: 'reward.redeemed', details: { name: r.name, cost: r.cost } });
    return Number(rid);
  });
}

/** A parent hands over a reward ('given'), or gives the points back ('refund'). The person can cancel their own. */
export function handleRedemption(db, actor, id, action) {
  const r = db.prepare("SELECT * FROM redemptions WHERE id = ? AND status = 'pending'").get(Number(id));
  if (!r) throw new ChoreError('That reward has already been handled.');
  const own = r.user_id === actor.id;
  if (action === 'given') requireAdult(actor, 'mark rewards as given');
  else if (action === 'refund') { if (!isAdult(actor) && !own) throw new ChoreForbidden('You can only cancel your own rewards.'); }
  else throw new ChoreError('Choose given or refund.');
  const people = names(db);
  change(db, actor, (log) => {
    const now = Date.now();
    db.prepare('UPDATE redemptions SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?')
      .run(action === 'given' ? 'given' : 'refunded', actor.id, now, r.id);
    if (action === 'refund') {
      db.prepare("INSERT INTO points (user_id, delta, kind, ref, note, by_user, at) VALUES (?, ?, 'refund', ?, ?, ?, ?)")
        .run(r.user_id, r.cost, String(r.id), r.name, actor.id, now);
    }
    log.push({ kind: action === 'given' ? 'reward.given' : 'reward.refunded', details: { name: r.name, cost: r.cost, for: people.get(r.user_id)?.name, self: own || undefined } });
  });
}
