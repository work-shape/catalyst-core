---
section: Database
---

- Add the column `connection_source_calls.operation_name` (0188, additive, `text NOT NULL DEFAULT ''`). Apply the migration before startup. A rollback to the previous release needs no step: it writes and reads rows with the default.
