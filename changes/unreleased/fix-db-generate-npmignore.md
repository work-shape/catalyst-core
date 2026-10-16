---
section: Fixed
---

- `pnpm db:generate` runs again without moving a file aside: the packaging rule that keeps migration snapshots out of the postgres-store tarball moved from `migrations/meta/.npmignore`, which drizzle-kit read as a malformed snapshot, to `migrations/.npmignore`. The packed file list is unchanged.
