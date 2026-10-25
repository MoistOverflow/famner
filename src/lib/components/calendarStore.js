// src/lib/components/calendarStore.js — connects <Calendar> to the /api/calendar routes.
//
//   import { createServerStore } from '$lib/components/calendarStore.js';
//   <Calendar store={createServerStore()} … />

import { serialize, deserialize } from './calendarUtils.js';

/** An Error carrying the HTTP status (401 = signed out, 400/403 = refused). */
async function problem(res) {
  const err = new Error((await res.text().catch(() => '')).trim() || `The server answered ${res.status}.`);
  err.status = res.status;
  return err;
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * @param {string} base     URL of the API route (the live stream is at `${base}/live`)
 * @param {object} options  batchSize: max events per request (keeps big imports under body-size limits)
 */
export function createServerStore(base = '/api/calendar', { batchSize = 250 } = {}) {
  // identifies this open page, so it can tell its own changes apart on the live stream
  const clientId = randomId();

  async function send(changes) {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Calendar-Client': clientId },
      body: serialize(changes)
    });
    if (!res.ok) throw await problem(res);
  }

  return {
    clientId,

    /** → { rev, calendars, events } (dates revived), or throws if the server can't be reached. */
    async load() {
      const res = await fetch(base, { cache: 'no-store' });
      if (!res.ok) throw await problem(res);
      return deserialize(await res.text());
    },

    /** Save a change set. Large sets go in several requests: calendars first, calendar deletions last. */
    async save({ upsertCalendars = [], deleteCalendars = [], upsertEvents = [], deleteEvents = [] }) {
      const total = upsertCalendars.length + deleteCalendars.length + upsertEvents.length + deleteEvents.length;
      if (!total) return;
      if (upsertEvents.length + deleteEvents.length <= batchSize) {
        return send({ upsertCalendars, deleteCalendars, upsertEvents, deleteEvents });
      }
      if (upsertCalendars.length) await send({ upsertCalendars });
      for (let i = 0; i < upsertEvents.length; i += batchSize) {
        await send({ upsertEvents: upsertEvents.slice(i, i + batchSize) });
      }
      for (let i = 0; i < deleteEvents.length; i += batchSize * 8) {
        await send({ deleteEvents: deleteEvents.slice(i, i + batchSize * 8) });
      }
      if (deleteCalendars.length) await send({ deleteCalendars });
    },

    /**
     * Listen for live changes. Handlers:
     *   onHello(rev)              on every (re)connect, with the server's current revision
     *   onChange({ rev, origin, changes })   for every saved change set (dates revived)
     *   onStatus(connected)       when the connection opens or drops
     *   onSignedOut()             when the stream was refused because the session has ended
     * Reconnects by itself. Returns a function that stops listening.
     */
    subscribe({ onHello, onChange, onStatus, onSignedOut }) {
      if (typeof EventSource === 'undefined') return () => {};
      let es = null, stopped = false, retry = 0, timer = 0;

      const connect = () => {
        es = new EventSource(`${base}/live`);
        es.addEventListener('hello', (e) => { retry = 0; onHello?.(JSON.parse(e.data).rev); });
        es.addEventListener('change', (e) => onChange?.(deserialize(e.data)));
        es.onopen = () => onStatus?.(true);
        es.onerror = () => {
          onStatus?.(false);
          // the browser retries by itself unless the server refused the connection outright
          if (es.readyState === EventSource.CLOSED && !stopped) {
            // refused outright: if it's because we're signed out, stop and say so
            fetch('/api/me', { cache: 'no-store' })
              .then((r) => { if (r.status === 401 && !stopped) { stopped = true; clearTimeout(timer); onSignedOut?.(); } })
              .catch(() => {});
            clearTimeout(timer);
            timer = setTimeout(connect, Math.min(30000, 2000 * 2 ** retry++));
          }
        };
      };

      const onVisible = () => {
        // phones often drop the connection in the background; reconnect right away on return
        if (document.visibilityState === 'visible' && es?.readyState === EventSource.CLOSED && !stopped) {
          clearTimeout(timer);
          connect();
        }
      };
      document.addEventListener('visibilitychange', onVisible);
      connect();

      return () => {
        stopped = true;
        clearTimeout(timer);
        es?.close();
        document.removeEventListener('visibilitychange', onVisible);
      };
    }
  };
}
