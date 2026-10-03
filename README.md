# Cloud Health Monitor

A self-hosted health monitor for public HTTP and HTTPS endpoints. It stores check history in PostgreSQL, serves a Next.js dashboard, and runs probes in a separate worker process.

> [!WARNING]
> **This application has no authentication or authorization.** Anyone who can reach it can add monitors and permanently delete their history. Deploy it only behind a trusted network boundary or operator-managed access control (for example, a private VPN, identity-aware proxy, or tightly restricted reverse proxy). Do not expose it directly to the public internet.

## Scope and safety boundary

This first release deliberately monitors **public HTTP(S) targets only**. Each probe resolves the target, rejects non-global addresses, pins its connection to a validated address, verifies TLS, does not use proxy environment variables, and does not follow redirects. Loopback, private, link-local, metadata, carrier-grade NAT, multicast, reserved, documentation, benchmark, mapped, and other non-global addresses are not supported targets.

These controls reduce server-side request forgery exposure; they are not a way to approve internal services. Do not rely on this application to monitor an internal network, cloud metadata endpoint, or a target reachable only through an HTTP proxy. A redirect is recorded as its original 3xx response and is healthy only if that status is in the monitor's accepted range.

## What it records

- Configurable check intervals from 30 to 86,400 seconds (default: 60).
- Configurable inclusive accepted HTTP status range from 100 to 599 (default: 200–299).
- Response time to response headers and total elapsed attempt duration.
- Public bounded outcome/error codes only; response bodies, request/response headers, credentials, cookies, target query strings, and raw exceptions are not stored.
- Raw results for 90 days plus hourly summaries. The current result remains after raw history expires.

A result is `up` only when its final status is inside the configured range. Transport failures and out-of-range statuses are `down`. `pending` means no result has arrived yet, and `stale` means the last observation is older than `max(2 × interval, 60 seconds)`; stale does **not** mean the endpoint failed.

## Prerequisites

For native development:

- Node.js 24 LTS (the project enforces Node 24.x).
- PostgreSQL 17.
- npm, supplied with Node.

For the container deployment:

- Docker Engine with Docker Compose v2.

No paid service, hosted queue, or public endpoint is required for development or CI.

## Environment setup

Create a local environment file and replace the placeholder password before starting Compose:

```sh
cp .env.example .env
```

`.env` is intentionally ignored by Git. Never commit it, pass it to a browser build, or use a `NEXT_PUBLIC_*` variable for a database URL or password.

| Variable | Purpose | Default in `.env.example` |
| --- | --- | --- |
| `APP_ORIGIN` | Absolute application origin used for same-origin mutation checks; no path/query/fragment. | `http://localhost:3000` |
| `DATABASE_URL` | Least-privilege runtime PostgreSQL URL. | Compose `db` hostname |
| `MIGRATION_DATABASE_URL` | Schema-owner PostgreSQL URL used only by migrations. | Compose `db` hostname |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Compose PostgreSQL initialization values. | local placeholders |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error`. | `info` |
| `DATABASE_POOL_MAX` | Maximum connections for one application process (1–50). | `10` |
| `DATABASE_CONNECTION_TIMEOUT_MS` | Database connection timeout in milliseconds. | `5000` |
| `DATABASE_STATEMENT_TIMEOUT_MS` | Database statement timeout in milliseconds. | `10000` |
| `WORKER_CONCURRENCY` | Concurrent probes in one worker process (1–25). | `5` |
| `WORKER_LEASE_SECONDS` | Duration of a claimed database lease (1–300 seconds). | `45` |
| `WORKER_POLL_INTERVAL_MS` | Scheduler poll interval in milliseconds (1–60,000). | `1000` |
| `WORKER_SHUTDOWN_GRACE_MS` | In-process worker drain period in milliseconds (1–120,000). | `25000` |
| `MAX_SERVICES` | Service creation capacity guard (1–10,000). | `100` |

All application values are validated at startup. In production, create distinct runtime and migration roles: the runtime role should have only the table permissions it needs, while the migration role owns schema changes. The example uses one local role only to make Compose convenient. Compose interpolates `.env` but injects `DATABASE_URL` only into web/worker, `MIGRATION_DATABASE_URL` only into the one-shot migration job, and the `POSTGRES_*` initialization values only into PostgreSQL.

When deployed behind TLS termination, set `APP_ORIGIN` to the externally visible `https://` origin and configure the reverse proxy to enforce that host, HTTPS, body-size limits, and any request limiting/access policy. The bundled Compose port is intentionally bound to `127.0.0.1:3000`; publish it through a trusted local proxy rather than changing it to `0.0.0.0`.

