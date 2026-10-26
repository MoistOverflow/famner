// Calendar storage: who sees which calendar, who may change what, and live messages per person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDbPath, household } from './helpers.js';
import * as A from '../src/lib/server/auth.js';
import * as C from '../src/lib/server/calendarDb.js';

const db = A.authDb(freshDbPath());
const { dad, mom, sam, tab } = await household(A, db);

const save = (changes, user) =>
	C.applyChanges(
		db,
		{ upsertCalendars: [], deleteCalendars: [], upsertEvents: [], deleteEvents: [], ...changes },
		'test',
		user
	);
const sees = (user) => {
	const data = JSON.parse(C.loadAll(db, user));
	return { cals: data.calendars.map((c) => c.id).sort(), evs: data.events.map((e) => e.id).sort() };
};
const ev = (id, calendar, extra = {}) => ({
	id,
	calendar,
	title: id,
	start: '2026-11-02T10:00:00Z',
	end: '2026-11-02T11:00:00Z',
	...extra
});
const forbidden = (fn, re) =>
	assert.throws(fn, (e) => e instanceof C.ForbiddenError && (!re || re.test(e.message)));

save(
	{
		upsertCalendars: [{ id: 'fam', label: 'Family', color: '#0a0' }],
		upsertEvents: [ev('dinner', 'fam')]
	},
	mom
);

test('a shared calendar is seen by everyone; new events record who added them', () => {
	for (const u of [dad, mom, sam]) assert.ok(sees(u).cals.includes('fam'));
	assert.equal(
		JSON.parse(C.loadAll(db, dad)).events.find((e) => e.id === 'dinner').createdBy,
		mom.id
	);
});

test('a calendar shared with chosen people: they can look, not change', () => {
	save(
		{
			upsertCalendars: [
				{
					id: 'work',
					label: 'Work',
					color: '#00f',
					private: true,
					sharedWith: [dad.id, 'nobody', mom.id]
				}
			],
			upsertEvents: [ev('meeting', 'work')]
		},
		mom
	);
	const work = JSON.parse(C.loadAll(db, mom)).calendars.find((c) => c.id === 'work');
	assert.deepEqual(
		[work.owner, work.sharedWith],
		[mom.id, [dad.id]],
		'unknown ids and the owner are dropped'
	);
	assert.ok(sees(dad).evs.includes('meeting'));
	assert.ok(!sees(sam).cals.includes('work'));
	forbidden(() => save({ upsertEvents: [ev('meeting', 'work', { title: 'changed' })] }, dad));
	forbidden(() => save({ upsertEvents: [ev('dads', 'work')] }, dad));
	forbidden(() => save({ upsertCalendars: [{ ...work, sharedWith: [dad.id, sam.id] }] }, dad));
	forbidden(() => save({ deleteCalendars: ['work'] }, dad));
});

test('changing who sees a calendar updates other devices live', () => {
	const messages = [];
	const stop = C.subscribe((m) => messages.push(m));
	const base = { id: 'work', label: 'Work', color: '#00f', private: true };
	save({ upsertCalendars: [{ ...base, sharedWith: [dad.id, sam.id] }] }, mom);
	assert.equal(
		C.messageFor(messages.at(-1), sam.id).resync,
		true,
		'Sam’s devices reload to get it'
	);
	save({ upsertCalendars: [{ ...base, sharedWith: [sam.id] }] }, mom);
	assert.deepEqual(
		C.messageFor(messages.at(-1), dad.id).changes.deleteCalendars,
		['work'],
		'gone from Dad’s devices'
	);
	stop?.();
});

test('children change only what they added, and can’t subscribe or change shared calendars', () => {
	save({ upsertEvents: [ev('soccer', 'fam')] }, sam);
	save({ upsertEvents: [ev('soccer', 'fam', { title: 'Soccer practice' })] }, sam);
	forbidden(
		() => save({ upsertEvents: [ev('dinner', 'fam', { title: 'pizza' })] }, sam),
		/only change events you added/
	);
	forbidden(() => save({ deleteEvents: ['dinner'] }, sam));
	forbidden(() =>
		save({ upsertCalendars: [{ id: 'fam', label: 'Mine now', color: '#0a0' }] }, sam)
	);
	forbidden(() =>
		save(
			{
				upsertCalendars: [
					{ id: 'feed', label: 'Feed', color: '#000', source: { url: 'https://x.example/a.ics' } }
				]
			},
			sam
		)
	);
	save(
		{ upsertCalendars: [{ id: 'sam-diary', label: 'Diary', color: '#f0f', private: true }] },
		sam
	);
	assert.ok(sees(sam).cals.includes('sam-diary') && !sees(mom).cals.includes('sam-diary'));
});

test('the kiosk changes only the unlocked person’s events, in calendars shared with it', () => {
	const asKiosk = (u) => ({ ...u, role: 'kiosk', kioskId: tab.id });
	save({ upsertEvents: [ev('k1', 'fam')] }, asKiosk(sam));
	forbidden(
		() => save({ upsertEvents: [ev('dinner', 'fam', { title: 'x' })] }, asKiosk(sam)),
		/Only the person who added/
	);
	forbidden(
		() => save({ upsertEvents: [ev('k2', 'sam-diary')] }, asKiosk(sam)),
		/isn’t shared with the tablet/
	);
	forbidden(
		() => save({ upsertCalendars: [{ id: 'new', label: 'New', color: '#000' }] }, asKiosk(mom)),
		/can’t be changed on the kiosk/
	);
});

test('removing a person deletes their private calendars', () => {
	assert.equal(C.privateCalendarCount(db, sam.id), 1);
	A.deleteUser(db, dad, sam.id);
	assert.ok(!JSON.parse(C.loadAll(db, null)).calendars.some((c) => c.id === 'sam-diary'));
});
