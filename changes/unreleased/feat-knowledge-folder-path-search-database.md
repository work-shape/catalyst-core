---
section: Database
---

- **Knowledge Bases:** Owned-store migration 21 `source_item_path_search` (applied to every
  Knowledge Base store at the next start, no platform migration): an expression GIN index
  `source_items_path_search_idx` over the words of each item's path. It adds no column and
  rewrites no row; building it holds writes to `source_items` but never a search, and it gives up
  after a 5 s `lock_timeout` where a sync is writing the table, so the migration is tried again.
  `chunks` is untouched and nothing is embedded again. A rollback leaves the index unused.
