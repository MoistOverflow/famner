<script>
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { slide } from 'svelte/transition';
  import { duration, OUTCOME, pointsText, resultPoints } from '$lib/choreText.js';
  import { onMount } from 'svelte';
  import { kiosk, pinGuard, unlockFor } from '$lib/kiosk.svelte.js';

  let { data, form } = $props();
  const s = $derived(data.chores);
  const people = $derived(page.data.people ?? []);
  const me = $derived(page.data.user);
  // on the kiosk this whole page needs a parent's or admin's PIN, and so does every decision on it
  const PARENT = { parents: true, title: 'A parent’s PIN to review' };
  const parentGuard = pinGuard(() => PARENT);
  const parentHere = $derived(!kiosk.on || ['admin', 'parent'].includes(kiosk.acting?.role));
  onMount(() => { if (!parentHere) unlockFor(PARENT); });
  const nameOf = (id) => (id === me?.id ? 'You' : people.find((p) => p.id === id)?.name ?? 'Someone');

  const waiting = $derived(s.chores.filter((c) => c.status === 'submitted').sort((a, b) => a.submittedAt - b.submittedAt));
  const handOut = $derived(s.redemptions.filter((r) => r.status === 'pending').sort((a, b) => a.at - b.at));
  const reviewed = $derived(s.history.filter((h) => h.outcome !== 'done').slice(0, 30));

  // an open "change points" / "don't accept" form: { id, decision, points, reason, possible }
  let deciding = $state(null);
  const LESS = ['Finished late', 'Not done right', 'Needed reminders', 'Only partly done'];
  const MORE = ['Did extra', 'Without being asked', 'Great job', 'Helped someone else'];
  const NO = ['Not done', 'Not done right', 'Didn’t really do it'];

  function open(c, decision) {
    const late = c.submittedAt > c.due;
    deciding = {
      id: c.id, decision, possible: c.points,
      points: decision === 'adjust' ? (late ? Math.max(0, Math.floor(c.points / 2)) : c.points + Math.max(1, Math.round(c.points / 2))) : 0,
      reason: late ? 'Finished late' : ''
    };
  }

  const diff = $derived(deciding ? (Number(deciding.points) || 0) - deciding.possible : 0);
  const quick = $derived(deciding?.decision === 'deny' ? NO : diff > 0 ? MORE : LESS);
  const nudge = (n) => (deciding.points = Math.max(0, (Number(deciding.points) || 0) + n));

  const when = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // changing a result that was already reviewed: { id, points, reason, possible }
  let revising = $state(null);
  const canRevise = (h) => h.outcome !== 'skipped' && Date.now() - h.at < 14 * 86400000;

  $effect(() => {
    if (form?.ok && form.action === 'review') deciding = null;
    if (form?.ok && form.action === 'revise') revising = null;
  });
</script>

<svelte:head><title>Review chores · Famner</title></svelte:head>

