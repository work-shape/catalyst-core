---
section: Added
---

- **Connections:** An accepted operation's `limits` (`concurrency`, `perPeriod: { calls, seconds }`) are now held on the call path for the whole instance, across processes and runs, and for every page of a paged Workflow step; a definition with them is no longer refused with `not_supported_yet`. A Workflow step that finds no room is queued again for when there is and spends no attempt; any other caller is answered the retryable reason `rate_limited` (`RATE_LIMITED`) with `retryAfterSeconds`, and nothing is sent (EW-13a).
