// src/routes/api/push/test/+server.js — send a test notification to this device.
//   POST { endpoint, delay? } → { sent } (with a delay of up to 30 s it answers at once and sends later,
//   so you can close the app first and see it arrive the way a real one would)
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { pushDb, sendTo, subscriptionOf } from '$lib/server/push.js';

export async function POST({ request, locals }) {
  const db = pushDb(env.CALENDAR_DB || 'data/calendar.db');
  let b = null;
  try { b = await request.json(); } catch { /* empty */ }
  const endpoint = String(b?.endpoint ?? '');
  if (!subscriptionOf(db, locals.user, endpoint)) return json({ sent: false, error: 'This device isn’t subscribed to notifications.' }, { status: 404 });
  const message = { title: 'Famner test notification', body: 'Notifications work on this device, even when Famner is closed.', url: '/account', tag: 'test', ttl: 300, urgency: 'high' };
  const delay = Math.min(30, Math.max(0, Number(b?.delay) || 0));
  if (delay) {
    setTimeout(() => sendTo(db, { endpoint }, message).catch(() => {}), delay * 1000).unref?.();
    return json({ sent: true, later: delay });
  }
  return json({ sent: (await sendTo(db, { endpoint }, message)) > 0 });
}
