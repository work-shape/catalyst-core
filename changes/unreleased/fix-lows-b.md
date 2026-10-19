---
section: Fixed
---

- Row updates and deletions accept computed primary-key columns as selectors while keeping computed columns read-only. Operation input validation uses the caller's English or German language, including schema limit refusals.
- Row-write event contract coverage requires the writing Operation Run, matching the existing audit writer.
