// src/lib/server/auth.js — accounts, passwords and sign-in sessions (server only).
//
// Users have a role: 'admin' (everything, plus managing people), 'parent' (can change everything),
// 'child' (can add events and list items, and change only the ones they added) or 'kiosk' (a shared
// tablet: see "kiosk" below). Everyone except a kiosk also has a 4-digit PIN, chosen at first sign-in,
// which unlocks the kiosk as them. Accounts are created by an admin with a temporary password, which
// the person must change on first sign-in. The very first admin is created on the /setup page.
//
// Passwords are hashed with scrypt (Node's built-in crypto). Sessions are random tokens kept in a
// cookie; only a SHA-256 of each token is stored, so a copy of the database can't be used to sign in.

import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { getDb, deletePrivateCalendarsOf, privateCalendarCount } from './calendarDb.js';
import { logActivity } from './activity.js';

export const ROLES = ['admin', 'parent', 'child', 'kiosk'];
export const ROLE_LABELS = { admin: 'Admin', parent: 'Parent', child: 'Child', kiosk: 'Kiosk' };
export const SESSION_COOKIE = 'sid';
export const SESSION_DAYS = 30;

const DAY = 86400000;
const RENEW_WHEN_LEFT = 15 * DAY;   // extend a session when it has less than this left
const SEEN_EVERY = 5 * 60000;       // how often "last seen" is written
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export class AuthError extends Error {}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id                   TEXT PRIMARY KEY,
    username             TEXT NOT NULL UNIQUE,
    name                 TEXT NOT NULL,
    role                 TEXT NOT NULL,
    password_hash        TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    disabled             INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    last_login_at        INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent   TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id);
