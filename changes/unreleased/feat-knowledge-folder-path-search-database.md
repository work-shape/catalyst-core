---
section: Database
---

- **Knowledge Bases:** Owned-store migration 21 `source_item_path_search` (applied to every
  Knowledge Base store at the next start, no platform migration): source items get the stored,
  generated `path_search`, the words of the item's path, with a GIN index. Adding it rewrites
  `source_items`, one row per item, under a lock for the length of the migration; `chunks` is
  untouched and nothing is embedded again. A rollback leaves the column and index unused.
