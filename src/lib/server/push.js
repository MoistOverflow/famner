// src/lib/server/push.js — Web Push: notifications that reach phones even when Famner is closed.
//
// A device that turns reminders on subscribes with its browser's push service (Apple, Google,
// Mozilla…) and sends the subscription here (/api/push). The server then sends:
//   • "Sam finished Dishes" to parents and admins,
//   • "Mom approved Dishes · +10" to whoever did the chore,
//   • "Dishes is due soon" 30 minutes before a chore's deadline, to whoever has to do it,
//   • "Mom added 3 items to Groceries", once nothing new was added for 2 minutes (at most 10
//     minutes after the first item), to everyone else whose device has grocery alerts on.
// Needs HTTPS (nginx). On iPhone the app has to be added to the Home Screen first.
//
// The signing keys (VAPID) are made on first use and kept in the database; or set
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY. PUSH_CONTACT (an https address or mailto:) tells the push
// services who runs this server; it defaults to ORIGIN.
import webpush from 'web-push';
import { getDb } from './calendarDb.js';
import { peopleNames } from './auth.js';
import { onChoreEvent } from './chores.js';
import { subscribeList } from './collections.js';
import { itemText } from '../groceryText.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS push_keys (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    public_key  TEXT NOT NULL,
    private_key TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    session_id TEXT,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    groceries  INTEGER NOT NULL DEFAULT 1,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_ok    INTEGER,
    fails      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS push_subscriptions_by_user ON push_subscriptions (user_id);
  CREATE TABLE IF NOT EXISTS push_sent (
    key TEXT PRIMARY KEY,
    at  INTEGER NOT NULL
  );
`;

export const GROCERY_QUIET = 2 * 60000;
export const GROCERY_MAX = 10 * 60000;
const DUE_SOON = 30 * 60000;

const prepared = new WeakSet();
export function pushDb(path) {
  const db = getDb(path);
  if (!prepared.has(db)) {
    db.exec(SCHEMA);
    prepared.add(db);
  }
  return db;
}

export class PushError extends Error {}

/** The server's signing keys (made the first time). */
export function vapidKeys(db) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  let row = db.prepare('SELECT public_key, private_key FROM push_keys WHERE id = 1').get();
  if (!row) {
    const k = webpush.generateVAPIDKeys();
    db.prepare('INSERT OR IGNORE INTO push_keys (id, public_key, private_key) VALUES (1, ?, ?)').run(k.publicKey, k.privateKey);
    row = db.prepare('SELECT public_key, private_key FROM push_keys WHERE id = 1').get();
  }
  return { publicKey: row.public_key, privateKey: row.private_key };
}

function contact() {
  const c = process.env.PUSH_CONTACT || process.env.ORIGIN || '';
  if (/^mailto:\S+@\S+$/.test(c) || /^https:\/\//.test(c)) return c;
  return 'mailto:famner@example.com';
}

// ---------- subscriptions ----------
const b64url = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Save a device's subscription for `user` ({ endpoint, keys: { p256dh, auth } } from the browser).
 * It's tied to the device's sign-in (`sessionId`): signing out, or being signed out, stops it.
 */
export function saveSubscription(db, user, sub, { userAgent = '', groceries, sessionId = null } = {}) {
  if (!user || user.role == null) throw new PushError('Please sign in.');
  const endpoint = String(sub?.endpoint ?? '');
  const { p256dh, auth } = sub?.keys ?? {};
  let url;
  try { url = new URL(endpoint); } catch { throw new PushError('That isn’t a push subscription.'); }
  if (url.protocol !== 'https:' || endpoint.length > 2000) throw new PushError('That isn’t a push subscription.');
  if (!b64url.test(p256dh ?? '') || !b64url.test(auth ?? '') || p256dh.length > 200 || auth.length > 100) {
    throw new PushError('That push subscription is missing its keys.');
  }
  const prev = db.prepare('SELECT groceries FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  const g = groceries == null ? (prev?.groceries ?? 1) : groceries ? 1 : 0;
  // the same device signed in as someone else now: it's theirs
  db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, session_id, p256dh, auth, groceries, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id, p256dh = excluded.p256dh,
      auth = excluded.auth, groceries = excluded.groceries, user_agent = excluded.user_agent, fails = 0`)
    .run(endpoint, user.id, sessionId, p256dh, auth, g, String(userAgent).slice(0, 300), Date.now());
  return { groceries: !!g };
}