{#if !parentHere}
  <div class="locked">
    <p><strong>For parents.</strong> Reviewing chores and handing out rewards needs a parent’s PIN.</p>
    <button class="ui-btn ui-primary" onclick={() => unlockFor(PARENT)}>Enter a parent’s PIN</button>
  </div>
{:else}
{#if form?.error}<p class="ui-error" role="alert">{form.error}</p>{/if}

<h2 class="section-title">Waiting for review</h2>
{#if waiting.length}
  <ul class="cards">
    {#each waiting as c (c.id)}
      {@const lateBy = c.submittedAt - c.due}
      <li class="card" transition:slide={{ duration: 150 }}>
        <div class="card-head">
          <div>
            <strong>{nameOf(c.assignee)}</strong> finished <strong>“{c.title}”</strong>
            <div class="meta">
              Done {when(c.submittedAt)} ·
              {#if lateBy > 0}<span class="chip bad">{duration(lateBy)} late</span>{:else}<span class="chip good">On time</span>{/if}
            </div>
            {#if c.notes}<p class="notes">{c.notes}</p>{/if}
          </div>
          <span class="pts">{pointsText(c.points)}</span>
        </div>

        {#if deciding?.id === c.id}
          <form class="decide" method="POST" action="?/review" use:enhance={parentGuard} transition:slide={{ duration: 150 }}>
            <input type="hidden" name="id" value={c.id} />
            <input type="hidden" name="decision" value={deciding.decision} />
            {#if deciding.decision === 'adjust'}
              <div class="ui-field">
                <span>Points to give (the chore is worth {c.points})</span>
                <div class="stepper">
                  <button type="button" class="step" aria-label="One point less" onclick={() => nudge(-1)} disabled={deciding.points <= 0}>−</button>
                  <input name="points" type="number" min="0" max="10000" step="1" bind:value={deciding.points} required aria-label="Points to give" />
                  <button type="button" class="step" aria-label="One point more" onclick={() => nudge(1)}>+</button>
                  {#if diff > 0}<span class="chip good">+{diff} bonus</span>{:else if diff < 0}<span class="chip warn">{diff} points</span>{:else}<span class="chip">Full points</span>{/if}
                </div>
              </div>
            {/if}
            <label class="ui-field">
              <span>
                {deciding.decision === 'deny' ? 'Why isn’t it accepted?' : diff > 0 ? 'What earned the extra points?' : diff < 0 ? 'Why fewer points?' : 'Note (optional)'}
                ({nameOf(c.assignee)} will see this)
              </span>
              <!-- svelte-ignore a11y_autofocus -->
              <input name="reason" bind:value={deciding.reason} required={deciding.decision === 'deny' || diff !== 0} maxlength="300" autofocus />
            </label>
            <div class="quick" role="group" aria-label="Common reasons">
              {#each quick as q}
                <button type="button" class="quick-btn" class:on={deciding.reason === q} onclick={() => (deciding.reason = q)}>{q}</button>
              {/each}
            </div>
            <div class="actions">
              <button type="button" class="ui-btn" onclick={() => (deciding = null)}>Back</button>
              <button class="ui-btn {deciding.decision === 'deny' ? 'ui-danger ui-solid' : 'ui-primary'}">
                {deciding.decision === 'adjust' ? `Give ${Number(deciding.points) || 0} point${deciding.points == 1 ? '' : 's'}` : 'Don’t accept'}
              </button>
            </div>
          </form>
        {:else}
          <div class="actions">
            <form method="POST" action="?/review" use:enhance={parentGuard}>
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="decision" value="approve" />
              <button class="ui-btn ui-primary">Approve{c.points ? ` · +${c.points}` : ''}</button>
            </form>
            <button class="ui-btn" onclick={() => open(c, 'adjust')}>Change points…</button>
            <button class="ui-btn ui-danger" onclick={() => open(c, 'deny')}>Don’t accept…</button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{:else}
  <p class="empty">Nothing waiting. When a child marks a chore done, it shows up here.</p>
{/if}

<h2 class="section-title">Rewards to hand out</h2>
{#if handOut.length}
  <ul class="rows">
    {#each handOut as r (r.id)}
      <li class="line">
        <div class="grow">
          <strong>{nameOf(r.userId)}</strong> got <strong>“{r.name}”</strong>
          <div class="meta">{when(r.at)} · {pointsText(r.cost)}</div>
        </div>
        <form method="POST" action="?/refund" use:enhance={parentGuard}>
          <input type="hidden" name="id" value={r.id} />
          <button class="ui-btn" title="Give the points back">Refund</button>
        </form>
        <form method="POST" action="?/given" use:enhance={parentGuard}>
          <input type="hidden" name="id" value={r.id} />
          <button class="ui-btn ui-primary">Given</button>
        </form>
      </li>
    {/each}
  </ul>
{:else}
  <p class="empty">No rewards waiting.</p>
{/if}

{#if reviewed.length}
  <h2 class="section-title">Recently reviewed</h2>
  <ul class="rows">
    {#each reviewed as h (h.id)}
      <li class="line">
        <div class="grow">
          <strong>{nameOf(h.assignee)}</strong> · {h.title}
          <div class="meta">
            {when(h.at)}{h.reviewedBy ? ` · by ${nameOf(h.reviewedBy)}` : ''}
            {#if h.reason} · “{h.reason}”{/if}
          </div>
        </div>
        <span class="chip {OUTCOME[h.outcome]?.tone}">{OUTCOME[h.outcome]?.label}</span>
        <span class="pts">{resultPoints(h)}</span>
        {#if canRevise(h) && revising?.id !== h.id}
          <button class="ui-btn small" onclick={() => (revising = { id: h.id, points: h.points, reason: '', possible: h.possible })}>Change</button>
        {/if}
      </li>
      {#if revising?.id === h.id}
        <li class="line">
          <form class="decide revise" method="POST" action="?/revise" use:enhance={parentGuard}>
            <input type="hidden" name="id" value={h.id} />
            <div class="ui-field">
              <span>Points to give instead (worth {h.possible}, gave {h.points})</span>
              <div class="stepper">
                <button type="button" class="step" aria-label="One point less" onclick={() => (revising.points = Math.max(0, (Number(revising.points) || 0) - 1))}>−</button>
                <input name="points" type="number" min="0" max="10000" step="1" bind:value={revising.points} required aria-label="Points to give instead" />
                <button type="button" class="step" aria-label="One point more" onclick={() => (revising.points = (Number(revising.points) || 0) + 1)}>+</button>
              </div>
            </div>
            <label class="ui-field">
              <span>Why the change? ({nameOf(h.assignee)} will see this)</span>
              <!-- svelte-ignore a11y_autofocus -->
              <input name="reason" bind:value={revising.reason} maxlength="300" required={Number(revising.points) !== h.possible} autofocus placeholder="e.g. I reviewed the wrong chore" />
            </label>
            <div class="actions">
              <button type="button" class="ui-btn" onclick={() => (revising = null)}>Back</button>
              <button class="ui-btn ui-primary">Save</button>
            </div>
          </form>
        </li>
      {/if}
    {/each}
  </ul>
{/if}

{/if}

<style>
  .locked { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 40px 16px; text-align: center; color: var(--app-muted); }
  .locked p { margin: 0; }
  .cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .card { padding: 14px 16px; border-radius: 12px; border: 1px solid var(--app-line); background: var(--app-surface); }
  .card-head { display: flex; justify-content: space-between; gap: 12px; }
  .meta { margin-top: 4px; font-size: 13px; color: var(--app-muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .notes { margin: 6px 0 0; font-size: 13px; color: var(--app-muted); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; margin-top: 12px; }
  .decide { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--app-line); }
  .stepper { display: flex; align-items: center; gap: 6px; }
  .stepper input { width: 90px; text-align: center; }
  .step {
    width: 38px; height: 38px; border-radius: 8px; border: 1px solid var(--app-line); background: none; cursor: pointer;
    color: var(--app-text); font: inherit; font-size: 20px; line-height: 1;
  }
  .step:hover:not(:disabled) { background: var(--app-hover); }
  .step:disabled { opacity: 0.4; cursor: default; }
  .stepper .chip { margin-left: 6px; }
  .quick { display: flex; gap: 6px; flex-wrap: wrap; }
  .quick-btn {
    padding: 5px 10px; border-radius: 999px; border: 1px solid var(--app-line); background: none; cursor: pointer;
    color: var(--app-text); font: inherit; font-size: 13px;
  }
  .quick-btn:hover { background: var(--app-hover); }
  .quick-btn.on { background: var(--app-accent); border-color: var(--app-accent); color: #fff; }
  .line { display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex-wrap: wrap; }
  .grow { flex: 1; min-width: 180px; }
  .small { padding: 5px 10px; font-size: 13px; }
  .revise { width: 100%; margin-top: 0; padding-top: 0; border-top: 0; }
</style>
