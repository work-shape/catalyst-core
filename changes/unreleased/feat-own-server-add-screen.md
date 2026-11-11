---
section: Added
---

- **Connections:** You > Connections has "Your MCP servers": a person adds an MCP server for
  themselves with its address and Connect, signs in to it in another tab, chooses its tools
  (reads or changes) and clicks Done. Each server shows as a card with its host, state and
  number of tools, "Change tools", "Sign in again" and "Remove". Under "Change tools" a changing
  tool the owner always allows says "Always allow", and "Ask again" takes it back. A tool the
  server does not mark read-only cannot be accepted as reading. English and German.
- **Connections:** `modules.connections.ownServers.enabled` is on by default. An operator whose
  contract forbids people's own servers sets it to `false`.
- **API:** `connections.mine` lists the caller's own servers, also while switched off, with
  `ownServer: { host, enabled, tools }`, and answers `ownServers.mayAdd`: whether the switch is
  on and the caller holds `connection.add_own` in a first-party session.
- **Docs:** "Add your own MCP server" under Connect systems.
