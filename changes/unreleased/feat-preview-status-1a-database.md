---
section: Database
---

- Migration 0159 adds `preview_reports`: one report per conversation and file set. Rows are removed with their conversation or file set, and an hourly job deletes rows older than 24 hours.
