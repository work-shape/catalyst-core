---
section: Fixed
---

- **Workflow retention:** One exhaustive owner now covers run snapshots, checkpoints, keys,
  labels, step inputs and outputs, all code attempts, staged inputs, raw outcomes and logs.
  Names, status, times, error codes, counts and structural child/continuation IDs remain.

- **Deployment:** Migrations 0119–0120 add an indexed retention version and allow expired run definitions to
  be removed. The existing scheduled retention job repairs already marked rows in bounded
  run/step batches, preserves their original prune time, and safely resumes or runs twice.
  The repair shares the normal owner rather than copying its field list into a data migration.
  Deploy migrations before app/workers. No new refusal text. Rollback cannot restore erased
  values; older workers may leave version-zero rows for the next upgraded sweep. Keep the
  previous release's prune index until its workers have drained.
