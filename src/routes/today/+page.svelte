<script>
  // The wall tablet view: the time, today's and tomorrow's events, everyone's chores for today and the
  // grocery list, all updating live. Keeps the screen on while open. Opened at /today.
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { listen } from '$lib/liveStream.js';
  import { createServerStore } from '$lib/components/calendarStore.js';
  import { expandEvents, startOfDay, addDays, isLong, sameDay } from '$lib/components/calendarUtils.js';

  const people = $derived(page.data.people ?? []);
  const nameOf = (id) => people.find((p) => p.id === id)?.name ?? 'Someone';

  let now = $state(new Date());
  let cal = $state({ calendars: [], events: [] });
  let chores = $state([]);
  let groceries = $state([]);
  let problem = $state('');
  let awake = $state(false);
  let full = $state(false);

  const store = createServerStore();
  const loadCalendar = async () => { try { cal = await store.load(); problem = ''; } catch (e) { problem = 'Can’t reach the calendar right now.'; } };
  const loadChores = async () => { try { const r = await fetch('/api/chores?view=household', { cache: 'no-store' }); if (r.ok) chores = (await r.json()).chores; } catch {} };
  const loadGroceries = async () => { try { const r = await fetch('/api/lists/groceries', { cache: 'no-store' }); if (r.ok) groceries = (await r.json()).items; } catch {} };

  // ---------- keeping the screen on ----------
  let lock = null;
  async function keepAwake() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      lock = await navigator.wakeLock.request('screen');
      awake = true;
      lock.addEventListener('release', () => (awake = false));
    } catch { awake = false; }
  }

  onMount(() => {
    loadCalendar(); loadChores(); loadGroceries();
    let pending = 0;
    const soon = (fn) => () => { clearTimeout(pending); pending = setTimeout(fn, 300); };
    const stops = [
      listen('/api/calendar/live', { onChange: soon(loadCalendar), onHello: loadCalendar }),
      listen('/api/chores/live', { onChange: loadChores, onHello: loadChores }),
      listen('/api/lists/groceries/live', { onChange: loadGroceries, onHello: loadGroceries })
    ];
    const tick = setInterval(() => (now = new Date()), 10000);
    // a full refresh every 15 minutes, in case the tablet slept through something
    const refresh = setInterval(() => { loadCalendar(); loadChores(); loadGroceries(); }, 15 * 60000);
    keepAwake();
    const onVisible = () => document.visibilityState === 'visible' && keepAwake();
    const onFull = () => (full = !!document.fullscreenElement);
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('fullscreenchange', onFull);
    return () => {
      stops.forEach((s) => s());
      clearInterval(tick); clearInterval(refresh);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('fullscreenchange', onFull);
      lock?.release().catch(() => {});
    };
  });

  function toggleFull() {
    const p = document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.();
    p?.catch?.(() => {}); // some tablets (iPhone/iPad Safari) don't allow it; installing to the home screen does the same
  }

  // ---------- what to show ----------
  const today = $derived(startOfDay(now));
  const colorOf = $derived(Object.fromEntries(cal.calendars.map((c) => [c.id, c.color])));
  function dayEvents(day) {
    const occ = expandEvents(cal.events, day, addDays(day, 1));
    return occ.sort((a, b) => (isLong(b) - isLong(a)) || (a.start - b.start));
  }
  const todayEvents = $derived(dayEvents(today));
  const tomorrowEvents = $derived(dayEvents(addDays(today, 1)));
  const choresToday = $derived(chores.filter((c) => c.due < +addDays(today, 1)));
  const toBuy = $derived(groceries.filter((g) => !g.done).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));

  const clock = $derived(now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
  const dateLine = $derived(now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
  const time = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  function whenText(o, day) {
    if (isLong(o)) return 'All day';
    const starts = sameDay(o.start, day), ends = sameDay(new Date(+o.end - 1), day);
    if (starts && ends) return `${time(o.start)} – ${time(o.end)}`;
    return starts ? `From ${time(o.start)}` : ends ? `Until ${time(o.end)}` : 'All day';
  }
</script>

<svelte:head><title>Today · Famner</title></svelte:head>

<div class="kiosk">
  <header>
    <div>
      <div class="clock">{clock}</div>
      <div class="date">{dateLine}</div>
    </div>
    <div class="corner">
      {#if problem}<span class="problem">{problem}</span>{/if}
      <span class="awake" title={awake ? 'The screen stays on while this page is open' : 'This device doesn’t allow keeping the screen on'}>
        {awake ? 'Screen stays on' : ''}
      </span>
      <button onclick={toggleFull}>{full ? 'Exit full screen' : 'Full screen'}</button>
      <a href="/">Open app</a>
    </div>
  </header>

  <main class="grid">
    <section class="panel events">
      <h2>Today</h2>
      {#if todayEvents.length}
        <ul>
          {#each todayEvents as o (o.key)}
            {@const past = !isLong(o) && o.end < now}
            <li class:past>
              <span class="dot" style="background: {colorOf[o.event.calendar] ?? '#888'}"></span>
              <span class="when">{whenText(o, today)}</span>
              <span class="what">{o.event.title}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="none">Nothing on the calendar today.</p>
      {/if}

      <h2 class="later">Tomorrow</h2>
      {#if tomorrowEvents.length}
        <ul class="small">
          {#each tomorrowEvents as o (o.key)}
            <li>
              <span class="dot" style="background: {colorOf[o.event.calendar] ?? '#888'}"></span>
              <span class="when">{whenText(o, addDays(today, 1))}</span>
              <span class="what">{o.event.title}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="none">Nothing yet.</p>
      {/if}
    </section>

    <section class="panel">
      <h2>Chores today</h2>
      {#if choresToday.length}
        <ul>
          {#each choresToday as c (c.id)}
            {@const late = c.due < +now && c.status !== 'submitted'}
            <li class:late>
              <span class="status" aria-hidden="true">{c.status === 'submitted' ? '⏳' : late ? '!' : '○'}</span>
              <span class="what">{c.title}</span>
              <span class="who">{nameOf(c.assignee)}</span>
              <span class="when">{c.status === 'submitted' ? 'Done, waiting for check' : late ? 'Overdue' : time(new Date(c.due))}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="none">No chores due today.</p>
      {/if}

      <h2 class="later">Groceries · {toBuy.length}</h2>
      {#if toBuy.length}
        <p class="grocery-line">{toBuy.slice(0, 12).map((g) => (g.qty > 1 ? `${g.qty} × ${g.name}` : g.name)).join(' · ')}{toBuy.length > 12 ? ` · +${toBuy.length - 12} more` : ''}</p>
      {:else}
        <p class="none">The list is empty.</p>
      {/if}
    </section>
  </main>
</div>

<style>
  .kiosk { min-height: 100vh; box-sizing: border-box; padding: max(20px, var(--safe-top, env(safe-area-inset-top))) 28px 28px; display: flex; flex-direction: column; gap: 20px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .clock { font-size: clamp(48px, 9vw, 96px); font-weight: 700; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .date { margin-top: 8px; font-size: clamp(18px, 2.4vw, 26px); color: var(--app-muted); }
  .corner { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; font-size: 13px; color: var(--app-muted); }
  .corner button, .corner a {
    padding: 6px 12px; border-radius: 8px; border: 1px solid var(--app-line); background: none; color: var(--app-text);
    font: inherit; text-decoration: none; cursor: pointer;
  }
  .problem { color: #e5484d; font-weight: 600; }
  .grid { flex: 1; display: grid; grid-template-columns: 1.2fr 1fr; gap: 20px; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
  .panel { padding: 20px 22px; border-radius: 18px; background: var(--app-surface); border: 1px solid var(--app-line); }
  h2 { margin: 0 0 12px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--app-muted); }
  h2.later { margin-top: 24px; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  li { display: flex; align-items: baseline; gap: 12px; font-size: clamp(18px, 2.2vw, 24px); }
  .small li { font-size: clamp(15px, 1.7vw, 19px); }
  li.past { opacity: 0.45; }
  .dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; align-self: center; }
  .when { color: var(--app-muted); white-space: nowrap; min-width: 6.5em; font-variant-numeric: tabular-nums; }
  .what { flex: 1; min-width: 0; font-weight: 600; }
  .who { color: var(--app-muted); white-space: nowrap; }
  .status { width: 1.2em; text-align: center; color: var(--app-muted); }
  li.late .status, li.late .when { color: #e5484d; font-weight: 700; }
  .none { margin: 0; color: var(--app-muted); font-size: 18px; }
  .grocery-line { margin: 0; font-size: clamp(16px, 1.9vw, 20px); line-height: 1.6; }
</style>
