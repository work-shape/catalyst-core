---
section: Fixed
---

- `pnpm check:affected` without `AFFECTED_BASE` compares against the first of `origin/main`, `github/main` and the `main` of a remote whose URL names work-shape/catalyst-core that exists, and says what it tried when none does, so lane worktrees whose remote is named `github` no longer need `AFFECTED_BASE` set by hand.
- The tests refuse to start against a Postgres whose major version differs from the pinned image's, read from `docker/postgres/Dockerfile`, instead of failing query-plan tests on it.
