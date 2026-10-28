---
section: Changed
---

- **Studio:** One set of words for where an asset sits, the same on every screen: "Only me" / "Nur ich" for the reader's Personal Workspace, a team by its workspace name, and "Everyone" / "Alle" for the instance. The list filter is called "Where" / "Wo" and lists the places in that order. Studio no longer says "Instance", "Scope" or "Geltungsbereich" for a place.
- **Studio:** Every list row and asset page shows where the asset sits as a chip. An agent page also shows who uses the agent when that is not everyone: the workspaces it is offered in, nobody yet, or only people with the right to use it. The read-only notice says it in the same words.
- **Studio:** An agent's skill chooser shows the reader's own skills greyed out, with a one-line reason, when the agent belongs to everyone or to a team and so cannot use them.
- **Studio:** When an asset is refused because it uses something from another place (`invalid_scope` with a reference), the message says where the asset sits, what it used, and what to do: make the item in the right place, or ask an admin.
- **Studio:** Data Stores are listed as "Data" / "Daten" and Knowledge Bases as "Knowledge" / "Wissen". A Knowledge Base over a data store's tables is offered as "Knowledge from your data" / "Wissen aus deinen Daten".
- **UI library:** `ScopeChip` takes `scope: "personal"` for the reader's own place.
