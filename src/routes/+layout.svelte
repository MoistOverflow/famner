<script>
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { ui, setTheme, followAccount, isDark, THEMES } from '$lib/theme.svelte.js';
  import { ROLE_TEXT } from '$lib/roles.js';
  import { listen } from '$lib/liveStream.js';
  import { notify, notificationsOn, notificationsSupported, groceryAlertsOn, pushActive, syncPush, registerServiceWorker } from '$lib/notify.js';
  import { itemText } from '$lib/groceryText.js';
  import { kiosk, syncKiosk, lockNow, touchKiosk, unlockFor } from '$lib/kiosk.svelte.js';
  import PinPad from '$lib/components/PinPad.svelte';
  import { net, watchNetwork, rememberUser, clearOfflineData } from '$lib/offline.svelte.js';

  let { children } = $props();

  const user = $derived(page.data.user);
  let menuOpen = $state(false);

  // ---------- offline ----------
  $effect(() => watchNetwork());
  $effect(() => { if (userId) untrack(() => rememberUser(userId)); }); // someone else signed in here → forget the last person's data
  const savedText = $derived(net.savedAt
    ? new Date(net.savedAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    : '');

  // ---------- the kiosk (shared tablet) ----------
  $effect(() => {
    const user = page.data.user, acting = page.data.acting, people = page.data.people;
    untrack(() => syncKiosk(user, acting, people)); // only re-run when the page data changes, not the unlock
  });
  let nowTick = $state(Date.now());
  $effect(() => {
    if (!kiosk.acting) return;
    const t = setInterval(() => (nowTick = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const secondsLeft = $derived(kiosk.acting ? Math.max(0, Math.ceil((kiosk.acting.until - nowTick) / 1000)) : 0);
  let menuEl = $state();

  const initials = (name) => (name ?? '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  // ---------- what needs attention: the Chores badge and reminders ----------
  let summary = $state(null);
  let clock = $state(Date.now());
  const endOfToday = $derived(new Date(new Date(clock).setHours(23, 59, 59, 999)).getTime());
  const attention = $derived.by(() => {
    if (!summary || !user) return { total: 0, text: '' };
    const due = summary.mine.filter((c) => c.status === 'open' && c.due <= endOfToday).length;
    const adult = user.role === 'admin' || user.role === 'parent';
    const review = adult ? summary.submitted.length : 0;
    const handOut = adult ? summary.handOut : 0;
    const parts = [];
    if (due) parts.push(`${due} chore${due === 1 ? '' : 's'} due today`);
    if (review) parts.push(`${review} to review`);
    if (handOut) parts.push(`${handOut} reward${handOut === 1 ? '' : 's'} to hand out`);
    return { total: due + review + handOut, text: parts.join(', ') };
  });

  const personName = (id) => page.data.people?.find((p) => p.id === id)?.name ?? 'Someone';
  const RESULT = {
    approved: (r) => `${personName(r.reviewedBy)} approved “${r.title}” · +${r.points}`,
    bonus: (r) => `${personName(r.reviewedBy)} gave you ${r.points} points for “${r.title}” 🎉`,
    reduced: (r) => `${personName(r.reviewedBy)} gave ${r.points} of ${r.possible} points for “${r.title}”`,
    denied: (r) => `${personName(r.reviewedBy)} didn’t accept “${r.title}”`
  };

  // Devices with Web Push get these from the server (push.js), even when closed; the rest get them
  // from the app itself, while it's open.
  let seen = null; // ids already known, so only new things notify
  function remindAbout(next) {
    const hidden = document.visibilityState !== 'visible';
    if (seen && hidden && !pushActive()) {
      for (const c of next.submitted) {
        if (!seen.has(`s:${c.id}:${c.at}`)) notify(`${personName(c.assignee)} finished “${c.title}”`, { body: 'Tap to review it.', url: '/chores/review', tag: `submitted-${c.id}` });
      }
      for (const r of next.results) {
        if (!seen.has(`r:${r.id}`) && RESULT[r.outcome]) notify(RESULT[r.outcome](r), { body: r.reason ? `“${r.reason}”` : '', url: '/chores', tag: `result-${r.id}` });
      }
    }
    seen = new Set([...next.submitted.map((c) => `s:${c.id}:${c.at}`), ...next.results.map((r) => `r:${r.id}`)]);
  }

  function dueReminders() {
    if (!summary || !notificationsOn() || pushActive()) return;
    const soon = Date.now() + 30 * 60000;
    for (const c of summary.mine) {
      if (c.status !== 'open' || c.due <= Date.now() || c.due > soon) continue;
      const key = `reminded:${c.id}:${c.due}`;
      try { if (localStorage.getItem(key)) continue; localStorage.setItem(key, '1'); } catch {}
      notify(`“${c.title}” is due soon`, { body: `Due at ${new Date(c.due).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`, url: '/chores', tag: `due-${c.id}` });
    }
  }

  // ---------- "someone added groceries": one notification once they've stopped adding ----------
  const GROCERY_QUIET = 2 * 60000; // wait until nothing new was added for this long…
  const GROCERY_MAX = 10 * 60000;  // …but not longer than this after the first item
  let groceryPending = new Map();  // id → item, added by someone else since the last notification
  let groceryTimer = 0, groceryFirst = 0;
  function groceriesChanged(msg) {
    const added = new Set((msg.added ?? []).map(String));
    let grew = false;
    for (const item of msg.changes?.upsert ?? []) {
      const id = String(item.id);
      if (added.has(id)) {
        if (item.createdBy !== userId && !item.done) { groceryPending.set(id, item); grew = true; }
      } else if (groceryPending.has(id)) {
        if (item.done) groceryPending.delete(id); // already bought: no need to tell anyone
        else groceryPending.set(id, item);        // e.g. the quantity went up
      }
    }
    for (const id of msg.changes?.delete ?? []) groceryPending.delete(String(id));
    if (!groceryPending.size) { clearTimeout(groceryTimer); groceryFirst = 0; return; }
    if (!grew) return;
    groceryFirst ||= Date.now();
    clearTimeout(groceryTimer);
    groceryTimer = setTimeout(sendGroceryAlert, Math.max(0, Math.min(GROCERY_QUIET, groceryFirst + GROCERY_MAX - Date.now())));
  }
  function sendGroceryAlert() {
    const items = [...groceryPending.values()];
    groceryPending = new Map();
    groceryFirst = 0;
    if (!items.length || !groceryAlertsOn() || pushActive()) return;
    if (document.visibilityState === 'visible' && page.url.pathname.startsWith('/groceries')) return; // looking at the list already
    const who = [...new Set(items.map((i) => personName(i.createdBy)))];
    const whoText = who.length < 3 ? who.join(' and ') : `${who.slice(0, -1).join(', ')} and ${who.at(-1)}`;
    const names = items.map(itemText);
    notify(items.length === 1 ? `${whoText} added ${names[0]} to Groceries` : `${whoText} added ${items.length} items to Groceries`, {
      body: items.length === 1 ? '' : names.slice(0, 6).join(', ') + (names.length > 6 ? `, and ${names.length - 6} more` : ''),
      url: '/groceries',
      tag: 'groceries-added'
    });
  }

  // (keyed on the id, so moving between pages doesn't reconnect)
  const userId = $derived(user?.id ?? null);
  const mustChange = $derived(!!user?.mustChangePassword);
  $effect(() => {
    const id = userId;
    if (!id || mustChange) { summary = null; seen = null; return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/chores?view=summary', { cache: 'no-store' });
        if (!r.ok || !alive) return;
        const next = await r.json();
        remindAbout(next);
        summary = next;
        dueReminders();
      } catch {}
    };
    load();
    registerServiceWorker();
    if (notificationsOn()) syncPush(); // keeps this device's push subscription with whoever is signed in
    const stop = listen('/api/chores/live', { onChange: load, onHello: load });
    // grocery alerts (only where this device can show notifications at all)
    const stopGroceries = notificationsSupported() ? listen('/api/lists/groceries/live', { onChange: groceriesChanged }) : () => {};
    const t = setInterval(() => { clock = Date.now(); dueReminders(); }, 60000);
    return () => {
      alive = false; stop(); stopGroceries(); clearInterval(t);
      clearTimeout(groceryTimer); groceryPending = new Map(); groceryFirst = 0;
    };
  });

  // close the account menu on navigation, outside clicks and Escape
  $effect(() => { page.url.pathname; menuOpen = false; });
  function onWindowPointer(e) {
    if (menuOpen && !menuEl?.contains(e.target)) menuOpen = false;
    if (kiosk.acting) touchKiosk(); // being used: stay unlocked
  }
  function onWindowKey(e) { if (e.key === 'Escape') menuOpen = false; }

  const links = [
    { href: '/', label: 'Calendar', icon: 'calendar' },
    { href: '/chores', label: 'Chores', icon: 'chores' },
    { href: '/groceries', label: 'Groceries', icon: 'groceries' }
  ];

  const isActive = (href) =>
    href === '/' ? page.url.pathname === '/' : page.url.pathname === href || page.url.pathname.startsWith(href + '/');

  // ---------- iPhone home-screen app: room for the status bar ----------
  // iOS 26 runs installed web apps underneath the status bar but reports too little room for it
  // (env(safe-area-inset-top) comes out too small), so the top bar ends up in the blurred strip.
  // When the page really does start at the very top of the screen, use the status bar height of
  // the iPhone model instead (iOS points, by screen height); otherwise leave it to iOS.
  const STATUS_BAR = { 667: 20, 736: 20, 812: 50, 844: 47, 852: 59, 874: 62, 896: 48, 926: 47, 932: 59, 956: 62 };
  $effect(() => {
    const ios = /iP(hone|od)/.test(navigator.userAgent);
    const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    if (!ios || !installed) return;
    const measure = () => {
      const portrait = window.innerHeight > window.innerWidth;
      const tall = Math.max(screen.height, screen.width);
      const underStatusBar = portrait && window.innerHeight >= tall - 2; // the page starts at the top edge
      const px = underStatusBar ? STATUS_BAR[tall] ?? (tall >= 852 ? 62 : tall >= 812 ? 50 : 20) : 0;
      document.documentElement.style.setProperty('--ios-top', `${px}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('orientationchange', measure); };
  });

  // the theme is an account setting (Account page): use it on every device this person signs in on
  $effect(() => { const t = user?.theme; untrack(() => followAccount(t)); });

  // no pinch-zoom on older iPhones, which only listen to their own gesture events
  $effect(() => {
    const stop = (e) => e.preventDefault();
    document.addEventListener('gesturestart', stop, { passive: false });
    return () => document.removeEventListener('gesturestart', stop);
  });

  // page background, scrollbars and form controls follow the theme
  $effect(() => {
    document.documentElement.dataset.theme = ui.theme;
    document.documentElement.style.colorScheme = isDark(ui.theme) ? 'dark' : 'light';
    // the phone's status bar / browser bar colour matches the top bar
    const bar = { light: '#ffffff', dark: '#1f2128', oled: '#000000' }[ui.theme] ?? '#1f2128';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bar);
  });
</script>

<svelte:window onpointerdown={onWindowPointer} onkeydown={onWindowKey} />

<div class="app" class:has-nav={user && page.url.pathname !== '/today'}>
  {#if user && page.url.pathname !== '/today'}
  <nav class="topnav" aria-label="Main">
    <a class="brand" href="/">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /></svg>
      <span>Famner</span>
    </a>

    <ul class="links">
      {#each user.mustChangePassword ? [] : links as l (l.href)}
        <li>
          <a href={l.href} class:active={isActive(l.href)} aria-current={isActive(l.href) ? 'page' : undefined}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              {#if l.icon === 'calendar'}
                <path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v13a2 2 0 01-2 2H6a2 2 0 01-2-2zM4 10h16M8 2v4M16 2v4" />
              {:else if l.icon === 'chores'}
                <path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
              {:else}
                <path d="M3 4h2l2.4 11h11.2L21 8H7M9 20a1 1 0 100-2 1 1 0 000 2zM18 20a1 1 0 100-2 1 1 0 000 2z" />
              {/if}
            </svg>
            <span>{l.label}</span>
            {#if l.href === '/chores' && attention.total}
              <b class="nav-badge" title={attention.text} aria-label={attention.text}>{attention.total}</b>
            {/if}
          </a>
        </li>
      {/each}
    </ul>


    <div class="account" bind:this={menuEl}>
      <button
        class="avatar-btn"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Account menu for {user.name}"
        onclick={() => (menuOpen = !menuOpen)}
      >{initials(user.name)}</button>
      {#if menuOpen}
        <div class="menu" role="menu">
          <div class="menu-head">
            <strong>{user.name}</strong>
            <span>{user.username} · {ROLE_TEXT[user.role]}</span>
          </div>
          {#if user.role !== 'kiosk'}<a role="menuitem" href="/account">Account</a>{/if}
          <a role="menuitem" href="/today">Today (wall view)</a>
          {#if user.role === 'kiosk'}
            <!-- the shared tablet has no Account page: its theme is chosen here -->
            <div class="menu-themes" role="group" aria-label="Theme">
              {#each THEMES as t (t.id)}
                <button type="button" role="menuitemradio" aria-checked={ui.theme === t.id} class:on={ui.theme === t.id} onclick={() => setTheme(t.id)}>{t.label}</button>
              {/each}
            </div>
          {/if}
          {#if user.role === 'admin' && !user.mustChangePassword}<a role="menuitem" href="/admin">Manage</a>{/if}
          <form method="POST" action="/logout" onsubmit={clearOfflineData}>
            <button role="menuitem" type="submit">Sign out</button>
          </form>
        </div>
      {/if}
    </div>
  </nav>
  {/if}

  {#if net.offline && user}
    <div class="offline-bar" role="status">
      <strong>Offline</strong> · showing what was saved{savedText ? ` ${savedText}` : ''}.
      Grocery changes are sent when you’re back online; chores need a connection.
    </div>
  {/if}

  {#if kiosk.on && page.url.pathname !== '/today'}
    <div class="kiosk-bar" class:unlocked={kiosk.acting} role="status">
      {#if kiosk.acting}
        <span>Unlocked for <strong>{kiosk.acting.name}</strong> · locks in {secondsLeft}s</span>
        <button onclick={lockNow}>Lock</button>
      {:else}
        <span>Shared tablet: anyone can add groceries. For everything else you’ll be asked for your PIN.</span>
        <button onclick={() => unlockFor({ title: 'Who’s using the tablet?' })}>Unlock</button>
      {/if}
    </div>
  {/if}

  <main>
    {@render children()}
  </main>
</div>

{#if kiosk.on}<PinPad />{/if}

<style>
  /* phone turned sideways (installed full screen): keep pages clear of the notch side */
  main { padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px); }
  .offline-bar {
    padding: 8px 16px; font-size: 13px; text-align: center; color: var(--app-text);
    background: color-mix(in srgb, #f59e0b 22%, var(--app-surface)); border-bottom: 1px solid var(--app-line);
  }
  .kiosk-bar {
    display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; text-align: center;
    padding: 8px 16px; font-size: 14px; background: var(--app-surface); border-bottom: 1px solid var(--app-line); color: var(--app-muted);
  }
  .kiosk-bar.unlocked { background: color-mix(in srgb, #22c55e 18%, var(--app-surface)); color: var(--app-text); }
  .kiosk-bar button {
    padding: 5px 14px; border-radius: 8px; border: 1px solid var(--app-line); background: var(--app-bg);
    color: var(--app-text); font: inherit; font-weight: 600; cursor: pointer;
  }
  :global(:root) {
    /* room for the phone's status bar: what the phone says, or our own measure when it says too little */
    --safe-top: max(env(safe-area-inset-top, 0px), var(--ios-top, 0px));
    --app-bg: #16181d;
    --app-surface: #1f2128;
    --app-text: #e4e6eb;
    --app-muted: #8d93a0;
    --app-line: #353842;
    --app-hover: #2e313a;
    --app-accent: #60a5fa;
  }
  /* OLED black: true black (pixels off on OLED screens), with just enough contrast for edges */
  :global(:root[data-theme='oled']) {
    --app-bg: #000000;
    --app-surface: #000000;
    --app-text: #e8e8ea;
    --app-muted: #8b8d94;
    --app-line: #26272b;
    --app-hover: #16171a;
    --app-accent: #60a5fa;
  }
  :global(:root[data-theme='light']) {
    --app-bg: #f4f5f7;
    --app-surface: #ffffff;
    --app-text: #2c2f3c;
    --app-muted: #8a8f9c;
    --app-line: #e6e8ec;
    --app-hover: #eef0f4;
    --app-accent: #3b82f6;
  }
  /* no rubber-band dragging of the whole page (iPhone), and never sideways: scrolling inside the
     calendar, lists etc. stays inside them; long pages still scroll normally */
  :global(html) { background: var(--app-bg); overscroll-behavior: none; overflow-x: clip; }
  /* no pinch or double-tap zoom anywhere: scrolling only (iOS ignores user-scalable=no on its own) */
  :global(html), :global(body) { touch-action: pan-x pan-y; }
  :global(body) { overscroll-behavior: none; overflow-x: clip; }
  :global(body) {
    margin: 0;
    background: var(--app-bg);
    color: var(--app-text);
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }

  /* The top bar is fixed (not sticky) and solid: then iOS 26 doesn't blur it in the home-screen app
     (its "scroll edge effect" softens ~40pt below the status bar, except over a fixed, full-width,
     single-colour bar). The page starts below it. */
  .app.has-nav { padding-top: calc(52px + var(--safe-top)); }
  .topnav {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    display: flex; align-items: center; gap: 16px;
    /* installed on a phone (full screen), keep clear of the status bar / notch and the rounded sides */
    box-sizing: border-box; height: calc(52px + var(--safe-top));
    padding: var(--safe-top) max(16px, env(safe-area-inset-right, 0px)) 0 max(16px, env(safe-area-inset-left, 0px));
    background: var(--app-surface); border-bottom: 1px solid var(--app-line);
  }
  .brand {
    display: flex; align-items: center; gap: 8px;
    color: var(--app-text); text-decoration: none; font-weight: 700; font-size: 16px;
  }
  .links { display: flex; gap: 4px; margin: 0; padding: 0; list-style: none; flex: 1; }
  .links a {
    display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-radius: 8px;
    color: var(--app-muted); text-decoration: none; font-weight: 500; font-size: 14px;
  }
  .links a:hover { color: var(--app-text); background: var(--app-hover); }
  .links a.active { color: var(--app-text); background: color-mix(in srgb, var(--app-accent) 18%, transparent); }
  .links a.active svg { color: var(--app-accent); }
  .links a { position: relative; }
  .nav-badge {
    min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; box-sizing: border-box;
    display: inline-grid; place-items: center; font-size: 11px; font-weight: 700; color: #fff; background: #e5484d;
  }
  .links svg {
    fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0;
  }
  a:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; }

  /* account menu */
  .account { position: relative; }
  .avatar-btn {
    display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; border: 0; cursor: pointer;
    background: color-mix(in srgb, var(--app-accent) 25%, transparent); color: var(--app-text); font: inherit; font-weight: 700; font-size: 13px;
  }
  .avatar-btn:hover { filter: brightness(1.1); }
  .avatar-btn:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; }
  .menu {
    position: absolute; right: 0; top: calc(100% + 8px); min-width: 220px; padding: 6px; z-index: 300;
    border-radius: 10px; border: 1px solid var(--app-line); background: var(--app-surface); box-shadow: 0 10px 30px rgb(0 0 0 / 0.25);
  }
  .menu-head { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px 10px; border-bottom: 1px solid var(--app-line); margin-bottom: 4px; }
  .menu-head span { font-size: 12px; color: var(--app-muted); }
  .menu a, .menu button {
    display: block; width: 100%; padding: 8px 10px; border-radius: 6px; border: 0; background: none; cursor: pointer;
    color: var(--app-text); text-decoration: none; text-align: left; font: inherit; font-size: 14px;
  }
  .menu a:hover, .menu button:hover { background: var(--app-hover); }

  /* shared bits for the account, sign-in and admin pages */
  :global(.auth-page) { min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; }
  :global(.auth-card) { width: min(380px, 100%); display: flex; flex-direction: column; gap: 14px; }
  :global(.auth-card h1) { margin: 0; font-size: 22px; }
  :global(.narrow-page) { max-width: 560px; margin: 0 auto; padding: 24px 16px 64px; display: flex; flex-direction: column; gap: 16px; }
  :global(.wide-page) { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
  :global(.narrow-page h1), :global(.wide-page h1) { margin: 0; font-size: 24px; }
  :global(.ui-card) { padding: 18px; border-radius: 12px; border: 1px solid var(--app-line); background: var(--app-surface); }
  :global(.ui-card h2) { margin: 0 0 12px; font-size: 16px; }
  :global(.ui-card form) { display: flex; flex-direction: column; gap: 12px; }
  :global(.ui-card form.ui-row-form) { flex-direction: row; align-items: flex-end; }
  :global(.ui-field) { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  :global(.ui-field.ui-grow) { flex: 1; }
  :global(.ui-field > span) { font-size: 12px; font-weight: 600; color: var(--app-muted); }
  :global(.ui-field small) { font-size: 12px; color: var(--app-muted); }
  :global(.ui-field input), :global(.ui-field select) {
    padding: 10px 12px; border-radius: 8px; border: 1px solid var(--app-line); background: var(--app-bg);
    color: var(--app-text); font: inherit; font-size: 16px;
  }
  :global(.ui-field input:focus), :global(.ui-field select:focus) { outline: 2px solid var(--app-accent); outline-offset: -1px; border-color: transparent; }
  :global(.ui-btn) {
    padding: 9px 14px; border-radius: 8px; border: 1px solid var(--app-line); background: none; cursor: pointer;
    color: var(--app-text); font: inherit; font-size: 14px; font-weight: 500; white-space: nowrap;
  }
  :global(.ui-btn:hover) { background: var(--app-hover); }
  :global(.ui-btn.ui-primary) { background: var(--app-accent); border-color: var(--app-accent); color: #fff; font-weight: 600; }
  :global(.ui-btn.ui-primary:hover) { filter: brightness(1.08); }
  :global(.ui-btn.ui-danger) { color: #e5484d; }
  :global(.ui-btn.ui-danger.ui-solid) { background: #e5484d; border-color: #e5484d; color: #fff; }
  :global(.ui-btn.ui-subtle) { border-color: transparent; color: var(--app-muted); align-self: flex-start; }
  :global(.ui-btn.ui-wide) { width: 100%; padding: 11px; }
  :global(.ui-btn:focus-visible) { outline: 2px solid var(--app-accent); outline-offset: 2px; }
  :global(.ui-error) { margin: 0; padding: 10px 12px; border-radius: 8px; font-size: 14px; color: var(--app-text); background: color-mix(in srgb, #e5484d 18%, transparent); }
  :global(.ui-ok) { margin: 0; padding: 10px 12px; border-radius: 8px; font-size: 14px; color: var(--app-text); background: color-mix(in srgb, #22c55e 18%, transparent); }
  :global(.ui-notice) { margin: 0; padding: 12px 14px; border-radius: 10px; background: color-mix(in srgb, var(--app-accent) 15%, transparent); }
  :global(.ui-hint) { margin: 0; font-size: 13px; color: var(--app-muted); }

  @media (max-width: 560px) {
    .topnav { gap: 8px; padding-left: max(12px, env(safe-area-inset-left, 0px)); padding-right: max(12px, env(safe-area-inset-right, 0px)); }
    .account { margin-left: auto; }

    /* phones: the pages are tabs along the bottom, within reach of a thumb. Like the top bar it's
       fixed, full width and one solid colour, and it keeps clear of the home indicator. Pages
       (and the calendar, which fills the screen) leave room for it through --app-bottom-space. */
    :global(:root:has(.app.has-nav .links li)) { --app-bottom-space: calc(56px + env(safe-area-inset-bottom, 0px)); }
    .app.has-nav { padding-bottom: var(--app-bottom-space, 0px); }
    .links {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 100;
      display: flex; gap: 0; box-sizing: border-box; height: var(--app-bottom-space, 56px);
      padding: 3px max(8px, env(safe-area-inset-right, 0px)) env(safe-area-inset-bottom, 0px) max(8px, env(safe-area-inset-left, 0px));
      background: var(--app-surface); border-top: 1px solid var(--app-line);
    }
    .links:not(:has(li)) { display: none; } /* no tabs yet (choosing a new password) */
    .links li { flex: 1; display: flex; min-width: 0; }
    .links a {
      flex: 1; flex-direction: column; justify-content: center; gap: 3px; height: 50px; padding: 0;
      font-size: 10.5px; font-weight: 600; border-radius: 10px;
    }
    .links a svg { width: 24px; height: 24px; }
    .links a:hover, .links a.active { background: none; }
    .links a.active { color: var(--app-accent); }
    .nav-badge { position: absolute; top: 2px; left: calc(50% + 6px); }
    /* while typing, the keyboard would push the bar up over what's being typed */
    :global(body:has(:is(input, textarea, select):focus)) .links { display: none; }
  }
  .menu-themes { display: flex; gap: 4px; padding: 4px 6px; }
  .menu .menu-themes button { flex: 1; padding: 6px 4px; text-align: center; font-size: 12px; border: 1px solid var(--app-line); }
  .menu .menu-themes button.on { border-color: var(--app-accent); background: color-mix(in srgb, var(--app-accent) 18%, transparent); }
</style>
