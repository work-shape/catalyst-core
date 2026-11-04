---
section: Changed
---

- **Projects in the sidebar:** Each project folds on its own. A project is a small label with its folder, which opens the project's page, and a caret right after it, which opens and folds its chats. Several can be open at once, the browser keeps the choice, and the project on screen opens. An open project shows its five chats used last at the label's edge, and only where it has more a muted "Show more" ("Mehr anzeigen") follows and shows the next ones in place. The "All chats" row is gone.
- **UI library:** `NavGroup` takes `collapsible` together with `labelLink`: the label stays the link and a caret right after it folds the group, with `labelIcon`, `labelMark`, `labelCurrent` and `foldLabel`. A group within a labelled group no longer pins its label.
