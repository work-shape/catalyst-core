---
section: Fixed
---

- **Workflow retention:** One exhaustive owner now covers run snapshots, checkpoints,
  step inputs and outputs, all code attempts, staged inputs, raw outcomes and logs.
  Keys and labels remain as governance identifiers, preserving done-run deduplication and keeping labels queryable.
  Names, status, times, error codes, counts and structural child/continuation IDs remain.
  Pruned run pages show status, times, errors, links, reached steps and loop counts; without the
  snapshot they omit concurrency and unreached loop-body steps, and expose no value previews.
  Stored code, output and continuation schema failures name positions, never checked data keys.

- **Deployment:** Migrations 0120–0121 add a shared retention version, separate expiry and repair
  indexes, and allow expired run definitions to be removed. The existing scheduled retention job repairs already marked rows in bounded
  run/step batches, preserves their original prune time, and safely resumes or runs twice.
  The repair shares the normal owner rather than copying its field list into a data migration.
  Deploy migrations before app/workers. No new refusal text. Rollback cannot restore erased
  values; older workers may leave version-zero rows for the next upgraded sweep. Keep the
  previous release's prune index until its workers have drained.