`;

const prepared = new WeakSet();

/** The app database with the account tables ready. */
export function authDb(path) {
  const db = getDb(path);
  if (!prepared.has(db)) {
    db.exec(SCHEMA);
    // roles were renamed: member → parent, view-only → child
    db.exec("UPDATE users SET role = 'parent' WHERE role = 'member'; UPDATE users SET role = 'child' WHERE role = 'viewer';");
    // PINs (for the kiosk) and who the kiosk is unlocked as
    const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    const u = cols('users'), se = cols('sessions');
    if (!u.has('pin_hash')) db.exec('ALTER TABLE users ADD COLUMN pin_hash TEXT');
    if (!u.has('pin_fails')) db.exec('ALTER TABLE users ADD COLUMN pin_fails INTEGER NOT NULL DEFAULT 0');
    if (!u.has('pin_locked_until')) db.exec('ALTER TABLE users ADD COLUMN pin_locked_until INTEGER');
    if (!u.has('theme')) db.exec('ALTER TABLE users ADD COLUMN theme TEXT'); // light, dark or oled (null: dark)
    if (!se.has('acting_as')) db.exec('ALTER TABLE sessions ADD COLUMN acting_as TEXT');
    if (!se.has('acting_until')) db.exec('ALTER TABLE sessions ADD COLUMN acting_until INTEGER');
    prepared.add(db);
  }
  return db;
}

// ---------- passwords ----------
function scrypt(password, salt) {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)))
  );
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length,
      { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 }, (err, k) => (err ? reject(err) : resolve(k)))
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummyHash = null; // used so a wrong username takes as long as a wrong password

/** A readable temporary password, e.g. "k7mq-x3pa-h9tf". */
export function generateTempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join('')).join('-');
}

// ---------- validation ----------
export function checkUsername(v) {
  const u = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) return { error: 'Usernames are 3–32 characters: letters, numbers, dots, dashes or underscores.' };
  return { value: u };
}

export function checkName(v) {
  const n = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!n || n.length > 60) return { error: 'Enter a name (up to 60 characters).' };
  return { value: n };
}

export function checkPassword(v) {
  const p = String(v ?? '');
  if (p.length < 8) return { error: 'Passwords need at least 8 characters.' };
  if (p.length > 200) return { error: 'That password is too long (200 characters at most).' };
  return { value: p };
}

const checkRole = (v) => (ROLES.includes(v) ? { value: v } : { error: 'Pick a role.' });

// ---------- users ----------
/** The safe-to-share parts of a user. */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
    needsPin: row.role !== 'kiosk' && !row.pin_hash,
    theme: THEMES.includes(row.theme) ? row.theme : null
  };
}

export const userCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

/** Everyone's id and name, for showing who added something. */
export const peopleNames = (db) => db.prepare('SELECT id, name, role FROM users ORDER BY name').all();
const getUserRow = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

async function insertUser(db, { username, name, role, password, mustChange }) {
  const u = checkUsername(username), n = checkName(name), r = checkRole(role), p = checkPassword(password);
  const problem = u.error || n.error || r.error || p.error;
  if (problem) throw new AuthError(problem);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.value)) throw new AuthError(`The username “${u.value}” is already taken.`);
  const hash = await hashPassword(p.value);
  const id = randomUUID();
  db.prepare(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, u.value, n.value, r.value, hash, mustChange ? 1 : 0, Date.now());
  return publicUser(getUserRow(db, id));
}

/** Create the first admin. Only works while there are no users at all. */
export async function createFirstAdmin(db, { username, name, password }) {
  if (userCount(db) > 0) throw new AuthError('Setup has already been done. Sign in instead.');
  const user = await insertUser(db, { username, name, role: 'admin', password, mustChange: false });
  // if two people submitted setup at the same moment, keep only the first
  const first = db.prepare('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1').get();
  if (first.id !== user.id) {
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    throw new AuthError('Setup has already been done. Sign in instead.');
  }
  return user;
}

/** Admin: add someone with a temporary password. Returns { user, tempPassword }. */
export async function createUser(db, actor, { username, name, role }) {
  requireAdmin(actor);
  const tempPassword = generateTempPassword();
  const user = await insertUser(db, { username, name, role, password: tempPassword, mustChange: true });
  logActivity(db, actor, 'accounts', [{ kind: 'account.added', details: { name: user.name, role: user.role } }]);
  return { user, tempPassword };
}

/** Everyone, with sign-in details, for the admin panel. */
export function listUsers(db) {
  const now = Date.now();
  return db.prepare(`
    SELECT u.*, COUNT(s.id) AS sessions, MAX(s.last_seen_at) AS last_seen
    FROM users u LEFT JOIN sessions s ON s.user_id = u.id AND s.expires_at > ?
    GROUP BY u.id ORDER BY u.created_at, u.rowid`).all(now).map((row) => ({
    ...publicUser(row),
    disabled: !!row.disabled,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    lastSeenAt: row.last_seen,
    activeSessions: row.sessions,
    privateCalendars: privateCalendarCount(db, row.id)
  }));
}

function requireAdmin(actor) {
  if (actor?.role !== 'admin') throw new AuthError('Only admins can do that.');
}

function otherUser(db, actor, id) {
  requireAdmin(actor);
  if (id === actor.id) throw new AuthError('You can’t do that to your own account here. Use the Account page instead.');
  const row = getUserRow(db, id);
  if (!row) throw new AuthError('That user no longer exists.');
  return row;
}

/** Admin: change someone's name and/or role. */
export function updateUser(db, actor, id, { name, role }) {
  requireAdmin(actor);
  const self = id === actor.id;
  if (self && role !== undefined && role !== actor.role) throw new AuthError('You can’t change your own role.');
  const row = self ? getUserRow(db, id) : otherUser(db, actor, id);
  const n = name === undefined ? { value: row.name } : checkName(name);
  const r = role === undefined ? { value: row.role } : checkRole(role);
  if (n.error || r.error) throw new AuthError(n.error || r.error);
  db.prepare('UPDATE users SET name = ?, role = ? WHERE id = ?').run(n.value, r.value, id);
  const log = [];
  if (n.value !== row.name) log.push({ kind: 'account.renamed', details: { from: row.name, name: n.value } });
  if (r.value !== row.role) log.push({ kind: 'account.role', details: { name: n.value, from: row.role, role: r.value } });
  logActivity(db, actor, 'accounts', log);
  return publicUser(getUserRow(db, id));
}

/** Admin: turn an account off (signs them out everywhere) or back on. */
export function setDisabled(db, actor, id, disabled) {
  const row = otherUser(db, actor, id);
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
  if (disabled) revokeUserSessions(db, id);
  logActivity(db, actor, 'accounts', [{ kind: disabled ? 'account.disabled' : 'account.enabled', details: { name: row.name } }]);
}

/** Admin: give someone a new temporary password (signs them out everywhere). */
export async function resetPassword(db, actor, id) {
  const row = otherUser(db, actor, id);
  const tempPassword = generateTempPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(await hashPassword(tempPassword), id);
  revokeUserSessions(db, id);
  logActivity(db, actor, 'accounts', [{ kind: 'account.reset', details: { name: row.name } }]);
  return tempPassword;
}

/** Admin: remove an account, its sessions and its private calendars. */
export function deleteUser(db, actor, id) {
  const row = otherUser(db, actor, id);
  revokeUserSessions(db, id);
  const removedCalendars = deletePrivateCalendarsOf(db, id); // internal: not checked or logged per calendar
  try { db.prepare('UPDATE chores SET active = 0 WHERE assignee = ?').run(id); } catch { /* chores not set up yet */ }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  logActivity(db, actor, 'accounts', [{ kind: 'account.removed', details: { name: row.name, privateCalendars: removedCalendars || undefined } }]);
  return { username: row.username, removedCalendars };
}

/** The app's look, chosen per person and used on every device they sign in on. */
export const THEMES = ['light', 'dark', 'oled'];
export function setOwnTheme(db, userId, theme) {
  if (!THEMES.includes(theme)) throw new AuthError('Pick light, dark or OLED black.');
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, userId);
}

/** The signed-in user changes their own name. */
export function renameSelf(db, userId, name) {
  const n = checkName(name);
  if (n.error) throw new AuthError(n.error);
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(n.value, userId);
}

/** The signed-in user changes their password; their other devices are signed out. */
export async function changeOwnPassword(db, userId, current, next, keepSessionId) {
  const row = getUserRow(db, userId);
  if (!row || !(await verifyPassword(String(current ?? ''), row.password_hash))) throw new AuthError('Your current password isn’t right.');
  const p = checkPassword(next);
  if (p.error) throw new AuthError(p.error);
  if (p.value === current) throw new AuthError('Choose a password different from the current one.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await hashPassword(p.value), userId);
  revokeUserSessions(db, userId, keepSessionId);
}

// ---------- signing in ----------
// Repeated wrong passwords slow down further tries, per username and per network address.
const attempts = (globalThis.__loginAttempts ??= new Map());
const WINDOW = 15 * 60000;

function lockedFor(key, now) {
  const a = attempts.get(key);
  if (!a) return 0;
  if (now - a.last > WINDOW) { attempts.delete(key); return 0; }
  return Math.max(0, (a.until ?? 0) - now);
}

function noteFailure(key, now) {
  const a = attempts.get(key);
  const fails = a && now - a.last <= WINDOW ? a.fails + 1 : 1;
  const until = fails >= 5 ? now + Math.min(WINDOW, 30000 * 2 ** (fails - 5)) : 0;
  attempts.set(key, { fails, last: now, until });
}

function waitText(ms) {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s} second${s === 1 ? '' : 's'}` : `${Math.ceil(s / 60)} minute${Math.ceil(s / 60) === 1 ? '' : 's'}`;
}

