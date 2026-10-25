// calendarUtils.js — date math, repeating events, layout and storage helpers
// used by Calendar.svelte. Plain JS so it can be tested without Svelte.

export const DAY_MS = 86400000;

// ---------- dates ----------
export const pad = (n) => String(n).padStart(2, '0');
export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMinutes = (d, n) => new Date(+d + n * 60000);
export const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
export const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const startOfWeek = (d, weekStartsOn = 0) => {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() - weekStartsOn + 7) % 7));
};
export const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
/** whole calendar days from a to b (DST-safe) */
export const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
export const monthDiff = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
export const minOfDay = (d) => d.getHours() * 60 + d.getMinutes();
export const atMinute = (day, min) => addMinutes(startOfDay(day), min);

export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const hm = (min) => (min >= 1440 ? '23:59' : `${pad(Math.floor(min / 60))}:${pad(min % 60)}`);
export const parseHm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

/** Only all-day events go in the all-day strip; timed events (even multi-day) go in the time grid. */
export const isLong = (x) => !!(x.event ? x.event.allDay : x.allDay); // accepts an event or an occurrence

/** True when a timed event starts and ends on different calendar days. */
export const spansDays = (o) => !sameDay(o.start, new Date(+o.end - 1));

// ---------- repeating events ----------
/*
  Repeat rules
    { freq: 'daily' | 'weekly' | 'monthly' | 'yearly',
      interval?: n,              // every n days/weeks/months/years (default 1)
      byWeekday?: [0..6],        // weekly: which days (0 = Sunday); default the start's weekday
      monthlyBy?: 'day' | 'nth' | 'last',  // monthly: same date, e.g. "2nd Tuesday", or "last Friday"
      until?: Date,              // last day it can happen (inclusive)
      count?: n }                // or: stop after n occurrences
  The older { freq: 'weekdays' } is still understood (= weekly on Mon–Fri).
*/
export const REPEAT_PRESETS = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
const UNIT = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth'];
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

/** Fill in defaults and convert old formats. Returns null if `r` isn't a valid repeat. */
export function normalizeRepeat(r, start) {
  if (!r) return null;
  let { freq, interval = 1, byWeekday, monthlyBy, until, count } = r;
  if (freq === 'weekdays') { freq = 'weekly'; byWeekday = [1, 2, 3, 4, 5]; }
  if (!FREQS.includes(freq)) return null;
  const out = { freq, interval: Math.max(1, Math.floor(Number(interval)) || 1) };
  if (freq === 'weekly') {
    const days = (byWeekday ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    out.byWeekday = days.length ? [...new Set(days)].sort((a, b) => a - b) : [start.getDay()];
  }
  if (freq === 'monthly') out.monthlyBy = ['day', 'nth', 'last'].includes(monthlyBy) ? monthlyBy : 'day';
  if (until) out.until = until;
  else if (Number(count) > 0) out.count = Math.floor(Number(count));
  return out;
}

/** Which week of the month a date falls in, and whether it's the last such weekday. */
export function weekdayPosition(d) {
  const nth = Math.ceil(d.getDate() / 7);
  const isLast = d.getDate() + 7 > daysInMonth(d.getFullYear(), d.getMonth());
  return { nth, isLast };
}

/** The monthly options that make sense for an event starting on `d`. */
export function monthlyChoices(d) {
  const { nth, isLast } = weekdayPosition(d);
  const wd = WD_LONG[d.getDay()];
  const out = [{ value: 'day', label: `On day ${d.getDate()}` }];
  if (nth <= 4) out.push({ value: 'nth', label: `On the ${ORDINAL[nth - 1]} ${wd}` });
  if (isLast) out.push({ value: 'last', label: `On the last ${wd}` });
  return out;
}

export function presetRepeat(key, start) {
  switch (key) {
    case 'daily': return { freq: 'daily', interval: 1 };
    case 'weekdays': return { freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4, 5] };
    case 'weekly': return { freq: 'weekly', interval: 1, byWeekday: [start.getDay()] };
    case 'monthly': return { freq: 'monthly', interval: 1, monthlyBy: 'day' };
    case 'yearly': return { freq: 'yearly', interval: 1 };
    default: return null;
  }
}

