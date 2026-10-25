// Data for all the chores pages. Reloaded after every change (form actions) and when another
// device changes something (the layout listens to /api/chores/live and calls invalidate).
import { getState } from '$lib/server/chores.js';
import { db } from '$lib/server/choreActions.js';

export function load({ locals, depends }) {
  depends('app:chores');
  return { chores: getState(db(), locals.user) };
}
