import { fail, redirect } from '@sveltejs/kit';
import { authenticate, createSession, sessionCookieOptions, safeNext, userCount, SESSION_COOKIE } from '$lib/server/auth.js';
import { appDb, clientAddress } from '$lib/server/requestInfo.js';

export function load() {
  if (userCount(appDb()) === 0) redirect(303, '/setup');
}

export const actions = {
  default: async ({ request, cookies, url, getClientAddress }) => {
    const form = await request.formData();
    const username = String(form.get('username') ?? '').trim();
    const db = appDb();
    const result = await authenticate(db, username, String(form.get('password') ?? ''), clientAddress(getClientAddress));
    if (result.error) return fail(400, { username, error: result.error });

    const session = createSession(db, result.user.id, request.headers.get('user-agent') ?? '');
    cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(url, session.expiresAt));
    redirect(303, result.user.mustChangePassword ? '/account' : safeNext(url.searchParams.get('next')));
  }
};
