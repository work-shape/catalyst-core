---
title: Deployment
description: Package and run a dedicated client instance.
---

Vivd Catalyst runtime services are packaged as Docker images. Docker Compose is the default local and first production-friendly deployment target.

## First Production Shape

```text
reverse proxy / TLS
  -> chat API service
  -> standalone or embedded chat frontend assets
  -> optional tool worker service
  -> Postgres
  -> object storage or backup target
  -> logs, metrics, backups, and deploy scripts
```

Caddy is the default reverse proxy/TLS choice for the first VPS or VM deployment because it keeps automatic HTTPS and routing simple.

The API limits how often one caller may call an operation, and counts a caller who is not
signed in by client address. It reads that address from `X-Forwarded-For` only when the request
comes from a loopback or private address, which is the reverse proxy on the Compose network.
Caddy as the outermost proxy passes the real client address without configuration.

Where another proxy or load balancer stands in front of Caddy (Traefik, a cloud load
balancer), Caddy must be told to trust it. Without this Caddy reports the outer proxy as the
client, and everyone who signs in shares one count:

```caddyfile
{
	servers {
		trusted_proxies static private_ranges
	}
}
```

Name the outer proxy's addresses instead of `private_ranges` where they are known. After the
change, sign in from two networks and check that the API's request log shows two different
`remoteAddress` values.

The counters live in the API process, so an instance runs exactly one API process. The numbers
are set in the release config, see [Rate limits](/configure/release-config/#rate-limits).

## Deployment Flow

Separate publishing from deployment:

```text
run checks
  -> build Docker images
  -> tag release
  -> push images
  -> explicitly deploy target client instance
  -> run migrations
  -> restart services
  -> health check
```

Production deploys should be explicit. A GitHub Actions workflow can call the same deploy script that an operator can run manually with the right credentials.

## Environment Contract

Do not commit production env files.

Document these values per instance:

- database URL
- model provider credentials
- auth token signing or exchange secrets
- object storage endpoint and credentials
- backup bucket
- public origin
- CORS or embed allowlist
- retention and audit env overrides, if any

For machine API access, configure a `SERVICE_ACCESS_TOKEN_SECRET` of at least 32 characters before starting the API. Treat it as a server signing secret: keep it stable across restarts and identical across replicas. API keys are separate database-backed credentials created in the API Access control plane and supplied only to callers as `CATALYST_API_KEY`; they do not belong in the server deployment environment.

## Database

Postgres is the baseline application store.

Managed Postgres is preferred for production when available. Running Postgres on the same VPS is acceptable for early instances only when backup and restore are treated as product features.

Minimum requirements:

- persistent volume outside the app container lifecycle
- automated external backups
- documented restore procedure
- migration procedure
- monitoring for failed backups
- least-privilege backup credentials

Database schema changes must be shipped as committed Drizzle migration files. Do not use `drizzle-kit push` or any direct schema-push workflow.

Migrations run as an explicit step before the API and the workers start. Each client builds `dist/migrate.js`, and the Compose `migrate` service runs `node <client folder>/dist/migrate.js`. In the operated production Compose files the deploy script runs that service after the pre-deploy backup and before `up`; the services themselves only wait for a healthy Postgres there. In local Compose the API waits for the `migrate` service to complete, and the workers wait for the API. The step holds a Postgres advisory lock on one session, applies each committed migration once, prints the names it applied and names the migration that failed.

The API and the workers never migrate. When one starts, it reads the migration state: a database that lacks committed migrations stops it with their names, so a production stack started without the migrate step fails instead of serving an old schema. A database ahead of the release starts, so the previous release keeps serving while a newer one is rolled out. There is no `RUN_MIGRATIONS` switch.

Schema changes expand before they contract. A new migration may hold the additive forms: a new table, type, schema or sequence; a nullable or defaulted column; a column default; a relaxed `NOT NULL`; a constraint added `NOT VALID` and its later validation; inserts and updates; and, in a migration of its own, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. Every other statement is a contract step, among them a drop, a rename, a new `NOT NULL`, a column type change, `DELETE`, `TRUNCATE` and a `DO` block: it ships in a later migration under `-- contract-after: <tag>`, once the oldest supported release in `packages/postgres-store/migration-policy.json` has reached that tag. A required column without a default and a blocking index build never pass. `pnpm check:migrations` enforces this for every migration the base branch lacks and rejects any change to a committed migration; `pnpm test:compatibility` runs the database tests of the previous and the oldest supported release against the new schema, and `pnpm test:upgrade` migrates a database of the oldest supported release.

A concurrent index build runs outside a transaction. When it fails, the migration is not recorded and the index stays behind as invalid; repair what stopped it and run the step again, which drops the invalid index and builds it anew.

## Health And Readiness

Two unversioned addresses answer without a credential.

- `GET /health` says the process is up. It reads nothing.
- `GET /ready` says whether this process can serve, and is the check that puts it into rotation: use it for the container healthcheck, the proxy's upstream check and the wait after a deploy. It answers `200 { "status": "ready", "migration": "<newest migration of the release>" }` when the database answers within two seconds and holds every migration the release was built with. Otherwise it answers `503 { "status": "not_ready", "reason": "database_unreachable" }` or `503 { "status": "not_ready", "reason": "database_behind", "missing": ["<migration>", ...] }`. A database ahead of the release is ready, so the previous release stays in rotation while a newer one is rolled out.

`/ready` checks the database and nothing else. A model or mail provider outage does not take the API out of rotation. The answer names migrations only: no host, no account, no connection string and no driver error. The document worker answers `/ready` on its own port with the same body and status.

The proxy has to forward `/ready` to the API like `/health`; it is outside `/api/*`.

## Production Readiness Checklist

Before a real deployment:

- release config validates
- migrations run cleanly
- `/health` answers and `/ready` answers `200` on the API and the document worker
- TLS is configured
- production secrets are not in Git or images
- backups run and restore has been tested
- model provider billing alerts or budgets exist
- retention and deletion behavior is documented
- audit views are permissioned
- user access path is tested
- customer-hosted integrations have timeout and failure behavior

## Release Gate For The `/api/v1` Cutover

The release that moves the product API under `/api/v1` answers 404 at every old path, with no alias. Interface, CLI and server ship together, so the only callers it can break are outside ones: a backend that issues chat session tokens for an embedded chat.

Before deploying that release to an operated instance:

1. Search the instance's access log for `POST /auth/session-token` and `POST /api/superadmin/session-tokens` over the log's whole retention.
2. Record the result with the release: the two paths, the period searched, and per path the request count and the calling hosts. Record metadata only, never request bodies, tokens or the server credential.
3. Move every caller found to `POST /api/v1/instance/session-tokens` in the same release. The `x-server-credential` header and the payload are unchanged.
4. Give every CLI runner a `CATALYST_API_KEY`; the CLI no longer signs in with the server credential. The server needs `SERVICE_ACCESS_TOKEN_SECRET` for the key exchange.
5. Tell users to reload open tabs after the upgrade. A tab loaded before it calls the old paths and shows "Operation is not available"; later releases show a notice with a reload action instead.

A reverse proxy that forwards `/api/*` and `/health` needs no change.
