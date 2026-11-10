---
section: Database
---

- **Knowledge Bases:** Owned-store migration 20 `source_item_stated_at` (applied to every
  Knowledge Base store at the next start, no platform migration): source items get a nullable
  `stated_at`, the date a synced item states of its own version, such as a web page's "Stand".
  Existing rows keep it null, so their citations show only the day they were retrieved until a
  source reads a stated date. A rollback leaves the column unused.
