---
section: Changed
---

- **Models:** Every model call sends a prompt cache key: the conversation's id, the parent conversation's for a subagent, the Workflow Run's for a Workflow step. The steps and later turns of one conversation then reach the same cache on the provider. A key longer than 64 characters is sent as its hash.
- **Models:** A turn sends the earlier turns as the last run sent them, so the provider's prompt cache holds across turns: tool results and tool call inputs are compact JSON with their keys in order, however storage ordered them. The encrypted reasoning the last run ended with is sent again while the conversation stays on the same provider and model. After a model switch, or when the provider cannot decrypt it, the turn goes on from history alone. A continuation keeps only the reasoning of the tool calls its request holds.
- **Models:** A tool result is cut for the model above 12,000 estimated tokens instead of 60,000 (`modelContext.toolOutput.maxTokens`). The cut keeps its start and end and is the same every turn. Its note names the result, its size and the characters left out, and how to read them. A deployment that sets `maxTokens` keeps its value.
- **Agents:** Every agent with tools is offered `tool_result.read`, always as its last tool. It reads a cut result in parts, from the whole result its conversation stores, and each answer names the offset to go on with. A run reads only the results of its own conversation. Where a tool can narrow its own result (`workspace.read_file`, `workspace.exec`, a `.query`), the note names that way too.
