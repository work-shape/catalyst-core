---
section: Database
---

- Add the table `workflow_webhook_deliveries` (nonces and rate counts of webhook requests, kept ten minutes) and the nullable column `workflow_runs.trigger_event` (0186, additive), and the partial unique index `workflow_runs_trigger_event_idx`, built concurrently (0187). Apply both migrations before startup. A rollback to the previous release needs no step: it reads neither.
