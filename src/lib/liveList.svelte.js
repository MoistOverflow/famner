// src/lib/liveList.svelte.js — a list of items saved on the server and kept in sync live
// across every open device (used by Groceries; Chores can use it too).
//
//   const list = createLiveList('groceries');
//   onMount(() => { list.start(); return list.stop; });
//   list.items                      reactive array of items ({ id, … })
//   list.put(item) / list.remove(id) / list.putMany(items) / list.removeMany(ids)
//   list.status      'loading' | 'ready' | 'error'
//   list.saveStatus  'idle' | 'saving' | 'error'      list.saveError   text of the last problem
//   list.live        'connecting' | 'live' | 'offline'
//   list.notice      a message when the server refused a change (the list is then reloaded)
//   list.reload()    try loading again (e.g. after status 'error')
//
// Changes show up immediately on this device, are sent to the server shortly after (only what
// changed), and are retried with backoff if the server can't be reached.
//
// Offline: the last list seen and any changes not sent yet are kept on this device (per person,
// `scope`), so the list opens without a connection, changes can still be made, and they're sent
// when the server can be reached again (list.offline is true meanwhile). Other devices' changes
// arrive on the live stream; if one is missed, the list reloads. Local changes that haven't been
// saved yet are never overwritten by incoming ones; they're sent next, so the last change wins.

