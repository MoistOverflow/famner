<script>
  import Calendar from '$lib/components/Calendar.svelte';
  import { createServerStore } from '$lib/components/calendarStore.js';
  import { ui } from '$lib/theme.svelte.js';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { listen } from '$lib/liveStream.js';
  import { kiosk, unlockFor } from '$lib/kiosk.svelte.js';

  // On the kiosk the calendar acts as the person it's unlocked as (role 'kiosk': only their own
  // events, in shared calendars), and asks for a PIN when someone wants to change something.
  const user = $derived(page.data.user?.role === 'kiosk'
    ? { id: kiosk.acting?.id ?? null, name: kiosk.acting?.name ?? 'Kiosk', role: 'kiosk' }
    : page.data.user);
  const nameOf0 = (id) => page.data.people?.find((p) => p.id === id)?.name;
  const requestUnlock = (personId) => unlockFor(personId
    ? { people: [personId], title: `${nameOf0(personId) ?? 'Their'} PIN to change this` }
    : { title: 'Who’s adding this?' });

  const STORAGE_KEY = 'svelte-calendar';

  // Events and calendars are saved in SQLite on the server (src/routes/api/calendar).
  const store = createServerStore();

  // Subscribed calendars are fetched through src/routes/api/ics/+server.js, which avoids the
  // browser's cross-site limits. Set to '' to have the browser fetch addresses directly instead.
  const ICS_PROXY = '/api/ics?url=';

  // chores shown on the calendar (read-only, a 30-minute block ending at the deadline; click → Chores)
  let choreState = $state(null);
  onMount(() => {
    const load = async () => {
      try { const r = await fetch('/api/chores', { cache: 'no-store' }); if (r.ok) choreState = await r.json(); } catch {}
    };
    load();
    return listen('/api/chores/live', { onChange: load, onHello: load });
  });
  const nameOf = (id) => page.data.people?.find((p) => p.id === id)?.name ?? 'someone';
  const overlay = $derived({
    calendars: [{ id: '__chores', label: 'Chores', color: '#f59e0b' }],
    events: (choreState?.chores ?? []).map((c) => ({
      id: `chore:${c.id}`,
      calendar: '__chores',
      title: `${c.status === 'submitted' ? '⏳ ' : ''}${c.title}${c.assignee !== user?.id ? ` · ${nameOf(c.assignee)}` : ''}`,
      start: new Date(c.due - 30 * 60000),
      end: new Date(c.due),
      notes: c.notes,
      choreId: c.id
    }))
  });

  let view = $state('week');
  let date = $state(new Date()); // start on today

  const at = (m, d, h = 0, min = 0) => new Date(2026, m - 1, d, h, min);

  // Starting data — only used the very first time, when the database is empty (and nothing was
  // saved in this browser before). After that everything comes from the server.
  let calendars = $state([
    { id: 'work', label: 'Work', color: '#3b82f6' },
    { id: 'home', label: 'Home', color: '#22a06b' },
    { id: 'holiday', label: 'Holidays', color: '#e5484d' }
  ]);

  let events = $state([
    { id: 1, calendar: 'work', title: 'Team Standup', start: at(10, 19, 9), end: at(10, 19, 9, 30), repeat: { freq: 'weekdays' } },
    { id: 2, calendar: 'work', title: 'Sprint Review', start: at(10, 19, 14), end: at(10, 19, 15), location: 'Room 4B' },
    { id: 3, calendar: 'home', title: 'Gym', start: at(10, 19, 8), end: at(10, 19, 8, 30), repeat: { freq: 'weekly' } },
    { id: 7, calendar: 'home', title: 'Gym', start: at(10, 22, 8), end: at(10, 22, 8, 30), repeat: { freq: 'weekly' } },
    { id: 4, calendar: 'home', title: 'Dentist', start: at(10, 20, 10), end: at(10, 20, 11), notes: 'Bring insurance card' },
    { id: 6, calendar: 'work', title: 'Design Sync', start: at(10, 21, 11), end: at(10, 21, 12) },
    { id: 8, calendar: 'home', title: 'Grocery Run', start: at(10, 23, 17), end: at(10, 23, 18) },
    { id: 9, calendar: 'work', title: 'Team Offsite', allDay: true, start: at(10, 28), end: at(10, 30) },
    { id: 10, calendar: 'holiday', title: 'Halloween', allDay: true, start: at(10, 31), end: at(11, 1), repeat: { freq: 'yearly' } }
  ]);
</script>

<svelte:head><title>Calendar · Famner</title></svelte:head>

<div class="page">
  <Calendar
    bind:events
    bind:calendars
    bind:date
    bind:view
    theme={ui.theme}
    {user}
    onUnlock={page.data.user?.role === 'kiosk' ? requestUnlock : null}
    people={page.data.people}
    {overlay}
    onOverlayClick={() => goto('/chores')}
    {store}
    storageKey={STORAGE_KEY}
    corsProxy={ICS_PROXY}
  />
</div>

<style>
  /* the calendar sizes itself to the space left below the nav bar */
  .page { padding: 16px 16px 0; }
  @media (max-width: 560px) { .page { padding: 8px 8px 0; } }
</style>
