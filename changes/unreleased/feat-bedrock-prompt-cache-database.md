---
section: Database
---

- **Usage:** migration 0204 `usage_cache_write_tokens` adds the nullable column
  `model_usage_events.cache_write_input_tokens`. Earlier rows hold null; no row is rewritten. A
  rollback leaves the column unused.
