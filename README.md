# Famner

**A family calendar, chore chart and grocery list you host yourself.** One small server for the
whole household: everyone signs in on their phone, the kids earn points for chores, and a
tablet on the wall shows the day. Changes show up on every device instantly, and your
family's data stays on your own machine.

Built with SvelteKit and SQLite. Runs from Docker or straight from Node.js.

---

## What it does

### 📅 Calendar
- **Views:** day, week and month, sized to fit the screen. The day and week views open at the current time.
- **Creating and editing:** drag to create, move or resize events, snapped to 15 minutes. Times in the editor are exact to the minute.
- **Repeating events:**
  - Daily, weekly on chosen days, monthly (the 15th, the 3rd Tuesday, the last Friday) and yearly.
  - Every N days, weeks, months or years.
  - Ends on a date or after N times.
- **Changing a repeating event:** edit *this event*, *this and following*, or *all events*. Dragging one asks which you mean.
- **Undo:** the message after a change has an Undo button, and Ctrl/⌘+Z works too.
- **Bringing events in:** import `.ics` files, or subscribe to a calendar by its web address (including iPhone/iCloud public calendars).
- **Exporting:** download `.ics` files that Google, Apple and Outlook calendars can import.
- **Who sees each calendar:** everyone, or only you and the people you pick. People it's shared with can look but not change it.
- Chores show on the calendar too.

### ✅ Chores and rewards
- **Setting chores:** parents give chores to someone, with a deadline, points and a repeat. Repeats can follow a fixed schedule or count from when the last one was done ("2 weeks after it's done").
- **Reviewing:** when a child marks a chore done, a parent checks it. They can approve it, change the points up or down with a reason, or not accept it.
- **Rewards:** points are spent on rewards that parents set up. Every point gained or spent shows in a history, so a balance always adds up.
- **Corrections:** parents can skip one occurrence, or fix a review afterwards. Admins can correct anyone's points.
- **Reminders:** a badge on the Chores tab, plus a notification shortly before a chore is due and when it's been reviewed.

### 🛒 Groceries
- Checked items disappear, and Undo brings them back.
- Type `2 milk` or `milk x2` to set a quantity, then use − / + to change it.
- Items are sorted into store aisles: produce, dairy, frozen and so on.
- **Works with no signal in the store.** Changes are kept on the phone and sent when it's back online.

### 🏠 For the whole family
- **Accounts and roles:** see the table below.
- **The wall tablet (kiosk):**
  - Anyone can add groceries.
  - With their PIN, a person marks their own chores done, spends their points or changes their events.
  - A parent's PIN reviews chores.
  - A full-screen **Today** view shows the clock, today's events, chores and groceries, and keeps the screen on.
- **Phones:**
  - Add Famner to the home screen and it runs like an app.
  - Over HTTPS it also opens offline, with the last data it saw.
- **For admins:**
  - An activity log of who changed what. Titles from a child's private calendar stay blurred until clicked.
  - Daily automatic backups, plus *Back up now* and downloads.
  - A factory reset that makes a backup first.

## Who can do what

| Role | Can |
|---|---|
| **Admin** | Everything a parent can, plus add and manage people, see the activity log, and handle backups and reset. |
| **Parent** | Change all shared calendars, groceries and chores; review chores; hand out rewards. |
| **Child** | Add events and grocery items and change only their own; make calendars of their own; mark their chores done; spend their points. |
| **Kiosk** | For a shared tablet. Anyone can add groceries; everything else asks for the right person's PIN. |

The first person to open a new Famner creates the admin account. The admin then adds everyone
else, each with a temporary password. Each person chooses their own password and a 4-digit PIN
the first time they sign in.

---

## Quick start with Docker

```sh
docker run -d --name famner --restart unless-stopped --init \
  -p 3000:3000 \
  -v famner-data:/data \
  -e ORIGIN=http://192.168.1.20:3000 \
  -e TZ=America/New_York \
  ghcr.io/YOUR-GITHUB-NAME/famner:latest
```

