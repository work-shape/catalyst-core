---
section: Changed
---

- Test projects share Postgres worker modules while retaining per-file databases and isolated exceptions. Tooling tests run separately with `pnpm test:tooling` in local, PR and nightly checks.
