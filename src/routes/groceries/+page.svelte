<script>
  import { onMount } from 'svelte';
  import { flip } from 'svelte/animate';
  import { slide } from 'svelte/transition';
  import { page } from '$app/state';
  import { createLiveList, newId } from '$lib/liveList.svelte.js';
  import { AISLES, aisleLabel, guessAisle, parseItem } from '$lib/groceryText.js';

  // Items: { id, name, qty?, aisle?, done, createdAt, doneAt, position, createdBy }. Typing "2 milk"
  // or "milk x2" sets the quantity; the aisle is guessed from the name and can be changed. Checked items stay saved
  // (done: true) so they can be put back from "Checked off"; "Clear" deletes them for good.
  // Everyone can add. Children can only check off, rename or delete items they added themselves
  // (the server enforces this too).
  const me = $derived(page.data.user);
  // kept on this device per person, so the list works without a connection (see liveList.svelte.js)
  const list = createLiveList('groceries', { scope: page.data.user?.id ?? null });
  const isChild = $derived(me?.role === 'child' || me?.role === 'kiosk'); // the shared tablet: add, and change only what was added on it
  const canChange = (item) => !isChild || item.createdBy === me?.id;
  const personName = (id) => page.data.people?.find((p) => p.id === id)?.name ?? 'someone else';
  onMount(() => {
    list.start();
    return () => list.stop();
  });

  let newName = $state('');
  let editing = $state(null); // { id, name } while renaming
  let showChecked = $state(false);
  let flashId = $state(null);

  // grouping by aisle is remembered on this device
  let byAisle = $state(readPref());
  function readPref() { try { return localStorage.getItem('groceries:byAisle') === '1'; } catch { return false; } }
  function setByAisle(v) { byAisle = v; try { localStorage.setItem('groceries:byAisle', v ? '1' : '0'); } catch {} }

  const tidy = (s) => s.trim().replace(/\s+/g, ' ');
  const keyOf = (s) => tidy(s).toLowerCase();
  const snap = (item) => $state.snapshot(item);
  const nextPosition = () => Math.max(0, ...list.items.map((i) => i.position ?? 0)) + 1;

  const toBuy = $derived(list.items.filter((i) => !i.done).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
  const aisleOf = (i) => i.aisle ?? guessAisle(i.name);
  const groups = $derived(
    AISLES.map(([id, label]) => ({ id, label, items: toBuy.filter((i) => aisleOf(i) === id) })).filter((g) => g.items.length)
  );
  const checkedOff = $derived(list.items.filter((i) => i.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)));

  // ---------- undo ----------
  // Every change records how to reverse it. Undo with the button, the message's Undo, or Ctrl/⌘+Z.
  let undoStack = $state.raw([]); // [{ label, undo }]
  let toast = $state(null);       // { text, canUndo }
  let toastTimer = 0;

  function record(label, undo) {
    undoStack = [...undoStack.slice(-49), { label, undo }];
    showToast(label, true);
  }

  function undoLast() {
    const last = undoStack.at(-1);
    if (!last) return;
    undoStack = undoStack.slice(0, -1);
    last.undo();
    showToast(`Undone: ${last.label.charAt(0).toLowerCase()}${last.label.slice(1)}`, false);
  }

  function showToast(text, canUndo) {
    toast = { text, canUndo };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 6000);
  }

  function flash(id) {
    flashId = id;
    setTimeout(() => { if (flashId === id) flashId = null; }, 1200);
  }

  // ---------- actions ----------
  function add(e) {
    e.preventDefault();
    const { name, qty } = parseItem(tidy(newName));
    if (!name) return;
    newName = '';
    const same = list.items.find((i) => keyOf(i.name) === keyOf(name));
    if (same && !same.done) {
      flash(same.id);
      if (!canChange(same)) { showToast(`“${same.name}” is already on the list`, false); return; }
      // already on the list: add to how many
      const before = snap(same);
      const total = Math.min(99, (same.qty ?? 1) + qty);
      list.put({ ...before, qty: total });
      record(`“${same.name}” is already on the list: now ${total}`, () => list.put(before));
      return;
    }
    if (same && canChange(same)) {
      // it was checked off before: put that one back instead of adding a duplicate
      const before = snap(same);
      const back = { ...before, done: false, doneAt: null, position: nextPosition() };
      if (qty > 1) back.qty = qty; else delete back.qty;
      list.put(back);
      record(`Added “${same.name}” back`, () => list.put(before));
      return;
    }
    const item = { id: newId(), name, done: false, createdAt: Date.now(), doneAt: null, position: nextPosition(), createdBy: me?.id };
    if (qty > 1) item.qty = qty;
    list.put(item);
    record(`Added ${qty > 1 ? `${qty} × ` : ''}“${name}”`, () => list.remove(item.id));
  }

  function checkOff(item) {
    const before = snap(item);
    list.put({ ...before, done: true, doneAt: Date.now() });
    record(`Checked off “${item.name}”`, () => list.put(before));
  }

  function putBack(item) {
    const before = snap(item);
    list.put({ ...before, done: false, doneAt: null, position: nextPosition() });
    record(`Put “${item.name}” back on the list`, () => list.put(before));
  }

  function remove(item) {
    const before = snap(item);
    list.remove(item.id);
    record(`Deleted “${item.name}”`, () => list.put(before));
  }

  function clearChecked() {
    const gone = checkedOff.map(snap);
    if (!gone.length) return;
    list.removeMany(gone.map((i) => i.id));
    record(`Cleared ${gone.length} checked-off item${gone.length === 1 ? '' : 's'}`, () => list.putMany(gone));
  }

  function changeQty(item, by) {
    const qty = Math.min(99, Math.max(1, (item.qty ?? 1) + by));
    if (qty === (item.qty ?? 1)) return;
    const before = snap(item);
    const next = { ...before, qty };
    if (qty === 1) delete next.qty;
    list.put(next);
    record(`“${item.name}”: ${qty}`, () => list.put(before));
  }

  function startEdit(item) {
    editing = { id: item.id, name: item.name, aisle: aisleOf(item), qty: item.qty ?? 1 };
  }

  function finishEdit(save = true) {
    if (!editing) return;
    const { id, name: raw, aisle } = editing;
    editing = null;
    const item = list.items.find((i) => i.id === id);
    const parsed = parseItem(tidy(raw));
    const name = parsed.name;
    if (!save || !item || !name) return;
    const qty = parsed.qty > 1 ? parsed.qty : item.qty ?? 1;
    const aisleChanged = aisle !== aisleOf(item);
    if (name === item.name && qty === (item.qty ?? 1) && !aisleChanged) return;
    const before = snap(item);
    const next = { ...before, name, qty };
    if (qty === 1) delete next.qty;
    // a chosen aisle is kept; otherwise it stays a guess that follows the name
    if (aisleChanged) next.aisle = aisle;
    list.put(next);
    record(name !== before.name ? `Renamed “${before.name}” to “${name}”` : aisleChanged ? `Moved “${name}” to ${aisleLabel(aisle)}` : `“${name}”: ${qty}`, () => list.put(before));
  }

  function onEditFocusOut(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) finishEdit(true);
  }

  // the server refused a change (rare): say so
  $effect(() => {
    if (list.notice) { showToast(list.notice, false); list.clearNotice(); }
  });

  function onKeydown(e) {
    // Ctrl/⌘+Z undoes, except while typing (so text fields keep their own undo)
    const typing = e.target.closest?.('input, textarea, [contenteditable="true"]');
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      undoLast();
    }
  }

  function focusOnMount(node) {
    node.focus();
    node.select();
  }
