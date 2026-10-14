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
  role, and finds it where the store already has it, also where an operator created it as its
  refusal `vector_extension_not_permitted` says; nothing calls it yet (KB-5). **Operators:**
  switch the `postgres` service of a deployment to the pinned digest once, in the order of the
  KB-3 rollout: every database backed up with the roles (`pg_dumpall --globals-only`),
  `/etc/os-release`, `version()` and `datcollversion` recorded on the host, staging first, the
  log and `pg_database` read for collation warnings after the restart. **Rollback:** until the
  first `CREATE EXTENSION vector` on a server, restart the `postgres` service on the image it
  ran before (`postgres@sha256:2d2b8998...` on the hosts read so far); the data directory is the
  same. After it, do not start the old image on that data directory: a store database with the
  extension can then not be read at all, its other columns included, and `pg_dump` and
  `pg_dumpall` fail on it, so a backup of all databases breaks as well. A dump taken on the new
  image does not restore on the old one either ("extension "vector" is not available"). The way
  back is on the new image: in every database that has it, `DROP EXTENSION vector CASCADE`,
  which drops the columns and indexes that use it with their embeddings; then restart on the
  old image.
