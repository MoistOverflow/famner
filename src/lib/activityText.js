// src/lib/activityText.js — turns activity log entries into readable text (in the browser, so
// dates show in the viewer's own time zone). The person's name is shown separately.
//
// Entries from a child's private calendar carry `blur: true`: their titles and calendar names come
// back as { secret } parts, which the admin panel shows blurred until clicked. Other private
// entries have no titles at all.
import { ROLE_TEXT } from './roles.js';

export const AREAS = { calendar: 'Calendar', groceries: 'Groceries', chores: 'Chores', accounts: 'People' };

const SECRET_START = '\u0001', SECRET_END = '\u0002';
const q = (s) => `“${s}”`;
const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

function when(iso, allDay) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return allDay ? day : `${day}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function dayOnly(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const FIELD_TEXT = { title: 'title', time: 'time', calendar: 'calendar', location: 'location', notes: 'notes', repeat: 'repeat' };
const BULK_VERB = { added: 'added', changed: 'changed', deleted: 'deleted', checked: 'checked off', unchecked: 'put back' };

/** The sentence, with blurred parts wrapped in marker characters. */
function sentence(e) {
  const d = e.details ?? {};
  const hid = d.private && !d.blur;                              // no title kept at all
  const S = (s) => (d.blur && s ? `${SECRET_START}${s}${SECRET_END}` : s); // blurred when shown
  const ev = hid ? 'an event in a private calendar' : S(q(d.title || 'Untitled'));
  const cal = (name) => (d.blur ? `the private calendar ${S(name)}` : name);
  switch (e.kind) {
    case 'event.added':
      return hid ? 'added an event to a private calendar' : `added ${ev} to ${cal(d.calendar)}${d.start ? ` · ${when(d.start, d.allDay)}` : ''}`;
    case 'event.changed': {
      if (hid) return 'changed an event in a private calendar';
      const parts = [];
      if (d.fields?.includes('title') && d.from != null) parts.push(`renamed ${S(q(d.from))} to ${ev}`);
      else parts.push(`changed ${ev}`);
      if (d.fields?.includes('calendar') && d.fromCalendar) parts.push(`moved it from ${S(d.fromCalendar)} to ${S(d.calendar)}`);
      if (d.fields?.includes('time') && d.start) parts.push(`now ${when(d.start, d.allDay)}`);
      const other = (d.fields ?? []).filter((f) => !['title', 'calendar', 'time'].includes(f)).map((f) => FIELD_TEXT[f] ?? f);
      if (other.length) parts.push(`(${list(other)})`);
      return parts.join(' · ');
    }
    case 'event.skipped':
      return hid ? 'removed a date from an event in a private calendar' : `removed ${list((d.dates ?? []).map(dayOnly))} from ${ev}`;
    case 'event.deleted':
      return hid ? 'deleted an event from a private calendar' : `deleted ${ev} from ${cal(d.calendar)}`;
    case 'events.bulk': {
      const where = d.private ? 'a private calendar' : d.calendar;
      return `${BULK_VERB[d.action] ?? d.action} ${d.count} events${where ? ` in ${where}` : ''}`;
    }
    case 'calendar.added':
      if (hid) return d.subscribed ? 'subscribed to a private calendar' : 'created a private calendar';
      if (d.blur) return `created the private calendar ${S(q(d.name))}`;
      return d.subscribed ? `subscribed to the calendar ${q(d.name)}` : `created the calendar ${q(d.name)}`;
    case 'calendar.changed': {
      if (hid && !d.fields?.includes('shared')) return d.fields?.includes('made private') ? 'made a calendar private' : d.fields?.includes('people') ? 'changed who can see a private calendar' : 'changed a private calendar';
      const name = S(q(d.name));
      const bits = [];
      if (d.fields?.includes('name') && d.from) bits.push(`renamed the ${d.blur ? 'private ' : ''}calendar ${S(q(d.from))} to ${name}`);
      if (d.fields?.includes('shared')) bits.push(`shared the calendar ${name} with everyone`);
      const rest = (d.fields ?? []).filter((f) => f !== 'name' && f !== 'shared' && f !== 'made private');
      if (rest.length) bits.push(`changed the ${list(rest)} of ${name}`);
      return bits.join(' · ') || `changed the calendar ${name}`;
    }
    case 'calendar.deleted': {
      const what = hid ? 'a private calendar' : d.blur ? `the private calendar ${S(q(d.name))}` : `the calendar ${q(d.name)}`;
      const verb = d.subscribed ? 'unsubscribed from' : 'deleted';
      return `${verb} ${what}${d.events ? ` and its ${d.events} event${d.events === 1 ? '' : 's'}` : ''}`;
    }
    case 'item.added': return `added ${q(d.name)}`;
    case 'item.checked': return `checked off ${q(d.name)}`;
    case 'item.unchecked': return `put ${q(d.name)} back on the list`;
    case 'item.renamed': return `renamed ${q(d.from)} to ${q(d.name)}`;
    case 'item.changed': return `changed ${q(d.name)}`;
    case 'item.deleted': return `deleted ${q(d.name)}`;
    case 'items.bulk': return `${BULK_VERB[d.action] ?? d.action} ${d.count} items`;
    case 'chore.added':
      return `added the chore ${q(d.title)} for ${d.for}${d.points ? ` (${d.points} points)` : ''}${d.due ? ` · due ${when(d.due)}` : ''}`;
    case 'chore.changed':
      return `${d.from ? `renamed the chore ${q(d.from)} to ${q(d.title)}` : `changed the chore ${q(d.title)}`}${d.fields?.length ? ` (${list(d.fields)})` : ''}`;
    case 'chore.deleted': return `removed the chore ${q(d.title)}${d.for ? ` for ${d.for}` : ''}`;
    case 'chore.submitted': return d.for ? `marked ${d.for}’s ${q(d.title)} done${d.late ? ' (late)' : ''} for a parent to check` : `finished ${q(d.title)}${d.late ? ' (late)' : ''} and asked for a review`;
    case 'chore.unsubmitted': return d.for ? `took back “done” on ${d.for}’s ${q(d.title)}` : `took back “done” on ${q(d.title)}`;
    case 'chore.done': return `finished ${q(d.title)}${d.self ? '' : ` for ${d.for}`}${d.points ? ` · +${d.points} points` : ''}`;
    case 'chore.reviewed': {
      const base = `${d.for}’s ${q(d.title)}`;
      if (d.outcome === 'approved') return `approved ${base} · +${d.points} points`;
      if (d.outcome === 'reduced') return `gave ${d.points} of ${d.possible} points for ${base}${d.reason ? ` · “${d.reason}”` : ''}`;
      if (d.outcome === 'bonus') return `gave ${d.points} points for ${base} (${d.possible} + ${d.points - d.possible} bonus)${d.reason ? ` · “${d.reason}”` : ''}`;
      return `didn’t accept ${base}${d.reason ? ` · “${d.reason}”` : ''}`;
    }
    case 'points.adjusted':
      return `${d.delta > 0 ? `added ${d.delta}` : `took away ${-d.delta}`} point${Math.abs(d.delta) === 1 ? '' : 's'} ${d.delta > 0 ? 'to' : 'from'} ${d.for}’s total · “${d.reason}” · now ${d.balance}`;
    case 'chore.skipped': return `skipped ${d.for}’s ${q(d.title)} due ${when(d.due)}${d.reason ? ` · “${d.reason}”` : ''}`;
    case 'chore.revised': return `changed the points for ${d.for}’s ${q(d.title)} from ${d.from} to ${d.points} (worth ${d.possible})${d.reason ? ` · “${d.reason}”` : ''}`;
    case 'reward.added': return `added the reward ${q(d.name)} (${d.cost} points)`;
    case 'reward.removed': return `removed the reward ${q(d.name)}`;
    case 'reward.redeemed': return d.for ? `spent ${d.for}’s ${d.cost} points on ${q(d.name)}` : `spent ${d.cost} points on ${q(d.name)}`;
    case 'reward.given': return `gave ${d.for} ${q(d.name)}`;
    case 'reward.refunded': return d.self ? `cancelled ${q(d.name)} and got ${d.cost} points back` : `refunded ${d.for}’s ${q(d.name)} (${d.cost} points back)`;
    case 'account.added': return `added ${d.name} as ${ROLE_TEXT[d.role] ?? d.role}`;
    case 'account.renamed': return `renamed ${d.from} to ${d.name}`;
    case 'account.role': return `changed ${d.name} from ${ROLE_TEXT[d.from] ?? d.from} to ${ROLE_TEXT[d.role] ?? d.role}`;
    case 'account.reset': return `reset ${d.name}’s password`;
    case 'account.pinReset': return `cleared ${d.name}’s kiosk PIN`;
    case 'account.disabled': return `turned off ${d.name}’s account`;
    case 'account.enabled': return `turned ${d.name}’s account back on`;
    case 'account.removed': return `removed ${d.name}${d.privateCalendars ? ` and their ${d.privateCalendars} private calendar${d.privateCalendars === 1 ? '' : 's'}` : ''}`;
    default: return e.kind;
  }
}

/**
 * What happened, as parts: plain strings, and { secret } for text from a child's private
 * calendar that should be shown blurred until clicked.
 */
export function describeParts(e) {
  const parts = [];
  for (const piece of sentence(e).split(SECRET_START)) {
    const end = piece.indexOf(SECRET_END);
    if (end < 0) { if (piece) parts.push(piece); continue; }
    parts.push({ secret: piece.slice(0, end) });
    if (piece.slice(end + 1)) parts.push(piece.slice(end + 1));
  }
  return parts;
}

/** The same as plain text (blurred parts included), e.g. for searching or tests. */
export function describeActivity(e) {
  return describeParts(e).map((p) => (typeof p === 'string' ? p : p.secret)).join('');
}

/** "Today", "Yesterday", or a date, for grouping. */
export function dayHeading(ms) {
  const d = new Date(ms), now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
