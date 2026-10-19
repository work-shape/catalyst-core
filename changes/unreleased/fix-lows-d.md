---
section: Fixed
---

- Repair pending Inbox requests left behind by ended calls before retention pruning, and remove settled held-call requests whose run is gone in bounded batches.
- Report missing Knowledge Base and Connection availability when the first default agent is created or synced, keeping those dependencies visible in publish review without blocking sync.
- Mark stale held asset saves consistently across asset kinds, localize unreadable Knowledge Base tool input in German, and derive unsupported attachment formats from the accepted file types.
- Reset the workspace route before mounting another person's session so an old workspace cannot trigger a closed-link notice or read for the next person.
