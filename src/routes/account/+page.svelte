<script>
  import { clearOfflineData } from '$lib/offline.svelte.js';
  import { enhance } from '$app/forms';
  import { ROLE_TEXT } from '$lib/roles.js';
  import { ui, setTheme, THEMES } from '$lib/theme.svelte.js';
  import { onMount } from 'svelte';
  import {
    notificationsSupported, notificationsOn, enableNotifications, disableNotifications, notify, groceryAlertsOn, setGroceryAlerts,
    pushActive, pushSupported, sendTestPush, syncPush
  } from '$lib/notify.js';

  // reminders on this device
  let notif = $state('unknown'); // 'on' | 'off' | 'blocked' | 'unsupported'
  const readNotif = () =>
    (notif = !notificationsSupported() ? 'unsupported' : Notification.permission === 'denied' ? 'blocked' : notificationsOn() ? 'on' : 'off');
  onMount(readNotif);
  let viaPush = $state(false);
  const readPush = () => (viaPush = pushActive());
  onMount(async () => { if (notificationsOn()) await syncPush(); readPush(); });
  async function turnOn() { await enableNotifications(); readNotif(); readPush(); }
  async function turnOff() { await disableNotifications(); readNotif(); readPush(); }
  let groceries = $state(true);
  onMount(() => (groceries = groceryAlertsOn()));
  let testResult = $state('');
  async function sendTest(delay = 0) {
    testResult = '';
    if (viaPush) {
      const r = await sendTestPush(delay);
      testResult = r.later ? `Sending in ${r.later} seconds. Close Famner or lock the screen to see it arrive like a real one.`
        : r.sent ? 'Sent through the push service. It should appear in a moment; if not, check this device’s notification settings for Famner.'
        : r.error ?? 'The push service didn’t accept it. Turn reminders off and on again.';
      return;
    }
    const shown = await notify('Famner test notification', { body: 'Reminders work on this device.', url: '/account', tag: 'test' });
    testResult = shown ? 'Sent. It should appear now; if not, check this device’s notification settings for Famner.' : 'This device didn’t show it. Check its notification settings for this site or app.';
  }

  let { data, form } = $props();

  // theme: saved to the account, so every device this person uses follows it
  let themeNote = $state('');
  async function chooseTheme(id) {
    themeNote = '';
    if (!(await setTheme(id))) themeNote = 'Changed on this device; it couldn’t be saved to your account just now.';
  }
  const user = $derived(data.user);
  const forced = $derived(user.mustChangePassword);
  const msg = (action) => (form?.action === action ? form : null);

  // iCloud
  let working = $state(false);
  let pickRemote = $state('new');
  let pickCalendar = $state('new');
  // forms that wait on iCloud: show that they're busy
  const busy = () => {
    working = true;
    return async ({ update }) => { await update(); working = false; };
  };
  const askFirst = (question) => ({ cancel }) => { if (!confirm(question)) cancel(); };
  // start with the first iCloud calendar that isn't synced yet
  $effect(() => {
    Promise.resolve(data.icloudRemote).then((r) => {
      const first = Array.isArray(r) ? r.find((c) => !c.linkedTo && c.writable) : null;
      if (first && pickRemote === 'new') pickRemote = first.url;
    });
  });
  const ago = (t) => {
    const min = Math.round((Date.now() - t) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    return h < 24 ? `${h} h ago` : new Date(t).toLocaleString();
  };
</script>

<svelte:head><title>Account · Famner</title></svelte:head>

<div class="narrow-page">
  <h1>{forced ? 'Choose a new password' : 'Your account'}</h1>

  {#if forced}
    <p class="ui-notice">You signed in with a temporary password. Pick your own to continue.</p>
  {:else}
    <section class="ui-card">
      <h2>Profile</h2>
      <p class="ui-hint">Username <strong>{user.username}</strong> · {ROLE_TEXT[user.role]}</p>
      <form method="POST" action="?/rename" use:enhance class="ui-row-form">
        <label class="ui-field ui-grow">
          <span>Name</span>
          <input name="name" value={user.name} required maxlength="60" autocomplete="name" />
        </label>
        <button class="ui-btn" type="submit">Save</button>
      </form>
      {#if msg('rename')?.error}<p class="ui-error">{msg('rename').error}</p>{/if}
      {#if msg('rename')?.message}<p class="ui-ok">{msg('rename').message}</p>{/if}
    </section>
  {/if}

  {#if !forced}
    <section class="ui-card">
      <h2>Appearance</h2>
      <div class="themes" role="radiogroup" aria-label="Theme">
        {#each THEMES as t (t.id)}
          <button type="button" role="radio" aria-checked={ui.theme === t.id} class="theme-opt" class:on={ui.theme === t.id} onclick={() => chooseTheme(t.id)}>
            <span class="swatch {t.id}" aria-hidden="true"><i></i><i></i><i></i></span>
            <span>{t.label}</span>
          </button>
        {/each}
      </div>
      <p class="ui-hint">{ui.theme === 'oled' ? 'Pure black: easiest on the battery and the eyes at night on phones with OLED screens.' : 'Used on every device you sign in on.'}</p>
      {#if themeNote}<p class="ui-hint">{themeNote}</p>{/if}
    </section>
  {/if}

  <section class="ui-card">
    <h2>Password</h2>
    <form method="POST" action="?/password" use:enhance>
      <!-- a hidden username helps password managers save the new password for the right account -->
      <input type="text" name="username" value={user.username} autocomplete="username" hidden readonly />
      <label class="ui-field">
        <span>{forced ? 'Temporary password' : 'Current password'}</span>
        <input name="current" type="password" autocomplete="current-password" required />
      </label>
      <label class="ui-field">
        <span>New password</span>
        <input name="next" type="password" autocomplete="new-password" required minlength="8" />
      </label>
      <label class="ui-field">
        <span>Confirm new password</span>
        <input name="confirm" type="password" autocomplete="new-password" required minlength="8" />
      </label>
      {#if msg('password')?.error}<p class="ui-error" role="alert">{msg('password').error}</p>{/if}
      {#if msg('password')?.message}<p class="ui-ok">{msg('password').message}</p>{/if}
      <button class="ui-btn ui-primary" type="submit">{forced ? 'Save and continue' : 'Change password'}</button>
    </form>
  </section>

  {#if !forced && user.role !== 'kiosk'}
    <section class="ui-card">
      <h2>Kiosk PIN</h2>
      <p class="ui-hint">The 4-digit PIN you type on the family tablet. To change it, enter your password too.</p>
      <form method="POST" action="?/pin" use:enhance>
        <label class="ui-field">
          <span>Password</span>
          <input name="current" type="password" autocomplete="current-password" required />
        </label>
        <label class="ui-field">
          <span>New PIN</span>
          <input name="pin" type="password" inputmode="numeric" autocomplete="off" pattern={"[0-9]{4}"} maxlength="4" required />
        </label>
        <label class="ui-field">
          <span>Type it again</span>
          <input name="confirm" type="password" inputmode="numeric" autocomplete="off" pattern={"[0-9]{4}"} maxlength="4" required />
        </label>
        {#if msg('pin')?.error}<p class="ui-error" role="alert">{msg('pin').error}</p>{/if}
        {#if msg('pin')?.message}<p class="ui-ok">{msg('pin').message}</p>{/if}
        <button class="ui-btn" type="submit">Change PIN</button>
      </form>
    </section>
  {/if}

  {#if data.icloud}
    {@const ic = data.icloud}
    <section class="ui-card">
      <h2>Apple Calendar (iCloud)</h2>
      {#if !ic.connected || ic.status === 'auth'}
        {#if ic.status === 'auth'}
          <p class="ui-error" role="alert">{ic.error}</p>
        {:else}
          <p class="ui-hint">Sync Famner calendars with your iCloud calendars, both ways. Changes on your iPhone, iPad or Mac show up here within a few minutes; changes here show up there.</p>
        {/if}
        <ol class="steps">
          <li>Go to <a href="https://account.apple.com" target="_blank" rel="noreferrer">account.apple.com</a> → <strong>Sign-In and Security</strong> → <strong>App-Specific Passwords</strong>, and make one called “Famner”.</li>
          <li>Enter your Apple ID and that password here. Your normal Apple password won’t work.</li>
        </ol>
        <form method="POST" action="?/icloudConnect" use:enhance={busy}>
          <label class="ui-field">
            <span>Apple ID</span>
            <input name="appleId" type="email" autocomplete="off" required value={ic.appleId ?? ''} placeholder="you@icloud.com" />
          </label>
          <label class="ui-field">
            <span>App-specific password</span>
            <input name="password" type="password" autocomplete="off" required placeholder="xxxx-xxxx-xxxx-xxxx" />
          </label>
          <button class="ui-btn ui-primary" type="submit" disabled={working}>{working ? 'Checking with iCloud…' : 'Connect iCloud'}</button>
        </form>
      {:else}
        <p class="ui-hint">Connected as <strong>{ic.appleId}</strong>. Synced calendars are checked every few minutes.</p>
        {#if ic.links.length}
          <ul class="syncs">
            {#each ic.links as l (l.calendarId)}
              <li>
                <div class="sync-name"><strong>{l.calendarName}</strong> ⇄ iCloud “{l.remoteName}”</div>
                {#if l.error}<p class="ui-error">{l.error}</p>
                {:else}<p class="ui-hint">{l.syncedAt ? `Synced ${ago(l.syncedAt)}` : 'Not synced yet'}</p>{/if}
                {#each l.warnings as w (w)}<p class="ui-hint">⚠ {w}</p>{/each}
                <div class="sync-actions">
                  <form method="POST" action="?/icloudSync" use:enhance={busy}>
                    <input type="hidden" name="calendar" value={l.calendarId} />
                    <button class="ui-btn" type="submit" disabled={working}>Sync now</button>
                  </form>
                  <form method="POST" action="?/icloudUnlink" use:enhance={askFirst(`Stop syncing “${l.calendarName}”? Its events stay in Famner and in iCloud.`)}>
                    <input type="hidden" name="calendar" value={l.calendarId} />
                    <button class="ui-btn ui-subtle" type="submit">Stop syncing</button>
                  </form>
                </div>
              </li>
            {/each}
          </ul>
        {/if}

        <h3>Sync {ic.links.length ? 'another' : 'a'} calendar</h3>
        {#await data.icloudRemote}
          <p class="ui-hint">Loading your iCloud calendars…</p>
        {:then remote}
          {#if remote?.error}
            <p class="ui-error">{remote.error}</p>
          {:else}
            {@const free = (remote ?? []).filter((c) => !c.linkedTo && c.writable)}
            <form method="POST" action="?/icloudLink" use:enhance={busy}>
              <label class="ui-field">
                <span>iCloud calendar</span>
                <select name="remote" bind:value={pickRemote}>
                  {#each free as c (c.url)}<option value={c.url}>{c.name}</option>{/each}
                  <option value="new">New iCloud calendar</option>
                </select>
              </label>
              <label class="ui-field">
                <span>Famner calendar</span>
                <select name="calendar" bind:value={pickCalendar}>
                  <option value="new">New Famner calendar</option>
                  {#each ic.linkable as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
                </select>
              </label>
              {#if pickCalendar === 'new' && user.role !== 'child'}
                <label class="check"><input type="checkbox" name="onlyMe" /> Only I can see the new Famner calendar</label>
              {/if}
              <p class="ui-hint">
                {#if pickRemote === 'new' && pickCalendar === 'new'}Pick an iCloud calendar, a Famner calendar, or both.
                {:else if pickRemote === 'new'}Famner makes a new iCloud calendar and copies this calendar’s events into it.
                {:else if pickCalendar === 'new'}Famner makes a new calendar with this iCloud calendar’s events.
                {:else}Events from both are combined; ones already in both places count once.{/if}
                {#if remote?.some((c) => !c.writable && !c.linkedTo)} View-only iCloud calendars (like ones shared with you to look at) can’t be synced.{/if}
              </p>
              <button class="ui-btn ui-primary" type="submit" disabled={working || (pickRemote === 'new' && pickCalendar === 'new')}>{working ? 'Syncing…' : 'Start syncing'}</button>
            </form>
          {/if}
        {/await}

        <form method="POST" action="?/icloudDisconnect" use:enhance={askFirst('Disconnect iCloud? All your synced calendars stop syncing. Their events stay in Famner and in iCloud.')}>
          <button class="ui-btn ui-subtle" type="submit">Disconnect iCloud</button>
        </form>
      {/if}
      {#if msg('icloud')?.error}<p class="ui-error" role="alert">{msg('icloud').error}</p>{/if}
      {#if msg('icloud')?.message}<p class="ui-ok">{msg('icloud').message}</p>{/if}
    </section>
  {/if}

  {#if !forced}
    <section class="ui-card">
      <h2>Reminders on this device</h2>
      {#if notif === 'on'}
        <p class="ui-hint">On. You’ll get a reminder 30 minutes before your chores are due{user.role !== 'child' ? ', when someone finishes a chore that needs reviewing' : ''}, and when your chores are reviewed{viaPush ? ', even when Famner is closed' : ', while the app is open or installed on this device'}.</p>
        {#if !viaPush && pushSupported()}<p class="ui-hint">Couldn’t set up notifications for when Famner is closed. Turn reminders off and on again.</p>{/if}
        <label class="check">
          <input type="checkbox" checked={groceries} onchange={(e) => { groceries = e.currentTarget.checked; setGroceryAlerts(groceries); }} />
          Tell me when someone adds groceries (one notification, 2 minutes after they stop adding)
        </label>
        <div class="sync-actions">
          <button class="ui-btn" onclick={() => sendTest()}>Send a test</button>
          {#if viaPush}<button class="ui-btn" onclick={() => sendTest(10)}>Send one in 10 seconds</button>{/if}
          <button class="ui-btn ui-subtle" onclick={turnOff}>Turn off</button>
        </div>
        {#if testResult}<p class="ui-hint" role="status">{testResult}</p>{/if}
      {:else if notif === 'off'}
        <p class="ui-hint">Get a reminder before chores are due{user.role !== 'child' ? ', when a chore is waiting for review' : ', when your chores are reviewed'} and when someone adds groceries.</p>
        <div><button class="ui-btn ui-primary" onclick={turnOn}>Turn on reminders</button></div>
      {:else if notif === 'blocked'}
        <p class="ui-hint">Notifications are blocked for this site. Allow them in the browser’s site settings, then come back here.</p>
      {:else if notif === 'unsupported'}
        <p class="ui-hint">This browser can’t show reminders for this address. They need the app to be opened over https (or on this computer at localhost); once it is, turn them on here. The red count on Chores always works.</p>
      {/if}
    </section>

    <section class="ui-card">
      <h2>Devices</h2>
      <p class="ui-hint">
        {data.otherSessions === 0
          ? 'You’re only signed in on this device.'
          : `You’re also signed in on ${data.otherSessions} other device${data.otherSessions === 1 ? '' : 's'}.`}
      </p>
      {#if data.otherSessions > 0}
        <form method="POST" action="?/signOutOthers" use:enhance>
          <button class="ui-btn" type="submit">Sign out of other devices</button>
        </form>
      {/if}
      {#if msg('signOutOthers')?.message}<p class="ui-ok">{msg('signOutOthers').message}</p>{/if}
    </section>
  {/if}

  <form method="POST" action="/logout" onsubmit={clearOfflineData}>
    <button class="ui-btn ui-subtle" type="submit">Sign out</button>
  </form>
</div>

<style>
  h3 { margin: 8px 0 0; font-size: 15px; }
  .steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: var(--app-muted); }
  .steps a { color: var(--app-accent); }
  .syncs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .syncs li { border: 1px solid var(--app-line); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
  .syncs p { margin: 0; }
  .sync-name { overflow-wrap: anywhere; }
  .sync-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .check { display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .themes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px; }
  .theme-opt {
    display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 10px 6px; border-radius: 10px; cursor: pointer;
    border: 1px solid var(--app-line); background: none; color: var(--app-text); font: inherit; font-size: 13px; font-weight: 500;
  }
  .theme-opt.on { border-color: var(--app-accent); box-shadow: 0 0 0 1px var(--app-accent); }
  .theme-opt:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; }
  /* a tiny picture of each theme: page, card and accent */
  .swatch { position: relative; width: 100%; max-width: 92px; aspect-ratio: 16 / 10; border-radius: 6px; overflow: hidden; border: 1px solid var(--app-line); }
  .swatch i { position: absolute; display: block; border-radius: 3px; }
  .swatch i:nth-child(1) { left: 0; right: 0; top: 0; height: 22%; border-radius: 0; }
  .swatch i:nth-child(2) { left: 12%; right: 12%; top: 34%; height: 40%; }
  .swatch i:nth-child(3) { left: 18%; width: 30%; top: 44%; height: 12%; }
  .swatch.light { background: #f4f5f7; } .swatch.light i:nth-child(-n + 2) { background: #fff; } .swatch.light i:nth-child(3) { background: #3b82f6; }
  .swatch.dark { background: #16181d; } .swatch.dark i:nth-child(-n + 2) { background: #1f2128; } .swatch.dark i:nth-child(3) { background: #60a5fa; }
  .swatch.oled { background: #000; } .swatch.oled i:nth-child(-n + 2) { background: #000; border: 1px solid #26272b; } .swatch.oled i:nth-child(3) { background: #60a5fa; border: 0; }
</style>
