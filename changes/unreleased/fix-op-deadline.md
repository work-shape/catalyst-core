---
section: Fixed
---

- Enforce operation deadlines and abort signals on direct calls as well as approved calls. A timed-out call records and returns `TIMEOUT`, replays that failure under the same idempotency key, and cannot replace it with a late success. Recovery sweeps remain the backstop for abandoned runs.

- Preserve the stored outcome when a recovery sweep ends a call first. Refuse dispatch after a deadline or caller abort, name the effective timeout limit in English and German, and keep interruption guidance for agent tools.

- Distinguish executor deadlines from caller cancellation through a typed abort reason. `workspace.exec` retains its deadline cancellation reason and returns `timed_out` with the command id, while its Operation Run remains `TIMEOUT`. Web fetch, Page build and repository-save waits also classify executor timeouts as deadlines.
