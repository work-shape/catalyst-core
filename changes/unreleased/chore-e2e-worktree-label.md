---
section: Changed
---

- The chat E2E runner labels its Postgres container and volume `catalyst.worktree=<name>`, taken from `CATALYST_WORKTREE` or the checkout's `.worktrees/<name>` path, so the lane's `tidy` removes a stack whose worktree is gone by its label and never by a name.
