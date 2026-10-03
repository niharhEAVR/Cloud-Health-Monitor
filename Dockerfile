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

# Migrations intentionally retain their CLI dependency but exclude application
# source, test files, Git metadata, and local environment files.
FROM runtime-base AS migrate
COPY --from=dependencies --chown=monitor:monitor /app/node_modules ./node_modules
COPY --from=build --chown=monitor:monitor /app/package.json ./package.json
COPY --from=build --chown=monitor:monitor /app/db/migrations ./db/migrations
USER monitor
CMD ["npm", "run", "migrate"]