## Run with Docker Compose

The standard local deployment starts PostgreSQL, applies migrations once, then starts the web application and worker:

```sh
docker compose up --build
```

Open http://localhost:3000 after the web health check is healthy:

```sh
docker compose ps
docker compose logs -f web worker
curl --fail http://localhost:3000/api/health/live
curl --fail http://localhost:3000/api/health/ready
```

PostgreSQL has no published host port. It lives on a Docker-internal `database` network; only the worker also joins a separate egress network so it can reach public monitoring targets. Data persists in the named `postgres_data` volume.

To apply a newly added migration to a running deployment, run it explicitly, then recreate the dependent services:

```sh
docker compose run --rm migrate
docker compose up -d --no-deps --force-recreate web worker
```

### Add and remove a sample monitor

Use the dashboard's **Add service** form to create a monitor such as `https://example.com`. The new monitor initially shows `pending`; the worker schedules its first check independently. For a curl-based API exercise, use a unique idempotency key:

```sh
curl --fail-with-body \
  -X POST http://localhost:3000/api/services \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: local-example-001' \
  -H 'Origin: http://localhost:3000' \
  --data '{"name":"Example","url":"https://example.com","intervalSeconds":60,"acceptedStatusMin":200,"acceptedStatusMax":299}'
```

Delete a monitor from its detail page only after confirming the name. Deletion is permanent and cascades through raw history, hourly summaries, and its create-idempotency record; it cannot be restored.

## Native development

Run PostgreSQL 17 locally (outside Compose) and point both database variables at a local URL. Compose does not publish its database port by design, so native application processes need their own local PostgreSQL instance or an explicitly managed development override.

```sh
npm ci
cp .env.example .env
# Edit DATABASE_URL and MIGRATION_DATABASE_URL to use 127.0.0.1 for local PostgreSQL.
set -a; . ./.env; set +a
npm run migrate
npm run dev
```

In a second terminal, start the worker with the project's worker script:

```sh
npm run build:worker
set -a; . ./.env; set +a
npm run worker
```

The development server binds to `0.0.0.0` and is normally available at http://localhost:3000. Keep `APP_ORIGIN` at that exact origin for local browser mutations.

To reset only local development schema, use the migration tooling deliberately; do not run destructive migration commands against a production URL. For a disposable Compose environment, `docker compose down -v` removes the database volume and all monitored history.

## Operations

### Scheduling, retention, and capacity

The worker claims due work through PostgreSQL, so no Redis or external queue is needed. The default worker concurrency is five and each attempt has a ten-second total deadline. A graceful shutdown stops new claims, lets in-flight work finish within its grace period, aborts remaining work, releases only its own leases, and drains database work.

History retention is 90 days. Cleanup runs in bounded batches and history queries also enforce the 90-day cutoff, even if cleanup is temporarily delayed. Retention bounds **age**, not disk size: at the 30-second minimum interval, 100 continuously monitored services can create roughly 288,000 raw checks per day (about 25.9 million over 90 days), before indexes and hourly summaries. At the 60-second default, that is roughly 144,000 per day (about 13 million over 90 days). Start below `MAX_SERVICES=100`, measure PostgreSQL disk/IO and worker scheduling lag, and increase capacity only after sizing the database, connection limits, and outbound network budget.

Logs are structured JSON on stdout/stderr. Forward those streams using the platform's normal log collection. Compose uses Docker's local log driver with a 10 MiB × 3-file bound per container; configure central log retention independently if required.

### Backups and recovery

Back up PostgreSQL, not the container filesystem. Stop or quiesce writes if your backup policy requires a point-in-time application snapshot; PostgreSQL-native backups remain the source of truth.

