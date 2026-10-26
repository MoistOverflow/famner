// The grocery list, backups and factory reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { freshDbPath, household } from './helpers.js';
import * as A from '../src/lib/server/auth.js';
import * as L from '../src/lib/server/collections.js';
import * as K from '../src/lib/server/chores.js';
import * as B from '../src/lib/server/backups.js';
import { factoryReset } from '../src/lib/server/reset.js';

const path = freshDbPath();
const db = A.authDb(path);
L.openLists(path);
K.choresDb(path);
const { dad, mom, sam } = await household(A, db);
const items = () => JSON.parse(L.loadList(db, 'groceries')).items;
const put = (item, user) => L.applyListChanges(db, 'groceries', { upsert: [item] }, 'test', user);

test('groceries: everyone adds; children change only their own items', () => {
	put({ id: 'milk', name: 'Milk', qty: 2, aisle: 'dairy', done: false }, mom);
	put({ id: 'chips', name: 'Chips', done: false }, sam);
	put({ id: 'chips', name: 'Chips', done: true }, sam);
	assert.throws(() => put({ id: 'milk', name: 'Milk', done: true }, sam), L.ListForbiddenError);
	assert.equal(items().find((i) => i.id === 'milk').createdBy, mom.id);
});

test('groceries: quantities and aisles are checked', () => {
	for (const bad of [{ qty: 0 }, { qty: 2.5 }, { qty: 100 }, { aisle: 'Dairy!' }]) {
		assert.throws(
			() => put({ id: 'x', name: 'x', ...bad }, mom),
			L.ListValidationError,
			JSON.stringify(bad)
		);
	}
});

test('backups: one automatic a day, complete copies, safe names only', () => {
	const first = B.backupIfDue(db, path);
	assert.equal(first.kind, 'auto');
	assert.equal(B.backupIfDue(db, path), null, 'not again the same day');
	const copy = new Database(B.backupFile(path, first.name), { readonly: true });
	assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n, 4);
	copy.close();
	for (const bad of ['../calendar.db', 'notes.txt', ''])
		assert.equal(B.backupFile(path, bad), null, bad);
});

test('factory reset: admins only, password + RESET, backup first, then empty', async () => {
	await assert.rejects(
		factoryReset(db, path, mom, { password: 'x', confirm: 'RESET' }),
		/Only admins/
	);
	await assert.rejects(
		factoryReset(db, path, dad, { password: 'family-admin-1', confirm: 'reset' }),
		/Type RESET/
	);
	await assert.rejects(
		factoryReset(db, path, dad, { password: 'wrong', confirm: 'RESET' }),
		/password isn’t right/
	);
	assert.equal(A.userCount(db), 4, 'nothing deleted after a refusal');
	const { backup } = await factoryReset(db, path, dad, {
		password: 'family-admin-1',
		confirm: 'RESET'
	});
	assert.equal(A.userCount(db), 0);
	assert.equal(items().length, 0);
	assert.ok(backup && existsSync(B.backupFile(path, backup)), 'a backup was made first');
	await A.createFirstAdmin(db, { username: 'again', name: 'Again', password: 'another-pass-1' });
});
