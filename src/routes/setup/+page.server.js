// First-time setup: creates the first admin. Only available while there are no accounts at all.
import { fail, redirect } from '@sveltejs/kit';
import { createFirstAdmin, createSession, sessionCookieOptions, userCount, AuthError, SESSION_COOKIE } from '$lib/server/auth.js';
import { appDb } from '$lib/server/requestInfo.js';

export function load() {
  if (userCount(appDb()) > 0) redirect(303, '/login');
}

export const actions = {
  default: async ({ request, cookies, url }) => {
    const form = await request.formData();
    const values = { username: String(form.get('username') ?? ''), name: String(form.get('name') ?? '') };
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('confirm') ?? '')) return fail(400, { ...values, error: 'The two passwords don’t match.' });
    const db = appDb();
    let user;
    try {
      user = await createFirstAdmin(db, { ...values, password });
    } catch (err) {
      if (err instanceof AuthError) return fail(400, { ...values, error: err.message });
      throw err;
    }
    const session = createSession(db, user.id, request.headers.get('user-agent') ?? '');
    cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(url, session.expiresAt));
    redirect(303, '/');
  }
};
