// src/routes/logout/+server.js — sign out this device (POST from the menu's "Sign out").
import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { authDb, endSession, SESSION_COOKIE } from '$lib/server/auth.js';

export function POST({ cookies }) {
  endSession(authDb(env.CALENDAR_DB || 'data/calendar.db'), cookies.get(SESSION_COOKIE));
  cookies.delete(SESSION_COOKIE, { path: '/' });
  redirect(303, '/login');
}
