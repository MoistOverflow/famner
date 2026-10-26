// src/lib/server/caldav.js — a small CalDAV client (the protocol iCloud Calendar speaks), server only.
//
//   const dav = caldavClient({ server: 'https://caldav.icloud.com/', username, password });
//   const { home } = await dav.discover();
//   const cals = await dav.calendars(home);          // [{ url, name, color, ctag, writable }]
//   const etags = await dav.etags(cals[0].url);      // Map(event url → etag)
//   const got = await dav.multiget(cals[0].url, [...etags.keys()]);  // Map(url → { etag, data })
//   await dav.put(url, icsText, { etag });           // update (or { create: true } for new)
//   await dav.remove(url, etag);
//
// Every URL handed out is absolute. Errors are CalDavError with `status` (401 = wrong password,
// 412 = changed on the server since we last looked, 0 = couldn't reach it).

export class CalDavError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// ---------- a little XML reader (enough for WebDAV answers; namespaces are ignored) ----------
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e] ?? m
  );
const localName = (n) => n.slice(n.indexOf(':') + 1).toLowerCase();

/** XML text → { name, attrs, children, text } (names without their namespace prefix, lowercase). */
export function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.text += m[1];
    else if (m[6] != null) top.text += decode(m[6]);
    else if (m[3]) {
      if (m[2]) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[localName(a[1])] = decode(a[2] ?? a[3]);
      const node = { name: localName(m[3]), attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  return root;
}
const kids = (n, name) => (n?.children ?? []).filter((c) => c.name === name);
const kid = (n, name) => kids(n, name)[0] ?? null;
function find(n, name) {
  if (!n) return null;
  for (const c of n.children) {
    if (c.name === name) return c;
    const f = find(c, name);
    if (f) return f;
  }
  return null;
}
const textOf = (n) => (n ? n.text.trim() : null);

/** A multistatus answer → [{ href, props: { name → node } }] (only properties answered with 200). */
function responses(doc, base) {
  const out = [];
  for (const r of kids(find(doc, 'multistatus') ?? doc, 'response')) {
    const href = textOf(kid(r, 'href'));
    if (!href) continue;
    const props = {};
    for (const ps of kids(r, 'propstat')) {
      const status = textOf(kid(ps, 'status')) ?? '';
      if (status && !/\s2\d\d\b/.test(status)) continue;
      for (const p of kid(ps, 'prop')?.children ?? []) props[p.name] = p;
    }
    out.push({ href: new URL(href, base).href, props, status: textOf(kid(r, 'status')) });
  }
  return out;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/"';
const propfindBody = (props) => `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop>${props.map((p) => `<${p}/>`).join('')}</d:prop></d:propfind>`;

/** "#RRGGBB" from Apple's "#RRGGBBAA" (or null). */
const color = (s) => {
  const m = String(s ?? '').trim().match(/^#([0-9a-f]{6})/i);
  return m ? `#${m[1].toLowerCase()}` : null;
};

// ---------- the client ----------
export function caldavClient({ server, username, password, timeoutMs = 30000, userAgent = 'Famner' }) {
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const start = new URL(server);
  // the address book may live on another host of the same service (iCloud: p52-caldav.icloud.com)
  const parent = (h) => h.split('.').slice(-2).join('.');
  const trusted = (u) => u.hostname === start.hostname || parent(u.hostname) === parent(start.hostname);

  async function request(method, url, { body, headers = {}, depth } = {}) {
    let target = new URL(url);
    for (let hop = 0; hop < 6; hop++) {
      if (!trusted(target)) throw new CalDavError(`The calendar server sent us to an unexpected address (${target.host}).`);
      let res;
      try {
        res = await fetch(target, {
          method,
          redirect: 'manual',
          body,
          headers: {
            Authorization: auth,
            'User-Agent': userAgent,
            ...(body ? { 'Content-Type': headers['Content-Type'] ?? 'application/xml; charset=utf-8' } : {}),
            ...(depth != null ? { Depth: String(depth) } : {}),
            ...headers
          },
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (err) {
        throw new CalDavError(err?.name === 'TimeoutError' ? 'iCloud took too long to answer.' : 'Couldn’t reach iCloud. Check the server’s internet connection.');
      }
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        target = new URL(loc, target);
        continue;
      }
      if (res.status === 401) throw new CalDavError('iCloud didn’t accept the Apple ID and app-specific password.', 401);
      if (res.status === 403) throw new CalDavError('iCloud doesn’t allow that change (the calendar may be view-only).', 403);
      if (res.status === 412) throw new CalDavError('That event changed in iCloud in the meantime.', 412);
      if (res.status === 404 && method === 'DELETE') return { res, text: '', url: target.href };
      if (!res.ok && res.status !== 207) {
        throw new CalDavError(`iCloud answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`, res.status);
      }
      return { res, text: await res.text(), url: target.href };
    }
    throw new CalDavError('iCloud redirected too many times.');
  }

  async function propfind(url, props, depth) {
    const { text, url: final } = await request('PROPFIND', url, { body: propfindBody(props), depth });
    return responses(parseXml(text), final);
  }

  return {
    /** Find the signed-in user's calendar folder. */
    async discover() {
      const [me] = await propfind(start.href, ['d:current-user-principal'], 0);
      const principalHref = textOf(kid(me?.props['current-user-principal'], 'href'));
      if (!principalHref) throw new CalDavError('That server doesn’t look like a CalDAV calendar server.');
      const principal = new URL(principalHref, me.href).href;
      const [p] = await propfind(principal, ['c:calendar-home-set'], 0);
      const homeHref = textOf(kid(p?.props['calendar-home-set'], 'href'));
      if (!homeHref) throw new CalDavError('Couldn’t find the calendars of that account.');
      return { principal, home: new URL(homeHref, principal).href };
    },

    /** The calendars in `home` that hold events. */
    async calendars(home) {
      const list = await propfind(home, ['d:resourcetype', 'd:displayname', 'cs:getctag', 'a:calendar-color', 'c:supported-calendar-component-set', 'd:current-user-privilege-set'], 1);
      const out = [];
      for (const r of list) {
        const types = (r.props.resourcetype?.children ?? []).map((c) => c.name);
        if (!types.includes('calendar') || r.href === new URL(home).href) continue;
        const comps = kids(r.props['supported-calendar-component-set'], 'comp').map((c) => String(c.attrs.name ?? '').toUpperCase());
        if (comps.length && !comps.includes('VEVENT')) continue; // reminders lists
        const privs = r.props['current-user-privilege-set'];
        const writable = !privs || kids(privs, 'privilege').some((p) => p.children.some((c) => ['write', 'write-content', 'all'].includes(c.name)));
        out.push({ url: r.href, name: textOf(r.props.displayname) || 'Calendar', color: color(textOf(r.props['calendar-color'])), ctag: textOf(r.props.getctag), writable });
      }
      return out;
    },

    /** A calendar's change tag: it changes whenever anything in the calendar does. */
    async ctag(calUrl) {
      const [r] = await propfind(calUrl, ['cs:getctag'], 0);
      return textOf(r?.props.getctag);
    },

    /** Every event in the calendar → Map(url → etag). */
    async etags(calUrl) {
      const base = new URL(calUrl).href;
      const out = new Map();
      for (const r of await propfind(calUrl, ['d:getetag', 'd:resourcetype'], 1)) {
        if (r.href === base || (r.props.resourcetype?.children ?? []).length) continue;
        const etag = textOf(r.props.getetag);
        if (etag) out.set(r.href, etag);
      }
      return out;
    },

    /** The events at `urls` → Map(url → { etag, data }), in batches. */
    async multiget(calUrl, urls) {
      const out = new Map();
      for (let i = 0; i < urls.length; i += 100) {
        const part = urls.slice(i, i + 100);
        const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop>${part.map((u) => `<d:href>${esc(new URL(u).pathname)}</d:href>`).join('')}</c:calendar-multiget>`;
        const { text, url } = await request('REPORT', calUrl, { body, depth: 1 });
        for (const r of responses(parseXml(text), url)) {
          const data = r.props['calendar-data']?.text;
          if (data) out.set(r.href, { etag: textOf(r.props.getetag), data });
        }
      }
      return out;
    },

    /** Save an event. Returns its new etag (null if the server didn't say). */
    async put(url, ics, { etag = null, create = false } = {}) {
      const headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
      if (create) headers['If-None-Match'] = '*';
      else if (etag) headers['If-Match'] = etag;
      const { res } = await request('PUT', url, { body: ics, headers });
      return res.headers.get('etag');
    },

    async etagOf(url) {
      const [r] = await propfind(url, ['d:getetag'], 0);
      return textOf(r?.props.getetag);
    },

    async remove(url, etag = null) {
      await request('DELETE', url, { headers: etag ? { 'If-Match': etag } : {} });
    },

    /** Make a new calendar in `home`; returns its url. */
    async makeCalendar(home, { name, color: hex }) {
      const url = new URL(`${crypto.randomUUID().toUpperCase()}/`, home).href;
      const body = `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar ${NS}><d:set><d:prop><d:displayname>${esc(name)}</d:displayname>${hex ? `<a:calendar-color>${esc(hex.toUpperCase())}FF</a:calendar-color>` : ''}<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`;
      await request('MKCALENDAR', url, { body });
      return url;
    }
  };
}
