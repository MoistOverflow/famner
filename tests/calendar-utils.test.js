// Dates, repeats, splitting a repeating event, .ics export/import, and grocery text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	expandEvents,
	ymd,
	atMinute,
	layoutTimedDay,
	splitSeries,
	detachOccurrence,
	toICS,
	parseICS,
	shiftEvent,
	deltaBetween
} from '../src/lib/components/calendarUtils.js';
import { parseItem, guessAisle } from '../src/lib/groceryText.js';

const d = (s) => new Date(s);
const days = (events, from = '2026-10-01', to = '2027-03-01') =>
	expandEvents(events, d(from), d(to))
		.map((o) => ymd(o.start))
		.sort();

const piano = () => ({
	id: 's',
	calendar: 'fam',
	title: 'Piano',
	start: d('2026-11-02T16:00'),
	end: d('2026-11-02T17:00'),
	repeat: { freq: 'weekly', byWeekday: [1], count: 6 }
});

test('a weekly repeat with a count and skipped dates', () => {
	const ev = { ...piano(), exdates: ['2026-11-16'] };
	assert.deepEqual(days([ev]), [
		'2026-11-02',
		'2026-11-09',
		'2026-11-23',
		'2026-11-30',
		'2026-12-07'
	]);
});

test('"this and following" splits a series without losing or adding any', () => {
	const ev = piano();
	const occ = { start: d('2026-11-16T16:00'), end: d('2026-11-16T17:00') };
	const { head, tail } = splitSeries(ev, occ);
	tail.id = 's2';
	assert.equal(head.repeat.count, 2);
	assert.equal(tail.repeat.count, 4);
	assert.deepEqual(days([head, tail]), days([ev]));
});

test('splitting at the first occurrence leaves nothing before it', () => {
	const ev = piano();
	assert.equal(splitSeries(ev, { start: ev.start, end: ev.end }).head, null);
});

test('"this event" takes one occurrence out as a one-off', () => {
	const ev = piano();
	const { series, single } = detachOccurrence(ev, {
		start: d('2026-11-09T16:00'),
		end: d('2026-11-09T17:00')
	});
	assert.ok(series.exdates.includes('2026-11-09'));
	assert.equal(single.repeat, undefined);
	assert.equal(ymd(single.start), '2026-11-09');
});

test('moving a weekly event moves its weekdays too', () => {
	const moved = shiftEvent(piano(), 1, 0); // Monday → Tuesday
	assert.deepEqual(moved.repeat.byWeekday, [2]);
});

test('.ics export reads back the same events and repeats', () => {
	const events = [
		{ ...piano(), exdates: ['2026-11-09'] },
		{
			id: 'trip',
			calendar: 'fam',
			title: 'Trip, with "quotes"',
			allDay: true,
			start: d('2026-12-20T00:00'),
			end: d('2026-12-23T00:00'),
			notes: 'line 1\nline 2 ' + 'x'.repeat(120)
		},
		{
			id: 'club',
			calendar: 'fam',
			title: 'Book club',
			start: d('2026-11-19T19:00'),
			end: d('2026-11-19T20:30'),
			repeat: { freq: 'monthly', monthlyBy: 'nth', until: d('2027-06-30') }
		}
	];
	const text = toICS(events, { name: 'Family' });
	assert.ok(
		text.split('\r\n').every((line) => new TextEncoder().encode(line).length <= 75),
		'lines are folded'
	);
	const back = parseICS(text);
	assert.equal(back.name, 'Family');
	assert.equal(back.events.length, 3);
	for (const e of events) {
		const b = back.events.find((x) => x.title === e.title);
		assert.ok(b, e.title);
		assert.deepEqual(
			days([{ ...b, id: 'x' }], '2026-10-01', '2027-08-01'),
			days([e], '2026-10-01', '2027-08-01'),
			e.title
		);
	}
	assert.equal(back.events.find((x) => x.id !== 's' && x.allDay)?.notes, events[1].notes);
});

