---
section: Database
---

- Add `workflow_runs.run_key` and `workflow_step_runs.linked_run_id` (0107), then, concurrently, the partial unique index `workflow_runs_run_key_idx` on `(client_instance_id, workflow, mode, run_key)` for keyed runs that are not `failed`, `cancelled` or `limit_reached`, and `workflow_step_runs_linked_run_idx` (0108). Apply both before startup; existing runs have no key, and the previous release reads the expanded schema.
