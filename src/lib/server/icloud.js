// src/lib/server/icloud.js — two-way sync between Famner calendars and Apple iCloud calendars.
//
// Each person can connect their own iCloud account (Apple ID + an app-specific password, which is
// stored encrypted, see secrets.js) and link Famner calendars to iCloud calendars, one to one.
// A linked calendar is synced every few minutes (ICLOUD_SYNC_MINUTES, default 5) and a few seconds
// after it changes in Famner. iCloud can't tell other servers about changes, so changes made on an
// iPhone show up in Famner at the next check.
//
// How a sync works (syncCalendar):
//   1. pull: ask iCloud which events changed (its change tag, then each event's etag) and download those;
//   2. apply them to Famner. If an event changed on both sides since the last sync, the newer change
//      wins (iCloud's LAST-MODIFIED against Famner's own save time);
//   3. push: send Famner's changes. An existing iCloud event is edited in place, so what Famner
//      doesn't show (alerts, invitees, links, travel time…) stays as it was.
// Tables: icloud_accounts (one per person), icloud_links (Famner calendar ↔ iCloud calendar),
// icloud_resources (the last copy of each iCloud event file and its etag) and icloud_items (which
// Famner event is which part of which file, and a fingerprint of how it looked after the last sync).
//
// Repeating events: a moved or edited occurrence in iCloud is its own one-off event in Famner (and
// that date is skipped in the series), the way Famner shows them anyway; edits to it go back to the
// same occurrence in iCloud. Repeat rules Famner can't show (e.g. "the 5th and 20th of each month")
// appear as their first date only, and their rule is left alone in iCloud.
// Changes from iCloud aren't checked against Famner's roles: whoever links a calendar decides who
// can change it, by who they share the iCloud calendar with.
import { createHash, randomUUID } from 'node:crypto';
import { getDb, applyChanges, subscribe, ValidationError, ForbiddenError } from './calendarDb.js';
import { caldavClient, CalDavError } from './caldav.js';
import { encryptSecret, decryptSecret } from './secrets.js';
import {
  parseICS, parseLine, parseIcsDate, icsEscape, icsDate, icsUtc, fold, rrule, pad, parseYmd, atMinute, minOfDay, normalizeRepeat
} from '../components/calendarUtils.js';

