<script>
  import { enhance } from '$app/forms';
  import { ROLE_TEXT, ROLE_HELP } from '$lib/roles.js';
  import { describeParts, dayHeading, AREAS } from '$lib/activityText.js';
  import { pointsReason, pointsText } from '$lib/choreText.js';

  let { data, form } = $props();

  let adding = $state(false);
  let editingId = $state(null);
  let confirm = $state(null); // { kind: 'delete' | 'reset' | 'resetPin' | 'disable', user }
  let resetOpen = $state(false); // the factory-reset form
  let resetWord = $state('');
  let copied = $state(false);
  let pointsFor = $state(null); // { id, direction: 'add' | 'remove', amount, reason } while correcting someone's points

  const me = $derived(data.user);
  const users = $derived(data.users);

  // close the add form / editor once an action succeeds
  $effect(() => {
    if (form && !form.error) {
      if (form.action === 'create') adding = false;
      if (form.action === 'update') editingId = null;
      if (form.action === 'points') pointsFor = null;
      confirm = null;
    }
  });

  function ago(ms) {
    if (!ms) return 'never';
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 2) return 'just now';
    if (min < 60) return `${min} min ago`;
    if (min < 1440) return `${Math.round(min / 60)} h ago`;
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {}
  }

  const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  // ---------- activity ----------
  const entries = $derived(data.activity?.entries ?? []);
  const days = $derived.by(() => {
    const out = [];
    for (const e of entries) {
      const h = dayHeading(e.at);
      if (out.at(-1)?.heading !== h) out.push({ heading: h, items: [] });
      out.at(-1).items.push(e);
    }
    return out;
  });
  // titles from a child's private calendar are blurred until clicked (per entry, until reload)
  let revealed = $state({});
  const toggleReveal = (id) => (revealed[id] = !revealed[id]);

  const timeOf = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const nameOf = (e) => data.users.find((u) => u.id === e.userId)?.name ?? e.userName ?? 'Someone';
  function filterHref(extra = {}) {
    const p = new URLSearchParams({ tab: 'activity' });
    const f = { who: data.filters?.who, area: data.filters?.area, ...extra };
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    return `?${p}`;
  }
</script>

<svelte:head><title>Admin · Famner</title></svelte:head>

