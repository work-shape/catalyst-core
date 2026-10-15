---
section: Added
---

- Config validation and push report unavailable agent tools with their `toolNames` index or instructions line. Dotted tool names in instructions are checked with or without backticks in the instance’s tool namespaces; skills are not scanned. Connection operations and App actions resolve against stored assets plus the push batch, with warnings for tools that exist but are not callable now. Failed validation writes nothing.

- Runtime Connection puts can share a scoped batch with agents, retaining server-owned fields and post-write discovery handling. Validation also recognizes the Page tools already offered by conversations.
