---
section: Fixed
---

- The local deterministic model reads a `/tool` command's input as its first JSON value. A later preview report that the run adds to the person's message no longer turns the command into invalid JSON, so the call runs instead of failing silently.
