---
section: Added
---

- **Apps:** A person renames an App in place from the "…" menu of its card in the Apps list and of its page (`apps.rename`). Renaming needs `app.write`, the right that edits the App. Only the name people read changes, at once for the draft and what is published and without a new revision; the id stays. The audit event `app.renamed` names the App, not the name (T34).
- **Apps:** A name a person gave, by renaming or in Save as app, stands over every later write of the App: a save from a Page, `assets.put` with a manifest that names another, and the agent's `app.save`. `app.save` and `app.edit` answer `nameSetByPerson`, and the agent is told never to rename such an App and at most to ask when its change made the App do something quite different (T34).
- **UI library:** `RenameField` edits a name where it is read, and `PageHeader` takes `titleEditor` to stand in the name's place.
