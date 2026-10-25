<script>
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { pointsText, pointsReason } from '$lib/choreText.js';
  import { pinGuard } from '$lib/kiosk.svelte.js';

  let { data, form } = $props();
  const s = $derived(data.chores);
  const me = $derived(page.data.user);
  const adult = $derived(me?.role === 'admin' || me?.role === 'parent');
  const isKiosk = $derived(me?.role === 'kiosk'); // the shared tablet: anyone spends their points with their PIN
  const people = $derived((page.data.people ?? []).filter((p) => p.role !== 'kiosk'));
  const nameOf = (id) => (id === me?.id ? 'You' : people.find((p) => p.id === id)?.name ?? 'Someone');
  const balance = $derived(s.balances[me.id] ?? 0);

  let choosing = $state(null);   // reward id waiting for "Yes, get it"
  let removing = $state(null);   // reward id waiting for "Remove"
  let adding = $state(false);

  const myRedemptions = $derived(s.redemptions.filter((r) => r.userId === me.id));
  const STATUS = { pending: ['Waiting to be handed over', 'wait'], given: ['Given', 'good'], refunded: ['Refunded', ''] };
  const when = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  $effect(() => {
    if (form?.ok) {
      if (form.action === 'redeem') choosing = null;
      if (form.action === 'remove') removing = null;
      if (form.action === 'add') adding = false;
    }
  });
</script>

<svelte:head><title>Rewards · Famner</title></svelte:head>

