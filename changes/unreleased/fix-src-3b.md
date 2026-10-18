---
section: Fixed
---

- Synced documents from before owned-store migration 5 remain searchable without another sync. A published boundary change invalidates unknown ancestry and queues a full pass. Only a person's full sync replaces a pending withdrawal confirmation; changes polls, Workflows, retries and answered confirmations join the held pass. Competing decisions return `CONFLICT` (409). Replaced passes end as `superseded` without a source failure.
- Apply platform migration `0115_knowledge_source_boundary_changes` before API/worker startup. Startup refuses a missing migration by name. Owned-store migration 8 (`source_superseded`) expands sync outcomes. Drain older source workers before starting this version: older binaries do not understand `superseded` outcomes. A rollback must retain both migrations and use code that understands this outcome; do not roll back the schema or clear published boundary markers.
