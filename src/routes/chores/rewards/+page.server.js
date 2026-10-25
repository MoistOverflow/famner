import { addReward, removeReward, redeemReward, handleRedemption } from '$lib/server/chores.js';
import { db, attempt, actor } from '$lib/server/choreActions.js';

export const actions = {
  add: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('add', () => { addReward(db(), actor(locals), { name: form.get('name'), cost: form.get('cost') }); });
  },
  remove: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('remove', () => { removeReward(db(), actor(locals), form.get('id')); });
  },
  redeem: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('redeem', () => {
      const who = actor(locals, true);
      redeemReward(db(), who, form.get('id'));
      return { name: form.get('name'), who: who.viaKiosk ? locals.acting.name : null };
    });
  },
  cancel: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('cancel', () => { handleRedemption(db(), actor(locals, true), form.get('id'), 'refund'); });
  }
};
