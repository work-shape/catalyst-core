---
section: Fixed
---

- **Apps:** "Chat" on an App owned by another workspace, such as one another person built and published for everyone, works again. The agent reads the App, loads its draft with `app.edit` and saves the change as the next draft, from a chat of the person's own in the workspace they are in. Before, the read, `app.edit` and the save were refused with "The subject of the conversation is not available", and the dock showed a preview that could not be opened. The App's own workspace decides who may read and change it, as before; only a conversation of the person's own reaches it.
- **Agents:** `platform.assets.get` tells the agent that an App's files are changed through `app.edit`.
