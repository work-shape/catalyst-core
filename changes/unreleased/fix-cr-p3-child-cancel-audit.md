---
section: Fixed
---

- Record `workflow_run.cancelled` once for each child run cancelled when its parent ends, with the parent run id in audit metadata.
- Restore per-value Connection and Workflow contract documentation and remove the outdated migration snapshot packaging comment.
