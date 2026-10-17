---
section: Database
---

- **Deployment:** Apply migration `0094_managed_file_owner` before starting API and worker processes. It adds the nullable columns `managed_files.owner_kind` and `managed_files.owner_id`; every existing file keeps no owner, and the previous release stays compatible. Do not roll back once a file was added to a Knowledge Base: the previous release's orphan sweep does not know the owner columns and deletes the Knowledge Base's copies, whose rows no Conversation refers to. Delete those files first, or keep the release.
