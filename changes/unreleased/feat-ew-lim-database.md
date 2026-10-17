---
section: Database
---

- Add `platform_jobs.concurrency_limit` and `workflow_runs.limits`, `waiting_since` and `waited_ms` (0110, additive). Apply the migration before startup; the previous release can read the expanded schema and ignores the new columns, so a rollback runs every Workflow under the fixed defaults again.
