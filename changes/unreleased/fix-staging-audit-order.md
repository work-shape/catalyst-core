---
section: Fixed
---

- Make the access-operation audit assertion independent of row order when audit timestamps tie, preventing intermittent staging release-check failures while still checking the exact events, statuses and actors.