/** The session has ended (signed out elsewhere, password reset, account turned off): go sign in. */
function goToSignIn() {
  location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

import { keepLocal, readLocal, noteOffline, noteOnline } from './offline.svelte.js';

async function problem(res) {
  const err = new Error((await res.text().catch(() => '')).trim() || `The server answered ${res.status}.`);
  err.status = res.status;
  return err;
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export function createLiveList(name, { base = `/api/lists/${name}`, batchSize = 500, scope = null } = {}) {
  const clientId = newId();
  const s = $state({ items: [], status: 'loading', saveStatus: 'idle', saveError: '', live: 'connecting', notice: '', offline: false, savedAt: null, unsent: 0 });

  // kept on this device: the last list seen and the changes not sent yet
  const keyFor = (what) => (scope ? `list:${name}:${scope}:${what}` : null);
  const pending = new Map(readLocal(keyFor('pending')) ?? []); // id → item to save, or null to delete
  s.unsent = pending.size;
  const keepPending = () => { s.unsent = pending.size; if (keyFor('pending')) keepLocal(keyFor('pending'), [...pending]); };
  const keepSnapshot = () => keyFor('items') && keepLocal(keyFor('items'), { rev, items: $state.snapshot(s.items), at: Date.now() });
  const isNetworkError = (err) => !err.status || err.status >= 500 || err.status === 0;
  let rev = 0, loading = false, buffer = [];
  let saveTimer = 0, retryTimer = 0, retryDelay = 2000, inflight = null, again = false;
  let es = null, reconnectTimer = 0, reconnectTries = 0, started = false;

  // ---------- loading ----------
  async function load() {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch(base, { cache: 'no-store' });
      if (!res.ok) throw await problem(res);
      const savedAt = Number(res.headers.get('x-famner-saved')) || null; // a saved copy (the service worker, offline)
      const data = await res.json();
      rev = data.rev ?? 0;
      const byId = new Map(data.items.map((i) => [i.id, i]));
      for (const [id, item] of pending) item === null ? byId.delete(id) : byId.set(id, item); // keep unsaved edits
      s.items = [...byId.values()];
      s.status = 'ready';
      s.offline = !!savedAt;
      s.savedAt = savedAt;
      if (savedAt) noteOffline(savedAt);
      else { keepSnapshot(); if (pending.size) scheduleSave(0); }
      loading = false;
      const queued = buffer.sort((a, b) => a.rev - b.rev);
      buffer = [];
      for (const m of queued) onChange(m);
    } catch (err) {
      if (err.status === 401) return goToSignIn();
      console.warn(`List "${name}": could not load`, err);
      const snap = isNetworkError(err) ? readLocal(keyFor('items')) : null;
      if (snap && s.status !== 'ready') {
        // no connection: show the list as last seen here, with this device's unsent changes on top
        rev = snap.rev ?? 0;
        const byId = new Map(snap.items.map((i) => [i.id, i]));
        for (const [id, item] of pending) item === null ? byId.delete(id) : byId.set(id, item);
        s.items = [...byId.values()];
        s.status = 'ready';
        s.offline = true;
        s.savedAt = snap.at;
        noteOffline(snap.at);
      } else if (s.status !== 'ready') { s.status = 'error'; s.saveError = err.message; }
      else if (isNetworkError(err)) { s.offline = true; noteOffline(); }
    } finally {
      loading = false;
    }
  }

  // ---------- local changes ----------
  function put(item) {
    const i = s.items.findIndex((x) => x.id === item.id);
    if (i >= 0) s.items[i] = item;
    else s.items.push(item);
    pending.set(item.id, item);
    keepPending();
    scheduleSave();
  }

  function remove(id) {
    s.items = s.items.filter((x) => x.id !== id);
    pending.set(id, null);
    keepPending();
    scheduleSave();
  }

  const putMany = (items) => items.forEach(put);
  const removeMany = (ids) => ids.forEach(remove);

  function scheduleSave(delay = 250) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, delay);
  }

  async function send(body) {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-List-Client': clientId },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw await problem(res);
  }

  async function flush() {
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    if (inflight) { again = true; return; }
    if (!pending.size) { s.saveStatus = 'idle'; return; }
    const batch = [...pending].slice(0, batchSize);
    const body = { upsert: [], delete: [] };
    for (const [id, item] of batch) item === null ? body.delete.push(id) : body.upsert.push($state.snapshot(item));
    s.saveStatus = 'saving';
    inflight = send(body);
    try {
      await inflight;
      for (const [id, item] of batch) if (pending.get(id) === item) pending.delete(id); // unless changed again meanwhile
      keepPending();
      keepSnapshot();
      retryDelay = 2000;
      s.saveStatus = 'idle';
      s.saveError = '';
      if (s.offline) { s.offline = false; s.savedAt = null; noteOnline(); }
    } catch (err) {
      if (err.status === 401) { goToSignIn(); return; }
      if (err.status === 400 || err.status === 403) {
        // refused (e.g. a child changing someone else's item): drop these changes and show what the server has
        for (const [id, item] of batch) if (pending.get(id) === item) pending.delete(id);
        keepPending();
        s.saveStatus = 'idle';
        s.notice = `Couldn’t save: ${err.message}`;
        load();
        return;
      }
      console.warn(`List "${name}": could not save`, err);
      s.saveStatus = 'error';
      s.saveError = err.message;
      if (isNetworkError(err)) { s.offline = true; noteOffline(); }
      retryTimer = setTimeout(flush, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    } finally {
      inflight = null;
    }
    if (again || (s.saveStatus === 'idle' && pending.size)) { again = false; flush(); }
  }

  // ---------- live changes from other devices ----------
  function onChange(msg) {
    if (loading || s.status !== 'ready') { buffer.push(msg); return; }
    if (msg.rev <= rev) return;                    // already have it
    if (msg.rev > rev + 1) { load(); return; }      // missed one or more: reload (unsaved edits are kept)
    rev = msg.rev;
    if (msg.origin && msg.origin === clientId) return; // our own save coming back
    const byId = new Map(s.items.map((i) => [i.id, i]));
    for (const item of msg.changes?.upsert ?? []) if (!pending.has(item.id)) byId.set(item.id, item);
    for (const id of msg.changes?.delete ?? []) if (!pending.has(id)) byId.delete(id);
    s.items = [...byId.values()];
    keepSnapshot();
  }

  function connect() {
    if (typeof EventSource === 'undefined') { s.live = 'offline'; return; }
    es = new EventSource(`${base}/live`);
    es.addEventListener('hello', (e) => {
      reconnectTries = 0;
      const serverRev = JSON.parse(e.data).rev;
      if (s.status === 'ready' && !loading && serverRev !== rev) load(); // changed while we weren't listening
    });
    es.addEventListener('change', (e) => onChange(JSON.parse(e.data)));
    es.onopen = () => (s.live = 'live');
    es.onerror = () => {
      s.live = 'offline';
      if (es.readyState === EventSource.CLOSED && started) {
        fetch('/api/me', { cache: 'no-store' }).then((r) => { if (r.status === 401) goToSignIn(); }).catch(() => {});
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, Math.min(30000, 2000 * 2 ** reconnectTries++));
      }
    };
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible' && es?.readyState === EventSource.CLOSED && started) {
      clearTimeout(reconnectTimer);
      connect();
    }
  };
  const onOnline = () => {
    retryDelay = 2000;
    if (pending.size) flush();
    if (s.offline) load();
  };
  const onLeave = () => { if (pending.size && !inflight) flush(); }; // unsent changes are kept on the device anyway

  return {
    get items() { return s.items; },
    get status() { return s.status; },
    get saveStatus() { return s.saveStatus; },
    get saveError() { return s.saveError; },
    get live() { return s.live; },
    get notice() { return s.notice; },
    get offline() { return s.offline; },
    get savedAt() { return s.savedAt; },
    get unsent() { return s.unsent; },
    clearNotice: () => (s.notice = ''),
    put, remove, putMany, removeMany,
    reload: load,
    retrySave: () => { retryDelay = 2000; flush(); },

    /** Load, connect to the live stream, and watch for going offline/away. Call once on mount. */
    start() {
      if (started) return;
      started = true;
      load();
      connect();
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('online', onOnline);
      window.addEventListener('beforeunload', onLeave);
    },

    /** Stop listening (call on unmount). Unsaved changes are sent first. */
    stop() {
      started = false;
      if (pending.size) flush();
      clearTimeout(reconnectTimer);
      es?.close();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('beforeunload', onLeave);
    }
  };
}
