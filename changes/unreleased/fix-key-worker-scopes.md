---
section: Fixed
---

- **Agent Runs:** Workers restore a starter's personal API key scopes when rebuilding the caller, including after a pause and in subagents. Tools keep the key's operation access and the scope ceiling on its owner's current rights; Data Store row tools can no longer inherit the owner's wider access. A revoked or expired key stops the run before execution.
