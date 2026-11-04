---
section: Fixed
---

- **Apps:** An open App gets the window. Its head is one slim row: a lower bar, a smaller name, small buttons and no description (Details still shows it). At phone width the row holds: Edit is its icon, Edit in chat folds into the menu, and the sidebar button stands level with the row. The App's frame fills everything under the head edge to edge, in light and dark; a browser test checks this at 1280 and 390 px.
- **UI:** `PageHeader` takes `compact` for a `detail` head over content that needs the height, and `usePageHeaderControlSize()` tells a button placed into a head which size to take.
