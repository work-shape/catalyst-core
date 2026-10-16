---
section: Added
---

- Config validation and push report unavailable agent tools with their `toolNames` index or instructions line. Dotted tool names in instructions are checked with or without backticks in the full registry’s tool groups, including tools disabled on the instance; skills are not scanned. Connection operations must exist in stored assets and be exposed to agents. App actions resolve against stored assets plus the push batch. Tools that exist and are exposed but are not callable now produce warnings. Failed validation writes nothing.
- The demo agent's instructions no longer name an unavailable App-saving tool, so demo seeding passes tool-reference validation.
- The Connection tools browser fixture saves valid references before removing a Connection, then verifies its retained tool is marked unavailable after a reload.
