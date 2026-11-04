---
section: Fixed
---

- **Apps written through the CLI:** An App created or changed with `catalyst app put` (`assets.put` with files) is now saved as a commit of the App's repository, as a save in chat is. Such an App could not be opened for editing in chat: `app.edit` answered "This App has no draft repository to check out" and the preview stayed empty. An App written that way before this release gets its repository from its existing revisions, oldest first, on its next `app.edit` or `assets.put`; no migration is needed. `assets.adopt_repository` now also adopts Apps.
