import { fail } from '@sveltejs/kit';
import { createChore, updateChore, deleteChore, completeChore, unsubmitChore, skipChore } from '$lib/server/chores.js';
import { db, attempt, actor, choreFields } from '$lib/server/choreActions.js';

export const actions = {
  create: async ({ request, locals }) => {
    const form = await request.formData();
    const values = choreFields(form);
    const r = attempt('create', () => { createChore(db(), actor(locals), values); });
    return r?.status ? fail(r.status, { ...r.data, values }) : r; // keep what was typed
  },
  update: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('update', () => { updateChore(db(), actor(locals), form.get('id'), choreFields(form)); return { id: form.get('id') }; });
  },
  delete: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('delete', () => { deleteChore(db(), actor(locals), form.get('id')); });
  },
  complete: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('complete', () => ({
      id: form.get('id'),
      ...completeChore(db(), actor(locals, true), form.get('id'), { ownOnly: locals.user.role === 'kiosk' })
    }));
  },
  skip: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('skip', () => { skipChore(db(), actor(locals), form.get('id'), form.get('reason')); return { id: form.get('id') }; });
  },
  unsubmit: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('unsubmit', () => { unsubmitChore(db(), actor(locals, true), form.get('id')); });
  }
};
