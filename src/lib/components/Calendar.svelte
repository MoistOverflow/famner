<!--
  Calendar.svelte — day / week / month calendar. Svelte 5 (runes).
  Needs calendarUtils.js next to it. No other dependencies.

  Creating events
    • Click an empty time slot (or long-press on touch)  → 1-hour event
    • Drag down a column                                  → event over the dragged range
    • Click the all-day row, or an empty month cell       → all-day event
    • "+ New event"                                        → event in the shown period
  Changing events
    • Click an event to edit or delete it (repeats: delete one or all)
    • Drag an event to move it; drag its bottom edge to resize it
      (touch: long-press first). Moving a repeat moves the whole series.

  Props
    events         bindable  [{ id, calendar, title, start: Date, end: Date,
                               allDay?, location?, notes?,
                               repeat?: { freq: 'daily'|'weekly'|'monthly'|'yearly', interval?, byWeekday?: [0-6],
                                          monthlyBy?: 'day'|'nth'|'last', until?: Date, count? },
                               exdates?: ['YYYY-MM-DD'] }]   all-day `end` is exclusive (midnight after last day)
    calendars      bindable  [{ id, label, color }]
    date           bindable  any date in the period to show
    view           bindable  'day' | 'week' | 'month' (default 'week')
    user           the signed-in user ({ id, name, role }); used to mark who owns a calendar and
                   to show the "Who can see it" choice. Calendars with `private: true` are only seen by
                   their owner and the people in `sharedWith` (user ids), who can look but not change them.
    readOnly       true to only look: nothing can be added or changed
    people         [{ id, name }] everyone's names, to show who added an event
    overlay        { calendars: [{ id, label, color }], events: [...] } extra read-only items shown on the
                   calendar but never saved (e.g. chores). They can be hidden like a calendar.
    onOverlayClick(event)  called when an overlay item is clicked (e.g. go to the Chores page)

  Roles (user.role): 'admin' and 'parent' can change everything. 'child' can add events to shared
  calendars and their own, and change only events they added (`createdBy`). Children can create
  calendars of their own (and choose who sees them), but can't change shared calendars, reorder,
  import or subscribe. The server enforces the same rules.
    store          where events and calendars are saved, e.g. createServerStore() from calendarStore.js
                   (SQLite via /api/calendar, with live updates from /api/calendar/live: changes made on
                   one device appear on every other open calendar). Without it, everything is saved in
                   this browser only.
    storageKey     localStorage key (default 'svelte-calendar'; null to disable). Without a store it holds
                   everything and replaces the events/calendars props on load; with a store it only holds
                   this device's preferences (which calendars are shown, current view).
    startHour/endHour  hours sized to fill the screen and shown first (8–18); the rest of the day
                       scrolls, with "earlier/later" markers for events out of view
    hourHeight     px per hour, or 'auto' to fill the height (default 'auto')
    minHourHeight  smallest px per hour in 'auto' mode before the grid scrolls (default 32)
    fitToViewport  size the calendar to the space left below it on screen (default true)
    bottomOffset   gap in px kept below the calendar when fitting (default 16)
    snap           click/drag precision in minutes (default 15); the editor allows any minute
    weekStartsOn   0 = Sunday, 1 = Monday, … (default 0)
    theme          'light' | 'dark' (default 'dark')
    onEventClick, onEventAdd, onEventUpdate, onEventDelete (event)
    onCalendarAdd, onCalendarUpdate (calendar), onCalendarDelete (calendar, removedEvents)
    onCalendarReorder(calendars)   after the user drags calendars into a new order
    onImport({ calendar, added, updated })  after an .ics import
    corsProxy      prefix for fetching subscribed calendars through a proxy, e.g. '/api/ics?url='
                   for the SvelteKit route in src/routes/api/ics/+server.js (the address is appended
                   URL-encoded). '' fetches addresses directly from the browser.
    fetchIcs       optional async (url) => text, to fetch subscribed calendars your own way

  Subscribing: "Subscribe by URL" in the sidebar. A subscribed calendar has
    source: { url, refreshMinutes, lastSync, error } and its events are read-only; they're
    replaced from the address on every refresh (at the chosen interval while the page is open).

  Importing: "Import .ics file" in the sidebar, or drop an .ics file on the calendar.
  Events keep their iCalendar UID (`uid`), so importing the same file again updates them.
