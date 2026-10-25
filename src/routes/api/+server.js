// src/routes/api/lists/[name]/+server.js — load and save a synced list (e.g. /api/lists/groceries).
//   GET  → { rev, items }
//   POST → { upsert: [items], delete: [ids] }   (header X-List-Client identifies the sending page)
// Same note as the calendar API: there's no login, so keep the app on your own network or add auth.

import { env } from '$env/dynamic/private';
import { LIST_NAMES, openLists, loadList, applyListChanges, ListValidationError } from '$lib/server/collections.js';

const reply = (body, status = 200, type = 'application/json') =>
  new Response(body, { status, headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' } });

const db = () => openLists(env.CALENDAR_DB || 'data/calendar.db');

export function GET({ params }) {
  if (!LIST_NAMES.has(params.name)) return reply('No such list.', 404, 'text/plain');
  return reply(loadList(db(), params.name));
}

export async function POST({ params, request }) {
  if (!LIST_NAMES.has(params.name)) return reply('No such list.', 404, 'text/plain');
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return reply('Send the changes as JSON.', 415, 'text/plain');
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return reply('That wasn’t valid JSON.', 400, 'text/plain');
  }
  try {
    const origin = (request.headers.get('x-list-client') ?? '').slice(0, 100) || null;
    return reply(JSON.stringify({ ok: true, ...applyListChanges(db(), params.name, body, origin) }));
  } catch (err) {
    if (err instanceof ListValidationError) return reply(err.message, 400, 'text/plain');
    console.error(`Saving list "${params.name}" failed:`, err);
    return reply('The server couldn’t save the changes.', 500, 'text/plain');
  }
}
