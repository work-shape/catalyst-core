---
title: Deployment
description: Package and run a dedicated client instance.
---

Vivd Stage runtime services are packaged as Docker images. Docker Compose is the default local and first production-friendly deployment target.

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

## Production Readiness Checklist

Before a real deployment:

- release config validates
- migrations run cleanly
- health endpoints pass
- TLS is configured
- production secrets are not in Git or images
- backups run and restore has been tested
- model provider billing alerts or budgets exist
- retention and deletion behavior is documented
- audit views are permissioned
- user access path is tested
- customer-hosted integrations have timeout and failure behavior
