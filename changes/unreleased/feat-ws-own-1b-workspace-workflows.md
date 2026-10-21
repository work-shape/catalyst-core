---
section: Added
---

- **Workflows:** a workspace owns the Workflows made in it (WS-OWN-1b). The agent's first save in a conversation creates the draft in the conversation's workspace; `assets.*` on `workflow` take `workspaceId`, and `workflow.read`, `use`, `write`, `publish` and `delete` are grantable at workspace scope, reaching that workspace's Workflows alone. Membership gives no Workflow right. `workflows.list` names the owning workspace (`workspaceId`), and the Workflows page lists the open workspace's Workflows beside the instance's, with the workspace's chip. A workspace Workflow's `workflow` step may name a Workflow of its own workspace or of the instance only.
