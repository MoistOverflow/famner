// src/lib/choreText.js — how chores, deadlines and outcomes are described on the pages (browser).

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS = WD;

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const time = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** { text, tone } for a deadline: tone is 'late', 'soon' (today) or ''. */
export function dueLabel(ms, now = Date.now()) {
  const d = new Date(ms);
  const days = Math.round((startOfDay(d) - startOfDay(new Date(now))) / 86400000);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (ms < now) return { text: `Overdue · was due ${days === 0 ? 'today' : days === -1 ? 'yesterday' : date}, ${time(d)}`, tone: 'late' };
  if (days === 0) return { text: `Due today, ${time(d)}`, tone: 'soon' };
  if (days === 1) return { text: `Due tomorrow, ${time(d)}`, tone: '' };
  if (days < 7) return { text: `Due ${d.toLocaleDateString(undefined, { weekday: 'long' })}, ${time(d)}`, tone: '' };
  return { text: `Due ${date}, ${time(d)}`, tone: '' };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const NTH = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last' };
const UNIT = { daily: ['day', 'days'], weekly: ['week', 'weeks'], monthly: ['month', 'months'], yearly: ['year', 'years'] };

/** "Every 2 weeks on Mon, Thu", "Every month on the last Friday", "3 days after it's done, 10 times" */
export function repeatLabel(repeat) {
  if (!repeat?.freq) return '';
  const n = repeat.interval ?? 1;
  const every = (unit) => (n === 1 ? `Every ${UNIT[unit][0]}` : `Every ${n} ${UNIT[unit][1]}`);
  let text;
  if (repeat.from === 'done') {
    text = `${n} ${UNIT[repeat.freq]?.[n === 1 ? 0 : 1] ?? 'days'} after it’s done`;
  } else {
    switch (repeat.freq) {
      case 'daily': text = n === 1 ? 'Every day' : every('daily'); break;
      case 'weekdays': text = 'Every weekday'; break;
      case 'weekly': {
        const days = repeat.days ?? [];
        const list = days.length === 7 ? 'every day' : days.map((d) => (days.length > 2 ? WD_SHORT[d] : WD[d])).join(days.length > 2 ? ', ' : ' and ');
        text = n === 1 ? (days.length === 7 ? 'Every day' : `Every ${list}`) : `${every('weekly')} on ${list}`;
        break;
      }
      case 'monthly': {
        const on = repeat.monthBy === 'nth' || repeat.monthBy === 'last' ? `the ${NTH[repeat.monthBy === 'last' ? -1 : repeat.nth]} ${WD[repeat.weekday]}` : `the ${ordinal(repeat.monthDay)}`;
        text = `${every('monthly')} on ${on}`;
        break;
      }
      case 'yearly': {
        const [, m] = String(repeat.anchor ?? '').split('-').map(Number);
        text = `${every('yearly')}${m ? ` on ${MONTHS[m - 1]} ${repeat.monthDay}` : ''}`;
        break;
      }
      default: return '';
    }
  }
  if (repeat.until) {
    const [y, m, d] = repeat.until.split('-').map(Number);
    text += `, until ${new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  } else if (repeat.count) {
    const left = repeat.count - (repeat.seq ?? 1);
    text += `, ${repeat.count} times${left > 0 ? ` (${left} more after this)` : ' (this is the last)'}`;
  }
  return text;
}

/** The month-day choices for a first deadline on `d`: on day 15 / the 3rd Tuesday / the last Tuesday. */
export function monthlyOptions(d) {
  const nth = Math.ceil(d.getDate() / 7);
  const last = d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const out = [{ value: 'day', label: `On the ${ordinal(d.getDate())}` }];
  if (nth <= 4) out.push({ value: 'nth', label: `On the ${NTH[nth]} ${WD[d.getDay()]}` });
  if (last) out.push({ value: 'last', label: `On the last ${WD[d.getDay()]}` });
  return out;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** "3 hours", "2 days" */
export function duration(ms) {
  const min = Math.round(Math.abs(ms) / 60000);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

export const OUTCOME = {
  done: { label: 'Done', tone: 'good' },
  approved: { label: 'Approved', tone: 'good' },
  reduced: { label: 'Fewer points', tone: 'warn' },
  bonus: { label: 'Bonus', tone: 'good' },
  skipped: { label: 'Skipped', tone: '' },
  denied: { label: 'Not accepted', tone: 'bad' }
};

export const pointsText = (n) => `${n} point${n === 1 ? '' : 's'}`;

/** How a line in someone's points history reads, e.g. "Chore: Dishes" or "Correction: typo". */
export function pointsReason(entry) {
  switch (entry.kind) {
    case 'chore': return `Chore: ${entry.note ?? ''}`;
    case 'reward': return `Reward: ${entry.note ?? ''}`;
    case 'refund': return `Refund: ${entry.note ?? ''}`;
    case 'adjust': return `Correction: ${entry.note ?? ''}`;
    default: return entry.note ?? entry.kind;
  }
}

/** "6/10", or "+15 (10 + 5 bonus)" when more than the chore was worth was given. */
export function resultPoints(h) {
  if (h.points > h.possible) return `+${h.points} (${h.possible} + ${h.points - h.possible} bonus)`;
  return h.possible ? `${h.points}/${h.possible}` : '';
}
