// Makes the signed-in user available to every page as `page.data.user` (null when signed out),
// plus everyone's names as `page.data.people` (to show who added an event or item), and on a kiosk
// who it's unlocked as (`page.data.acting`).
import { peopleNames } from '$lib/server/auth.js';
import { appDb } from '$lib/server/requestInfo.js';

export function load({ locals }) {
  const a = locals.acting;
  return {
    user: locals.user,
    people: locals.user ? peopleNames(appDb()) : [],
    acting: a ? { id: a.id, name: a.name, role: a.role, until: a.until } : null
  };
}
