# Infrastructure

All runtime services should be packaged as Docker images. Docker Compose should be the default for local development and the first production-friendly deployment target.

## First Production Target

Recommended first production shape for an operated dedicated instance:

```text
EU VPS / cloud VM
  -> Caddy reverse proxy / TLS
  -> chat API service
  -> standalone/widget frontend service or static assets
  -> tool execution service or worker command, when needed
  -> Postgres, managed or on the VPS
  -> object/file storage, local or S3-compatible depending on data needs
  -> logs, metrics, backups, update scripts
```

Docker Compose can be acceptable for first production deployments if the availability requirements are modest and the instance has proper backups, monitoring, update procedure, firewalling, TLS, and secrets management.

Caddy is the default reverse proxy/TLS component for the first VPS/Compose deployment. It keeps automatic HTTPS and simple service routing lower-friction than Nginx plus Certbot. Nginx or Traefik can still be used later if a customer or hosting environment requires them.

## Postgres On VPS

Managed Postgres is preferred when the customer needs a stronger operational story or the hosting provider makes it easy. Running Postgres on the same VPS is acceptable for early operated dedicated instances if we treat backup and restore as production features.

Minimum requirements for VPS-hosted Postgres:

- persistent volume outside the app container lifecycle
- automated backups to an external bucket
- restore procedure documented and tested
- retention policy for backups
- encrypted bucket or provider-side encryption
- least-privilege bucket credentials
- monitoring for failed backups
- committed migration procedure; startup migrations are acceptable for first single-instance Compose deployments, but run a separate migration step where practical

Cron-based backups are acceptable for v1. Prefer a simple, inspectable setup such as scheduled `pg_dump` or volume-level backups uploaded to an S3-compatible bucket. If recovery point objectives become stricter, add WAL archiving or managed Postgres.

S3-compatible object storage is the default backup target. The stack should support AWS S3, Hetzner Object Storage, Cloudflare R2, MinIO, or similar providers through configuration:

- endpoint
- bucket name
- region
- access key
- secret key
- retention policy
- optional server-side encryption settings

## Kubernetes

Kubernetes should not be a v1 requirement. It adds operational complexity that is probably not justified for one dedicated client instance with moderate traffic.

The stack should still stay Kubernetes/managed-container ready by following container discipline:

- one process per container role
- immutable images with explicit tags
- env/file based configuration
- externalized persistent state
- health/readiness endpoints
- graceful shutdown
- stdout/stderr logs
- explicit database migrations
- no hardcoded localhost assumptions
- secrets injected at runtime, not built into images

## Deployment Stages

1. **Local development**: Docker Compose runs app services plus Postgres and optional support services.
2. **First operated production**: Docker Compose on an EU VPS/cloud VM. Postgres may be managed or on the VPS with external backups.
3. **Larger operated production**: same images deployed to managed container service or Kubernetes.
4. **Self-hosted customer deployment**: customer runs the same images through Compose or their own orchestrator.

The likely scaling pressure is not normal chat traffic. It is tool execution and future full agent worker machines. Therefore the infrastructure should separate the chat API from worker-style execution early enough that heavy tools can move to separate containers/machines without changing the public API.

## Deployment Automation

For v1, separate release/publish from deployment.

The local publish script is the release gate. It should run checks before creating/pushing a new tag:

```text
npm run publish
  -> install/verify dependencies if needed
  -> lint
  -> typecheck
  -> test
  -> build
  -> verify generated artifacts are current
  -> create version/tag
  -> push tag
```

The tag then triggers CI to build and push versioned Docker images.

Deployment uses a deploy script as the source of truth and lets GitHub Actions call it.

Recommended flow:

```text
npm run publish pushes a tag
  -> CI builds and pushes versioned Docker images
  -> explicit GitHub Actions deploy workflow is manually triggered for a target client instance and tag
  -> GitHub Actions calls deploy script over SSH
  -> deploy script updates env/image tags on the VPS
  -> docker compose pull
  -> run database migrations
  -> docker compose up -d
  -> health check
```

The deploy script should also be runnable manually from a developer machine with the right credentials. This avoids duplicating deployment logic between local emergency operations and CI.

For the first single-instance Compose target, the app may also run committed migrations on startup so a pulled image and database stay in sync. Once there are multiple app replicas, separate worker processes, zero-downtime requirements, or riskier data migrations, the deploy script should run migrations exactly once before starting app containers and app containers should disable startup migrations.

GitHub Actions is the preferred automation wrapper for operated instances. Deployment should be a manual `workflow_dispatch` action in v1, with inputs for the client instance and image/release tag. Use GitHub Environments for production approvals and an audit trail.

A GitHub Release can be created from the release tag for human-readable release notes, but publishing a GitHub Release should not automatically deploy to a customer instance in v1.

A manual script-only path remains useful for first setup, break-glass recovery, and customers that do not use GitHub.

## Secrets

For the first VPS deployment, secrets can live in env files on the VPS. They must be provisioned manually or through an encrypted deploy/setup step and must not be committed or baked into images.

Minimum rules:

- no secrets in Git
- no secrets in Docker images
- separate example env files from real env files
- least-privilege credentials per service
- production env files readable only by the deploy/runtime user
- documented rotation procedure

Future options include SOPS, Infisical, Doppler, 1Password Secrets Automation, or cloud secret managers.
