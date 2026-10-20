# One image for the three compose services (spec 0001): `web` runs
# server.js, `worker` runs dist/worker.mjs, `migrate` runs dist/migrate.mjs.
# The build reads no env; every value arrives at start (server/env.ts).

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts: husky needs .git, and nothing else here needs one.
RUN npm ci --ignore-scripts

FROM node:24-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm run build:bundle

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    TZ=UTC
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/db/migrations ./db/migrations
# The node user is uid 1000, so it can read the host's mode 600 secret files.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