<div class="wide-page">
  <nav class="tabs" aria-label="Admin sections">
    <a href="?" class:on={data.tab === 'people'} aria-current={data.tab === 'people' ? 'page' : undefined}>People</a>
    <a href="?tab=activity" class:on={data.tab === 'activity'} aria-current={data.tab === 'activity' ? 'page' : undefined}>Activity</a>
    <a href="?tab=backups" class:on={data.tab === 'backups'} aria-current={data.tab === 'backups' ? 'page' : undefined}>Backups</a>
  </nav>

  {#if data.tab === 'backups'}
    <div class="page-head">
      <h1>Backups</h1>
      <form method="POST" action="?/backup" use:enhance>
        <button class="ui-btn ui-primary">Back up now</button>
      </form>
    </div>
    {#if form?.action === 'backup' && form?.message}<p class="ui-ok banner">{form.message}</p>{/if}
    {#if form?.action === 'backup' && form?.error}<p class="ui-error banner" role="alert">{form.error}</p>{/if}
    <p class="ui-hint">
      A backup is made automatically once a day while the app is running; the last 14 are kept, plus the last
      10 made with “Back up now”. They’re saved in <code>{data.backupDir}</code>. Download one now and then to keep
      a copy somewhere else too.
    </p>
    {#if data.backups.length}
      <ul class="ui-card log backups">
        {#each data.backups as b (b.name)}
          <li>
            <div class="what">
              <strong>{new Date(b.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong>
              <span class="area">{b.kind === 'auto' ? 'Automatic' : b.kind === 'reset' ? 'Before reset' : 'Manual'}</span>
            </div>
            <span class="size">{b.size > 1048576 ? `${(b.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b.size / 1024))} KB`}</span>
            <a class="ui-btn" href="/admin/backups/{b.name}" download>Download</a>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="ui-hint empty-log">No backups yet.</p>
    {/if}

    <section class="ui-card danger-zone">
      <h2>Start over (factory reset)</h2>
      <p class="ui-hint">
        Deletes <strong>everything</strong>: every account (yours too), calendar, event, grocery item, chore, point,
        reward and the activity log. Everyone is signed out, and the app goes back to the first-time setup page.
        A backup is made first and kept here, so it can be restored (see DEPLOY.md, “Backups and restoring”).
      </p>
      {#if !resetOpen}
        <div><button class="ui-btn ui-danger" type="button" onclick={() => (resetOpen = true)}>Reset the app…</button></div>
      {:else}
        <form method="POST" action="?/factoryReset" use:enhance>
          <label class="ui-field">
            <span>Your password</span>
            <input name="password" type="password" autocomplete="current-password" required />
          </label>
          <label class="ui-field">
            <span>Type <strong>RESET</strong> to confirm</span>
            <input name="confirm" autocomplete="off" required bind:value={resetWord} />
          </label>
          {#if form?.action === 'factoryReset' && form?.error}<p class="ui-error" role="alert">{form.error}</p>{/if}
          <div class="actions">
            <button class="ui-btn" type="button" onclick={() => { resetOpen = false; resetWord = ''; }}>Cancel</button>
            <button class="ui-btn ui-danger ui-solid" disabled={resetWord.trim() !== 'RESET'}>Delete everything</button>
          </div>
        </form>
      {/if}
    </section>
  {:else if data.tab === 'activity'}
    <div class="page-head">
      <h1>Activity</h1>
    </div>
    <form class="filters" method="GET" data-sveltekit-keepfocus>
      <input type="hidden" name="tab" value="activity" />
      <label>
        <span>Person</span>
        <select name="who" value={data.filters.who ?? ''} onchange={(e) => e.currentTarget.form.requestSubmit()}>
          <option value="">Everyone</option>
          {#each data.users as u (u.id)}<option value={u.id}>{u.name}</option>{/each}
        </select>
      </label>
      <label>
        <span>Area</span>
        <select name="area" value={data.filters.area ?? ''} onchange={(e) => e.currentTarget.form.requestSubmit()}>
          <option value="">Everything</option>
          {#each Object.entries(AREAS) as [key, label]}<option value={key}>{label}</option>{/each}
        </select>
      </label>
      <noscript><button class="ui-btn" type="submit">Filter</button></noscript>
    </form>

    {#if !entries.length}
      <p class="ui-hint empty-log">{data.before ? 'Nothing older.' : 'Nothing has been logged yet with these filters.'}</p>
    {/if}
    {#each days as day (day.heading)}
      <h2 class="day">{day.heading}</h2>
      <ul class="log ui-card">
        {#each day.items as e (e.id)}
          <li>
            <span class="avatar sm" aria-hidden="true">{initials(nameOf(e))}</span>
            <div class="what">
              <strong>{nameOf(e)}</strong>
              {#each describeParts(e) as part}{#if typeof part === 'string'}{part}{:else}<button
                    type="button"
                    class="secret"
                    class:shown={revealed[e.id]}
                    aria-pressed={!!revealed[e.id]}
                    aria-label={revealed[e.id] ? `${part.secret} (click to hide)` : 'Private: click to show'}
                    title={revealed[e.id] ? 'Click to hide' : 'Private: click to show'}
                    onclick={() => toggleReveal(e.id)}
                  ><span aria-hidden={!revealed[e.id]}>{part.secret}</span></button>{/if}{/each}
              {#if e.details?.blur}<span class="private-tag" title="From a child’s private calendar">private</span>{/if}
            </div>
            <span class="area area-{e.area}">{AREAS[e.area] ?? e.area}</span>
            <time datetime={new Date(e.at).toISOString()}>{timeOf(e.at)}</time>
          </li>
        {/each}
      </ul>
    {/each}
    <div class="pager">
      {#if data.before}<a class="ui-btn" href={filterHref()}>Newest</a>{/if}
      {#if data.activity.more}<a class="ui-btn" href={filterHref({ before: entries.at(-1).id })}>Older</a>{/if}
    </div>
  {:else}
  <div class="page-head">
    <h1>People</h1>
    {#if !adding}<button class="ui-btn ui-primary" onclick={() => { adding = true; editingId = null; }}>+ Add person</button>{/if}
  </div>

  {#if form?.tempPassword}
    <div class="ui-card temp" role="status">
      <p><strong>{form.message}</strong> Give {form.forUser} this temporary password. They'll choose their own when they first sign in.</p>
      <div class="temp-row">
        <code>{form.tempPassword}</code>
        <button class="ui-btn" onclick={() => copy(form.tempPassword)}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p class="ui-hint">It won't be shown again. If it's lost, reset the password.</p>
    </div>
  {:else if form?.message}
    <p class="ui-ok banner">{form.message}</p>
  {/if}
  {#if form?.error}<p class="ui-error banner" role="alert">{form.error}</p>{/if}

  {#if adding}
    <form class="ui-card add-form" method="POST" action="?/create" use:enhance>
      <h2>Add a person</h2>
      <div class="grid2">
        <label class="ui-field">
          <span>Name</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input name="name" required maxlength="60" value={form?.values?.name ?? ''} autofocus />
        </label>
        <label class="ui-field">
          <span>Username</span>
          <input name="username" required minlength="3" maxlength="32" autocapitalize="none" spellcheck="false" value={form?.values?.username ?? ''} />
        </label>
      </div>
      <fieldset class="roles">
        <legend>Role</legend>
        {#each ['parent', 'child', 'admin', 'kiosk'] as r}
          <label class="role">
            <input type="radio" name="role" value={r} checked={(form?.values?.role ?? 'parent') === r} />
            <span><strong>{ROLE_TEXT[r]}</strong> · {ROLE_HELP[r]}</span>
          </label>
        {/each}
      </fieldset>
      <div class="actions">
        <button class="ui-btn" type="button" onclick={() => (adding = false)}>Cancel</button>
        <button class="ui-btn ui-primary" type="submit">Add and create temporary password</button>
      </div>
    </form>
  {/if}

  <ul class="people">
    {#each users as u (u.id)}
      {@const self = u.id === me.id}
      <li class="ui-card person" class:off={u.disabled}>
        <div class="person-main">
          <span class="avatar" aria-hidden="true">{initials(u.name)}</span>
          <div class="who">
            <div class="name-line">
              <strong>{u.name}</strong>
              {#if self}<span class="tag">You</span>{/if}
              <span class="tag role-{u.role}">{ROLE_TEXT[u.role]}</span>
              {#if u.disabled}<span class="tag off-tag">Turned off</span>{/if}
              {#if u.mustChangePassword && !u.disabled}<span class="tag pending">Temporary password</span>{/if}
              {#if u.needsPin && !u.mustChangePassword && !u.disabled}<span class="tag pending">No PIN yet</span>{/if}
            </div>
            <div class="meta">
              {u.username} · last active {ago(u.lastSeenAt ?? u.lastLoginAt)}
              {#if u.activeSessions} · signed in on {u.activeSessions} device{u.activeSessions === 1 ? '' : 's'}{/if}
              {#if u.privateCalendars} · {u.privateCalendars} private calendar{u.privateCalendars === 1 ? '' : 's'}{/if}
            </div>
            <div class="meta">
              <span class="points-tag">★ {pointsText(data.points?.balances[u.id] ?? 0)}</span>
            </div>
          </div>
          {#if editingId !== u.id}
            <button class="ui-btn" onclick={() => { editingId = u.id; adding = false; confirm = null; }}>Edit</button>
          {/if}
        </div>

        {#if editingId === u.id}
          <form class="editor" method="POST" action="?/update" use:enhance>
            <input type="hidden" name="id" value={u.id} />
            <label class="ui-field">
              <span>Name</span>
              <input name="name" value={u.name} required maxlength="60" />
            </label>
            {#if self}
              <p class="ui-hint">You can’t change your own role, turn off or remove your own account.</p>
            {:else}
              <fieldset class="roles">
                <legend>Role</legend>
                {#each ['parent', 'child', 'admin', 'kiosk'] as r}
                  <label class="role">
                    <input type="radio" name="role" value={r} checked={u.role === r} />
                    <span><strong>{ROLE_TEXT[r]}</strong> · {ROLE_HELP[r]}</span>
                  </label>
                {/each}
              </fieldset>
            {/if}
            <div class="actions">
              {#if !self}
                <button class="ui-btn" type="button" onclick={() => (confirm = { kind: 'reset', user: u })}>Reset password</button>
                {#if u.role !== 'kiosk' && !u.needsPin}
                  <button class="ui-btn" type="button" onclick={() => (confirm = { kind: 'resetPin', user: u })}>Reset PIN</button>
                {/if}
                <button class="ui-btn" type="button" onclick={() => (confirm = { kind: 'disable', user: u })}>{u.disabled ? 'Turn on' : 'Turn off'}</button>
                <button class="ui-btn ui-danger" type="button" onclick={() => (confirm = { kind: 'delete', user: u })}>Remove</button>
              {/if}
              <span class="spacer"></span>
              <button class="ui-btn" type="button" onclick={() => (editingId = null)}>Cancel</button>
              <button class="ui-btn ui-primary" type="submit">Save</button>
            </div>
          </form>

          {#if u.role !== 'kiosk'}
          <section class="points-box">
            <div class="points-head">
              <h3>Points · {pointsText(data.points?.balances[u.id] ?? 0)}</h3>
              {#if pointsFor?.id !== u.id}
                <button class="ui-btn" type="button" onclick={() => (pointsFor = { id: u.id, direction: 'add', amount: 5, reason: '' })}>Correct points…</button>
              {/if}
            </div>
            {#if pointsFor?.id === u.id}
              <form class="points-form" method="POST" action="?/points" use:enhance>
                <input type="hidden" name="id" value={u.id} />
                <input type="hidden" name="name" value={u.name} />
                <div class="points-row">
                  <div class="seg" role="group" aria-label="Add or take away">
                    <label class:on={pointsFor.direction === 'add'}><input type="radio" name="direction" value="add" bind:group={pointsFor.direction} /> Add</label>
                    <label class:on={pointsFor.direction === 'remove'}><input type="radio" name="direction" value="remove" bind:group={pointsFor.direction} /> Take away</label>
                  </div>
                  <label class="ui-field amount">
                    <span>Points</span>
                    <input name="amount" type="number" min="1" max="100000" step="1" bind:value={pointsFor.amount} required />
                  </label>
                </div>
                <label class="ui-field">
                  <span>Reason (shown in their points history and the activity log)</span>
                  <!-- svelte-ignore a11y_autofocus -->
                  <input name="reason" bind:value={pointsFor.reason} required maxlength="200" placeholder="e.g. Fixing a chore that was reviewed by mistake" autofocus />
                </label>
                <p class="ui-hint">
                  {u.name} will have {Math.max(0, (data.points?.balances[u.id] ?? 0) + (pointsFor.direction === 'remove' ? -1 : 1) * (Number(pointsFor.amount) || 0))} points after this.
                </p>
                <div class="actions">
                  <button class="ui-btn" type="button" onclick={() => (pointsFor = null)}>Cancel</button>
                  <button class="ui-btn ui-primary" type="submit">{pointsFor.direction === 'remove' ? 'Take away' : 'Add'} {Number(pointsFor.amount) || 0}</button>
                </div>
              </form>
            {/if}
            {#if data.points?.history[u.id]?.length}
              <ul class="points-history">
                {#each data.points.history[u.id] as p (p.id)}
                  <li>
                    <span class="delta" class:neg={p.delta < 0}>{p.delta > 0 ? '+' : '−'}{Math.abs(p.delta)}</span>
                    <span class="why">{pointsReason(p)}</span>
                    <time>{new Date(p.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="ui-hint">No points yet.</p>
            {/if}
          </section>
          {/if}

          {#if confirm?.user.id === u.id}
            <form class="confirm" method="POST" action="?/{confirm.kind}" use:enhance>
              <input type="hidden" name="id" value={u.id} />
              <input type="hidden" name="username" value={u.username} />
              {#if confirm.kind === 'resetPin'}
                <p>Clear {u.name}’s kiosk PIN? They’ll be asked to choose a new one the next time they use the app.</p>
              {:else if confirm.kind === 'reset'}
                <p>Give {u.name} a new temporary password? They’ll be signed out everywhere and must choose a new password next time.</p>
              {:else if confirm.kind === 'disable'}
                <input type="hidden" name="disabled" value={u.disabled ? '0' : '1'} />
                <p>{u.disabled ? `Let ${u.name} sign in again?` : `Turn off ${u.name}’s account? They’ll be signed out everywhere until it’s turned back on. Nothing is deleted.`}</p>
              {:else}
                <p>
                  Remove {u.name}? They’ll be signed out and can’t sign in again.
                  {#if u.privateCalendars}Their {u.privateCalendars} private calendar{u.privateCalendars === 1 ? '' : 's'} will be deleted too.{/if}
                  Shared calendars, groceries and chores aren’t affected.
                </p>
              {/if}
              <div class="actions">
                <button class="ui-btn" type="button" onclick={() => (confirm = null)}>Keep</button>
                <button class="ui-btn {confirm.kind === 'delete' ? 'ui-danger ui-solid' : 'ui-primary'}" type="submit">
                  {confirm.kind === 'resetPin' ? 'Reset PIN' : confirm.kind === 'reset' ? 'Reset password' : confirm.kind === 'disable' ? (u.disabled ? 'Turn on' : 'Turn off') : 'Remove'}
                </button>
              </div>
            </form>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
  {/if}
</div>

<style>
  .danger-zone { margin-top: 28px; border-color: color-mix(in srgb, #e5484d 45%, var(--app-line)); }
  .danger-zone h2 { color: #e5484d; }
  .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--app-line); }
  .tabs a {
    padding: 8px 14px; margin-bottom: -1px; border-bottom: 2px solid transparent;
    color: var(--app-muted); text-decoration: none; font-weight: 600; font-size: 14px;
  }
  .tabs a:hover { color: var(--app-text); }
  .tabs a.on { color: var(--app-text); border-bottom-color: var(--app-accent); }
  .filters { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
  .filters label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--app-muted); }
  .filters select {
    min-width: 160px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--app-line);
    background: var(--app-surface); color: var(--app-text); font: inherit; font-size: 14px; font-weight: 400;
  }
  .empty-log { padding: 24px 0; }
  .day { margin: 20px 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--app-muted); }
  .log { list-style: none; margin: 0; padding: 0; }
  .log li { display: flex; align-items: center; gap: 10px; padding: 10px 14px; font-size: 14px; }
  .log li + li { border-top: 1px solid var(--app-line); }
  .log .what { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .log time { color: var(--app-muted); font-size: 12px; white-space: nowrap; }
  .avatar.sm { width: 28px; height: 28px; font-size: 11px; }
  .area { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--app-hover); color: var(--app-muted); white-space: nowrap; }
  .area-calendar { background: color-mix(in srgb, #3b82f6 18%, transparent); color: var(--app-text); }
  .area-groceries { background: color-mix(in srgb, #22c55e 18%, transparent); color: var(--app-text); }
  .area-chores { background: color-mix(in srgb, #f59e0b 18%, transparent); color: var(--app-text); }
  .area-accounts { background: color-mix(in srgb, #8b5cf6 18%, transparent); color: var(--app-text); }
  .secret {
    display: inline; padding: 0 2px; margin: 0; border: 0; border-radius: 4px; cursor: pointer;
    font: inherit; color: inherit; background: color-mix(in srgb, var(--app-muted) 18%, transparent);
  }
  .secret span { filter: blur(5px); user-select: none; transition: filter 0.15s; }
  .secret.shown { background: none; }
  .secret.shown span { filter: none; user-select: text; }
  .secret:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 1px; }
  .private-tag {
    margin-left: 6px; padding: 1px 6px; border-radius: 999px; font-size: 11px; font-weight: 600;
    color: var(--app-muted); background: var(--app-hover); white-space: nowrap;
  }
  .backups { margin-top: 14px; }
  .backups .what { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .size { color: var(--app-muted); font-size: 13px; white-space: nowrap; }
  .pager { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
  @media (max-width: 560px) {
    .log li { flex-wrap: wrap; }
    .log .what { flex-basis: calc(100% - 40px); }
    .log .area { margin-left: 38px; }
  }
  .page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
  .page-head h1 { margin: 0; }
  .banner { margin: 0 0 12px; }
  .temp { margin-bottom: 16px; border-color: var(--app-accent); }
  .temp p { margin: 0 0 10px; }
  .temp-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .temp code { font-size: 20px; letter-spacing: 0.06em; padding: 8px 12px; border-radius: 8px; background: var(--app-bg); user-select: all; }
  .add-form { margin-bottom: 16px; }
  .add-form h2 { margin-top: 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
  .roles { border: 0; margin: 12px 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .roles legend { font-size: 12px; font-weight: 600; color: var(--app-muted); margin-bottom: 6px; padding: 0; }
  .role { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; font-size: 14px; }
  .role input { margin-top: 3px; accent-color: var(--app-accent); }
  .actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .spacer { flex: 1; }

  .people { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .person { padding: 14px 16px; }
  .person.off { opacity: 0.7; }
  .person-main { display: flex; align-items: center; gap: 12px; }
  .avatar {
    display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
    background: color-mix(in srgb, var(--app-accent) 22%, transparent); color: var(--app-text); font-weight: 700; font-size: 14px;
  }
  .who { flex: 1; min-width: 0; }
  .name-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .meta { color: var(--app-muted); font-size: 13px; margin-top: 2px; }
  .tag { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--app-hover); color: var(--app-muted); }
  .tag.role-admin { background: color-mix(in srgb, #8b5cf6 22%, transparent); color: var(--app-text); }
  .tag.role-child { background: color-mix(in srgb, #f59e0b 22%, transparent); color: var(--app-text); }
  .tag.off-tag { background: color-mix(in srgb, #e5484d 22%, transparent); color: var(--app-text); }
  .tag.pending { background: color-mix(in srgb, var(--app-accent) 18%, transparent); color: var(--app-text); }
  .editor { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--app-line); }
  .points-tag { font-weight: 600; color: var(--app-text); }
  .points-box { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--app-line); }
  .points-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
  .points-head h3 { margin: 0; font-size: 14px; }
  .points-form { margin-bottom: 10px; padding: 12px; border-radius: 8px; background: var(--app-bg); }
  .points-row { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
  .amount { width: 120px; }
  .seg { display: flex; border: 1px solid var(--app-line); border-radius: 8px; overflow: hidden; }
  .seg label { padding: 9px 14px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .seg label + label { border-left: 1px solid var(--app-line); }
  .seg label.on { background: var(--app-accent); color: #fff; }
  .seg input { position: absolute; opacity: 0; pointer-events: none; }
  .seg label:focus-within { outline: 2px solid var(--app-accent); outline-offset: -2px; }
  .points-history { list-style: none; margin: 0; padding: 0; font-size: 13px; }
  .points-history li { display: flex; align-items: baseline; gap: 10px; padding: 4px 0; }
  .delta { width: 52px; font-weight: 700; color: #16a34a; text-align: right; font-variant-numeric: tabular-nums; }
  .delta.neg { color: #e5484d; }
  .why { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .points-history time { color: var(--app-muted); white-space: nowrap; }
  .confirm { margin-top: 12px; padding: 12px; border-radius: 8px; background: var(--app-bg); }
  .confirm p { margin: 0; font-size: 14px; }
</style>
