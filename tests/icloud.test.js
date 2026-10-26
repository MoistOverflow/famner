// Two-way iCloud sync, against a pretend iCloud server (tests/fakeCaldav.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDbPath, household } from './helpers.js';
import { fakeCaldav } from './fakeCaldav.js';
import * as A from '../src/lib/server/auth.js';
import * as C from '../src/lib/server/calendarDb.js';
import * as I from '../src/lib/server/icloud.js';
import {
	parseICS,
	expandEvents,
	ymd,
	detachOccurrence
} from '../src/lib/components/calendarUtils.js';

const path = freshDbPath();
const db = I.icloudDb(path);
A.authDb(path);
const { mom, sam, tab } = await household(A, db);
const fake = await fakeCaldav();
after(() => fake.close());

const famner = (calId) =>
	JSON.parse(C.loadAll(db, null)).events.filter((e) => e.calendar === calId);
const byTitle = (calId, title) => famner(calId).find((e) => e.title === title);
const save = (changes, user = mom) =>
	C.applyChanges(db, { upsertEvents: [], deleteEvents: [], ...changes }, 'browser', user);
const sync = (calId) => I.syncCalendar(db, path, calId);
const remoteText = (id) => [...fake.files(id).values()].join('\n');
const remoteFile = (id, uid) => [...fake.files(id)].find(([, t]) => t.includes(`UID:${uid}`));
const days = (ics, title) =>
	expandEvents(
		parseICS(ics)
			.events.filter((e) => e.title === title)
			.map((e, i) => ({ ...e, id: i })),
		new Date('2026-10-01'),
		new Date('2027-03-01')
	)
		.map((o) => ymd(o.start))
		.sort();

// what the family calendar looks like on the iPhone to start with
const ics = (body) =>
	`BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Apple Inc.//iPhone OS 26.0//EN\n${body}\nEND:VCALENDAR\n`;
fake.addCalendar('family', { name: 'Family', color: '#34C759FF' });
fake.addCalendar('reminders', { name: 'Reminders', comps: ['VTODO'] });
fake.addCalendar('holidays', { name: 'US Holidays', writable: false });
fake.put(
	'family',
	'piano.ics',
	ics(`BEGIN:VEVENT
UID:PIANO-1
DTSTAMP:20261020T120000Z
LAST-MODIFIED:20261020T120000Z
DTSTART;TZID=America/New_York:20261102T160000
DTEND;TZID=America/New_York:20261102T170000
RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6
EXDATE;TZID=America/New_York:20261116T160000
SUMMARY:Piano
ATTENDEE;CN=Teacher:mailto:teacher@example.com
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT15M
DESCRIPTION:Reminder
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:PIANO-1
RECURRENCE-ID;TZID=America/New_York:20261109T160000
DTSTAMP:20261020T120000Z
DTSTART;TZID=America/New_York:20261109T170000
DTEND;TZID=America/New_York:20261109T180000
SUMMARY:Piano (late)
END:VEVENT`)
);
fake.put(
	'family',
	'trip.ics',
	ics(`BEGIN:VEVENT
UID:TRIP-1
DTSTAMP:20261020T120000Z
LAST-MODIFIED:20261020T120000Z
DTSTART;VALUE=DATE:20261220
DTEND;VALUE=DATE:20261223
SUMMARY:Ski trip
X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC
END:VEVENT`)
);
fake.put(
	'family',
	'dinner.ics',
	ics(`BEGIN:VEVENT
UID:DINNER-1
DTSTAMP:20261020T120000Z
DTSTART;TZID=America/Los_Angeles:20261105T190000
DTEND;TZID=America/Los_Angeles:20261105T210000
SUMMARY:Dinner with Grandma
LOCATION:San Diego
END:VEVENT`)
);
fake.put(
	'family',
	'odd.ics',
	ics(`BEGIN:VEVENT
UID:ODD-1
DTSTAMP:20261020T120000Z
DTSTART;TZID=America/New_York:20261105T080000
DTEND;TZID=America/New_York:20261105T083000
RRULE:FREQ=MONTHLY;BYMONTHDAY=5,20
SUMMARY:Pay bills
END:VEVENT`)
);

