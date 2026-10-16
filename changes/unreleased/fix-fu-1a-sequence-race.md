---
section: Fixed
---

- **Follow-up queue:** Changes no longer deadlock with streaming agent-run writes. Worker observations and messages lock the conversation before the run, matching queue acceptance and withdrawal; durable event sequences keep their existing shared allocation and public shape.