/** Check a username and password. Returns { user } or { error }. */
export async function authenticate(db, username, password, address = '') {
  const now = Date.now();
  const uname = String(username ?? '').trim().toLowerCase();
  const keys = [`u:${uname}`, `ip:${address}`];
  const wait = Math.max(...keys.map((k) => lockedFor(k, now)));
  if (wait > 0) return { error: `Too many attempts. Try again in ${waitText(wait)}.` };

  const row = uname ? db.prepare('SELECT * FROM users WHERE username = ?').get(uname) : null;
  dummyHash ??= await hashPassword('not-a-real-password');
  const ok = await verifyPassword(String(password ?? ''), row?.password_hash ?? dummyHash);
  if (!row || !ok) {
    keys.forEach((k) => noteFailure(k, now));
    return { error: 'That username and password don’t match.' };
  }
  if (row.disabled) return { error: 'This account has been turned off. Ask an admin to turn it back on.' };
  keys.forEach((k) => attempts.delete(k));
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, row.id);
  return { user: publicUser(row) };
}

// ---------- sessions ----------
const tokenId = (token) => createHash('sha256').update(token).digest('base64url');

/** Start a session. Returns { token, expiresAt } — put the token in the cookie. */
export function createSession(db, userId, userAgent = '') {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * DAY;
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tokenId(token), userId, now, expiresAt, now, String(userAgent).slice(0, 300));
  return { token, expiresAt };
}

