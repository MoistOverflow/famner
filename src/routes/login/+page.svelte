<script>
  let { form } = $props();
</script>

<svelte:head><title>Sign in · Famner</title></svelte:head>

<div class="auth-page">
  <form class="ui-card auth-card" method="POST">
    <h1>Sign in to Famner</h1>
    {#if form?.error}<p class="ui-error" role="alert">{form.error}</p>{/if}
    <label class="ui-field">
      <span>Username</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value={form?.username ?? ''} autofocus={!form?.username} />
    </label>
    <label class="ui-field">
      <span>Password</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input name="password" type="password" autocomplete="current-password" required autofocus={!!form?.username} />
    </label>
    <button class="ui-btn ui-primary ui-wide" type="submit">Sign in</button>
    <p class="ui-hint">Forgot your password? Ask an admin to reset it.</p>
  </form>
</div>
