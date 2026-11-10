---
section: Fixed
---

- **Knowledge Bases:** A synced source's pass no longer fails as unreachable when it lists while
  the indexing of an earlier pass's documents finishes. A listing page and a Workflow `ingest`
  page locked the source's items before their contents, and an index completion takes them the
  other way round, so the database broke the deadlock by ending one of them: an ended page
  failed the whole pass with `knowledge_source_unreachable`. Both now take the contents first.
