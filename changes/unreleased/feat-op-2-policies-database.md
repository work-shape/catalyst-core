---
section: Database
---

- Add the tables `central_policy_settings` and `always_allow_locks` (0192, additive). A setting narrowed to a Shared Workspace is removed with the workspace. Apply the migration before startup. A rollback to the previous release needs no step: it reads neither.