/** 'none', one of REPEAT_PRESETS, or 'custom' — ignoring when it ends. */
export function matchPreset(r, start) {
  const n = normalizeRepeat(r, start);
  if (!n) return 'none';
  const sig = (x) => [x.freq, x.interval, (x.byWeekday ?? []).join(','), x.monthlyBy ?? ''].join('|');
  for (const key of REPEAT_PRESETS) {
    if (sig(normalizeRepeat(presetRepeat(key, start), start)) === sig(n)) return key;
  }
  return 'custom';
}

/** Plain-English description, e.g. "Every 2 weeks on Mon, Wed, Fri, until Dec 31, 2026". */
export function describeRepeat(r, start) {
  const n = normalizeRepeat(r, start);
  if (!n) return 'Does not repeat';
  const unit = UNIT[n.freq];
  let s;
  if (n.freq === 'weekly' && n.interval === 1 && n.byWeekday.join() === '1,2,3,4,5') s = 'Every weekday (Mon–Fri)';
  else {
    s = n.interval === 1 ? (n.freq === 'daily' ? 'Every day' : `Every ${unit}`) : `Every ${n.interval} ${unit}s`;
    if (n.freq === 'weekly') {
      s += n.byWeekday.length === 1
        ? ` on ${WD_LONG[n.byWeekday[0]]}`
        : ` on ${n.byWeekday.map((d) => WD_SHORT[d]).join(', ')}`;
    } else if (n.freq === 'monthly') {
      const { nth } = weekdayPosition(start);
      s += n.monthlyBy === 'day' ? ` on day ${start.getDate()}`
        : n.monthlyBy === 'nth' ? ` on the ${ORDINAL[nth - 1]} ${WD_LONG[start.getDay()]}`
        : ` on the last ${WD_LONG[start.getDay()]}`;
    } else if (n.freq === 'yearly') {
      s += ` on ${start.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
    }
  }
  if (n.until) s += `, until ${n.until.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  else if (n.count) s += `, ${n.count} time${n.count === 1 ? '' : 's'}`;
  return s;
}

/** The date in month (y, m) a monthly rule lands on, or null if it doesn't exist that month. */
function monthlyDate(y, m, by, s) {
  const first = new Date(y, m, 1);
  const Y = first.getFullYear(), M = first.getMonth();
  if (by === 'day') return s.getDate() <= daysInMonth(Y, M) ? new Date(Y, M, s.getDate()) : null;
  if (by === 'last') {
    const last = new Date(Y, M + 1, 0);
    return new Date(Y, M, last.getDate() - ((last.getDay() - s.getDay() + 7) % 7));
  }
  const { nth } = weekdayPosition(s);
  const day = 1 + ((s.getDay() - first.getDay() + 7) % 7) + (nth - 1) * 7;
  return day <= daysInMonth(Y, M) ? new Date(Y, M, day) : null;
}

/**
 * Yields occurrence starts of a repeating event in order. Starts a little before `from`
 * to skip ahead quickly; may yield times before the event's own start (callers skip those).
 */
function* occurrenceStarts(ev, r, from) {
  const s = ev.start;
  const t = minOfDay(s);
  const n = r.interval;
  if (r.freq === 'daily') {
    let k = Math.max(0, Math.floor(dayDiff(s, from) / n) - 1);
    for (;; k++) yield addDays(s, k * n);
  } else if (r.freq === 'weekly') {
    const anchor = startOfWeek(s, 0);
    let w = Math.max(0, Math.floor(dayDiff(anchor, from) / 7 / n) - 1);
    for (;; w++) {
      for (const wd of r.byWeekday) yield atMinute(addDays(anchor, w * n * 7 + wd), t);
    }
  } else {
    const step = r.freq === 'yearly' ? 12 * n : n;
    const by = r.freq === 'yearly' ? 'day' : r.monthlyBy;
    let k = Math.max(0, Math.floor(monthDiff(s, from) / step) - 1);
    for (;; k++) {
      const d = monthlyDate(s.getFullYear(), s.getMonth() + k * step, by, s);
      if (d) yield atMinute(d, t); // e.g. the 31st in a 30-day month: skip that month
    }
  }
}

function occurrenceEnd(ev, start) {
  if (ev.allDay) return addDays(start, dayDiff(ev.start, ev.end));
  return new Date(+start + (ev.end - ev.start));
}

/**
 * Every occurrence that overlaps [rangeStart, rangeEnd).
 * Returns [{ key, event, start, end, recurring }].
 */
export function expandEvents(events, rangeStart, rangeEnd, isVisible = () => true) {
  const out = [];
  for (const ev of events) {
    if (!isVisible(ev)) continue;
    const r = normalizeRepeat(ev.repeat, ev.start);
    if (!r) {
      if (ev.start < rangeEnd && ev.end > rangeStart)
        out.push({ key: String(ev.id), event: ev, start: ev.start, end: ev.end, recurring: false });
      continue;
    }
    const limit = r.until ? addDays(startOfDay(r.until), 1) : null;
    const skip = new Set(ev.exdates ?? []);
    // with a count we have to walk from the first occurrence to know which ones exist
    const from = r.count ? ev.start : new Date(+rangeStart - (ev.end - ev.start) - DAY_MS);
    let guard = 0, produced = 0;
    for (const s of occurrenceStarts(ev, r, from)) {
      if (++guard > 20000 || s >= rangeEnd || (limit && s >= limit)) break;
      if (s < ev.start) continue;
      if (r.count && ++produced > r.count) break;
      const e = occurrenceEnd(ev, s);
      if (e <= rangeStart || skip.has(ymd(s))) continue;
      out.push({ key: `${ev.id}:${ymd(s)}`, event: ev, start: s, end: e, recurring: true });
    }
  }
  return out;
}

// ---------- layout ----------
/**
 * Timed segments for one day column, clipped to [winStart, winEnd) minutes.
 * Overlapping segments get side-by-side columns.
 * Returns [{ occ, sMin, eMin, col, cols, isStart, isEnd }].
 */
export function layoutTimedDay(occs, day, winStart = 0, winEnd = 1440) {
  const d0 = startOfDay(day);
  const lo = +addMinutes(d0, winStart);
  const hi = +addMinutes(d0, winEnd);
  const items = occs
    .filter((o) => !isLong(o) && o.start < hi && o.end > lo)
    .map((o) => ({ occ: o, s: Math.max(+o.start, lo), e: Math.min(+o.end, hi) }))
    .sort((a, b) => a.s - b.s || b.e - a.e);

  const out = [];
  let cluster = [], colEnds = [], clusterEnd = -Infinity;
  const flush = () => {
    for (const it of cluster) it.cols = colEnds.length;
    out.push(...cluster);
    cluster = []; colEnds = [];
  };
  for (const it of items) {
    if (it.s >= clusterEnd) { flush(); clusterEnd = -Infinity; }
    let col = colEnds.findIndex((end) => end <= it.s);
    if (col === -1) { col = colEnds.length; colEnds.push(it.e); } else colEnds[col] = it.e;
    it.col = col;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  flush();

  const dayEnd = +addDays(d0, 1);
  return out.map((it) => ({
    occ: it.occ,
    sMin: (it.s - +d0) / 60000,
    eMin: (it.e - +d0) / 60000,
    col: it.col,
    cols: it.cols,
    isStart: +it.occ.start >= +d0,
    isEnd: +it.occ.end <= dayEnd
  }));
}

/** Earliest and latest minute (from midnight) needed to show every timed occurrence on these days. */
export function timedExtent(occs, days) {
  let min = Infinity, max = -Infinity;
  for (const day of days) {
    for (const seg of layoutTimedDay(occs, day)) {
      min = Math.min(min, seg.sMin);
      max = Math.max(max, seg.eMin);
    }
  }
  return min === Infinity ? null : { min, max };
}

/**
 * Bars for the all-day strip across `days` (consecutive).
 * Returns { items: [{ occ, startCol, endCol, row, contLeft, contRight }], rows }.
 */
export function layoutStrip(occs, days) {
  if (!days.length) return { items: [], rows: 0 };
  const first = startOfDay(days[0]);
  const n = days.length;
  const items = occs
    .filter(isLong)
    .map((o) => {
      const a = dayDiff(first, o.start);
      const lastDay = new Date(+o.end - 1); // end is exclusive
      const b = dayDiff(first, lastDay);
      return { occ: o, a, b };
    })
    .filter((it) => it.b >= 0 && it.a < n)
    .sort((x, y) => x.a - y.a || (y.b - y.a) - (x.b - x.a));

  const rowEnds = [];
  const out = [];
  for (const it of items) {
    const startCol = Math.max(0, it.a);
    const endCol = Math.min(n - 1, it.b);
    let row = rowEnds.findIndex((end) => end < startCol);
    if (row === -1) { row = rowEnds.length; rowEnds.push(endCol); } else rowEnds[row] = endCol;
    out.push({ occ: it.occ, startCol, endCol, row, contLeft: it.a < 0, contRight: it.b > n - 1 });
  }
  return { items: out, rows: rowEnds.length };
}

/** Occurrences touching `day`, all-day/long first, then by start time. */
export function occurrencesOnDay(occs, day) {
  const s = startOfDay(day), e = addDays(s, 1);
  return occs
    .filter((o) => o.start < e && o.end > s)
    .sort((a, b) => (isLong(b) - isLong(a)) || (a.start - b.start) || (b.end - a.end));
}

// ---------- editing ----------
/**
 * Move an event (or a whole repeating series) by the same amount an occurrence moved:
 * `dayDelta` calendar days plus `minDelta` minutes. Skipped dates move with it.
 */
export function shiftEvent(ev, dayDelta, minDelta) {
  const move = (d) => addMinutes(addDays(d, dayDelta), minDelta);
  const next = { ...ev, start: move(ev.start), end: move(ev.end) };
  if (ev.exdates?.length && dayDelta) next.exdates = ev.exdates.map((s) => ymd(addDays(parseYmd(s), dayDelta)));
  // a weekly series moved to other days keeps the same pattern, e.g. Mon/Wed → Tue/Thu
  if (dayDelta && ev.repeat?.byWeekday?.length) {
    next.repeat = { ...ev.repeat, byWeekday: ev.repeat.byWeekday.map((d) => (((d + dayDelta) % 7) + 7) % 7).sort((a, b) => a - b) };
  }
  return next;
}

/** Calendar-day and minute difference between two instants (for shiftEvent). */
export function deltaBetween(from, to) {
  return { dayDelta: dayDiff(from, to), minDelta: minOfDay(to) - minOfDay(from) };
}

// ---------- storage ----------
const DATE_KEYS = new Set(['start', 'end', 'until']);

export function serialize(data) {
  return JSON.stringify(data, (k, v) => v);
}

export function deserialize(text) {
  return JSON.parse(text, (k, v) => (DATE_KEYS.has(k) && typeof v === 'string' ? new Date(v) : v));
}

export function loadState(key) {
  if (!key || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = deserialize(raw);
    if (data && Array.isArray(data.events) && Array.isArray(data.calendars)) return data;
  } catch (err) {
    console.warn('Calendar: could not read saved data', err);
  }
  return null;
}

export function saveState(key, data) {
  if (!key || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, serialize(data));
  } catch (err) {
    console.warn('Calendar: could not save data', err);
  }
}

// ---------- .ics import ----------
/*
  parseICS(text) reads an iCalendar file (Google, Apple, Outlook exports, subscriptions…) and returns
    { name, color, events: [{ uid, title, start, end, allDay?, location?, notes?, repeat?, exdates? }],
      warnings: [string], cancelled: n }
  Times with a TZID are converted to the viewer's local time. Repeat rules are converted to this
  calendar's repeat format; rules it can't express are imported as their first date with a warning.
  Moved/edited single occurrences (RECURRENCE-ID) become their own events.
*/
const ICS_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WINDOWS_ZONES = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest', 'Russian Standard Time': 'Europe/Moscow',
  'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore', 'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. South America Standard Time': 'America/Sao_Paulo', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC'
};

function unescapeText(v) {
  return v.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function parseLine(line) {
  let i = 0, inQuote = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) break;
  }
  const head = line.slice(0, i);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) ?? [''];
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0].toUpperCase(), params, value: line.slice(i + 1) };
}