let familyId;

test('connecting checks the password and keeps it encrypted', async () => {
	await assert.rejects(
		I.connectAccount(db, path, mom, { appleId: fake.user, password: 'wrong', server: fake.url }),
		/didn’t accept/
	);
	await assert.rejects(
		I.connectAccount(db, path, tab, {
			appleId: fake.user,
			password: fake.password,
			server: fake.url
		}),
		/kiosk/
	);
	const cals = await I.connectAccount(db, path, mom, {
		appleId: fake.user,
		password: fake.password,
		server: fake.url
	});
	assert.deepEqual(
		cals.map((c) => [c.name, c.writable]).sort(),
		[
			['Family', true],
			['US Holidays', false]
		],
		'reminders lists are left out'
	);
	const row = db.prepare('SELECT secret FROM icloud_accounts WHERE user_id = ?').get(mom.id);
	assert.ok(!row.secret.includes(fake.password));
	assert.equal(I.accountStatus(db, mom).connected, true);
});

test('an iCloud calendar comes into Famner as a new calendar', async () => {
	const holidays = (await I.remoteCalendars(db, path, mom)).find((c) => c.name === 'US Holidays');
	await assert.rejects(I.linkCalendar(db, path, mom, { remoteUrl: holidays.url }), /view-only/);
	const family = (await I.remoteCalendars(db, path, mom)).find((c) => c.name === 'Family');
	const { calendarId } = await I.linkCalendar(db, path, mom, { remoteUrl: family.url });
	familyId = calendarId;
	const cal = JSON.parse(C.loadAll(db, null)).calendars.find((c) => c.id === calendarId);
	assert.deepEqual([cal.label, cal.color, !!cal.private], ['Family', '#34c759', false]);

	const piano = byTitle(familyId, 'Piano');
	assert.deepEqual(
		piano.exdates.sort(),
		['2026-11-09', '2026-11-16'],
		'skipped, and the moved one'
	);
	assert.equal(piano.createdBy, mom.id);
	const late = byTitle(familyId, 'Piano (late)');
	assert.equal(new Date(late.start).getHours(), 17);
	assert.equal(byTitle(familyId, 'Ski trip').allDay, true);
	assert.equal(
		new Date(byTitle(familyId, 'Dinner with Grandma').start).getHours(),
		22,
		'7 PM in California is 10 PM here'
	);
	assert.equal(
		byTitle(familyId, 'Pay bills').repeat,
		undefined,
		'a rule Famner can’t show: first date only…'
	);
	assert.match(I.accountStatus(db, mom).links[0].warnings.join(), /Pay bills/, '…with a warning');
	assert.ok(!I.accountStatus(db, mom).linkable.some((c) => c.id === familyId));
});

test('nothing changed: a sync only asks iCloud’s change tag', async () => {
	fake.log.length = 0;
	await sync(familyId);
	await sync(familyId);
	assert.ok(
		fake.log.every((l) => l.startsWith('PROPFIND')),
		fake.log.join()
	);
});

test('an edit in Famner goes to iCloud, keeping what Famner doesn’t show', async () => {
	save({ upsertEvents: [{ ...byTitle(familyId, 'Piano'), title: 'Piano lesson' }] });
	const stats = await sync(familyId);
	assert.equal(stats.pushed, 1);
	const [, text] = remoteFile('family', 'PIANO-1');
	assert.match(text, /SUMMARY:Piano lesson/);
	assert.match(text, /ATTENDEE;CN=Teacher/);
	assert.match(text, /TRIGGER:-PT15M/);
	assert.match(
		text,
		/RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6/,
		'iCloud’s own wording of the repeat is kept'
	);
	assert.match(
		text,
		/RECURRENCE-ID;TZID=America\/New_York:20261109T160000/,
		'the moved occurrence stays attached'
	);
	assert.match(text, /SEQUENCE:1/);
	assert.match(
		text,
		/SUMMARY:Piano \(late\)\r\nEND:VEVENT/,
		'the untouched occurrence keeps its timestamps'
	);
	assert.deepEqual(days(text, 'Piano lesson'), [
		'2026-11-02',
		'2026-11-23',
		'2026-11-30',
		'2026-12-07'
	]);
	fake.log.length = 0;
	await sync(familyId);
	assert.ok(!fake.log.some((l) => l.startsWith('PUT')), 'iCloud’s answer doesn’t bounce back');
});

