---
section: Fixed
---

- A start of a workspace's Workflow through `workflow.<id>.start` (agent tool, API, child step) asks its rights with the Workflow's workspace, so a grant there admits it, a deny there refuses it, a builder of the workspace finds it among the callable operations and its workspace's guardrails see it.
- Deleting a workspace deletes its Workflows by the Workflow's own delete: their open runs are cancelled, their accounts retired with their grants, and each name stays taken as a deleted Workflow of the instance, so a new Workflow of that name in another workspace no longer reads the old runs. The same holds for a Personal Workspace deleted with its account.
- Unpublishing or deleting a Workflow names only the live Apps the caller may read among those that start it, and counts the others.