-->
<script>
  import { untrack, tick } from 'svelte';
  import {
    pad, startOfDay, addDays, startOfMonth, startOfWeek, sameDay, isWeekend, dayDiff,
    minOfDay, atMinute, ymd, parseYmd, hm, parseHm, isLong, spansDays, REPEAT_PRESETS, presetRepeat, normalizeRepeat, matchPreset,
    describeRepeat, monthlyChoices, parseICS, toICS, splitSeries, detachOccurrence,
    expandEvents, layoutTimedDay, layoutStrip, occurrencesOnDay,
    shiftEvent, deltaBetween, loadState, saveState
  } from './calendarUtils.js';

  /** Room the phone keeps at the bottom (the home bar on an iPhone, when installed full screen). */
  function safeBottom() {
    if (typeof document === 'undefined') return 0;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px)';
    document.body.append(probe);
    const px = parseFloat(getComputedStyle(probe).paddingBottom) || 0; // changes when the phone turns
    probe.remove();
    return px;
  }

  /** The first day of the week where this device is set up (0 = Sunday, 1 = Monday …). */
  function localeWeekStart() {
    try {
      const loc = new Intl.Locale(navigator.language);
      const info = loc.getWeekInfo?.() ?? loc.weekInfo;
      if (info?.firstDay) return info.firstDay % 7;
    } catch {}
    return 0;
  }

  let {
    events = $bindable([]),
    calendars = $bindable([
      { id: 'work', label: 'Work', color: '#3b82f6' },
      { id: 'home', label: 'Home', color: '#22a06b' },
      { id: 'holiday', label: 'Holidays', color: '#e5484d' }
    ]),
    date = $bindable(new Date()),
    view = $bindable('week'),
    storageKey = 'svelte-calendar',
    startHour = 8,
    endHour = 18,
    hourHeight = 'auto',
    minHourHeight = 32,
    fitToViewport = true,
    bottomOffset = 16,
    snap = 15,
    weekStartsOn = localeWeekStart(),
    theme = 'dark',
    onEventClick = () => {},
    onEventAdd = () => {},
    onEventUpdate = () => {},
    onEventDelete = () => {},
    onCalendarAdd = () => {},
    onCalendarUpdate = () => {},
    onCalendarDelete = () => {},
    onCalendarReorder = () => {},
    onImport = () => {},
    corsProxy = '',
    fetchIcs = null,
    store = null,
    user = null,
    readOnly = false,
    people = [],
    overlay = { calendars: [], events: [] },
    onOverlayClick = null,
    onUnlock = null
  } = $props();

  // ---------- saved data ----------
  // Without a store: everything is kept in this browser's localStorage.
  // With a store: events and calendars come from the server (see "server sync" below) and only
  // this device's preferences stay in the browser.
  const VIEWS = ['day', 'week', 'month'];
  const prefsKey = storageKey ? `${storageKey}:prefs` : null;
  const saved = loadState(storageKey); // with a store, only used to migrate older browser-only data
  const prefs = store ? readPrefs() : null;
  let visible = $state(prefs?.visible ?? saved?.visible ?? {});
  if (saved && !store) {
    events = saved.events;
    calendars = saved.calendars;
  }
  const savedView = store ? prefs?.view ?? saved?.view : saved?.view;
  if (VIEWS.includes(savedView)) view = savedView;
  const isOn = (calId) => visible[calId] !== false;

  function readPrefs() {
    if (!prefsKey || typeof localStorage === 'undefined') return null;
    try { return JSON.parse(localStorage.getItem(prefsKey) ?? 'null'); } catch { return null; }
  }

  $effect(() => {
    if (store) {
      const p = JSON.stringify({ visible: $state.snapshot(visible), view });
      try { if (prefsKey) localStorage.setItem(prefsKey, p); } catch {}
      return;
    }
    saveState(storageKey, {
      version: 1,
      events: $state.snapshot(events),
      calendars: $state.snapshot(calendars),
      visible: $state.snapshot(visible),
      view
    });
  });

  // ---------- formatting (the device's language and region decide date order, 12/24-hour time…) ----------
  // weekday names, Sunday first (shown in the order weekStartsOn gives)
  const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 4 + i).toLocaleDateString(undefined, { weekday: 'short' }));
  const hour12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 ?? false;
  const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtMin = (min) => fmtTime(atMinute(new Date(2000, 0, 1), min));
  /** compact times for month chips: "9a", "9:30p" (12-hour places) or "9:00", "21:30" */
  const shortTime = (d) => {
    const h = d.getHours(), m = d.getMinutes();
    return hour12 ? `${h % 12 || 12}${m ? ':' + pad(m) : ''}${h < 12 ? 'a' : 'p'}` : `${h}:${pad(m)}`;
  };
  const fmtHour = (h) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
  const fmtHead = (d) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  const monthName = (d, style = 'long') => d.toLocaleDateString(undefined, { month: style });
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  /** "October 18 – 24, 2026" in the device's own style */
  function rangeTitle(a, b) {
    const f = new Intl.DateTimeFormat(undefined, { month: a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() ? 'long' : 'short', day: 'numeric', year: 'numeric' });
    return f.formatRange ? f.formatRange(a, b) : `${f.format(a)} – ${f.format(b)}`;
  }

  const shortDate = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  /** "09:30 PM – 11:45 PM", or with dates when it crosses midnight */
  function fmtRange(start, end) {
    if (!spansDays({ start, end })) return `${fmtTime(start)} – ${fmtTime(end)}`;
    return `${shortDate(start)}, ${fmtTime(start)} – ${shortDate(end)}, ${fmtTime(end)}`;
  }

  function occTooltip(o) {
    const ev = o.event;
    const when = isLong(o) ? 'All day' : fmtRange(o.start, o.end);
    const rep = o.recurring ? describeRepeat(ev.repeat, ev.start) : '';
    return [ev.title, when, rep, ev.location].filter(Boolean).join('\n');
  }

  /** Days of a month grid (whole weeks) for the month that contains `d`. */
  function monthGrid(d) {
    const first = startOfMonth(d);
    const start = startOfWeek(first, weekStartsOn);
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const lead = dayDiff(start, first);
    const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
    return Array.from({ length: cells }, (_, i) => addDays(start, i));
  }

  // ---------- layout state ----------
  let narrow = $state(false);
  let sidebarOpen = $state(true);
  let drawerOpen = $state(false);
  const showSidebar = $derived(narrow ? drawerOpen : sidebarOpen);
  const toggleSidebar = () => (narrow ? (drawerOpen = !drawerOpen) : (sidebarOpen = !sidebarOpen));

  let now = $state(new Date());
  let miniMonth = $state(new Date());

  $effect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const update = () => { narrow = mq.matches; if (!mq.matches) drawerOpen = false; };
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  });

  $effect(() => { miniMonth = startOfMonth(date); });

  $effect(() => {
    const t = setInterval(() => (now = new Date()), 60000);
    return () => clearInterval(t);
  });

  // ---------- what's on screen ----------
  const colorOf = $derived(Object.fromEntries([...calendars, ...(overlay?.calendars ?? [])].map((c) => [c.id, c.color])));
  const weekdayHeads = $derived(Array.from({ length: 7 }, (_, i) => WEEKDAYS[(weekStartsOn + i) % 7]));

  const days = $derived(
    view === 'day'
      ? [startOfDay(date)]
      : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(date, weekStartsOn), i))
  );
  const monthCells = $derived(monthGrid(date));
  const rangeStart = $derived(view === 'month' ? monthCells[0] : days[0]);
  const rangeEnd = $derived(addDays(view === 'month' ? monthCells[monthCells.length - 1] : days[days.length - 1], 1));
  const occs = $derived(expandEvents([...events, ...(overlay?.events ?? [])], rangeStart, rangeEnd, (ev) => isOn(ev.calendar)));

  const title = $derived(
    view === 'day'
      ? date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      : view === 'month'
        ? `${monthName(date)} ${date.getFullYear()}`
        : rangeTitle(days[0], days[6])
  );

  // The grid always covers the whole day; startHour–endHour is sized to fill the screen
  // and the rest is reached by scrolling.
  const hours = Array.from({ length: 24 }, (_, i) => i);

  const timed = $derived(view === 'month' ? [] : days.map((d) => layoutTimedDay(occs, d, 0, 1440)));
  const strip = $derived(view === 'month' ? { items: [], rows: 0 } : layoutStrip(occs, days));
  // month cells, iOS-style: all-day bars keep the same row across a week (with gaps where needed),
  // then the day's timed events. Per cell: { bars: [bar | null], timed: [occ], count }
  const monthItems = $derived.by(() => {
    if (view !== 'month') return [];
    const out = [];
    for (let w = 0; w < monthCells.length / 7; w++) {
      const week = monthCells.slice(w * 7, w * 7 + 7);
      const { items } = layoutStrip(occs, week);
      for (let c = 0; c < 7; c++) {
        const bars = [];
        for (const it of items) {
          if (it.startCol > c || c > it.endCol) continue;
          bars[it.row] = { occ: it.occ, first: c === it.startCol, joinL: c > it.startCol || it.contLeft, joinR: c < it.endCol || it.contRight };
        }
        const lanes = Array.from(bars, (b) => b ?? null);
        const timedHere = occurrencesOnDay(occs, week[c]).filter((o) => !isLong(o));
        out.push({ bars: lanes, timed: timedHere, count: lanes.filter(Boolean).length + timedHere.length });
      }
    }
    return out;
  });

  // ---------- sizing ----------
  let root;
  let scrollEl = $state();
  let scrollH = $state(0);
  let monthH = $state(0);
  let rootHeight = $state(null);

  const hh = $derived(
    hourHeight === 'auto'
      ? Math.max(minHourHeight, scrollH > 0 ? scrollH / Math.max(1, endHour - startHour) : minHourHeight)
      : hourHeight
  );
  const monthRows = $derived(monthCells.length / 7);
  const maxChips = $derived(Math.max(1, Math.floor((monthH / monthRows - 31) / 20)));

  $effect(() => {
    if (!fitToViewport) { rootHeight = null; return; }
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = root.getBoundingClientRect().top + window.scrollY;
        const h = Math.max(320, Math.floor(window.innerHeight - top - bottomOffset - safeBottom()));
        if (h !== rootHeight) rootHeight = h;
      });
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      ro.disconnect();
    };
  });

  // Scroll position is remembered as a time of day. When the view or period changes it jumps:
  //   • if today is shown → to the current time, with ~1/3 of the visible hours before it
  //   • otherwise          → to startHour
  // and it stays on the same time when the hour height changes (window resize).
  let scrollTop = $state(0);
  let topMin = startHour * 60;
  let lastPeriod = '';
  let pendingJump = true;

  function jumpTarget(visibleMin) {
    const showsToday = days.some((d) => sameDay(d, new Date()));
    if (!showsToday) return startHour * 60;
    const nowM = minOfDay(new Date());
    return clamp(nowM - visibleMin / 3, 0, Math.max(0, 1440 - visibleMin));
  }

  $effect(() => {
    const period = `${view}:${+rangeStart}`;
    const h = hh;
    const visibleMin = (scrollH / h) * 60;
    if (!scrollEl) return;
    if (period !== lastPeriod) { lastPeriod = period; pendingJump = true; }
    if (pendingJump && scrollH > 0) { topMin = jumpTarget(visibleMin); pendingJump = false; }
    scrollEl.scrollTop = (topMin / 60) * h;
    scrollTop = scrollEl.scrollTop;
  });

  function onGridScroll() {
    scrollTop = scrollEl.scrollTop;
    topMin = (scrollTop / hh) * 60;
  }

  // timed events entirely above or below what's currently scrolled into view
  const offscreen = $derived.by(() => {
    const res = { above: 0, aboveAt: null, below: 0, belowAt: null };
    if (view === 'month' || !scrollH) return res;
    const topM = (scrollTop / hh) * 60;
    const botM = ((scrollTop + scrollH) / hh) * 60;
    for (const segs of timed) {
      for (const s of segs) {
        if (s.eMin <= topM + 1) { res.above++; res.aboveAt = Math.max(res.aboveAt ?? 0, s.sMin); }
        else if (s.sMin >= botM - 1) { res.below++; res.belowAt = Math.min(res.belowAt ?? 1440, s.sMin); }
      }
    }
    return res;
  });

  function scrollToMinute(min, where = 'top') {
    const y = (min / 60) * hh;
    const top = where === 'top' ? y - 12 : y - scrollH / 3;
    scrollEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  const nowMin = $derived(minOfDay(now));

  // ---------- navigation ----------
  function step(n) {
    if (view === 'day') date = addDays(date, n);
    else if (view === 'week') date = addDays(date, 7 * n);
    else {
      const t = new Date(date.getFullYear(), date.getMonth() + n, 1);
      const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
      t.setDate(Math.min(date.getDate(), last));
      date = t;
    }
  }
  const goToday = () => (date = new Date());
  function openDay(d) { date = d; view = 'day'; }
  function pickDate(d) { date = d; if (narrow) drawerOpen = false; }

  // ---------- event changes ----------
  function updateEvent(id, fn) {
    let updated;
    events = events.map((x) => (x.id === id ? (updated = fn(x)) : x));
    if (updated) onEventUpdate(updated);
  }

  /** A unique id for a new event (safe when several devices add events at the same time). */
  /** The session ended (signed out elsewhere, password reset, account turned off): go sign in. */
  function goToSignIn() {
    if (typeof location === 'undefined') return;
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }

  function newId() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
  }

  // ---------- changing one, some or all of a repeating event ----------
  /**
   * Apply `patch` to a repeating event's occurrence: 'this' takes the occurrence out of the series as
   * a one-off event, 'following' splits the series there, 'all' changes the whole series.
   * `patch(event)` returns the changed event; for 'all' it gets the series, otherwise the new part.
   */
  function applyScoped(ev, occ, scope, patch) {
    const addNew = (x) => {
      const created = { ...x, id: newId() };
      if (ev.createdBy) created.createdBy = ev.createdBy; else if (user) created.createdBy = user.id;
      events = [...events, created];
      onEventAdd(created);
      return created;
    };
    if (scope === 'this') {
      const { series, single } = detachOccurrence(ev, occ);
      updateEvent(ev.id, () => series);
      return addNew(patch(single));
    }
    if (scope === 'following') {
      const { head, tail } = splitSeries(ev, occ);
      if (head) {
        updateEvent(ev.id, () => head);
        return addNew(patch(tail));
      }
    }
    updateEvent(ev.id, patch);
  }

  // The scope question for drags and resizes of a repeating event: { label, run(scope) }
  let scopeAsk = $state(null);
  let scopeDlg;
  function askScope(label, run) {
    scopeAsk = { label, run };
    tick().then(() => scopeDlg?.showModal());
  }
  function answerScope(scope) {
    const ask = scopeAsk;
    scopeDlg?.close();
    scopeAsk = null;
    if (ask && scope) ask.run(scope);
  }

  // ---------- undo ----------
  // Each change made here records what the events and calendars it touched looked like before.
  // Undo puts those back (changes made on other devices to other things are left alone).
  let undoStack = [];
  function withUndo(label, fn, { toast: say = true } = {}) {
    const before = { events, calendars };
    const result = fn();
    const diff = (a, b, key) => {
      const am = new Map(a.map((x) => [key(x), x]));
      const bm = new Map(b.map((x) => [key(x), x]));
      const out = [];
      for (const [k, v] of am) if (bm.get(k) !== v) out.push([k, v]);
      for (const k of bm.keys()) if (!am.has(k)) out.push([k, undefined]);
      return out;
    };
    const step = {
      label,
      events: diff(before.events, events, (e) => String(e.id)),
      calendars: diff(before.calendars, calendars, (c) => c.id),
      order: before.calendars.map((c) => c.id)
    };
    if (step.events.length || step.calendars.length) {
      undoStack = [...undoStack.slice(-29), step];
      if (say) showToast(label, { label: 'Undo', run: undo });
    }
    return result;
  }

  function undo() {
    const step = undoStack.pop();
    if (!step) { showToast('Nothing to undo.'); return; }
    if (step.calendars.length) {
      const map = new Map(calendars.map((c) => [c.id, c]));
      for (const [k, v] of step.calendars) { if (v === undefined) map.delete(k); else { map.set(k, v); visible[k] ??= true; } }
      const pos = new Map(step.order.map((id, i) => [id, i]));
      const now = new Map(calendars.map((c, i) => [c.id, i]));
      calendars = [...map.values()].sort((a, b) => (pos.get(a.id) ?? 1000 + now.get(a.id)) - (pos.get(b.id) ?? 1000 + now.get(b.id)));
    }
    const calIds = new Set(calendars.map((c) => c.id));
    const map = new Map(events.map((e) => [String(e.id), e]));
    for (const [k, v] of step.events) {
      if (v === undefined) { const gone = map.get(k); map.delete(k); if (gone) onEventDelete(gone); }
      else if (calIds.has(v.calendar)) { const had = map.has(k); map.set(k, v); had ? onEventUpdate(v) : onEventAdd(v); }
    }
    events = [...map.values()];
    showToast(`Undone: ${step.label.replace(/\.$/, '')}.`);
  }

  function onUndoKey(e) {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
    const t = e.target;
    if (t?.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    if (readOnly || !undoStack.length) return;
    e.preventDefault();
    undo();
  }
  $effect(() => {
    window.addEventListener('keydown', onUndoKey);
    return () => window.removeEventListener('keydown', onUndoKey);
  });

  // ---------- exporting ----------
  function downloadIcs(list, name, color) {
    const blob = new Blob([toICS(list, { name, color })], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(name || 'calendar').replace(/[\\/:*?"<>|]+/g, '').trim() || 'calendar'}.ics`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportCalendar(cal) {
    const list = events.filter((x) => x.calendar === cal.id);
    if (!list.length) { showToast(`“${cal.label}” has no events to export.`); return; }
    downloadIcs(list, cal.label, cal.color);
  }
  function exportAll() {
    const shown = new Set(calendars.filter((c) => visible[c.id] !== false).map((c) => c.id));
    const list = events.filter((x) => shown.has(x.calendar));
    if (!list.length) { showToast('No events to export.'); return; }
    downloadIcs(list, 'Calendar');
  }

  // ---------- pointer gestures: create, move, resize ----------
  const LONG_PRESS = 450;
  const MOVE_TOL = 6;
  let draft = $state(null);  // { day, s, e } new-event preview
  let moving = $state(null); // { kind: 'timed', key, color, day, s, e } | { kind: 'resize', key, day, end } | { kind: 'days', key, dayDelta, hoverDate }
  let gesture = null;
  let suppressClick = false;
  let lastTouch = false;

  function cellAt(x, y, selector) {
    for (const el of document.elementsFromPoint(x, y)) {
      const c = el.closest(selector);
      if (c?.dataset.date) return c;
    }
    return null;
  }

  function rawMinute(col, y) {
    const r = col.getBoundingClientRect();
    return (clamp(y - r.top, 0, r.height - 1) / hh) * 60;
  }

  const snapDown = (m) => Math.floor(m / snap) * snap;
  const snapRound = (m) => Math.round(m / snap) * snap;
  const clampCreate = (m) => clamp(m, 0, 1440 - snap);

  function beginGesture(e, data) {
    endGesture();
    lastTouch = e.pointerType !== 'mouse';
    gesture = {
      ...data, id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: Date.now(),
      touch: lastTouch, armed: false, moved: false, timer: 0
    };
    window.addEventListener('pointermove', onGestureMove);
    window.addEventListener('pointerup', onGestureUp);
    window.addEventListener('pointercancel', endGesture);
    if (gesture.touch) {
      const g = gesture;
      g.timer = setTimeout(() => { if (gesture === g) arm(g); }, LONG_PRESS);
    } else {
      arm(gesture);
    }
  }

  function arm(g) {
    g.armed = true;
    if (g.touch) navigator.vibrate?.(10);
    if (g.kind === 'create') {
      const m = clampCreate(snapDown(rawMinute(g.col, g.y0)));
      g.m0 = m;
      draft = { day: g.day, s: m, e: Math.min(m + 60, 1440) };
    }
  }

  function endGesture() {
    if (!gesture) return;
    clearTimeout(gesture.timer);
    window.removeEventListener('pointermove', onGestureMove);
    window.removeEventListener('pointerup', onGestureUp);
    window.removeEventListener('pointercancel', endGesture);
    if (gesture.kind === 'create' && !dlg?.open) draft = null;
    gesture = null;
    moving = null;
  }

  function onGestureMove(e) {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    const dist = Math.hypot(e.clientX - g.x0, e.clientY - g.y0);
    if (!g.armed) { if (dist > MOVE_TOL) endGesture(); return; } // touch: it's a scroll
    if (!g.moved && dist <= MOVE_TOL) return;

    if (g.kind === 'create') {
      const m = clampCreate(snapDown(rawMinute(g.col, e.clientY)));
      if (m !== g.m0) g.moved = true;
      if (g.moved) draft = { day: g.day, s: Math.min(m, g.m0), e: Math.min(Math.max(m, g.m0) + snap, 1440) };
      return;
    }

    g.moved = true;
    if (g.kind === 'move') {
      const col = cellAt(e.clientX, e.clientY, '.day-col');
      if (!col) return;
      const delta = snapRound(rawMinute(col, e.clientY) - g.raw0);
      const s = clamp(g.origS + delta, snap - g.dur, 1440 - snap);
      moving = { kind: 'timed', key: g.occ.key, color: colorOf[g.occ.event.calendar], day: parseYmd(col.dataset.date), s, e: s + g.dur };
    } else if (g.kind === 'resize') {
      const delta = snapRound(rawMinute(g.col, e.clientY) - g.raw0);
      const end = clamp(g.origE + delta, g.segS + snap, 1440);
      moving = { kind: 'resize', key: g.occ.key, day: g.day, end };
    } else if (g.kind === 'days') {
      const cell = cellAt(e.clientX, e.clientY, '[data-date]');
      if (!cell) return;
      const day = parseYmd(cell.dataset.date);
      moving = { kind: 'days', key: g.occ.key, dayDelta: dayDiff(g.fromDay, day), hoverDate: cell.dataset.date };
    }
  }

  function onGestureUp(e) {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    const mv = moving;
    const d = draft;
    if (g.kind === 'create') {
      clearTimeout(g.timer);
      window.removeEventListener('pointermove', onGestureMove);
      window.removeEventListener('pointerup', onGestureUp);
      window.removeEventListener('pointercancel', endGesture);
      gesture = null;
      if (g.armed && d) return openNewTimed(g.day, d.s, d.e);
      if (!g.armed && Date.now() - g.t0 < LONG_PRESS) {
        const m = clampCreate(snapDown(rawMinute(g.col, g.y0)));
        return openNewTimed(g.day, m, Math.min(m + 60, 1440));
      }
      draft = null;
      return;
    }

    endGesture();
    if (!g.armed) return;                  // touch tap → the click opens the editor
    if (!g.moved) { if (g.touch) blockNextClick(); return; }
    blockNextClick();
    if (!mv) return;
    const ev = g.occ.event;
    const occ = g.occ;
    let patch = null, label = 'Event moved.';
    if (mv.kind === 'timed') {
      const { dayDelta, minDelta } = deltaBetween(occ.start, atMinute(mv.day, mv.s));
      if (dayDelta || minDelta) patch = (x) => shiftEvent(x, dayDelta, minDelta);
    } else if (mv.kind === 'resize') {
      const diff = +atMinute(mv.day, mv.end) - +occ.end;
      if (diff) { patch = (x) => ({ ...x, end: new Date(+x.end + diff) }); label = 'Event resized.'; }
    } else if (mv.kind === 'days' && mv.dayDelta) {
      const dd = mv.dayDelta;
      patch = (x) => shiftEvent(x, dd, 0);
    }
    if (!patch) return;
    const live = events.find((x) => x.id === ev.id) ?? ev;
    if (occ.recurring && live.repeat) {
      askScope(mv.kind === 'resize' ? 'Change the length of' : 'Move', (scope) => withUndo(label, () => applyScoped(live, occ, scope, patch)));
    } else {
      withUndo(label, () => updateEvent(ev.id, patch));
    }
  }

  function blockNextClick() {
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
  }

  function onColPointerDown(e, day) {
    if (!addableCalendars.length) return;
    if (e.target.closest('.event')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'mouse') e.preventDefault();
    beginGesture(e, { kind: 'create', col: e.currentTarget, day });
  }

  function onSegmentPointerDown(e, seg, day) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!canEditEvent(seg.occ.event)) return; // subscribed, or someone else's (children): click to view only
    e.stopPropagation();
    if (e.pointerType === 'mouse') e.preventDefault();
    const col = e.currentTarget.closest('.day-col');
    const resize = !!e.target.closest('.resize-handle');
    const origS = dayDiff(day, seg.occ.start) * 1440 + minOfDay(seg.occ.start); // on the clock, like the grid
    beginGesture(e, {
      kind: resize ? 'resize' : 'move',
      occ: seg.occ, day, col,
      raw0: rawMinute(col, e.clientY),
      origS,
      origE: seg.eMin,
      segS: seg.sMin,
      dur: (seg.occ.end - seg.occ.start) / 60000
    });
  }

  function onDayItemPointerDown(e, occ) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!canEditEvent(occ.event)) return;
    e.stopPropagation();
    if (e.pointerType === 'mouse') e.preventDefault();
    const cell = cellAt(e.clientX, e.clientY, '[data-date]');
    if (!cell) return;
    beginGesture(e, { kind: 'days', occ, fromDay: parseYmd(cell.dataset.date) });
  }

  function onOccClick(occ) {
    if (suppressClick) { suppressClick = false; return; }
    openEdit(occ);
  }

  // stop the page scrolling while a touch drag is in progress
  $effect(() => {
    const block = (e) => { if (gesture?.armed && gesture.touch) e.preventDefault(); };
    root.addEventListener('touchmove', block, { passive: false });
    return () => root.removeEventListener('touchmove', block);
  });

  // ---------- event editor ----------
  let dlg = $state();
  let form = $state(blankForm());
  let error = $state('');

  function blankForm() {
    return {
      id: null, occ: null, title: '', calendar: '', allDay: false,
      startDate: '', startTime: '09:00', endDate: '', endTime: '10:00',
      repeat: 'none', location: '', notes: '',
      // custom repeat
      rFreq: 'weekly', rInterval: 1, rDays: [], rMonthly: 'day',
      rEnds: 'never', rUntil: '', rCount: 10
    };
  }

  // ---------- repeat options in the editor ----------
  const WD_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const formStart = $derived(form.startDate ? parseYmd(form.startDate) : startOfDay(new Date()));
  const weekdayOrder = $derived(Array.from({ length: 7 }, (_, i) => (weekStartsOn + i) % 7));

  /** Editor fields for an existing repeat rule (or defaults). */
  function repeatFields(r, start) {
    const n = normalizeRepeat(r, start);
    return {
      repeat: matchPreset(r, start),
      rFreq: n?.freq ?? 'weekly',
      rInterval: n?.interval ?? 1,
      rDays: n?.byWeekday ?? [start.getDay()],
      rMonthly: n?.monthlyBy ?? 'day',
      rEnds: n?.until ? 'on' : n?.count ? 'after' : 'never',
      rUntil: n?.until ? ymd(n.until) : '',
      rCount: n?.count ?? 10
    };
  }

  function onRepeatSelect(e) {
    const next = e.currentTarget.value;
    if (next === 'custom' && form.repeat !== 'custom') {
      // start the custom panel from whatever was picked before
      const base = form.repeat === 'none' ? { freq: 'weekly' } : presetRepeat(form.repeat, formStart);
      const f = repeatFields(base, formStart);
      form.rFreq = f.rFreq; form.rInterval = f.rInterval; form.rDays = f.rDays; form.rMonthly = f.rMonthly;
    }
    form.repeat = next;
  }

  function toggleDay(wd) {
    form.rDays = form.rDays.includes(wd) ? form.rDays.filter((d) => d !== wd) : [...form.rDays, wd];
  }

  /** The repeat rule the editor describes: { repeat } or { error }. */
  function repeatFromForm(start) {
    if (form.repeat === 'none') return {};
    let r;
    if (form.repeat === 'custom') {
      const n = Number(form.rInterval);
      if (!Number.isInteger(n) || n < 1 || n > 999) return { error: '“Every” must be a whole number from 1 to 999.' };
      r = { freq: form.rFreq, interval: n };
      if (form.rFreq === 'weekly') {
        if (!form.rDays.length) return { error: 'Pick at least one day of the week.' };
        r.byWeekday = [...form.rDays].sort((a, b) => a - b);
      }
      if (form.rFreq === 'monthly') {
        r.monthlyBy = monthlyChoices(start).some((c) => c.value === form.rMonthly) ? form.rMonthly : 'day';
      }
    } else {
      r = presetRepeat(form.repeat, start);
    }
    if (form.rEnds === 'on') {
      if (!form.rUntil) return { error: 'Pick the date the repeat ends.' };
      r.until = parseYmd(form.rUntil);
      if (r.until < startOfDay(start)) return { error: 'The repeat end date is before the event starts.' };
    } else if (form.rEnds === 'after') {
      const c = Number(form.rCount);
      if (!Number.isInteger(c) || c < 1 || c > 999) return { error: 'The number of times must be a whole number from 1 to 999.' };
      r.count = c;
    }
    return { repeat: r };
  }

  const repeatSummary = $derived.by(() => {
    const res = repeatFromForm(formStart);
    return res.repeat ? describeRepeat(res.repeat, formStart) : '';
  });

  function defaultCalendar() {
    const editable = addableCalendars;
    return editable.find((c) => isOn(c.id))?.id ?? editable[0]?.id ?? calendars[0]?.id ?? '';
  }

  function openNew(start, end, allDay = false) {
    if (!addableCalendars.length) return;
    if (store && syncState !== 'ready') return; // wait for the server's data
    form = {
      ...blankForm(),
      calendar: defaultCalendar(),
      allDay,
      startDate: ymd(start),
      endDate: ymd(allDay ? addDays(end, -1) : end),
      startTime: allDay ? '09:00' : hm(minOfDay(start)),
      endTime: allDay ? '10:00' : hm(minOfDay(end))
    };
    error = '';
    dlg.showModal();
  }

  function openNewTimed(day, s, e) {
    draft = { day, s, e };
    openNew(atMinute(day, s), atMinute(day, e));
  }

  function openNewAllDay(day) {
    draft = null;
    openNew(startOfDay(day), addDays(startOfDay(day), 1), true);
  }

  function openNewFromToolbar() {
    const shown = view === 'month' ? null : days.find((d) => sameDay(d, now));
    const day = shown ?? (view === 'month' && sameDay(startOfMonth(now), startOfMonth(date)) ? now : date);
    const h = clamp(now.getHours() + 1, startHour, endHour - 1);
    draft = null;
    openNew(atMinute(day, h * 60), atMinute(day, (h + 1) * 60));
  }

  function openEdit(occ) {
    const ev = occ.event;
    if (overlay?.calendars?.some((c) => c.id === ev.calendar)) { onOverlayClick?.(ev); return; } // e.g. a chore
    onEventClick(ev);
    draft = null;
    form = {
      id: ev.id,
      occ,
      title: ev.title ?? '',
      calendar: ev.calendar,
      allDay: !!ev.allDay,
      startDate: ymd(occ.start),
      endDate: ymd(ev.allDay ? addDays(occ.end, -1) : occ.end),
      startTime: ev.allDay ? '09:00' : hm(minOfDay(occ.start)),
      endTime: ev.allDay ? '10:00' : hm(minOfDay(occ.end)),
      ...repeatFields(ev.repeat, occ.start),
      location: ev.location ?? '',
      notes: ev.notes ?? '',
      scope: 'all'
    };
    error = '';
    dlg.showModal();
  }

  const formReadOnly = $derived(form.id != null && !canEditEvent(form.occ?.event));

  function save(e) {
    e.preventDefault();
    if (formReadOnly) return;
    // the kiosk saves as whoever is unlocked; locked (or it locked itself meanwhile): ask first
    if (isKiosk && !user?.id) {
      onUnlock?.(form.id != null ? form.occ?.event.createdBy : null).then((ok) => { if (ok) save(e); });
      return;
    }
    if (form.id != null && !events.some((x) => x.id === form.id)) {
      error = 'This event was deleted on another device.';
      return;
    }
    const titleText = form.title.trim();
    if (!titleText) { error = 'Give the event a title.'; return; }
    if (!form.startDate || !form.endDate || (!form.allDay && (!form.startTime || !form.endTime))) {
      error = 'Fill in the dates and times.'; return;
    }

    let start, end;
    if (form.allDay) {
      start = parseYmd(form.startDate);
      end = addDays(parseYmd(form.endDate), 1);
      if (end <= start) { error = "The end date can't be before the start date."; return; }
    } else {
      start = atMinute(parseYmd(form.startDate), parseHm(form.startTime));
      end = atMinute(parseYmd(form.endDate), parseHm(form.endTime));
      if (end <= start) { error = 'The end must be after the start.'; return; }
    }

    const rr = repeatFromForm(start);
    if (rr.error) { error = rr.error; return; }
    const repeat = rr.repeat;

    const fields = { title: titleText, calendar: form.calendar, allDay: form.allDay || undefined };
    if (form.location.trim()) fields.location = form.location.trim();
    if (form.notes.trim()) fields.notes = form.notes.trim();
    if (repeat) fields.repeat = repeat;

    // the whole series moves the way the edited occurrence moved
    const moveSeries = (old, occ, rep) => {
      const next = { ...old, ...fields };
      // keep any extra fields the app stores on events; drop the ones the user cleared
      for (const k of ['allDay', 'location', 'notes', 'repeat']) if (fields[k] === undefined) delete next[k];
      if (rep !== undefined) { if (rep) next.repeat = rep; else delete next.repeat; }
      delete next.exdates;
      if (occ?.recurring && next.repeat) {
        const { dayDelta, minDelta } = deltaBetween(occ.start, start);
        const shifted = shiftEvent(old, dayDelta, minDelta);
        next.start = shifted.start;
        next.end = form.allDay ? addDays(shifted.start, dayDiff(start, end)) : new Date(+shifted.start + (end - start));
        if (shifted.exdates?.length) next.exdates = shifted.exdates;
      } else {
        next.start = start;
        next.end = end;
      }
      return next;
    };

    if (form.id == null) {
      const ev = { id: newId(), ...fields, start, end };
      if (user) ev.createdBy = user.id;
      if (!ev.allDay) delete ev.allDay;
      withUndo('Event added.', () => { events = [...events, ev]; }, { toast: false });
      onEventAdd(ev);
    } else {
      const occ = form.occ;
      const old = events.find((x) => x.id === form.id);
      const scope = occ?.recurring && old.repeat ? form.scope : 'all';
      withUndo('Event saved.', () => {
        if (scope === 'this') {
          applyScoped(old, occ, 'this', (single) => moveSeries(single, null, null));
        } else if (scope === 'following') {
          // an unchanged repeat rule keeps the part's own count; a changed one applies as set
          const same = JSON.stringify(normalizeRepeat(repeat, start)) === JSON.stringify(normalizeRepeat(old.repeat, start));
          applyScoped(old, occ, 'following', (tail) => {
            const tailOcc = { ...occ, start: tail.start, end: tail.end, recurring: true };
            return moveSeries(tail, tailOcc, same ? tail.repeat : repeat ?? null);
          });
        } else {
          updateEvent(form.id, (o) => {
            const next = moveSeries(o, occ);
            if (!(occ?.recurring && repeat) && repeat && o.repeat && o.exdates?.length) next.exdates = o.exdates;
            return next;
          });
        }
      }, { toast: false });
    }

    visible[form.calendar] = true;
    if (start >= rangeEnd || end <= rangeStart) date = start;
    dlg.close();
  }

  function deleteEvent() {
    const ev = events.find((x) => x.id === form.id);
    if (!ev) return;
    withUndo(ev.repeat ? 'Repeating event deleted.' : 'Event deleted.', () => { events = events.filter((x) => x.id !== form.id); });
    onEventDelete(ev);
    dlg.close();
  }

  function deleteOccurrence() {
    const key = ymd(form.occ.start);
    withUndo('Event deleted.', () => updateEvent(form.id, (x) => ({ ...x, exdates: [...new Set([...(x.exdates ?? []), key])] })));
    dlg.close();
  }

  /** Delete this occurrence and every later one (the series ends the day before). */
  function deleteFollowing() {
    const ev = events.find((x) => x.id === form.id);
    if (!ev) return;
    const { head } = splitSeries(ev, form.occ);
    if (!head) return deleteEvent();
    withUndo('Later repeats deleted.', () => updateEvent(ev.id, () => head));
    dlg.close();
  }

  // ---------- calendars ----------
  const PALETTE = ['#8b5cf6', '#f59e0b', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#6366f1', '#a855f7', '#0ea5e9'];
  let calForm = $state(null); // { mode: 'add' | 'edit', id, label, color, confirm }
  let calError = $state('');

  function nextColor() {
    const used = new Set(calendars.map((c) => c.color.toLowerCase()));
    return PALETTE.find((p) => !used.has(p)) ?? PALETTE[calendars.length % PALETTE.length];
  }

  /** May the signed-in user choose who sees this calendar? (Its creator; admins for older ones without one.) */
  const canSetPrivate = (c) => !!user?.id && !isKiosk && !readOnly && (!c || (c.owner ? c.owner === user.id : user.role === 'admin'));
  const isMine = (c) => !!user && c?.owner === user.id;
  /** Everyone the calendar could be shared with (not the user). */
  const shareChoices = $derived(people.filter((p) => p.id !== user?.id));
  /** "Only you", "You, Mom and Dad", "Mom’s · shared with you" */
  function whoSees(c) {
    if (!c?.private) return 'Everyone';
    const names = (c.sharedWith ?? []).map((id) => (id === user?.id ? 'you' : personName(id))).filter(Boolean);
    if (sharedWithMe(c)) return `${personName(c.owner) ?? 'Someone'}’s calendar, shared with ${names.length > 1 ? `you and ${names.length - 1} other${names.length === 2 ? '' : 's'}` : 'you'} (view only)`;
    if (!names.length) return 'Only you';
    return `You and ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
  }
  const visibilityFields = (c) => ({ who: c?.private ? 'some' : (c ? 'everyone' : isChild ? 'some' : 'everyone'), sharedWith: [...(c?.sharedWith ?? [])] });
  /** The calendar's visibility from the form: { private, sharedWith } or {} for everyone. */
  const visibilityFrom = (f) => (f.who === 'some' ? { private: true, sharedWith: f.sharedWith.filter((id) => people.some((p) => p.id === id)) } : {});
  const toggleShare = (id) => {
    calForm.sharedWith = calForm.sharedWith.includes(id) ? calForm.sharedWith.filter((x) => x !== id) : [...calForm.sharedWith, id];
  };

  function startAddCalendar() {
    calForm = { mode: 'add', id: null, label: '', color: nextColor(), confirm: false, ...visibilityFields(null) };
    calError = '';
  }

  function startEditCalendar(c) {
    calForm = {
      mode: 'edit', id: c.id, label: c.label, color: c.color, confirm: false, ...visibilityFields(c),
      isSub: !!c.source, url: c.source?.url ?? '', refresh: c.source?.refreshMinutes ?? 60
    };
    calError = '';
  }

  function startSubscribe() {
    calForm = { mode: 'subscribe', id: null, label: '', color: nextColor(), confirm: false, url: '', refresh: 60, busy: false, ...visibilityFields(null), who: 'everyone' };
    calError = '';
  }

  function createCalendar(label, color, source = null, vis = {}) {
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'calendar';
    let id = base, n = 2;
    // ids are shared by the whole household; another person's private calendar may already use one
    while (calendars.some((c) => c.id === id)) id = `${base}-${n++}`;
    if (store) id = `${id}-${newId().slice(0, 6)}`;
    const cal = { id, label, color };
    if (source) cal.source = source;
    if (user) cal.owner = user.id;
    if (vis === true) vis = { private: true }; // older callers: private to the owner
    if (vis?.private && user) {
      cal.private = true;
      const others = (vis.sharedWith ?? []).filter((id) => id !== user.id);
      if (others.length) cal.sharedWith = others;
    }
    calendars = [...calendars, cal];
    visible[id] = true;
    onCalendarAdd(cal);
    return cal;
  }

  const labelTaken = (label, exceptId = null) =>
    calendars.some((c) => c.id !== exceptId && c.label.toLowerCase() === label.toLowerCase());

  function uniqueLabel(label) {
    let name = label, n = 2;
    while (labelTaken(name)) name = `${label} (${n++})`;
    return name;
  }

  async function saveCalendar(e) {
    e.preventDefault();
    const f = calForm;
    if (f.busy) return;
    const label = f.label.trim();
    const isSub = f.mode === 'subscribe' || f.isSub;
    if (!label && f.mode !== 'subscribe') { calError = 'Enter a name.'; return; }
    if (label && labelTaken(label, f.id)) { calError = 'A calendar with that name already exists.'; return; }
    const url = isSub ? normalizeUrl(f.url) : null;
    if (isSub && !url) { calError = 'Enter the calendar’s web address (starting with https:// or webcal://).'; return; }
    if (isSub && /^https?:\/\/(www\.)?icloud\.com\/(calendar|calendars)\b/i.test(url)) {
      calError = 'That’s an iCloud sharing invitation, not a calendar feed. On the iPhone, turn on Public Calendar for this calendar and copy that link instead (it starts with webcal://).';
      return;
    }

    if (f.mode === 'add') {
      createCalendar(label, f.color, null, visibilityFrom(f));
    } else if (f.mode === 'subscribe') {
      f.busy = true;
      calError = '';
      try {
        const parsed = await fetchCalendar(url);
        let host = 'Subscribed calendar';
        try { host = new URL(url).hostname; } catch {}
        const cal = createCalendar(uniqueLabel(label || parsed.name || host), f.color, {
          url, refreshMinutes: Number(f.refresh), lastSync: Date.now(), error: null
        }, visibilityFrom(f));
        const list = replaceCalendarEvents(cal.id, parsed.events);
        if (calForm === f) calForm = null;
        showToast(`Subscribed to “${cal.label}”: ${plural(list.length, 'event')}.`);
      } catch (err) {
        if (calForm === f) { f.busy = false; calError = err.message; }
      }
      return;
    } else {
      let updated, urlChanged = false;
      calendars = calendars.map((c) => {
        if (c.id !== f.id) return c;
        updated = { ...c, label, color: f.color };
        if (canSetPrivate(c)) {
          const v = visibilityFrom(f);
          delete updated.private;
          delete updated.sharedWith;
          if (v.private) {
            updated.private = true;
            updated.owner ??= user.id;
            const others = v.sharedWith.filter((id) => id !== updated.owner);
            if (others.length) updated.sharedWith = others;
          }
        }
        if (c.source) {
          urlChanged = url !== c.source.url;
          updated.source = { ...c.source, url, refreshMinutes: Number(f.refresh) };
        }
        return updated;
      });
      if (updated) onCalendarUpdate(updated);
      if (urlChanged) syncCalendar(f.id);
    }
    calForm = null;
  }

  function deleteCalendar() {
    const cal = calendars.find((c) => c.id === calForm.id);
    if (!cal || (!cal.source && editableCount <= 1)) return;
    const removed = events.filter((x) => x.calendar === cal.id);
    withUndo(cal.source ? `Unsubscribed from “${cal.label}”.` : `Deleted “${cal.label}”.`, () => {
      events = events.filter((x) => x.calendar !== cal.id);
      calendars = calendars.filter((c) => c.id !== cal.id);
    });
    delete visible[cal.id];
    onCalendarDelete(cal, removed);
    calForm = null;
  }

  const eventCount = (calId) => events.filter((x) => x.calendar === calId).length;

  // ---------- reordering calendars ----------
  // Drag a calendar's handle (mouse or touch), or focus it and press ↑/↓. The order is saved like any
  // other change (each calendar's position), so it also updates on other devices.
  let calListEl;
  let calDrag = $state(null); // { id, over } while dragging: `over` is the index it would drop at

  const shownCalendars = $derived.by(() => {
    if (!calDrag) return calendars;
    const dragged = calendars.find((c) => c.id === calDrag.id);
    if (!dragged) return calendars;
    const rest = calendars.filter((c) => c.id !== calDrag.id);
    rest.splice(calDrag.over, 0, dragged);
    return rest;
  });

  function moveCalendar(id, to) {
    const from = calendars.findIndex((c) => c.id === id);
    if (from < 0) return;
    const target = clamp(to, 0, calendars.length - 1);
    if (target === from) return;
    const next = calendars.filter((c) => c.id !== id);
    next.splice(target, 0, calendars[from]);
    calendars = next;
    onCalendarReorder(next);
  }

  function onGripPointerDown(e, id) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    calDrag = { id, over: calendars.findIndex((c) => c.id === id) };

    const onMove = (ev) => {
      if (!calDrag) return;
      // the drop index is where the pointer sits among the other rows
      const rows = [...calListEl.querySelectorAll('[data-cal-row]')].filter((r) => r.dataset.calRow !== id);
      let over = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { over = i; break; }
      }
      if (over !== calDrag.over) calDrag = { ...calDrag, over };
    };
    const finish = (commit) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      const d = calDrag;
      calDrag = null;
      if (commit && d) moveCalendar(d.id, d.over);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev) => { if (ev.key === 'Escape') finish(false); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
  }

  async function onGripKey(e, id) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const from = calendars.findIndex((c) => c.id === id);
    moveCalendar(id, from + (e.key === 'ArrowUp' ? -1 : 1));
    await tick();
    calListEl?.querySelector(`[data-grip="${CSS.escape(id)}"]`)?.focus(); // moving the row can drop focus
  }
  const editableCount = $derived(calendars.filter((c) => !c.source).length);
  /** Someone else's private calendar that's shared with this user: look, don't change. */
  const sharedWithMe = (c) => !!c?.private && !!c.owner && c.owner !== user?.id;
  const readOnlyCals = $derived(new Set([
    ...calendars.filter((c) => c.source || sharedWithMe(c)).map((c) => c.id),
    ...(overlay?.calendars ?? []).map((c) => c.id)
  ]));
  const isReadOnly = (calId) => readOnly || readOnlyCals.has(calId);
  const isChild = $derived(user?.role === 'child');
  /** The shared tablet: `user` is whoever it's unlocked as (id null when locked). Their own events, in shared calendars. */
  const isKiosk = $derived(user?.role === 'kiosk');
  const limited = $derived(isChild || isKiosk);
  /** Adding, renaming, reordering, importing and subscribing to calendars. */
  const canManage = $derived(!readOnly && !limited);
  /** Children may edit (rename, recolor, delete) only their own calendars; nobody edits a calendar only shared with them. */
  const canEditCalendar = (c) => !sharedWithMe(c) && (canManage || (!readOnly && isChild && !!user && c.owner === user.id));
  /** Calendars new events can go in (not subscribed ones). */
  const addableCalendars = $derived(readOnly ? [] : calendars.filter((c) => !c.source && !sharedWithMe(c)));
  /** May the signed-in user change or delete this event? */
  const canEditEvent = (ev) =>
    !!ev && !isReadOnly(ev.calendar) && (!limited || (!!user?.id && ev.createdBy === user.id));
  /** On the kiosk: an event its creator could change after entering their PIN. */
  const kioskCanUnlock = (ev) => {
    if (!isKiosk || !onUnlock || !ev?.createdBy || ev.createdBy === user?.id || !personName(ev.createdBy)) return false;
    const c = calendars.find((x) => x.id === ev.calendar);
    if (!c || c.source || overlay?.calendars?.some((o) => o.id === c.id)) return false;
    return !c.private || c.owner === ev.createdBy; // in a private calendar, only its owner changes things
  };
  const personName = (id) => people.find((p) => p.id === id)?.name ?? null;

  // ---------- subscriptions ----------
  const REFRESH_CHOICES = [[15, 'Every 15 minutes'], [60, 'Every hour'], [360, 'Every 6 hours'], [1440, 'Every day']];
  let syncing = $state({});

  function normalizeUrl(raw) {
    const v = String(raw ?? '').trim().replace(/^webcals?:\/\//i, 'https://');
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch {
      return null;
    }
  }

  async function defaultFetchIcs(url) {
    let res;
    try {
      res = await fetch(corsProxy ? corsProxy + encodeURIComponent(url) : url, { cache: 'no-store' });
    } catch {
      throw new Error(corsProxy
        ? 'Couldn’t reach the calendar proxy at ' + corsProxy
        : 'Couldn’t download it. Most calendar sites don’t let web pages read their files directly; set corsProxy to "/api/ics?url=" to fetch through your SvelteKit server.');
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 160).trim();
      throw new Error(body && corsProxy ? body : `The calendar server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}. Check the address.`);
    }
    return res.text();
  }

  async function fetchCalendar(url) {
    const text = await (fetchIcs ?? defaultFetchIcs)(url);
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That address didn’t return a calendar (.ics) file.');
    return parseICS(text);
  }

  /**
   * Replace a calendar's events, keeping each event's id when its UID is unchanged. New events get
   * an id made from the calendar and UID, so every device refreshing the same feed agrees on it.
   */
  function replaceCalendarEvents(calId, list) {
    const oldIds = new Map(events.filter((x) => x.calendar === calId && x.uid).map((x) => [x.uid, x.id]));
    const used = new Set();
    const fresh = list.map((p) => {
      const ev = { ...p, calendar: calId };
      if (!ev.uid) delete ev.uid;
      let id = (ev.uid && oldIds.get(ev.uid)) ?? (ev.uid ? `${calId}:${ev.uid}` : newId());
      if (used.has(String(id))) id = newId(); // duplicate UID in the feed
      used.add(String(id));
      ev.id = id;
      return ev;
    });
    events = [...events.filter((x) => x.calendar !== calId), ...fresh];
    return fresh;
  }

  function setSource(calId, patch) {
    calendars = calendars.map((c) => (c.id === calId && c.source ? { ...c, source: { ...c.source, ...patch } } : c));
  }

  async function syncCalendar(calId, quiet = false) {
    if (!canManage) return; // only parents refresh subscriptions (children can't save calendar changes)
    const cal = calendars.find((c) => c.id === calId);
    if (!cal?.source || syncing[calId]) return;
    syncing[calId] = true;
    try {
      const parsed = await fetchCalendar(cal.source.url);
      if (!calendars.some((c) => c.id === calId)) return; // unsubscribed meanwhile
      const list = replaceCalendarEvents(calId, parsed.events);
      setSource(calId, { lastSync: Date.now(), lastTry: Date.now(), error: null });
      if (!quiet) showToast(`Refreshed “${cal.label}”: ${plural(list.length, 'event')}.`);
    } catch (err) {
      setSource(calId, { lastTry: Date.now(), error: err.message });
      if (!quiet) showToast(`Couldn’t refresh “${cal.label}”. ${err.message}`);
    } finally {
      delete syncing[calId];
    }
  }

  // refresh subscriptions when they're due (checked every minute while the page is open)
  function refreshDueSubscriptions() {
    untrack(() => {
      if (store && syncState !== 'ready') return; // wait until the server's data has loaded
      for (const c of calendars) {
        if (!c.source || syncing[c.id]) continue;
        const last = Math.max(c.source.lastSync ?? 0, c.source.lastTry ?? 0);
        if (Date.now() - last >= (c.source.refreshMinutes ?? 60) * 60000) syncCalendar(c.id, true);
      }
    });
  }

  $effect(() => {
    refreshDueSubscriptions();
    const t = setInterval(refreshDueSubscriptions, 60000);
    return () => clearInterval(t);
  });

  // ---------- server sync (only when a `store` is given) ----------
  // The browser remembers, as JSON, what the server has for every event and calendar. After each
  // change it sends only the differences (debounced), retrying with backoff if the server is
  // unreachable. Changes saved by other devices arrive on the live stream and are merged in place;
  // every change has a revision number, and if one is missed (dropped connection, sleeping phone)
  // the calendar saves its own edits and reloads everything.
  let syncState = $state(store ? 'loading' : 'off');                 // 'loading' | 'load-error' | 'ready' | 'off'
  let saveStatus = $state('idle');                                    // 'idle' | 'saving' | 'error'
  let saveError = $state('');
  let liveState = $state(store?.subscribe ? 'connecting' : 'off');    // 'connecting' | 'live' | 'offline' | 'off'
  let serverHas = { events: new Map(), calendars: new Map() };
  let saveTimer = 0, retryTimer = 0, retryDelay = 2000;
  let inflight = null, saveAgain = false, dirty = false, lastLoad = 0, migrating = false;
  let lastRev = 0, loading = false, liveBuffer = [], resyncing = false;

  const toJson = (x) => JSON.stringify(x);
  const calRecord = (c, i) => ({ ...c, position: i });

  function rememberServer(evs, cals) {
    serverHas = {
      events: new Map(evs.map((e) => [String(e.id), toJson(e)])),
      calendars: new Map(cals.map((c, i) => [c.id, toJson(calRecord(c, i))]))
    };
  }

  async function loadFromServer(initial = false) {
    if (initial) syncState = 'loading';
    loading = true;
    try {
      const data = await store.load();
      lastLoad = Date.now();
      lastRev = data?.rev ?? 0;
      if (!data?.calendars?.length) {
        // first run: the database is empty. Upload what this browser has (older saved data, or the defaults).
        if (saved?.calendars?.length) {
          calendars = saved.calendars;
          events = saved.events;
          migrating = true;
        }
        rememberServer([], []);
        syncState = 'ready';
        scheduleSave(0);
      } else {
        rememberServer(data.events, data.calendars);
        calendars = data.calendars;
        events = data.events;
        syncState = 'ready';
      }
      loading = false;
      // live changes that arrived while loading (ones already in the loaded data are skipped by revision)
      const buffered = liveBuffer.sort((a, b) => a.rev - b.rev);
      liveBuffer = [];
      for (const m of buffered) applyLive(m);
      refreshDueSubscriptions();
    } catch (err) {
      if (err.status === 401) { goToSignIn(); return; }
      console.warn('Calendar: could not load from the server', err);
      if (initial || syncState !== 'ready') { syncState = 'load-error'; saveError = err.message; }
    } finally {
      loading = false;
    }
  }

  function scheduleSave(delay = 400) {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushChanges, delay);
  }

  /** What changed since the server last confirmed a save. */
  function pendingChanges() {
    const evs = $state.snapshot(events);
    const cals = $state.snapshot(calendars);
    const ch = { upsertCalendars: [], deleteCalendars: [], upsertEvents: [], deleteEvents: [] };
    const calIds = new Set(), evIds = new Set();
    cals.forEach((c, i) => {
      const rec = calRecord(c, i);
      calIds.add(c.id);
      if (serverHas.calendars.get(c.id) !== toJson(rec)) ch.upsertCalendars.push(rec);
    });
    for (const id of serverHas.calendars.keys()) if (!calIds.has(id)) ch.deleteCalendars.push(id);
    for (const e of evs) {
      const k = String(e.id);
      evIds.add(k);
      if (serverHas.events.get(k) !== toJson(e)) ch.upsertEvents.push(e);
    }
    for (const k of serverHas.events.keys()) if (!evIds.has(k)) ch.deleteEvents.push(k);
    return ch;
  }

  async function flushChanges() {
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    if (!store || syncState !== 'ready' || readOnly) return;
    if (inflight) { saveAgain = true; return; }
    const ch = pendingChanges();
    const count = ch.upsertCalendars.length + ch.deleteCalendars.length + ch.upsertEvents.length + ch.deleteEvents.length;
    if (!count) { dirty = false; saveStatus = 'idle'; return; }
    saveStatus = 'saving';
    inflight = store.save(ch);
    try {
      await inflight;
      // record exactly what the server now has
      for (const c of ch.upsertCalendars) serverHas.calendars.set(c.id, toJson(c));
      for (const id of ch.deleteCalendars) serverHas.calendars.delete(id);
      for (const e of ch.upsertEvents) serverHas.events.set(String(e.id), toJson(e));
      for (const k of ch.deleteEvents) serverHas.events.delete(k);
      retryDelay = 2000;
      saveStatus = 'idle';
      saveError = '';
      if (migrating) {
        migrating = false;
        try { localStorage.removeItem(storageKey); } catch {} // now on the server
      }
    } catch (err) {
      if (err.status === 401) { goToSignIn(); return; }
      if (err.status === 400 || err.status === 403) {
        // the server refused these changes (e.g. not allowed): show why and go back to what it has
        saveStatus = 'idle';
        saveError = '';
        showToast(`Couldn’t save: ${err.message} The calendar was reloaded.`);
        loadFromServer();
        return;
      }
      console.warn('Calendar: could not save to the server', err);
      saveStatus = 'error';
      saveError = err.message;
      retryTimer = setTimeout(flushChanges, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    } finally {
      inflight = null;
    }
    if (saveAgain || saveStatus === 'idle') { saveAgain = false; flushChanges(); } // catch anything changed meanwhile
  }

  // ---------- live changes from other devices ----------
  function applyLive(msg) {
    if (loading || syncState !== 'ready') { liveBuffer.push(msg); return; }
    if (msg.rev <= lastRev) return;                  // already have it
    if (msg.rev > lastRev + 1) { resync(); return; } // missed one or more: reload
    lastRev = msg.rev;
    if (msg.origin && msg.origin === store.clientId) return; // our own save coming back
    if (msg.resync) { resync(); return; } // a calendar just became visible to us: fetch its events
    mergeRemote(msg.changes ?? {});
  }

  /** Save our own pending edits, then reload everything from the server. */
  async function resync() {
    if (resyncing) return;
    resyncing = true;
    try {
      while (inflight) await inflight.catch(() => {});
      await flushChanges();
      while (inflight) await inflight.catch(() => {});
      if (saveStatus === 'error') return; // server unreachable; the next reconnect tries again
      await loadFromServer();
    } finally {
      resyncing = false;
    }
  }

  /**
   * Apply another device's saved changes. Anything we've changed locally but not saved yet is kept
   * (it will be saved next and so becomes the latest version everywhere: last change wins).
   */
  function mergeRemote(ch) {
    const unsavedHere = (map, key, local) => local !== undefined && map.get(key) !== toJson(local);
    const goneCals = new Set(ch.deleteCalendars ?? []);

    if (ch.upsertEvents?.length || ch.deleteEvents?.length || goneCals.size) {
      const byId = new Map(events.map((e) => [String(e.id), e]));
      for (const e of ch.upsertEvents ?? []) {
        const k = String(e.id);
        const keepMine = unsavedHere(serverHas.events, k, byId.get(k));
        serverHas.events.set(k, toJson(e));
        if (!keepMine) byId.set(k, e);
      }
      for (const id of ch.deleteEvents ?? []) {
        const k = String(id);
        const keepMine = unsavedHere(serverHas.events, k, byId.get(k));
        serverHas.events.delete(k);
        if (!keepMine) byId.delete(k);
      }
      for (const [k, e] of byId) {
        if (goneCals.has(e.calendar)) { byId.delete(k); serverHas.events.delete(k); }
      }
      events = [...byId.values()];
    }

    if (ch.upsertCalendars?.length || goneCals.size) {
      const pos = new Map(calendars.map((c, i) => [c.id, i]));
      const byId = new Map(calendars.map((c) => [c.id, c]));
      for (const rec of ch.upsertCalendars ?? []) {
        const { position, ...cal } = rec;
        const mine = byId.get(cal.id);
        const keepMine = unsavedHere(serverHas.calendars, cal.id, mine ? calRecord(mine, pos.get(cal.id)) : undefined);
        serverHas.calendars.set(cal.id, toJson(rec));
        if (!keepMine) {
          byId.set(cal.id, cal);
          pos.set(cal.id, position ?? byId.size);
        }
      }
      for (const id of goneCals) {
        serverHas.calendars.delete(id);
        byId.delete(id);
        if (calForm?.id === id) calForm = null;
      }
      calendars = [...byId.values()].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    }
  }

  // save whenever events or calendars change
  $effect(() => {
    if (!store || syncState !== 'ready') return;
    $state.snapshot(events);
    $state.snapshot(calendars);
    untrack(() => scheduleSave());
  });

  // live stream
  $effect(() => {
    if (!store?.subscribe) return;
    return untrack(() =>
      store.subscribe({
        onHello: (rev) => {
          // on every (re)connect: if anything changed while we weren't listening, catch up
          if (syncState === 'ready' && !loading && rev !== lastRev) resync();
        },
        onChange: applyLive,
        onStatus: (connected) => (liveState = connected ? 'live' : 'offline'),
        onSignedOut: goToSignIn
      })
    );
  });

  $effect(() => {
    if (!store) return;
    untrack(() => loadFromServer(true));
    const unsaved = () => dirty || !!inflight || saveStatus === 'error';
    const onReturn = () => {
      // fallback when the live stream isn't available
      if (liveState === 'live' || document.visibilityState !== 'visible' || syncState !== 'ready') return;
      if (unsaved() || gesture || dlg?.open || Date.now() - lastLoad < 15000) return;
      loadFromServer();
    };
    const onLeave = (e) => {
      if (!unsaved()) return;
      flushChanges();
      e.preventDefault();
      e.returnValue = '';
    };
    const onOnline = () => { if (saveStatus === 'error') { retryDelay = 2000; flushChanges(); } };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    window.addEventListener('beforeunload', onLeave);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('beforeunload', onLeave);
      window.removeEventListener('online', onOnline);
      clearTimeout(saveTimer);
      clearTimeout(retryTimer);
    };
  });

  function ago(ms) {
    if (!ms) return 'never';
    const min = Math.round((+now - ms) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    if (min < 1440) return `${Math.round(min / 60)} h ago`;
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ---------- .ics import ----------
  let fileInput;
  let importDlg = $state();
  let imp = $state(null); // { fileName, parsed, target: 'new' | calendarId, newName, newColor, error }
  let dragOver = $state(false);
  let toast = $state(null); // { text, action?: { label, run } }
  let toastTimer = 0;

  function showToast(text, action = null) {
    toast = { text, action };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 7000);
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const fmtDay = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  async function readIcsFile(file) {
    if (!file || !canManage) return;
    if (store && syncState !== 'ready') { showToast('Your calendar is still loading. Try again in a moment.'); return; }
    if (narrow) drawerOpen = false;
    let parsed;
    try {
      parsed = parseICS(await file.text());
    } catch (err) {
      console.warn('Calendar: could not read', file.name, err);
      showToast(`Couldn't read “${file.name}”. Is it an .ics calendar file?`);
      return;
    }
    if (!parsed.events.length) {
      showToast(`No events found in “${file.name}”.`);
      return;
    }
    const name = parsed.name ?? file.name.replace(/\.(ics|ical|icalendar|ifb)$/i, '');
    const existing = calendars.find((c) => c.label.toLowerCase() === name.toLowerCase());
    imp = {
      fileName: file.name,
      parsed,
      target: existing ? existing.id : 'new', // re-importing into the same calendar updates its events
      newName: name || 'Imported',
      newColor: parsed.color ?? nextColor(),
      error: ''
    };
    importDlg.showModal();
  }

  const impStats = $derived.by(() => {
    if (!imp) return null;
    const evs = imp.parsed.events;
    const uids = new Set(evs.map((e) => e.uid).filter(Boolean));
    return {
      total: evs.length,
      repeating: evs.filter((e) => e.repeat).length,
      first: new Date(Math.min(...evs.map((e) => +e.start))),
      last: new Date(Math.max(...evs.map((e) => +e.end - 1))),
      updates: imp.target === 'new' ? 0 : events.filter((x) => x.calendar === imp.target && x.uid && uids.has(x.uid)).length
    };
  });

  function doImport(e) {
    e.preventDefault();
    let cal;
    if (imp.target === 'new') {
      const label = imp.newName.trim();
      if (!label) { imp.error = 'Enter a name for the new calendar.'; return; }
      if (calendars.some((c) => c.label.toLowerCase() === label.toLowerCase())) {
        imp.error = 'A calendar with that name already exists. Pick it from the list instead.';
        return;
      }
      cal = createCalendar(label, imp.newColor);
    } else {
      cal = calendars.find((c) => c.id === imp.target);
      if (!cal) { imp.error = 'Pick a calendar.'; return; }
    }

    const existingByUid = new Map(events.filter((x) => x.calendar === cal.id && x.uid).map((x) => [x.uid, x]));
    const replaced = new Map();
    const added = [];
    for (const p of imp.parsed.events) {
      const ev = { ...p, calendar: cal.id };
      if (!ev.uid) delete ev.uid;
      const old = ev.uid ? existingByUid.get(ev.uid) : null;
      if (old) replaced.set(old.id, { ...ev, id: old.id });
      else added.push({ ...ev, id: newId(), ...(user ? { createdBy: user.id } : {}) });
    }
    withUndo(`Import into “${cal.label}”.`, () => { events = [...events.map((x) => replaced.get(x.id) ?? x), ...added]; }, { toast: false });
    visible[cal.id] = true;
    onImport({ calendar: cal, added, updated: [...replaced.values()] });
    importDlg.close();

    const parts = [];
    if (added.length) parts.push(`added ${plural(added.length, 'event')}`);
    if (replaced.size) parts.push(`updated ${replaced.size}`);
    const all = [...added, ...replaced.values()];
    const now0 = new Date();
    const next = all.filter((x) => x.start >= now0).sort((a, b) => a.start - b.start)[0]
      ?? all.sort((a, b) => b.start - a.start)[0];
    showToast(
      `“${cal.label}”: ${parts.join(', ')}.`,
      next ? { label: 'Show', run: () => { date = next.start; toast = null; } } : null
    );
  }

  function onFileChosen(e) {
    readIcsFile(e.currentTarget.files?.[0]);
    e.currentTarget.value = ''; // allow choosing the same file again
  }

  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
