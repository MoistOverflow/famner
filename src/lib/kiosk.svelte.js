// src/lib/kiosk.svelte.js — the kiosk (shared tablet) in the browser: who it's unlocked as, the PIN
// pad, and helpers that ask for the right person's PIN before a change.
//
//   kiosk.on            this device is signed in as a kiosk account
//   kiosk.acting        { id, name, role, until } while unlocked, else null
//   unlockFor(need)     → Promise<boolean>: already unlocked as someone who fits, or asks for a PIN
//   pinGuard(getNeed)   for use:enhance on forms: asks first, then submits
//
// `need` says who may do it: { people: [ids], parents: true, title }. `parents` lets any admin or
// parent's PIN do it too. An empty `people` with no `parents` means anyone.

const ADULT = new Set(['admin', 'parent']);

export const kiosk = $state({
  on: false,
  acting: null,
  people: [],     // everyone who can unlock it: { id, name, role }
  ask: null       // the open PIN pad: { title, choices, resolve }
});

let lockTimer = 0;
let lastTouch = 0;
let syncedFor = undefined; // the signed-in account the unlock state was last taken from

/**
 * Called by the layout with the page data. Who it's unlocked as is only taken from the page data
 * when the page first loads (or the account changes): after that this device knows better, since
 * the page data still says what it was at load time.
 */
export function syncKiosk(user, acting, people) {
  kiosk.on = user?.role === 'kiosk';
  kiosk.people = (people ?? []).filter((p) => p.role !== 'kiosk');
  const id = user?.id ?? null;
  if (id !== syncedFor) {
    syncedFor = id;
    setActing(kiosk.on ? acting : null);
  }
}

function setActing(a) {
  clearTimeout(lockTimer);
  const next = a && a.until > Date.now() ? a : null;
  kiosk.acting = next;
  if (next) lockTimer = setTimeout(() => (kiosk.acting = null), next.until - Date.now());
}

export const fits = (need, a = kiosk.acting) =>
  !!a && (!need?.people?.length && !need?.parents ? true : need.people?.includes(a.id) || (need.parents && ADULT.has(a.role)));

/** Who the PIN pad offers for `need`. */
export function choicesFor(need) {
  const anyone = !need?.people?.length && !need?.parents;
  return kiosk.people.filter((p) => anyone || need.people?.includes(p.id) || (need.parents && ADULT.has(p.role)));
}

/** Resolve true when the kiosk is (or becomes) unlocked as someone who fits `need`. */
export function unlockFor(need = {}) {
  if (!kiosk.on) return Promise.resolve(true);
  if (fits(need)) return Promise.resolve(true);
  const choices = choicesFor(need);
  return new Promise((resolve) => {
    kiosk.ask?.resolve(false);
    kiosk.ask = { title: need.title ?? 'Who’s this?', choices, resolve };
  });
}

/** The PIN pad calls this with the chosen person and PIN. Returns an error message or null. */
export async function submitPin(userId, pin) {
  let r, body;
  try {
    r = await fetch('/api/kiosk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unlock', userId, pin }) });
    body = await r.json();
  } catch {
    return 'Can’t reach the server. Try again.';
  }
  if (!r.ok) return body?.error ?? 'That didn’t work.';
  setActing(body.acting);
  const ask = kiosk.ask;
  kiosk.ask = null;
  ask?.resolve(true);
  return null;
}

export function cancelPin() {
  const ask = kiosk.ask;
  kiosk.ask = null;
  ask?.resolve(false);
}

export async function lockNow() {
  setActing(null);
  try { await fetch('/api/kiosk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'lock' }) }); } catch {}
}

/** Someone is using the kiosk: keep it unlocked (checked at most every 20 seconds). */
export async function touchKiosk() {
  if (!kiosk.acting || Date.now() - lastTouch < 20000) return;
  lastTouch = Date.now();
  try {
    const r = await fetch('/api/kiosk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'touch' }) });
    const { until } = await r.json();
    if (until && kiosk.acting) setActing({ ...kiosk.acting, until });
    else setActing(null);
  } catch {}
}

/**
 * For `use:enhance={pinGuard(() => need)}`: on the kiosk, ask for a fitting PIN first, then send
 * the form. Elsewhere it does nothing.
 */
export function pinGuard(getNeed) {
  return ({ cancel, formElement, submitter }) => {
    if (!kiosk.on) return;
    const need = getNeed();
    const resend = () => unlockFor(need).then((ok) => { if (ok) formElement.requestSubmit(submitter ?? undefined); });
    if (!fits(need)) { cancel(); resend(); return; }
    return async ({ result, update }) => {
      // the server says the tablet locked itself meanwhile: ask again, then send it again
      if (result.type === 'failure' && result.data?.needPin) { setActing(null); resend(); return; }
      await update();
    };
  };
}