For a local Compose backup:

```sh
set -a; . ./.env; set +a
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > cloud-health-$(date +%F).dump
```

Test restores regularly in a separate empty PostgreSQL 17 instance:

```sh
pg_restore --clean --if-exists --no-owner -d "$RESTORE_DATABASE_URL" cloud-health-YYYY-MM-DD.dump
```

Store backups encrypted with access limited to operators. A restore replaces service configuration and history; verify the restored application's migration version and readiness endpoint before routing traffic to it.

### Upgrades

1. Take and verify a database backup.
2. Read release notes and test the new revision against a restored copy when possible.
3. Build/pull the new application image.
4. Run `docker compose run --rm migrate` exactly once and wait for success.
5. Recreate `web` and `worker`, then verify `/api/health/ready`, worker freshness in the dashboard, and a known safe public target.

Never downgrade a migration by guessing. Restore the prior application version with a compatible database backup instead. Pin and review the PostgreSQL major upgrade process separately; a major PostgreSQL upgrade requires the official dump/restore or `pg_upgrade` procedure, not a container-tag change alone.

### Safe shutdown

Use the normal Compose stop path so the worker receives `SIGTERM` and can release its leases safely:

```sh
docker compose stop
docker compose down
```

`docker compose down` preserves `postgres_data`. Do not append `-v` unless you intentionally want to erase every monitor and all history. Allow at least the configured 30-second grace period before forcing a process or host shutdown.

## Testing and CI

Run the checks available to the current checkout before opening a change:

```sh
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
docker compose build
docker compose up -d --wait
npm run test:e2e
```

The GitHub Actions workflow provisions a disposable PostgreSQL 17 database and runs linting, strict type checking, explicit API/worker database tests, production builds, and Docker target builds. It also starts the local Compose stack, verifies its health endpoints, and runs the checked-in desktop/mobile Playwright journeys against its dashboard. Those browser journeys mock their API responses intentionally, while the Compose health checks cover the actual local API/database path. It does not require paid services or public internet targets.

## Troubleshooting

| Symptom | Check | Resolution |
| --- | --- | --- |
| `web` waits forever or exits after startup | `docker compose ps` and `docker compose logs migrate db` | Fix the migration/database error first. Web and worker intentionally wait for a healthy database and successful one-shot migration. |
| Ready endpoint fails but live endpoint succeeds | `docker compose logs web` and database logs | Confirm `DATABASE_URL`, PostgreSQL health, and migration completion. Liveness only confirms the web process is running. |
| New monitors remain pending or dashboard says worker delayed | `docker compose logs worker` | Confirm the worker is running, has valid database configuration, and can reach DNS/public targets through its egress network. Do not interpret this as a monitored endpoint outage. |
| A target is rejected as blocked | Validate its DNS A/AAAA answers | Only globally routable public addresses are allowed. Private services, loopback, cloud metadata, and documentation ranges cannot be bypassed. |
| A URL returns 301/302 but is down | Inspect the configured accepted status range | Redirects are never followed. Include the 3xx status only if that is intentionally healthy, or monitor the final public URL directly. |
| Browser POST/DELETE is rejected as cross-origin | Check `APP_ORIGIN`, reverse-proxy host, and scheme | Set `APP_ORIGIN` to the exact public origin and have the proxy enforce it. This protection does not replace access control. |
| Database connections are exhausted | Check PostgreSQL connection limits and `DATABASE_POOL_MAX` across web/worker replicas | Lower per-process pools or raise PostgreSQL capacity after measuring. Count every web and worker replica. |
| Disk use grows unexpectedly | Inspect check rate, indexes, retention cleanup, and backups | Retention is time-based. Reduce monitor count/frequency or scale PostgreSQL; never delete production rows without a tested backup. |

## Health endpoints

- `GET /api/health/live` — web-process liveness.
- `GET /api/health/ready` — database connectivity and expected migration readiness.

Use readiness for load-balancer admission. The dashboard separately reports worker-heartbeat freshness because a healthy web process cannot prove that probes are running.
