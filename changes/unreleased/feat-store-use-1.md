---
section: Added
---

- **Chat:** An agent can add a Data Store to the chat for reading, next to what the chat is about (STORE-USE-1). `data_store.use` adds the store's `describe`, `query` and `preview_rows` tools, never tools that change records, and the agent uses them in the same turn. The person's own store, in a chat of their Personal Workspace, is added at once. Any other store shows a card, "Read “…” in this chat?" / "„…“ in diesem Chat lesen?", whose "Allow" / "Erlauben" adds it and lets the agent go on. In a chat others read, the card says that they will see the answers from the store.
- **Rights:** Adding a store grants nothing: every read still checks the person's `data_store.read`. Only the person can add a store, in their own turn: a subagent, a Workflow step, a scheduled start, a run started with a key and an outside client cannot. A Personal Workspace's store is read only in its owner's own chats there. The audit log records each add as `conversation.data_store_added`, with ids only.
- **API:** `POST /api/v1/conversations/:conversationId/data-stores` (`conversations.data_stores.add`) is the card's confirmation. It takes the store and the agent's call it confirms, and only the person whose turn asked for it may send it.
- **Agent tools:** `platform.data_stores.describe` names `data_store.use` as the next step where the chat has no tools for the store's records. A tool now learns whether the call is a subagent's, a Workflow step's, a scheduled start's or a first-party run's.
