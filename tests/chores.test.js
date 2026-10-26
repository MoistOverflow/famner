// Chores: finishing, reviewing, points, rewards, skipping, and repeat rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDbPath, household } from './helpers.js';
import * as A from '../src/lib/server/auth.js';
import * as K from '../src/lib/server/chores.js';
import { repeatLabel } from '../src/lib/choreText.js';

const path = freshDbPath();
const db = K.choresDb(path);
A.authDb(path);
const { dad, mom, sam, tab } = await household(A, db);

const tz = 'America/New_York';
const soon = () => new Date(Math.floor((Date.now() + 3600000) / 60000) * 60000).toISOString();
const chore = (title, extra = {}) => {
	K.createChore(db, mom, { title, assignee: sam.id, points: 10, due: soon(), tz, ...extra });
	return K.getState(db, mom).chores.find((c) => c.title === title).id;
};
const err = (fn, cls, re) => assert.throws(fn, (e) => e instanceof cls && re.test(e.message));
const pts = () => K.balanceOf(db, sam.id);

test('only parents add chores; a child’s finished chore waits for review', () => {
	err(
		() => K.createChore(db, sam, { title: 'x', assignee: sam.id, points: 1, due: soon() }),
		K.ChoreForbidden,
		/Only parents/
	);
	err(
		() => K.createChore(db, mom, { title: 'x', assignee: tab.id, points: 1, due: soon() }),
		K.ChoreError,
		/Pick who/
	);
	const id = chore('Dishes');
	// on the tablet, only the person it's for can mark it done
	err(() => K.completeChore(db, dad, id, { ownOnly: true }), K.ChoreForbidden, /only Sam/);
	assert.equal(K.completeChore(db, sam, id).status, 'submitted');
	assert.equal(pts(), 0);
	K.reviewChore(db, mom, id, { decision: 'approve' });
	assert.equal(pts(), 10);
});

test('reviews can change points, but need a reason', () => {
	const yard = chore('Yard');
	K.completeChore(db, sam, yard);
	err(
		() => K.reviewChore(db, mom, yard, { decision: 'adjust', points: 14 }),
		K.ChoreError,
		/extra points/
	);
	K.reviewChore(db, mom, yard, { decision: 'adjust', points: 14, reason: 'Raked the front too' });
	const bed = chore('Bed');
	K.completeChore(db, sam, bed);
	err(() => K.reviewChore(db, mom, bed, { decision: 'deny' }), K.ChoreError, /Say why/);
	K.reviewChore(db, mom, bed, { decision: 'deny', reason: 'Not done' });
	assert.equal(pts(), 24);
	const outcomes = K.getState(db, sam).history.map((h) => h.outcome);
	assert.deepEqual(outcomes.slice(0, 2), ['denied', 'bonus']);
});

test('rewards spend points; balances can’t go below zero', () => {
	K.addReward(db, mom, { name: 'Ice cream', cost: 20 });
	const reward = K.getState(db, sam).rewards[0].id;
	K.redeemReward(db, sam, reward);
	assert.equal(pts(), 4);
	err(() => K.redeemReward(db, sam, reward), K.ChoreError, /need 16 more/);
	err(() => K.adjustPoints(db, mom, sam.id, 5, 'x'), K.ChoreForbidden, /Only admins/);
	err(() => K.adjustPoints(db, dad, sam.id, -10, 'oops'), K.ChoreError, /at most 4/);
	const pending = K.getState(db, mom).redemptions.find((r) => r.status === 'pending').id;
	err(() => K.handleRedemption(db, sam, pending, 'given'), K.ChoreForbidden, /Only parents/);
	K.handleRedemption(db, mom, pending, 'refund');
	assert.equal(pts(), 24);
});

test('skipping a repeating chore moves it on without points', () => {
	const trash = chore('Trash', { repeat: 'daily' });
	const before = K.getState(db, sam).chores.find((c) => c.id === trash).due;
	K.skipChore(db, mom, trash, 'Away');
	const after = K.getState(db, sam).chores.find((c) => c.id === trash).due;
	assert.equal(after - before, 86400000);
	assert.equal(pts(), 24);
});

// ---------- repeat rules ----------
const at = (s) => Date.parse(s);
const fmt = (ms) =>
	new Date(ms).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
function series(input, first, n = 5, doneAt = null) {
	const rule = K.readRepeat(input, first, tz);
	let row = { due: first, repeat: JSON.stringify(rule), tz };
	const out = [fmt(first)];
	for (let i = 1; i < n; i++) {
		const next = K.advance(row, doneAt ? doneAt(row.due) : row.due, row.due);
		if (!next) {
			out.push('end');
			break;
		}
		out.push(fmt(next.due));
		row = { due: next.due, repeat: JSON.stringify(next.repeat), tz };
	}
	return { out, label: repeatLabel(rule) };
}
const tue = at('2026-11-03T19:00:00-05:00'); // a Tuesday, 7 PM

test('every 2 weeks on Tuesday and Thursday', () => {
	const r = series({ repeat: 'custom', interval: 2, unit: 'weekly', days: ['2', '4'] }, tue, 5);
	assert.deepEqual(r.out, ['Nov 3', 'Nov 5', 'Nov 17', 'Nov 19', 'Dec 1']);
	assert.equal(r.label, 'Every 2 weeks on Tuesday and Thursday');
});

test('monthly on the first Tuesday, and on the last Friday', () => {
	assert.deepEqual(series({ repeat: 'monthly', monthBy: 'nth' }, tue, 4).out, [
		'Nov 3',
		'Dec 1',
		'Jan 5',
		'Feb 2'
	]);
	assert.deepEqual(
		series({ repeat: 'monthly', monthBy: 'last' }, at('2026-11-27T18:00:00-05:00'), 4).out,
		['Nov 27', 'Dec 25', 'Jan 29', 'Feb 26']
	);
});

test('ends after N times, or on a date', () => {
	assert.deepEqual(series({ repeat: 'daily', ends: 'after', count: '3' }, tue, 5).out, [
		'Nov 3',
		'Nov 4',
		'Nov 5',
		'end'
	]);
	assert.deepEqual(series({ repeat: 'daily', ends: 'on', until: '2026-11-04' }, tue, 5).out, [
		'Nov 3',
		'Nov 4',
		'end'
	]);
});

test('"2 weeks after it’s done" counts from the day it was done', () => {
	const r = series(
		{ repeat: 'custom', interval: 2, unit: 'weekly', from: 'done' },
		tue,
		3,
		(due) => due + 7 * 86400000
	);
	assert.deepEqual(r.out, ['Nov 3', 'Nov 24', 'Dec 15']);
});

test('impossible repeat rules are refused', () => {
	err(
		() => K.readRepeat({ repeat: 'custom', interval: 0, unit: 'daily' }, tue, tz),
		K.ChoreError,
		/Every/
	);
	err(
		() => K.readRepeat({ repeat: 'monthly', monthBy: 'last' }, tue, tz),
		K.ChoreError,
		/isn’t the last/
	);
	err(
		() => K.readRepeat({ repeat: 'daily', ends: 'on', until: '2026-10-01' }, tue, tz),
		K.ChoreError,
		/ends before/
	);
});
