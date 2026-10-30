---
section: Database
---

- Add the nullable column `workflow_runs.rerun_of` (0185, additive). Apply the migration before startup. A rollback to the previous release needs no step: it reads nothing of it.