</script>

<svelte:window onkeydown={onKeydown} />
<svelte:head><title>Groceries · Famner</title></svelte:head>

<div class="page">
  <header class="head">
    <div class="title">
      <h1>Groceries</h1>
      {#if list.status === 'ready'}
        <span class="count">{toBuy.length} to buy</span>
      {/if}
    </div>
    <div class="head-actions">
      <span
        class="live-dot"
        class:on={list.live === 'live'}
        role="img"
        aria-label={list.live === 'live' ? 'Live updates on' : 'Reconnecting for live updates'}
        title={list.live === 'live' ? 'Live: changes from other devices show up instantly' : 'Reconnecting…'}
      ></span>
      {#if list.offline}
        <span class="saving" title="Changes are kept on this phone and sent when the server can be reached">
          Offline{list.unsent ? ` · ${list.unsent} to send` : ''}
        </span>
      {:else if list.saveStatus === 'error'}
        <button class="save-bad" title={list.saveError} onclick={list.retrySave}>Not saved · Retry</button>
      {:else if list.saveStatus === 'saving'}
        <span class="saving">Saving…</span>
      {/if}
      <button
        class="undo-btn"
        onclick={undoLast}
        disabled={!undoStack.length}
        title={undoStack.length ? `Undo: ${undoStack.at(-1).label} (Ctrl/⌘+Z)` : 'Nothing to undo'}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3" /></svg>
        Undo
      </button>
    </div>
  </header>

  {#if list.status === 'loading'}
    <p class="state">Loading the list…</p>
  {:else if list.status === 'error'}
    <div class="state">
      <p><strong>Couldn't load the grocery list.</strong> {list.saveError}</p>
      <button class="primary" onclick={list.reload}>Try again</button>
    </div>
  {:else}
    <form class="add" onsubmit={add}>
      <input
        type="text"
        bind:value={newName}
        placeholder="Add an item…"
        aria-label="New item"
        autocomplete="off"
        enterkeyhint="done"
      />
      <button class="primary" type="submit" disabled={!newName.trim()}>Add</button>
    </form>

    {#if toBuy.length > 1}
      <div class="view-bar">
        <label class="group-toggle">
          <input type="checkbox" checked={byAisle} onchange={(e) => setByAisle(e.currentTarget.checked)} />
          <span>Group by aisle</span>
        </label>
      </div>
    {/if}

    {#if toBuy.length}
      {#each byAisle ? groups : [{ id: 'all', label: '', items: toBuy }] as group (group.id)}
      {#if group.label}<h2 class="aisle">{group.label}</h2>{/if}
      <ul class="items">
        {#each group.items as item (item.id)}
          <li class="item" class:flash={flashId === item.id} animate:flip={{ duration: 200 }} transition:slide={{ duration: 180 }}>
            {#if canChange(item)}
              <button class="check" aria-label="Check off {item.name}" onclick={() => checkOff(item)}>
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
              </button>
            {:else}
              <span class="check static" title="Added by {personName(item.createdBy)}. Only they or a parent can check it off." aria-hidden="true"></span>
            {/if}
            {#if item.qty > 1 && editing?.id !== item.id}<span class="qty" aria-label="{item.qty} of">{item.qty}×</span>{/if}
            {#if !canChange(item)}
              <span class="name">{item.name} <small class="by">· {personName(item.createdBy)}</small></span>
            {:else if editing?.id === item.id}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="edit-row"
                onfocusout={onEditFocusOut}
                onkeydown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
                  if (e.key === 'Escape') finishEdit(false);
                }}
              >
                <input class="edit" type="text" bind:value={editing.name} aria-label="Item name" use:focusOnMount />
                <select class="edit-aisle" bind:value={editing.aisle} aria-label="Aisle">
                  {#each AISLES as [id, label] (id)}<option value={id}>{label}</option>{/each}
                </select>
              </div>
            {:else}
              <button class="name" title="Rename or change aisle" onclick={() => startEdit(item)}>{item.name}</button>
            {/if}
            {#if canChange(item) && editing?.id !== item.id}
              <span class="stepper">
                {#if item.qty > 1}<button class="step" aria-label="One fewer {item.name}" onclick={() => changeQty(item, -1)}>−</button>{/if}
                <button class="step" aria-label="One more {item.name}" onclick={() => changeQty(item, 1)}>+</button>
              </span>
            {/if}
            {#if canChange(item)}
              <button class="del" aria-label="Delete {item.name}" title="Delete" onclick={() => remove(item)}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            {/if}
          </li>
        {/each}
      </ul>
      {/each}
    {:else}
      <p class="empty">{checkedOff.length ? 'All done! Nothing left to buy.' : 'The list is empty. Add something above.'}</p>
    {/if}

    {#if checkedOff.length}
      <section class="checked">
        <div class="checked-head">
          <button class="toggle" aria-expanded={showChecked} onclick={() => (showChecked = !showChecked)}>
            <svg class:open={showChecked} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
            Checked off ({checkedOff.length})
          </button>
          {#if showChecked && !isChild}
            <button class="clear" onclick={clearChecked}>Clear all</button>
          {/if}
        </div>
        {#if showChecked}
          <ul class="items done" transition:slide={{ duration: 180 }}>
            {#each checkedOff as item (item.id)}
              <li class="item" animate:flip={{ duration: 200 }}>
                <button class="check on" aria-label="Put {item.name} back on the list" title={canChange(item) ? 'Put back on the list' : `Added by ${personName(item.createdBy)}`} disabled={!canChange(item)} onclick={() => putBack(item)}>
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
                </button>
                <span class="name struck">{item.qty > 1 ? `${item.qty} × ` : ''}{item.name}</span>
                {#if canChange(item)}
                  <button class="del" aria-label="Delete {item.name}" title="Delete" onclick={() => remove(item)}>
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/if}

  {#if toast}
    <div class="toast" role="status" transition:slide={{ duration: 150 }}>
      <span>{toast.text}</span>
      {#if toast.canUndo}<button onclick={undoLast}>Undo</button>{/if}
      <button class="x" aria-label="Dismiss" onclick={() => (toast = null)}>×</button>
    </div>
  {/if}
</div>

<style>
  .page { max-width: 640px; margin: 0 auto; padding: 20px 16px 96px; }
  svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
  button:disabled { cursor: default; opacity: 0.45; }

  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
  .title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
  h1 { margin: 0; font-size: 24px; }
  .count { color: var(--app-muted); font-size: 14px; white-space: nowrap; }
  .head-actions { display: flex; align-items: center; gap: 10px; }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--app-muted); opacity: 0.6; flex-shrink: 0; }
  .live-dot.on { background: #22c55e; opacity: 1; box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 25%, transparent); }
  .saving { font-size: 12px; color: var(--app-muted); }
  .save-bad { padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; color: #fff; background: #e5484d; }
  .undo-btn {
    display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 8px;
    border: 1px solid var(--app-line); color: var(--app-text);
  }
  .undo-btn:not(:disabled):hover { background: var(--app-hover); }

  .state { padding: 32px 0; text-align: center; color: var(--app-muted); }
  .state p { margin: 0 0 12px; }

  .add {
    position: sticky; top: calc(60px + var(--safe-top, env(safe-area-inset-top, 0px))); z-index: 5; display: flex; gap: 8px; margin-bottom: 12px;
    padding: 8px; border-radius: 12px; background: var(--app-surface); border: 1px solid var(--app-line);
  }
  .add input {
    flex: 1; min-width: 0; padding: 10px 12px; border-radius: 8px; border: 0;
    background: transparent; color: var(--app-text); font: inherit; font-size: 16px; /* 16px stops iOS zooming */
  }
  .add input:focus { outline: none; }
  .add:focus-within { border-color: var(--app-accent); }
  .primary { padding: 8px 16px; border-radius: 8px; background: var(--app-accent); color: #fff; font-weight: 600; }

  .items { list-style: none; margin: 0; padding: 0; border-radius: 12px; overflow: hidden; border: 1px solid var(--app-line); background: var(--app-surface); }
  .item { display: flex; align-items: center; gap: 4px; min-height: 52px; padding: 0 6px 0 10px; }
  .item + .item { border-top: 1px solid var(--app-line); }
  .item.flash { animation: flash 1.2s ease-out; }
  @keyframes flash { 0%, 40% { background: color-mix(in srgb, var(--app-accent) 25%, transparent); } }

  .check {
    display: grid; place-items: center; width: 26px; height: 26px; margin-right: 8px; flex-shrink: 0;
    border-radius: 50%; border: 2px solid var(--app-muted); color: transparent;
  }
  .check:hover { border-color: #22c55e; color: #22c55e; }
  .check.on { border-color: #22c55e; background: #22c55e; color: #fff; }
  .check.on:hover:not(:disabled) { background: transparent; color: #22c55e; }
  .check.on:disabled { opacity: 1; }
  .check.static { border-style: dotted; }
  .by { color: var(--app-muted); font-size: 12px; }

  .name {
    flex: 1; min-width: 0; padding: 14px 4px; text-align: left; font-size: 16px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: text;
  }
  span.name { cursor: default; }
  .struck { text-decoration: line-through; color: var(--app-muted); }
  .edit {
    flex: 1; min-width: 0; margin: 8px 0; padding: 6px 8px; font: inherit; font-size: 16px;
    color: var(--app-text); background: var(--app-bg); border: 1px solid var(--app-accent); border-radius: 6px;
  }
  .edit:focus { outline: none; }
  .del {
    display: grid; place-items: center; width: 36px; height: 36px; border-radius: 8px; color: var(--app-muted); flex-shrink: 0;
  }
  .del:hover { color: #e5484d; background: var(--app-hover); }
  @media (hover: hover) {
    .item .del { opacity: 0; }
    .item:hover .del, .del:focus-visible { opacity: 1; }
  }

  .view-bar { display: flex; justify-content: flex-end; margin: -4px 0 8px; }
  .group-toggle { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--app-muted); cursor: pointer; }
  .aisle { margin: 16px 0 6px 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--app-muted); }
  .aisle:first-of-type { margin-top: 4px; }
  .qty { flex-shrink: 0; min-width: 26px; padding: 2px 6px; border-radius: 999px; font-size: 13px; font-weight: 700; text-align: center; background: var(--app-hover); }
  .stepper { display: flex; gap: 2px; flex-shrink: 0; }
  .step { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; font-size: 18px; line-height: 1; color: var(--app-muted); }
  .step:hover { background: var(--app-hover); color: var(--app-text); }
  @media (hover: hover) {
    .item .stepper { opacity: 0; }
    .item:hover .stepper, .stepper:focus-within { opacity: 1; }
  }
  .edit-row { flex: 1; min-width: 0; display: flex; gap: 6px; align-items: center; }
  .edit-aisle {
    flex-shrink: 0; max-width: 40%; padding: 6px; font: inherit; font-size: 14px; color: var(--app-text);
    background: var(--app-bg); border: 1px solid var(--app-line); border-radius: 6px;
  }
  .empty { padding: 32px 0; text-align: center; color: var(--app-muted); }

  .checked { margin-top: 20px; }
  .checked-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .toggle { display: flex; align-items: center; gap: 6px; padding: 6px 4px; color: var(--app-muted); font-weight: 600; font-size: 14px; }
  .toggle svg { transition: transform 0.15s; }
  .toggle svg.open { transform: rotate(90deg); }
  .clear { padding: 6px 10px; border-radius: 8px; color: #e5484d; font-size: 14px; }
  .clear:hover { background: var(--app-hover); }
  .done .item { min-height: 44px; }
  .done .name { padding: 10px 4px; }

  .toast {
    position: fixed; left: 50%; bottom: calc(20px + var(--app-bottom-space, env(safe-area-inset-bottom, 0px))); /* above the tab bar on phones */ transform: translateX(-50%); z-index: 200;
    display: flex; align-items: center; gap: 12px; max-width: calc(100% - 32px);
    padding: 10px 10px 10px 16px; border-radius: 10px;
    background: var(--app-text); color: var(--app-bg); box-shadow: 0 8px 28px rgb(0 0 0 / 0.3);
  }
  .toast span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toast button { font-weight: 700; padding: 4px 8px; border-radius: 6px; color: #93c5fd; } /* on the dark toast */
  :global(:root:is([data-theme='dark'], [data-theme='oled'])) .toast button { color: #1d4ed8; }            /* on the light toast */
  .toast .x { font-size: 18px; line-height: 1; color: inherit; opacity: 0.7; font-weight: 400; }

  button:focus-visible, input:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; }
</style>