function resolveZone(tzid) {
  if (!tzid) return null;
  if (WINDOWS_ZONES[tzid]) return WINDOWS_ZONES[tzid];
  const m = tzid.match(/([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/); // e.g. /mozilla.org/…/America/New_York
  const zone = m ? m[1] : tzid;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone; } catch { return null; }
}

function zoneOffset(zone, utcMs) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utcMs;
}

/** Wall-clock time in `zone` → Date. */
function zonedDate(y, mo, d, h, mi, s, zone) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  const off = zoneOffset(zone, guess);
  let t = guess - off;
  const off2 = zoneOffset(zone, t);
  if (off2 !== off) t = guess - off2; // around a DST change
  return new Date(t);
}

/** Parse a DATE or DATE-TIME value. Returns { date, allDay } or null. */
function parseIcsDate(value, params = {}, warn = () => {}) {
  const v = value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || params.VALUE === 'DATE') {
    m = m ?? v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { date: new Date(+m[1], +m[2] - 1, +m[3]), allDay: true };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)];
  if (m[7]) return { date: new Date(Date.UTC(y, mo, d, h, mi, s)), allDay: false };
  if (params.TZID) {
    const zone = resolveZone(params.TZID);
    if (zone) return { date: zonedDate(y, mo, d, h, mi, s, zone), allDay: false };
    warn(`Unknown time zone “${params.TZID}” — those times were read as your local time.`);
  }
  return { date: new Date(y, mo, d, h, mi, s), allDay: false };
}

