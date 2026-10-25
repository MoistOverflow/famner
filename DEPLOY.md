# Running Famner for real

The app is one Node.js server: SvelteKit with `adapter-node`, a SQLite database file, and long-lived
connections for live updates. Run **one** copy of it (live updates are shared inside that one process),
put nginx in front, and let systemd keep it running. These steps assume a Linux machine (a Raspberry Pi,
a mini PC, a home server). The files mentioned are in the `deploy/` folder.

## 1. Build

On your development machine or the server, in the project folder:

```sh
npm install -D @sveltejs/adapter-node@^5         # 5.x is for SvelteKit 2 (6.x needs SvelteKit 3)
# vite.config.ts already uses adapter-node (older projects: see deploy/svelte.config.js)
npm install                                     # better-sqlite3 needs Node 18+ (it downloads a prebuilt
                                                #  binary; on unusual systems it needs build tools)
npm run build                                   # creates ./build
```

## 2. Install on the server

```sh
sudo useradd --system --home /opt/famner --shell /usr/sbin/nologin famner
sudo mkdir -p /opt/famner/data /opt/famner/backups
# copy these into /opt/famner:  build/  package.json  package-lock.json
cd /opt/famner && sudo npm ci --omit=dev       # installs better-sqlite3 for this machine
sudo cp deploy/env.example /opt/famner/.env     # then edit it: ORIGIN, paths, TZ
sudo chown -R famner:famner /opt/famner
```

**Moving your existing data:** copy your current `data/calendar.db` into `/opt/famner/data/` *while
the dev server is stopped* (or download a backup from Admin → Backups and copy that in, renamed to
`calendar.db`).

## 3. Run it as a service

```sh
sudo cp deploy/famner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now famner
systemctl status famner          # should say "active (running)"
journalctl -u famner -f          # live logs
```

It now starts at boot and restarts itself if it ever crashes. After an update: copy the new `build/`
over, then `sudo systemctl restart famner`.

## 4. nginx

```sh
sudo cp deploy/nginx-famner.conf /etc/nginx/sites-available/famner
# edit server_name to match the ORIGIN in .env
sudo ln -s /etc/nginx/sites-available/famner /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Three settings matter and are already in the config:

* **Live updates** (`/api/…/live`) must not be buffered (`proxy_buffering off`) and need a long read
  timeout, or changes from other devices arrive late or the dot keeps going grey.
* **`X-Real-IP`** passes each device's address through, matching `ADDRESS_HEADER` in `.env`. Without
  it every request looks like it comes from nginx, and five wrong passwords from *anyone* would slow
  down sign-in for *everyone*.
* **`ORIGIN`** in `.env` must be exactly the address in the browser bar (`http://home.local`, later
  `https://…`). If it's wrong, every form (sign in, saving chores…) fails with “Cross-site POST form
  submissions are forbidden”.

When you add HTTPS in nginx, change `ORIGIN` to `https://…` and restart the app. The session cookie
then automatically becomes HTTPS-only.

## 5. Backups and restoring

The app makes a backup once a day (keeps 14) into `BACKUP_DIR`, and admins can make and download
backups from **Admin → Backups**. Pointing `BACKUP_DIR` at another disk or a synced folder protects
against the disk itself failing.

**Factory reset:** Admin → Backups → *Start over* deletes all accounts and data and returns the app to
the first-time setup page (it needs your password and typing RESET). A backup named `…-reset.db` is
made first; restore it the same way as any other backup to undo a reset.

To restore one:

```sh
sudo systemctl stop famner
cd /opt/famner/data
sudo mv calendar.db calendar.db.before-restore
sudo rm -f calendar.db-wal calendar.db-shm
sudo cp ../backups/backup-2026-10-25T04-00-00Z-auto.db calendar.db
sudo chown famner:famner calendar.db
sudo systemctl start famner
```

## 6. Phones and the wall tablet

* **Install on a phone:** open the app's address. On iPhone: Share → *Add to Home Screen*. On
  Android (Chrome): ⋮ → *Install app* (or *Add to Home screen*). It opens full screen with its own icon.
* **Wall tablet:** in **Admin → People**, add an account with the **Kiosk** role and sign the tablet in
  with it. Anyone can add groceries on it. For everything else it asks for a PIN, and a green bar shows
  who it's unlocked for; it locks itself after 90 seconds of not being used, or tap *Lock*:
  * mark a chore done: only the PIN of the person it's for;
  * check (review) chores, hand out or refund rewards: a parent's PIN;
  * spend points on a reward: the PIN of the person getting it;
  * add an event, or change or delete one: the PIN of the person who added it (shared calendars only;
    private calendars don't show on the tablet, and calendars themselves can't be changed there).
  Everyone except the kiosk chooses a 4-digit PIN the first time they sign in (after changing a
  temporary password), and can change it on the Account page. Admins can *Reset PIN* for someone
  who forgot theirs. Five wrong PINs for a person pause their PIN for 5 minutes. The activity log
  shows tablet changes as e.g. “Sam (kiosk)”.
  **`/today`** is the wall view: the time, today's and tomorrow's events, chores due today and the
  grocery list, updating live and keeping the screen on. Tap *Full screen* in the corner, or add the
  app to the home screen for a true full-screen kiosk.

## 7. Offline use

Over https, Famner keeps a copy of itself and of each person's last data on their phone (a "service
worker", `src/service-worker.js`). Without signal, or away from home, it opens with that copy:
grocery changes are kept on the phone and sent when it can reach the server again; chores need a
connection; calendar changes are sent once back online as long as the app stays open. Signing out
removes the copy from that device. A new version of the app replaces the old copy automatically.

