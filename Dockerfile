# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
# .npmrc carries engine-strict=true, so `npm ci` FAILS here rather than warning
# if the base image ever drops below the engines floor (node >=22.9). That floor
# is load-bearing in production: `npm run db:migrate` is fly.toml's
# release_command and passes --env-file-if-exists, which older node rejects
# outright with `node: bad option`. Fail at build, not at deploy.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM deps AS build
COPY . .
# Config env vars are validated lazily at request/startup time, never at build.
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
# Web process: the self-contained standalone server.
COPY --from=build /app/.next/standalone ./web
COPY --from=build /app/.next/static ./web/.next/static
# Standalone output excludes public/ — without this the favicon and app icons 404.
COPY --from=build /app/public ./web/public
# Worker + release migrate run from source via tsx (prod dependency).
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle
COPY tsconfig.json next.config.ts ./
# No chown: COPY'd files are world-readable and nothing under /app is written
# at runtime (all pages force-dynamic, no ISR/image cache) — a recursive chown
# would duplicate node_modules + the standalone build into an extra layer.
RUN addgroup -S authgd && adduser -S authgd -G authgd
USER authgd
ENV HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "web/server.js"]