function parseDuration(v) {
  const m = v.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

/** RRULE → this calendar's repeat format, or null if it can't be expressed exactly. */
function mapRRule(value, start, warn) {
  const p = {};
  for (const kv of value.split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) p[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1).toUpperCase();
  }
  const freq = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[p.FREQ];
  if (!freq) return null;
  const r = { freq, interval: Math.max(1, parseInt(p.INTERVAL ?? '1', 10) || 1) };
  const byDay = p.BYDAY ? p.BYDAY.split(',') : [];
  const dayIndex = (s) => ICS_DAYS.indexOf(s.slice(-2));
  for (const k of ['BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYYEARDAY', 'BYWEEKNO']) if (p[k]) return null;

  if (freq === 'daily') {
    if (byDay.length) {
      if (r.interval !== 1 || byDay.some((d) => dayIndex(d) < 0)) return null;
      r.freq = 'weekly';
      r.byWeekday = byDay.map(dayIndex);
    }
    if (p.BYMONTHDAY || p.BYMONTH || p.BYSETPOS) return null;
  } else if (freq === 'weekly') {
    if (byDay.length) {
      if (byDay.some((d) => !/^(SU|MO|TU|WE|TH|FR|SA)$/.test(d))) return null;
      r.byWeekday = byDay.map(dayIndex);
    }
    if (p.BYMONTHDAY || p.BYMONTH || p.BYSETPOS) return null;
  } else if (freq === 'monthly') {
    if (p.BYMONTH) return null;
    if (p.BYMONTHDAY) {
      if (p.BYMONTHDAY.includes(',') || +p.BYMONTHDAY !== start.getDate() || byDay.length) return null;
      r.monthlyBy = 'day';
    } else if (byDay.length === 1) {
      const m = byDay[0].match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
      const n = m?.[1] ? +m[1] : p.BYSETPOS ? +p.BYSETPOS : null;
      if (!m || dayIndex(byDay[0]) !== start.getDay() || n == null) return null;
      if (n === -1 && weekdayPosition(start).isLast) r.monthlyBy = 'last';
      else if (n === weekdayPosition(start).nth && n <= 4) r.monthlyBy = 'nth';
      else return null;
    } else if (byDay.length || p.BYSETPOS) return null;
    else r.monthlyBy = 'day';
  } else {
    if (byDay.length || p.BYSETPOS) return null;
    if (p.BYMONTH && +p.BYMONTH !== start.getMonth() + 1) return null;
    if (p.BYMONTHDAY && +p.BYMONTHDAY !== start.getDate()) return null;
  }

  if (p.UNTIL) {
    const u = parseIcsDate(p.UNTIL, {}, warn);
    if (u) r.until = startOfDay(u.date);
  } else if (p.COUNT) {
    r.count = Math.max(1, parseInt(p.COUNT, 10) || 1);
  }
  return r;
}

