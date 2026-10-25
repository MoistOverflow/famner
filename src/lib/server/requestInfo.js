// small helpers shared by the account pages (server only)
import { env } from '$env/dynamic/private';
import { authDb } from './auth.js';

export const appDb = () => authDb(env.CALENDAR_DB || 'data/calendar.db');

/** The visitor's network address, if the server can tell (used to slow down password guessing). */
export function clientAddress(getClientAddress) {
  try { return getClientAddress(); } catch { return ''; }
}
