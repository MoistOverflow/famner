// src/lib/theme.svelte.js — the app-wide theme: 'light', 'dark' or 'oled' (pure black, for OLED
// screens), shared by the layout and every page. It's an account setting (Account page), so it
// follows the person to every device; this browser also remembers it, so pages open in the right
// colours before the account has loaded. Use it in a page with:
//   import { ui } from '$lib/theme.svelte.js';   …   {ui.theme}   (or isDark(ui.theme))

const KEY = 'app-theme';
export const THEMES = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'oled', label: 'OLED black' }
];
const valid = (v) => THEMES.some((t) => t.id === v);

function saved() {
  try {
    const v = localStorage.getItem(KEY);
    if (valid(v)) return v;
  } catch { /* no storage (private mode): use the default */ }
  return 'dark';
}

export const ui = $state({ theme: typeof localStorage === 'undefined' ? 'dark' : saved() });

/** OLED black is a dark theme too (for anything that only knows light and dark). */
export const isDark = (theme) => theme !== 'light';

function apply(theme) {
  if (!valid(theme)) return;
  ui.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* not remembered on this device */ }
}

/** Use the theme saved on the signed-in person's account (when the page data arrives). */
export function followAccount(theme) {
  if (valid(theme) && theme !== ui.theme) apply(theme);
}

/** Choose a theme: right away here, and saved to the account for their other devices. */
export async function setTheme(theme) {
  apply(theme);
  try {
    const r = await fetch('/api/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }) });
    return r.ok;
  } catch {
    return false; // offline: this device has it; the account gets it next time it's chosen
  }
}
