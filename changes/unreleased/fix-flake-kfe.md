---
section: Fixed
---

- Prevent unused Data Store test fixtures from deleting another fixture's live databases during teardown and leaving stale assets that fail subsequent Knowledge Base extraction setup with HTTP 412.
