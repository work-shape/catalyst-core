---
section: Fixed
---

- Row updates and deletions accept computed primary-key columns as selectors while keeping computed columns read-only. Operation input validation uses the caller's English or German language, including schema limit refusals.
- Row-write event contract coverage requires the writing Operation Run, matching the existing audit writer.
- Workflow failures carry the called Connection name alongside the missing right, so run summaries can name it without reading a later definition. This is an optional API field; no migration is required, and older runs retain the plain-language fallback.
