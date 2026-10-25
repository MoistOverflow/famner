// src/routes/api/ics/+server.js
// Fetches a calendar (.ics) file on the server so the browser doesn't hit cross-site (CORS) limits.
// Use it with: <Calendar corsProxy="/api/ics?url=" … />
// Only signed-in users can use it (see hooks.server.js).
//
// Needs a Node-based adapter (adapter-node, adapter-auto on Vercel/Netlify's Node runtime, or `npm run dev`).

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Set to true to allow calendars on your own network (e.g. http://192.168.1.20/cal.ics or localhost).
// Leave false on a public server: otherwise anyone could use this route to reach machines behind it.
const ALLOW_PRIVATE_ADDRESSES = false;

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20000;

const text = (body, status) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

function isPrivateIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||            // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)     // carrier-grade NAT
    );
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v)) return true; // unique-local, link-local
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIp(mapped[1]) : false;
}

async function checkHost(url) {
  if (ALLOW_PRIVATE_ADDRESSES) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    return `Couldn’t find the server “${host}”. Check the address.`;
  }
  if (addresses.some((a) => isPrivateIp(a.address))) {
    return 'That address is on a private network, which this server doesn’t allow.';
  }
  return null;
}

export async function GET({ url: requestUrl }) {
  const raw = requestUrl.searchParams.get('url');
  if (!raw) return text('Add ?url=<calendar address>.', 400);

  let target;
  try {
    target = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    return text('That isn’t a valid address.', 400);
  }

  try {
    let res;
    // follow redirects by hand so every hop gets the same address check
    for (let hop = 0; ; hop++) {
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        return text('Only http and https addresses are supported.', 400);
      }
      const problem = await checkHost(target);
      if (problem) return text(problem, 400);

      res = await fetch(target, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Calendar subscription', Accept: 'text/calendar, */*' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) return text('That address redirects too many times.', 502);
        target = new URL(location, target);
        continue;
      }
      break;
    }

    if (!res.ok) {
      return text(`The calendar server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}. Check the address.`, 502);
    }
    if (Number(res.headers.get('content-length')) > MAX_BYTES) return text('That calendar file is too large.', 413);
    const body = await res.text();
    if (body.length > MAX_BYTES) return text('That calendar file is too large.', 413);
    if (!/BEGIN:VCALENDAR/i.test(body.slice(0, 4096))) {
      return text('That address didn’t return a calendar (.ics) file.', 422);
    }

    return new Response(body, {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    return text(
      err?.name === 'TimeoutError' ? 'The calendar server took too long to answer.' : 'Couldn’t reach the calendar server.',
      502
    );
  }
}