/**
 * Look up the session for a cookie token. Returns { sessionId, user, renewedUntil? } or null
 * (expired, signed out, or the account was turned off/removed). Active sessions are extended.
 */
export function validateSession(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const id = tokenId(token);
  const row = db.prepare(`
    SELECT s.id AS sid, s.expires_at, s.last_seen_at, s.acting_as, s.acting_until, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(id);
  const now = Date.now();
  if (!row || row.expires_at <= now || row.disabled) {
    if (row) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  let renewedUntil;
  if (row.expires_at - now < RENEW_WHEN_LEFT) {
    renewedUntil = now + SESSION_DAYS * DAY;
    db.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?').run(renewedUntil, now, id);
  } else if (now - row.last_seen_at > SEEN_EVERY) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
  }
  let acting = null;
  if (row.role === 'kiosk' && row.acting_as && row.acting_until > now) {
    const a = getUserRow(db, row.acting_as);
    if (a && !a.disabled && a.role !== 'kiosk') acting = { ...publicUser(a), until: row.acting_until };
  }
  return { sessionId: id, user: publicUser(row), acting, renewedUntil };
}

/** Is this session still usable? (Used by live streams to close when someone is signed out.) */
export function sessionIsValid(db, sessionId) {
  const row = db.prepare(`SELECT s.expires_at, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(sessionId);
  return !!row && row.expires_at > Date.now() && !row.disabled;
}

export function endSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenId(token));
}

export function revokeUserSessions(db, userId, exceptSessionId = null) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, exceptSessionId);
}

/** Remove expired sessions (cheap; called now and then). */
export function pruneSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}

/** Cookie settings for the session cookie. */
export function sessionCookieOptions(url, expiresAt) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: url.protocol === 'https:',
    expires: new Date(expiresAt)
  };
}

/** A safe place to send someone after signing in (only paths on this site). */
export function safeNext(next) {
  const n = String(next ?? '');
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') && !n.startsWith('/login') ? n : '/';
}

// ---------- PINs and the kiosk ----------
// A kiosk account (the wall tablet) is unlocked as one person by their PIN, for a short while
// (KIOSK_IDLE after the last change). While unlocked, changes are made as that person, within
// what the kiosk allows (see the chores actions and calendarDb.js). Five wrong PINs for a person
// pause their PIN for five minutes.
export const KIOSK_IDLE = 90 * 1000;
const PIN_TRIES = 5;
const PIN_PAUSE = 5 * 60000;

export function checkPin(v) {
  const pin = String(v ?? '').trim();
  if (!/^\d{4}$/.test(pin)) return { error: 'A PIN is 4 digits.' };
  const d = [...pin].map(Number);
  const step = d[1] - d[0];
  if (d.every((x, i) => i === 0 || x - d[i - 1] === step) && Math.abs(step) <= 1) {
    return { error: 'That PIN is too easy to guess (like 1111 or 1234). Pick another.' };
  }
  return { value: pin };
}

/**
 * Set a person's PIN. Their first one needs nothing more (they're signed in); changing it later
 * needs their password.
 */
export async function setPin(db, userId, pin, currentPassword = null) {
  const row = getUserRow(db, userId);
  if (!row) throw new AuthError('That user no longer exists.');
  if (row.role === 'kiosk') throw new AuthError('A kiosk account doesn’t have a PIN.');
  if (row.pin_hash && !(await verifyPassword(String(currentPassword ?? ''), row.password_hash))) {
    throw new AuthError('Your current password isn’t right.');
  }
  const p = checkPin(pin);
  if (p.error) throw new AuthError(p.error);
  db.prepare('UPDATE users SET pin_hash = ?, pin_fails = 0, pin_locked_until = NULL WHERE id = ?').run(await hashPassword(p.value), userId);
}

