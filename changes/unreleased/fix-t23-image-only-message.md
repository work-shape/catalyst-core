---
section: Fixed
---

- **Chat:** A picture or file can be sent without text. The send button and Enter take a message whose only content is its attachments, on the start page and in an open conversation, and the agent gets it as a normal turn. A picture pasted into the composer uploads like a picked file, so it goes with the message instead of being dropped. A message with neither text nor attachment is still refused: `conversations.runs.start` answers it with `VALIDATION_FAILED`, and `conversations.runs.create` refuses an empty first message before it makes a conversation.
