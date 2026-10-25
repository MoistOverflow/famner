import { fail, redirect } from '@sveltejs/kit';
import { renameSelf, changeOwnPassword, revokeUserSessions, setPin, AuthError } from '$lib/server/auth.js';
import { appDb } from '$lib/server/requestInfo.js';

export function load({ locals }) {
  const db = appDb();
  const others = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND id != ? AND expires_at > ?')
    .get(locals.user.id, locals.sessionId, Date.now()).n;
  return { otherSessions: others };
}

export const actions = {
  rename: async ({ request, locals }) => {
    const name = String((await request.formData()).get('name') ?? '');
    try {
      renameSelf(appDb(), locals.user.id, name);
    } catch (err) {
      if (err instanceof AuthError) return fail(400, { action: 'rename', error: err.message });
      throw err;
    }
    return { action: 'rename', message: 'Name saved.' };
  },

  password: async ({ request, locals }) => {
    const form = await request.formData();
    const next = String(form.get('next') ?? '');
    if (next !== String(form.get('confirm') ?? '')) return fail(400, { action: 'password', error: 'The two new passwords don’t match.' });
    try {
      await changeOwnPassword(appDb(), locals.user.id, String(form.get('current') ?? ''), next, locals.sessionId);
    } catch (err) {
      if (err instanceof AuthError) return fail(400, { action: 'password', error: err.message });
      throw err;
    }
    if (locals.user.mustChangePassword) redirect(303, '/');
    return { action: 'password', message: 'Password changed. Your other devices have been signed out.' };
  },

  pin: async ({ request, locals }) => {
    const form = await request.formData();
    const pin = String(form.get('pin') ?? '');
    if (pin !== String(form.get('confirm') ?? '')) return fail(400, { action: 'pin', error: 'The two PINs don’t match.' });
    try {
      await setPin(appDb(), locals.user.id, pin, String(form.get('current') ?? ''));
    } catch (err) {
      if (err instanceof AuthError) return fail(400, { action: 'pin', error: err.message });
      throw err;
    }
    return { action: 'pin', message: 'PIN changed.' };
  },

  signOutOthers: async ({ locals }) => {
    revokeUserSessions(appDb(), locals.user.id, locals.sessionId);
    return { action: 'signOutOthers', message: 'Signed out of your other devices.' };
  }
};
