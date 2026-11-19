---
section: Database
---

- **Tools:** migration 0207 `tool_code_calls` creates the table `tool_code_calls`, which holds a
  code tool's call while its handler runs: the input until the handler ended, then how it ended,
  until the operation read it. Rows go with their conversation and the command worker's sweep
  removes rows older than an hour. It changes no existing table. A rollback leaves the table unused.
