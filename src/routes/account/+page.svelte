<script>
  import { clearOfflineData } from '$lib/offline.svelte.js';
  import { enhance } from '$app/forms';
  import { ROLE_TEXT } from '$lib/roles.js';
  import { onMount } from 'svelte';
  import { notificationsSupported, notificationsOn, enableNotifications, disableNotifications } from '$lib/notify.js';

  // reminders on this device
  let notif = $state('unknown'); // 'on' | 'off' | 'blocked' | 'unsupported'
  const readNotif = () =>
    (notif = !notificationsSupported() ? 'unsupported' : Notification.permission === 'denied' ? 'blocked' : notificationsOn() ? 'on' : 'off');
  onMount(readNotif);
  async function turnOn() { await enableNotifications(); readNotif(); }
  function turnOff() { disableNotifications(); readNotif(); }

  let { data, form } = $props();
  const user = $derived(data.user);
  const forced = $derived(user.mustChangePassword);
  const msg = (action) => (form?.action === action ? form : null);
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

  {#if !forced}
    <section class="ui-card">
      <h2>Reminders on this device</h2>
      {#if notif === 'on'}
        <p class="ui-hint">On. You’ll get a reminder 30 minutes before your chores are due{user.role !== 'child' ? ', when someone finishes a chore that needs reviewing' : ''}, and when your chores are reviewed, while the app is open or installed on this device.</p>
        <div><button class="ui-btn" onclick={turnOff}>Turn off</button></div>
      {:else if notif === 'off'}
        <p class="ui-hint">Get a reminder before chores are due{user.role !== 'child' ? ' and when a chore is waiting for review' : ' and when your chores are reviewed'}.</p>
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
