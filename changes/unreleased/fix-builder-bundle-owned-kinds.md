---
section: Fixed
---

- **Access:** Builder and Publisher in a workspace carry their verbs only on the kinds a
  workspace can own. Builder no longer carries `connection.read` and `connection.write`, which
  named a right on no asset, since no workspace owns a Connection; a workspace builder is no
  longer offered an empty Connections page in Studio. Agents, skills, Apps, Workflows, Data
  Stores, Knowledge Bases and guardrails the workspace owns are reached as before.