export const ICLOUD_SERVER = 'https://caldav.icloud.com/';
const ORIGIN = 'icloud';
const ADULT = new Set(['admin', 'parent']);
const LIMITS = { notes: 20000, title: 500, location: 1000 };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS icloud_accounts (
    user_id      TEXT PRIMARY KEY,
    apple_id     TEXT NOT NULL,
    secret       TEXT NOT NULL,
    server       TEXT NOT NULL,
    home         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'ok',
    error        TEXT,
    connected_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS icloud_links (
    calendar_id TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    remote_url  TEXT NOT NULL UNIQUE,
    remote_name TEXT NOT NULL,
    ctag        TEXT,
    synced_at   INTEGER,
    error       TEXT,
    warnings    TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS icloud_resources (
    calendar_id TEXT NOT NULL,
    href        TEXT NOT NULL,
    etag        TEXT,
    raw         TEXT NOT NULL,
    PRIMARY KEY (calendar_id, href)
  );
  CREATE TABLE IF NOT EXISTS icloud_items (
    calendar_id TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    href        TEXT NOT NULL,
    rid         TEXT NOT NULL DEFAULT '',
    hash        TEXT NOT NULL,
    PRIMARY KEY (calendar_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS icloud_items_by_href ON icloud_items (calendar_id, href);
`;

const prepared = new WeakSet();
/** The app database with the iCloud tables ready. */
export function icloudDb(path) {
  const db = getDb(path);
  if (!prepared.has(db)) {
    db.exec(SCHEMA);
    prepared.add(db);
  }
  return db;
}

export class ICloudError extends Error {}

// ---------- iCalendar files as a tree we can edit without losing anything ----------
function parseComponents(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((l) => l.trim());
  const root = { name: '#root', props: [], comps: [] };
  const stack = [root];
  for (const raw of lines) {
    const p = parseLine(raw);
    const top = stack[stack.length - 1];
    if (p.name === 'BEGIN') {
      const c = { name: p.value.trim().toUpperCase(), props: [], comps: [] };
      top.comps.push(c);
      stack.push(c);
    } else if (p.name === 'END') {
      if (stack.length > 1) stack.pop();
    } else {
      top.props.push({ ...p, raw });
    }
  }
  return root.comps.find((c) => c.name === 'VCALENDAR') ?? { name: 'VCALENDAR', props: [], comps: root.comps };
}
function writeComponent(c, out = []) {
  out.push(`BEGIN:${c.name}`);
  for (const p of c.props) out.push(p.raw);
  for (const k of c.comps) writeComponent(k, out);
  out.push(`END:${c.name}`);
  return out;
}
const writeCalendar = (cal) => writeComponent(cal).map(fold).join('\r\n') + '\r\n';
const prop = (c, name) => c.props.find((p) => p.name === name) ?? null;
const lineProp = (raw) => ({ ...parseLine(raw), raw });
const ridOf = (c) => {
  const p = prop(c, 'RECURRENCE-ID');
  const d = p && parseIcsDate(p.value, p.params);
  return d ? ymd(d.date) : '';
};
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const serverZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// ---------- the household's time zone, written out for iCloud ----------
const offsetAt = (zone, ms) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms) / 60000);
};
const fmtOffset = (min) => `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}${pad(Math.abs(min) % 60)}`;
const tzName = (zone, ms) => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName')?.value ?? null;
  } catch { return null; }
};
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** A VTIMEZONE for `zone`, with its daylight-saving rules worked out from this year's changes. */
export function vtimezone(zone, year = new Date().getFullYear()) {
  const changes = [];
  let t = Date.UTC(year, 0, 1);
  let off = offsetAt(zone, t);
  for (let day = 1; day <= 366; day++) {
    const next = Date.UTC(year, 0, 1) + day * 86400000;
    const o = offsetAt(zone, next);
    if (o !== off) {
      let lo = t, hi = next; // the exact minute it changes
      while (hi - lo > 60000) {
        const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
        if (offsetAt(zone, mid) === off) lo = mid; else hi = mid;
      }
      changes.push({ at: hi, from: off, to: o });
      off = o;
    }
    t = next;
  }
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
  if (!changes.length) {
    lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${fmtOffset(off)}`, `TZOFFSETTO:${fmtOffset(off)}`);
    const name = tzName(zone, t);
    if (name) lines.push(`TZNAME:${name}`);
    lines.push('END:STANDARD');
  }
  for (const c of changes) {
    const wall = new Date(c.at + c.from * 60000); // the local time it changes at, before the change (as UTC fields)
    const m = wall.getUTCMonth(), d = wall.getUTCDate(), wd = wall.getUTCDay();
    const dim = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
    const n = d + 7 > dim && d > 21 ? -1 : Math.ceil(d / 7);
    // the same rule in 1970, as the start of the rule
    let day1970;
    if (n === -1) {
      const last = new Date(Date.UTC(1970, m + 1, 0));
      day1970 = last.getUTCDate() - ((last.getUTCDay() - wd + 7) % 7);
    } else {
      const first = new Date(Date.UTC(1970, m, 1)).getUTCDay();
      day1970 = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
    }
    const kind = c.to > c.from ? 'DAYLIGHT' : 'STANDARD';
    lines.push(`BEGIN:${kind}`,
      `DTSTART:1970${pad(m + 1)}${pad(day1970)}T${pad(wall.getUTCHours())}${pad(wall.getUTCMinutes())}${pad(wall.getUTCSeconds())}`,
      `RRULE:FREQ=YEARLY;BYMONTH=${m + 1};BYDAY=${n}${DAYS[wd]}`,
      `TZOFFSETFROM:${fmtOffset(c.from)}`, `TZOFFSETTO:${fmtOffset(c.to)}`);
    const name = tzName(zone, c.at + 3600000);
    if (name) lines.push(`TZNAME:${name}`);
    lines.push(`END:${kind}`);
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

// ---------- Famner events → iCalendar properties ----------
const toDate = (v) => (v instanceof Date ? v : new Date(v));
/** A stored Famner event with real Dates, as the calendar code expects. */
function withDates(e) {
  const x = { ...e, start: toDate(e.start), end: toDate(e.end) };
  if (x.repeat?.until) x.repeat = { ...x.repeat, until: toDate(x.repeat.until) };
  return x;
}
const wallTime = (d) => `${icsDate(d)}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

const TIME_PROPS = ['DTSTART', 'DTEND', 'DURATION'];
const TEXT_PROPS = ['SUMMARY', 'LOCATION', 'DESCRIPTION'];
const RULE_PROPS = ['RRULE', 'EXDATE'];
const STAMP_PROPS = ['DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE'];

function timeLines(ev, zone) {
  if (ev.allDay) return [`DTSTART;VALUE=DATE:${icsDate(ev.start)}`, `DTEND;VALUE=DATE:${icsDate(ev.end)}`];
  if (zone === 'UTC') return [`DTSTART:${icsUtc(ev.start)}`, `DTEND:${icsUtc(ev.end)}`];
  return [`DTSTART;TZID=${zone}:${wallTime(ev.start)}`, `DTEND;TZID=${zone}:${wallTime(ev.end)}`];
}
function textLines(ev) {
  const out = [`SUMMARY:${icsEscape(ev.title || '')}`];
  if (ev.location) out.push(`LOCATION:${icsEscape(ev.location)}`);
  if (ev.notes) out.push(`DESCRIPTION:${icsEscape(ev.notes)}`);
  return out;
}
/** RRULE and EXDATE lines for a repeating event, leaving out dates that have their own occurrence. */
function ruleLines(ev, zone, keepDays = new Set()) {
  const rule = rrule(ev);
  if (!rule) return [];
  const out = [`RRULE:${rule}`];
  for (const d of [...new Set(ev.exdates ?? [])].sort()) {
    if (keepDays.has(d)) continue;
    const day = parseYmd(d);
    if (ev.allDay) out.push(`EXDATE;VALUE=DATE:${icsDate(day)}`);
    else {
      const at = atMinute(day, minOfDay(ev.start));
      out.push(zone === 'UTC' ? `EXDATE:${icsUtc(at)}` : `EXDATE;TZID=${zone}:${wallTime(at)}`);
    }
  }
  return out;
}
function stampLines(old) {
  const now = icsUtc(Date.now());
  const seq = old ? (parseInt(prop(old, 'SEQUENCE')?.value ?? '0', 10) || 0) + 1 : 0;
  return [`DTSTAMP:${now}`, `LAST-MODIFIED:${now}`, `SEQUENCE:${seq}`];
}
/** The dates a component's EXDATE lines skip. */
function skippedDays(c) {
  const out = new Set();
  for (const p of c.props.filter((x) => x.name === 'EXDATE')) {
    for (const part of p.value.split(',')) {
      const d = parseIcsDate(part, p.params);
      if (d) out.add(ymd(d.date));
    }
  }
  return [...out].sort().join();
}
/** Replace `names` in a component with `lines`. */
function replaceProps(c, names, lines) {
  const drop = new Set(names);
  c.props = [...c.props.filter((p) => !drop.has(p.name)), ...lines.map(lineProp)];
}
function ensureZone(cal, zone) {
  if (zone === 'UTC' || cal.comps.some((c) => c.name === 'VTIMEZONE' && prop(c, 'TZID')?.value === zone)) return;
  const tz = parseComponents(['BEGIN:VCALENDAR', ...vtimezone(zone), 'END:VCALENDAR'].join('\n')).comps[0];
  cal.comps.unshift(tz);
}
const usesZone = (cal, zone) => cal.comps.some((c) => c.name === 'VEVENT' && c.props.some((p) => p.params.TZID === zone));

/** A new iCloud event file for a Famner event. */
export function newResource(ev, uid, zone = serverZone()) {
  ev = withDates(ev);
  const cal = parseComponents('BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Famner//Calendar//EN\nCALSCALE:GREGORIAN\nEND:VCALENDAR');
  const ve = { name: 'VEVENT', props: [], comps: [] };
  replaceProps(ve, [], [`UID:${uid}`, `CREATED:${icsUtc(Date.now())}`, ...stampLines(null), ...timeLines(ev, zone), ...textLines(ev), ...ruleLines(ev, zone)]);
  cal.comps.push(ve);
  if (usesZone(cal, zone)) ensureZone(cal, zone);
  return writeCalendar(cal);
}

/**
 * Edit an iCloud event file to match Famner. `master` is the series (or one-off) event, `overrides`
 * maps each moved occurrence's date to its Famner event (null when it was deleted in Famner).
 * When the series itself was moved or its repeat changed, its moved occurrences can't stay attached:
 * they're returned as `detached`, to be saved as their own events.
 */
export function patchResource(raw, master, overrides, { keepRule = false, zone = serverZone() } = {}) {
  master = withDates(master);
  const cal = parseComponents(raw);
  const events = cal.comps.filter((c) => c.name === 'VEVENT');
  const main = events.find((c) => !prop(c, 'RECURRENCE-ID')) ?? events[0];
  if (!main) throw new ICloudError('That iCloud event is empty.');
  // how iCloud has it now: only what changed is rewritten, so iCloud's own wording stays
  const old = new Map(readResource(raw).events.map((r) => [r.rid, r.fields]));
  const sameTime = (a, b) => !!a && Date.parse(a.start) === +b.start && Date.parse(a.end) === +b.end && !!a.allDay === !!b.allDay;
  const sameText = (a, b) => !!a && a.title === (b.title || a.title) && (a.location ?? '') === (b.location ?? '') && (a.notes ?? '') === (b.notes ?? '');
  const repeatKey = (e) => JSON.stringify(normalizeRepeat(e?.repeat ? withDates(e).repeat : null, withDates(e ?? master).start) ?? null, (k, v) => (k === 'until' ? new Date(v).toISOString() : v));

  const kept = new Set();
  for (const [rid, ev] of overrides) if (ev) kept.add(rid);
  const was = old.get('');
  const timeSame = sameTime(was, master);
  const moved = !keepRule && (!timeSame || repeatKey(was) !== repeatKey(master));
  const changes = (c, ev, prev, rules) => {
    const names = [], lines = [];
    if (!sameTime(prev, ev)) { names.push(...TIME_PROPS); lines.push(...timeLines(ev, zone)); }
    if (!sameText(prev, ev)) { names.push(...TEXT_PROPS); lines.push(...textLines(ev)); }
    if (rules) { names.push(...RULE_PROPS); lines.push(...rules); }
    if (names.length) replaceProps(c, [...names, ...STAMP_PROPS], [...lines, ...stampLines(c)]);
  };

  const detached = [];
  cal.comps = cal.comps.filter((c) => {
    if (c.name !== 'VEVENT' || c === main) return true;
    const rid = ridOf(c);
    const ev = overrides.get(rid);
    if (!ev) return false; // deleted in Famner (that date is skipped in the series)
    if (moved) { detached.push(ev); return false; } // the series moved: the occurrence lives on as its own event
    changes(c, withDates(ev), old.get(rid), null);
    return true;
  });
  // skipped dates: the ones with their own occurrence in this file aren't listed as skipped
  const keep = detached.length ? new Set() : kept;
  const wanted = [...new Set(master.exdates ?? [])].filter((d) => !keep.has(d)).sort().join();
  const ruleSame = keepRule || (repeatKey(was) === repeatKey(master) && (!master.repeat || skippedDays(main) === wanted));
  const rules = ruleSame ? null : ruleLines(master, zone, keep);
  changes(main, master, was, rules);
  if (usesZone(cal, zone)) ensureZone(cal, zone);
  return { text: writeCalendar(cal), detached };
}

// ---------- iCloud event files → Famner events ----------
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) : s);

/**
 * The Famner events in one iCloud event file: [{ rid, keepRule, fields }] where rid is '' for the
 * series (or one-off) and the occurrence date for a moved occurrence.
 */
export function readResource(raw) {
  const cal = parseComponents(raw);
  const comps = cal.comps.filter((c) => c.name === 'VEVENT');
  const main = comps.find((c) => !prop(c, 'RECURRENCE-ID'));
  const uid = (main ?? comps[0]) && prop(main ?? comps[0], 'UID')?.value.trim();
  const parsed = parseICS(raw);
  const out = [];
  const cancelled = comps.filter((c) => prop(c, 'RECURRENCE-ID') && /^CANCELLED$/i.test(prop(c, 'STATUS')?.value.trim() ?? '')).map(ridOf);
  for (const ev of parsed.events) {
    const rid = uid && ev.uid && ev.uid !== uid && ev.uid.startsWith(`${uid}#`) ? ev.uid.slice(uid.length + 1) : '';
    const fields = {
      title: clip(ev.title, LIMITS.title), start: ev.start.toISOString(), end: ev.end.toISOString(),
      ...(ev.allDay ? { allDay: true } : {}),
      ...(ev.location ? { location: clip(ev.location, LIMITS.location) } : {}),
      ...(ev.notes ? { notes: clip(ev.notes, LIMITS.notes) } : {}),
      ...(ev.repeat ? { repeat: ev.repeat.until ? { ...ev.repeat, until: ev.repeat.until.toISOString() } : ev.repeat } : {}),
      ...(ev.uid ? { uid: ev.uid } : {})
    };
    if (!rid && fields.repeat && cancelled.length) fields.exdates = [...new Set([...(ev.exdates ?? []), ...cancelled])];
    else if (ev.exdates?.length) fields.exdates = ev.exdates;
    out.push({ rid, keepRule: !rid && !ev.repeat && !!(main && prop(main, 'RRULE')), fields });
  }
  const lm = main && (prop(main, 'LAST-MODIFIED') ?? prop(main, 'DTSTAMP'));
  return { uid, events: out, modified: lm ? parseIcsDate(lm.value, lm.params)?.date?.getTime() ?? 0 : 0, warnings: parsed.warnings };
}

