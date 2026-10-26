# Running Famner with Docker

Famner is one small Node.js server with a SQLite database. Everything it saves lives in one
folder in the container, **`/data`**: the database (`calendar.db`) and its daily backups
(`backups/`). Keep `/data` on a volume and your data survives updates.

## Quick start

```sh
docker run -d --name famner --restart unless-stopped --init \
  -p 3000:3000 \
  -v famner-data:/data \
  -e ORIGIN=http://192.168.1.20:3000 \
  -e TZ=America/New_York \
  ghcr.io/YOUR-GITHUB-NAME/famner:latest
```

Open the `ORIGIN` address. The first visit asks you to create the admin account.

Or with Compose: edit `docker-compose.yml` (ORIGIN, TZ), then `docker compose up -d`.

## Settings

| Variable | Default | What it's for |
|---|---|---|
| `ORIGIN` | *(required)* | The exact address people type in the browser, e.g. `http://192.168.1.20:3000` or `https://famner.example.com`. If it's wrong, signing in and saving forms fail with “Cross-site POST form submissions are forbidden”. |
| `TZ` | `UTC` | The household's time zone (e.g. `America/New_York`): used for repeating chores, backup times, and the times of events synced with iCloud. |
| `PORT` | `3000` | Port inside the container. |
| `ADDRESS_HEADER` | *(unset)* | Behind a reverse proxy, set to `X-Real-IP`. Then too many wrong passwords only slow down that device, not everyone. |
| `CALENDAR_DB` | `/data/calendar.db` | Where the database is. |
| `BACKUP_DIR` | `/data/backups` | Where backups go. Point it at another mounted disk to protect against the disk failing. |
| `BODY_SIZE_LIMIT` | `2M` | Largest upload (e.g. importing a big .ics file). |
| `ICLOUD_SYNC_MINUTES` | `5` | How often calendars synced with iCloud are checked for changes made on Apple devices. |
| `PUSH_CONTACT` | `ORIGIN` | Who runs this server, for the push services (Apple, Google…): your `https://` address or `mailto:you@example.com`. Apple refuses notifications without a valid one, so set it if `ORIGIN` isn't https. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | *(made for you)* | Optional. The keys that sign push notifications. Without them they're made once and kept in the database. If they change, devices subscribe again by themselves the next time they open Famner. |
| `FAMNER_SECRET` | *(unset)* | Optional. Long random text used to encrypt saved iCloud passwords. Without it, a key is made in `/data/secret.key`. |

## Notifications on phones (Web Push)

With HTTPS through nginx, turning on reminders (**Account**) subscribes the device to Web Push. The
server then sends reminders even when Famner is closed: chores finished, reviewed and due soon, and
groceries added. The container needs to reach the internet: notifications go out through Apple's,
Google's or Mozilla's push service. Nothing else needs to be open, and nginx needs no changes.
On an iPhone or iPad, add Famner to the Home Screen first, then turn reminders on from the app
there (iOS 16.4 or later).

## Behind nginx (HTTPS)

Run the container on the same machine as nginx, publishing the port only to it:
`-p 127.0.0.1:3000:3000`. Then use `deploy/nginx-famner.conf` and set:

```sh
-e ORIGIN=https://famner.example.com -e ADDRESS_HEADER=X-Real-IP
```

Over HTTPS, the session cookie becomes secure-only and offline mode turns on for phones.
Keep `proxy_buffering off` for the `/live` paths (it's in the nginx file), or changes from other
devices arrive late.

## Updating

```sh
docker pull ghcr.io/YOUR-GITHUB-NAME/famner:latest
docker stop famner && docker rm famner
# run the same `docker run …` again (the volume keeps the data)
```

With Compose: `docker compose pull && docker compose up -d`.

## Backups and restoring

- **Making backups:** the app makes one a day into `/data/backups`, and admins can make and download backups from **Admin → Backups**.
- **Copying them off the machine:** `docker cp famner:/data/backups ./famner-backups`.

To restore one:

```sh
docker stop famner
docker run --rm -v famner-data:/data -v "$PWD":/restore --user node node:22-bookworm-slim \
  sh -c 'cd /data && mv calendar.db calendar.db.before-restore && rm -f calendar.db-wal calendar.db-shm \
         && cp /restore/backup-2026-10-25T04-00-00Z-auto.db calendar.db'
docker start famner
```

(Put the backup file in the folder you run this from.)

**iCloud passwords and backups:** the app-specific passwords people saved for iCloud sync are encrypted
with the key in `/data/secret.key` (or `FAMNER_SECRET`). Backups don't include that key. Restoring on the
same volume keeps it; on a new machine, copy `secret.key` across too, or everyone reconnects iCloud on
their Account page.

## Using a folder instead of a named volume

```sh
mkdir -p ./famner-data && sudo chown 1000:1000 ./famner-data   # the app runs as user 1000 ("node")
docker run … -v "$PWD/famner-data":/data …
```

## Building the image yourself

Before building, the project needs:
- `better-sqlite3` in `dependencies`: `npm i better-sqlite3`.
- `@sveltejs/adapter-node`: `npm i -D @sveltejs/adapter-node@^5`.
- The SvelteKit config in `vite.config.ts` using `adapter-node` rather than `adapter-auto` (this repo already does).
- A `package-lock.json`.

The build checks these and says what's missing. Then:

```sh
docker build -t famner .
```

The image runs as a non-root user and works on x86 PCs and on ARM boards such as a Raspberry Pi 4/5.

## Publishing it for others

`.github/workflows/docker.yml` builds the image for amd64 and arm64 and publishes it to GitHub's
registry as `ghcr.io/<your-name>/famner`:
- Pushing to `main` updates the `latest` tag.
- A tag like `v1.0.0` also publishes `1.0.0` and `1.0`.

After the first run, make the package public on GitHub (your profile → Packages → famner →
Package settings → Change visibility) so others can pull it without signing in.

## Run only one copy

Live updates are shared inside one server process, and SQLite is a single file, so run **one**
container per household. Don't scale it to several replicas.