export function parseICS(text) {
  const result = { name: null, color: null, events: [], warnings: [], cancelled: 0 };
  const warned = new Set();
  const warn = (msg) => { if (!warned.has(msg)) { warned.add(msg); result.warnings.push(msg); } };

  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const raw = [];
  let cur = null, depth = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const { name, params, value } = parseLine(line);
    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VEVENT' && !cur) { cur = {}; depth = 0; }
      else if (cur) depth++; // VALARM etc. inside an event: ignore its properties
      continue;
    }
    if (name === 'END') {
      if (cur && depth > 0) depth--;
      else if (cur && value.toUpperCase() === 'VEVENT') { raw.push(cur); cur = null; }
      continue;
    }
    if (cur) {
      if (depth === 0) (cur[name] ??= []).push({ params, value });
    } else if (name === 'X-WR-CALNAME' && !result.name) {
      result.name = unescapeText(value).trim() || null;
    } else if ((name === 'X-APPLE-CALENDAR-COLOR' || name === 'COLOR') && !result.color) {
      const hex = value.trim().match(/^#([0-9a-f]{6})/i);
      if (hex) result.color = `#${hex[1].toLowerCase()}`;
    }
  }

  const masters = new Map();   // uid → event, for attaching overrides
  const overrides = [];
  for (const ve of raw) {
    const get = (k) => ve[k]?.[0];
    if (!get('DTSTART')) continue;
    if (get('STATUS')?.value.toUpperCase() === 'CANCELLED') { result.cancelled++; continue; }
    const s = parseIcsDate(get('DTSTART').value, get('DTSTART').params, warn);
    if (!s) continue;
    const title = get('SUMMARY') ? unescapeText(get('SUMMARY').value).trim() : '';
    const ev = { uid: get('UID')?.value.trim() || null, title: title || '(No title)', start: s.date };

    let end = null;
    if (get('DTEND')) end = parseIcsDate(get('DTEND').value, get('DTEND').params, warn)?.date ?? null;
    else if (get('DURATION')) {
      const ms = parseDuration(get('DURATION').value);
      if (ms != null) end = s.allDay ? addDays(s.date, Math.round(ms / DAY_MS)) : new Date(+s.date + ms);
    }
    if (s.allDay) {
      ev.allDay = true;
      ev.end = end && end > s.date ? startOfDay(end) : addDays(s.date, 1);
    } else {
      ev.end = end && end > s.date ? end : new Date(+s.date + 30 * 60000); // no end given: 30 minutes
    }
    if (get('LOCATION')?.value.trim()) ev.location = unescapeText(get('LOCATION').value).trim();
    if (get('DESCRIPTION')?.value.trim()) ev.notes = unescapeText(get('DESCRIPTION').value).trim();

    if (get('RECURRENCE-ID')) {
      const rid = parseIcsDate(get('RECURRENCE-ID').value, get('RECURRENCE-ID').params, warn);
      if (rid) { ev.uid = `${ev.uid ?? 'event'}#${ymd(rid.date)}`; overrides.push({ ev, masterUid: get('UID')?.value.trim(), date: rid.date }); }
      result.events.push(ev);
      continue;
    }

    if (get('RRULE')) {
      const repeat = mapRRule(get('RRULE').value, ev.start, warn);
      if (repeat) ev.repeat = repeat;
      else warn(`“${ev.title}” has a repeat rule this calendar can't show, so only its first date was imported.`);
    }
    if (ev.repeat && ve.EXDATE) {
      const ex = [];
      for (const { value, params } of ve.EXDATE) {
        for (const part of value.split(',')) {
          const d = parseIcsDate(part, params, warn);
          if (d) ex.push(ymd(d.date));
        }
      }
      if (ex.length) ev.exdates = [...new Set(ex)];
    }
    if (ev.uid) masters.set(ev.uid, ev);
    result.events.push(ev);
  }

  // a moved/edited occurrence replaces that date of its series
  for (const o of overrides) {
    const m = masters.get(o.masterUid);
    if (m?.repeat) m.exdates = [...new Set([...(m.exdates ?? []), ymd(o.date)])];
  }
  return result;
}

