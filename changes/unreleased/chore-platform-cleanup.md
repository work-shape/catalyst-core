---
section: Changed
---

- **Repository:** The README now says what the repository holds, how to run and test it and how a
  change lands; `tests/README.md` is the one page on which command runs which tests and how to get
  a test Postgres. Release, GHCR and Postgres-image notes moved to `scripts/release/README.md`.
- **Repository:** Removed the broken agent-stories runner (`pnpm test:agent-stories`), the
  migration 0020 preflight (`pnpm db:preflight:collaboration-workspaces`), the unused root
  `.env.example`, `skills-lock.json`, `components.json`, the demo's unused `deploy/Caddyfile` and a
  stray preview config. The reference client reads its environment from `clients/demo/.env`.
