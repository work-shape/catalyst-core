---
section: Added
---

- **CLI:** Workflows can be pulled, pushed and compared as CLI folders with `workflow.yaml` and `steps/`, using the App folder machinery. Unchanged Workflow pushes create no revision or commit; stale folders are refused. Workflow folder writes warn about possible secrets without refusing the write or printing the matched text.
