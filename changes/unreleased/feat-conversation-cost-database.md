---
section: Database
---

- **Usage:** Migration 0203 `usage_event_conversation_index` builds
  `model_usage_events_conversation_idx` on `(client_instance_id, conversation_id)` for events that
  name a conversation, with `CREATE INDEX CONCURRENTLY`, so writes to `model_usage_events` go on
  while it builds. It adds no column and changes no row. A rollback leaves the index unused.
