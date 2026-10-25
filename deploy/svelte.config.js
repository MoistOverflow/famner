// svelte.config.js — the production setup: a single Node server (needed for live updates and SQLite).
// Replace your project's svelte.config.js with this, then: npm install -D @sveltejs/adapter-node
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ out: 'build' })
  }
};
