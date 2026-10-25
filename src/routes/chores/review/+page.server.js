// Only for admins and parents (and the kiosk, with a parent's PIN): finalize children's finished chores and hand out rewards.
import { redirect } from '@sveltejs/kit';
import { reviewChore, reviseReview, handleRedemption, isAdult, ChoreForbidden } from '$lib/server/chores.js';
import { db, attempt, actor } from '$lib/server/choreActions.js';

export function load({ locals }) {
  if (!isAdult(locals.user) && locals.user?.role !== 'kiosk') redirect(303, '/chores'); // the kiosk asks for a parent's PIN
}

/** Who reviews: on the kiosk, only a parent or admin it's unlocked as. */
function reviewer(locals) {
  const who = actor(locals, true);
  if (locals.user.role === 'kiosk' && !isAdult(who)) throw new ChoreForbidden('This needs a parent’s PIN.');
  return who;
}

export const actions = {
  review: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('review', () => {
      reviewChore(db(), reviewer(locals), form.get('id'), { decision: form.get('decision'), points: form.get('points'), reason: form.get('reason') });
      return { id: form.get('id'), decision: form.get('decision') };
    });
  },
  revise: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('revise', () => {
      const { delta } = reviseReview(db(), reviewer(locals), form.get('id'), { points: form.get('points'), reason: form.get('reason') });
      return { id: form.get('id'), delta };
    });
  },
  given: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('given', () => { handleRedemption(db(), reviewer(locals), form.get('id'), 'given'); });
  },
  refund: async ({ request, locals }) => {
    const form = await request.formData();
    return attempt('refund', () => { handleRedemption(db(), reviewer(locals), form.get('id'), 'refund'); });
  }
};
