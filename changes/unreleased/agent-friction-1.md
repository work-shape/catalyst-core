---
section: Fixed
---

- Tool timeouts tell the agent that the tool did not answer in time and that its outcome must be checked before repeating a change; provider details stay private.
- Tool validation messages name the offending field and the validation issue, alongside the structured details.
- Workflow authoring guidance tries Connection reads before using their results, offers missing tools with `platform.connections.offer_to_agent`, and explains MCP JSON-in-text results and parsing before mapping fields.
- App and Workflow guidance names the runner's existing PyYAML installation; documentation references need only be loaded once while they remain in the conversation context. The task-sized App guide and the corresponding Connection guidance already exist on main.
