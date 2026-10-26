// src/routes/api/me/+server.js — who's signed in (the pages use it to notice a session has ended).
//   GET          → the signed-in user
//   POST {theme} → save their theme ('light' | 'dark' | 'oled'), for every device they use
import { json } from '@sveltejs/kit';
import { setOwnTheme, AuthError } from '$lib/server/auth.js';
import { appDb } from '$lib/server/requestInfo.js';

export function GET({ locals }) {
  return json(locals.user, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST({ request, locals }) {
  let body = null;
  try { body = await request.json(); } catch { /* checked below */ }
  try {
    setOwnTheme(appDb(), locals.user.id, body?.theme);
  } catch (err) {
    if (err instanceof AuthError) return new Response(err.message, { status: 400 });
    throw err;
  }
  return json({ ok: true, theme: body.theme });
}
