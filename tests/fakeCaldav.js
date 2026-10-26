// A pretend iCloud calendar server for the tests: enough CalDAV (PROPFIND, REPORT, PUT, DELETE,
// MKCALENDAR, etags and change tags) to sync against, answering the way iCloud does.
import { createServer } from 'node:http';

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function fakeCaldav({
	user = 'me@icloud.com',
	password = 'abcd-efgh-ijkl-mnop'
} = {}) {
	const calendars = new Map(); // id → { name, color, writable, comps, ctag, items: Map(file → { etag, data }) }
	let n = 0;
	const log = [];
	const home = '/123/calendars/';
	const addCalendar = (
		id,
		{ name, color = '#FF2968FF', writable = true, comps = ['VEVENT'] } = {}
	) => {
		calendars.set(id, {
			name: name ?? id,
			color,
			writable,
			comps,
			ctag: `c${++n}`,
			items: new Map()
		});
		return `${base}${home}${id}/`;
	};

	const ms = (inner) =>
		`<?xml version="1.0" encoding="UTF-8"?>\n<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">${inner}</multistatus>`;
	const resp = (href, props) =>
		`<response><href>${xmlEsc(href)}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
	const calProps = (c) =>
		`<resourcetype><collection/><C:calendar/></resourcetype><displayname>${xmlEsc(c.name)}</displayname><CS:getctag>${c.ctag}</CS:getctag>` +
		`<A:calendar-color>${c.color}</A:calendar-color><C:supported-calendar-component-set>${c.comps.map((x) => `<C:comp name="${x}"/>`).join('')}</C:supported-calendar-component-set>` +
		`<current-user-privilege-set><privilege><read/></privilege>${c.writable ? '<privilege><write/></privilege>' : ''}</current-user-privilege-set>`;

	const server = createServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) body += chunk;
		const path = decodeURIComponent(new URL(req.url, base).pathname);
		log.push(`${req.method} ${path}`);
		const send = (status, text = '', headers = {}) => {
			res.writeHead(status, headers);
			res.end(text);
		};
		if (
			req.headers.authorization !==
			'Basic ' + Buffer.from(`${fake.user}:${fake.password}`).toString('base64')
		)
			return send(401);
		if (fake.failNext) {
			const s = fake.failNext;
			fake.failNext = null;
			return send(s);
		}

		const m = path.match(/^\/123\/calendars\/([^/]+)\/(?:([^/]+\.ics))?$/);
		const cal = m && calendars.get(m[1]);
		const file = m?.[2];
		const xml = (inner) =>
			send(207, ms(inner), { 'Content-Type': 'application/xml; charset=utf-8' });

		if (req.method === 'PROPFIND') {
			const depth = req.headers.depth ?? '1';
			if (path === '/')
				return xml(
					resp('/', '<current-user-principal><href>/123/principal/</href></current-user-principal>')
				);
			if (path === '/123/principal/')
				return xml(
					resp(path, `<C:calendar-home-set><href>${base}${home}</href></C:calendar-home-set>`)
				);
			if (path === home) {
				let out = resp(home, '<resourcetype><collection/></resourcetype>');
				if (depth !== '0')
					for (const [id, c] of calendars) out += resp(`${home}${id}/`, calProps(c));
				return xml(out);
			}
			if (!cal) return send(404);
			if (file) {
				const it = cal.items.get(file);
				return it ? xml(resp(path, `<getetag>${it.etag}</getetag>`)) : send(404);
			}
			let out = resp(
				path,
				depth === '0'
					? `<CS:getctag>${cal.ctag}</CS:getctag>`
					: '<resourcetype><collection/><C:calendar/></resourcetype>'
			);
			if (depth !== '0')
				for (const [f, it] of cal.items)
					out += resp(`${path}${f}`, `<getetag>${it.etag}</getetag><resourcetype/>`);
			return xml(out);
		}
		if (req.method === 'REPORT' && cal) {
			const hrefs = [...body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((x) =>
				decodeURIComponent(x[1])
			);
			let out = '';
			for (const h of hrefs) {
				const it = cal.items.get(h.split('/').pop());
				if (it)
					out += resp(
						h,
						`<getetag>${it.etag}</getetag><C:calendar-data>${xmlEsc(it.data)}</C:calendar-data>`
					);
			}
			return xml(out);
		}
		if (req.method === 'PUT' && cal && file) {
			if (!cal.writable) return send(403);
			if (fake.beforePut) {
				const f = fake.beforePut;
				fake.beforePut = null;
				f(m[1], file);
			} // someone else saves first
			const it = cal.items.get(file);
			if (req.headers['if-none-match'] === '*' && it) return send(412);
			if (req.headers['if-match'] && req.headers['if-match'] !== it?.etag) return send(412);
			const etag = `"e${++n}"`;
			cal.items.set(file, { etag, data: body });
			cal.ctag = `c${++n}`;
			return send(it ? 204 : 201, '', fake.omitEtag ? {} : { ETag: etag });
		}
		if (req.method === 'DELETE' && cal && file) {
			const it = cal.items.get(file);
			if (!it) return send(404);
			if (req.headers['if-match'] && req.headers['if-match'] !== it.etag) return send(412);
			cal.items.delete(file);
			cal.ctag = `c${++n}`;
			return send(204);
		}
		if (req.method === 'MKCALENDAR') {
			const id = path.match(/^\/123\/calendars\/([^/]+)\/$/)?.[1];
			if (!id || calendars.has(id)) return send(405);
			addCalendar(id, {
				name: body.match(/<d:displayname>([^<]*)<\/d:displayname>/)?.[1] ?? 'New'
			});
			return send(201);
		}
		send(405);
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${server.address().port}`;

	const fake = {
		url: `${base}/`,
		user,
		password,
		log,
		calendars,
		failNext: null,
		omitEtag: false,
		beforePut: null,
		addCalendar,
		/** What's in a calendar: Map(file → ics text). */
		files: (id) => new Map([...calendars.get(id).items].map(([f, it]) => [f, it.data])),
		/** Change an event "on the iPhone". */
		put(id, file, data) {
			const c = calendars.get(id);
			c.items.set(file, { etag: `"e${++n}"`, data: data.replace(/\r?\n/g, '\r\n') });
			c.ctag = `c${++n}`;
		},
		remove(id, file) {
			const c = calendars.get(id);
			c.items.delete(file);
			c.ctag = `c${++n}`;
		},
		close: () => new Promise((r) => server.close(r))
	};
	return fake;
}