export function removeSubscription(db, user, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(endpoint ?? ''), user.id);
}

export function setGroceryAlerts(db, user, endpoint, on) {
  const r = db.prepare('UPDATE push_subscriptions SET groceries = ? WHERE endpoint = ? AND user_id = ?').run(on ? 1 : 0, String(endpoint ?? ''), user.id);
  return r.changes > 0;
}

export function subscriptionOf(db, user, endpoint) {
  const r = db.prepare('SELECT groceries FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').get(String(endpoint ?? ''), user.id);
  return r ? { groceries: !!r.groceries } : null;
}

// ---------- sending ----------
// tests replace this to see what would be sent
let sender = (sub, payload, options) => webpush.sendNotification(sub, payload, options);
export function setSender(fn) {
  const prev = sender;
  sender = fn;
  return prev;
}

/**
 * Send `message` ({ title, body, url, tag }) to devices: of `userId`, or just the one `endpoint`.
 * Subscriptions the push service says are gone are forgotten. Returns how many devices got it.
 */
export async function sendTo(db, { userId = null, endpoint = null, groceriesOnly = false }, message) {
  // only devices still signed in, as accounts that still exist and aren't turned off
  const base = `SELECT s.* FROM push_subscriptions s
    JOIN users u ON u.id = s.user_id AND u.disabled = 0
    JOIN sessions se ON se.id = s.session_id AND se.user_id = s.user_id AND se.expires_at > ${Date.now()} WHERE`;
  const subs = endpoint
    ? db.prepare(`${base} s.endpoint = ?`).all(endpoint)
    : db.prepare(`${base} s.user_id = ?${groceriesOnly ? ' AND s.groceries = 1' : ''}`).all(userId);
  if (!subs.length) return 0;
  const { publicKey, privateKey } = vapidKeys(db);
  const payload = JSON.stringify({ title: message.title, body: message.body ?? '', url: message.url ?? '/', tag: message.tag });
  let ok = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
        vapidDetails: { subject: contact(), publicKey, privateKey },
        TTL: message.ttl ?? 12 * 3600,
        urgency: message.urgency ?? 'normal',
        ...(message.tag ? { topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {})
      });
      db.prepare('UPDATE push_subscriptions SET last_ok = ?, fails = 0 WHERE endpoint = ?').run(Date.now(), s.endpoint);
      ok++;
    } catch (err) {
      const status = err?.statusCode;
      if (status === 404 || status === 410 || status === 403) {
        // unsubscribed, expired, or made with other keys: this device subscribes again when it next opens Famner
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
      } else {
        db.prepare('UPDATE push_subscriptions SET fails = fails + 1 WHERE endpoint = ?').run(s.endpoint);
        console.error(`Push to ${new URL(s.endpoint).host} failed:`, status ?? '', err?.body || err?.message || err);
      }
    }
  }));
  return ok;
}

// ---------- what gets sent ----------
const nameOf = (db, id) => peopleNames(db).find((p) => p.id === id)?.name ?? 'Someone';
const RESULT = {
  approved: (r, by) => `${by} approved “${r.title}” · +${r.points}`,
  bonus: (r, by) => `${by} gave you ${r.points} points for “${r.title}” 🎉`,
  reduced: (r, by) => `${by} gave ${r.points} of ${r.possible} points for “${r.title}”`,
  denied: (r, by) => `${by} didn’t accept “${r.title}”`
};

export function choreMessages(db, e) {
  if (e.type === 'submitted') {
    const who = nameOf(db, e.chore.assignee);
    return peopleNames(db).filter((p) => (p.role === 'admin' || p.role === 'parent') && p.id !== e.by)
      .map((p) => ({ userId: p.id, message: { title: `${who} finished “${e.chore.title}”`, body: 'Tap to review it.', url: '/chores/review', tag: `submitted-${e.chore.id}` } }));
  }
  if (e.type === 'result' && RESULT[e.outcome] && e.reviewer !== e.assignee) {
    return [{ userId: e.assignee, message: { title: RESULT[e.outcome](e, nameOf(db, e.reviewer)), body: e.reason ? `“${e.reason}”` : '', url: '/chores', tag: `result-${e.title}` } }];
  }
  return [];
}

