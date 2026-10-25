<script>
  import { clearOfflineData } from '$lib/offline.svelte.js';
  import { enhance } from '$app/forms';
  import { page } from '$app/state';

  let { form } = $props();
  let pin = $state('');
  let confirm = $state('');
  const digits = (v) => v.replace(/\D/g, '').slice(0, 4);
</script>

<svelte:head><title>Choose your PIN · Famner</title></svelte:head>

<div class="ui-card narrow">
  <h1>Choose your PIN</h1>
  <p class="ui-hint">
    Hi {page.data.user?.name}! Pick a 4-digit PIN. You’ll type it on the family tablet to mark chores done,
    spend points or change your events{page.data.user?.role === 'admin' || page.data.user?.role === 'parent' ? ', and to check the kids’ chores' : ''}.
    Keep it to yourself.
  </p>
  {#if form?.error}<p class="ui-error" role="alert">{form.error}</p>{/if}
  <form method="POST" use:enhance>
    <label class="ui-field">
      <span>PIN</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input class="pin" name="pin" type="password" inputmode="numeric" autocomplete="off" pattern={"[0-9]{4}"} maxlength="4" required autofocus
        value={pin} oninput={(e) => (e.currentTarget.value = pin = digits(e.currentTarget.value))} />
    </label>
    <label class="ui-field">
      <span>Type it again</span>
      <input class="pin" name="confirm" type="password" inputmode="numeric" autocomplete="off" pattern={"[0-9]{4}"} maxlength="4" required
        value={confirm} oninput={(e) => (e.currentTarget.value = confirm = digits(e.currentTarget.value))} />
    </label>
    {#if confirm.length === 4 && pin !== confirm}<p class="ui-error">The two PINs don’t match.</p>{/if}
    <button class="ui-btn ui-primary wide" disabled={pin.length !== 4 || pin !== confirm}>Save PIN</button>
  </form>
  <form class="small" method="POST" action="/logout" onsubmit={clearOfflineData}><button class="ui-btn">Sign out</button></form>
</div>

<style>
  .narrow { max-width: 380px; margin: 48px auto; padding: 24px; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  form { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
  .pin { font-size: 24px; letter-spacing: 0.5em; text-align: center; }
  .wide { width: 100%; justify-content: center; }
  .small { margin-top: 16px; text-align: center; }
</style>