Open the address you set as `ORIGIN` and create the admin account.

- **`ORIGIN`** must be exactly the address people type in the browser. If it doesn't match, signing in fails.
- **`TZ`** is your household's time zone.
- Everything Famner saves (the database and its backups) is in the `famner-data` volume.

There's also a `docker-compose.yml`. See **[DOCKER.md](DOCKER.md)** for all the settings, updating,
backups and running behind nginx.

## Running from source

You need Node.js 20 or newer.

```sh
npm install
npm run dev          # http://localhost:5173
```

For a production build (uses `@sveltejs/adapter-node`):

```sh
npm run build
ORIGIN=http://localhost:3000 node build
```

The database is created at `data/calendar.db` the first time it runs. To run Famner as a
service with systemd and nginx, see **[DEPLOY.md](DEPLOY.md)**.

### Settings

| Variable | Default | |
|---|---|---|
| `ORIGIN` | — | The address people use, e.g. `https://famner.example.com`. Required for `node build`. |
| `TZ` | system | Household time zone, for repeating chores and backup times. |
| `CALENDAR_DB` | `data/calendar.db` | The database file. |
| `BACKUP_DIR` | `data/backups` | Where backups go. Ideally another disk. |
| `ADDRESS_HEADER` | — | Behind nginx: `X-Real-IP`, so wrong-password limits apply per device. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens. |

## HTTPS, phones and offline

Famner runs fine over plain `http://` on your home network. Put it behind a reverse proxy with
HTTPS (nginx config in `deploy/`) to also get:
- **Offline use on phones:** the app opens with no signal, and grocery changes sync when you're back.
- **Notifications** before chores are due.
- **Secure-only session cookies.**

Keep response buffering off for the `/api/…/live` paths in your proxy; the config in `deploy/`
already does this. Otherwise, changes from other devices arrive late.

---

## Your data

- **Stored only on your server:** everything is in one SQLite file (`calendar.db`). Nothing is sent anywhere else.
- **Passwords and sign-ins:** passwords and PINs are stored as scrypt hashes, and sign-in sessions as hashes of their tokens. A copy of the database can't be used to sign in.
- **Private calendars:** someone's private calendar is only ever sent to the people it's shared with, including the live updates.
- **Backups:** every backup is a complete, standalone copy of the database. DEPLOY.md and DOCKER.md explain how to restore one.
- **Kept out of git and Docker:** `.gitignore` and `.dockerignore` keep databases, backups and `.env` files out of the repository and the image.

## Project layout

```
src/
  lib/components/Calendar.svelte   the calendar (views, editor, drag, import/export, sync)
  lib/components/calendarUtils.js  dates, repeats, .ics reading and writing
  lib/server/                      database, accounts and PINs, chores, lists, backups, activity log
  lib/kiosk.svelte.js              the shared-tablet PIN unlock
  lib/offline.svelte.js            offline state and data kept on the device
  routes/                          pages (calendar, chores, groceries, today, admin, account)
  routes/api/                      JSON endpoints and live streams (Server-Sent Events)
  service-worker.js                offline support
  hooks.server.js                  sign-in checks for every request
static/                            icons and the app manifest
deploy/                            systemd service, nginx config, adapter-node config
```

## Good to know

- **Run one copy per household.** Live updates are shared inside a single server process, so don't run several replicas.
- **Kiosk PINs are 4 digits.** Five wrong guesses pause that person's PIN for 5 minutes.
- **Signed out on a phone?** Signing out clears the offline copy on that device. If someone else signs in there, the previous person's saved data is cleared first.
- **Testing by hand:** [TESTING.md](TESTING.md) is a checklist for each role (admin, parent, child, kiosk, phones).

## License

No license has been chosen yet. Until one is added, others can view the code but have no
permission to use or share it. Add a `LICENSE` file (MIT is a common choice) before publishing.