// ---------- changing part of a repeating event ----------
const dropKeys = (ev, keys) => { const x = { ...ev }; for (const k of keys) delete x[k]; return x; };

/**
 * One occurrence taken out of a repeating event: returns { series, single } where `series` skips
 * that date and `single` is a one-off copy at the occurrence's time (no id yet).
 */
export function detachOccurrence(ev, occ) {
  const day = ymd(occ.start);
  const series = { ...ev, exdates: [...new Set([...(ev.exdates ?? []), day])] };
  const single = dropKeys({ ...ev, start: occ.start, end: occ.end }, ['id', 'repeat', 'exdates', 'uid']);
  return { series, single };
}

/**
 * Split a repeating event at an occurrence ("this and following"): `head` is the original series
 * ending the day before, `tail` a new series (no id yet) starting at the occurrence. When the
 * occurrence is the first one there is no head: the whole series is "this and following".
 * A series that ends after a number of times keeps the right total across both parts.
 */
export function splitSeries(ev, occ) {
  const day = startOfDay(occ.start);
  const occDay = ymd(occ.start);
  if (+day <= +startOfDay(ev.start)) return { head: null, tail: dropKeys(ev, ['id', 'uid']) };
  const before = expandEvents([{ ...ev, id: '_', exdates: [] }], ev.start, day).filter((o) => o.start < day).length;
  const headRepeat = { ...ev.repeat };
  if (headRepeat.count) headRepeat.count = before;
  else headRepeat.until = addDays(day, -1);
  const head = { ...ev, repeat: headRepeat, exdates: (ev.exdates ?? []).filter((d) => d < occDay) };
  if (!head.exdates.length) delete head.exdates;
  const tailRepeat = { ...ev.repeat };
  if (tailRepeat.count) tailRepeat.count = Math.max(1, tailRepeat.count - before);
  const tail = dropKeys({ ...ev, start: occ.start, end: occ.end, repeat: tailRepeat, exdates: (ev.exdates ?? []).filter((d) => d >= occDay) }, ['id', 'uid']);
  if (!tail.exdates.length) delete tail.exdates;
  return { head, tail };
}

