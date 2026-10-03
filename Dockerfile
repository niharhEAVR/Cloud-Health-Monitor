# syntax=docker/dockerfile:1

# Pin the Node 24 LTS image used for every build and runtime target.
FROM node:24.12.0-alpine3.22 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM dependencies AS build
COPY . ./
RUN npm run build && npm run build:worker

FROM base AS runtime-base
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 monitor \
  && adduser --system --uid 1001 --ingroup monitor monitor

# Standalone tracing contains only the modules needed by the Next.js server.
FROM runtime-base AS web
COPY --from=build --chown=monitor:monitor /app/.next/standalone ./
COPY --from=build --chown=monitor:monitor /app/.next/static ./.next/static
USER monitor
EXPOSE 3000
CMD ["node", "server.js"]

# The worker bundle is built independently, then runs with production-only
# dependencies. It does not contain source, tests, or development tooling.
FROM runtime-base AS worker
COPY --from=production-dependencies --chown=monitor:monitor /app/node_modules ./node_modules
COPY --from=build --chown=monitor:monitor /app/dist/worker ./dist/worker
USER monitor
CMD ["node", "dist/worker/index.js"]

# The migration target installs only its pinned CLI. Unlike the build stage it
# does not carry TypeScript, Next.js tooling, source, or test dependencies.
FROM runtime-base AS migrate
RUN npm install --global --omit=dev --ignore-scripts node-pg-migrate@8.0.4 \
  && npm cache clean --force
COPY --chown=monitor:monitor package.json ./package.json
COPY --chown=monitor:monitor db/migrations ./db/migrations
USER monitor
CMD ["node-pg-migrate", "up", "--migrations-dir", "db/migrations", "--database-url-var", "MIGRATION_DATABASE_URL"]