test('edits and deletions on the iPhone come into Famner', async () => {
	const [file, text] = remoteFile('family', 'TRIP-1');
	fake.put(
		'family',
		file,
		text
			.replace('SUMMARY:Ski trip', 'SUMMARY:Ski trip to Vermont')
			.replace(/LAST-MODIFIED:\S+/, 'LAST-MODIFIED:20261101T000000Z')
	);
	fake.remove('family', 'dinner.ics');
	const stats = await sync(familyId);
	assert.deepEqual([stats.pulled, stats.deleted], [1, 1]);
	assert.ok(byTitle(familyId, 'Ski trip to Vermont'));
	assert.equal(byTitle(familyId, 'Dinner with Grandma'), undefined);
});

test('a new repeating event from Famner keeps its time and weekday in iCloud', async () => {
	save({
		upsertEvents: [
			{
				id: 'swim',
				calendar: familyId,
				title: 'Swim',
				start: new Date('2026-11-03T20:30').toISOString(),
				end: new Date('2026-11-03T21:30').toISOString(),
				repeat: { freq: 'weekly', interval: 1, byWeekday: [2], count: 4 }
			}
		]
	});
	await sync(familyId);
	const text = remoteText('family');
	assert.match(text, /DTSTART;TZID=America\/New_York:20261103T203000/);
	assert.match(text, /BEGIN:VTIMEZONE\r\nTZID:America\/New_York/);
	assert.match(
		text,
		/RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU/,
		'daylight saving starts the 2nd Sunday of March'
	);
	assert.deepEqual(
		days(text, 'Swim'),
		['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24'],
		'evenings stay on Tuesdays'
	);
});

test('deleting a moved occurrence in Famner skips that date in iCloud', async () => {
	save({ deleteEvents: [byTitle(familyId, 'Piano (late)').id] });
	await sync(familyId);
	const [, text] = remoteFile('family', 'PIANO-1');
	assert.doesNotMatch(text, /RECURRENCE-ID/);
	assert.match(text, /EXDATE;TZID=America\/New_York:20261109T160000/);
	assert.deepEqual(days(text, 'Piano lesson'), [
		'2026-11-02',
		'2026-11-23',
		'2026-11-30',
		'2026-12-07'
	]);
});

test('"this event" in Famner: skipped in the series, saved on its own', async () => {
	const piano = byTitle(familyId, 'Piano lesson');
	const ev = { ...piano, start: new Date(piano.start), end: new Date(piano.end) };
	const { series, single } = detachOccurrence(ev, {
		start: new Date('2026-11-23T16:00'),
		end: new Date('2026-11-23T17:00')
	});
	save({
		upsertEvents: [
			{ ...series, start: piano.start, end: piano.end },
			{
				...single,
				id: 'moved',
				title: 'Piano at Nana’s',
				start: new Date('2026-11-23T18:00').toISOString(),
				end: new Date('2026-11-23T19:00').toISOString()
			}
		]
	});
	await sync(familyId);
	const text = remoteText('family');
	assert.deepEqual(days(text, 'Piano lesson'), ['2026-11-02', '2026-11-30', '2026-12-07']);
	assert.deepEqual(days(text, 'Piano at Nana’s'), ['2026-11-23']);
});

