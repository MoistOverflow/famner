// Web Push: subscriptions, who gets which notification, and the grocery wait.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDbPath, household } from './helpers.js';
import * as A from '../src/lib/server/auth.js';
import * as K from '../src/lib/server/chores.js';
import * as P from '../src/lib/server/push.js';

const path = freshDbPath();
const db = P.pushDb(path);
A.authDb(path);
K.choresDb(path);
const { dad, mom, sam } = await household(A, db);

// what would have gone to the push services
const sent = [];
const gone = new Set();
const restore = P.setSender(async (sub, payload) => {
	if (gone.has(sub.endpoint)) throw Object.assign(new Error('Gone'), { statusCode: 410 });
	sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
});
after(() => P.setSender(restore));

const keys = { p256dh: 'BOr2' + 'a'.repeat(83), auth: 'x'.repeat(22) };
const device = (name, user) => {
	const sessionId = A.validateSession(db, A.createSession(db, user.id).token).sessionId;
	const endpoint = `https://push.example.com/${name}`;
	P.saveSubscription(db, user, { endpoint, keys }, { sessionId });
	return { endpoint, sessionId };
};
const to = (who) => sent.filter((s) => s.endpoint.endsWith(`/${who}`)).map((s) => s.title);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const momPhone = device('mom', mom);
const dadPhone = device('dad', dad);
device('sam', sam);

test('signing keys are made once and kept', () => {
	const k = P.vapidKeys(db);
	assert.equal(k.publicKey.length, 87);
	assert.deepEqual(P.vapidKeys(db), k);
});

test('only real push subscriptions are accepted', () => {
	for (const bad of [
		null,
		{ endpoint: 'http://push.example.com/x', keys },
		{ endpoint: 'https://push.example.com/x', keys: {} },
		{ endpoint: 'nope', keys }
	]) {
		assert.throws(() => P.saveSubscription(db, mom, bad), P.PushError, JSON.stringify(bad));
	}
});

test('a finished chore tells the parents; the review tells the child', async () => {
	const stop = K.onChoreEvent(async (e) => {
		for (const { userId, message } of P.choreMessages(db, e))
			await P.sendTo(db, { userId }, message);
	});
	K.createChore(db, mom, {
		title: 'Dishes',
		assignee: sam.id,
		points: 10,
		due: new Date(Date.now() + 86400000).toISOString(),
		tz: 'America/New_York'
	});
	const id = K.getState(db, mom).chores.find((c) => c.title === 'Dishes').id;
	K.completeChore(db, sam, id);
	await wait(10);
	assert.deepEqual(to('mom'), ['Sam finished “Dishes”']);
	assert.deepEqual(to('dad'), ['Sam finished “Dishes”']);
	assert.deepEqual(to('sam'), []);
	K.reviewChore(db, mom, id, { decision: 'adjust', points: 12, reason: 'Dried them too' });
	await wait(10);
	assert.deepEqual(to('sam'), ['Mom gave you 12 points for “Dishes” 🎉']);
	stop();
});

test('"due soon" goes once, 30 minutes before', async () => {
	K.createChore(db, mom, {
		title: 'Trash',
		assignee: sam.id,
		points: 2,
		due: new Date(Date.now() + 20 * 60000).toISOString(),
		tz: 'America/New_York'
	});
	K.createChore(db, mom, {
		title: 'Later',
		assignee: sam.id,
		points: 2,
		due: new Date(Date.now() + 3 * 3600000).toISOString(),
		tz: 'America/New_York'
	});
	const first = P.dueMessages(db);
	assert.deepEqual(
		first.map((m) => [m.userId, m.message.title]),
		[[sam.id, '“Trash” is due soon']]
	);
	assert.match(first[0].message.body, /^Due at \d{1,2}:\d{2} [AP]M$/);
	assert.deepEqual(P.dueMessages(db), [], 'not again');
});

test('groceries: one notification after people stop adding, never about your own', async () => {
	sent.length = 0;
	const batch = P.groceryBatcher(
		db,
		async (list) => {
			for (const { userId, message, groceriesOnly } of list)
				await P.sendTo(db, { userId, groceriesOnly }, message);
		},
		{ quiet: 40, max: 1000 }
	);
	const add = (item) =>
		batch.changed({ added: [item.id], changes: { upsert: [item], delete: [] } });
	add({ id: 'a', name: 'Milk', qty: 2, createdBy: mom.id });
	await wait(20);
	add({ id: 'b', name: 'Eggs', createdBy: mom.id });
	add({ id: 'c', name: 'Chips', createdBy: sam.id });
	add({ id: 'd', name: 'Gum', createdBy: sam.id });
	batch.changed({ added: [], changes: { upsert: [], delete: ['d'] } }); // taken off again
	await wait(25);
	assert.equal(sent.length, 0, 'still waiting: something was added 25 ms ago');
	await wait(40);
	assert.deepEqual(to('dad'), ['Mom and Sam added 3 items to Groceries']);
	assert.equal(sent.find((s) => s.endpoint.endsWith('/dad')).body, '2 × Milk, Eggs, Chips');
	assert.deepEqual(to('mom'), ['Sam added Chips to Groceries']);
	assert.deepEqual(to('sam'), ['Mom added 2 items to Groceries']);
	batch.stop();
});

test('grocery alerts can be turned off per device', async () => {
	sent.length = 0;
	assert.equal(P.setGroceryAlerts(db, dad, dadPhone.endpoint, false), true);
	assert.equal(
		P.setGroceryAlerts(db, mom, dadPhone.endpoint, true),
		false,
		'not someone else’s device'
	);
	await P.sendTo(db, { userId: dad.id, groceriesOnly: true }, { title: 'x' });
	await P.sendTo(db, { userId: dad.id }, { title: 'chores still come' });
	assert.deepEqual(to('dad'), ['chores still come']);
});

test('signing out stops a device’s notifications; gone subscriptions are forgotten', async () => {
	sent.length = 0;
	db.prepare('DELETE FROM sessions WHERE id = ?').run(momPhone.sessionId); // signed out
	assert.equal(await P.sendTo(db, { userId: mom.id }, { title: 'hello' }), 0);
	gone.add(dadPhone.endpoint);
	assert.equal(await P.sendTo(db, { userId: dad.id }, { title: 'hello' }), 0);
	assert.equal(
		P.subscriptionOf(db, dad, dadPhone.endpoint),
		null,
		'the push service said it’s gone'
	);
});

test('a device that signs in as someone else becomes theirs', () => {
	const s = A.validateSession(db, A.createSession(db, dad.id).token).sessionId;
	P.saveSubscription(db, dad, { endpoint: momPhone.endpoint, keys }, { sessionId: s });
	assert.equal(P.subscriptionOf(db, mom, momPhone.endpoint), null);
	assert.ok(P.subscriptionOf(db, dad, momPhone.endpoint));
});
