---
section: Added
---

- **Workspace default agent:** A Shared Workspace can name its own default agent, any agent available there, under Settings > Workspace > General ("Default agent"). New chats in the workspace start with it. Its owner or admin sets it, and so can an instance admin, also with `catalyst agent set-default <name> --workspace <id>` or `assets.set_default` with `workspaceId`. The instance's default agent then no longer has to be available in that workspace: it stays available in every workspace that names no default of its own and in every Personal Workspace, and a workspace created later gets it. Taking an agent away from a workspace that names it as its default, or deleting it, is refused with the workspace's name. The agent page's "Available in" says where a default has to stay. The change is audited as `config_asset.workspace_default_agent_set` with the workspace's and the agent's ids.
