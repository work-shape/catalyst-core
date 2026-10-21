---
section: Changed
---

- **Access:** Instance > Access > Data access is an overview per declared dimension: every person and each group and service account that holds values, with their values or "All values" and where each comes from (assigned directly or through a group), values never shown in plain words, and each person without values marked. A holder's values change in a dialog with a chip field; groups and service accounts are chosen by name. Without a declared dimension the tab is not shown. A new read, `scope_assignments.overview`, gives the page every assignment the reader may see with each active person's groups and effective values (SCOPE-UI-1).
- **UI library:** `ChipInput`, a field that holds a list of short values as chips.