test('grocery quantities are read from what was typed', () => {
	const cases = {
		'2 milk': ['milk', 2],
		'milk x2': ['milk', 2],
		'2x milk': ['milk', 2],
		'Eggs ×3': ['Eggs', 3],
		milk: ['milk', 1],
		'2 lb beef': ['2 lb beef', 1],
		'7up': ['7up', 1]
	};
	for (const [typed, [name, qty]] of Object.entries(cases))
		assert.deepEqual(parseItem(typed), { name, qty }, typed);
});

test('grocery aisles are guessed from the name', () => {
	const cases = {
		Bananas: 'produce',
		'whole milk': 'dairy',
		'peanut butter': 'pantry',
		'Ice cream': 'frozen',
		'sourdough bread': 'bakery',
		'Paper towels': 'household',
		toothpaste: 'personal',
		thing: 'other'
	};
	for (const [name, aisle] of Object.entries(cases)) assert.equal(guessAisle(name), aisle, name);
});

test('on the days the clocks change, times stay what you typed', () => {
	const hm = (x) => `${x.getHours()}:${String(x.getMinutes()).padStart(2, '0')}`;
	// Nov 1, 2026: 1 AM happens twice; Mar 8, 2026: 2 AM is skipped
	assert.equal(hm(atMinute(d('2026-11-01T00:00'), 5 * 60)), '5:00');
	assert.equal(hm(atMinute(d('2026-11-01T00:00'), 23 * 60 + 30)), '23:30');
	assert.equal(hm(atMinute(d('2026-03-08T00:00'), 9 * 60)), '9:00');
	assert.equal(
		ymd(atMinute(d('2026-11-01T00:00'), 24 * 60)),
		'2026-11-02',
		'midnight at the end of the day'
	);
	// dragging an event from 12:30 AM to 3:00 AM that night
	const ev = { id: 'x', start: d('2026-11-01T00:30'), end: d('2026-11-01T01:30') };
	const { dayDelta, minDelta } = deltaBetween(ev.start, d('2026-11-01T03:00'));
	const moved = shiftEvent(ev, dayDelta, minDelta);
	assert.deepEqual([hm(moved.start), hm(moved.end)], ['3:00', '4:00']);
	// a weekly 5 AM event keeps 5 AM on the Sunday the clocks go back
	const weekly = {
		id: 'w',
		start: d('2026-10-25T05:00'),
		end: d('2026-10-25T06:00'),
		repeat: { freq: 'weekly', byWeekday: [0], count: 3 }
	};
	assert.deepEqual(
		expandEvents([weekly], d('2026-10-01'), d('2026-12-01')).map((o) => hm(o.start)),
		['5:00', '5:00', '5:00']
	);
});

test('the week view puts blocks at the time they show on the days the clocks change', () => {
	const day = d('2026-11-01T00:00');
	const ev = { id: 'x', start: d('2026-11-01T05:00'), end: d('2026-11-01T06:00') };
	const [seg] = layoutTimedDay(expandEvents([ev], day, d('2026-11-02T00:00')), day);
	assert.deepEqual([seg.sMin, seg.eMin], [300, 360], '5–6 AM, not 6–7');
	const late = { id: 'y', start: d('2026-11-01T23:00'), end: d('2026-11-02T01:00') };
	const [cut] = layoutTimedDay(expandEvents([late], day, d('2026-11-02T00:00')), day);
	assert.deepEqual([cut.sMin, cut.eMin], [1380, 1440], 'runs to the bottom of the day');
	const spring = d('2026-03-08T00:00');
	const nine = { id: 'z', start: d('2026-03-08T09:00'), end: d('2026-03-08T10:30') };
	const [s2] = layoutTimedDay(expandEvents([nine], spring, d('2026-03-09T00:00')), spring);
	assert.deepEqual([s2.sMin, s2.eMin], [540, 630]);
});