/** Chores due in the next 30 minutes that haven't had their reminder yet → messages (and marks them sent). */
export function dueMessages(db, now = Date.now()) {
  let rows;
  try {
    rows = db.prepare("SELECT id, title, assignee, due, tz FROM chores WHERE active = 1 AND status = 'open' AND due > ? AND due <= ?").all(now, now + DUE_SOON);
  } catch {
    return []; // chores not set up yet
  }
  const out = [];
  const mark = db.prepare('INSERT OR IGNORE INTO push_sent (key, at) VALUES (?, ?)');
  for (const c of rows) {
    if (!mark.run(`due:${c.id}:${c.due}`, now).changes) continue;
    let time;
    try { time = new Date(c.due).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: c.tz }); }
    catch { time = new Date(c.due).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
    out.push({ userId: c.assignee, message: { title: `“${c.title}” is due soon`, body: `Due at ${time}`, url: '/chores', tag: `due-${c.id}` } });
  }
  db.prepare('DELETE FROM push_sent WHERE at < ?').run(now - 3 * 86400000);
  return out;
}

const listWords = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * Collects grocery items as they're added and, once people stop adding, says who added what.
 * `send(messages)` gets [{ userId, message }] — each person hears about the items others added.
 */
export function groceryBatcher(db, send, { quiet = GROCERY_QUIET, max = GROCERY_MAX } = {}) {
  let pending = new Map(); // id → item
  let timer = null, first = 0;
  const flush = () => {
    timer = null;
    first = 0;
    const items = [...pending.values()];
    pending = new Map();
    if (!items.length) return;
    const people = peopleNames(db);
    const name = (id) => people.find((p) => p.id === id)?.name ?? 'Someone';
    const out = [];
    for (const p of people) {
      const theirs = items.filter((i) => i.createdBy !== p.id);
      if (!theirs.length) continue;
      const who = listWords([...new Set(theirs.map((i) => name(i.createdBy)))]);
      const texts = theirs.map(itemText);
      out.push({ userId: p.id, groceriesOnly: true, message: {
        title: theirs.length === 1 ? `${who} added ${texts[0]} to Groceries` : `${who} added ${theirs.length} items to Groceries`,
        body: theirs.length === 1 ? '' : texts.slice(0, 6).join(', ') + (texts.length > 6 ? `, and ${texts.length - 6} more` : ''),
        url: '/groceries', tag: 'groceries-added'
      } });
    }
    send(out);
  };
  return {
    changed(msg) {
      const added = new Set((msg.added ?? []).map(String));
      let grew = false;
      for (const item of msg.changes?.upsert ?? []) {
        const id = String(item.id);
        if (added.has(id)) {
          if (!item.done) { pending.set(id, item); grew = true; }
        } else if (pending.has(id)) {
          if (item.done) pending.delete(id); // bought already: no need to tell anyone
          else pending.set(id, item);        // e.g. the quantity went up
        }
      }
      for (const id of msg.changes?.delete ?? []) pending.delete(String(id));
      if (!pending.size) { clearTimeout(timer); timer = null; first = 0; return; }
      if (!grew) return;
      first ||= Date.now();
      clearTimeout(timer);
      timer = setTimeout(flush, Math.max(0, Math.min(quiet, first + max - Date.now())));
      timer.unref?.();
    },
    flush,
    stop() { clearTimeout(timer); timer = null; }
  };
}

// ---------- in the background ----------
export function startPush(dbPath) {
  if (globalThis.__push) return;
  const db = pushDb(dbPath);
  vapidKeys(db);
  const deliver = (list) => {
    for (const { userId, message, groceriesOnly } of list) sendTo(db, { userId, groceriesOnly }, message).catch((err) => console.error('Push failed:', err));
  };
  const stopChores = onChoreEvent((e) => deliver(choreMessages(db, e)));
  const groceries = groceryBatcher(db, deliver);
  const stopList = subscribeList('groceries', (msg) => groceries.changed(msg));
  const tick = setInterval(() => { try { deliver(dueMessages(db)); } catch (err) { console.error('Due reminders failed:', err); } }, 60000);
  tick.unref?.();
  globalThis.__push = { stop: () => { stopChores(); stopList(); groceries.stop(); clearInterval(tick); } };
}
