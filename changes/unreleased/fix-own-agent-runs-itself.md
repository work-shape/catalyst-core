---
section: Fixed
---

- **Agents:** A person's "Only me" agent can run itself as a subagent in its owner's own chats. `agents.run` without another agent named was refused because the availability check did not get the chat; it now gets the root chat, so the same rule as for choosing the agent decides. It stays refused for another member's personal agent, for a key, an embedding host or a Workflow step, in a chat others read, and for a personal agent named by another agent.
