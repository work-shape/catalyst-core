---
section: Database
---

- **Knowledge Bases:** Owned-store migration 13 `workflow_ingest` (the platform role applies it to every Knowledge Base store at the next start, no platform migration): sync runs take the mode `ingest` with their Workflow run, dataset, `complete`, `accepted` and the state of a complete pass. The unique index of a running sync per source stays as it is: one pass of a Workflow's source runs at a time, and a further call waits in the new table `ingest_waiting` until it is its turn. New tables `ingest_failures` and `ingest_items` hold a pass's failure rows and inline items only until it ends. A rollback leaves the columns and tables unused.
