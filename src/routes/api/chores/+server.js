// src/routes/api/chores/+server.js — chores data as JSON (for the calendar and the Today view).
//   GET                    → what the chores pages show this user (children: only their own)
//   GET ?view=household     → everyone's chores due soon, for the Today view
//   GET ?view=summary       → what needs this person's attention (badges and reminders)
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { choresDb, getState, householdChores, choresRev, attentionSummary } from '$lib/server/chores.js';

export function GET({ url, locals }) {
  const db = choresDb(env.CALENDAR_DB || 'data/calendar.db');
  const headers = { 'Cache-Control': 'no-store' };
  if (url.searchParams.get('view') === 'summary') return json(attentionSummary(db, locals.user), { headers });
  if (url.searchParams.get('view') === 'household') return json({ rev: choresRev(db), chores: householdChores(db) }, { headers });
  return json(getState(db, locals.user), { headers });
}