const OPTIONAL = ['allDay', 'location', 'notes', 'repeat', 'exdates', 'uid'];
function mergeEvent(existing, fields, id, calendarId) {
  const e = { ...(existing ?? {}) };
  for (const k of OPTIONAL) delete e[k];
  return { ...e, ...fields, id, calendar: calendarId };
}

/** What a Famner event looks like, for noticing changes (only what iCloud gets). */
function fingerprint(e) {
  const iso = (v) => (v == null ? null : toDate(v).toISOString());
  const r = e.repeat ? Object.fromEntries(Object.entries(e.repeat).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, k === 'until' ? iso(v) : v])) : null;
  const data = [e.title ?? '', iso(e.start), iso(e.end), !!e.allDay, e.location ?? '', e.notes ?? '', r, [...(e.exdates ?? [])].sort()];
  return createHash('sha1').update(JSON.stringify(data)).digest('hex');
}

// ---------- accounts and links ----------
const accountRow = (db, userId) => db.prepare('SELECT * FROM icloud_accounts WHERE user_id = ?').get(userId);
const linkRow = (db, calendarId) => db.prepare('SELECT * FROM icloud_links WHERE calendar_id = ?').get(calendarId);
const calendarOf = (db, id) => {
  const r = db.prepare('SELECT data FROM calendars WHERE id = ?').get(id);
  return r ? JSON.parse(r.data) : null;
};

