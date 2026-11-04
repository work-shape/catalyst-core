---
section: Fixed
---

- **Apps:** An open App gets the window: its head is one slim row (a lower bar, a smaller name, small buttons, no description; the description stays in Details). At phone width it stays one row: Edit is its icon, Edit in chat folds into the menu, and the sidebar button stands level with the row, and the App's frame fills everything under it edge to edge, at 390 px and in dark mode too. A browser test checks that the frame reaches the window's bottom.
- **UI:** `PageHeader` takes `compact` for a `detail` head over content that needs the height, and `usePageHeaderControlSize()` tells a button placed into a head which size to take.
