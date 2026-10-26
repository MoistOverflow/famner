# Famner — notes for Claude Code

Famner is a self-hosted family app: a shared calendar, chores with points and rewards, and a
grocery list. It's one SvelteKit (Svelte 5 runes) server on `adapter-node` with a SQLite file.
The owner runs it at home, on Docker and behind nginx (which handles HTTPS), and tests it on an
iPhone 15 Pro Max, added to the home screen.

## Commands

- `npm run dev`: dev server on port 5173 (`--host`, so phones on the network can reach it).
- `npm test`: the server and logic tests (Node's built-in runner, `tests/`). Each test file uses
  its own temporary database, never `data/`. Run this after any change in `src/lib`.
- `npm run build`, then `node build`: the production server (needs `ORIGIN`).
- Docker: `Dockerfile` and `docker-compose.yml`. Pushing to `main` publishes
  `ghcr.io/moistoverflow/famner:latest` through `.github/workflows/docker.yml`.

The svelte config lives in **`vite.config.ts`**; there is no `svelte.config.js`. It must stay on
`@sveltejs/adapter-node` (the Dockerfile checks this). `better-sqlite3` must stay in
`dependencies`, not devDependencies.

## How it's put together

- **Rendering:** browser only (`ssr = false` in `src/routes/+layout.js`).
- **`src/hooks.server.js`:** the sign-in check on every request. It also sends a temporary
  password to `/account` and a missing PIN to `/pin`, handles the kiosk unlock
  (`locals.acting`), keeps `/admin` for admins only, and starts the daily backups.
- **`src/lib/server/`**, the server side. Every module checks permissions itself, not only the
  pages:
  - `calendarDb.js`: calendars, events, who sees what, the role rules, and the live messages for
    each person (`messageFor`).
  - `auth.js`: accounts, scrypt passwords, sessions, PINs, and the kiosk unlock (`actingUser`).
  - `chores.js`: chores, reviews, the points history (append-only), rewards, and repeat rules
    (`readRepeat`, `advance`, worked out on the household's wall clock through `tz`).
  - `collections.js`: the grocery list (`list_items`).
  - `activity.js`: the admin activity log.
  - `backups.js`: daily `VACUUM INTO` backups. `reset.js`: factory reset, with a backup first.
- **Live updates:** Server-Sent Events at `/api/…/live`. Every change bumps a revision number; a
  client that misses one reloads. Browsers send a client id so they can ignore their own echo.
- **`src/lib/components/Calendar.svelte`:** the big calendar component. It handles the views,
  editor, drag and drop, the scope choice for repeating events, undo, import/export and syncing.
  The date and repeat logic, plus .ics reading and writing, is in `calendarUtils.js`.
- **Kiosk:** `src/lib/kiosk.svelte.js` (PIN pad state, `pinGuard` for forms) and
  `components/PinPad.svelte`.
- **Offline:** `src/service-worker.js` keeps a copy of the app and of answers. It only runs over
  https or localhost. `src/lib/offline.svelte.js` holds the offline state, and
  `liveList.svelte.js` keeps grocery changes on the device until they can be sent.

## Rules that matter

- **Roles:**
  - admin: everything, plus people, the log, backups and reset.
  - parent: changes everything shared, reviews chores, hands out rewards.
  - child: adds things and changes only what they added (`createdBy`).
  - kiosk: a shared tablet with a child's rights. Other actions need the right person's PIN.
    Marking a chore done takes **only the assignee's PIN**. The Review page and everything on it
    takes a parent's or admin's PIN. Changing an event takes its creator's PIN. The tablet sees
    only calendars shared with everyone or with the tablet itself.
- **Calendar visibility:** either everyone, or `private: true` plus `sharedWith: [userIds]`. Only
  the owner changes it. People it's shared with can look but never change it (enforced on the
  server).
- **Activity log:** titles from a child's private calendar are stored but blurred in the admin
  panel. Titles from an adult's private calendar are never stored.

## Gotchas we've hit

- **Svelte attributes:** a literal `{…}` inside a quoted attribute is read as code. Write
  `pattern={"[0-9]{4}"}`, not `pattern="\d{4}"`.
- **iPhone home-screen app (iOS 26):** the top bar must stay `position: fixed`, full width and in
  one solid colour, or iOS blurs it. The top inset is `--safe-top` (our own measurement, because
  iOS reports too little). `overscroll-behavior` stops the page rubber-banding.
- **`ORIGIN`** must match the address in the browser exactly, or sign-in fails with "Cross-site
  POST form submissions are forbidden".
- **One server only:** live updates are in-process, so never run several replicas.
- **Private data:** never commit `data/`, `*.db`, backups or `.env`. `.gitignore` and
  `.dockerignore` cover them.

## By hand

`TESTING.md` is the checklist of things only a real browser or phone can show: layout, drag,
notifications, the kiosk flow and offline mode. `DEPLOY.md` covers systemd and nginx, and
`DOCKER.md` covers Docker.