/** Admin: clear someone's PIN; they choose a new one the next time they use the app. */
export function resetPin(db, actor, id) {
  const row = otherUser(db, actor, id);
  db.prepare('UPDATE users SET pin_hash = NULL, pin_fails = 0, pin_locked_until = NULL WHERE id = ?').run(id);
  db.prepare('UPDATE sessions SET acting_as = NULL, acting_until = NULL WHERE acting_as = ?').run(id);
  logActivity(db, actor, 'accounts', [{ kind: 'account.pinReset', details: { name: row.name } }]);
}

/** Check a person's PIN. Returns { user } or { error }. */
export async function verifyPin(db, userId, pin) {
  const row = getUserRow(db, String(userId ?? ''));
  if (!row || row.disabled || row.role === 'kiosk') return { error: 'Pick a person.' };
  if (!row.pin_hash) return { error: `${row.name} hasn’t chosen a PIN yet. They choose one the next time they sign in.` };
  const now = Date.now();
  if (row.pin_locked_until > now) return { error: `Too many wrong PINs for ${row.name}. Try again in ${waitText(row.pin_locked_until - now)}.` };
  if (!/^\d{4}$/.test(String(pin ?? '')) || !(await verifyPassword(String(pin), row.pin_hash))) {
    const fails = (row.pin_fails ?? 0) + 1;
    if (fails >= PIN_TRIES) {
      db.prepare('UPDATE users SET pin_fails = 0, pin_locked_until = ? WHERE id = ?').run(now + PIN_PAUSE, row.id);
      return { error: `Too many wrong PINs for ${row.name}. Try again in 5 minutes.` };
    }
    db.prepare('UPDATE users SET pin_fails = ? WHERE id = ?').run(fails, row.id);
    return { error: `That’s not ${row.name}’s PIN.`, left: PIN_TRIES - fails };
  }
  if (row.pin_fails) db.prepare('UPDATE users SET pin_fails = 0 WHERE id = ?').run(row.id);
  return { user: publicUser(row) };
}

/** Unlock a kiosk session as a person. Returns { acting } or { error }. */
export async function unlockKiosk(db, sessionId, kioskUser, userId, pin) {
  if (kioskUser?.role !== 'kiosk') return { error: 'Only the kiosk uses PINs.' };
  const r = await verifyPin(db, userId, pin);
  if (r.error) return r;
  const until = Date.now() + KIOSK_IDLE;
  db.prepare('UPDATE sessions SET acting_as = ?, acting_until = ? WHERE id = ?').run(r.user.id, until, sessionId);
  return { acting: { ...r.user, until } };
}

export function lockKiosk(db, sessionId) {
  db.prepare('UPDATE sessions SET acting_as = NULL, acting_until = NULL WHERE id = ?').run(sessionId);
}

/** Keep an unlocked kiosk unlocked (it's being used). Returns the new time it locks. */
export function touchKiosk(db, sessionId) {
  const until = Date.now() + KIOSK_IDLE;
  const r = db.prepare('UPDATE sessions SET acting_until = ? WHERE id = ? AND acting_as IS NOT NULL AND acting_until > ?').run(until, sessionId, Date.now());
  return r.changes ? until : null;
}

/**
 * Who a change is made as. Everyone but a kiosk: themselves. A kiosk: the person it's unlocked as
 * (named "… (kiosk)" in the activity log), or a KioskLocked error when it isn't unlocked.
 */
export class KioskLocked extends Error {}
export function actingUser(locals) {
  const u = locals.user;
  if (u?.role !== 'kiosk') return u;
  const a = locals.acting;
  if (!a) throw new KioskLocked('Enter a PIN first.');
  return { id: a.id, username: a.username, name: `${a.name} (kiosk)`, role: a.role, viaKiosk: true };
}
