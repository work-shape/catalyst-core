---
section: Fixed
---

- **Workflows:** Workflow Runs now refresh failed-item counts when an attempt finishes after cancellation, preserving the failure rollup of a continued Lauf. Run-row locks share one root, parent, child order, so a keyed child start returns `run_key_cycle` instead of deadlocking with a concurrent root transition.

- **Deployment:** Deadline wakes requested while the current deadline job runs are retained and queued after that attempt. Migration `0119_job_wakes` adds the durable wake table before API or worker startup. Startup on an older database refuses with `The database is behind this release. Run the migration step before starting. Missing migrations: 0119_job_wakes`. The migration is additive and supports draining workers from the previous release. On rollback, leave the table in place; pending wakes need the new executor and must be drained before reverting workers.
