// src/routes/admin/backups/[name]/+server.js — download a backup (admins only; see hooks.server.js).
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { backupFile } from '$lib/server/backups.js';

export function GET({ params, locals }) {
  if (locals.user?.role !== 'admin') error(403, 'Only admins can download backups.');
  const file = backupFile(env.CALENDAR_DB || 'data/calendar.db', params.name);
  if (!file) error(404, 'That backup doesn’t exist.');
  return new Response(Readable.toWeb(createReadStream(file)), {
    headers: {
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Length': String(statSync(file).size),
      'Content-Disposition': `attachment; filename="${params.name}"`,
      'Cache-Control': 'no-store'
    }
  });
}
