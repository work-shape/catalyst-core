---
section: Added
---

- **Connections:** An agent can propose a person's own MCP server in a chat only that person
  reads (PMCP-CHAT). `platform.connections.propose` takes a mode `own_server` with the type
  `mcp`, a name and an https address, and nothing else. It is offered to any agent there, not
  only one with the platform's tools, while own servers are on and the person holds
  `connection.add_own`, and never in a shared chat, a Workflow, a subagent or a key's run. The
  agent's `ownServers: false` withholds it. The card "Add MCP server" opens You > Connections
  with the add dialog filled; nothing is saved before the person presses Connect. On Done the
  chat gets their message naming the server and the tools accepted. The audit names the mode,
  never the address or name. English and German.