test('changed in both places: the newer change wins', async () => {
	// Famner first, then the iPhone a minute later → the iPhone's
	save({ upsertEvents: [{ ...byTitle(familyId, 'Ski trip to Vermont'), title: 'Famner title' }] });
	let [file, text] = remoteFile('family', 'TRIP-1');
	const future = new Date(Date.now() + 60000)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d+/, '');
	fake.put(
		'family',
		file,
		text
			.replace(/SUMMARY:.*/, 'SUMMARY:iPhone title')
			.replace(/LAST-MODIFIED:\S+/, `LAST-MODIFIED:${future}`)
	);
	let stats = await sync(familyId);
	assert.equal(stats.conflicts, 1);
	assert.ok(byTitle(familyId, 'iPhone title'));
	// the iPhone (an old change, synced late), then Famner → Famner's
	[file, text] = remoteFile('family', 'TRIP-1');
	fake.put(
		'family',
		file,
		text
			.replace(/SUMMARY:.*/, 'SUMMARY:Old iPhone title')
			.replace(/LAST-MODIFIED:\S+/, 'LAST-MODIFIED:20260101T000000Z')
	);
	save({ upsertEvents: [{ ...byTitle(familyId, 'iPhone title'), title: 'Newer Famner title' }] });
	stats = await sync(familyId);
	assert.equal(stats.conflicts, 1);
	assert.ok(byTitle(familyId, 'Newer Famner title'));
	assert.match(remoteFile('family', 'TRIP-1')[1], /SUMMARY:Newer Famner title/);
	assert.match(remoteFile('family', 'TRIP-1')[1], /X-APPLE-TRAVEL-ADVISORY-BEHAVIOR/);
});

test('a repeat Famner can’t show is left alone in iCloud', async () => {
	save({ upsertEvents: [{ ...byTitle(familyId, 'Pay bills'), title: 'Pay the bills' }] });
	await sync(familyId);
	const [, text] = remoteFile('family', 'ODD-1');
	assert.match(text, /SUMMARY:Pay the bills/);
	assert.match(text, /RRULE:FREQ=MONTHLY;BYMONTHDAY=5,20/);
});

test('changed in iCloud just before Famner saves: Famner edits the newest version', async () => {
	save({ upsertEvents: [{ ...byTitle(familyId, 'Newer Famner title'), title: 'Trip (final)' }] });
	// between Famner's look and its save, someone adds an invitee on their iPhone
	fake.beforePut = (cal, file) => {
		const text = fake.files(cal).get(file);
		fake.put(
			cal,
			file,
			text.replace('END:VEVENT', 'ATTENDEE;CN=Nana:mailto:nana@example.com\nEND:VEVENT')
		);
	};
	await sync(familyId);
	const [, text] = remoteFile('family', 'TRIP-1');
	assert.match(text, /SUMMARY:Trip \(final\)/);
	assert.match(text, /ATTENDEE;CN=Nana/, 'their change is kept too');
});

test('moving a whole series in Famner keeps its separately edited occurrence, on its own', async () => {
	fake.put(
		'family',
		'yoga.ics',
		ics(`BEGIN:VEVENT
UID:YOGA-1
DTSTAMP:20261020T120000Z
DTSTART;TZID=America/New_York:20261104T070000
DTEND;TZID=America/New_York:20261104T080000
RRULE:FREQ=DAILY;COUNT=4
SUMMARY:Yoga
END:VEVENT
BEGIN:VEVENT
UID:YOGA-1
RECURRENCE-ID;TZID=America/New_York:20261105T070000
DTSTAMP:20261020T120000Z
DTSTART;TZID=America/New_York:20261105T090000
DTEND;TZID=America/New_York:20261105T100000
SUMMARY:Yoga (late)
END:VEVENT`)
	);
	await sync(familyId);
	const yoga = byTitle(familyId, 'Yoga');
	const hour = 3600000;
	save({
		upsertEvents: [
			{
				...yoga,
				start: new Date(Date.parse(yoga.start) + hour).toISOString(),
				end: new Date(Date.parse(yoga.end) + hour).toISOString()
			}
		]
	});
	await sync(familyId);
	const text = remoteText('family');
	assert.doesNotMatch(remoteFile('family', 'YOGA-1')[1], /RECURRENCE-ID/);
	assert.match(remoteFile('family', 'YOGA-1')[1], /DTSTART;TZID=America\/New_York:20261104T080000/);
	assert.deepEqual(days(text, 'Yoga'), ['2026-11-04', '2026-11-06', '2026-11-07']);
	assert.deepEqual(days(text, 'Yoga (late)'), ['2026-11-05']);
	await sync(familyId);
	assert.equal(
		famner(familyId).filter((e) => e.title.startsWith('Yoga')).length,
		2,
		'still one series and one occurrence in Famner'
	);
});

