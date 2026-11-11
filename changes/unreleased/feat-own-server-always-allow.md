---
section: Added
---

- **Connections:** The owner of a self-added MCP server can answer a changing tool's
  confirmation with "Always allow", or choose it on Settings > You > Confirmations, although the
  tool declares no change class. The next call of that tool in a chat where only that server
  ran goes without asking; every other changing tool still asks, and an admin's `allow` still
  does not lower one. In a chat where another Connection's operation ran, the tool asks again.
  Only the owner sets it, in their own signed-in session: a personal key, the CLI, an embedding
  host's session or a Service Principal is refused with `user_only`, and for anyone else the
  operation does not exist. A discovery that finds the tool's description or input schema
  changed since it was accepted removes the owner's "Always allow" in the same write and
  records `user.operation_setting_changed` with reason `tool_changed`, the operation and nothing
  else; Ask me and Never stay. Ask me takes it back.
