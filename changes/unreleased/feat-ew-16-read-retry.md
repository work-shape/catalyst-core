---
section: Fixed
---

- Retry transient Workflow reading operation failures up to three attempts with the step job backoff. Source rate limits respect Retry-After without spending an attempt or holding a worker slot. Exhausted reads keep the operation error code; changing calls retain their existing replay rules.
