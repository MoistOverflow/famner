// Admin panel: add people, change roles, reset passwords, turn accounts off, remove them;
// and the activity log (?tab=activity, filtered by ?who= and ?area=, paged with ?before=).
// (hooks.server.js already keeps non-admins out; every action checks again.)
import { fail, redirect } from '@sveltejs/kit';
import { listUsers, createUser, updateUser, resetPassword, resetPin, setDisabled, deleteUser, AuthError } from '$lib/server/auth.js';
import { listActivity } from '$lib/server/activity.js';
import { choresDb, pointsSummary, adjustPoints, ChoreError } from '$lib/server/chores.js';
import { env } from '$env/dynamic/private';
import { listBackups, makeBackup, backupDir } from '$lib/server/backups.js';
import { appDb } from '$lib/server/requestInfo.js';
import { factoryReset } from '$lib/server/reset.js';
import { SESSION_COOKIE } from '$lib/server/auth.js';

const AREAS = new Set(['calendar', 'groceries', 'chores', 'accounts']);

export function load({ url }) {
  const db = appDb();
  const tabParam = url.searchParams.get('tab');
  const tab = tabParam === 'activity' || tabParam === 'backups' ? tabParam : 'people';
  const users = listUsers(db);
  if (tab === 'backups') {
    const path = env.CALENDAR_DB || 'data/calendar.db';
    return { tab, users, backups: listBackups(path), backupDir: backupDir(path) };
  }
  if (tab !== 'activity') return { tab, users, points: pointsSummary(choresDb(env.CALENDAR_DB || 'data/calendar.db')) };
  const who = url.searchParams.get('who') || null;
  const area = AREAS.has(url.searchParams.get('area')) ? url.searchParams.get('area') : null;
  const before = Number(url.searchParams.get('before')) || null;
  return { tab, users, filters: { who, area }, before, activity: listActivity(db, { userId: who, area, before }) };
}

/** Run an admin action, turning permission/validation problems into a message on the page. */
async function attempt(action, fn) {
  try {
    return { action, ...(await fn()) };
  } catch (err) {
    if (err instanceof AuthError || err instanceof ChoreError) return fail(400, { action, error: err.message });
    throw err;
  }
}

const field = (form, key) => String(form.get(key) ?? '');

export const actions = {
  create: async ({ request, locals }) => {
    const form = await request.formData();
    const values = { username: field(form, 'username'), name: field(form, 'name'), role: field(form, 'role') };
    const result = await attempt('create', async () => {
      const { user, tempPassword } = await createUser(appDb(), locals.user, values);
      return { message: `Added ${user.name}.`, tempPassword, forUser: user.username };
    });
    return result?.status ? fail(400, { ...result.data, values }) : result;
  },

  update: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('update', () => {
      const u = updateUser(appDb(), locals.user, field(form, 'id'), { name: field(form, 'name'), role: form.get('role') ?? undefined });
      return { message: `Saved ${u.name}.`, id: u.id };
    });
  },

  reset: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('reset', async () => {
      const tempPassword = await resetPassword(appDb(), locals.user, field(form, 'id'));
      return { message: `New temporary password for ${field(form, 'username')}.`, tempPassword, forUser: field(form, 'username') };
    });
  },

  resetPin: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('resetPin', () => {
      resetPin(appDb(), locals.user, field(form, 'id'));
      return { message: `Cleared ${field(form, 'username')}’s PIN. They’ll choose a new one next time.` };
    });
  },

  disable: async ({ request, locals }) => {
    const form = await request.formData();
    const off = field(form, 'disabled') === '1';
    return attempt('disable', () => {
      setDisabled(appDb(), locals.user, field(form, 'id'), off);
      return { message: off ? `Turned off ${field(form, 'username')}’s account and signed them out.` : `Turned ${field(form, 'username')}’s account back on.` };
    });
  },

  points: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('points', () => {
      const sign = field(form, 'direction') === 'remove' ? -1 : 1;
      const amount = Number(field(form, 'amount'));
      const { balance } = adjustPoints(choresDb(env.CALENDAR_DB || 'data/calendar.db'), locals.user, field(form, 'id'),
        Number.isFinite(amount) ? sign * amount : NaN, field(form, 'reason'));
      return { message: `${field(form, 'name')} now has ${balance} point${balance === 1 ? '' : 's'}.`, id: field(form, 'id') };
    });
  },

  backup: async ({ locals }) => {
    if (locals.user?.role !== 'admin') return fail(403, { action: 'backup', error: 'Only admins can do that.' });
    try {
      const b = makeBackup(appDb(), env.CALENDAR_DB || 'data/calendar.db', 'manual');
      return { action: 'backup', message: `Backed up (${Math.max(1, Math.round(b.size / 1024))} KB).` };
    } catch (err) {
      console.error('Backup failed:', err);
      return fail(500, { action: 'backup', error: `The backup didn’t work: ${err.message}` });
    }
  },

  factoryReset: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    try {
      await factoryReset(appDb(), env.CALENDAR_DB || 'data/calendar.db', locals.user, { password: form.get('password'), confirm: form.get('confirm') });
    } catch (err) {
      if (err instanceof AuthError) return fail(400, { action: 'factoryReset', error: err.message });
      console.error('Factory reset failed:', err);
      return fail(500, { action: 'factoryReset', error: `The reset didn’t work, and nothing was deleted: ${err.message}` });
    }
    cookies.delete(SESSION_COOKIE, { path: '/' });
    redirect(303, '/setup');
  },

  delete: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('delete', () => {
      const { username, removedCalendars } = deleteUser(appDb(), locals.user, field(form, 'id'));
      return {
        message: `Removed ${username}${removedCalendars ? ` and ${removedCalendars} private calendar${removedCalendars === 1 ? '' : 's'}` : ''}.`
      };
    });
  }
};
