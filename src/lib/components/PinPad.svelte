<script>
  // The kiosk's PIN pad: pick who you are (when more than one person fits), then type your PIN.
  // Shown by the layout whenever kiosk.ask is set (see $lib/kiosk.svelte.js).
  import { tick } from 'svelte';
  import { kiosk, submitPin, cancelPin } from '$lib/kiosk.svelte.js';

  const ROLE = { admin: 'Parent', parent: 'Parent', child: '' };
  let chosen = $state(null);
  let pin = $state('');
  let error = $state('');
  let busy = $state(false);
  let dlg;

  const ask = $derived(kiosk.ask);
  $effect(() => {
    if (ask) {
      chosen = ask.choices.length === 1 ? ask.choices[0] : null;
      pin = ''; error = ''; busy = false;
      tick().then(() => { if (!dlg?.open) dlg?.showModal(); });
    } else if (dlg?.open) dlg.close();
  });

  async function press(d) {
    if (busy || !chosen) return;
    error = '';
    if (pin.length < 4) pin += d;
    if (pin.length === 4) {
      busy = true;
      const problem = await submitPin(chosen.id, pin);
      busy = false;
      if (problem) { error = problem; pin = ''; }
    }
  }
  const back = () => { error = ''; pin = pin.slice(0, -1); };

  function onKey(e) {
    if (!ask || !chosen) return;
    if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); back(); }
  }
  const initials = (name) => (name ?? '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
</script>

<svelte:window onkeydown={onKey} />

<dialog bind:this={dlg} class="pinpad" onclose={() => kiosk.ask && cancelPin()} aria-labelledby="pin-title">
  {#if ask}
    <h2 id="pin-title">{chosen ? `${chosen.name}’s PIN` : ask.title}</h2>
    {#if !chosen}
      {#if ask.choices.length}
        <div class="people">
          {#each ask.choices as p (p.id)}
            <button class="person" onclick={() => (chosen = p)}>
              <span class="avatar">{initials(p.name)}</span>
              <span>{p.name}</span>
              {#if ROLE[p.role]}<small>{ROLE[p.role]}</small>{/if}
            </button>
          {/each}
        </div>
      {:else}
        <p class="none">Nobody can do this here.</p>
      {/if}
    {:else}
      <div class="dots" aria-label="{pin.length} of 4 digits entered" role="status">
        {#each [0, 1, 2, 3] as i}<span class:filled={i < pin.length}></span>{/each}
      </div>
      <p class="error" role="alert">{error}</p>
      <div class="keys">
        {#each ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as d}
          <button class="key" onclick={() => press(d)} disabled={busy}>{d}</button>
        {/each}
        <button class="key small" onclick={() => (ask.choices.length > 1 ? ((chosen = null), (pin = ''), (error = '')) : cancelPin())}>
          {ask.choices.length > 1 ? 'Not me' : 'Cancel'}
        </button>
        <button class="key" onclick={() => press('0')} disabled={busy}>0</button>
        <button class="key small" onclick={back} disabled={!pin || busy} aria-label="Delete last digit">⌫</button>
      </div>
    {/if}
    <button class="cancel" onclick={cancelPin}>Cancel</button>
  {/if}
</dialog>

<style>
  .pinpad {
    width: min(360px, calc(100vw - 32px)); padding: 24px; border: 1px solid var(--app-line); border-radius: 18px;
    background: var(--app-surface); color: var(--app-text); box-shadow: 0 20px 60px rgb(0 0 0 / 0.4);
  }
  .pinpad::backdrop { background: rgb(0 0 0 / 0.55); }
  h2 { margin: 0 0 16px; font-size: 20px; text-align: center; }
  .people { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; }
  .person {
    display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 6px; border-radius: 12px;
    border: 1px solid var(--app-line); background: none; color: inherit; font: inherit; cursor: pointer;
  }
  .person:hover, .person:focus-visible { background: var(--app-hover); }
  .person small { color: var(--app-muted); font-size: 11px; }
  .avatar {
    display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%;
    background: var(--app-accent); color: #fff; font-weight: 700;
  }
  .none { text-align: center; color: var(--app-muted); }
  .dots { display: flex; justify-content: center; gap: 14px; margin: 4px 0 6px; }
  .dots span { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--app-muted); }
  .dots span.filled { background: var(--app-text); border-color: var(--app-text); }
  .error { min-height: 20px; margin: 0 0 8px; text-align: center; color: #e5484d; font-size: 14px; }
  .keys { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .key {
    height: 64px; border-radius: 14px; border: 1px solid var(--app-line); background: var(--app-bg);
    color: var(--app-text); font: inherit; font-size: 26px; font-weight: 600; cursor: pointer; touch-action: manipulation;
  }
  .key.small { font-size: 15px; font-weight: 500; }
  .key:active:not(:disabled) { background: var(--app-hover); }
  .key:disabled { opacity: 0.4; }
  .cancel { display: block; margin: 16px auto 0; padding: 6px 14px; border: 0; background: none; color: var(--app-muted); font: inherit; cursor: pointer; }
</style>
