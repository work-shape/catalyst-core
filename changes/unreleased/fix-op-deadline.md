---
section: Fixed
---

- Enforce operation deadlines and abort signals on direct calls as well as approved calls. A timed-out call records and returns `TIMEOUT`, replays that failure under the same idempotency key, and cannot replace it with a late success. Recovery sweeps remain the backstop for abandoned runs.
