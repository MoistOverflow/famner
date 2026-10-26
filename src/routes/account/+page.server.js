import { fail, redirect } from '@sveltejs/kit';
import { renameSelf, changeOwnPassword, revokeUserSessions, setPin, AuthError } from '$lib/server/auth.js';
import { appDb } from '$lib/server/requestInfo.js';
import { env } from '$env/dynamic/private';
import {
  icloudDb, accountStatus, remoteCalendars, connectAccount, disconnectAccount, linkCalendar, unlinkCalendar, syncCalendar, ICloudError
} from '$lib/server/icloud.js';
import { CalDavError } from '$lib/server/caldav.js';

const dbPath = () => env.CALENDAR_DB || 'data/calendar.db';
const icloudFail = (err) => {
  if (err instanceof ICloudError || err instanceof CalDavError) return fail(400, { action: 'icloud', error: err.message });
  throw err;
};

export function load({ locals }) {
  const db = appDb();
  const others = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND id != ? AND expires_at > ?')
    .get(locals.user.id, locals.sessionId, Date.now()).n;
  // iCloud: the calendars there come from Apple, so they arrive a moment after the page (streamed)
  let icloud = null, icloudRemote = null;
  if (locals.user.role !== 'kiosk' && !locals.user.mustChangePassword) {
    const idb = icloudDb(dbPath());
    icloud = accountStatus(idb, locals.user);
    if (icloud.connected && icloud.status === 'ok') {
      icloudRemote = remoteCalendars(idb, dbPath(), locals.user).catch((err) => ({ error: err?.message ?? 'Couldn’t reach iCloud.' }));
    }
  }
  return { otherSessions: others, icloud, icloudRemote };
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

  icloudConnect: async ({ request, locals }) => {
    const form = await request.formData();
    try {
      await connectAccount(icloudDb(dbPath()), dbPath(), locals.user, { appleId: form.get('appleId'), password: form.get('password') });
    } catch (err) {
      return icloudFail(err);
    }
    return { action: 'icloud', message: 'Connected to iCloud. Now pick a calendar to sync.' };
  },

  icloudDisconnect: async ({ locals }) => {
    disconnectAccount(icloudDb(dbPath()), locals.user);
    return { action: 'icloud', message: 'Disconnected. Events already synced stay in Famner and in iCloud.' };
  },

  icloudLink: async ({ request, locals }) => {
    const form = await request.formData();
    const remote = String(form.get('remote') ?? '');
    const calendar = String(form.get('calendar') ?? '');
    let out;
    try {
      out = await linkCalendar(icloudDb(dbPath()), dbPath(), locals.user, {
        remoteUrl: remote && remote !== 'new' ? remote : null,
        calendarId: calendar && calendar !== 'new' ? calendar : null,
        onlyMe: form.get('onlyMe') === 'on'
      });
    } catch (err) {
      return icloudFail(err);
    }
    if (out.syncError) return { action: 'icloud', message: `Syncing is set up, but the first sync didn’t work: ${out.syncError} It will try again in a few minutes.` };
    const r = out.result;
    return { action: 'icloud', message: `Syncing. ${r.pulled ? `${r.pulled} event${r.pulled === 1 ? '' : 's'} came from iCloud` : 'Nothing came from iCloud'}${r.pushed ? `, ${r.pushed} went to iCloud` : ''}.` };
  },

  icloudUnlink: async ({ request, locals }) => {
    const id = String((await request.formData()).get('calendar') ?? '');
    try {
      unlinkCalendar(icloudDb(dbPath()), locals.user, id);
    } catch (err) {
      return icloudFail(err);
    }
    return { action: 'icloud', message: 'Stopped syncing. The events stay in both places.' };
  },

  icloudSync: async ({ request, locals }) => {
    const id = String((await request.formData()).get('calendar') ?? '');
    const db = icloudDb(dbPath());
    if (!accountStatus(db, locals.user).links.some((l) => l.calendarId === id)) return fail(404, { action: 'icloud', error: 'That calendar isn’t synced.' });
    try {
      await syncCalendar(db, dbPath(), id);
    } catch (err) {
      return icloudFail(err);
    }
    return { action: 'icloud', message: 'Synced.' };
  },

  signOutOthers: async ({ locals }) => {
    revokeUserSessions(appDb(), locals.user.id, locals.sessionId);
    return { action: 'signOutOthers', message: 'Signed out of your other devices.' };
  }
};
