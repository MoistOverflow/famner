<script>
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { slide } from 'svelte/transition';
  import { dueLabel, repeatLabel, OUTCOME, pointsText, WEEKDAYS, resultPoints, monthlyOptions } from '$lib/choreText.js';
  import { pinGuard } from '$lib/kiosk.svelte.js';

  let { data, form } = $props();
  const s = $derived(data.chores);
  const me = $derived(page.data.user);
  const adult = $derived(me?.role === 'admin' || me?.role === 'parent');
  const isKiosk = $derived(me?.role === 'kiosk'); // the shared tablet: everyone's chores, with PINs
  const people = $derived((page.data.people ?? []).filter((p) => p.role !== 'kiosk'));
  // on the kiosk: only the person the chore is for marks it done (their PIN); a parent's PIN checks it
  const doneNeed = (c) => (c.status === 'submitted'
    ? { parents: true, title: `A parent checks “${c.title}”` }
    : { people: [c.assignee], title: `${nameOf(c.assignee)} finished “${c.title}”` });
  const nameOf = (id) => (id === me?.id ? 'You' : people.find((p) => p.id === id)?.name ?? 'Someone');

  // a clock for "overdue" labels
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 60000);
    return () => clearInterval(t);
  });

  const mine = $derived(s.chores.filter((c) => c.assignee === me.id));
  const others = $derived.by(() => {
    const byPerson = new Map();
    for (const c of s.chores) {
      if (c.assignee === me.id) continue;
      if (!byPerson.has(c.assignee)) byPerson.set(c.assignee, []);
      byPerson.get(c.assignee).push(c);
    }
    return [...byPerson].map(([id, list]) => ({ id, name: nameOf(id), list })).sort((a, b) => a.name.localeCompare(b.name));
  });
  let showHistory = $state(false);

  // ---------- the add / edit form ----------
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  // null | { id?, title, assignee, points, date, time, notes, repeat, days, interval, unit, monthBy, from, ends, until, count }
  let editing = $state(null);
  const REPEAT_DEFAULTS = { interval: 2, unit: 'weekly', monthBy: 'day', from: 'schedule', ends: 'never', until: '', count: 10 };
  let confirmDelete = $state(null);
  let skipping = $state(null); // { id, reason }

  function startNew() {
    const due = new Date();
    due.setHours(19, 0, 0, 0);
    if (due < new Date()) due.setDate(due.getDate() + 1);
    editing = { id: null, title: '', assignee: me.id, points: 10, date: ymd(due), time: hm(due), repeat: 'none', days: [due.getDay()], notes: '', ...REPEAT_DEFAULTS };
  }

  function startEdit(c) {
    const due = new Date(c.due);
    const r = c.repeat;
    const custom = !!r && (r.from === 'done' || (r.interval ?? 1) > 1);
    editing = {
      id: c.id, title: c.title, assignee: c.assignee, points: c.points, date: ymd(due), time: hm(due), notes: c.notes ?? '',
      ...REPEAT_DEFAULTS,
      repeat: !r ? 'none' : custom ? 'custom' : r.freq,
      days: r?.days ?? [due.getDay()],
      interval: r?.interval ?? (custom ? 1 : 2),
      unit: custom ? (r.freq === 'weekdays' ? 'daily' : r.freq) : REPEAT_DEFAULTS.unit,
      monthBy: r?.monthBy ?? 'day',
      from: r?.from ?? 'schedule',
      ends: r?.until ? 'on' : r?.count ? 'after' : 'never',
      until: r?.until ?? '',
      count: r?.count ?? 10
    };
  }

  const dueIso = $derived(editing?.date && editing?.time ? new Date(`${editing.date}T${editing.time}`).toISOString() : '');
  // which parts of the repeat form apply
  const firstDue = $derived(editing?.date ? new Date(`${editing.date}T12:00`) : new Date());
  const onSchedule = $derived(editing?.repeat !== 'custom' || editing.from === 'schedule');
  const unitNow = $derived(editing?.repeat === 'custom' ? editing.unit : editing?.repeat);
  const showDays = $derived(onSchedule && unitNow === 'weekly');
  const monthChoices = $derived(monthlyOptions(firstDue));
  const showMonthBy = $derived(onSchedule && unitNow === 'monthly');
  $effect(() => { if (editing && !monthChoices.some((o) => o.value === editing.monthBy)) editing.monthBy = 'day'; });
  /** The rule as the server will save it, for the summary line. */
  const preview = $derived.by(() => {
    if (!editing || editing.repeat === 'none') return '';
    const d = firstDue;
    const freq = editing.repeat === 'custom' ? editing.unit : editing.repeat;
    const r = { freq, interval: editing.repeat === 'custom' ? Math.max(1, Number(editing.interval) || 1) : 1, anchor: editing.date };
    if (editing.repeat === 'custom' && editing.from === 'done') r.from = 'done';
    else {
      if (freq === 'weekly') r.days = editing.days.length ? editing.days : [d.getDay()];
      if (freq === 'monthly') Object.assign(r, { monthBy: editing.monthBy, monthDay: d.getDate(), nth: Math.ceil(d.getDate() / 7), weekday: d.getDay() });
      if (freq === 'yearly') r.monthDay = d.getDate();
    }
    if (editing.ends === 'on' && editing.until) r.until = editing.until;
    if (editing.ends === 'after') { r.count = Number(editing.count) || 1; r.seq = 1; }
    return repeatLabel(r);
  });
  const toggleDay = (d) => (editing.days = editing.days.includes(d) ? editing.days.filter((x) => x !== d) : [...editing.days, d].sort());

  // close the form once a save works
  $effect(() => {
    if (form?.ok && (form.action === 'create' || form.action === 'update')) editing = null;
    if (form?.ok && form.action === 'delete') confirmDelete = null;
    if (form?.ok && form.action === 'skip') skipping = null;
  });
