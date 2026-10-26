// Accounts, passwords, sessions, PINs and the kiosk (shared tablet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDbPath, household } from './helpers.js';
import * as A from '../src/lib/server/auth.js';

const db = A.authDb(freshDbPath());
const { dad, mom, sam, tab } = await household(A, db);

test('only one first admin; new people get temporary passwords', async () => {
	await assert.rejects(
		A.createFirstAdmin(db, { username: 'x', name: 'X', password: 'another-pass-1' }),
		/already been done/
	);
	const { user, tempPassword } = await A.createUser(db, dad, {
		username: 'nana',
		name: 'Nana',
		role: 'child'
	});
	assert.equal(user.mustChangePassword, true);
	assert.match(tempPassword, /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
	await assert.rejects(
		A.createUser(db, mom, { username: 'y', name: 'Y', role: 'child' }),
		/Only admins/
	);
});

test('sign-in checks the password and slows down guessing', async () => {
	assert.equal(
		(await A.authenticate(db, 'mom', 'wrong', '10.0.0.9')).error,
		'That username and password don’t match.'
	);
	for (let i = 0; i < 5; i++) await A.authenticate(db, 'guess-me', 'nope', '10.0.0.8');
	assert.match(
		(await A.authenticate(db, 'guess-me', 'nope', '10.0.0.8')).error,
		/Too many attempts/
	);
});

test('sessions: valid until signed out or the account is turned off', () => {
	const { token } = A.createSession(db, mom.id);
	assert.equal(A.validateSession(db, token).user.id, mom.id);
	A.setDisabled(db, dad, mom.id, true);
	assert.equal(A.validateSession(db, token), null);
	A.setDisabled(db, dad, mom.id, false);
	const again = A.createSession(db, mom.id).token;
	A.endSession(db, again);
	assert.equal(A.validateSession(db, again), null);
});

test('sign-in redirects only go to pages on this site', () => {
	assert.equal(A.safeNext('/chores'), '/chores');
	for (const bad of ['//evil.example', 'https://evil.example', '/\\evil', '/login'])
		assert.equal(A.safeNext(bad), '/');
});

test('PINs: 4 digits, not too easy; everyone but the kiosk needs one', async () => {
	assert.equal(
		A.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(sam.id)).needsPin,
		true
	);
	assert.equal(
		A.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(tab.id)).needsPin,
		false
	);
	for (const bad of ['1111', '1234', '9876', '12a4', '123', ''])
		assert.ok(A.checkPin(bad).error, bad);
	await A.setPin(db, sam.id, '2580');
	await A.setPin(db, mom.id, '7391');
	await assert.rejects(A.setPin(db, sam.id, '1357'), /current password/); // changing it needs the password
	await assert.rejects(A.setPin(db, tab.id, '1357'), /kiosk account/);
});

test('the kiosk unlocks as a person with their PIN; wrong PINs pause it', async () => {
	const sid = A.validateSession(db, A.createSession(db, tab.id).token).sessionId;
	assert.match((await A.unlockKiosk(db, sid, mom, sam.id, '2580')).error, /Only the kiosk/);
	for (let i = 4; i >= 1; i--)
		assert.equal((await A.unlockKiosk(db, sid, tab, sam.id, '0007')).left, i);
	assert.match((await A.unlockKiosk(db, sid, tab, sam.id, '0007')).error, /Too many wrong PINs/); // the 5th
	assert.match(
		(await A.unlockKiosk(db, sid, tab, sam.id, '2580')).error,
		/Too many wrong PINs/,
		'even the right PIN waits'
	);
	db.prepare('UPDATE users SET pin_locked_until = ? WHERE id = ?').run(Date.now() - 1, sam.id);
	assert.equal((await A.unlockKiosk(db, sid, tab, sam.id, '2580')).acting.name, 'Sam');
	A.lockKiosk(db, sid);
	assert.equal(A.touchKiosk(db, sid), null, 'locked: nothing to keep alive');
});

test('changes on the kiosk are made as the unlocked person', () => {
	assert.throws(() => A.actingUser({ user: tab, acting: null }), A.KioskLocked);
	const as = A.actingUser({ user: tab, acting: { ...sam, until: Date.now() + 1000 } });
	assert.deepEqual([as.id, as.name, as.viaKiosk], [sam.id, 'Sam (kiosk)', true]);
	assert.equal(A.actingUser({ user: mom }), mom);
});

test('an admin can reset a PIN; the person chooses a new one', async () => {
	A.resetPin(db, dad, sam.id);
	assert.match((await A.verifyPin(db, sam.id, '2580')).error, /hasn’t chosen a PIN/);
});
