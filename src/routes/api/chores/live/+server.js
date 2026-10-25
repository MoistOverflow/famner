// src/routes/api/chores/live/+server.js — tells open chores pages when anything changed
// (Server-Sent Events: { rev } on connect and after every change). Pages then reload their data.
// Closes when the session ends.

import { env } from '$env/dynamic/private';
import { choresDb, choresRev, subscribeChores } from '$lib/server/chores.js';
import { authDb, sessionIsValid } from '$lib/server/auth.js';

const PING_MS = 25000;

export function GET({ request, locals }) {
  const path = env.CALENDAR_DB || 'data/calendar.db';
  const db = choresDb(path);
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
      send('hello', { rev: choresRev(db) });
      const unsubscribe = subscribeChores((m) => send('change', m));
      const ping = setInterval(() => {
        if (!sessionIsValid(authDb(path), locals.sessionId)) return cleanup();
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
    cancel() { cleanup(); }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }
  });
}