</script>

<svelte:head><title>Chores · Famner</title></svelte:head>

{#snippet choreRow(c)}
  {@const due = dueLabel(c.due, now)}
  {@const isMine = c.assignee === me.id}
  {@const waiting = c.status === 'submitted'}
  <li class="chore" class:late={due.tone === 'late' && !waiting}>
    {#if (isMine || adult || isKiosk) && !(waiting && !adult && !isKiosk)}
      <form method="POST" action="?/complete" use:enhance={pinGuard(() => doneNeed(c))}>
        <input type="hidden" name="id" value={c.id} />
        <button
          class="done-btn"
          class:approve={waiting}
          aria-label={waiting ? `Approve ${c.title}` : isMine ? `Mark ${c.title} done` : `Mark ${c.title} done for ${nameOf(c.assignee)}`}
          title={waiting ? 'Approve with full points' : isMine ? 'Mark done' : `Mark done for ${nameOf(c.assignee)}`}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
        </button>
      </form>
    {:else}
      <span class="done-btn waiting" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z" /></svg>
      </span>
    {/if}

    <div class="main">
      <div class="title-line">
        <strong>{c.title}</strong>
        {#if c.points}<span class="pts">+{c.points}</span>{/if}
      </div>
      <div class="meta">
        <span class="due {due.tone}">{due.text}</span>
        {#if c.repeat}<span>· {repeatLabel(c.repeat)}</span>{/if}
      </div>
      {#if c.notes}<p class="notes">{c.notes}</p>{/if}
      {#if waiting}
        <div class="waiting-line">
          <span class="chip wait">{adult || isKiosk ? `${nameOf(c.assignee)} says it’s done` : 'Waiting for a parent to check'}</span>
          {#if adult || isKiosk}
            <a href="/chores/review">Review</a>
          {/if}
          {#if !adult}
            <form method="POST" action="?/unsubmit" use:enhance={pinGuard(() => ({ people: [c.assignee], parents: true, title: `Not done yet: “${c.title}”` }))}>
              <input type="hidden" name="id" value={c.id} />
              <button class="link">Not done yet</button>
            </form>
          {/if}
        </div>
      {/if}
    </div>

    {#if adult}
      <div class="row-actions">
        <button class="icon" aria-label="Edit {c.title}" title="Edit" onclick={() => startEdit(c)}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" /></svg>
        </button>
        {#if c.repeat}
          <button class="icon" aria-label="Skip this {c.title}" title="Skip this one" onclick={() => { skipping = { id: c.id, reason: '' }; confirmDelete = null; }}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 5l9 7-9 7zM17 5v14" /></svg>
          </button>
        {/if}
        <button class="icon" aria-label="Remove {c.title}" title="Remove" onclick={() => { confirmDelete = c.id; skipping = null; }}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
        </button>
      </div>
    {/if}
  </li>
  {#if skipping?.id === c.id}
    <li class="confirm" transition:slide={{ duration: 150 }}>
      <form class="skip-form" method="POST" action="?/skip" use:enhance>
        <input type="hidden" name="id" value={c.id} />
        <span>Skip the one due {dueLabel(c.due, now).text.replace(/^(Overdue · was due|Due) /, '')}? No points; the next one becomes due.</span>
        <input class="skip-reason" name="reason" bind:value={skipping.reason} maxlength="300" placeholder="Reason (optional), e.g. Sick day" aria-label="Reason for skipping" />
        <button type="button" class="ui-btn" onclick={() => (skipping = null)}>Back</button>
        <button class="ui-btn ui-primary">Skip it</button>
      </form>
    </li>
  {/if}
  {#if confirmDelete === c.id}
    <li class="confirm" transition:slide={{ duration: 150 }}>
      <span>Remove “{c.title}”{c.repeat ? ' and all its repeats' : ''}? Points already earned are kept.</span>
      <button class="ui-btn" onclick={() => (confirmDelete = null)}>Keep</button>
      <form method="POST" action="?/delete" use:enhance>
        <input type="hidden" name="id" value={c.id} />
        <button class="ui-btn ui-danger ui-solid">Remove</button>
      </form>
    </li>
  {/if}
  {#if editing?.id === c.id}
    <li class="edit-row">{@render choreForm()}</li>
  {/if}
{/snippet}

{#snippet choreForm()}
  <form class="chore-form" method="POST" action={editing.id ? '?/update' : '?/create'} use:enhance>
    {#if editing.id}<input type="hidden" name="id" value={editing.id} />{/if}
    <input type="hidden" name="due" value={dueIso} />
    <input type="hidden" name="tz" value={tz} />
    <h2>{editing.id ? 'Edit chore' : 'New chore'}</h2>
    <div class="grid">
      <label class="ui-field wide">
        <span>Chore</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input name="title" bind:value={editing.title} required maxlength="100" placeholder="e.g. Empty the dishwasher" autofocus />
      </label>
      <label class="ui-field">
        <span>For</span>
        <select name="assignee" bind:value={editing.assignee}>
          {#each people as p (p.id)}<option value={p.id}>{p.id === me.id ? `${p.name} (you)` : p.name}</option>{/each}
        </select>
      </label>
      <label class="ui-field">
        <span>Points</span>
        <input name="points" type="number" min="0" max="10000" step="1" bind:value={editing.points} required />
      </label>
      <label class="ui-field">
        <span>Due date</span>
        <input type="date" bind:value={editing.date} required />
      </label>
      <label class="ui-field">
        <span>Due time</span>
        <input type="time" bind:value={editing.time} required />
      </label>
      <label class="ui-field wide">
        <span>Repeat</span>
        <select name="repeat" bind:value={editing.repeat}>
          <option value="none">Doesn’t repeat</option>
          <option value="daily">Every day</option>
          <option value="weekdays">Every weekday (Mon–Fri)</option>
          <option value="weekly">Every week on…</option>
          <option value="monthly">Every month</option>
          <option value="yearly">Every year</option>
          <option value="custom">Custom…</option>
        </select>
      </label>
      {#if editing.repeat === 'custom'}
        <div class="repeat-box wide">
          <div class="every">
            <span>Every</span>
            <input class="num" name="interval" type="number" min="1" max="365" step="1" bind:value={editing.interval} required aria-label="How many" />
            <select name="unit" bind:value={editing.unit} aria-label="Days, weeks, months or years">
              <option value="daily">{editing.interval == 1 ? 'day' : 'days'}</option>
              <option value="weekly">{editing.interval == 1 ? 'week' : 'weeks'}</option>
              <option value="monthly">{editing.interval == 1 ? 'month' : 'months'}</option>
              <option value="yearly">{editing.interval == 1 ? 'year' : 'years'}</option>
            </select>
          </div>
          <div class="radios" role="radiogroup" aria-label="When the next one is due">
            <label><input type="radio" name="from" value="schedule" bind:group={editing.from} /> On a fixed schedule</label>
            <label><input type="radio" name="from" value="done" bind:group={editing.from} /> Counting from when the last one was done</label>
          </div>
        </div>
      {/if}
      {#if showMonthBy}
        <div class="radios wide" role="radiogroup" aria-label="Which day of the month">
          {#each monthChoices as o (o.value)}
            <label><input type="radio" name="monthBy" value={o.value} bind:group={editing.monthBy} /> {o.label}</label>
          {/each}
        </div>
      {/if}
      {#if showDays}
        <div class="days wide" role="group" aria-label="Repeat on">
          {#each [1, 2, 3, 4, 5, 6, 0] as d}
            <label class="day" class:on={editing.days.includes(d)}>
              <input type="checkbox" name="days" value={d} checked={editing.days.includes(d)} onchange={() => toggleDay(d)} />
              {WEEKDAYS[d].slice(0, 3)}
            </label>
          {/each}
        </div>
      {/if}
      {#if editing.repeat !== 'none'}
        <div class="radios wide ends" role="radiogroup" aria-label="When the repeat ends">
          <span class="sub">Ends</span>
          <label><input type="radio" name="ends" value="never" bind:group={editing.ends} /> Never</label>
          <label>
            <input type="radio" name="ends" value="on" bind:group={editing.ends} /> On
            <input type="date" name="until" bind:value={editing.until} min={editing.date} aria-label="Last date" onfocus={() => (editing.ends = 'on')} required={editing.ends === 'on'} />
          </label>
          <label>
            <input type="radio" name="ends" value="after" bind:group={editing.ends} /> After
            <input class="num" type="number" name="count" min="1" max="999" bind:value={editing.count} aria-label="Number of times" onfocus={() => (editing.ends = 'after')} />
            {editing.count == 1 ? 'time' : 'times'}
          </label>
        </div>
        {#if preview}<p class="ui-hint wide repeat-summary">{preview}</p>{/if}
      {/if}
      <label class="ui-field wide">
        <span>Notes (optional)</span>
        <input name="notes" bind:value={editing.notes} maxlength="500" placeholder="Anything they should know" />
      </label>
    </div>
    {#if editing.repeat !== 'none'}
      <p class="ui-hint">
        One at a time: the next one becomes due after this one is finished{editing.assignee !== me.id ? ' and reviewed' : ''}{editing.repeat === 'custom' && editing.from === 'done' ? `, ${Number(editing.interval) || 1} ${({ daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' })[editing.unit]}${Number(editing.interval) === 1 ? '' : 's'} after the day it was done` : ''}.
      </p>
    {/if}
    {#if form?.error && (form.action === 'create' || form.action === 'update')}<p class="ui-error" role="alert">{form.error}</p>{/if}
    <div class="form-actions">
      <button type="button" class="ui-btn" onclick={() => (editing = null)}>Cancel</button>
      <button type="submit" class="ui-btn ui-primary">{editing.id ? 'Save' : 'Add chore'}</button>
    </div>
  </form>
{/snippet}

{#if form?.error && !['create', 'update'].includes(form.action)}<p class="ui-error" role="alert">{form.error}</p>{/if}
{#if form?.ok && form.action === 'complete' && form.status === 'submitted'}
  <p class="ui-ok" role="status">Nice! A parent will check it and give {isKiosk ? 'the' : 'you the'} points.</p>
{:else if form?.ok && form.action === 'complete' && isKiosk}
  <p class="ui-ok" role="status">Done{form.status === 'approved' ? ', points given' : ''}!</p>
{/if}

{#if adult}
  {#if editing && !editing.id}
    <div class="new-form">{@render choreForm()}</div>
  {:else if !editing}
    <button class="ui-btn ui-primary add" onclick={startNew}>+ New chore</button>
  {/if}
{/if}

{#if isKiosk}
  {#if !s.chores.length}<p class="empty">No chores right now. 🎉</p>{/if}
{:else}
  <h2 class="section-title">Your chores</h2>
  {#if mine.length}
    <ul class="rows">{#each mine as c (c.id)}{@render choreRow(c)}{/each}</ul>
  {:else}
    <p class="empty">{adult ? 'Nothing assigned to you.' : 'No chores right now. 🎉'}</p>
  {/if}
{/if}

{#each others as group (group.id)}
  <h2 class="section-title">{group.name}</h2>
  <ul class="rows">{#each group.list as c (c.id)}{@render choreRow(c)}{/each}</ul>
{/each}

{#if s.history.length}
  <button class="history-toggle" aria-expanded={showHistory} onclick={() => (showHistory = !showHistory)}>
    <svg class:open={showHistory} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
    Finished in the last 30 days ({s.history.length})
  </button>
  {#if showHistory}
    <ul class="rows history" transition:slide={{ duration: 180 }}>
      {#each s.history as h (h.id)}
        <li>
          <div class="main">
            <div class="title-line">
              <strong>{h.title}</strong>
              <span class="chip {OUTCOME[h.outcome]?.tone}">{OUTCOME[h.outcome]?.label}</span>
              <span class="pts">{resultPoints(h)}</span>
            </div>
            <div class="meta">
              {#if adult || isKiosk}{nameOf(h.assignee)} · {/if}
              {new Date(h.doneAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              {#if h.doneAt > h.due} · late{/if}
            </div>
            {#if h.reason}<p class="notes">“{h.reason}”{h.reviewedBy ? ` — ${nameOf(h.reviewedBy)}` : ''}</p>{/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .repeat-box { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 10px; background: var(--app-hover); }
  .every { display: flex; align-items: center; gap: 8px; }
  .num { width: 72px; }
  .radios { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; font-size: 14px; }
  .radios label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .ends .sub { font-weight: 600; color: var(--app-muted); }
  .repeat-summary { margin: 0; font-weight: 600; color: var(--app-text); }
  svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
  button { font: inherit; color: inherit; }
  .add { margin-bottom: 4px; }
  .new-form { margin-bottom: 8px; }

  .chore { display: flex; align-items: flex-start; gap: 12px; padding: 12px 12px 12px 14px; }
  .chore.late { background: color-mix(in srgb, #e5484d 7%, transparent); }
  .done-btn {
    display: grid; place-items: center; width: 30px; height: 30px; margin-top: 1px; flex-shrink: 0; cursor: pointer;
    border-radius: 50%; border: 2px solid var(--app-muted); background: none; color: transparent;
  }
  .done-btn:hover { border-color: #22c55e; color: #22c55e; }
  .done-btn.approve { border-color: var(--app-accent); color: var(--app-accent); }
  .done-btn.waiting { cursor: default; border-style: dashed; color: var(--app-accent); border-color: var(--app-accent); }
  .main { flex: 1; min-width: 0; }
  .title-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .meta { margin-top: 2px; font-size: 13px; color: var(--app-muted); display: flex; gap: 4px; flex-wrap: wrap; }
  .due.late { color: #e5484d; font-weight: 600; }
  .due.soon { color: var(--app-text); font-weight: 600; }
  .notes { margin: 6px 0 0; font-size: 13px; color: var(--app-muted); }
  .waiting-line { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; font-size: 13px; }
  .waiting-line a { color: var(--app-accent); font-weight: 600; }
  .link { border: 0; background: none; padding: 0; color: var(--app-accent); cursor: pointer; font-weight: 600; font-size: 13px; }
  .row-actions { display: flex; gap: 2px; }
  .icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; border: 0; background: none; color: var(--app-muted); cursor: pointer; }
  .icon:hover { background: var(--app-hover); color: var(--app-text); }
  @media (hover: hover) {
    .row-actions { opacity: 0; }
    .chore:hover .row-actions, .row-actions:focus-within { opacity: 1; }
  }
  .confirm { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; background: var(--app-bg); font-size: 14px; }
  .confirm span { flex: 1; min-width: 200px; }
  .skip-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; width: 100%; }
  .skip-reason {
    flex: 1 1 200px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--app-line);
    background: var(--app-surface); color: var(--app-text); font: inherit; font-size: 15px;
  }
  .edit-row { padding: 0; }

  .chore-form { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .new-form .chore-form { border-radius: 12px; border: 1px solid var(--app-accent); background: var(--app-surface); }
  .edit-row .chore-form { background: var(--app-bg); }
  .chore-form h2 { margin: 0; font-size: 16px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .grid .wide { grid-column: 1 / -1; }
  @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
  .chore-form select {
    padding: 10px 12px; border-radius: 8px; border: 1px solid var(--app-line); background: var(--app-bg);
    color: var(--app-text); font: inherit; font-size: 16px;
  }
  .days { display: flex; gap: 6px; flex-wrap: wrap; }
  .day {
    position: relative; padding: 6px 10px; border-radius: 999px; border: 1px solid var(--app-line); cursor: pointer;
    font-size: 13px; font-weight: 600; user-select: none;
  }
  .day input { position: absolute; opacity: 0; pointer-events: none; }
  .day.on { background: var(--app-accent); border-color: var(--app-accent); color: #fff; }
  .day:focus-within { outline: 2px solid var(--app-accent); outline-offset: 2px; }
  .form-actions { display: flex; justify-content: flex-end; gap: 8px; }

  .history-toggle {
    display: flex; align-items: center; gap: 6px; margin-top: 24px; padding: 6px 2px; border: 0; background: none; cursor: pointer;
    color: var(--app-muted); font-weight: 600; font-size: 14px;
  }
  .history-toggle svg { transition: transform 0.15s; }
  .history-toggle svg.open { transform: rotate(90deg); }
  .history { margin-top: 8px; }
  .history li { padding: 10px 14px; }
  .done-btn:focus-visible, .icon:focus-visible, .link:focus-visible, .history-toggle:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; }
</style>
