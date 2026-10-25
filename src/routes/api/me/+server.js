// src/routes/api/me/+server.js — who's signed in (the pages use it to notice a session has ended).
import { json } from '@sveltejs/kit';

export function GET({ locals }) {
  return json(locals.user, { headers: { 'Cache-Control': 'no-store' } });
}
