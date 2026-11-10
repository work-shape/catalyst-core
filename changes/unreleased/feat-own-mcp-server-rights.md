---
section: Added
---

- **Connections:** The rights and rules of a person's own MCP server. A Connection of type `mcp`
  in mode `user` may carry `ownerOnly: true`, which is fixed when it is added
  (`owner_only_fixed`). A person signed in to the instance in a first-party session who holds
  the new action `connection.add_own` adds one through `assets.put` without any Connection
  right. The built-in role `user` holds the action by default. Such a server takes exposure
  `agent` only, has no availability and no accepted tool in its create, and nobody but its owner
  reads, uses, changes or deletes it. No role, grant, workspace, availability or key scope
  reaches it (`not_owner`). An instance admin reads it, switches it off and deletes it, and
  nothing more. No grant on it can be written.
- **Connections:** The owner's test of their own server resolves no credential. It answers
  `ready`, `oauth_required`, `token_required` (a 401 with no Bearer challenge) or `unavailable`,
  and writes the server's health. The owner reads its tools with their own sign-in, as for a
  personal MCP Connection.
- **Release config:** `modules.connections.ownServers` with `enabled` (default `true`),
  `perPerson` (default 10, `own_servers_limit`) and `publicHttps` (default `true`, read by a
  later change). With `enabled: false`, adding one answers `own_servers_off`, and so do the
  calls and tests of a server added before. Nothing is deleted.
- No interface offers the add yet.
