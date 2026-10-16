---
section: Fixed
---

- **Agent runs:** Log explicitly cancelled agent runs as cancelled at info level with their run id and no error stack. Other signal aborts, including idle stops, worker shutdown and lost leases, keep their error-level diagnostics and stacks.
