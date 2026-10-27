---
section: Database
---

- Migration 0163 rebuilds the two Workflow retention indexes for retention version 4 and adds `operation_runs_workflow_run_idx`, so the calls of a run's own steps can be found when its values are pruned. All indexes are built concurrently.
