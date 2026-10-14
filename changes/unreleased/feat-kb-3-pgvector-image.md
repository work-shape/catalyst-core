---
section: Changed
---

- **The instance's Postgres image is our own, with pgvector (KB-3, ADR-0023):**
  `ghcr.io/vivd-solutions/catalyst-postgres`, pinned by digest in
  `docker/postgres/pinned-image`. It is `postgres:17.11-trixie` by the digest the live hosts
  ran on 2026-10-14 (Debian 13, glibc 2.41) plus `postgresql-17-pgvector` 0.8.7-1.pgdg13+1 from
  PGDG, checked against its SHA-256 and installed alone, so Debian, glibc and Postgres stay
  those of the base. `vector` is not a trusted extension on it. The demo Compose files, the
  hosted checks and `pnpm check:local` start it; `POSTGRES_VERSION` is gone from the demo's
  environment. The workflow "Postgres image" builds, checks and pushes it
  (`docker/postgres/check-image.sh`: versions, collation, `halfvec` ranking exact and through
  HNSW, a dump with vectors restored into a scratch database). `DataStores` gains
  `ensureVectorExtension(storeId)`, which creates the extension in one store as the platform's
  role; nothing calls it yet (KB-5). **Operators:** switch the `postgres` service of a deployment
  to the pinned digest once, in the order of the KB-3 rollout: every database backed up with
  the roles (`pg_dumpall --globals-only`), `/etc/os-release`, `version()` and `datcollversion`
  recorded on the host, staging first, the log and `pg_database` read for collation warnings
  after the restart. **Rollback:** until the first `CREATE EXTENSION vector` on a server,
  restart the `postgres` service on the image it ran before (`postgres@sha256:2d2b8998...` on
  the hosts read so far); the data directory is the same. After it, the old image starts, but every use
  of the extension's types in that store fails, since its library is missing; the way back is
  then only through a dump (ADR-0023).
