---
section: Changed
---

- Phone fit (UXA-7a): a table in a chat reply or a Markdown preview stands in the library's `Table` box, so a table wider than the message scrolls sideways inside it with the edge fade and shade instead of losing columns, and a cell is as wide as its content up to 16rem and breaks between words only, so a short value stays on one line and the cut falls inside a column; its copy menu stays, its fullscreen button is gone.
- A page head keeps its actions on one line. Where they do not fit, the secondary actions move into the head's "…" menu and the primary action stays, so no label is cut. Beside the actions a detail head keeps room for its name (the whole name or 160 px), so beside a dock the actions fold before the name is cut. Breaking for `@work-shape/catalyst-ui`: `PageHeader`'s `secondaryActions` is now a list of `PageHeaderAction` data, and `overflow` became `menu`, the items of the "…" menu whose button the head draws itself.
- The agent picker and every other `Picker` open at their first option; the keyboard starts on the chosen option where it shows, otherwise on the first.
- The command palette names each Settings page with its group, such as "Instance › Users" ("Instanz › Benutzer").
- The solid band under the phone's sidebar button gives way where a pinned detail head stands outside a conversation: on a Studio page, an App or a Workflow it covered the head, its name and its actions. Over a conversation, a list or a Settings page it stays, so nothing scrolls under the button.
- An App's view keeps Edit in its head as the primary action, so on a phone only "Edit with the agent" folds into the "…" menu.
- A shipped skill or Connection keeps "Copy to edit" in its head as the leading action, so on a phone it no longer folds into "…" while the notice under the head says to copy it. The German notice addresses the reader with "du".
