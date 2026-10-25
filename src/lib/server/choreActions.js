// small helpers shared by the chores pages' form actions (server only)
import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { ChoreError, ChoreForbidden, choresDb } from './chores.js';
import { actingUser, KioskLocked } from './auth.js';

export const db = () => choresDb(env.CALENDAR_DB || 'data/calendar.db');

/**
 * Who an action is done as. On the kiosk: the person it's unlocked as, and only for the actions the
 * kiosk allows (`kioskOk`); others are refused there. Everyone else: themselves.
 */
export function actor(locals, kioskOk = false) {
  if (locals.user?.role === 'kiosk' && !kioskOk) throw new ChoreForbidden('That can’t be done on the kiosk. Use your own device.');
  return actingUser(locals);
}

/** Run a chores operation; turn its problems into a message on the page. */
export function attempt(action, fn) {
  try {
    const result = fn();
    return { action, ok: true, ...(result && typeof result === 'object' ? result : {}) };
  } catch (err) {
    if (err instanceof KioskLocked) return fail(401, { action, error: err.message, needPin: true });
    if (err instanceof ChoreForbidden) return fail(403, { action, error: err.message });
    if (err instanceof ChoreError) return fail(400, { action, error: err.message });
    throw err;
  }
}

/** The fields of a submitted chore form. */
export function choreFields(form) {
  return {
    title: form.get('title'),
    notes: form.get('notes'),
    assignee: form.get('assignee'),
    points: form.get('points'),
    due: form.get('due'),
    tz: form.get('tz'),
    repeat: form.get('repeat'),
    days: form.getAll('days'),
    interval: form.get('interval'),
    unit: form.get('unit'),
    monthBy: form.get('monthBy'),
    from: form.get('from'),
    ends: form.get('ends'),
    until: form.get('until'),
    count: form.get('count')
  };
}
