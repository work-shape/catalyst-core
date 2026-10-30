---
section: Database
---

- Add the table `workflow_step_pins` and the nullable column `workflow_runs.pinned_steps` (0183, additive). A pin row is removed with its Workflow asset or its source run. Apply the migration before startup. A rollback to the previous release needs no step: it reads neither.
