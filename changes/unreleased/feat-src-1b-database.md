---
section: Database
---

- Add generic asset ownership to service principals (0105/0106), and owned Knowledge Base store migration 4 for transactionally maintained source counts. Apply the migration before startup; the previous release can read the expanded schema. Source narrowing and removal remain refused with `not_supported_yet` ("Changing a source boundary or removing a source is not supported yet; the published source is kept."); rollback stops new source operations but keeps imported data and owned principals. The previous API lists those principals and does not enforce ownership, so do not administer their accounts on a rollback.
