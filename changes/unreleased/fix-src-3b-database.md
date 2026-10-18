---
section: Database
---

- Owned-store migration 9 (`source_superseded`), after REC-1a's migration 8 (`record_content_hash`), expands sync outcomes. The owned-store upgrade job applies it in order; no platform migration is needed. Source operations refuse a store awaiting upgrade with `CONFLICT` (409), reason `knowledge_store_not_ready`. Drain older source workers before starting this version: older binaries do not understand `superseded` outcomes. A rollback must retain migration 9 and use code that understands this outcome; do not roll back the schema.
