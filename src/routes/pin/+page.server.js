// Choosing a PIN: required once for everyone except kiosk accounts (see hooks.server.js). The PIN
// unlocks the kiosk (the shared tablet) as this person.
import { fail, redirect } from '@sveltejs/kit';
import { setPin, safeNext, AuthError } from '$lib/server/auth.js';
import { appDb } from '$lib/server/requestInfo.js';

export function load({ locals, url }) {
  if (!locals.user.needsPin) redirect(303, safeNext(url.searchParams.get('next')));
}

export const actions = {
  default: async ({ request, locals, url }) => {
    const form = await request.formData();
    const pin = String(form.get('pin') ?? '');
    if (pin !== String(form.get('confirm') ?? '')) return fail(400, { error: 'The two PINs don’t match.' });
    try {
      await setPin(appDb(), locals.user.id, pin);
    } catch (err) {
      if (err instanceof AuthError) return fail(400, { error: err.message });
      throw err;
    }
    redirect(303, safeNext(url.searchParams.get('next')));
  }
};