test('a Famner calendar can go to a new iCloud calendar; matching events aren’t doubled', async () => {
	C.applyChanges(
		db,
		{
			upsertCalendars: [{ id: 'school', label: 'School', color: '#ff9500' }],
			upsertEvents: [
				{
					id: 's1',
					calendar: 'school',
					title: 'Field trip',
					start: new Date('2026-11-12T09:00').toISOString(),
					end: new Date('2026-11-12T15:00').toISOString()
				},
				{
					id: 's2',
					calendar: 'school',
					title: 'No school',
					allDay: true,
					start: new Date('2026-11-26T00:00').toISOString(),
					end: new Date('2026-11-27T00:00').toISOString()
				}
			]
		},
		'browser',
		mom
	);
	const { calendarId } = await I.linkCalendar(db, path, mom, { calendarId: 'school' });
	assert.equal(calendarId, 'school');
	const made = [...fake.calendars.entries()].find(([, c]) => c.name === 'School');
	assert.ok(made, 'a new iCloud calendar');
	assert.equal(made[1].items.size, 2);
	assert.equal(famner('school').length, 2, 'nothing doubled on the way back');
	assert.match(
		[...made[1].items.values()].map((i) => i.data).join(),
		/DTSTART;VALUE=DATE:20261126/
	);
});

test('who may sync what', async () => {
	await I.connectAccount(db, path, sam, {
		appleId: fake.user,
		password: fake.password,
		server: fake.url
	});
	const status = I.accountStatus(db, sam);
	assert.ok(
		!status.linkable.some((c) => c.id === 'school'),
		'children can’t sync shared calendars'
	);
	await assert.rejects(
		I.linkCalendar(db, path, sam, { calendarId: 'school' }),
		/Only parents|already synced/
	);
	fake.addCalendar('sams', { name: 'Sam’s stuff' });
	const sams = (await I.remoteCalendars(db, path, sam)).find((c) => c.name === 'Sam’s stuff');
	const { calendarId } = await I.linkCalendar(db, path, sam, { remoteUrl: sams.url });
	assert.equal(
		JSON.parse(C.loadAll(db, null)).calendars.find((c) => c.id === calendarId).private,
		true,
		'a child’s calendars are private'
	);
	assert.throws(() => I.unlinkCalendar(db, mom, calendarId), /Only the person/);
	I.disconnectAccount(db, sam);
	assert.equal(I.accountStatus(db, sam).connected, false);
	assert.equal(
		db.prepare('SELECT COUNT(*) AS n FROM icloud_links WHERE user_id = ?').get(sam.id).n,
		0
	);
});

test('a password iCloud stops accepting pauses syncing until reconnected', async () => {
	const saved = fake.password;
	fake.password = 'revoked-in-apple-account';
	await assert.rejects(sync(familyId), /didn’t accept/);
	assert.equal(I.accountStatus(db, mom).status, 'auth');
	assert.match(I.accountStatus(db, mom).error, /Connect again/);
	assert.deepEqual(await sync(familyId), { skipped: true }, 'no more tries with the old password');
	fake.password = saved;
	await I.connectAccount(db, path, mom, {
		appleId: fake.user,
		password: fake.password,
		server: fake.url
	});
	assert.equal(I.accountStatus(db, mom).status, 'ok');
	assert.ok((await sync(familyId)).pulled >= 0);
});

test('deleting a synced calendar in Famner stops its sync (iCloud keeps it)', async () => {
	I.startICloudSync(path);
	try {
		C.applyChanges(db, { deleteCalendars: ['school'] }, 'browser', mom);
		assert.equal(
			db.prepare("SELECT COUNT(*) AS n FROM icloud_links WHERE calendar_id = 'school'").get().n,
			0
		);
		assert.ok([...fake.calendars.values()].some((c) => c.name === 'School'));
	} finally {
		globalThis.__icloudSync.stop();
		delete globalThis.__icloudSync;
	}
});