{#if !isKiosk}
<div class="balance">
  <span class="big">{balance}</span>
  <span>point{balance === 1 ? '' : 's'} to spend</span>
</div>
{/if}

{#if form?.error}<p class="ui-error" role="alert">{form.error}</p>{/if}
{#if form?.ok && form.action === 'redeem'}
  <p class="ui-ok" role="status">{form.who ? `${form.who} got` : 'You got'} “{form.name}”! {adult ? '' : 'A parent will hand it over.'}</p>
{/if}

<div class="section-head">
  <h2 class="section-title">Rewards</h2>
  {#if adult && !adding}<button class="ui-btn" onclick={() => (adding = true)}>+ Add reward</button>{/if}
</div>

{#if adding}
  <form class="add-form" method="POST" action="?/add" use:enhance>
    <label class="ui-field grow">
      <span>Reward</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input name="name" required maxlength="60" placeholder="e.g. 30 minutes of screen time" autofocus />
    </label>
    <label class="ui-field cost">
      <span>Cost (points)</span>
      <input name="cost" type="number" min="1" max="100000" step="1" required value="50" />
    </label>
    <div class="add-actions">
      <button type="button" class="ui-btn" onclick={() => (adding = false)}>Cancel</button>
      <button class="ui-btn ui-primary">Add</button>
    </div>
  </form>
{/if}

{#if s.rewards.length}
  <ul class="rewards">
    {#each s.rewards as r (r.id)}
      {@const short = isKiosk ? 0 : r.cost - balance}
      <li class="reward">
        <div class="reward-main">
          <strong>{r.name}</strong>
          <span class="pts">{pointsText(r.cost)}</span>
        </div>
        {#if choosing === r.id}
          <form class="reward-actions" method="POST" action="?/redeem" use:enhance={pinGuard(() => ({ title: `Who’s getting “${r.name}”?` }))}>
            <input type="hidden" name="id" value={r.id} />
            <input type="hidden" name="name" value={r.name} />
            <span class="ask">Spend {r.cost}?</span>
            <button type="button" class="ui-btn" onclick={() => (choosing = null)}>No</button>
            <button class="ui-btn ui-primary">Yes, get it</button>
          </form>
        {:else if removing === r.id}
          <form class="reward-actions" method="POST" action="?/remove" use:enhance>
            <input type="hidden" name="id" value={r.id} />
            <button type="button" class="ui-btn" onclick={() => (removing = null)}>Keep</button>
            <button class="ui-btn ui-danger ui-solid">Remove</button>
          </form>
        {:else}
          <div class="reward-actions">
            {#if short > 0}
              <span class="need">{short} more needed</span>
            {:else}
              <button class="ui-btn ui-primary" onclick={() => { choosing = r.id; removing = null; }}>Get it</button>
            {/if}
            {#if adult}
              <button class="icon" aria-label="Remove {r.name}" title="Remove reward" onclick={() => { removing = r.id; choosing = null; }}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            {/if}
          </div>
        {/if}
        <div class="bar" aria-hidden="true"><span style="width: {Math.min(100, (balance / r.cost) * 100)}%"></span></div>
      </li>
    {/each}
  </ul>
{:else}
  <p class="empty">{adult ? 'No rewards yet. Add some for points to be spent on.' : 'No rewards yet. Ask a parent to add some!'}</p>
{/if}

{#if myRedemptions.length}
  <h2 class="section-title">Your rewards</h2>
  <ul class="rows">
    {#each myRedemptions as r (r.id)}
      <li class="redeemed">
        <div class="grow">
          <strong>{r.name}</strong>
          <div class="meta">{when(r.at)} · {pointsText(r.cost)}</div>
        </div>
        <span class="chip {STATUS[r.status][1]}">{STATUS[r.status][0]}</span>
        {#if r.status === 'pending'}
          <form method="POST" action="?/cancel" use:enhance>
            <input type="hidden" name="id" value={r.id} />
            <button class="ui-btn">Cancel</button>
          </form>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

{#if s.ledger.length}
  <h2 class="section-title">Your points history</h2>
  <ul class="rows">
    {#each s.ledger as p (p.id)}
      <li class="redeemed">
        <span class="delta" class:neg={p.delta < 0}>{p.delta > 0 ? '+' : '−'}{Math.abs(p.delta)}</span>
        <span class="grow">{pointsReason(p)}</span>
        <span class="meta">{when(p.at)}</span>
      </li>
    {/each}
  </ul>
{/if}

{#if adult || isKiosk}
  <h2 class="section-title">Everyone’s points</h2>
  <ul class="rows">
    {#each people as p (p.id)}
      <li class="redeemed">
        <span class="grow">{p.name}</span>
        <span class="pts">{pointsText(s.balances[p.id] ?? 0)}</span>
      </li>
    {/each}
  </ul>
{/if}

<style>
  svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; flex-shrink: 0; }
  .balance {
    display: flex; align-items: baseline; gap: 10px; padding: 18px 20px; margin-bottom: 8px; border-radius: 14px;
    background: color-mix(in srgb, #f59e0b 16%, var(--app-surface)); border: 1px solid color-mix(in srgb, #f59e0b 35%, transparent);
  }
  .big { font-size: 40px; font-weight: 800; line-height: 1; }
  .section-head { display: flex; align-items: center; justify-content: space-between; }
  .section-head .section-title { margin-bottom: 8px; }
  .add-form {
    display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; padding: 14px; margin-bottom: 12px;
    border-radius: 12px; border: 1px solid var(--app-accent); background: var(--app-surface);
  }
  .grow { flex: 1; min-width: 0; }
  .cost { width: 130px; }
  .add-actions { display: flex; gap: 8px; }
  .rewards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .reward {
    position: relative; display: flex; flex-direction: column; justify-content: space-between; gap: 12px; padding: 14px 14px 18px;
    border-radius: 12px; border: 1px solid var(--app-line); background: var(--app-surface); overflow: hidden;
  }
  .reward-main { display: flex; flex-direction: column; gap: 4px; }
  .reward-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ask { font-size: 14px; font-weight: 600; }
  .need { font-size: 13px; color: var(--app-muted); }
  .icon { display: grid; place-items: center; width: 32px; height: 32px; margin-left: auto; border-radius: 8px; border: 0; background: none; color: var(--app-muted); cursor: pointer; }
  .icon:hover { background: var(--app-hover); color: #e5484d; }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: var(--app-hover); }
  .bar span { display: block; height: 100%; background: #f59e0b; }
  .redeemed { display: flex; align-items: center; gap: 10px; padding: 10px 14px; }
  .meta { font-size: 13px; color: var(--app-muted); }
  .delta { width: 48px; font-weight: 700; color: #16a34a; text-align: right; font-variant-numeric: tabular-nums; }
  .delta.neg { color: #e5484d; }
</style>
