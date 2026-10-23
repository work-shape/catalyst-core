---
section: Database
---

- Migration `0143_personal_connection_isolation` adds nullable `conversations.personal_data_at` and `operation_runs.result_bytes`. Existing persisted run authorization already records first-party or owner-authorized scheduled starts; no new run column is needed.
