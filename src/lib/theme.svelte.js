// src/lib/theme.svelte.js — the app-wide light/dark setting, shared by the layout and every page.
// Remembered in this browser. Use it in a page with:
//   import { ui } from '$lib/theme.svelte.js';   …   {ui.theme}

const KEY = 'app-theme';

function saved() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {}
  return 'dark';
}

export const ui = $state({ theme: typeof localStorage === 'undefined' ? 'dark' : saved() });

export function setTheme(theme) {
  ui.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch {}
}
