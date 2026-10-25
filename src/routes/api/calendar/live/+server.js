// src/routes/api/calendar/live/+server.js — live updates for open calendars (Server-Sent Events).
// Each browser keeps this connection open. It first gets { rev } (the current revision), then every
// saved change set as it happens: { rev, origin, changes }, with other people's private calendars
// left out. The stream closes when the session ends (signed out, password reset, account turned off).
// Browsers reconnect automatically.

import { env } from '$env/dynamic/private';
import { getDb, currentRev, subscribe, messageFor } from '$lib/server/calendarDb.js';
import { authDb, sessionIsValid } from '$lib/server/auth.js';

const PING_MS = 25000; // keeps proxies and phones from closing an idle connection

export function GET({ request, locals }) {
  const db = getDb(env.CALENDAR_DB || 'data/calendar.db');
  const userId = locals.user.id;
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let open = true;
      const write = (chunk) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      write('retry: 3000\n\n'); // reconnect after 3 s if the connection drops
      send('hello', { rev: currentRev(db) });
      const unsubscribe = subscribe((message) => send('change', messageFor(message, userId)));
      const ping = setInterval(() => {
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
      'X-Accel-Buffering': 'no' // tell nginx not to buffer the stream
    }
  });
}