function clientFor(db, dbPath, account) {
  const password = decryptSecret(dbPath, account.secret);
  if (password == null) throw new ICloudError('The saved iCloud password can’t be read any more (the secret key changed). Connect iCloud again.');
  return caldavClient({ server: account.server, username: account.apple_id, password });
}

/** May `user` link this Famner calendar to iCloud? Returns an error message, or null. */
function linkProblem(user, cal) {
  if (!cal) return 'That calendar doesn’t exist.';
  if (cal.source) return 'Subscribed calendars can’t be synced with iCloud.';
  if (cal.private) return cal.owner === user.id ? null : 'Only the person who made a private calendar can sync it.';
  return ADULT.has(user.role) ? null : 'Only parents can sync calendars shared with everyone.';
}

/** Connect (or reconnect) `user`'s iCloud account. Checks the password with iCloud first. */
export async function connectAccount(db, dbPath, user, { appleId, password, server = ICLOUD_SERVER }) {
  if (!user || user.role === 'kiosk') throw new ICloudError('The kiosk can’t connect an iCloud account.');
  const id = String(appleId ?? '').trim();
  const pw = String(password ?? '').trim();
  if (!/^\S+@\S+\.\S+$/.test(id)) throw new ICloudError('Enter your Apple ID (the email address you sign in to iCloud with).');
  if (!pw) throw new ICloudError('Enter the app-specific password.');
  const dav = caldavClient({ server, username: id, password: pw });
  let home, calendars;
  try {
    ({ home } = await dav.discover());
    calendars = await dav.calendars(home);
  } catch (err) {
    if (err instanceof CalDavError) {
      throw new ICloudError(err.status === 401
        ? 'iCloud didn’t accept that Apple ID and app-specific password. Use an app-specific password, not your normal Apple ID password.'
        : err.message);
    }
    throw err;
  }
  db.prepare(`INSERT INTO icloud_accounts (user_id, apple_id, secret, server, home, status, error, connected_at)
    VALUES (?, ?, ?, ?, ?, 'ok', NULL, ?)
    ON CONFLICT(user_id) DO UPDATE SET apple_id = excluded.apple_id, secret = excluded.secret, server = excluded.server,
      home = excluded.home, status = 'ok', error = NULL, connected_at = excluded.connected_at`)
    .run(user.id, id, encryptSecret(dbPath, pw), server, home, Date.now());
  db.prepare('UPDATE icloud_links SET error = NULL WHERE user_id = ?').run(user.id);
  return calendars;
}

