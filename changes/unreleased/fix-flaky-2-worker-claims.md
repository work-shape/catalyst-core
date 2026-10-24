---
section: Changed
---

- **Jobs:** Debug logs show each worker pass's queue filter and claim decisions, including local slots, global concurrency and skipped candidates. Job tests retain these decisions and queue metadata on failure to diagnose intermittent missed work.
