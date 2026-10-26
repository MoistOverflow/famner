<script>
  import { onMount } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { pointsText } from '$lib/choreText.js';
  import { net } from '$lib/offline.svelte.js';

  let { data, children } = $props();
  const me = $derived(page.data.user);
  const adult = $derived(me?.role === 'admin' || me?.role === 'parent');
  const isKiosk = $derived(me?.role === 'kiosk');
  const s = $derived(data.chores);
  const reviewCount = $derived(s.toReview + s.toHandOut);

  // live: reload this section's data whenever anything changes on another device
  let live = $state('connecting');
  onMount(() => {
    let es = null, stopped = false, timer = 0, tries = 0;
    const refresh = () => invalidate('app:chores');
    const connect = () => {
      es = new EventSource('/api/chores/live');
      es.addEventListener('hello', (e) => { tries = 0; if (JSON.parse(e.data).rev !== s.rev) refresh(); });
      es.addEventListener('change', (e) => { if (JSON.parse(e.data).rev !== s.rev) refresh(); });
      es.onopen = () => (live = 'live');
      es.onerror = () => {
        live = 'offline';
        if (es.readyState === EventSource.CLOSED && !stopped) {
          fetch('/api/me', { cache: 'no-store' }).then((r) => {
            if (r.status === 401) location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
          }).catch(() => {});
          clearTimeout(timer);
          timer = setTimeout(connect, Math.min(30000, 2000 * 2 ** tries++));
        }
      };
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && es?.readyState === EventSource.CLOSED && !stopped) { clearTimeout(timer); connect(); }
    };
    document.addEventListener('visibilitychange', onVisible);
    connect();
    return () => { stopped = true; clearTimeout(timer); es?.close(); document.removeEventListener('visibilitychange', onVisible); };
  });

  const tabs = $derived([
    { href: '/chores', label: 'Chores' },
    { href: '/chores/rewards', label: 'Rewards' },
    ...(adult || isKiosk ? [{ href: '/chores/review', label: 'Review', count: reviewCount }] : [])
  ]);
</script>

<div class="chores-page">
  <header class="head">
    <h1>Chores</h1>
    <div class="head-right">
      <span
        class="live-dot"
        class:on={live === 'live'}
        role="img"
        aria-label={live === 'live' ? 'Live updates on' : 'Reconnecting for live updates'}
        title={live === 'live' ? 'Live: changes from other devices show up instantly' : 'Reconnecting…'}
      ></span>
      {#if !isKiosk}
      <a class="points" href="/chores/rewards" title="Your points: spend them on rewards">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></svg>
        {pointsText(s.balances[me.id] ?? 0)}
      </a>
      {/if}
    </div>
  </header>

  <nav class="tabs" aria-label="Chores sections">
    {#each tabs as t (t.href)}
      <a href={t.href} class:on={page.url.pathname === t.href} aria-current={page.url.pathname === t.href ? 'page' : undefined}>
        {t.label}
        {#if t.count}<span class="badge" aria-label="{t.count} waiting">{t.count}</span>{/if}
      </a>
    {/each}
  </nav>

  <!-- without a connection the chores can be looked at but not changed (points are checked by the server) -->
  <fieldset class="offline-lock" disabled={net.offline}>
    {@render children()}
  </fieldset>
</div>

<style>
  .offline-lock { margin: 0; padding: 0; border: 0; min-width: 0; }
  .offline-lock:disabled { opacity: 0.75; }
  .chores-page { max-width: 760px; margin: 0 auto; padding: 20px 16px 96px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  h1 { margin: 0; font-size: 24px; }
  .head-right { display: flex; align-items: center; gap: 12px; }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--app-muted); opacity: 0.6; }
  .live-dot.on { background: #22c55e; opacity: 1; box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 25%, transparent); }
  .points {
    display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; text-decoration: none;
    font-weight: 700; font-size: 14px; color: var(--app-text); background: color-mix(in srgb, #f59e0b 22%, transparent);
  }
  .points svg { fill: #f59e0b; }
  .tabs { display: flex; gap: 4px; margin-bottom: 18px; border-bottom: 1px solid var(--app-line); }
  .tabs a {
    display: flex; align-items: center; gap: 6px; padding: 8px 14px; margin-bottom: -1px; border-bottom: 2px solid transparent;
    color: var(--app-muted); text-decoration: none; font-weight: 600; font-size: 14px;
  }
  .tabs a:hover { color: var(--app-text); }
  .tabs a.on { color: var(--app-text); border-bottom-color: var(--app-accent); }
  .badge { min-width: 18px; padding: 1px 6px; border-radius: 999px; font-size: 11px; text-align: center; color: #fff; background: #e5484d; }

  /* shared by the chores pages */
  :global(.chores-page .section-title) { margin: 22px 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--app-muted); }
  :global(.chores-page .rows) { list-style: none; margin: 0; padding: 0; border-radius: 12px; border: 1px solid var(--app-line); background: var(--app-surface); overflow: hidden; }
  :global(.chores-page .rows > li + li) { border-top: 1px solid var(--app-line); }
  :global(.chores-page .empty) { padding: 20px 0; color: var(--app-muted); text-align: center; }
  :global(.chores-page .chip) { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; background: var(--app-hover); color: var(--app-muted); }
  :global(.chores-page .chip.good) { background: color-mix(in srgb, #22c55e 20%, transparent); color: var(--app-text); }
  :global(.chores-page .chip.warn) { background: color-mix(in srgb, #f59e0b 22%, transparent); color: var(--app-text); }
  :global(.chores-page .chip.bad) { background: color-mix(in srgb, #e5484d 20%, transparent); color: var(--app-text); }
  :global(.chores-page .chip.wait) { background: color-mix(in srgb, var(--app-accent) 20%, transparent); color: var(--app-text); }
  :global(.chores-page .pts) { font-weight: 700; color: #d97706; white-space: nowrap; }
  :global(:root:is([data-theme='dark'], [data-theme='oled']) .chores-page .pts) { color: #fbbf24; }
</style>
