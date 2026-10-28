---
section: Added
---

- **Chat:** An agent under "Only me", owned by a person's Personal Workspace, can now be chosen by that person in any chat they began that nobody else reads: a chat of their Personal Workspace or a private chat in a team. Choosing it marks the chat as holding personal data, so a later move to the workspace is refused. In a chat others read the agent picker shows it greyed with the reason. Nobody else sees it, and a key, an embedding host, a service principal, a subagent of another agent, a Workflow step or a scheduled start cannot use it. `workspaces.agents.list` returns such agents as `ownChatAgents`; the same chat-audience rule (`mayUseOwnInChat` in core) now also decides personal skills in chats. The publish dialog's "Can be chosen in" for such an agent reads "In your own chats". In the usage of a shared workspace such an agent counts to the workspace under one row, "Personal agents" (`PERSONAL_AGENTS_KEY`), never by its name.