function forgetLink(db, calendarId) {
  db.prepare('DELETE FROM icloud_items WHERE calendar_id = ?').run(calendarId);
  db.prepare('DELETE FROM icloud_resources WHERE calendar_id = ?').run(calendarId);
  db.prepare('DELETE FROM icloud_links WHERE calendar_id = ?').run(calendarId);
}

/** Disconnect: stop syncing every calendar `user` linked. Events stay in both places. */
export function disconnectAccount(db, user) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const l of db.prepare('SELECT calendar_id FROM icloud_links WHERE user_id = ?').all(user.id)) forgetLink(db, l.calendar_id);
    db.prepare('DELETE FROM icloud_accounts WHERE user_id = ?').run(user.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** For the account page: the connection, its linked calendars, and the Famner calendars it could link. */
export function accountStatus(db, user) {
  const a = accountRow(db, user.id);
  const cals = db.prepare('SELECT id, data FROM calendars ORDER BY position, rowid').all().map((r) => JSON.parse(r.data));
  const linked = new Map(db.prepare('SELECT * FROM icloud_links').all().map((l) => [l.calendar_id, l]));
  const links = [...linked.values()].filter((l) => l.user_id === user.id).map((l) => ({
    calendarId: l.calendar_id,
    calendarName: cals.find((c) => c.id === l.calendar_id)?.label ?? l.calendar_id,
    remoteUrl: l.remote_url,
    remoteName: l.remote_name,
    syncedAt: l.synced_at,
    error: l.error,
    warnings: l.warnings ? JSON.parse(l.warnings) : []
  }));
  const linkable = cals.filter((c) => !linked.has(c.id) && !linkProblem(user, c)).map((c) => ({ id: c.id, label: c.label }));
  return a
    ? { connected: true, appleId: a.apple_id, status: a.status, error: a.error, links, linkable }
    : { connected: false, links: [], linkable };
}

/** `user`'s iCloud calendars, each with whether (and to which Famner calendar) it's linked. */
export async function remoteCalendars(db, dbPath, user) {
  const a = accountRow(db, user.id);
  if (!a) return [];
  const linked = new Map(db.prepare('SELECT remote_url, calendar_id FROM icloud_links').all().map((l) => [l.remote_url, l.calendar_id]));
  const list = await clientFor(db, dbPath, a).calendars(a.home);
  return list.map((c) => ({ ...c, linkedTo: linked.get(c.url) ?? null }));
}

/**
 * Start syncing. `remoteUrl` is an iCloud calendar, or null to make a new one (named after the
 * Famner calendar). `calendarId` is a Famner calendar, or null to make a new one (named after the
 * iCloud calendar, seen by everyone, or only by `user` when `onlyMe`). Then syncs once.
 * Returns { calendarId, result, syncError }.
 */
export async function linkCalendar(db, dbPath, user, { remoteUrl = null, calendarId = null, onlyMe = false }) {
  if (!user || user.role === 'kiosk') throw new ICloudError('The kiosk can’t sync calendars.');
  const a = accountRow(db, user.id);
  if (!a) throw new ICloudError('Connect your iCloud account first.');
  if (!remoteUrl && !calendarId) throw new ICloudError('Pick an iCloud calendar or a Famner calendar (or both).');
  const dav = clientFor(db, dbPath, a);
  let remote = null;
  if (remoteUrl) {
    const list = await dav.calendars(a.home);
    remote = list.find((c) => c.url === remoteUrl);
    if (!remote) throw new ICloudError('That iCloud calendar wasn’t found. It may have been deleted.');
    if (!remote.writable) throw new ICloudError(`“${remote.name}” is view-only in iCloud, so it can’t be synced both ways.`);
    if (db.prepare('SELECT 1 FROM icloud_links WHERE remote_url = ?').get(remoteUrl)) throw new ICloudError(`“${remote.name}” is already synced with a Famner calendar.`);
  }
  let cal = null;
  if (calendarId) {
    cal = calendarOf(db, calendarId);
    const problem = linkProblem(user, cal);
    if (problem) throw new ICloudError(problem);
    if (linkRow(db, calendarId)) throw new ICloudError(`“${cal.label}” is already synced with iCloud.`);
  }
  if (!remote) {
    const url = await dav.makeCalendar(a.home, { name: cal.label, color: cal.color });
    remote = { url, name: cal.label };
  }
  if (!cal) {
    const id = `icloud-${randomUUID().slice(0, 8)}`;
    const position = db.prepare('SELECT COUNT(*) AS n FROM calendars').get().n;
    const isChild = !ADULT.has(user.role);
    const c = { id, label: remote.name, color: remote.color ?? '#3b82f6', position, ...(onlyMe || isChild ? { private: true } : {}) };
    try {
      applyChanges(db, { upsertCalendars: [c] }, ORIGIN, user);
    } catch (err) {
      if (err instanceof ValidationError || err instanceof ForbiddenError) throw new ICloudError(err.message);
      throw err;
    }
    cal = calendarOf(db, id);
  }
  db.prepare('INSERT INTO icloud_links (calendar_id, user_id, remote_url, remote_name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(cal.id, user.id, remote.url, remote.name, Date.now());
  // the link stays even if the first sync fails (e.g. no internet): it's tried again later
  try {
    return { calendarId: cal.id, result: await syncCalendar(db, dbPath, cal.id), syncError: null };
  } catch (err) {
    return { calendarId: cal.id, result: null, syncError: err.message };
  }
}

/** Stop syncing one calendar (`user` must have linked it). Events stay in both places. */
export function unlinkCalendar(db, user, calendarId) {
  const l = linkRow(db, calendarId);
  if (!l) return false;
  if (l.user_id !== user.id && user.role !== 'admin') throw new ICloudError('Only the person who set up this sync can stop it.');
  forgetLink(db, calendarId);
  return true;
}

// ---------- syncing ----------
const running = (globalThis.__icloudRunning ??= new Map());

/** Sync one linked calendar now (waits for a sync that's already running, then runs again). */
export function syncCalendar(db, dbPath, calendarId) {
  const prev = running.get(calendarId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => syncOnce(db, dbPath, calendarId));
  running.set(calendarId, next);
  next.finally(() => { if (running.get(calendarId) === next) running.delete(calendarId); }).catch(() => {});
  return next;
}

async function syncOnce(db, dbPath, calendarId) {
  const link = linkRow(db, calendarId);
  if (!link) return null;
  const account = accountRow(db, link.user_id);
  if (!account || !calendarOf(db, calendarId)) { forgetLink(db, calendarId); return null; }
  if (account.status === 'auth') return { skipped: true };
  const setError = (msg) => db.prepare('UPDATE icloud_links SET error = ? WHERE calendar_id = ?').run(msg, calendarId);
  try {
    const dav = clientFor(db, dbPath, account);
    const stats = { pulled: 0, pushed: 0, deleted: 0, conflicts: 0 };
    const warnings = new Set();
    const ctag = await pull(db, dav, link, stats, warnings);
    const pushed = await push(db, dav, link, stats);
    db.prepare('UPDATE icloud_links SET ctag = ?, synced_at = ?, error = NULL, warnings = ? WHERE calendar_id = ?')
      .run(pushed ? null : ctag, Date.now(), warnings.size ? JSON.stringify([...warnings]) : link.warnings, calendarId);
    return stats;
  } catch (err) {
    if (err instanceof CalDavError && err.status === 401) {
      db.prepare("UPDATE icloud_accounts SET status = 'auth', error = ? WHERE user_id = ?")
        .run('iCloud stopped accepting the app-specific password. Connect again with a new one.', link.user_id);
    }
    const msg = err instanceof CalDavError || err instanceof ICloudError ? err.message : 'Something went wrong while syncing.';
    if (!(err instanceof CalDavError || err instanceof ICloudError)) console.error('iCloud sync failed:', err);
    setError(msg);
    throw err;
  }
}

function localState(db, calendarId) {
  const events = new Map(db.prepare('SELECT id, data, updated_at FROM events WHERE calendar_id = ?').all(calendarId)
    .map((r) => [r.id, { ...JSON.parse(r.data), _updated: r.updated_at }]));
  const items = db.prepare('SELECT * FROM icloud_items WHERE calendar_id = ?').all(calendarId);
  const resources = new Map(db.prepare('SELECT href, etag, raw FROM icloud_resources WHERE calendar_id = ?').all(calendarId).map((r) => [r.href, r]));
  return { events, items, resources };
}
const strip = (e) => { const rest = { ...e }; delete rest._updated; return rest; };

/** Steps 1–2: bring iCloud's changes into Famner. Returns the calendar's change tag. */
async function pull(db, dav, link, stats, warnings) {
  const calId = link.calendar_id;
  const ctag = await dav.ctag(link.remote_url);
  const before = localState(db, calId);
  if (ctag && ctag === link.ctag && before.resources.size) return ctag;

  const etags = await dav.etags(link.remote_url);
  const changed = [...etags].filter(([href, etag]) => before.resources.get(href)?.etag !== etag).map(([href]) => href);
  const gone = [...before.resources.keys()].filter((href) => !etags.has(href));
  const fetched = changed.length ? await dav.multiget(link.remote_url, changed) : new Map();

  // apply, from a fresh look at Famner (it may have changed while we were waiting for iCloud)
  const { events, items } = localState(db, calId);
  const byHref = new Map();
  for (const it of items) (byHref.get(it.href) ?? byHref.set(it.href, []).get(it.href)).push(it);
  const pending = (href) => (byHref.get(href) ?? []).some((it) => !events.has(it.event_id) || fingerprint(events.get(it.event_id)) !== it.hash);
  const newestLocal = (href) => Math.max(0, ...(byHref.get(href) ?? []).map((it) => events.get(it.event_id)?._updated ?? Date.now()));
  const unmapped = new Map([...events].filter(([id]) => !items.some((it) => it.event_id === id)));

  const upserts = [], deletes = [];
  const ops = []; // database steps, run after the events are saved
  const saveResource = (href, etag, raw) => ops.push(() => db.prepare('INSERT INTO icloud_resources (calendar_id, href, etag, raw) VALUES (?, ?, ?, ?) ON CONFLICT(calendar_id, href) DO UPDATE SET etag = excluded.etag, raw = excluded.raw').run(calId, href, etag, raw));
  const saveItem = (id, href, rid, hash) => ops.push(() => db.prepare('INSERT INTO icloud_items (calendar_id, event_id, href, rid, hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(calendar_id, event_id) DO UPDATE SET href = excluded.href, rid = excluded.rid, hash = excluded.hash').run(calId, String(id), href, rid, hash));
  const dropItem = (id) => ops.push(() => db.prepare('DELETE FROM icloud_items WHERE calendar_id = ? AND event_id = ?').run(calId, String(id)));
  const dropHref = (href) => ops.push(() => {
    db.prepare('DELETE FROM icloud_items WHERE calendar_id = ? AND href = ?').run(calId, href);
    db.prepare('DELETE FROM icloud_resources WHERE calendar_id = ? AND href = ?').run(calId, href);
  });

  for (const [href, { etag, data }] of fetched) {
    const remote = readResource(data);
    for (const w of remote.warnings) warnings.add(w);
    if (pending(href)) {
      stats.conflicts++;
      if (newestLocal(href) > remote.modified) {
        saveResource(href, etag, data); // Famner's change is newer: keep it, and push it onto this version
        continue;
      }
    }
    const mine = new Map((byHref.get(href) ?? []).map((it) => [it.rid, it]));
    for (const r of remote.events) {
      let id = mine.get(r.rid)?.event_id;
      if (!id && !r.rid && !mine.size) {
        // first sync of a calendar that already had events: the same event in both places counts once
        const match = [...unmapped.values()].find((e) => (r.fields.uid && (e.uid === r.fields.uid || `${e.id}@home-app` === r.fields.uid)) ||
          ((e.title ?? '') === r.fields.title && toDate(e.start).getTime() === Date.parse(r.fields.start) && toDate(e.end).getTime() === Date.parse(r.fields.end)));
        if (match) { id = match.id; unmapped.delete(match.id); }
      }
      id ??= `ic-${randomUUID()}`;
      const existing = events.get(id);
      const ev = mergeEvent(existing ? strip(existing) : { createdBy: link.user_id }, r.fields, id, calId);
      upserts.push(ev);
      saveItem(id, href, r.rid, fingerprint(ev));
      mine.delete(r.rid);
    }
    for (const it of mine.values()) { deletes.push(it.event_id); dropItem(it.event_id); }
    saveResource(href, etag, data);
    stats.pulled++;
  }
  for (const href of gone) {
    if (pending(href)) {
      // deleted in iCloud but changed in Famner since: keep Famner's, it goes back as a new event
      stats.conflicts++;
      dropHref(href);
      continue;
    }
    for (const it of byHref.get(href) ?? []) if (events.has(it.event_id)) deletes.push(it.event_id);
    dropHref(href);
    stats.deleted++;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < Math.max(upserts.length, deletes.length); i += 1000) {
      applyChanges(db, { upsertEvents: upserts.slice(i, i + 1000), deleteEvents: deletes.slice(i, i + 1000) }, ORIGIN);
    }
    for (const op of ops) op();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return ctag;
}

/** Step 3: send Famner's changes to iCloud. Returns how many files were written. */
async function push(db, dav, link, stats) {
  const calId = link.calendar_id;
  const { events, items, resources } = localState(db, calId);
  const byHref = new Map();
  for (const it of items) (byHref.get(it.href) ?? byHref.set(it.href, []).get(it.href)).push(it);
  const mapped = new Set(items.map((it) => it.event_id));
  const fresh = [...events.values()].filter((e) => !mapped.has(String(e.id)));
  const dirty = [...byHref].filter(([, list]) => list.some((it) => !events.has(it.event_id) || fingerprint(events.get(it.event_id)) !== it.hash));
  let writes = 0;

  const saveItems = (href, list) => {
    const up = db.prepare('INSERT INTO icloud_items (calendar_id, event_id, href, rid, hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(calendar_id, event_id) DO UPDATE SET href = excluded.href, rid = excluded.rid, hash = excluded.hash');
    for (const { ev, rid } of list) up.run(calId, String(ev.id), href, rid, fingerprint(ev));
  };
  const saveResource = (href, etag, raw) => db.prepare('INSERT INTO icloud_resources (calendar_id, href, etag, raw) VALUES (?, ?, ?, ?) ON CONFLICT(calendar_id, href) DO UPDATE SET etag = excluded.etag, raw = excluded.raw').run(calId, href, etag, raw);
  const dropHref = (href) => {
    db.prepare('DELETE FROM icloud_items WHERE calendar_id = ? AND href = ?').run(calId, href);
    db.prepare('DELETE FROM icloud_resources WHERE calendar_id = ? AND href = ?').run(calId, href);
  };

  for (const [href, list] of dirty) {
    const masterItem = list.find((it) => it.rid === '');
    const master = masterItem && events.get(masterItem.event_id);
    const res = resources.get(href);
    if (!master || !res) {
      // the series (or one-off) was deleted in Famner: delete it in iCloud; any moved occurrences left become their own events
      if (res) await dav.remove(href, res.etag).catch((err) => { if (err.status !== 412) throw err; });
      dropHref(href);
      for (const it of list) if (it.rid && events.has(it.event_id)) fresh.push(events.get(it.event_id));
      stats.deleted++;
      writes++;
      continue;
    }
    const overrides = new Map(list.filter((it) => it.rid).map((it) => [it.rid, events.has(it.event_id) ? strip(events.get(it.event_id)) : null]));
    const keepRule = !master.repeat && /\nRRULE[:;]/i.test(`\n${res.raw.replace(/\r/g, '')}`) &&
      readResource(res.raw).events.find((r) => !r.rid)?.keepRule;
    const write = async (base, etag) => {
      const { text, detached } = patchResource(base, strip(master), overrides, { keepRule });
      const newEtag = (await dav.put(href, text, { etag })) ?? (await dav.etagOf(href));
      return { text, detached, newEtag };
    };
    let out;
    try {
      out = await write(res.raw, res.etag);
    } catch (err) {
      if (err.status !== 412) throw err;
      const latest = (await dav.multiget(link.remote_url, [href])).get(href); // changed in iCloud meanwhile: edit the newest version
      if (!latest) { dropHref(href); fresh.push(master); continue; }
      out = await write(latest.data, latest.etag);
    }
    saveResource(href, out.newEtag, out.text);
    const detachedIds = new Set(out.detached.map((e) => String(e.id)));
    db.prepare('DELETE FROM icloud_items WHERE calendar_id = ? AND href = ?').run(calId, href);
    saveItems(href, [{ ev: master, rid: '' }, ...list.filter((it) => it.rid && events.has(it.event_id) && !detachedIds.has(it.event_id)).map((it) => ({ ev: events.get(it.event_id), rid: it.rid }))]);
    fresh.push(...out.detached);
    stats.pushed++;
    writes++;
  }

  for (const ev of fresh) {
    const uid = randomUUID().toUpperCase();
    const href = new URL(`${uid}.ics`, link.remote_url).href;
    const text = newResource(strip(ev), uid);
    const etag = (await dav.put(href, text, { create: true })) ?? (await dav.etagOf(href));
    saveResource(href, etag, text);
    saveItems(href, [{ ev, rid: '' }]);
    stats.pushed++;
    writes++;
  }
  return writes;
}

// ---------- in the background ----------
/** Sync every linked calendar now and then, and soon after a linked calendar changes in Famner. */
export function startICloudSync(dbPath) {
  if (globalThis.__icloudSync) return;
  const db = icloudDb(dbPath);
  const minutes = Math.max(1, Number(process.env.ICLOUD_SYNC_MINUTES) || 5);
  const soon = new Map();
  const later = (calId, ms) => {
    clearTimeout(soon.get(calId));
    const t = setTimeout(() => { soon.delete(calId); syncCalendar(db, dbPath, calId).catch(() => {}); }, ms);
    t.unref?.();
    soon.set(calId, t);
  };
  const all = () => {
    for (const l of db.prepare('SELECT calendar_id FROM icloud_links').all()) later(l.calendar_id, Math.random() * 20000);
  };
  const stop = subscribe((msg) => {
    if (msg.origin === ORIGIN) return;
    const { changes: ch, privacy } = msg;
    for (const id of ch.deleteCalendars) if (linkRow(db, id)) forgetLink(db, id);
    const cals = new Set([...ch.upsertEvents.map((e) => e.calendar), ...Object.values(privacy?.eventCals ?? {}).filter(Boolean)]);
    for (const id of cals) if (linkRow(db, id)) later(id, 4000);
  });
  const timer = setInterval(all, minutes * 60000);
  timer.unref?.();
  const first = setTimeout(all, 15000);
  first.unref?.();
  globalThis.__icloudSync = { stop: () => { stop(); clearInterval(timer); clearTimeout(first); for (const t of soon.values()) clearTimeout(t); } };
}
