// src/routes/api/kiosk/+server.js — unlock the kiosk as a person with their PIN, or lock it again.
//   POST { action: 'unlock', userId, pin } → { acting: { id, name, role, until } } or 400 { error }
//   POST { action: 'lock' }                → { acting: null }
//   POST { action: 'touch' }               → { until } (still being used: stay unlocked a bit longer)
import { json } from '@sveltejs/kit';
import { unlockKiosk, lockKiosk, touchKiosk } from '$lib/server/auth.js';
import { appDb } from '$lib/server/requestInfo.js';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST({ request, locals }) {
  if (locals.user?.role !== 'kiosk') return json({ error: 'Only a kiosk account uses this.' }, { status: 403, headers: noStore });
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Send JSON.' }, { status: 400, headers: noStore }); }
  const db = appDb();
  if (body?.action === 'lock') { lockKiosk(db, locals.sessionId); return json({ acting: null }, { headers: noStore }); }
  if (body?.action === 'touch') return json({ until: touchKiosk(db, locals.sessionId) }, { headers: noStore });
  if (body?.action !== 'unlock') return json({ error: 'Unknown action.' }, { status: 400, headers: noStore });
  const r = await unlockKiosk(db, locals.sessionId, locals.user, body.userId, body.pin);
  if (r.error) return json({ error: r.error, left: r.left }, { status: 400, headers: noStore });
  const a = r.acting;
  return json({ acting: { id: a.id, name: a.name, role: a.role, until: a.until } }, { headers: noStore });
}
