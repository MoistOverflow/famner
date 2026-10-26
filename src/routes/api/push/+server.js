// src/routes/api/push/+server.js — this device's push subscription (see $lib/server/push.js).
//   GET    ?endpoint=…              → { publicKey, subscribed, groceries }
//   POST   { subscription, groceries? } → save it for the signed-in person
//   PATCH  { endpoint, groceries }  → grocery alerts on or off for this device
//   DELETE { endpoint }             → this device stops getting notifications
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { pushDb, vapidKeys, saveSubscription, removeSubscription, setGroceryAlerts, subscriptionOf, PushError } from '$lib/server/push.js';

const db = () => pushDb(env.CALENDAR_DB || 'data/calendar.db');
const text = (body, status) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const body = async (request) => {
  try { return await request.json(); } catch { return null; }
};

export function GET({ url, locals }) {
  const d = db();
  const sub = subscriptionOf(d, locals.user, url.searchParams.get('endpoint'));
  return json({ publicKey: vapidKeys(d).publicKey, subscribed: !!sub, groceries: sub?.groceries ?? true }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST({ request, locals }) {
  const b = await body(request);
  try {
    return json(saveSubscription(db(), locals.user, b?.subscription, { userAgent: request.headers.get('user-agent') ?? '', groceries: b?.groceries, sessionId: locals.sessionId }));
  } catch (err) {
    if (err instanceof PushError) return text(err.message, 400);
    throw err;
  }
}

export async function PATCH({ request, locals }) {
  const b = await body(request);
  if (!setGroceryAlerts(db(), locals.user, b?.endpoint, !!b?.groceries)) return text('This device isn’t subscribed.', 404);
  return json({ ok: true });
}

export async function DELETE({ request, locals }) {
  const b = await body(request);
  removeSubscription(db(), locals.user, b?.endpoint);
  return json({ ok: true });
}
