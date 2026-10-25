<script>
  let { form } = $props();
</script>

<svelte:head><title>Set up · Famner</title></svelte:head>

<div class="auth-page">
  <form class="ui-card auth-card" method="POST">
    <h1>Welcome to Famner</h1>
    <p class="ui-hint">Create the first account. It will be an admin, so it can add everyone else.</p>
    {#if form?.error}<p class="ui-error" role="alert">{form.error}</p>{/if}
    <label class="ui-field">
      <span>Your name</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input name="name" autocomplete="name" required maxlength="60" value={form?.name ?? ''} autofocus />
    </label>
    <label class="ui-field">
      <span>Username</span>
      <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required
        minlength="3" maxlength="32" value={form?.username ?? ''} />
      <small>3–32 letters, numbers, dots, dashes or underscores.</small>
    </label>
    <label class="ui-field">
      <span>Password</span>
      <input name="password" type="password" autocomplete="new-password" required minlength="8" />
    </label>
    <label class="ui-field">
      <span>Confirm password</span>
      <input name="confirm" type="password" autocomplete="new-password" required minlength="8" />
    </label>
    <button class="ui-btn ui-primary ui-wide" type="submit">Create admin account</button>
  </form>
</div>
