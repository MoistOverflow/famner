# Famner — family calendar, chores and groceries in one small Node server.
#
#   docker build -t famner .
#   docker run -d --name famner -p 3000:3000 -v famner-data:/data \
#     -e ORIGIN=http://192.168.1.20:3000 -e TZ=America/New_York famner
#
# Everything the app saves (the database and its backups) is in /data: keep it on a volume.
# See DOCKER.md for the settings.

# ---------- 1. build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# tools for building better-sqlite3 if no ready-made binary exists for this machine
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# the server needs better-sqlite3 at run time, so it must be a regular dependency, and adapter-node
RUN node -e "const p=require('./package.json'); const miss=[]; if(!p.dependencies?.['better-sqlite3']) miss.push('better-sqlite3 must be in \"dependencies\" (npm i better-sqlite3)'); if(!(p.devDependencies?.['@sveltejs/adapter-node']||p.dependencies?.['@sveltejs/adapter-node'])) miss.push('@sveltejs/adapter-node is missing (npm i -D @sveltejs/adapter-node@^5)'); if(miss.length){console.error(miss.join('\n'));process.exit(1)}"
RUN npm ci
COPY . .
# the SvelteKit config (vite.config.ts/js, or an older svelte.config.js) must use adapter-node
RUN cat vite.config.* svelte.config.* 2>/dev/null | grep -q "adapter-node" \
  || (echo "Your SvelteKit config (vite.config.ts) must use @sveltejs/adapter-node instead of adapter-auto" && exit 1)
RUN npm run build && npm prune --omit=dev

# ---------- 2. run ----------
FROM node:22-bookworm-slim
WORKDIR /app
# time zones (for TZ), so "every day at 7 PM" chores and backup times follow the household's clock
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/backups && chown -R node:node /data
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    CALENDAR_DB=/data/calendar.db \
    BACKUP_DIR=/data/backups \
    BODY_SIZE_LIMIT=2M \
    TZ=UTC

USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "build"]
