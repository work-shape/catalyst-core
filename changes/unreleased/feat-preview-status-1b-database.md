---
section: Database
---

- Migration 0161 adds `preview_viewer_reports`: one preview report per conversation, file set and viewer, with the digest of the report a run last noted. Rows go with their conversation, file set or account, and the hourly job deletes rows older than 24 hours. `preview_reports` is no longer written; its remaining rows are pruned the same way, and a later migration drops it.
