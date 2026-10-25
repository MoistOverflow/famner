// src/routes/api/lists/[name]/live/+server.js — live updates for a list (Server-Sent Events).
// Sends { rev } on connect, then { rev, origin, changes } for every saved change.

import { env } from '$env/dynamic/private';
import { LIST_NAMES, openLists, listRev, subscribeList } from '$lib/server/collections.js';
import { authDb, sessionIsValid } from '$lib/server/auth.js';

const PING_MS = 25000;

export function GET({ params, request, locals }) {
  if (!LIST_NAMES.has(params.name)) return new Response('No such list.', { status: 404 });
  const db = openLists(env.CALENDAR_DB || 'data/calendar.db');
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let open = true;
      const write = (chunk) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { cleanup(); }
      };
      const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      write('retry: 3000\n\n');
      send('hello', { rev: listRev(db, params.name) });
      const unsubscribe = subscribeList(params.name, (message) => send('change', message));
      const ping = setInterval(() => {
        // close when the session ends (signed out, password reset, account turned off)
        if (!sessionIsValid(authDb(env.CALENDAR_DB || 'data/calendar.db'), locals.sessionId)) return cleanup();
        write(': ping\n\n');
      }, PING_MS);

      cleanup = () => {
        if (!open) return;
        open = false;
        clearInterval(ping);
        unsubscribe();
        try { controller.close(); } catch {}
      };
      request.signal?.addEventListener('abort', cleanup);
    },
    cancel() {
      cleanup();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}