</script>

{#snippet calendarForm()}
  <form class="cal-form" onsubmit={saveCalendar}>
    {#if calForm.mode === 'subscribe' || calForm.isSub}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="name-input"
        type="url"
        bind:value={calForm.url}
        placeholder="https://… or webcal://… (.ics address)"
        aria-label="Calendar address"
        autofocus={calForm.mode === 'subscribe'}
        onkeydown={(e) => e.key === 'Escape' && (calForm = null)}
      />
      {#if calForm.mode === 'subscribe'}
        <details class="help">
          <summary>Getting the link from an iPhone</summary>
          <ol>
            <li>Open the <strong>Calendar</strong> app and tap <strong>Calendars</strong> at the bottom.</li>
            <li>Tap <strong>ⓘ</strong> next to the calendar you want (it must be under <strong>iCloud</strong>).</li>
            <li>Turn on <strong>Public Calendar</strong>, tap <strong>Share Link…</strong> and choose <strong>Copy</strong>.</li>
            <li>Paste the link above. It starts with <code>webcal://</code>.</li>
          </ol>
          <p>
            Calendars under “On My iPhone” can't be shared this way, and anyone with the link can see the
            events. For Google or Outlook calendars on your phone, use that service's own iCal link instead.
            iCloud can take a little while to publish changes made on the phone.
          </p>
        </details>
      {/if}
    {/if}
    <div class="add-row">
      <input class="color-input" type="color" bind:value={calForm.color} aria-label="Calendar color" />
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="name-input"
        type="text"
        bind:value={calForm.label}
        placeholder={calForm.mode === 'subscribe' ? 'Name (optional)' : 'Calendar name'}
        aria-label="Calendar name"
        autofocus={calForm.mode !== 'subscribe'}
        onkeydown={(e) => e.key === 'Escape' && (calForm = null)}
      />
    </div>
    {#if calForm.mode === 'subscribe' || calForm.isSub}
      <select class="name-input" bind:value={calForm.refresh} aria-label="Refresh how often">
        {#each REFRESH_CHOICES as [min, text]}<option value={min}>Refresh {text.toLowerCase()}</option>{/each}
      </select>
    {/if}
    {#if calForm.isSub}
      {@const src = calendars.find((c) => c.id === calForm.id)?.source}
      <div class="sync-row">
        <span class:bad={src?.error}>
          {src?.error ? `Last refresh failed: ${src.error}` : `Refreshed ${ago(src?.lastSync)}`}
        </span>
        <button type="button" class="text-btn small" disabled={syncing[calForm.id]} onclick={() => syncCalendar(calForm.id)}>
          {syncing[calForm.id] ? 'Refreshing…' : 'Refresh now'}
        </button>
      </div>
    {/if}
    <div class="swatches" role="group" aria-label="Color presets">
      {#each PALETTE as p}
        <button
          type="button"
          class="swatch"
          class:picked={calForm.color.toLowerCase() === p}
          style="--c: {p}"
          aria-label="Use color {p}"
          onclick={() => (calForm.color = p)}
        ></button>
      {/each}
    </div>
    {#if user && canSetPrivate(calForm.mode === 'edit' ? calendars.find((c) => c.id === calForm.id) : null)}
      <fieldset class="who-sees">
        <legend>Who can see it</legend>
        <label class="radio-line"><input type="radio" bind:group={calForm.who} value="everyone" /> Everyone</label>
        <label class="radio-line"><input type="radio" bind:group={calForm.who} value="some" /> Only me and…</label>
        {#if calForm.who === 'some'}
          <div class="share-list">
            {#each shareChoices as p (p.id)}
              <label class="share-person">
                <input type="checkbox" checked={calForm.sharedWith.includes(p.id)} onchange={() => toggleShare(p.id)} />
                {p.name}{p.role === 'kiosk' ? ' (tablet)' : ''}
              </label>
            {/each}
          </div>
          <p class="private-note">
            {calForm.sharedWith.length ? 'They can see it but not change it.' : 'Only you can see this calendar and its events.'}
          </p>
        {/if}
      </fieldset>
    {:else if calForm.mode === 'edit'}
      <p class="private-note">{whoSees(calendars.find((c) => c.id === calForm.id))}</p>
    {/if}
    {#if calError}<p class="error" role="alert">{calError}</p>{/if}

    {#if calForm.confirm}
      {@const n = eventCount(calForm.id)}
      {@const name = calendars.find((c) => c.id === calForm.id)?.label}
      {#if calForm.isSub}
        <p class="confirm">Unsubscribe from “{name}”? Its events will be removed from this calendar (the original isn't affected).</p>
      {:else}
        <p class="confirm">Delete “{name}”{n ? ` and its ${n} event${n === 1 ? '' : 's'}` : ''}? This can't be undone.</p>
      {/if}
      <div class="form-actions">
        <button type="button" class="text-btn small" onclick={() => (calForm.confirm = false)}>Keep</button>
        <button type="button" class="danger-btn solid small" onclick={deleteCalendar}>{calForm.isSub ? 'Unsubscribe' : 'Delete'}</button>
      </div>
    {:else}
      <div class="form-actions">
        {#if calForm.mode === 'edit'}
          <button
            type="button"
            class="danger-btn small"
            disabled={!calForm.isSub && editableCount <= 1}
            title={!calForm.isSub && editableCount <= 1 ? 'You need at least one calendar of your own' : ''}
            onclick={() => (calForm.confirm = true)}
          >{calForm.isSub ? 'Unsubscribe' : 'Delete'}</button>
          <button type="button" class="text-btn small" title="Download as an .ics file for other calendar apps"
            onclick={() => { const c = calendars.find((x) => x.id === calForm.id); if (c) exportCalendar(c); }}>Export</button>
        {/if}
        <div class="spacer"></div>
        <button type="button" class="text-btn small" onclick={() => (calForm = null)}>Cancel</button>
        <button type="submit" class="primary-btn small" disabled={calForm.busy}>
          {calForm.mode === 'add' ? 'Add' : calForm.mode === 'subscribe' ? (calForm.busy ? 'Subscribing…' : 'Subscribe') : 'Save'}
        </button>
      </div>
    {/if}
  </form>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="cal"
  class:dark={theme === 'dark'}
  role="region"
  aria-label="Calendar"
  bind:this={root}
  style:height={rootHeight != null ? `${rootHeight}px` : null}
  ondragover={(e) => { if (hasFiles(e) && canManage) { e.preventDefault(); dragOver = true; } }}
  ondragleave={(e) => { if (!root.contains(e.relatedTarget)) dragOver = false; }}
  ondrop={(e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragOver = false;
    readIcsFile(e.dataTransfer.files[0]);
  }}
>
  <input
    class="sr"
    type="file"
    accept=".ics,.ical,.icalendar,text/calendar"
    tabindex="-1"
    aria-hidden="true"
    bind:this={fileInput}
    onchange={onFileChosen}
  />
  {#if dragOver}
    <div class="drop-overlay"><div>Drop an .ics file to import its events</div></div>
  {/if}
  {#if toast}
    <div class="toast" role="status">
      <span>{toast.text}</span>
      {#if toast.action}<button class="toast-btn" onclick={toast.action.run}>{toast.action.label}</button>{/if}
      <button class="toast-close" aria-label="Dismiss" onclick={() => (toast = null)}>×</button>
    </div>
  {/if}

  <!-- toolbar -->
  <header class="toolbar">
    <button class="icon-btn" aria-label="Toggle sidebar" aria-expanded={showSidebar} onclick={toggleSidebar}>
      <svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
    </button>
    <button class="text-btn" onclick={goToday}>Today</button>
    <div class="nav" role="group" aria-label="Date navigation">
      <button class="icon-btn" aria-label="Previous {view}" onclick={() => step(-1)}>
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <button class="icon-btn" aria-label="Next {view}" onclick={() => step(1)}>
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
    </div>
    <h2 class="title" aria-live="polite">{title}</h2>
    <div class="spacer"></div>
    {#if store}
      <span
        class="live-dot"
        class:on={liveState === 'live'}
        role="img"
        aria-label={liveState === 'live' ? 'Live updates on' : 'Reconnecting for live updates'}
        title={liveState === 'live'
          ? 'Live: changes from other devices show up instantly'
          : 'Reconnecting… changes from other devices will show up once connected'}
      ></span>
    {/if}
    {#if saveStatus === 'error'}
      <button class="save-status bad" title={saveError} onclick={() => { retryDelay = 2000; flushChanges(); }}>
        Not saved · Retry
      </button>
    {:else if saveStatus === 'saving'}
      <span class="save-status" role="status">Saving…</span>
    {/if}
    <div class="views" role="group" aria-label="View">
      {#each ['day', 'week', 'month'] as v}
        <button class:on={view === v} aria-pressed={view === v} onclick={() => (view = v)}>{v[0].toUpperCase() + v.slice(1)}</button>
      {/each}
    </div>
    {#if addableCalendars.length}
      <button class="primary-btn" onclick={openNewFromToolbar} aria-label="New event">
        +<span class="label"> New event</span>
      </button>
    {:else}
      <span class="view-only" title="Your account can look at the calendar but not change it">View only</span>
    {/if}
  </header>

  <div class="body">
    {#if syncState === 'loading' || syncState === 'load-error'}
      <div class="sync-overlay" role="status">
        {#if syncState === 'loading'}
          <div>Loading your calendar…</div>
        {:else}
          <div>
            <strong>Couldn't load your calendar from the server.</strong>
            {#if saveError}<p>{saveError}</p>{/if}
            <button class="primary-btn" onclick={() => loadFromServer(true)}>Try again</button>
          </div>
        {/if}
      </div>
    {/if}
    {#if narrow && drawerOpen}
      <button class="scrim" aria-label="Close sidebar" onclick={() => (drawerOpen = false)}></button>
    {/if}

    {#if showSidebar}
      <aside class="sidebar" class:drawer={narrow} aria-label="Calendar sidebar">
        <div class="mini">
          <div class="mini-head">
            <button class="icon-btn sm" aria-label="Previous month" onclick={() => (miniMonth = new Date(miniMonth.getFullYear(), miniMonth.getMonth() - 1, 1))}>‹</button>
            <span>{monthName(miniMonth)} {miniMonth.getFullYear()}</span>
            <button class="icon-btn sm" aria-label="Next month" onclick={() => (miniMonth = new Date(miniMonth.getFullYear(), miniMonth.getMonth() + 1, 1))}>›</button>
          </div>
          <div class="mini-grid">
            {#each weekdayHeads as wd}
              <div class="mini-wd">{wd}</div>
            {/each}
            {#each monthGrid(miniMonth) as d (+d)}
              <button
                class="mini-day"
                class:out={d.getMonth() !== miniMonth.getMonth()}
                class:weekend={isWeekend(d)}
                class:in-range={view !== 'month' && d >= rangeStart && d < rangeEnd}
                class:selected={sameDay(d, date)}
                class:today={sameDay(d, now)}
                onclick={() => pickDate(d)}
              >{d.getDate()}</button>
            {/each}
          </div>
        </div>

        <div class="cal-list">
          <div class="section-head">My calendars</div>
          <div class="filters" role="group" aria-label="Calendar filters" bind:this={calListEl}>
            {#each shownCalendars as c, i (c.id)}
              {#if calForm?.mode === 'edit' && calForm.id === c.id}
                {@render calendarForm()}
              {:else}
                <div class="filter-row" class:dragging={calDrag?.id === c.id} data-cal-row={c.id}>
                  {#if calendars.length > 1 && canManage}
                    <button
                      class="grip"
                      data-grip={c.id}
                      aria-label="Reorder {c.label} (position {i + 1} of {calendars.length}). Use the up and down arrow keys."
                      title="Drag to reorder"
                      onpointerdown={(e) => onGripPointerDown(e, c.id)}
                      onkeydown={(e) => onGripKey(e, c.id)}
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                        <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
                        <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
                        <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
                      </svg>
                    </button>
                  {/if}
                  <label class="filter" style="--c: {c.color}">
                    <input type="checkbox" checked={isOn(c.id)} onchange={(e) => (visible[c.id] = e.currentTarget.checked)} />
                    <span class="box"></span>
                    <span class="filter-label">{c.label}</span>
                    {#if c.private}
                      <span class="lock" class:shared-in={sharedWithMe(c)} title={whoSees(c)} aria-label={whoSees(c)}>
                        <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" /></svg>
                      </span>
                    {/if}
                    {#if c.source}
                      <span
                        class="sub-state"
                        class:spin={syncing[c.id]}
                        class:bad={c.source.error}
                        title={c.source.error ? `Last refresh failed: ${c.source.error}` : `Subscribed · refreshed ${ago(c.source.lastSync)}`}
                      >
                        {#if c.source.error && !syncing[c.id]}!{:else}
                          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M20 11a8 8 0 00-14.3-4.9L4 8m0-5v5h5M4 13a8 8 0 0014.3 4.9L20 16m0 5v-5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
                        {/if}
                      </span>
                    {/if}
                  </label>
                  {#if canEditCalendar(c)}
                    <button class="icon-btn sm edit-cal" aria-label="Edit {c.label}" title="Edit calendar" onclick={() => startEditCalendar(c)}>
                      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /></svg>
                    </button>
                  {/if}
                </div>
              {/if}
            {/each}
            {#each overlay?.calendars ?? [] as c (c.id)}
              <div class="filter-row">
                <label class="filter" style="--c: {c.color}">
                  <input type="checkbox" checked={isOn(c.id)} onchange={(e) => (visible[c.id] = e.currentTarget.checked)} />
                  <span class="box"></span>
                  <span class="filter-label">{c.label}</span>
                </label>
              </div>
            {/each}
          </div>

          {#if readOnly}
            <!-- view-only: nothing to add -->
          {:else if calForm?.mode === 'add' || calForm?.mode === 'subscribe'}
            {@render calendarForm()}
          {:else if isKiosk}
            <!-- the kiosk can't change calendars -->
          {:else if isChild}
            <!-- children can make calendars of their own (and choose who sees them); shared ones are managed by parents -->
            <button class="add-link" onclick={startAddCalendar}>+ Add a calendar of your own</button>
          {:else}
            <button class="add-link" onclick={startAddCalendar}>+ Add calendar</button>
            <button class="add-link" onclick={startSubscribe}>
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
              Subscribe by URL
            </button>
            <button class="add-link" onclick={() => fileInput.click()}>
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 15V3m0 12l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
              Import .ics file
            </button>
          {/if}
          {#if calForm?.mode !== 'add' && calForm?.mode !== 'subscribe' && events.length}
            <button class="add-link" onclick={exportAll} title="Download the calendars that are switched on as an .ics file">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3v12m0-12L8 7m4-4l4 4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
              Export .ics
            </button>
          {/if}
        </div>
      </aside>
    {/if}

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <main class="main" oncontextmenu={(e) => lastTouch && e.preventDefault()}>
      {#if view === 'month'}
        <div class="month">
          <div class="m-head">
            {#each weekdayHeads as wd}<div>{wd}</div>{/each}
          </div>
          <div class="m-grid" style="--rows: {monthRows}" bind:clientHeight={monthH}>
            {#each monthCells as d, i (+d)}
              {@const cell = monthItems[i] ?? { bars: [], timed: [], count: 0 }}
              {@const slots = [...cell.bars.map((bar) => ({ bar })), ...cell.timed.map((occ) => ({ occ }))]}
              {@const shown = slots.length > maxChips ? slots.slice(0, maxChips - 1) : slots}
              {@const hiddenCount = cell.count - shown.filter((x) => x.bar || x.occ).length}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="m-cell"
                class:out={d.getMonth() !== date.getMonth()}
                class:weekend={isWeekend(d)}
                class:has-today={sameDay(d, now)}
                class:drop={moving?.kind === 'days' && moving.hoverDate === ymd(d)}
                data-date={ymd(d)}
                onclick={(e) => { if (!suppressClick && !e.target.closest('button')) openNewAllDay(d); }}
              >
                <button class="m-num" class:today={sameDay(d, now)} aria-label="Open {d.toDateString()}" onclick={() => openDay(d)}>{d.getDate()}</button>
                <div class="m-list">
                  {#each shown as x, k (x.bar ? x.bar.occ.key : x.occ ? x.occ.key : `gap-${k}`)}
                    {@const o = x.bar?.occ ?? x.occ}
                    {#if !o}
                      <div class="gap" aria-hidden="true"></div>
                    {:else}
                      <button
                        class="chip"
                        class:long={!!x.bar}
                        class:join-l={x.bar?.joinL}
                        class:join-r={x.bar?.joinR}
                        class:dragging={moving?.key === o.key}
                        class:readonly={!canEditEvent(o.event)}
                        style="--c: {colorOf[o.event.calendar] ?? '#888'}"
                        title={occTooltip(o)}
                        aria-label={x.bar && !x.bar.first ? o.event.title : undefined}
                        onpointerdown={(e) => onDayItemPointerDown(e, o)}
                        onclick={() => onOccClick(o)}
                      >
                        <!-- a bar's title is written once per week, where it starts -->
                        {#if !x.bar || x.bar.first}<span class="chip-title">{o.event.title}</span>{/if}
                        {#if !x.bar}
                          {#if sameDay(o.start, d)}
                            <span class="chip-time">{shortTime(o.start)}</span>
                          {:else if sameDay(new Date(+o.end - 1), d)}
                            <span class="chip-time">→{shortTime(o.end)}</span>
                          {/if}
                        {/if}
                      </button>
                    {/if}
                  {/each}
                  {#if hiddenCount > 0}
                    <button class="more" onclick={() => openDay(d)}>+{hiddenCount} more</button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {:else}
        <div class="time-view" style="--n: {days.length}">
          <div class="head-row">
            <div class="corner"></div>
            {#each days as d (+d)}
              <button class="col-head" class:today={sameDay(d, now)} onclick={() => openDay(d)}>{fmtHead(d)}</button>
            {/each}
          </div>

          <div class="strip-row">
            <div class="strip-label">all-day</div>
            <div class="strip" style="--rows: {Math.max(1, strip.rows)}">
              {#each days as d, i (+d)}
                <button
                  class="strip-col"
                  class:drop={moving?.kind === 'days' && moving.hoverDate === ymd(d)}
                  data-date={ymd(d)}
                  style="grid-column: {i + 1}"
                  aria-label="New all-day event on {d.toDateString()}"
                  onclick={() => { if (!suppressClick) openNewAllDay(d); }}
                ></button>
              {/each}
              {#each strip.items as it (it.occ.key)}
                {@const shift = moving?.kind === 'days' && moving.key === it.occ.key ? moving.dayDelta : 0}
                {@const a = clamp(it.startCol + shift, 0, days.length - 1)}
                {@const b = clamp(it.endCol + shift, 0, days.length - 1)}
                <button
                  class="bar"
                  class:cont-left={it.contLeft}
                  class:cont-right={it.contRight}
                  class:dragging={shift !== 0}
                  class:readonly={!canEditEvent(it.occ.event)}
                  style="--c: {colorOf[it.occ.event.calendar] ?? '#888'}; grid-column: {a + 1} / {b + 2}; grid-row: {it.row + 1}"
                  title={occTooltip(it.occ)}
                  onpointerdown={(e) => onDayItemPointerDown(e, it.occ)}
                  onclick={() => onOccClick(it.occ)}
                >{it.occ.event.title}</button>
              {/each}
            </div>
          </div>

          <div class="scroll-wrap">
          {#if offscreen.above}
            <button class="offscreen top" onclick={() => scrollToMinute(offscreen.aboveAt)}>
              ↑ {offscreen.above} earlier
            </button>
          {/if}
          {#if offscreen.below}
            <button class="offscreen bottom" onclick={() => scrollToMinute(offscreen.belowAt, 'third')}>
              ↓ {offscreen.below} later
            </button>
          {/if}
          <div class="scroll" bind:this={scrollEl} bind:clientHeight={scrollH} onscroll={onGridScroll}>
            <div class="grid" style="--hh: {hh}px; height: {hours.length * hh}px">
              <div class="gutter">
                {#each hours as h (h)}
                  <div class="hour-label">{fmtHour(h)}</div>
                {/each}
              </div>

              {#each days as d, i (+d)}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="day-col"
                  class:weekend={isWeekend(d)}
                  data-date={ymd(d)}
                  onpointerdown={(e) => onColPointerDown(e, d)}
                >
                  {#each timed[i] as seg (seg.occ.key)}
                    {@const eMin = moving?.kind === 'resize' && moving.key === seg.occ.key && sameDay(moving.day, d) ? moving.end : seg.eMin}
                    {@const height = ((Math.min(eMin, 1440) - seg.sMin) / 60) * hh}
                    <button
                      class="event"
                      class:dragging={moving?.kind === 'timed' && moving.key === seg.occ.key}
                      class:readonly={!canEditEvent(seg.occ.event)}
                      class:cont-top={!seg.isStart}
                      class:cont-bottom={!seg.isEnd}
                      style="--c: {colorOf[seg.occ.event.calendar] ?? '#888'};
                             top: {(seg.sMin / 60) * hh + 1}px; height: {Math.max(height - 2, 16)}px;
                             left: calc({(seg.col / seg.cols) * 100}% + 2px);
                             width: calc({100 / seg.cols}% - 4px);"
                      title={occTooltip(seg.occ)}
                      onpointerdown={(e) => onSegmentPointerDown(e, seg, d)}
                      onclick={() => onOccClick(seg.occ)}
                    >
                      {#if height >= 40}
                        <span class="ev-time">
                          {moving?.kind === 'resize' && moving.key === seg.occ.key
                            ? fmtRange(seg.occ.start, atMinute(d, eMin))
                            : fmtRange(seg.occ.start, seg.occ.end)}
                        </span>
                      {/if}
                      <span class="ev-title">{seg.occ.event.title}</span>
                      {#if height >= 64 && seg.occ.event.location}
                        <span class="ev-loc">{seg.occ.event.location}</span>
                      {/if}
                      {#if seg.isEnd && canEditEvent(seg.occ.event)}<span class="resize-handle" aria-hidden="true"></span>{/if}
                    </button>
                  {/each}

                  {#if moving?.kind === 'timed' && sameDay(moving.day, d)}
                    {@const top = Math.max(moving.s, 0)}
                    {@const bottom = Math.min(moving.e, 1440)}
                    <div
                      class="event ghost"
                      style="--c: {moving.color ?? '#888'}; top: {(top / 60) * hh + 1}px; height: {Math.max(((bottom - top) / 60) * hh - 2, 16)}px; left: 2px; width: calc(100% - 4px);"
                    >
                      <span class="ev-time">{fmtMin(moving.s)} – {fmtMin(moving.e)}</span>
                    </div>
                  {/if}

                  {#if draft && sameDay(draft.day, d)}
                    <div
                      class="event ghost"
                      style="--c: {colorOf[defaultCalendar()] ?? '#888'};
                             top: {(draft.s / 60) * hh + 1}px;
                             height: {Math.max(((draft.e - draft.s) / 60) * hh - 2, 16)}px;
                             left: 2px; width: calc(100% - 4px);"
                    >
                      <span class="ev-time">{fmtMin(draft.s)} – {fmtMin(draft.e)}</span>
                      <span class="ev-title">New event</span>
                    </div>
                  {/if}

                  {#if sameDay(d, now)}
                    <div class="now-line" style="top: {(nowMin / 60) * hh}px"></div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
          </div>
        </div>
      {/if}
    </main>
  </div>

  <!-- import dialog -->
  <dialog bind:this={importDlg} class="editor" onclose={() => (imp = null)}>
    {#if imp && impStats}
      <form onsubmit={doImport}>
        <h3>Import “{imp.fileName}”</h3>
        <p class="import-summary">
          {plural(impStats.total, 'event')}{impStats.repeating ? ` (${impStats.repeating} repeating)` : ''}
          · {sameDay(impStats.first, impStats.last) ? fmtDay(impStats.first) : `${fmtDay(impStats.first)} – ${fmtDay(impStats.last)}`}
        </p>

        <label class="field">
          <span>Add to</span>
          <select bind:value={imp.target}>
            <option value="new">New calendar</option>
            {#each calendars.filter((c) => !c.source) as c (c.id)}
              <option value={c.id}>{c.label}</option>
            {/each}
          </select>
        </label>

        {#if imp.target === 'new'}
          <div class="add-row">
            <input class="color-input" type="color" bind:value={imp.newColor} aria-label="New calendar color" />
            <input class="name-input" type="text" bind:value={imp.newName} aria-label="New calendar name" placeholder="Calendar name" />
          </div>
        {:else if impStats.updates}
          <p class="hint">
            {plural(impStats.updates, 'event')} from an earlier import of this file will be updated instead of added again.
          </p>
        {/if}

        {#if imp.parsed.warnings.length}
          <div class="warn-box">
            <strong>Some things didn't come across exactly:</strong>
            <ul>
              {#each imp.parsed.warnings.slice(0, 4) as w}<li>{w}</li>{/each}
            </ul>
            {#if imp.parsed.warnings.length > 4}<p>…and {imp.parsed.warnings.length - 4} more.</p>{/if}
          </div>
        {/if}
        {#if imp.parsed.cancelled}
          <p class="hint">{plural(imp.parsed.cancelled, 'cancelled event')} will be skipped.</p>
        {/if}
        {#if imp.error}<p class="error" role="alert">{imp.error}</p>{/if}

        <div class="form-actions">
          <div class="spacer"></div>
          <button type="button" class="text-btn" onclick={() => importDlg.close()}>Cancel</button>
          <button type="submit" class="primary-btn">Import {plural(impStats.total, 'event')}</button>
        </div>
      </form>
    {/if}
  </dialog>

  <!-- event editor -->
  <dialog bind:this={dlg} class="editor" onclose={() => { draft = null; error = ''; }}>
    <form onsubmit={save}>
      <h3>{formReadOnly ? 'Event details' : form.id == null ? 'New event' : 'Edit event'}</h3>
      {#if !formReadOnly && form.id != null && form.occ?.recurring}
        <div class="scope" role="radiogroup" aria-label="Which events to change">
          {#each [['this', 'This event'], ['following', 'This and following'], ['all', 'All events']] as [value, text]}
            <label class:on={form.scope === value}>
              <input type="radio" bind:group={form.scope} {value} />
              <span>{text}</span>
            </label>
          {/each}
        </div>
      {/if}
      <fieldset class="bare" disabled={formReadOnly}>

      <label class="field">
        <span>Title</span>
        <input type="text" bind:value={form.title} placeholder="Event title" />
      </label>

      <div class="row">
        <label class="field grow">
          <span>Calendar</span>
          <select bind:value={form.calendar}>
            {#each calendars.filter((c) => addableCalendars.includes(c) || c.id === form.calendar) as c (c.id)}
              <option value={c.id}>{c.label}</option>
            {/each}
          </select>
        </label>
        <label class="toggle">
          <input type="checkbox" bind:checked={form.allDay} />
          <span>All day</span>
        </label>
      </div>

      <div class="row">
        <label class="field grow">
          <span>Starts</span>
          <input type="date" bind:value={form.startDate} />
        </label>
        {#if !form.allDay}
          <label class="field">
            <span class="sr">Start time</span>
            <input type="time" bind:value={form.startTime} aria-label="Start time" />
          </label>
        {/if}
      </div>

      <div class="row">
        <label class="field grow">
          <span>Ends</span>
          <input type="date" bind:value={form.endDate} />
        </label>
        {#if !form.allDay}
          <label class="field">
            <span class="sr">End time</span>
            <input type="time" bind:value={form.endTime} aria-label="End time" />
          </label>
        {/if}
      </div>

      {#if form.scope !== 'this' || !form.occ?.recurring}
      <label class="field">
        <span>Repeat</span>
        <select value={form.repeat} onchange={onRepeatSelect}>
          <option value="none">Does not repeat</option>
          {#each REPEAT_PRESETS as key}
            <option value={key}>{describeRepeat(presetRepeat(key, formStart), formStart)}</option>
          {/each}
          <option value="custom">Custom…</option>
        </select>
      </label>

      {#if form.repeat === 'custom'}
        <div class="repeat-panel">
          <div class="inline">
            <span>Every</span>
            <input class="num" type="number" min="1" max="999" bind:value={form.rInterval} aria-label="Repeat every" />
            <select bind:value={form.rFreq} aria-label="Repeat unit">
              <option value="daily">{form.rInterval == 1 ? 'day' : 'days'}</option>
              <option value="weekly">{form.rInterval == 1 ? 'week' : 'weeks'}</option>
              <option value="monthly">{form.rInterval == 1 ? 'month' : 'months'}</option>
              <option value="yearly">{form.rInterval == 1 ? 'year' : 'years'}</option>
            </select>
          </div>

          {#if form.rFreq === 'weekly'}
            <div class="sub-label">On</div>
            <div class="wd-row" role="group" aria-label="Repeat on">
              {#each weekdayOrder as wd}
                <button
                  type="button"
                  class="wd"
                  class:on={form.rDays.includes(wd)}
                  aria-pressed={form.rDays.includes(wd)}
                  aria-label={WD_NAMES[wd]}
                  onclick={() => toggleDay(wd)}
                >{WD_NAMES[wd][0]}</button>
              {/each}
            </div>
          {:else if form.rFreq === 'monthly'}
            <div class="radios">
              {#each monthlyChoices(formStart) as c (c.value)}
                <label class="radio">
                  <input type="radio" bind:group={form.rMonthly} value={c.value} />
                  <span>{c.label}</span>
                </label>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if form.repeat !== 'none'}
        <fieldset class="repeat-panel ends">
          <legend class="sub-label">Ends</legend>
          <label class="radio">
            <input type="radio" bind:group={form.rEnds} value="never" />
            <span>Never</span>
          </label>
          <label class="radio">
            <input type="radio" bind:group={form.rEnds} value="on" />
            <span>On</span>
            <input
              type="date"
              bind:value={form.rUntil}
              aria-label="Repeat end date"
              class:dim={form.rEnds !== 'on'}
              onfocus={() => (form.rEnds = 'on')}
            />
          </label>
          <label class="radio">
            <input type="radio" bind:group={form.rEnds} value="after" />
            <span>After</span>
            <input
              class="num"
              type="number"
              min="1"
              max="999"
              bind:value={form.rCount}
              aria-label="Number of times"
              class:dim={form.rEnds !== 'after'}
              onfocus={() => (form.rEnds = 'after')}
            />
            <span>{form.rCount == 1 ? 'time' : 'times'}</span>
          </label>
        </fieldset>
        {#if repeatSummary}<p class="hint summary">{repeatSummary}</p>{/if}
      {/if}
      {/if}

      <label class="field">
        <span>Location</span>
        <input type="text" bind:value={form.location} placeholder="Add a location" />
      </label>

      <label class="field">
        <span>Notes</span>
        <textarea rows="3" bind:value={form.notes} placeholder="Add notes"></textarea>
      </label>
      </fieldset>

      {#if form.id != null && form.occ?.event.createdBy && personName(form.occ.event.createdBy)}
        <p class="hint">Added by {form.occ.event.createdBy === user?.id ? 'you' : personName(form.occ.event.createdBy)}</p>
      {/if}
      {#if formReadOnly}
        <p class="hint">
          {#if readOnly}
            You can look at events here but not change them.
          {:else if readOnlyCals.has(form.occ?.event.calendar)}
            From the subscribed calendar “{calendars.find((c) => c.id === form.calendar)?.label}”, so it can't be changed here.
            Changes made to the original show up after the next refresh.
          {:else if kioskCanUnlock(form.occ?.event)}
            Added by {personName(form.occ.event.createdBy)}. They can change it with their PIN.
          {:else if isKiosk}
            This can’t be changed on the tablet.
          {:else}
            Only {personName(form.occ?.event.createdBy) ?? 'the person who added it'} or a parent can change this event.
          {/if}
        </p>
      {:else if form.occ?.recurring}
        <p class="hint">
          {form.scope === 'this' ? `Only the ${fmtDay(form.occ.start)} event changes; the other repeats stay as they are.`
            : form.scope === 'following' ? `Changes apply from ${fmtDay(form.occ.start)} on; earlier repeats stay as they are.`
            : 'Changes apply to every repeat of this event.'}
        </p>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}

      <div class="form-actions">
        {#if formReadOnly}
          <div class="spacer"></div>
          {#if kioskCanUnlock(form.occ?.event)}
            <button type="button" class="text-btn" onclick={() => onUnlock(form.occ.event.createdBy)}>Enter {personName(form.occ.event.createdBy)}’s PIN</button>
          {/if}
          <button type="button" class="primary-btn" onclick={() => dlg.close()}>Close</button>
        {:else}
        {#if form.id != null}
          {#if form.occ?.recurring}
            <button type="button" class="danger-btn" onclick={deleteOccurrence}>Delete this one</button>
            {#if form.occ.event.start < startOfDay(form.occ.start)}
              <button type="button" class="danger-btn" onclick={deleteFollowing}>Delete this &amp; following</button>
            {/if}
            <button type="button" class="danger-btn" onclick={deleteEvent}>Delete all</button>
          {:else}
            <button type="button" class="danger-btn" onclick={deleteEvent}>Delete</button>
          {/if}
        {/if}
        <div class="spacer"></div>
        <button type="button" class="text-btn" onclick={() => dlg.close()}>Cancel</button>
        <button type="submit" class="primary-btn">Save</button>
        {/if}
      </div>
    </form>
  </dialog>

  <dialog bind:this={scopeDlg} class="editor scope-ask" onclose={() => (scopeAsk = null)}>
    {#if scopeAsk}
      <h3>{scopeAsk.label} a repeating event</h3>
      <p class="hint">Which events should change?</p>
      <div class="scope-choices">
        <button type="button" class="text-btn" onclick={() => answerScope('this')}>This event</button>
        <button type="button" class="text-btn" onclick={() => answerScope('following')}>This and following</button>
        <button type="button" class="primary-btn" onclick={() => answerScope('all')}>All events</button>
      </div>
      <div class="form-actions">
        <div class="spacer"></div>
        <button type="button" class="text-btn" onclick={() => answerScope(null)}>Cancel</button>
      </div>
    {/if}
  </dialog>
</div>

<style>
  .scope { display: flex; gap: 4px; padding: 3px; margin: -4px 0 12px; border-radius: 10px; background: var(--bg-alt); }
  .scope label { flex: 1; text-align: center; padding: 6px 8px; border-radius: 8px; font-size: 13px; cursor: pointer; color: var(--muted); }
  .scope label.on { background: var(--bg); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgb(0 0 0 / 0.15); }
  .scope input { position: absolute; opacity: 0; pointer-events: none; }
  .scope label:has(input:focus-visible) { outline: 2px solid var(--accent); }
  .scope-ask { max-width: 380px; }
  .scope-choices { display: flex; flex-direction: column; gap: 8px; margin: 12px 0 4px; }
  .scope-choices button { width: 100%; justify-content: center; }
  .cal {
    --bg: #ffffff;
    --bg-alt: #f7f8fa;
    --weekend: #fafbfc;
    --text: #2c2f3c;
    --muted: #8a8f9c;
    --line: #e6e8ec;
    --hover: #eef0f4;
    --accent: #3b82f6;
    --today: #e5483f;
    --accent-soft: #e6effe;
    --danger: #e5484d;
    --gutter: 64px;

    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 320px;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    -webkit-tap-highlight-color: transparent;
  }
  .cal.dark {
    --bg: #1f2128;
    --bg-alt: #262931;
    --weekend: #23252c;
    --text: #e4e6eb;
    --muted: #8d93a0;
    --line: #353842;
    --hover: #2e313a;
    --accent: #60a5fa;
    --today: #ff5a4f;
    --accent-soft: #2a3a55;
    color-scheme: dark;
  }

  /* padding must not add to the heights computed from times (hour rows, event blocks) */
  .cal, .cal *, .cal *::before, .cal *::after { box-sizing: border-box; }

  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .spacer { flex: 1; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

  /* toolbar */
  .toolbar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 8px 12px; border-bottom: 1px solid var(--line);
  }
  .title { margin: 0 0 0 4px; font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .nav { display: flex; gap: 2px; }
  .icon-btn { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 6px; flex-shrink: 0; }
  .icon-btn.sm { width: 24px; height: 24px; font-size: 18px; line-height: 1; }
  .icon-btn:hover, .text-btn:hover { background: var(--hover); }
  .text-btn { padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; }
  .primary-btn { padding: 6px 12px; border-radius: 6px; background: var(--accent); color: #fff; font-weight: 500; white-space: nowrap; }
  .primary-btn:hover { filter: brightness(1.08); }
  .danger-btn { padding: 6px 12px; border-radius: 6px; color: var(--danger); }
  .danger-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .danger-btn.solid { background: var(--danger); color: #fff; }
  .small { padding: 4px 10px; font-size: 13px; }

  .views { display: flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .views button { padding: 5px 12px; }
  .views button + button { border-left: 1px solid var(--line); }
  .views button:hover { background: var(--hover); }
  .views button.on { background: var(--accent); color: #fff; }

  .body { display: flex; flex: 1; min-height: 0; position: relative; }
  .sync-overlay {
    position: absolute; inset: 0; z-index: 30; display: grid; place-items: center; padding: 16px;
    background: color-mix(in srgb, var(--bg) 88%, transparent); text-align: center;
  }
  .sync-overlay p { margin: 6px 0 12px; color: var(--muted); font-size: 13px; }
  .save-status { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .view-only {
    padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap;
    color: var(--text); background: color-mix(in srgb, #f59e0b 22%, transparent);
  }
  .lock { display: inline-grid; place-items: center; margin-left: auto; color: var(--muted); flex-shrink: 0; }
  .lock + .sub-state { margin-left: 4px; }
  .private-note { margin: 0; font-size: 12px; color: var(--muted); }
  .who-sees { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; border: 0; font-size: 13px; }
  .who-sees legend { padding: 0; margin-bottom: 4px; font-size: 12px; font-weight: 600; color: var(--muted); }
  .radio-line, .share-person { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .radio-line input, .share-person input { accent-color: var(--accent); margin: 0; }
  .share-list { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; margin-left: 22px; border-radius: 8px; background: var(--bg-alt); }
  .private-toggle { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--muted); cursor: pointer; }
  .private-toggle input { margin-top: 2px; accent-color: var(--accent); }
  .private-toggle strong { color: var(--text); margin-right: 4px; }
  .live-dot {
    width: 8px; height: 8px; flex-shrink: 0; border-radius: 50%;
    background: var(--muted); opacity: 0.6;
  }
  .live-dot.on { background: #22c55e; opacity: 1; box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 25%, transparent); }
  .save-status.bad {
    padding: 4px 10px; border-radius: 999px; font-weight: 600;
    color: #fff; background: var(--danger);
  }

  /* sidebar */
  .sidebar {
    width: 240px; flex-shrink: 0; display: flex; flex-direction: column;
    gap: 20px; padding: 12px; overflow-y: auto; overscroll-behavior: contain;
    border-right: 1px solid var(--line); background: var(--bg-alt);
  }
  .sidebar.drawer {
    position: absolute; top: 0; bottom: 0; left: 0; z-index: 20;
    width: min(280px, 85%); box-shadow: 4px 0 24px rgb(0 0 0 / 0.2);
  }
  .scrim { position: absolute; inset: 0; z-index: 19; background: rgb(0 0 0 / 0.35); }

  .section-head {
    padding: 0 8px 6px; font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted);
  }
  .filters { display: flex; flex-direction: column; gap: 2px; }
  .filter-row { display: flex; align-items: center; border-radius: 6px; }
  .filter-row.dragging {
    background: var(--bg); box-shadow: 0 4px 14px rgb(0 0 0 / 0.22);
    position: relative; z-index: 2;
  }
  .filters:has(.dragging) { cursor: grabbing; }
  .grip {
    display: grid; place-items: center; width: 18px; height: 28px; margin-left: 2px; flex-shrink: 0;
    border-radius: 4px; color: var(--muted); cursor: grab; touch-action: none;
  }
  .grip svg { fill: currentColor; }
  .grip:hover, .grip:focus-visible { color: var(--text); background: var(--hover); }
  .filter-row.dragging .grip { cursor: grabbing; color: var(--text); }
  .filter-row .grip + .filter { padding-left: 4px; }
  .filter-row:hover { background: var(--hover); }
  .filter {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px;
    padding: 6px 8px; cursor: pointer; user-select: none;
  }
  .filter-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .filter input { position: absolute; opacity: 0; pointer-events: none; }
  .filter .box {
    width: 16px; height: 16px; flex-shrink: 0; border-radius: 4px;
    border: 2px solid var(--c); display: grid; place-items: center;
  }
  .filter input:checked + .box { background: var(--c); }
  .filter input:checked + .box::after {
    content: ''; width: 4px; height: 8px; margin-top: -2px;
    border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
  }
  .filter input:focus-visible + .box { outline: 2px solid var(--accent); outline-offset: 2px; }
  .edit-cal { margin-right: 4px; color: var(--muted); }
  @media (hover: hover) {
    .grip { opacity: 0; }
    .filter-row:hover .grip, .grip:focus-visible, .filter-row.dragging .grip { opacity: 1; }
  }
  .edit-cal:hover { color: var(--text); }
  @media (hover: hover) {
    .edit-cal { opacity: 0; }
    .filter-row:hover .edit-cal, .edit-cal:focus-visible { opacity: 1; }
  }

  .add-link { margin-top: 4px; padding: 6px 8px; width: 100%; text-align: left; border-radius: 6px; color: var(--accent); }
  .add-link:hover { background: var(--hover); }
  .cal-form {
    margin: 4px 0; padding: 10px; display: flex; flex-direction: column; gap: 8px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--bg);
  }
  .add-row { display: flex; gap: 8px; align-items: center; }
  .color-input {
    width: 32px; height: 32px; padding: 0; flex-shrink: 0; cursor: pointer;
    border: 1px solid var(--line); border-radius: 6px; background: none;
  }
  .color-input::-webkit-color-swatch-wrapper { padding: 3px; }
  .color-input::-webkit-color-swatch { border: 0; border-radius: 4px; }
  .color-input::-moz-color-swatch { border: 0; border-radius: 4px; }
  .name-input {
    flex: 1; min-width: 0; font: inherit; color: inherit; padding: 6px 8px;
    border: 1px solid var(--line); border-radius: 6px; background: var(--bg-alt);
  }
  .name-input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .swatches { display: flex; flex-wrap: wrap; gap: 6px; }
  .swatch { width: 18px; height: 18px; border-radius: 50%; background: var(--c); }
  .swatch.picked { outline: 2px solid var(--text); outline-offset: 2px; }
  .confirm { margin: 0; font-size: 13px; }
  .form-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

  .mini-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-weight: 600; }
  .mini-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; text-align: center; }
  .mini-wd { font-size: 11px; color: var(--muted); padding: 4px 0; }
  .mini-day { height: 28px; border-radius: 6px; font-size: 13px; }
  .mini-day:hover { background: var(--hover); }
  .mini-day.weekend { color: var(--muted); }
  .mini-day.out { opacity: 0.4; }
  .mini-day.in-range { background: var(--accent-soft); }
  .mini-day.today { font-weight: 700; color: var(--accent); }
  .mini-day.selected { background: var(--accent); color: #fff; }

  /* main area */
  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }

  /* day / week */
  .time-view { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .head-row, .strip-row, .grid { display: grid; grid-template-columns: var(--gutter) repeat(var(--n), minmax(0, 1fr)); }
  .head-row, .strip-row { overflow: hidden; scrollbar-gutter: stable; }
  .head-row { border-bottom: 1px solid var(--line); }
  .col-head {
    padding: 10px 8px; font-weight: 500; text-align: center;
    border-left: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .col-head:hover { background: var(--hover); }
  .col-head.today { color: var(--accent); font-weight: 700; }

  .strip-row { border-bottom: 1px solid var(--line); max-height: 100px; overflow-y: auto; flex-shrink: 0; overscroll-behavior: contain; }
  .strip-label { padding: 6px 8px 0 0; font-size: 11px; color: var(--muted); text-align: right; }
  .strip {
    grid-column: 2 / -1; display: grid; position: relative;
    grid-template-columns: repeat(var(--n), minmax(0, 1fr));
    grid-template-rows: repeat(var(--rows), 22px);
    row-gap: 2px; padding: 3px 0;
  }
  .strip-col { grid-row: 1 / -1; border-left: 1px solid var(--line); margin: -3px 0; }
  .strip-col:hover { background: var(--hover); }
  .strip-col.drop { background: var(--accent-soft); }
  .bar {
    position: relative; z-index: 1; margin: 0 3px; padding: 0 8px; min-width: 0;
    border-radius: 4px; background: var(--c); color: #fff;
    font-size: 12px; font-weight: 600; text-align: left; line-height: 22px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .bar.cont-left { margin-left: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }
  .bar.cont-right { margin-right: 0; border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .bar.dragging { opacity: 0.75; box-shadow: 0 4px 12px rgb(0 0 0 / 0.25); }

  .scroll-wrap { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }
  /* the time grid scrolls up and down only, and at its top/bottom the page doesn't take over */
  .scroll { flex: 1; overflow-y: auto; scrollbar-gutter: stable; overscroll-behavior: contain; touch-action: pan-y pinch-zoom; }
  .offscreen {
    position: absolute; left: 50%; transform: translateX(-50%); z-index: 5;
    padding: 3px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
    background: var(--accent); color: #fff; box-shadow: 0 2px 8px rgb(0 0 0 / 0.25);
  }
  .offscreen.top { top: 6px; }
  .offscreen.bottom { bottom: 6px; }
  .offscreen:hover { filter: brightness(1.08); }
  .grid { position: relative; }
  .gutter { display: flex; flex-direction: column; }
  .hour-label { height: var(--hh); flex-shrink: 0; padding: 4px 8px 0 0; font-size: 12px; color: var(--muted); text-align: right; }

  .day-col {
    position: relative; border-left: 1px solid var(--line);
    background-image: linear-gradient(var(--line) 1px, transparent 1px);
    background-size: 100% var(--hh);
    cursor: cell;
  }
  .day-col.weekend { background-color: var(--weekend); }

  .event {
    position: absolute; overflow: hidden;
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
    padding: 4px 8px; text-align: left; border-radius: 6px;
    border-left: 3px solid var(--c);
    background: color-mix(in srgb, var(--c) 16%, var(--bg));
    cursor: grab;
  }
  .event:hover { filter: brightness(0.96); }
  .cal.dark .event:hover { filter: brightness(1.15); }
  .event:focus-visible { outline: 2px solid var(--c); outline-offset: 1px; }
  .event.cont-top { border-top-left-radius: 0; border-top-right-radius: 0; }
  .event.cont-bottom { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .event.dragging { opacity: 0.35; }
  .event.ghost {
    pointer-events: none; z-index: 3;
    border: 1px dashed var(--c); border-left: 3px solid var(--c);
    background: color-mix(in srgb, var(--c) 26%, var(--bg));
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.18);
  }
  .ev-time { font-size: 11px; color: var(--muted); white-space: nowrap; }
  .ev-title, .ev-loc { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .ev-title { font-weight: 600; }
  .ev-loc { font-size: 12px; color: var(--muted); }
  .resize-handle { position: absolute; left: 0; right: 0; bottom: 0; height: 8px; cursor: ns-resize; }
  .resize-handle::after {
    content: ''; position: absolute; left: 50%; bottom: 2px; width: 18px; height: 3px; margin-left: -9px;
    border-radius: 2px; background: var(--c); opacity: 0; transition: opacity 0.15s;
  }
  .event:hover .resize-handle::after { opacity: 0.6; }

  .now-line { position: absolute; left: 0; right: 0; height: 2px; background: #e5484d; pointer-events: none; z-index: 2; }
  .now-line::before {
    content: ''; position: absolute; left: -5px; top: -4px;
    width: 10px; height: 10px; border-radius: 50%; background: #e5484d;
  }

  /* month */
  .month { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .m-head { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); border-bottom: 1px solid var(--line); }
  .m-head div { padding: 6px 4px; font-size: 11px; font-weight: 600; color: var(--muted); text-align: center; text-transform: uppercase; letter-spacing: 0.02em; }
  .m-grid {
    flex: 1; min-height: 0; display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    grid-template-rows: repeat(var(--rows), minmax(0, 1fr));
  }
  /* only lines between the weeks, like a phone's month view; bars run on from one day to the next */
  .m-cell {
    --pad: 3px;
    min-height: 0; min-width: 0; padding: 2px var(--pad) 3px; display: flex; flex-direction: column; gap: 2px;
    border-top: 1px solid var(--line); overflow: hidden; cursor: cell;
  }
  .m-cell.out > * { opacity: 0.4; }
  .m-cell.drop { background: var(--accent-soft); }
  .m-num { align-self: center; min-width: 24px; height: 24px; padding: 0 5px; border-radius: 12px; font-size: 13px; font-weight: 500; flex-shrink: 0; }
  .m-cell.weekend .m-num { color: var(--muted); }
  .m-num:hover { background: var(--hover); }
  .m-cell .m-num.today { background: var(--today); color: #fff; font-weight: 700; }
  .m-list { display: flex; flex-direction: column; gap: 2px; min-height: 0; }
  .gap { height: 18px; flex-shrink: 0; }
  /* timed events: a light wash of the calendar's color, the title in a deeper shade of it */
  .chip {
    display: flex; align-items: center; gap: 4px; height: 18px; padding: 0 5px; min-width: 0; flex-shrink: 0;
    border-radius: 4px; font-size: 11.5px; font-weight: 500; text-align: left; cursor: grab;
    background: color-mix(in srgb, var(--c) 16%, transparent);
    color: color-mix(in srgb, var(--c) 62%, var(--text));
  }
  .chip:hover { background: color-mix(in srgb, var(--c) 26%, transparent); }
  /* all-day and multi-day events: solid bars, squared off where they carry on to the next day */
  .chip.long { background: var(--c); color: #fff; font-weight: 600; }
  .chip.long:hover { filter: brightness(1.08); }
  .chip.join-l { margin-left: calc(-1 * var(--pad)); border-top-left-radius: 0; border-bottom-left-radius: 0; padding-left: calc(5px + var(--pad)); }
  .chip.join-r { margin-right: calc(-1 * var(--pad)); border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .chip.dragging { opacity: 0.4; }
  .chip-time { margin-left: auto; padding-left: 2px; color: var(--muted); font-weight: 400; flex-shrink: 0; }
  .chip-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .more { height: 20px; padding: 0 6px; font-size: 12px; font-weight: 600; text-align: left; color: var(--muted); border-radius: 4px; }
  .more:hover { background: var(--hover); color: var(--text); }

  /* editor dialog */
  .editor {
    width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 0;
    border: 1px solid var(--line); border-radius: 10px;
    background: var(--bg); color: var(--text);
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.25);
  }
  .editor::backdrop { background: rgb(0 0 0 / 0.35); }
  .editor form { display: flex; flex-direction: column; gap: 12px; padding: 20px; }
  .editor h3 { margin: 0; font-size: 17px; }
  .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .field > span { font-size: 12px; color: var(--muted); font-weight: 500; }
  .field input, .field select, .field textarea {
    font: inherit; color: inherit; padding: 8px 10px;
    border: 1px solid var(--line); border-radius: 6px; background: var(--bg-alt);
  }
  .field textarea { resize: vertical; min-height: 60px; }
  .field input:focus, .field select:focus, .field textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .grow { flex: 1 1 160px; }
  .toggle { display: flex; align-items: center; gap: 6px; padding: 9px 4px; cursor: pointer; }

  /* import */
  .cal { position: relative; }
  .add-link { display: flex; align-items: center; gap: 6px; }
  .add-link + .add-link { margin-top: 0; }
  fieldset.bare { margin: 0; padding: 0; border: 0; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  fieldset.bare:disabled input, fieldset.bare:disabled select, fieldset.bare:disabled textarea { opacity: 0.85; cursor: default; }
  .sub-state {
    display: inline-grid; place-items: center; width: 16px; height: 16px; flex-shrink: 0; margin-left: auto;
    color: var(--muted); font-size: 11px; font-weight: 800;
  }
  .sub-state.bad { color: #fff; background: var(--danger); border-radius: 50%; }
  .sub-state.spin svg { animation: cal-spin 1s linear infinite; }
  @keyframes cal-spin { to { transform: rotate(360deg); } }
  .help { font-size: 12px; color: var(--muted); }
  .help summary { cursor: pointer; color: var(--accent); font-weight: 500; }
  .help ol { margin: 6px 0; padding-left: 18px; color: var(--text); }
  .help li + li { margin-top: 3px; }
  .help p { margin: 4px 0 0; }
  .help code { font-size: 11px; }
  .sync-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); }
  .sync-row .bad { color: var(--danger); }
  .event.readonly, .chip.readonly, .bar.readonly { cursor: pointer; }
  .import-summary { margin: -4px 0 0; color: var(--muted); font-size: 13px; }
  .warn-box {
    padding: 10px 12px; border-radius: 8px; font-size: 13px;
    background: color-mix(in srgb, #f59e0b 14%, var(--bg)); border: 1px solid color-mix(in srgb, #f59e0b 40%, var(--bg));
  }
  .warn-box ul { margin: 6px 0 0; padding-left: 18px; }
  .warn-box li + li { margin-top: 4px; }
  .warn-box p { margin: 6px 0 0; }
  .drop-overlay {
    position: absolute; inset: 0; z-index: 50; display: grid; place-items: center; pointer-events: none;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    border: 3px dashed var(--accent); border-radius: 8px;
  }
  .drop-overlay div {
    padding: 12px 20px; border-radius: 8px; font-weight: 600;
    background: var(--bg); color: var(--text); box-shadow: 0 6px 24px rgb(0 0 0 / 0.25);
  }
  .toast {
    position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 40;
    display: flex; align-items: center; gap: 12px; max-width: calc(100% - 32px);
    padding: 10px 10px 10px 16px; border-radius: 8px;
    background: var(--text); color: var(--bg); box-shadow: 0 8px 28px rgb(0 0 0 / 0.3);
  }
  .toast-btn { font-weight: 700; color: var(--accent); padding: 4px 8px; border-radius: 6px; }
  .cal:not(.dark) .toast-btn { color: #93c5fd; }
  .cal.dark .toast-btn { color: #1d4ed8; }
  .toast-close { font-size: 18px; line-height: 1; padding: 2px 6px; opacity: 0.7; }
  .toast-close:hover { opacity: 1; }
  .toggle input { width: 16px; height: 16px; accent-color: var(--accent); }
  .hint { margin: 0; font-size: 13px; color: var(--muted); }
  .hint.summary { color: var(--text); font-weight: 500; }

  .repeat-panel {
    margin: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--bg-alt);
  }
  .repeat-panel.ends { min-width: 0; }
  .repeat-panel input, .repeat-panel select {
    font: inherit; color: inherit; padding: 6px 8px;
    border: 1px solid var(--line); border-radius: 6px; background: var(--bg);
  }
  .repeat-panel input.dim { opacity: 0.5; }
  .repeat-panel input:focus, .repeat-panel select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .repeat-panel .num { width: 70px; }
  .inline { display: flex; align-items: center; gap: 8px; }
  .sub-label { padding: 0; font-size: 12px; font-weight: 500; color: var(--muted); }
  .wd-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .wd {
    width: 34px; height: 34px; border-radius: 50%; font-size: 13px; font-weight: 600;
    border: 1px solid var(--line); background: var(--bg);
  }
  .wd:hover { border-color: var(--accent); }
  .wd.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .radios { display: flex; flex-direction: column; gap: 6px; }
  .radio { display: flex; align-items: center; gap: 8px; min-height: 34px; cursor: pointer; }
  .radio input[type='radio'] { width: 16px; height: 16px; margin: 0; padding: 0; accent-color: var(--accent); }
  .error { margin: 0; color: var(--danger); font-size: 13px; }

  @media (max-width: 720px) {
    .cal { --gutter: 44px; }
    .toolbar { padding: 6px 8px; gap: 6px; }
    .title { order: 10; flex-basis: 100%; margin: 0; font-size: 15px; }
    .label { display: none; }
    .views button { padding: 5px 9px; }
    .col-head { font-size: 12px; padding: 8px 2px; }
    .event { padding: 2px 4px; }
    .ev-time { display: none; }
    .chip-time { display: none; }
    .m-cell { --pad: 1px; }
    .chip { padding: 0 3px; font-size: 10.5px; }
    .chip.join-l { padding-left: calc(3px + var(--pad)); }
    .m-num { font-size: 12px; min-width: 22px; height: 22px; }
  }
</style>