// ---------- .ics export ----------
const ICS_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const icsEscape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const icsUtc = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Fold long lines at 75 bytes, as the iCalendar format requires. */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '', len = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function rrule(ev) {
  const r = normalizeRepeat(ev.repeat, ev.start);
  if (!r) return null;
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === 'weekly') parts.push(`BYDAY=${r.byWeekday.map((d) => ICS_DAY[d]).join(',')}`);
  if (r.freq === 'monthly' && r.monthlyBy === 'nth') parts.push(`BYDAY=${weekdayPosition(ev.start).nth}${ICS_DAY[ev.start.getDay()]}`);
  if (r.freq === 'monthly' && r.monthlyBy === 'last') parts.push(`BYDAY=-1${ICS_DAY[ev.start.getDay()]}`);
  if (r.until) {
    const lastMoment = new Date(+addDays(startOfDay(r.until), 1) - 1000);
    parts.push(`UNTIL=${ev.allDay ? icsDate(r.until) : icsUtc(lastMoment)}`);
  } else if (r.count) parts.push(`COUNT=${r.count}`);
  return parts.join(';');
}

/**
 * Events as an iCalendar (.ics) file that Google, Apple and Outlook calendars can import.
 * `name` becomes the calendar's name in apps that show it.
 */
export function toICS(events, { name = 'Calendar', color } = {}) {
  const now = icsUtc(Date.now());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Famner//Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEscape(name)}`];
  if (color) lines.push(`X-APPLE-CALENDAR-COLOR:${color}`);
  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${icsEscape(ev.uid ?? `${ev.id}@home-app` /* kept from before the rename, so re-exported events match ones already imported */)}`);
    lines.push(`DTSTAMP:${now}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(ev.start)}`, `DTEND;VALUE=DATE:${icsDate(ev.end)}`);
    } else {
      lines.push(`DTSTART:${icsUtc(ev.start)}`, `DTEND:${icsUtc(ev.end)}`);
    }
    lines.push(`SUMMARY:${icsEscape(ev.title || 'Untitled')}`);
    if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
    if (ev.notes) lines.push(`DESCRIPTION:${icsEscape(ev.notes)}`);
    const rule = rrule(ev);
    if (rule) {
      lines.push(`RRULE:${rule}`);
      for (const d of ev.exdates ?? []) {
        const day = parseYmd(d);
        lines.push(ev.allDay ? `EXDATE;VALUE=DATE:${icsDate(day)}` : `EXDATE:${icsUtc(atMinute(day, minOfDay(ev.start)))}`);
      }
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
