// src/lib/server/activity.js — the activity log shown on the admin panel: who added, changed or
// deleted events, grocery/chore items, calendars and accounts. Entries store structured details
// (not finished sentences) so the browser can show dates in its own time zone; see $lib/activityText.js.
//
// Kept for 180 days (and at most 20,000 entries).

const KEEP_DAYS = 180;
const KEEP_MAX = 20000;
const GROUP_OVER = 3; // more than this many of the same thing in one save → one summary line

const prepared = new WeakSet();
function ensure(db) {
  if (prepared.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        INTEGER NOT NULL,
      user_id   TEXT,
      user_name TEXT,
      area      TEXT NOT NULL,
      kind      TEXT NOT NULL,
      details   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_by_time ON activity (at);
    CREATE INDEX IF NOT EXISTS activity_by_user ON activity (user_id, at);
  `);
  prepared.add(db);
}

// kinds that can be folded into one "bulk" line, and the bulk kind they fold into
const BULK = {
  'event.added': ['events.bulk', 'added'],
  'event.changed': ['events.bulk', 'changed'],
  'event.deleted': ['events.bulk', 'deleted'],
  'item.added': ['items.bulk', 'added'],
  'item.checked': ['items.bulk', 'checked'],
  'item.unchecked': ['items.bulk', 'unchecked'],
  'item.deleted': ['items.bulk', 'deleted'],
  'item.changed': ['items.bulk', 'changed'],
  'item.renamed': ['items.bulk', 'changed']
};

/** Fold large groups of the same action (an import, "Clear all") into single summary entries. */
function compact(entries) {
  const groups = new Map();
  for (const e of entries) {
    const b = BULK[e.kind];
    const key = b ? `${b[0]}|${b[1]}|${e.details.private ? '' : e.details.calendar ?? ''}|${!!e.details.private}` : null;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const folded = new Set();
  const out = [];
  for (const e of entries) {
    if (folded.has(e)) continue;
    const b = BULK[e.kind];
    const key = b ? `${b[0]}|${b[1]}|${e.details.private ? '' : e.details.calendar ?? ''}|${!!e.details.private}` : null;
    const group = key ? groups.get(key) : null;
    if (group && group.length > GROUP_OVER) {
      group.forEach((g) => folded.add(g));
      out.push({
        kind: b[0],
        details: { action: b[1], count: group.length, ...(e.details.private ? { private: true } : e.details.calendar ? { calendar: e.details.calendar } : {}) }
      });
    } else {
      out.push(e);
    }
  }
  return out;
}

/**
 * Record what `user` did. `entries` are { kind, details }. Call inside the same transaction as the
 * change itself so the log can't disagree with the data. Does nothing without a user (internal changes).
 */
export function logActivity(db, user, area, entries) {
  if (!user || !entries.length) return;
  ensure(db);
  const insert = db.prepare('INSERT INTO activity (at, user_id, user_name, area, kind, details) VALUES (?, ?, ?, ?, ?, ?)');
  const now = Date.now();
  for (const e of compact(entries)) insert.run(now, user.id, user.name ?? user.username ?? '', area, e.kind, JSON.stringify(e.details));
  if (Math.random() < 0.02) pruneActivity(db);
}

export function pruneActivity(db) {
  ensure(db);
  db.prepare('DELETE FROM activity WHERE at < ?').run(Date.now() - KEEP_DAYS * 86400000);
  db.prepare('DELETE FROM activity WHERE id <= (SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET ?)').run(KEEP_MAX);
}

/** Newest first. Filters: userId, area; `before` = an entry id to page back from. */
export function listActivity(db, { userId = null, area = null, before = null, limit = 100 } = {}) {
  ensure(db);
  const where = [], args = [];
  if (userId) { where.push('user_id = ?'); args.push(userId); }
  if (area) { where.push('area = ?'); args.push(area); }
  if (before) { where.push('id < ?'); args.push(Number(before)); }
  const rows = db.prepare(`SELECT * FROM activity ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit + 1);
  return {
    entries: rows.slice(0, limit).map((r) => ({
      id: r.id, at: r.at, userId: r.user_id, userName: r.user_name, area: r.area, kind: r.kind, details: JSON.parse(r.details)
    })),
    more: rows.length > limit
  };
}

// ---------- describing changes (used by calendarDb.js and collections.js) ----------
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** What changed between two versions of an event: field names like 'time', 'title', 'calendar'. */
export function eventFields(a, b) {
  const f = [];
  if ((a.title ?? '') !== (b.title ?? '')) f.push('title');
  if (a.start !== b.start || a.end !== b.end || !!a.allDay !== !!b.allDay) f.push('time');
  if (a.calendar !== b.calendar) f.push('calendar');
  if ((a.location ?? '') !== (b.location ?? '')) f.push('location');
  if ((a.notes ?? '') !== (b.notes ?? '')) f.push('notes');
  if (!same(a.repeat, b.repeat)) f.push('repeat');
  return f;
}

/** Dates newly skipped in a repeating event ("delete this one"). */
export function newExdates(a, b) {
  const before = new Set(a.exdates ?? []);
  return (b.exdates ?? []).filter((d) => !before.has(d));
}

export function calendarFields(a, b) {
  const f = [];
  if (a.label !== b.label) f.push('name');
  if (a.color !== b.color) f.push('color');
  if (!!a.private !== !!b.private) f.push(b.private ? 'made private' : 'shared');
  else if (a.private && JSON.stringify([...(a.sharedWith ?? [])].sort()) !== JSON.stringify([...(b.sharedWith ?? [])].sort())) f.push('people');
  if ((a.source?.url ?? '') !== (b.source?.url ?? '')) f.push('address');
  return f;
}
