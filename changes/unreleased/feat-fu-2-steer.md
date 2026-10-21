---
section: Added
---

- **Conversations:** `runs.start` takes `followUp: "steer"` (FU-2). While the sender's own run is going, under the same credential, the message is taken in by the running turn after all tool results of its current step and before its next model call. It is stored as a user row at that moment, with `steered` delivery metadata, and every tab is told with the new `user_message_steered` run event. A steer the turn does not read before it answers becomes a queued follow-up and starts the next turn. A steer into someone else's run, or one with attachments, is queued. `message.created` is audited with `delivery: steered` and the run, without the text. Follow-ups gain the mode `steer` and the status `consumed`. Provider tests cover a steered message after tool results on Bedrock, OpenAI-compatible providers and Vertex.
